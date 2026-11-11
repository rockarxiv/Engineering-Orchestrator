import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, KeyRound, Shapes, ShieldCheck, Trash2, Upload, UnlockKeyhole, Variable, Webhook } from "lucide-react";
import {
  DIVERGED_ACTIONS,
  isPackShipped,
  WEBHOOK_UNATTENDED_LABEL,
  WEBHOOK_UNATTENDED_MANAGED,
  WEBHOOK_UNATTENDED_NO_ENTRY,
  WEBHOOK_UNATTENDED_RISK,
  type AssistCardDetail,
  type AssistCardKind,
  type DiscussionMessage,
  type ItemTypeCardShape,
} from "@eo/core";
import { Markdown } from "@eo/ui";
import { useAliasesRetired } from "../../hooks/useAppVersion";
import { ipcQuery } from "../../query/client";
import {
  divergenceKey,
  environmentVariablesRootKey,
  itemsKey,
  moduleSecretsRootKey,
  modulesKey,
  pipelineStepsKey,
  registryKey,
  sectionsKey,
  useChromeVocabulary,
} from "../../query/hooks";
import { Button, Chip, Segmented, TextInput } from "../kit";
import { ImportNeeds } from "./ImportNeeds";
import { assistCardKey, drawAssistReply } from "../../shared/assist/useAssistRoom";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";

/**
 * Something only a person may do, offered by the assistant with the
 * button that does it (EO-521): export a pipeline to a file, import a
 * pipeline file attached to the chat, delete a pipeline, or discard this
 * machine's edits to one the organisation manages.
 *
 * The assistant does none of these. It names the thing, and this card
 * reads everything else about it with `assist:card` — the pipeline's name,
 * how many items it holds, what an import would need here — so it shows
 * what pressing the button would do now, not what the agent believed.
 * The button is `assist:applyCard`, which carries it out through the very
 * channel the pipeline editor called and files what came of it under the
 * card.
 *
 * Once pressed the card keeps its place and shows that outcome instead of
 * a button — done, or refused and why — and it cannot be pressed again,
 * here or in another window. A card a later reply replaced says so and
 * offers nothing.
 *
 * Three more are settings that are deliberately a person's (EO-522):
 * letting a webhook pipeline's items reach a sending step unread, with
 * the risk in the words every screen uses for it, and a step's own secret
 * or variable. For those the card says whether a value is already set —
 * never what it is — and the person types the new one into the card. It
 * is sent with the press and kept nowhere here: not in the conversation,
 * not in what is filed under the card, and not in anything the assistant
 * reads.
 *
 * And three are a project's item types (EO-523): adding one, changing
 * one, removing one. The card shows the type as it would be — its names,
 * whether it holds other items, its fields — and, where
 * `itemTypes:create`, `update` or `delete` would refuse the press, that
 * refusal in place of the button.
 */
export function OperationCard({ message, conversationId, onDone }: { message: DiscussionMessage; conversationId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const vocabulary = useChromeVocabulary();
  const aliasesRetired = useAliasesRetired();
  const kind: AssistCardKind = message.card!.kind;
  const outcome = message.card?.outcome ?? null;
  const open = message.canApprove && outcome === null;

  const read = useQuery({
    queryKey: assistCardKey(message.id),
    queryFn: () => ipcQuery("assist:card", { conversationId, messageId: message.id }),
  });
  // Re-read when the work or the configuration moves, which is what can
  // change whether the button would be refused. It used to ride along
  // with every re-read of the room, including each streamed event of any
  // run; it no longer sits under the room's key (EO-550).
  useInvalidateOnPush("items:changed", assistCardKey(message.id));
  useInvalidateOnPush("config:changed", assistCardKey(message.id));
  const detail = read.data?.card ?? null;

  // Keep mine unless the person says otherwise: the module here is code
  // somebody on this machine approved.
  const [choices, setChoices] = useState<Record<string, "reuse" | "import">>({});
  const collisions = detail?.kind === "pipelineImport" ? detail.preflight.collisions : [];
  const chosen = Object.fromEntries(collisions.map((collision) => [collision.slug, choices[collision.slug] ?? "reuse"]));

  // What the person types for a step's own secret or variable. Held here
  // only until the press, and emptied by it whatever came of it.
  const [value, setValue] = useState("");
  const typesValue = (detail?.kind === "stepSecret" || detail?.kind === "stepVariable") && detail.action === "set";

  const [problem, setProblem] = useState<string | null>(null);
  const press = useMutation({
    mutationFn: () =>
      ipcQuery("assist:applyCard", { conversationId, messageId: message.id, choices: chosen, ...(typesValue ? { value } : {}) }),
    onSuccess: (result) => {
      setValue("");
      // The card spent, as the answer says, before anything is re-read (EO-548).
      drawAssistReply(queryClient, result.conversation);
      // What was filed under the card arrives with the conversation; a
      // problem nothing was filed for is said here instead.
      setProblem(result.said === null ? result.problem : null);
      if (result.said !== null) {
        if (detail?.kind === "pipelineWebhookUnattended") void queryClient.invalidateQueries({ queryKey: pipelineStepsKey(detail.pipelineId) });
        if (kind === "stepSecret") void queryClient.invalidateQueries({ queryKey: moduleSecretsRootKey });
        if (kind === "stepVariable") void queryClient.invalidateQueries({ queryKey: environmentVariablesRootKey });
        if (kind !== "pipelineExport" && !kind.startsWith("itemType")) void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
        if (kind === "pipelineDelete" || kind === "pipelineImport") void queryClient.invalidateQueries({ queryKey: itemsKey });
        if (kind === "pipelineImport") void queryClient.invalidateQueries({ queryKey: modulesKey });
        // A type change is when the registry moves, as the editor's Types section said.
        if (kind === "itemTypeCreate" || kind === "itemTypeUpdate" || kind === "itemTypeDelete") {
          void queryClient.invalidateQueries({ queryKey: ["itemTypes"] });
          void queryClient.invalidateQueries({ queryKey: registryKey });
        }
        if (kind === "pipelineDiscardEdits" && detail?.kind === "pipelineDiscardEdits") {
          void queryClient.invalidateQueries({ queryKey: divergenceKey(detail.pipelineId) });
          void queryClient.invalidateQueries({ queryKey: sectionsKey });
        }
      }
      onDone();
    },
    onError: (error: unknown) => {
      setValue("");
      setProblem(error instanceof Error ? error.message : String(error));
    },
  });

  const label = buttonFor(kind, detail);
  const refused = detail !== null && cannotPress(detail);

  return (
    <section aria-label={TITLE[kind]} className="flex flex-col gap-2.5 rounded-[14px] bg-canvas-subtle px-4 py-3.5">
      <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
        <span className="shrink-0">{ICON[kind]}</span>
        <b className="min-w-0 truncate text-[13px] font-semibold text-ink">{detail === null ? TITLE[kind] : subjectOf(detail)}</b>
        <span className="ml-auto shrink-0 text-[11.5px] text-ink-subtle">{STATE[kind]}</span>
      </div>

      {/* What pressing it would do — until it has been pressed, when what it did is below instead. */}
      {outcome !== null ? null : detail !== null ? (
        <Body detail={detail} itemsWord={vocabulary.items.toLowerCase()} itemWord={vocabulary.item.toLowerCase()} aliasesRetired={aliasesRetired} />
      ) : (
        <Markdown className="text-[13px] leading-relaxed">{message.body}</Markdown>
      )}
      {read.data?.problem && outcome === null ? <p className="text-xs text-danger">{read.data.problem}</p> : null}

      {open && collisions.length > 0 ? (
        <ul aria-label="Modules it shares a name with" className="flex flex-col gap-1.5">
          {collisions.map((collision) => (
            <li key={collision.slug} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-canvas px-3 py-2 text-[12.5px]">
              <span className="min-w-0 flex-1 text-ink-muted">
                You already have <code className="font-mono text-ink">{collision.slug}</code> ({collision.localName}); the file brings “{collision.incomingName}”.
              </span>
              <Segmented
                size="sm"
                label={`What to do about ${collision.slug}`}
                value={chosen[collision.slug] ?? "reuse"}
                options={CHOICES}
                onChange={(choice) => setChoices((before) => ({ ...before, [collision.slug]: choice }))}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {open && typesValue && detail !== null && !refused ? (
        <TextInput
          aria-label={`Value for ${detail.name}`}
          type={detail.kind === "stepSecret" ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          className={detail.kind === "stepVariable" ? "font-mono" : undefined}
          placeholder={`Value for ${detail.name} on ${detail.stepName}`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      ) : null}

      {open ? (
        <div className="flex items-center gap-2">
          <Button
            variant={kind === "pipelineDelete" || kind === "itemTypeDelete" ? "danger" : "primary"}
            size="sm"
            disabled={press.isPending || detail === null || refused || (typesValue && value === "")}
            onClick={() => press.mutate()}
          >
            {press.isPending ? label.pending : label.idle}
          </Button>
          <span className="ml-auto text-[11px] text-ink-subtle">or say what should change</span>
        </div>
      ) : outcome !== null ? (
        <div className="flex flex-col gap-1.5">
          <span>
            <Chip tone={outcome.done ? "success" : "danger"}>{outcome.done ? label.done : label.refused}</Chip>
          </span>
          <p role="status" className="text-[12.5px] leading-relaxed text-ink-muted">
            {outcome.said}
          </p>
        </div>
      ) : (
        <p className="text-[12px] text-ink-subtle">A newer reply replaced this card — ask again to do it.</p>
      )}
      {problem && outcome === null ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** An import's choice per colliding module, as the editor's Import offered it. */
const CHOICES = [
  { value: "reuse", label: "Keep mine" },
  { value: "import", label: "Import theirs" },
] as const satisfies readonly { value: "reuse" | "import"; label: string }[];

const TITLE: Record<AssistCardKind, string> = {
  pipelineExport: "Export a pipeline",
  pipelineImport: "Import a pipeline",
  pipelineDelete: "Delete a pipeline",
  pipelineDiscardEdits: "Discard my edits",
  pipelineWebhookUnattended: "Webhook items",
  stepSecret: "A step's own secret",
  stepVariable: "A step's own variable",
  itemTypeCreate: "Add an item type",
  itemTypeUpdate: "Change an item type",
  itemTypeDelete: "Delete an item type",
  pipelineKeepMine: "Keep my pipeline",
  trialPublish: "Publish the tested pipeline",
};

const STATE: Record<AssistCardKind, string> = {
  pipelineExport: "export",
  pipelineImport: "import",
  pipelineDelete: "delete",
  pipelineDiscardEdits: "discard edits",
  pipelineWebhookUnattended: "webhook",
  stepSecret: "secret",
  stepVariable: "variable",
  itemTypeCreate: "add type",
  itemTypeUpdate: "change type",
  itemTypeDelete: "delete type",
  pipelineKeepMine: "keep mine",
  trialPublish: "publish",
};

const ICON: Record<AssistCardKind, ReactNode> = {
  pipelineExport: <Download aria-hidden size={14} />,
  pipelineImport: <Upload aria-hidden size={14} />,
  pipelineDelete: <Archive aria-hidden size={14} />,
  pipelineDiscardEdits: <UnlockKeyhole aria-hidden size={14} />,
  pipelineWebhookUnattended: <Webhook aria-hidden size={14} />,
  stepSecret: <KeyRound aria-hidden size={14} />,
  stepVariable: <Variable aria-hidden size={14} />,
  itemTypeCreate: <Shapes aria-hidden size={14} />,
  itemTypeUpdate: <Shapes aria-hidden size={14} />,
  itemTypeDelete: <Trash2 aria-hidden size={14} />,
  pipelineKeepMine: <ShieldCheck aria-hidden size={14} />,
  trialPublish: <Upload aria-hidden size={14} />,
};

type ButtonWords = { idle: string; pending: string; done: string; refused: string };

const BUTTON: Record<Exclude<AssistCardKind, "pipelineWebhookUnattended" | "stepSecret" | "stepVariable">, ButtonWords> = {
  pipelineExport: { idle: "Export…", pending: "Exporting…", done: "Exported", refused: "Not exported" },
  pipelineImport: { idle: "Import", pending: "Importing…", done: "Imported", refused: "Not imported" },
  pipelineDelete: { idle: "Delete pipeline", pending: "Deleting…", done: "Deleted", refused: "Not deleted" },
  pipelineDiscardEdits: { idle: DIVERGED_ACTIONS.discard, pending: "Discarding…", done: "Discarded", refused: "Not discarded" },
  itemTypeCreate: { idle: "Add type", pending: "Adding…", done: "Added", refused: "Not added" },
  itemTypeUpdate: { idle: "Save type", pending: "Saving…", done: "Saved", refused: "Not saved" },
  itemTypeDelete: { idle: "Delete type", pending: "Deleting…", done: "Deleted", refused: "Not deleted" },
  pipelineKeepMine: { idle: "Keep my pipeline", pending: "Keeping…", done: "Kept", refused: "Not kept" },
  // Drawn by `TrialPublishCard`, never here (EO-588); the words are for completeness.
  trialPublish: { idle: "Approve and publish", pending: "Publishing…", done: "Published", refused: "Not published" },
};

/**
 * What the button and the outcome say. The settings' cards (EO-522) say
 * which way they go — on or off, set or clear — which is in what the card
 * read; until it has read it, the words are the ones true either way.
 */
function buttonFor(kind: AssistCardKind, detail: AssistCardDetail | null): ButtonWords {
  switch (kind) {
    case "pipelineWebhookUnattended": {
      const on = detail?.kind === "pipelineWebhookUnattended" ? detail.unattended : null;
      return {
        idle: on === null ? "Change" : on ? "Send on unread" : "Stop sending on unread",
        pending: "Changing…",
        done: "Changed",
        refused: "Not changed",
      };
    }
    case "stepSecret":
    case "stepVariable": {
      const noun = kind === "stepSecret" ? "secret" : "variable";
      const action = detail?.kind === kind ? detail.action : null;
      if (action === "set") return { idle: `Set ${noun}`, pending: "Setting…", done: "Set", refused: "Not set" };
      if (action === "clear") return { idle: `Clear ${noun}`, pending: "Clearing…", done: "Cleared", refused: "Not cleared" };
      return { idle: "Apply", pending: "Applying…", done: "Done", refused: "Not done" };
    }
    default:
      return BUTTON[kind];
  }
}

/** Whether what the card read already says pressing it could only be refused, so the button is not offered. */
function cannotPress(detail: AssistCardDetail): boolean {
  switch (detail.kind) {
    case "pipelineImport":
      return detail.preflight.refusal !== null;
    case "pipelineWebhookUnattended":
      return detail.managed || detail.current === detail.unattended || (detail.unattended && !detail.entry);
    case "stepSecret":
    case "stepVariable":
      // Nothing of this kind to clear; or a set the step's other kind of
      // entry under the same name would have refused — a name is a secret
      // or a variable within one scope, never both.
      return detail.action === "clear" ? !detail.set : detail.setAsOther;
    case "itemTypeCreate":
    case "itemTypeUpdate":
    case "itemTypeDelete":
      // What the channel would refuse the press with — said on the card instead.
      return detail.problem !== null;
    case "pipelineKeepMine":
      // Nothing held any more: resolved since the card was offered.
      return detail.held === null;
    default:
      return false;
  }
}

function subjectOf(detail: AssistCardDetail): string {
  switch (detail.kind) {
    case "pipelineImport":
      return detail.preflight.pipelineName;
    case "stepSecret":
    case "stepVariable":
      return `${detail.name} · ${detail.stepName}`;
    case "itemTypeCreate":
    case "itemTypeDelete":
      return detail.type.label;
    case "itemTypeUpdate":
      return detail.before.label === detail.after.label ? detail.after.label : `${detail.before.label} → ${detail.after.label}`;
    default:
      return detail.pipelineName;
  }
}

/** What pressing the button would do, in a sentence or two, and — for an import — every line of what it would need here. */
function Body({ detail, itemsWord, itemWord, aliasesRetired }: { detail: AssistCardDetail; itemsWord: string; itemWord: string; aliasesRetired: boolean }) {
  const text = "text-[13px] leading-relaxed text-ink-muted";
  switch (detail.kind) {
    case "pipelineExport":
      return <p className={text}>Saves {detail.pipelineName} as a pipeline file — its steps, its routes and the custom modules they use — wherever you choose.</p>;
    case "pipelineImport":
      return (
        <div className="flex flex-col gap-2">
          <p className={text}>
            From {detail.attachmentName}: a new pipeline, {detail.preflight.pipelineName}
            {detail.preflight.moduleCount > 0 ? `, and ${detail.preflight.moduleCount} module${detail.preflight.moduleCount === 1 ? "" : "s"}` : ""}.
          </p>
          <ImportNeeds preflight={detail.preflight} aliasesRetired={aliasesRetired} itemsWord={itemsWord} />
        </div>
      );
    case "pipelineDelete":
      return (
        <p className={text}>
          {detail.pipelineName} holds {detail.itemCount === 0 ? `no ${itemsWord}` : `${detail.itemCount} ${detail.itemCount === 1 ? itemWord : itemsWord}`}. Deleting it moves
          it to the Archive{detail.itemCount === 0 ? "" : `, with ${detail.itemCount === 1 ? `that ${itemWord}` : `those ${itemsWord}`}`} — nothing is erased, and the
          Archive is where it stays readable.
        </p>
      );
    case "pipelineDiscardEdits":
      return (
        <div className="flex flex-col gap-1">
          {detail.line !== null ? <p className="text-[12.5px] text-ink-subtle">{detail.line}</p> : null}
          <p className={text}>
            Throws this machine&apos;s edits to {detail.pipelineName} away and puts back the version your organisation published
            {detail.version === null ? "" : `, v${detail.version}`}. Your organisation&apos;s updates resume.
          </p>
        </div>
      );
    case "pipelineKeepMine":
      return detail.held === null ? (
        <p className={text}>{detail.pipelineName} has no template update waiting any more, so there is nothing to skip.</p>
      ) : (
        <p className={text}>
          Keeps {detail.pipelineName} exactly as it is and skips the {detail.held.templateTitle} template&apos;s update from {detail.held.fromVersion} to{" "}
          {detail.held.toVersion}. The update is marked resolved, and the next template version is compared with {detail.held.toVersion}.
        </p>
      );
    case "pipelineWebhookUnattended":
      return (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] font-medium text-ink">{WEBHOOK_UNATTENDED_LABEL}</p>
          <p className={text}>
            {detail.unattended ? `Turns this on for ${detail.pipelineName}.` : `Turns this off for ${detail.pipelineName}.`} It is{" "}
            {detail.current ? "on" : "off"} now.
          </p>
          {/* The risk in the one wording every screen uses for it (webhookUnattended.ts). */}
          <p className={text}>{WEBHOOK_UNATTENDED_RISK}</p>
          {detail.managed ? <p className="text-[12.5px] text-ink-subtle">{WEBHOOK_UNATTENDED_MANAGED}</p> : null}
          {!detail.managed && detail.unattended && !detail.entry ? <p className="text-[12.5px] text-ink-subtle">{WEBHOOK_UNATTENDED_NO_ENTRY}</p> : null}
          {!detail.managed && detail.current === detail.unattended && (detail.entry || !detail.unattended) ? (
            <p className="text-[12.5px] text-ink-subtle">It is already {detail.current ? "on" : "off"}, so there is nothing to change.</p>
          ) : null}
        </div>
      );
    case "stepSecret":
    case "stepVariable": {
      const noun = detail.kind === "stepSecret" ? "secret" : "environment variable";
      const otherNoun = detail.kind === "stepSecret" ? "environment variable" : "secret";
      // What the step falls back to without a value of its own — the
      // shared list's entry, whichever kind it is, as a run resolves it.
      const fallback = detail.shared === null ? null : `the shared ${detail.shared === "secret" ? "secret" : "environment variable"}`;
      // Whether a value is set, and never what it is (EO-522).
      const held = detail.set
        ? `The ${detail.stepName} step already has its own value for ${detail.name}.`
        : detail.setAsOther
          ? `The ${detail.stepName} step already has ${detail.name} as its own ${otherNoun}.`
          : `The ${detail.stepName} step has no value of its own for ${detail.name}${fallback === null ? ", and there is no shared one" : `, so it uses ${fallback}`}.`;
      const what =
        detail.action === "set"
          ? detail.setAsOther
            ? `A name is a secret or an environment variable, never both — remove the step's ${otherNoun} first.`
            : detail.set
              ? `Setting replaces it${detail.kind === "stepSecret" ? " — the old value cannot be read back" : ""}.`
              : `Setting gives this step its own ${noun}${fallback === null ? "" : `, used in place of ${fallback}`}.`
          : detail.set
            ? `Clearing removes it, and the step ${fallback === null ? "is left with no value for it" : `falls back to ${fallback}`}.`
            : "There is nothing to clear.";
      return (
        <div className="flex flex-col gap-1">
          <p className="text-[12.5px] text-ink-subtle">
            The {noun} <code className="font-mono text-ink">{detail.name}</code> on the {detail.stepName} step of {detail.pipelineName}
          </p>
          <p className={text}>
            {held} {what}
            {detail.action === "set" && !detail.setAsOther ? " Type the value below — it goes to this machine's store, not to the assistant." : ""}
          </p>
          {/* The organisation's value wins over the step's and the shared list's alike (EO-328). */}
          {detail.organisation ? (
            <p className="text-[12.5px] text-ink-subtle">
              Your organisation sets {detail.name}, so its value is what a run of this step is given, whatever is set here.
            </p>
          ) : null}
        </div>
      );
    }
    case "itemTypeCreate":
      return (
        <ItemTypeBody
          lead={`A new item type on ${detail.projectName}.`}
          shape={detail.type}
          before={null}
          note={null}
          problem={detail.problem}
        />
      );
    case "itemTypeUpdate":
      return (
        <ItemTypeBody
          lead={`The item type “${detail.before.label}”${detail.projectName === null ? "" : ` on ${detail.projectName}`}, as it would be.`}
          shape={detail.after}
          before={detail.before}
          note={
            isPackShipped(detail)
              ? `The ${detail.packSlug} pack ships this type. It can be renamed and take optional fields of this project's own; the pack's fields and whether it holds other items are the pack's.`
              : null
          }
          problem={detail.problem}
        />
      );
    case "itemTypeDelete":
      return (
        <ItemTypeBody
          lead={`Removes the item type “${detail.type.label}”${detail.projectName === null ? "" : ` from ${detail.projectName}`}. ${detail.itemCount === 0 ? `No ${itemsWord} are of it.` : `${detail.itemCount} ${detail.itemCount === 1 ? itemWord : itemsWord} ${detail.itemCount === 1 ? "is" : "are"} of it.`}`}
          shape={detail.type}
          before={null}
          note={isPackShipped(detail) ? `The ${detail.packSlug} pack ships this type.` : null}
          problem={detail.problem}
        />
      );
  }
}

/** What a field kind is called, as the editor's Types section called it. */
const FIELD_KIND: Record<ItemTypeCardShape["fields"][number]["kind"], string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes / no",
  "string list": "List of text",
};

/**
 * One item type as an item-type card shows it (EO-523): its names, the
 * word its items are filed under, whether it holds other items, and its
 * fields. Given `before`, what pressing the card changes is marked. A
 * refusal the press would meet is said last, as the refusal.
 */
function ItemTypeBody({
  lead,
  shape,
  before,
  note,
  problem,
}: {
  lead: string;
  shape: ItemTypeCardShape;
  before: ItemTypeCardShape | null;
  note: string | null;
  problem: string | null;
}) {
  const changed = (now: string, then: string | undefined) =>
    before === null || then === now ? null : <span className="text-ink-subtle line-through">{then}</span>;
  const fieldsChanged = before !== null && JSON.stringify(before.fields) !== JSON.stringify(shape.fields);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] leading-relaxed text-ink-muted">{lead}</p>
      <dl aria-label="The item type" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
        <dt className="text-ink-subtle">Name</dt>
        <dd className="flex flex-wrap gap-1.5 text-ink">
          {changed(shape.label, before?.label)}
          <span>{shape.label}</span>
        </dd>
        <dt className="text-ink-subtle">Plural</dt>
        <dd className="flex flex-wrap gap-1.5 text-ink">
          {changed(shape.plural, before?.plural)}
          <span>{shape.plural}</span>
        </dd>
        <dt className="text-ink-subtle">Filed as</dt>
        <dd>
          <code className="font-mono text-ink">{shape.slug || "—"}</code>
        </dd>
        <dt className="text-ink-subtle">Holds</dt>
        <dd className="flex flex-wrap gap-1.5 text-ink">
          {changed(containerWords(shape.container), before === null ? undefined : containerWords(before.container))}
          <span>{containerWords(shape.container)}</span>
        </dd>
        <dt className="text-ink-subtle">Fields{fieldsChanged ? " (changed)" : ""}</dt>
        <dd>
          {shape.fields.length === 0 ? (
            <span className="text-ink-subtle">None — a title and a description only.</span>
          ) : (
            <ul aria-label="Fields" className="flex flex-col gap-0.5">
              {shape.fields.map((field, index) => (
                <li key={index} className="flex flex-wrap gap-1.5">
                  <code className="font-mono text-ink">{field.name || "—"}</code>
                  <span className="text-ink-muted">{FIELD_KIND[field.kind]}</span>
                  {field.required ? <span className="text-ink-subtle">required</span> : null}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
      {note !== null ? <p className="text-[12.5px] text-ink-subtle">{note}</p> : null}
      {problem !== null ? (
        <p role="note" aria-label="Refused" className="text-[12.5px] text-danger">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function containerWords(container: boolean): string {
  return container ? "Other items" : "Is the work";
}
