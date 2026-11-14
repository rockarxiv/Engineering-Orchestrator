import { specFields, withShapeDefaults, type IpcPayload, type IpcResponse, type Item, type SpecShape, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { addItemAttachments, hasJiraPullPending, postComment, resolveItemType } from "../db/repos/index.js";
import { checkItemUploads, rollbackItemUploads, storeItemUploads } from "../attachments/itemUploads.js";
import type { AttachmentStorage } from "../attachments/storage.js";
import { requestJiraPullDrain } from "../packs/developer/jira/pullSchedule.js";
import { applyNewItem } from "../roles/discussion.js";
import { activeProjectId } from "./repositoryCommands.js";
import { actingPersonId } from "../identity/acting.js";
import { emitPush } from "./push.js";
import { withModuleEntryChecks } from "../modules/entryChecks.js";
import type { EngineHandle } from "./domainCommands.js";

/**
 * One bug or story, handed over on its own.
 *
 * The four bug fields are demanded here rather than in the schema: see
 * the channel's comment for why a flat object beats a union in a tool's
 * JSON Schema. What matters is that the rule itself is not relaxed — a
 * bug arriving this way goes straight to the board and never meets
 * intake, which is exactly the case the pinned decision on KAN-4 is
 * about.
 *
 * `jiraKey` and `jiraSync` are the case this was missing (EO-123): an
 * agent outside EO handing over a bug that is already filed in Jira had
 * nowhere to say so, and the item arrived unlinked. Attaching is
 * still a local write — `applyNewItem` checks the key's shape and
 * that no other item holds it, and refuses before creating anything,
 * and no request leaves this call. What it *does* do is mark the item
 * for a pull (EO-127), which the schedule reads in a moment later; the
 * kick below is only what makes that moment a short one.
 */
export function submitItem(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"work:submitItem">,
  /**
   * The item's own files, already checked and stored (EO-704) — written
   * in the transaction that creates the item, so nothing is dispatched
   * on it before they are there. See `submitItemCommand`.
   */
  files: Parameters<typeof addItemAttachments>[2] = [],
): IpcResponse<"work:submitItem"> {
  const projectId = (input.projectId ?? activeProjectId(db)) as Uuid | null;

  // Files named by path arrive here already stored, as `files`
  // (EO-704). A caller that skipped `submitItemCommand` would have them
  // dropped in silence, which invariant 8 forbids.
  if ((input.paths?.length ?? 0) > 0 && files.length === 0) {
    return { created: false, key: null, problem: "The files this names by path were not uploaded, so nothing was created." };
  }

  // The type is a slug now rather than one of two words (KAN-146), so
  // the first thing this channel does is find the row it names. Two
  // refusals come out of it, both as `problem` on a successful call
  // rather than as a malformed payload: a slug this project has no type
  // for, which `resolveItemType` answers by naming the ones it does
  // have, and a container.
  const type = resolveItemType(db, projectId, input.type);
  if (!type.ok) return { created: false, key: null, problem: type.problem };

  // A container holds work rather than being work, so one handed over on
  // its own would be an empty plan — a board filling up with containers
  // holding nothing. `work:submitPlan` is where a container and the work
  // under it arrive together. Asked of the type's flag, so a project
  // whose container is an Epic is refused for the same reason as a
  // feature and no word is written down here.
  //
  // `applyNewItem` refuses this too since KAN-164, and would refuse it a
  // few lines below — the guard moved to the door once the approval gate
  // became a second way to name a type. This stays because the sentence
  // differs by audience and the more specific one belongs to whoever can
  // act on it: this channel's caller is an agent holding
  // `work_submit_plan`, and the door's caller may be a person who is
  // not.
  if (type.type.container) {
    return {
      created: false,
      key: null,
      problem: `A ${type.type.label} holds work rather than being work, so there is nothing to file on its own — work_submit_plan is how one arrives, together with the work under it.`,
    };
  }

  // What this type demands of the spec is checked by `applyNewItem`, once,
  // against the type's shape (KAN-147). Two hand-written checks stood here
  // — a story's one criterion and a bug's four reproduction fields — and
  // they were the only thing that knew either type's fields; a pack's own
  // leaf type was held to a bug's bar or to nothing at all. The refusals a
  // person reads are unchanged, because the words are on the shapes now.

  const applied = db.transaction(() => {
    const made = applyNewItem(
      db,
      projectId,
      {
        type: { packSlug: type.type.packSlug, slug: type.type.slug },
        title: input.title,
        body: input.body,
        spec: { ...specFromPayload(type.type.specShape, input), ...(input.spec ?? {}) },
        depends_on: input.dependsOn,
        // Who asked for it, where the record knows (EO-326, ARCHITECTURE.md, "Identity"). The
        // local person on a desktop, which is what `createItem` fills in
        // by itself and what this channel has always recorded.
        createdBy: actingPersonId(db, input.actingDeviceId),
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        ...(input.pipeline === undefined ? {} : { pipeline: input.pipeline }),
        ...(input.repository === undefined ? {} : { repository: input.repository }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        // Trimmed and judged by `applyNewItem` (EO-739), on any pipeline.
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        // Normalised and judged by `applyNewItem` (EO-743), as
        // `items:update` judges them; `[]` asks nobody.
        ...(input.reviewers === undefined ? {} : { reviewers: input.reviewers }),
      },
      null,
      // What the caller said about Jira, carried whole (EO-123). Neither
      // is defaulted here: an absent key leaves the item unlinked, and
      // an absent switch is inherited from the parent by `createItem`,
      // so filling either in would be this layer inventing an answer.
      {
        ...(input.jiraKey === undefined ? {} : { key: input.jiraKey }),
        ...(input.jiraSync === undefined ? {} : { sync: input.jiraSync }),
      },
    );
    const item = made.ok ? made.created[0] : undefined;
    if (item && files.length > 0) addItemAttachments(db, item.id, files);
    return made;
  });

  if (!applied.ok) return { created: false, key: null, problem: applied.reason };

  // Before anything is pushed, so whoever opens the item finds the
  // note already on it.
  const created = applied.created[0];
  if (created) noteUncarriedFields(db, created, type.type.specShape, input);

  for (const item of applied.created) emitPush("items:changed", { itemId: item.id });
  engine?.notifyStateChange();
  // An item that arrived attached has an issue to read (EO-127). Asked
  // for by the state of the marker rather than by what the payload
  // said, so this cannot drift from what `createItem` actually
  // decided — and it is an optimisation either way: the tick would find
  // it within the minute regardless.
  if (hasJiraPullPending(db)) requestJiraPullDrain();

  return { created: true, key: applied.created[0]?.key ?? null, problem: null, ...(applied.warnings === undefined ? {} : { warnings: applied.warnings }) };
}

/**
 * `work:submitItem` as the channel answers it, with the files it names
 * by path (EO-704).
 *
 * Every path is checked, under the grant the door stamped, before
 * anything is written, and a refusal names each path and why. The
 * files are then stored, and the item and its files are written in one
 * transaction by `submitItem`; an item refused after that takes the
 * stored files back, so a refused call leaves nothing behind.
 */
export async function submitItemCommand(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"work:submitItem">,
  attachmentStorage?: AttachmentStorage,
): Promise<IpcResponse<"work:submitItem">> {
  const paths = input.paths ?? [];
  // The item's module entry rules are run before it is written (EO-736):
  // `submitItem` refuses before minting a key until each has a verdict.
  if (paths.length === 0) return withModuleEntryChecks(db, "creation", () => submitItem(db, engine, input));
  const granted = await checkItemUploads(input.pathsFrom, [paths], attachmentStorage);
  if (!granted.ok) return { created: false, key: null, problem: granted.problem };
  const stored = await storeItemUploads(granted, [paths]);
  if (!stored.ok) return { created: false, key: null, problem: stored.problem };
  let answer: IpcResponse<"work:submitItem">;
  try {
    answer = await withModuleEntryChecks(db, "creation", () => submitItem(db, engine, input, stored.records[0] ?? []));
  } catch (error) {
    await rollbackItemUploads(granted.storage, stored.records);
    throw error;
  }
  if (!answer.created) await rollbackItemUploads(granted.storage, stored.records);
  return answer;
}

/**
 * This channel's flat payload, as the spec its type asked for (KAN-147).
 *
 * The channel is one flat object rather than a union — a union renders as
 * `anyOf` in a tool's JSON Schema, which models handle far worse — so
 * every type's fields are declared side by side on it and a submission
 * may carry fields its type has nowhere to put. Which of them belong to
 * *this* item is the shape's answer: each field it declares is read from
 * the payload key that spells it in camelCase, which is the one
 * convention this flatness costs. `steps_to_reproduce` is
 * `stepsToReproduce`; `expected` is `expected`.
 *
 * What the shape does not declare is dropped, and `noteUncarriedFields`
 * is what stops that being silent (invariant 8). A blank string and an
 * empty list count as not sent: they are the defaults the channel gives
 * these fields, so a story that never mentioned `expected` has not said
 * anything about it.
 */
function specFromPayload(shape: SpecShape, input: IpcPayload<"work:submitItem">): Record<string, unknown> {
  const flat = input as unknown as Record<string, unknown>;
  const spec: Record<string, unknown> = {};

  for (const field of specFields(shape)) {
    const value = flat[payloadKey(field.name)];
    if (typeof value === "string" && value.trim() !== "") spec[field.name] = value.trim();
    if (Array.isArray(value) && value.length > 0) spec[field.name] = value;
    if (typeof value === "number" || typeof value === "boolean") spec[field.name] = value;
  }

  // Not a field any shape declares, and the same bag it has always lived
  // in: the paths EO serialises work against are a property of the work
  // rather than of its type, and there is no column for them yet.
  if (input.touches.length > 0) spec["touches"] = input.touches;

  // `spec` itself is merged by the caller above, after this: what a
  // submission says outright about a field wins over what the flat
  // payload spells.

  return withShapeDefaults(shape, spec);
}

/** `steps_to_reproduce` → `stepsToReproduce`, which is how this channel spells a spec field. */
function payloadKey(name: string): string {
  return name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * The four repro fields belong to a bug and to nothing else, so a type
 * without them carrying one has said something the item will not hold.
 */
const REPRO_ELSEWHERE = "This type does not carry the bug repro fields, so this sentence is here and nowhere else on the ticket.";

interface UncarriedField {
  /** The channel's own field name, which is what a caller sent and what the note has to name. */
  field: string;
  /** The spec field it spells. A type whose shape declares this one carries it. */
  spec: string;
  /** What was sent, rendered — or `null` when the caller sent nothing, which drops nothing. */
  sent: (input: IpcPayload<"work:submitItem">) => string | null;
  /** What not carrying it actually means for this item, in the terms of whoever reads the thread. */
  consequence: string;
}

/**
 * Every field `work:submitItem` accepts that an item's type may have
 * nowhere to put (EO-205, invariant 8).
 *
 * One list rather than one per type, and applicability read off the
 * shape: a field is carried exactly when the type declares it (KAN-147).
 * It used to be a table keyed by `story` and `bug`, which meant a third
 * type was answered for by neither — and that the two entries this story
 * *deleted* looked like facts rather than the gaps they were. `touches`
 * and `dependsOn` are carried for every type now, because what work
 * collides with and what it waits for are properties of work rather than
 * of a type.
 *
 * A note rather than a refusal, because none of these makes an item
 * unfileable and refusing a complete bug report over one `touches` entry
 * would lose the report. On the item rather than in `problem`, because
 * `problem` means "nothing was created" to the tool's renderer and to
 * every caller reading it, and because a comment is the communication
 * channel EO has (invariant 4).
 *
 * A field added to the channel and to neither the spec nor this list is
 * caught by `submittedItemFields.test.ts`, which drives every field the
 * channel declares — read off the channel's own shape rather than a copy
 * of it — and requires each one to be either stored or answered for.
 */
const UNCARRIED: readonly UncarriedField[] = [
  { field: "stepsToReproduce", spec: "steps_to_reproduce", sent: (input) => blank(input.stepsToReproduce), consequence: REPRO_ELSEWHERE },
  { field: "expected", spec: "expected", sent: (input) => blank(input.expected), consequence: REPRO_ELSEWHERE },
  { field: "actual", spec: "actual", sent: (input) => blank(input.actual), consequence: REPRO_ELSEWHERE },
  { field: "environment", spec: "environment", sent: (input) => blank(input.environment), consequence: REPRO_ELSEWHERE },
  {
    field: "acceptanceCriteria",
    spec: "acceptance_criteria",
    sent: (input) => (input.acceptanceCriteria.length > 0 ? input.acceptanceCriteria.join("; ") : null),
    consequence: "This type declares no criteria field, so there is nothing on it for a reviewer to judge the work against.",
  },
];

/** Nothing sent is nothing dropped: an empty or whitespace-only string is the default this channel gives these fields. */
function blank(value: string): string | null {
  return value.trim() === "" ? null : value.trim();
}

/**
 * What a submission said that the created item does not hold (EO-205).
 *
 * Silence here was the whole of the defect this comes from: a caller
 * was told `created: true` and the thing it sent was on the floor. The
 * note is what the item has instead — whoever picks the work up reads
 * the thread, and a fact that reached EO and stopped there is exactly
 * what belongs in it.
 */
function noteUncarriedFields(db: Db, item: Item, shape: SpecShape, input: IpcPayload<"work:submitItem">): void {
  const declared = new Set(Object.keys(shape.properties));
  const dropped = UNCARRIED.filter((entry) => !declared.has(entry.spec))
    .map((entry) => ({ entry, sent: entry.sent(input) }))
    .filter((row): row is { entry: UncarriedField; sent: string } => row.sent !== null);

  if (dropped.length === 0) return;

  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "note",
    body: [
      `This ${item.type} was submitted with ${dropped.length === 1 ? "a field" : "fields"} EO accepted and does not store on a ${item.type}. ` +
        `Recorded here rather than dropped:`,
      "",
      ...dropped.map((row) => `- **${row.entry.field}** — ${row.sent}. ${row.entry.consequence}`),
      "",
      "Everything else the submission carried is on the ticket itself.",
    ].join("\n"),
  });
}
