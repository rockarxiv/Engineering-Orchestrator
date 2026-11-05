import {
  ContainerIntakeSchema,
  formatIssues,
  IntakeAnswerSchema,
  LeafIntakeSchema,
  specFields,
  specFromAnswer,
  specIssues,
  withShapeDefaults,
  type IntakeAnswer,
  type Item,
  type LeafIntake,
  type SpecField,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment, resolveItemType, updateItem, type ItemType } from "../db/repos/index.js";
import { PROPOSAL_KIND } from "./proposal.js";

/**
 * What intake settled, put into the thread and pinned (KAN-32).
 *
 * `system-agent.md` has asked for this since it was written as `product-owner.md` — record
 * a settled decision as a comment with `kind: "decision"` and
 * `pinned: true`, "the main way your work outlives this conversation".
 * It has never happened. `CommentToolArgsSchema` has no `pinned` field,
 * so an agent following the instruction exactly still produced an
 * ordinary comment: the first thing truncation drops, and precisely the
 * thing that was supposed to survive it.
 *
 * Moving it into the result fixes that by removing the agent from the
 * step it kept getting wrong. The agent says what was decided; the
 * engine decides how it is stored.
 *
 * Nobody is mentioned. These are a record, not a request — intake
 * finishing means there is nothing left to ask, and an inbox item
 * saying "here is what you already told me" is noise.
 */
export function postIntakeSummary(db: Db, item: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown): void {
  const answer = IntakeAnswerSchema.safeParse(parsedResult);
  if (!answer.success) return; // A-02 already validated this; nothing to post if it somehow didn't

  // The type the agent named, resolved once. Read from the result rather
  // than from the item's own row, which has not been updated yet at this
  // point in the run; `resultKeyFor` asks the same question of the same
  // word, so the route and this agree.
  //
  // As a **bare slug**, which is the one thing KAN-147 changed here.
  // While intake's shape was this pack's three words, the word was this
  // pack's by construction and was resolved as `developer:<word>`. The
  // shape is composed from every type the project has now, so the answer
  // may name another pack's — and a word two packs both ship is a question
  // with two answers, which `resolveItemType` refuses by naming both
  // rather than picking one (ARCHITECTURE.md, "An item type is data").
  //
  // Either refusal ends in the thread and nothing else happens (invariant
  // 8): the item keeps the type it had, and the note says which word could
  // not be applied — something a person can act on by adding the type,
  // saying which pack's was meant, or reclassifying by hand.
  const answered = resolveItemType(db, item.projectId, answer.data.type);
  if (!answered.ok) {
    postUnapplied(db, item, runId, `Intake read this as a **${answer.data.type}**, which EO could not apply, so its classification was left alone. ${answered.problem}`);
    return;
  }
  const type = answered.type;

  // Which of the two answers this is, decided by the *type row's*
  // container flag and not by the word `feature` (KAN-146) — and then the
  // answer is read with the matching shape. A container is being
  // understood before it is decomposed; a leaf arrived already written and
  // is being classified (KAN-4, KAN-37/EO-5).
  //
  // An answer that does not fit the shape its type asks for is a
  // misconfigured type row rather than a bad answer — the composed schema
  // held the run to one of the project's branches (KAN-147), so the only
  // way here is a row whose flag says the opposite of the branch the agent
  // answered in. Said in the thread, with the item left exactly as it was.
  if (type.container) {
    const understood = ContainerIntakeSchema.safeParse(parsedResult);
    if (!understood.success) {
      postUnapplied(
        db,
        item,
        runId,
        `Intake answered about **${type.slug}** as one ticket, but this project's ${type.slug} type is a container, which holds work rather than being work. Its classification was left alone.`,
      );
      return;
    }

    // The fields this type declares, if it declares any (KAN-147).
    //
    // A container's shape is a shape like any other: a pack whose
    // container carries a quarter and an owner demands them at creation,
    // so a classification that left them unwritten would produce an item
    // its own type calls incomplete — by the same route the leaf branch
    // used to leave a story with no acceptance criteria. EO's own two
    // answers about a container are not spec: `understanding` is pinned
    // and each decision is its own comment, which is where `refine` and
    // a person read them.
    //
    // Nothing is written for a container that declares no fields, which
    // is every container EO ships — `specFromAnswer` returns nothing to
    // merge and the row is left exactly as it was.
    const settled = withShapeDefaults(type.specShape, specFromAnswer(type.specShape, answer.data));
    const merged = { ...(item.spec ?? {}), ...settled };

    // Held to the shape before it is written, exactly as a leaf
    // classification is (KAN-147).
    //
    // A-02 held the answer to this type's branch, and the branch is
    // composed from the same shape — but the two are not the same
    // question. A type may name a field the branch already carries, and
    // what that field *is* stays EO's: an `understanding` is prose to
    // pin whatever a shape calls it, so a type declaring it a number
    // composes a document that asks for the string EO can use and a
    // shape that refuses the string EO stores. The item keeps what it
    // had and the thread says so, rather than carrying a spec its own
    // type rejects.
    const issues = specIssues(type.specShape, merged);
    if (issues.length > 0) {
      postUnapplied(
        db,
        item,
        runId,
        `Intake understood this as a **${type.slug}**, and a ${type.slug} does not accept what that left on the ticket, so nothing was written:\n${formatIssues(issues)}`,
      );
      return;
    }

    if (Object.keys(settled).length > 0) updateItem(db, item.id, { spec: merged });

    // Pinned, and first: `refine` reads this instead of replaying the
    // conversation that produced it, so it is the one thing that must
    // still be there when the thread no longer fits.
    postComment(db, {
      itemId: item.id,
      runId,
      author: { type: "agent", agentId },
      kind: "note",
      pinned: true,
      body: understood.data.understanding,
    });

    // One comment each rather than a single list: a decision is a thing a
    // human can reply to, disagree with, or unpin on its own, and a list
    // is none of those.
    for (const settled of understood.data.decisions) {
      postComment(db, {
        itemId: item.id,
        runId,
        author: { type: "agent", agentId },
        kind: "decision",
        pinned: true,
        body: `**${settled.topic}** — ${settled.decision}`,
      });
    }
    return;
  }

  const classified = LeafIntakeSchema.safeParse(parsedResult);
  if (!classified.success) {
    postUnapplied(
      db,
      item,
      runId,
      `Intake answered about **${type.slug}** as something to decompose, but this project's ${type.slug} type is not a container, so there was nothing to do with the answer. Mark the type as a container, or ask for this again.`,
    );
    return;
  }

  postClassificationProposal(db, item, agentId, runId, type, classified.data, answer.data);
}

/**
 * Why intake's answer changed nothing (invariant 8).
 *
 * Three ways that can happen, all of them about the *type* rather than
 * about what the agent wrote: a word this project has no row for, and a
 * row whose container flag disagrees with the shape the answer came in.
 * None is something a person can see from the item, so each says which
 * word it was about and what to do; the human is mentioned because
 * nothing else will move this item on.
 */
function postUnapplied(db: Db, item: Item, runId: Uuid, body: string): void {
  postComment(db, {
    itemId: item.id,
    runId,
    author: { type: "engine" },
    kind: "note",
    mentions: [{ type: "human" }],
    body,
  });
}

/**
 * What intake settled on for a leaf type (KAN-4, routed by KAN-37/EO-5).
 *
 * Parallel to `postRefineProposal`: a decision a human can act on, not a
 * record like the note above. The item's type is updated immediately —
 * ahead of the human ever seeing it — because `resolveNextState` is
 * about to send this item to `pending_approval` either way, and the type
 * shown there has to be the type the PO is proposing. It stays editable:
 * `items:update` can change it right up until approval, which is the
 * reclassification point the pinned decisions describe.
 *
 * **And the fields it answered with, which used to stay in the card**
 * (KAN-147). The agent is asked for the type's spec fields and had
 * nowhere to put them: a story classified here reached `todo` carrying no
 * acceptance criteria at all, and the first thing that noticed was the
 * review refusing to start (EO-213). They are the item's spec now, read
 * by the shape that asked for them — so what the card shows and what the
 * item holds are the same thing.
 *
 * Merged into whatever the spec already held rather than replacing it: a
 * field this type does not declare belongs to whoever wrote it, and
 * intake is classifying the item, not taking it over.
 */
function postClassificationProposal(db: Db, item: Item, agentId: Uuid, runId: Uuid, type: ItemType, leaf: LeafIntake, answer: IntakeAnswer): void {
  const spec = withShapeDefaults(type.specShape, specFromAnswer(type.specShape, answer));
  const merged = { ...(item.spec ?? {}), ...spec };

  // What the item will hold, held to the type it is about to be
  // (KAN-147).
  //
  // A-02 held the answer to the type's branch, so what the agent *said*
  // satisfies the shape. What it kept may not: a classification merges
  // over whatever the item already carried, and a field from the type it
  // is leaving can be one this type declares differently — an old
  // `channel` a new type's `enum` has no place for. Writing anyway would
  // re-file the item as a type its own shape rejects, which is the state
  // every other door refuses to produce.
  //
  // So the classification is not applied, and the thread says why: the
  // item keeps the type it had, which is something a person can act on
  // by clearing the field or reclassifying by hand (invariant 8).
  const issues = specIssues(type.specShape, merged);
  if (issues.length > 0) {
    postUnapplied(
      db,
      item,
      runId,
      `Intake read this as a **${type.slug}**, and this ticket carries fields a ${type.slug} does not accept, so its classification was left alone:\n${formatIssues(issues)}`,
    );
    return;
  }

  updateItem(db, item.id, { typeId: type.id, spec: merged });

  postComment(db, {
    itemId: item.id,
    runId,
    author: { type: "agent", agentId },
    kind: PROPOSAL_KIND,
    mentions: [{ type: "human" }],
    body: renderClassification(type, leaf, spec),
  });
}

/**
 * One spec field on the card.
 *
 * Two kinds of rendering, which is what the four field kinds collapse to
 * on a card: a list is bullets and everything else is a labelled line.
 *
 * `headed` is the one subtlety, and it is the rule the hand-written
 * version encoded: bullets need a heading when something labelled comes
 * before them, or they read as a continuation of the field above rather
 * than as a list of their own. A type whose only field is its criteria —
 * a story — renders them bare, exactly as it always did.
 */
function renderField(field: SpecField, value: unknown, headed: boolean): string[] {
  if (field.kind === "string list") {
    const entries = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
    if (entries.length === 0) return [];
    const bullets = entries.map((entry) => `- ${entry}`);
    return headed ? ["", `**${field.label}:**`, "", ...bullets] : ["", ...bullets];
  }
  if (value === undefined || value === null || String(value).trim() === "") return [];
  return ["", `**${field.label}:** ${String(value)}`];
}

/**
 * Renders a proposed classification as something a human can approve,
 * reject, or overrule the type of.
 *
 * The fields come from the type's spec shape in the order it declares
 * them (KAN-147), which is what makes this card work for a `Case` with a
 * customer and a channel as well as for the two types it was written out
 * for. A field the agent did not answer with is left out rather than
 * shown empty: the shape says what may be there, and the answer says what
 * is.
 */
function renderClassification(type: ItemType, leaf: LeafIntake, spec: Record<string, unknown>): string {
  const lines = [`I'm treating this as a **${type.slug}** — one ticket, no decomposition.`, "", `**${leaf.title}**`, "", leaf.body];

  let labelled = false;
  for (const field of specFields(type.specShape)) {
    const rendered = renderField(field, spec[field.name], labelled);
    if (rendered.length === 0) continue;
    lines.push(...rendered);
    if (field.kind !== "string list") labelled = true;
  }

  lines.push("", "Approve to move this straight to to-do, or reply saying what to change — including the type, if I guessed wrong.");
  return lines.join("\n");
}
