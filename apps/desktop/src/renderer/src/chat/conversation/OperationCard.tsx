import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Archive, CalendarClock, Download, KeyRound, Shapes, ShieldCheck, Terminal, Trash2, Upload, UnlockKeyhole, Variable, Webhook } from "lucide-react";
import {
  DIVERGED_ACTIONS,
  isPackShipped,
  WEBHOOK_UNATTENDED_LABEL,
  WEBHOOK_UNATTENDED_MANAGED,
  WEBHOOK_UNATTENDED_NO_ENTRY,
  WEBHOOK_UNATTENDED_RISK,
  type AssistCardDetail,
  type AssistCardKind,
  type AssistCardView,
  type CliToolDetection,
  type DiscussionMessage,
  type ItemTypeCardShape,
  type JobCardLine,
} from "@eo/core";
import { Markdown } from "@eo/ui";
import { useAliasesRetired } from "../../hooks/useAppVersion";
import { ipcQuery } from "../../query/client";
import {
  agentCliToolsKey,
  cliToolsKey,
  divergenceKey,
  environmentVariablesRootKey,
  itemsKey,
  jobsRootKey,
  moduleSecretsRootKey,
  modulesKey,
  pipelineStepsKey,
  registryKey,
  sectionsKey,
  useChromeVocabulary,
} from "../../query/hooks";
import { Button, Checkbox, Chip, Segmented, Select, TextInput } from "../kit";
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
 *
 * And four are jobs (EO-786): making one, changing one, deleting one, and
 * a webhook job's new secret or test event. The card shows the job as it
 * would be — or each changed field as old → new — in EO's words, and
 * never a webhook's signing secret. Delete asks whether the job's items
 * are kept or archived; once pressed, the card links the job it made or
 * the item a test event filed.
 *
 * And one adds command-line tools and gives them to several agents, or
 * takes them away, in one press (EO-859): a section per CLI it adds, then
 * a row per agent × CLI. Every row starts ticked and the person unticks
 * what they do not want; unticking an add unticks and disables each row
 * giving that new CLI. A row already in place has no box. The button
 * counts what it will do — "Add 2, give 5" — and a press refused at that
 * moment writes nothing and leaves the card to untick the row it names.
 *
 * In a reply's block of several (EO-863) the block can hold every button
 * still (`disabled`), and is handed this card's own press while its
 * button could be pressed (`onPress`), which is how "do all" presses it:
 * through the very call the button makes, with whatever the person chose
 * on the card.
 */
export function OperationCard({
  message,
  card,
  conversationId,
  onDone,
  disabled = false,
  onPress,
}: {
  message: DiscussionMessage;
  /** Which of the message's cards this is (EO-862): one reply can carry several, each pressed on its own. */
  card: AssistCardView;
  conversationId: string;
  onDone: () => void;
  /** Holds the button still, as a block does while "do all" runs (EO-863). */
  disabled?: boolean;
  /** Given this card's own press while its button could be pressed, and null when it no longer could. */
  onPress?: (press: CardPress | null) => void;
}) {
  const queryClient = useQueryClient();
  const vocabulary = useChromeVocabulary();
  const aliasesRetired = useAliasesRetired();
  const kind: AssistCardKind = card.kind;
  const { index, outcome } = card;
  const open = message.canApprove && outcome === null;

  const read = useQuery({
    queryKey: assistCardKey(message.id, index),
    queryFn: () => ipcQuery("assist:card", { conversationId, messageId: message.id, index }),
  });
  // Re-read when the work or the configuration moves, which is what can
  // change whether the button would be refused. It used to ride along
  // with every re-read of the room, including each streamed event of any
  // run; it no longer sits under the room's key (EO-550).
  useInvalidateOnPush("items:changed", assistCardKey(message.id, index));
  useInvalidateOnPush("config:changed", assistCardKey(message.id, index));
  const detail = read.data?.card ?? null;

  // Keep mine unless the person says otherwise: the module here is code
  // somebody on this machine approved.
  const [choices, setChoices] = useState<Record<string, "reuse" | "import">>({});
  const collisions = detail?.kind === "pipelineImport" ? detail.preflight.collisions : [];
  const chosen = Object.fromEntries(collisions.map((collision) => [collision.slug, choices[collision.slug] ?? "reuse"]));

  // The agent each kind's steps name where the project has several
  // (EO-877): the first offered until the person picks another. The
  // import is refused without one, so one is always sent.
  const [agentPicks, setAgentPicks] = useState<Record<string, string>>({});
  const toChoose = detail?.kind === "pipelineImport" ? detail.preflight.roleSlots.filter((slot) => slot.binding === "choose") : [];
  const pickedAgents = Object.fromEntries(toChoose.flatMap((slot) => {
    const picked = agentPicks[slot.slug] ?? slot.agents[0]?.id;
    return picked === undefined ? [] : [[slot.slug, picked]];
  }));

  // What the person types for a step's own secret or variable. Held here
  // only until the press, and emptied by it whatever came of it.
  const [value, setValue] = useState("");
  const typesValue = (detail?.kind === "stepSecret" || detail?.kind === "stepVariable") && detail.action === "set";

  // A job card's Delete: keep the job's items, unless the person says to
  // archive them — `jobs:delete`'s own default, and the dialog's.
  const [archiveItems, setArchiveItems] = useState<"keep" | "archive">("keep");
  const asksItems = detail?.kind === "jobDelete" && detail.itemCount > 0;

  // A `cliToolsAssign` card's boxes (EO-859): what the person unticked —
  // adds by command, rows by agent and CLI. Everything else is ticked.
  const [unticked, setUnticked] = useState<CliToolsUnticked>(NOTHING_UNTICKED);
  const assigned = detail?.kind === "cliToolsAssign" ? assignTicks(detail, unticked) : null;

  const [problem, setProblem] = useState<string | null>(null);
  const press = useMutation({
    mutationFn: () =>
      ipcQuery("assist:applyCard", {
        conversationId,
        messageId: message.id,
        index,
        choices: chosen,
        ...(toChoose.length > 0 ? { agents: pickedAgents } : {}),
        ...(typesValue ? { value } : {}),
        ...(kind === "jobDelete" ? { archiveItems: asksItems && archiveItems === "archive" } : {}),
        ...(kind === "cliToolsAssign" ? { unticked: { adds: [...unticked.adds], rows: [...unticked.rows].map(rowOfKey) } } : {}),
      }),
    onSuccess: (result) => {
      setValue("");
      // The card spent, as the answer says, before anything is re-read (EO-548).
      drawAssistReply(queryClient, result.conversation);
      // What was filed under the card arrives with the conversation; a
      // problem nothing was filed for is said here instead.
      setProblem(result.said === null ? result.problem : null);
      // A refused assignment wrote nothing: re-read the card, which now shows why on the row.
      if (result.said === null && kind === "cliToolsAssign") void queryClient.invalidateQueries({ queryKey: assistCardKey(message.id, index) });
      if (result.said !== null) {
        if (detail?.kind === "pipelineWebhookUnattended") void queryClient.invalidateQueries({ queryKey: pipelineStepsKey(detail.pipelineId) });
        if (kind === "stepSecret") void queryClient.invalidateQueries({ queryKey: moduleSecretsRootKey });
        if (kind === "stepVariable") void queryClient.invalidateQueries({ queryKey: environmentVariablesRootKey });
        if (kind !== "pipelineExport" && !kind.startsWith("itemType") && !kind.startsWith("job") && !kind.startsWith("cliTool")) void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
        // A job card: the Jobs list and page move, and the card re-reads what it made, for its link.
        if (kind.startsWith("job")) {
          void queryClient.invalidateQueries({ queryKey: jobsRootKey });
          void queryClient.invalidateQueries({ queryKey: assistCardKey(message.id, index) });
          if (kind === "jobDelete" || kind === "jobWebhook") void queryClient.invalidateQueries({ queryKey: itemsKey });
        }
        // A CLI card: the Agent tools screen's catalogue and ticks move (EO-821's keys).
        if (kind === "cliToolAdd") void queryClient.invalidateQueries({ queryKey: cliToolsKey });
        if (kind === "cliToolAttach") void queryClient.invalidateQueries({ queryKey: agentCliToolsKey });
        if (kind === "cliToolsAssign") {
          void queryClient.invalidateQueries({ queryKey: cliToolsKey });
          void queryClient.invalidateQueries({ queryKey: agentCliToolsKey });
        }
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

  const label = assigned === null ? buttonFor(kind, detail) : { ...buttonFor(kind, detail), idle: assigned.label };
  const refused = detail !== null && (cannotPress(detail) || (assigned !== null && assigned.count === 0));
  const pressable = open && detail !== null && !refused && !(typesValue && value === "");

  // The press a block's "do all" makes (EO-863): this button's, to the
  // letter, resolving to whether it ended done. The latest render's, so
  // what the person chose on the card goes with it.
  const pressNow = useRef<() => Promise<boolean>>(async () => false);
  pressNow.current = async () => {
    // Never a second press over one still in flight.
    if (press.isPending) return false;
    try {
      const result = await press.mutateAsync();
      return result.said !== null && result.applied;
    } catch {
      return false;
    }
  };
  const report = useRef(onPress);
  report.current = onPress;
  const verb = verbOf(buttonFor(kind, detail).idle);
  const pending = press.isPending;
  useEffect(() => {
    report.current?.(pressable ? { verb, pending, press: () => pressNow.current() } : null);
  }, [pressable, verb, pending]);
  useEffect(() => () => report.current?.(null), []);

  return (
    <section aria-label={TITLE[kind]} className="flex flex-col gap-2.5 rounded-[14px] bg-canvas-subtle px-4 py-3.5">
      <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
        <span className="shrink-0">{ICON[kind]}</span>
        <b className="min-w-0 truncate text-[13px] font-semibold text-ink">{detail === null ? TITLE[kind] : subjectOf(detail)}</b>
        <span className="ml-auto shrink-0 text-[11.5px] text-ink-subtle">{STATE[kind]}</span>
      </div>

      {/* What pressing it would do — until it has been pressed, when what it did is below instead. */}
      {outcome !== null ? null : detail?.kind === "cliToolsAssign" && assigned !== null ? (
        <CliToolsAssignBody detail={detail} ticks={assigned} open={open} disabled={disabled} unticked={unticked} onChange={setUnticked} />
      ) : detail !== null ? (
        <Body detail={detail} itemsWord={vocabulary.items.toLowerCase()} itemWord={vocabulary.item.toLowerCase()} aliasesRetired={aliasesRetired} />
      ) : (
        <Markdown className="text-[13px] leading-relaxed">{proseOf(message, index)}</Markdown>
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
                disabled={disabled}
                label={`What to do about ${collision.slug}`}
                value={chosen[collision.slug] ?? "reuse"}
                options={CHOICES}
                onChange={(choice) => setChoices((before) => ({ ...before, [collision.slug]: choice }))}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {open && toChoose.length > 0 ? (
        <ul aria-label="Agents to choose" className="flex flex-col gap-1.5">
          {toChoose.map((slot) => (
            <li key={slot.slug} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-canvas px-3 py-2 text-[12.5px]">
              <span className="min-w-0 flex-1 text-ink-muted">
                You have several <code className="font-mono text-ink">{slot.slug}</code> agents. Its steps run the one you choose.
              </span>
              <Select
                aria-label={`Agent for the ${slot.slug} steps`}
                disabled={disabled}
                value={pickedAgents[slot.slug] ?? ""}
                onChange={(event) => setAgentPicks((before) => ({ ...before, [slot.slug]: event.target.value }))}
              >
                {slot.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} · {agent.backend}
                  </option>
                ))}
              </Select>
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

      {open && asksItems && detail?.kind === "jobDelete" ? (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-muted">
          <span>
            Its {detail.itemCount === 1 ? "item" : `${detail.itemCount} items`}:
          </span>
          <Segmented size="sm" disabled={disabled} label="What happens to the job's items" value={archiveItems} options={ITEMS_CHOICES} onChange={setArchiveItems} />
        </div>
      ) : null}

      {open ? (
        <div className="flex items-center gap-2">
          <Button
            variant={kind === "pipelineDelete" || kind === "itemTypeDelete" || kind === "jobDelete" ? "danger" : "primary"}
            size="sm"
            disabled={disabled || press.isPending || detail === null || refused || (typesValue && value === "")}
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
          {/* What a job card made, linked (EO-786): the job, or the item a test event filed. */}
          {outcome.done && detail?.kind === "jobCreate" && detail.created !== null ? (
            <Link to={`/jobs/${detail.created.jobId}`} className="text-[12.5px] text-accent underline-offset-2 hover:underline">
              Open {detail.created.name}
            </Link>
          ) : null}
          {outcome.done && detail?.kind === "jobWebhook" && detail.filed !== null ? (
            <Link to={`/items/${detail.filed.itemId}`} className="font-mono text-[12.5px] text-accent underline-offset-2 hover:underline">
              {detail.filed.itemKey}
            </Link>
          ) : null}
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

/** A card's own press, as a block's "do all" makes it (EO-863). */
export interface CardPress {
  /** The button's verb, for the block's "… all": "Give", "Add", "Create". */
  verb: string;
  /** Its own press is in flight: a block starts no "do all" until it lands. */
  pending: boolean;
  /** Presses the card through its own button's call; true when it ended done. */
  press: () => Promise<boolean>;
}

/** The verb a button's words start with: "Give CLI" → "Give", "Export…" → "Export". */
function verbOf(idle: string): string {
  return (idle.split(" ")[0] ?? idle).replace(/…$/, "");
}

/** An import's choice per colliding module, as the editor's Import offered it. */
const CHOICES = [
  { value: "reuse", label: "Keep mine" },
  { value: "import", label: "Import theirs" },
] as const satisfies readonly { value: "reuse" | "import"; label: string }[];

/** A job card's Delete: what happens to the items the job filed. */
const ITEMS_CHOICES = [
  { value: "keep", label: "Keep them" },
  { value: "archive", label: "Archive them" },
] as const satisfies readonly { value: "keep" | "archive"; label: string }[];

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
  jobCreate: "Create a job",
  jobUpdate: "Change a job",
  jobDelete: "Delete a job",
  jobWebhook: "A webhook job",
  cliToolAdd: "Add a command-line tool",
  cliToolAttach: "An agent's command-line tool",
  cliToolsAssign: "Command-line tools for agents",
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
  jobCreate: "create job",
  jobUpdate: "change job",
  jobDelete: "delete job",
  jobWebhook: "webhook",
  cliToolAdd: "add CLI",
  cliToolAttach: "agent CLI",
  cliToolsAssign: "agent CLIs",
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
  jobCreate: <CalendarClock aria-hidden size={14} />,
  jobUpdate: <CalendarClock aria-hidden size={14} />,
  jobDelete: <Trash2 aria-hidden size={14} />,
  jobWebhook: <Webhook aria-hidden size={14} />,
  cliToolAdd: <Terminal aria-hidden size={14} />,
  cliToolAttach: <Terminal aria-hidden size={14} />,
  cliToolsAssign: <Terminal aria-hidden size={14} />,
};

type ButtonWords = { idle: string; pending: string; done: string; refused: string };

const BUTTON: Record<Exclude<AssistCardKind, "pipelineWebhookUnattended" | "stepSecret" | "stepVariable" | "jobWebhook" | "cliToolAttach">, ButtonWords> = {
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
  jobCreate: { idle: "Create job", pending: "Creating…", done: "Created", refused: "Not created" },
  jobUpdate: { idle: "Save job", pending: "Saving…", done: "Saved", refused: "Not saved" },
  jobDelete: { idle: "Delete job", pending: "Deleting…", done: "Deleted", refused: "Not deleted" },
  cliToolAdd: { idle: "Add CLI", pending: "Adding…", done: "Added", refused: "Not added" },
  // Its idle words count the ticked rows instead — see `assignTicks`.
  cliToolsAssign: { idle: "Apply", pending: "Applying…", done: "Applied", refused: "Not applied" },
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
    case "jobWebhook": {
      const action = detail?.kind === "jobWebhook" ? detail.action : null;
      if (action === "regenerateSecret") return { idle: "Regenerate secret", pending: "Regenerating…", done: "Regenerated", refused: "Not regenerated" };
      if (action === "testEvent") return { idle: "Send test event", pending: "Sending…", done: "Sent", refused: "Not sent" };
      return { idle: "Apply", pending: "Applying…", done: "Done", refused: "Not done" };
    }
    case "cliToolAttach": {
      const attached = detail?.kind === "cliToolAttach" ? detail.attached : null;
      if (attached === true) return { idle: "Give CLI", pending: "Giving…", done: "Given", refused: "Not given" };
      if (attached === false) return { idle: "Take CLI away", pending: "Taking away…", done: "Taken away", refused: "Not taken away" };
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
    case "cliToolAdd":
      // What `cliTools:save` would refuse the press with — said on the card instead.
      return detail.problem !== null;
    case "cliToolAttach":
      // Already as asked, or a CLI no agent is told about while it is archived.
      return detail.current === detail.attached || (detail.attached && detail.archived);
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
    case "jobCreate":
      return detail.name;
    case "jobUpdate":
    case "jobDelete":
    case "jobWebhook":
      return detail.jobName;
    case "cliToolAdd":
      return detail.name;
    case "cliToolAttach":
      return `${detail.cliToolName} · ${detail.agentName}`;
    case "cliToolsAssign": {
      const agents = new Set(detail.rows.map((row) => row.agentId)).size;
      return agents === 0 ? "Command-line tools" : `Command-line tools · ${agents === 1 ? detail.rows[0]!.agentName : `${agents} agents`}`;
    }
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
    case "jobCreate":
      return (
        <div className="flex flex-col gap-1.5">
          <p className={text}>A new job on {detail.projectName}, as it would be.</p>
          <JobLines lines={detail.lines} />
        </div>
      );
    case "jobUpdate":
      return (
        <div className="flex flex-col gap-1.5">
          <p className={text}>What changes on {detail.jobName}:</p>
          <ul aria-label="What changes" className="flex flex-col gap-1 text-[12.5px]">
            {detail.changes.map((change) => (
              <li key={change.label} className="flex flex-wrap gap-1.5">
                <span className="text-ink-subtle">{change.label}</span>
                <span className="text-ink-subtle line-through">{change.before}</span>
                <span aria-hidden>→</span>
                <span className="text-ink">{change.after}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "jobDelete":
      return (
        <div className="flex flex-col gap-1.5">
          <p className={text}>
            {detail.jobName} fires nothing again. {detail.itemCount === 0 ? `It has filed no ${itemsWord} that are not archived.` : `Choose below whether the ${detail.itemCount === 1 ? itemWord : `${detail.itemCount} ${itemsWord}`} it filed stay where they are or go to the Archive.`}
          </p>
          <JobLines lines={detail.lines} />
        </div>
      );
    case "cliToolAdd":
      return <CliToolAddBody detail={detail} />;
    case "cliToolAttach":
      return (
        <div className="flex flex-col gap-1">
          <p className={text}>
            {detail.attached
              ? `Gives ${detail.agentName} ${detail.cliToolName}: from its next dispatch it is told the program exists and what it is for, where EO finds it installed.`
              : `Takes ${detail.cliToolName} away from ${detail.agentName}: from its next dispatch it is no longer told about it.`}{" "}
            The command is <code className="font-mono text-ink">{detail.command}</code>.
          </p>
          {detail.current === detail.attached ? (
            <p className="text-[12.5px] text-ink-subtle">
              {detail.agentName} {detail.current ? "already has it" : "does not have it"}, so there is nothing to change.
            </p>
          ) : detail.attached && detail.archived ? (
            <p className="text-[12.5px] text-ink-subtle">{detail.cliToolName} is archived. Restore it on the Agent tools screen first.</p>
          ) : null}
        </div>
      );
    case "cliToolsAssign":
      // Drawn by `CliToolsAssignBody`, which holds the boxes.
      return null;
    case "jobWebhook":
      return detail.action === "regenerateSecret" ? (
        <p className={text}>
          Makes a new signing secret for {detail.jobName}. <b className="font-semibold text-ink">The old secret stops working the moment the button is pressed</b>: every sender
          still signing with it is refused until it is given the new one, which you read on the job&apos;s page.
        </p>
      ) : (
        <p className={text}>
          Sends one test event to {detail.jobName} through its webhook at <code className="font-mono text-ink">{detail.address}</code>, signed with its own secret. It may file a
          new {itemWord} on its pipeline.
        </p>
      );
  }
}

/**
 * A command-line tool as an add card shows it (EO-822): the command, the
 * description an agent will read, and whether this machine has it — read
 * when the card is drawn, never the assistant's word.
 */
function CliToolAddBody({ detail }: { detail: Extract<AssistCardDetail, { kind: "cliToolAdd" }> }) {
  const found = detail.detection;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] leading-relaxed text-ink-muted">
        A new command-line tool in the catalogue. No agent is told about it until one is given it, and it grants nothing: an agent runs it through the shell it already has.
      </p>
      <CliToolLines command={detail.command} description={detail.description} detection={found} />
      {found !== null && !found.found ? (
        <p className="text-[12.5px] text-ink-subtle">An agent given it is told about it only on a machine where EO finds it installed.</p>
      ) : null}
      {detail.problem !== null ? (
        <p role="note" aria-label="Refused" className="text-[12.5px] text-danger">
          {detail.problem}
        </p>
      ) : null}
    </div>
  );
}

type CliToolsAssignDetail = Extract<AssistCardDetail, { kind: "cliToolsAssign" }>;
type CliToolsAssignRow = CliToolsAssignDetail["rows"][number];
/** What the person unticked on a `cliToolsAssign` card: adds by command, rows by `rowKey`. */
type CliToolsUnticked = { adds: ReadonlySet<string>; rows: ReadonlySet<string> };

const NOTHING_UNTICKED: CliToolsUnticked = { adds: new Set(), rows: new Set() };

/** One agent × CLI row's key: the agent and the CLI as the card names it. */
const rowKey = (row: { agentId: string; cli: string }): string => JSON.stringify([row.agentId, row.cli]);
function rowOfKey(key: string): { agentId: string; cli: string } {
  const [agentId, cli] = JSON.parse(key) as [string, string];
  return { agentId, cli };
}

/** Which of a `cliToolsAssign` card's boxes are ticked, and what the button says it will do. */
interface AssignTicks {
  addTicked: (command: string) => boolean;
  /** Ticked and pressable: not in place, and not giving a new CLI whose add is unticked. */
  rowTicked: (row: CliToolsAssignRow) => boolean;
  /** A row whose box cannot be changed: its add is unticked, so there is nothing to give. */
  rowDisabled: (row: CliToolsAssignRow) => boolean;
  count: number;
  label: string;
}

function assignTicks(detail: CliToolsAssignDetail, unticked: CliToolsUnticked): AssignTicks {
  const addTicked = (command: string) => !unticked.adds.has(command);
  const rowDisabled = (row: CliToolsAssignRow) => row.add !== null && !addTicked(row.add);
  const rowTicked = (row: CliToolsAssignRow) => !row.inPlace && !rowDisabled(row) && !unticked.rows.has(rowKey(row));
  const adds = detail.adds.filter((add) => addTicked(add.command)).length;
  const gives = detail.rows.filter((row) => row.give && rowTicked(row)).length;
  const takes = detail.rows.filter((row) => !row.give && rowTicked(row)).length;
  const words = [adds > 0 ? `add ${adds}` : null, gives > 0 ? `give ${gives}` : null, takes > 0 ? `take ${takes}` : null].filter((word) => word !== null).join(", ");
  return {
    addTicked,
    rowTicked,
    rowDisabled,
    count: adds + gives + takes,
    label: words === "" ? "Nothing ticked" : words.charAt(0).toUpperCase() + words.slice(1),
  };
}

/** Toggles one entry of a set, as a new set. */
function toggled(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/**
 * A `cliToolsAssign` card's body (EO-859): a section per CLI it adds,
 * with whether this machine has it, then a row per agent × CLI with
 * give or take and what the agent has now. Boxes only while the card can
 * be pressed, and none on a row already in place.
 */
function CliToolsAssignBody({
  detail,
  ticks,
  open,
  disabled,
  unticked,
  onChange,
}: {
  detail: CliToolsAssignDetail;
  ticks: AssignTicks;
  open: boolean;
  /** Held still, as a block does while "do all" runs (EO-863). */
  disabled: boolean;
  unticked: CliToolsUnticked;
  onChange: (next: CliToolsUnticked) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {detail.rows.length === 0 ? (
        // Adds alone (EO-860): nobody is given anything, so no agent rows.
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Untick anything you do not want. Adding a CLI gives it to no agent: none is told about it until one is given it.
        </p>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Untick anything you do not want. An agent is told about a CLI it is given from its next dispatch, where EO finds the program installed; a CLI grants nothing, as an
          agent runs it through the shell it already has.
        </p>
      )}
      {detail.adds.map((add) => (
        <section key={add.command} aria-label={`Add ${add.name}`} className="flex flex-col gap-1.5 rounded-[10px] bg-canvas px-3 py-2">
          {open ? (
            <Checkbox
              checked={ticks.addTicked(add.command)}
              disabled={disabled}
              ariaLabel={`Add ${add.name}`}
              onChange={(on) => onChange({ ...unticked, adds: toggled(unticked.adds, add.command, !on) })}
              label={<b className="font-semibold">Add {add.name}</b>}
            />
          ) : (
            <b className="text-[13px] font-semibold text-ink">Add {add.name}</b>
          )}
          <CliToolLines command={add.command} description={add.description} detection={add.detection} />
          {add.problem !== null ? (
            <p role="note" aria-label="Refused" className="text-[12.5px] text-danger">
              {add.problem}
            </p>
          ) : null}
        </section>
      ))}
      {detail.rows.length > 0 ? (
        <ul aria-label="Agents" className="flex flex-col gap-1">
          {detail.rows.map((row) => {
            const words = row.give ? `Give ${row.agentName} ${row.cliToolName}` : `Take ${row.cliToolName} from ${row.agentName}`;
            const now = row.inPlace
              ? row.current
                ? "already has it"
                : "does not have it"
              : row.current
                ? "has it now"
                : row.add !== null
                  ? "new"
                  : "does not have it now";
            const line = (
              <span className="flex flex-wrap items-baseline gap-x-1.5">
                <span>{words}</span>
                <code className="font-mono text-[12px] text-ink-muted">{row.command}</code>
                <span className="text-[12px] text-ink-subtle">· {now}</span>
              </span>
            );
            return (
              <li key={rowKey(row)} aria-label={words} className="flex flex-col gap-0.5 text-[13px] text-ink">
                {open && !row.inPlace ? (
                  <Checkbox
                    checked={ticks.rowTicked(row)}
                    disabled={disabled || ticks.rowDisabled(row)}
                    ariaLabel={words}
                    onChange={(on) => onChange({ ...unticked, rows: toggled(unticked.rows, rowKey(row), !on) })}
                    label={line}
                  />
                ) : (
                  <span className={row.inPlace ? "text-ink-subtle" : undefined}>{line}</span>
                )}
                {row.problem !== null ? (
                  <p role="note" aria-label="Refused" className="pl-6 text-[12.5px] text-danger">
                    {row.problem}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** A CLI's command, description and whether this machine has it — as an add card shows them. */
function CliToolLines({ command, description, detection }: { command: string; description: string; detection: CliToolDetection | null }) {
  return (
    <dl aria-label="The command-line tool" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
      <dt className="text-ink-subtle">Command</dt>
      <dd>
        <code className="font-mono text-ink">{command}</code>
      </dd>
      <dt className="text-ink-subtle">Description</dt>
      <dd className="break-words text-ink">{description === "" ? <span className="text-ink-subtle">None</span> : description}</dd>
      <dt className="text-ink-subtle">On this machine</dt>
      <dd className="break-words text-ink">
        {detection === null ? (
          <span className="text-ink-subtle">Could not be checked</span>
        ) : detection.found ? (
          <>
            Found at <code className="font-mono">{detection.path}</code>
          </>
        ) : (
          "Not found"
        )}
      </dd>
    </dl>
  );
}

/** A job as a job card shows it (EO-786): each field the Job page has, in words. */
function JobLines({ lines }: { lines: readonly JobCardLine[] }) {
  return (
    <dl aria-label="The job" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
      {lines.map((line) => (
        <div key={line.label} className="contents">
          <dt className="text-ink-subtle">{line.label}</dt>
          <dd className="break-words text-ink">{line.value}</dd>
        </div>
      ))}
    </dl>
  );
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

/**
 * What a card says in prose, shown until what it shows is read: the
 * message's body, or on a reply carrying several cards (EO-862) the part
 * of it headed with this card's place — "**Card 2 of 3.** …".
 */
function proseOf(message: DiscussionMessage, index: number): string {
  if ((message.cards?.length ?? 0) < 2) return message.body;
  const heading = `**Card ${index + 1} of `;
  return message.body.split("\n\n").find((part) => part.startsWith(heading)) ?? message.body;
}
