import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, Check, Copy, GitBranch, GitFork, LoaderCircle, PanelLeftClose, PanelRight, Pencil, RotateCcw, Sparkles } from "lucide-react";
import { MODULE_COVERAGE_BAR, pipelineMachineSpecificWarnings, TURN_STOPPED_NOTE, type AssistWaitingModule, type DiscussionMessage, type HandOffTargets, type LiveTurn, type PipelineView } from "@eo/core";
import { Markdown, cn } from "@eo/ui";
import { AttachmentCard } from "./conversation/AttachmentCard";
import { DesignPlan } from "./conversation/DesignPlan";
import { WorkingLine } from "./conversation/WorkingLine";
import { approveAndPublishAssistDraft, approveAssistDesign, publishAssistDraft, type ApprovedAndPublishedDraft, type PublishedDraft } from "../shared/assist/draft";
import { useLiveDrafts } from "../shared/assist/liveDeltas";
import { assistDraftKey, drawAssistReply, mergedMessages, pendingToDraw, SENT_INTO_THE_TURN, useAssistRoom, type PendingSend } from "../shared/assist/useAssistRoom";
import { OfferedAnswers } from "./conversation/OfferedAnswers";
import { OperationCard } from "./conversation/OperationCard";
import { TrialPublishCard } from "./conversation/TrialPublishCard";
import { ProposalCard } from "./conversation/ProposalCard";
import { QuestionCard, transcriptRows, type TranscriptRow } from "./conversation/QuestionCard";
import { Composer, type ComposerCompletion } from "./conversation/Composer";
import { ChatSettings } from "./conversation/ChatSettings";
import { LiveTurnBody, TurnFold } from "./conversation/TurnView";
import { useStickToBottom } from "./conversation/useStickToBottom";
import { ModuleChangeCard } from "./modules/ModuleChangeCard";
import { DraftModuleRow } from "./modules/DraftModuleRow";
import { ModuleProposal } from "./modules/ModuleProposal";
import { MachineSpecificValues } from "./modules/MachineSpecificValues";
import { ipcQuery } from "../query/client";
import { itemsKey, modulesKey, pipelineStepsKey, useChromeVocabulary, useModulesWithDeleted, usePipelines } from "../query/hooks";
import { useProjects } from "../query/useRepositories";
import { PipelineDrawing } from "./graph/PipelineDrawing";
import { Button, IconButton } from "./kit";
import { CONTROLS_END } from "./windowChrome";
import { withArticle } from "./parts";

/**
 * The conversation: the assistant's room, drawn as the chat layout's
 * middle column (ARCHITECTURE.md, "The chat-centric layout").
 *
 * The same room the help widget opens — one thread with the system agent,
 * `useAssistRoom` underneath — so a turn started here and a turn started
 * from the widget are one conversation. What differs is the drawing: what
 * you said sits on the right in a bubble, what the assistant said runs
 * full width beside its mark, and the two things that ask for a decision
 * are cards — a pipeline the assistant drafted, with its steps and who
 * owns each, a change it proposed to the work, a module it wrote, and
 * something only the person may do with a pipeline, with the button that
 * does it.
 *
 * A turn is drawn the way Claude Desktop draws one. While it runs, its
 * steps appear as they happen — what it says, what it thinks, each tool it
 * calls — and its words arrive as they are written (`runs:delta`), not a
 * paragraph at a time. Once it has answered, everything it did on the way
 * folds behind one line above the answer ("Worked for 1m · 12 tool
 * calls"). The box offers Stop while it runs, and Escape does the same;
 * the transcript follows the newest words only while the person is
 * reading the newest words.
 */
export function ChatConversation({
  narrow,
  context,
  drawerOpen,
  onToggleDrawer,
  hidden = false,
  onFold,
  focusRequest = 0,
  atWindowEnd = false,
}: {
  /** Beside the canvas, where the column is a fixed width rather than the window's middle. */
  narrow: boolean;
  /** A chip naming what is open beside the conversation, if anything is. */
  context?: ReactNode;
  /** The home's right column, and the control that hides it. Absent beside the canvas. */
  drawerOpen?: boolean;
  onToggleDrawer?: () => void;
  /** Folded to its strip beside a view; the column stays mounted, and keeps what was typed. */
  hidden?: boolean;
  /** Folds the column to a strip, giving the view beside it the width. */
  onFold?: () => void;
  /** Bumped by a view's hand-off (`askAssistant.tsx`) to put the cursor in the box. */
  focusRequest?: number;
  /** Nothing is beside the column, so its header's end is under the window controls (EO-668). */
  atWindowEnd?: boolean;
}) {
  const room = useAssistRoom(true);
  const view = room.conversation;
  // The pages read back so far, then the view's newest stretch; a message
  // in both (the view moved on while a page was read) is drawn once.
  const olderMessages = room.earlier.messages;
  const messages = useMemo(() => mergedMessages(olderMessages, view?.messages ?? []), [view, olderMessages]);
  const rows = useMemo(() => transcriptRows(messages), [messages]);
  // The message on its way, until the conversation holding it is drawn (EO-549).
  const pending = pendingToDraw(room.pending, view?.id ?? null, messages);
  const thinking = view?.thinking ?? false;
  const transcript = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  /*
   * Asked for from outside (a view's "Ask the assistant", the rail's New
   * pipeline): the cursor goes to the end of whatever is in the box. A
   * request made before the box exists — the room still opening — is
   * kept until it does, rather than spent on a box that is not there
   * (EO-525). The count this column mounted with asks for nothing: a
   * conversation drawn afresh is not somebody asking to type.
   */
  const answeredFocus = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === answeredFocus.current) return;
    const element = composer.current;
    if (!room.available || !element) return;
    answeredFocus.current = focusRequest;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [focusRequest, room.available]);
  const { active } = useProjects();
  const { refresh } = room;
  const { following, jumpToLatest } = useStickToBottom(transcript, content, `${view?.id ?? ""}:${hidden ? "folded" : "open"}`);
  const queryClient = useQueryClient();

  const answer = useMutation({
    mutationFn: async (answers: { questionId: string; answer: string | null }[]) => {
      const result = await ipcQuery("assist:answer", { conversationId: view!.id, answers });
      // The card closes on the conversation the answer came back with, not
      // on a refetch (EO-548): drawn live until then, it took its picks
      // again. Drawn before a refusal is thrown as well — "already answered
      // or replaced by a newer turn" carries the thread that closed or
      // replaced this card, and the card should stop asking at once.
      drawAssistReply(queryClient, result.conversation);
      if (result.problem) throw new Error(result.problem);
      return result;
    },
    onSettled: () => room.refresh(),
  });

  // Focus goes back to the box when a send settles — the box is disabled
  // while it is in flight, and the browser drops focus from a disabled
  // element. Not on mount: in this layout the room is always there, and a
  // mount is not somebody asking to type.
  const sentBefore = useRef(room.sending);
  useEffect(() => {
    const settled = sentBefore.current && !room.sending;
    sentBefore.current = room.sending;
    if (settled) composer.current?.focus();
  }, [room.sending]);

  // What a person said last, for Up in an empty box and for Retry.
  const lastMine = useMemo(() => [...messages].reverse().find((message) => message.authorType === "human" && message.parentId === null) ?? null, [messages]);
  const lastSaid = useMemo(() => [...messages].reverse().find((message) => message.authorType !== "human") ?? null, [messages]);
  // Sent and waiting for its turn to start: the engine dispatches on its
  // next tick, and until then the room would otherwise say nothing at all.
  const starting = !thinking && lastMine !== null && (lastMine.status === "queued" || lastMine.status === "processing");
  // Retry asks the same thing again, so it is offered only where that is
  // what it would do: under the reply to (or the stop of) the person's
  // last message, with nothing newer waiting and nothing running, and not
  // for a message whose files are no longer staged to send again.
  const retryable =
    lastSaid !== null &&
    lastMine !== null &&
    lastMine.createdAt <= lastSaid.createdAt &&
    lastMine.attachments.length === 0 &&
    !thinking &&
    !starting;
  const retry = retryable ? () => void room.send(lastMine.body) : null;

  const commands = useChatCommands(room, lastSaid?.id ?? null, queryClient);

  // Edit, as Claude Desktop has it: the thread is a record and is not
  // rewritten, so editing a message branches — a new chat holding the
  // conversation up to just before it — with the words back in the box to
  // change and send. The first message of a chat has nothing before it,
  // so its edit starts an empty chat.
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const edit = (message: DiscussionMessage): void => {
    const index = messages.findIndex((candidate) => candidate.id === message.id);
    const before = index > 0 ? messages[index - 1] : undefined;
    if (before) room.fork(before.id);
    else room.startNew();
    setPrefill((current) => ({ text: message.body, nonce: (current?.nonce ?? 0) + 1 }));
  };

  // What a row can ask of the conversation, as one object that stays the
  // same from render to render, so a finished row is drawn again only when
  // its own message changes (EO-551). Each reads what is current when it
  // is pressed, not what was current when the row was last drawn.
  const latest = useRef({ room, edit, retry, answer: answer.mutateAsync });
  useLayoutEffect(() => {
    latest.current = { room, edit, retry, answer: answer.mutateAsync };
  });
  const handlers = useMemo<RowHandlers>(
    () => ({
      withdraw: (messageId) => latest.current.room.withdraw(messageId),
      fork: (messageId) => latest.current.room.fork(messageId),
      edit: (message) => latest.current.edit(message),
      retry: () => latest.current.retry?.(),
      answer: (answers) => latest.current.answer(answers),
      refresh: () => latest.current.room.refresh(),
    }),
    [],
  );

  // A long chat carries its newest stretch, with older pages read from
  // the main process on demand — Claude Desktop's paged transcript, so a
  // month-long thread is neither sent nor drawn whole on every word.
  const shownRows = rows;

  // The reading measure on the home, and the column's own width beside the canvas.
  const measure = narrow ? "w-full" : "w-full max-w-[42.5rem]";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Part of the window's title bar (EO-668): it drags the window, and
          at the window's right edge it ends short of the controls. */}
      <header
        className="app-drag flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line px-5"
        style={atWindowEnd ? { paddingRight: `calc(1.25rem + ${CONTROLS_END})` } : undefined}
      >
        <span className="text-[14px] font-semibold text-ink">Assistant</span>
        {context}
        <span className="flex-1" />
        {onFold ? (
          <IconButton label="Fold the conversation" title="Give the screen beside it the width" icon={<PanelLeftClose size={16} />} onClick={onFold} />
        ) : null}
        {onToggleDrawer ? (
          <IconButton
            label={drawerOpen ? "Hide the side panel" : "Show the side panel"}
            aria-pressed={drawerOpen}
            icon={<PanelRight size={16} />}
            onClick={onToggleDrawer}
          />
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={transcript} aria-label="Assistant transcript" className="absolute inset-0 overflow-y-auto">
          <div ref={content} className={cn("mx-auto flex min-h-full flex-col justify-end gap-[18px] px-5 pb-4 pt-6 *:shrink-0", measure)}>
            {!room.available && !room.loading ? (
              <p className="text-[13px] leading-relaxed text-ink-muted">
                There is no enabled system agent, so there is nobody here to ask. Enable one on the{" "}
                <Link to="/agents" className="text-accent-soft hover:underline">
                  Agents
                </Link>{" "}
                screen and this conversation opens.
              </p>
            ) : null}

            {room.available && messages.length === 0 && !pending && !room.loading ? <EmptyRoom /> : null}

            {room.earlier.remaining > 0 ? (
              <button
                type="button"
                onClick={room.earlier.load}
                disabled={room.earlier.loading}
                aria-busy={room.earlier.loading}
                className="self-center rounded-[10px] px-3 py-1.5 text-[12px] text-ink-subtle hover:bg-canvas-raised hover:text-ink disabled:opacity-60"
              >
                {room.earlier.loading ? "Reading earlier messages…" : `Show earlier messages (${room.earlier.remaining})`}
              </button>
            ) : null}

            {shownRows.map((row) => (
              <ChatRow
                key={row.kind === "questions" ? row.batch.id : row.message.id}
                row={row}
                conversationId={view?.id ?? ""}
                retry={row.kind === "message" && retry !== null && row.message.id === lastSaid?.id}
                busy={row.kind === "questions" && row.live && (answer.isPending || thinking)}
                handlers={handlers}
              />
            ))}

            {pending ? <Sending pending={pending} /> : null}

            <LiveReply turn={view?.liveTurn} conversationId={view?.id} thinking={thinking} agentName={view?.settings.agentName ?? ""} onGap={refresh} />
            {thinking ? <WorkingLine since={view?.thinkingSince ?? null} /> : starting ? <WorkingLine since={lastMine?.createdAt ?? null} label="Starting" /> : null}
          </div>
        </div>
        {!following ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-[10px] bg-canvas-raised px-3 py-1.5 text-[12px] text-ink shadow-panel hover:bg-canvas-hover"
          >
            <ArrowDown aria-hidden size={13} />
            {thinking ? "Follow the reply" : "Jump to latest"}
          </button>
        ) : null}
      </div>

      {room.problem ? <p className={cn("mx-auto px-5 pb-2 text-[12px] text-danger", measure)}>{room.problem}</p> : null}
      {/* Where a message went when it missed the turn it was sent during (EO-395). */}
      {room.notice ? (
        <p role="status" className={cn("mx-auto px-5 pb-2 text-[12px] text-ink-muted", measure)}>
          {room.notice}
        </p>
      ) : null}

      {room.available ? (
        <div className="shrink-0 pb-[18px]">
          <div className={cn("mx-auto px-5", measure)}>
            <Composer
              appearance="chat"
              mentionables={[]}
              completions={commands.completions}
              onCommand={commands.run}
              textareaRef={composer}
              ariaLabel="Message the assistant"
              busy={room.sending}
              running={thinking}
              onStop={room.stop}
              stopping={room.stopping}
              recallLast={lastMine?.body ?? null}
              prefill={prefill}
              // Typing starts the backend for the turn being asked for, so
              // the first word arrives sooner (Claude Desktop's warm start).
              onTyping={thinking ? undefined : room.prewarm}
              typingScope={view?.id}
              // The transcript draws the message as sending, so the box is free of it at once (EO-549).
              clearOnSend
              controls={view ? <ChatSettings settings={view.settings} onChange={room.updateSettings} /> : null}
              placeholder={thinking ? "Add to the running turn…" : narrow ? "Ask about it, or change it…" : "Ask, plan work, or change a pipeline…"}
              statusText={thinking ? `Esc to stop · ${SENT_INTO_THE_TURN}` : (active?.name ?? "Attach, paste or drop files")}
              onSubmit={async (body, _mentions, attachmentIds) => {
                // Sending is wanting to see the answer: back to the end.
                jumpToLatest();
                await room.send(body, attachmentIds);
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** What a transcript row can ask of the conversation (EO-551): one stable object, read when pressed. */
interface RowHandlers {
  withdraw: (messageId: string) => void;
  fork: (messageId: string) => void;
  edit: (message: DiscussionMessage) => void;
  retry: () => void;
  answer: (answers: { questionId: string; answer: string | null }[]) => Promise<unknown>;
  refresh: () => void;
}

interface ChatRowProps {
  row: TranscriptRow;
  conversationId: string;
  /** Whether Retry sits under this row: the reply to the person's last message, and nothing since. */
  retry: boolean;
  /** A live question card's: an answer on its way, or the turn still running. */
  busy: boolean;
  handlers: RowHandlers;
}

/** An answered question card has nothing left to send. */
const answerNothing = async (): Promise<undefined> => undefined;

/** The same row: the same message, or the same questions in the same state. Rows are rebuilt on every read; their messages are not. */
function sameRow(before: TranscriptRow, after: TranscriptRow): boolean {
  if (before.kind === "message" && after.kind === "message") return before.message === after.message;
  if (before.kind === "questions" && after.kind === "questions") {
    const was = before.batch.questions;
    const now = after.batch.questions;
    return before.live === after.live && before.batch.id === after.batch.id && was.length === now.length && was.every((question, index) => question === now[index]);
  }
  return false;
}

/**
 * One finished row of the transcript — something said, a card, a batch of
 * questions — drawn again only when what it shows has changed (EO-551).
 * A turn streaming below it, a send in flight, the box being typed in:
 * none of them is a reason to draw a finished message, its actions, its
 * cards or its markdown again.
 */
function ChatRowView({ row, conversationId, retry, busy, handlers }: ChatRowProps) {
  if (row.kind === "questions") {
    return row.live ? (
      <QuestionCard questions={row.batch.questions} live busy={busy} onSubmit={handlers.answer} />
    ) : (
      <QuestionCard questions={row.batch.questions} live={false} busy={false} onSubmit={answerNothing} />
    );
  }
  const { message } = row;
  if (message.authorType === "human") {
    return (
      <Mine
        message={message}
        onWithdraw={() => handlers.withdraw(message.id)}
        actions={<MessageActions message={message} onFork={handlers.fork} onRetry={null} onEdit={message.attachments.length === 0 ? () => handlers.edit(message) : null} />}
      />
    );
  }
  const actions = <MessageActions message={message} onFork={handlers.fork} onRetry={retry ? handlers.retry : null} />;
  // A module card whether or not it is still the newest thing said: what it shows is the catalog (EO-398).
  // One a corrected module has since replaced says so and offers no Approve (EO-401).
  if (message.moduleSlug) return <ModuleCard slug={message.moduleSlug} replaced={message.moduleReplaced ?? null} />;
  // A change to a module that exists (EO-418). Its card whether or not Apply is still on it:
  // once applied it offers Approve, and a superseded one keeps its diff readable.
  if (message.moduleChange) {
    return (
      <Turn name="Assistant" message={message}>
        <ModuleChangeCard message={message} conversationId={conversationId} onDone={handlers.refresh} />
      </Turn>
    );
  }
  // Something only a person may do (EO-521): export, import or delete a pipeline, or discard
  // this machine's edits to one. Its card whether or not its button is still on it: once
  // pressed it shows what came of it.
  // The publish card after a draft's trials (EO-588): its own card, with the graph and the module rows.
  if (message.card?.kind === "trialPublish") {
    return (
      <Turn name="Assistant" message={message}>
        <TrialPublishCard message={message} conversationId={conversationId} onDone={handlers.refresh} />
      </Turn>
    );
  }
  if (message.card) {
    return (
      <Turn name="Assistant" message={message}>
        <OperationCard message={message} conversationId={conversationId} onDone={handlers.refresh} />
      </Turn>
    );
  }
  if (message.canApprove && message.approves === "pipeline") {
    return <DraftCard message={message} conversationId={conversationId} onDone={handlers.refresh} />;
  }
  // A work proposal keeps its card after it stops being approvable (EO-407): the rows stay, the button goes.
  if (message.canApprove || message.proposal) {
    return (
      <Turn name="Assistant" message={message}>
        <ProposalCard message={message} conversationId={conversationId} onDone={handlers.refresh} />
      </Turn>
    );
  }
  // A turn stopped before it answered keeps what it did on
  // screen, opened, above the line saying it was stopped.
  if (message.authorType === "engine" && message.turn && message.body.startsWith(TURN_STOPPED_NOTE)) {
    return (
      <div className="group flex flex-col gap-2 pl-[38px]">
        <TurnFold turn={message.turn} defaultOpen />
        {message.body.split("\n\n").map((line, index) => (
          <EventLine key={index}>{line}</EventLine>
        ))}
        {actions}
      </div>
    );
  }
  if (message.authorType === "engine" && isOneLine(message.body)) return <EventLine>{message.body}</EventLine>;
  return (
    <Turn name={message.authorName} message={message} actions={actions}>
      <Markdown>{message.body}</Markdown>
      {/* An answer EO asks the person for (EO-586): a guardrail stopping a draft's testing. */}
      {message.authorType === "engine" ? <OfferedAnswers message={message} conversationId={conversationId} onDone={handlers.refresh} /> : null}
      {message.attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" aria-label="Attachments">
          {message.attachments.map((attachment) => (
            <AttachmentCard key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}
    </Turn>
  );
}

const ChatRow = memo(
  ChatRowView,
  (before, after) =>
    sameRow(before.row, after.row) &&
    before.conversationId === after.conversationId &&
    before.retry === after.retry &&
    before.busy === after.busy &&
    before.handlers === after.handlers,
);

/**
 * The turn being written, and the one part of the conversation that
 * listens to its words (EO-551). `runs:delta` arrives about once a frame,
 * and the hook that hears it re-renders whatever calls it — so it is
 * called here, where all there is to draw is the live turn, rather than
 * at the top of the conversation, which would draw every row again with
 * each word. Mounted whether or not a turn is running, so this window
 * keeps the pushes for the conversation on show from the first one.
 */
function LiveReply({
  turn,
  conversationId,
  thinking,
  agentName,
  onGap,
}: {
  turn: LiveTurn | null | undefined;
  conversationId: string | undefined;
  thinking: boolean;
  agentName: string;
  onGap: () => void;
}) {
  const drafts = useLiveDrafts(turn, conversationId, onGap);
  if (!thinking || !turn) return null;
  return (
    <Turn name={agentName} live>
      <LiveTurnBody turn={turn} drafts={drafts} />
    </Turn>
  );
}

/**
 * The box's slash commands — what Claude Desktop's `/` offers that this
 * room has: a new chat, clearing this one, stopping the turn, forking from
 * the last thing said, and the model, effort and thinking for the next
 * turn. Anything else typed after a slash is sent as a message.
 */
function useChatCommands(
  room: ReturnType<typeof useAssistRoom>,
  lastSaidId: string | null,
  queryClient: ReturnType<typeof useQueryClient>,
): { completions: ComposerCompletion[]; run: (command: string, rest: string) => boolean | Promise<boolean> } {
  const settings = room.conversation?.settings;
  return useMemo(() => {
    const completions: ComposerCompletion[] = [
      { trigger: "/", value: "new", description: "Start a new chat beside this one" },
      { trigger: "/", value: "clear", description: "Put this chat away and start an empty one" },
      { trigger: "/", value: "stop", description: "Stop the turn that is running" },
      { trigger: "/", value: "fork", description: "Copy this chat up to here into a new one" },
      { trigger: "/", value: "model", description: "Choose the model: /model <name>, or /model default" },
      { trigger: "/", value: "effort", description: `Reasoning effort: ${(settings?.reasoningEfforts ?? []).join(", ") || "default"}` },
      { trigger: "/", value: "thinking", description: "Show or hide its reasoning: /thinking on, /thinking off" },
    ];
    /**
     * The model a person named, as the backend names it — matched against
     * the backend's own list (the picker's, from the same cache), by id or
     * by label. A name the list does not hold is refused here rather than
     * saved to fail the next turn. A backend whose list cannot be read is
     * taken at its word.
     */
    const modelNamed = async (named: string): Promise<string> => {
      if (!settings?.configurable) return named;
      const answer = await queryClient
        .fetchQuery({
          queryKey: ["providers", "capabilities", settings.provider],
          queryFn: () => ipcQuery("providers:capabilities", { provider: settings.provider, refreshModels: true }),
          staleTime: 60_000,
        })
        .catch(() => null);
      const models = answer?.models ?? [];
      if (models.length === 0) return named;
      const wanted = named.toLowerCase();
      const found = models.find((model) => model.value.toLowerCase() === wanted || model.label.toLowerCase() === wanted);
      // A list can name models by alias and leave out the full ids it
      // accepts; a name shaped like an id — one word, with a version in
      // it — is passed on as the person wrote it.
      if (!found && /^[a-z][\w.[\]-]*\d[\w.[\]-]*$/i.test(named)) return named;
      if (!found) throw new Error(`There is no model called “${named}”. This backend offers: ${models.map((model) => model.value).join(", ")}.`);
      return found.value;
    };
    const run = (command: string, rest: string): boolean | Promise<boolean> => {
      // A command that takes nothing, followed by words, was not that
      // command: "/clear up the naming first" is a message, and running
      // it would put the chat away and lose what was typed.
      if (rest !== "" && (command === "new" || command === "clear" || command === "stop" || command === "fork")) return false;
      switch (command) {
        case "new":
          room.startNew();
          return true;
        case "clear":
          room.clear();
          return true;
        case "stop":
          room.stop();
          return true;
        case "fork":
          if (!lastSaidId) throw new Error("There is nothing to fork yet: fork once the assistant has said something.");
          room.fork(lastSaidId);
          return true;
        case "model":
          if (rest === "" || rest === "default") {
            room.updateSettings({ model: null });
            return true;
          }
          return modelNamed(rest).then((model) => {
            room.updateSettings({ model });
            return true;
          });
        case "effort": {
          const offered = settings?.reasoningEfforts ?? [];
          if (rest === "default") {
            room.updateSettings({ reasoningEffort: null });
            return true;
          }
          if (!offered.includes(rest)) throw new Error(offered.length > 0 ? `Effort is one of ${offered.join(", ")}, or default.` : "This assistant's backend has no effort to choose.");
          room.updateSettings({ reasoningEffort: rest });
          return true;
        }
        case "thinking":
          if (rest !== "on" && rest !== "off") throw new Error("Say /thinking on or /thinking off.");
          room.updateSettings({ showReasoning: rest === "on" });
          return true;
        default:
          return false;
      }
    };
    return { completions, run };
    // The room's functions, not the room: it is a new object every render.
  }, [room.startNew, room.clear, room.stop, room.fork, room.updateSettings, lastSaidId, settings, queryClient]);
}

/** A message with no line break, short enough to be an event rather than a turn. */
function isOneLine(body: string): boolean {
  return body.length <= 120 && !body.includes("\n");
}

function EmptyRoom() {
  const vocabulary = useChromeVocabulary();
  return (
    <div className="flex flex-col gap-2 pb-6">
      <h2 className="text-xl font-semibold tracking-[-0.01em] text-ink">What should happen next?</h2>
      <p className="text-[15px] leading-relaxed text-ink-muted">
        Plan work or ask about anything in this project. Open a board, {withArticle(vocabulary.item.toLowerCase())} or a run from the left and it opens beside this conversation,
        where the assistant can see it — so &ldquo;send this back&rdquo;, or &ldquo;add an approval step after Draft&rdquo; on a board,
        needs nothing named.
      </p>
    </div>
  );
}

/** What you said: on the right, in a bubble, with its actions under it. */
function Mine({ message, actions, onWithdraw }: { message: DiscussionMessage; actions?: ReactNode; onWithdraw?: () => void }) {
  return (
    <div className="group flex max-w-[80%] flex-col items-end gap-1 self-end">
      <div className="rounded-[16px_16px_4px_16px] bg-canvas-raised px-3.5 py-2.5 text-[14.5px] leading-[1.55] text-ink">
        <Markdown>{message.body}</Markdown>
        {message.attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2" aria-label="Attachments">
            {message.attachments.map((attachment) => (
              <AttachmentCard key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}
      </div>
      {message.status === "queued" ? (
        <span className="flex items-center gap-2 text-[11.5px] text-ink-subtle">
          Waiting for the next turn
          {onWithdraw ? (
            <button type="button" aria-label="Take back this message" onClick={onWithdraw} className="rounded-[6px] px-1 text-ink-muted underline-offset-2 hover:text-ink hover:underline">
              Cancel
            </button>
          ) : null}
        </span>
      ) : null}
      {actions}
    </div>
  );
}

/**
 * A message on its way (EO-549): the person's bubble, faded, with a line
 * under it saying it is sending — never drawn as though it had landed.
 * It has no actions: there is nothing stored yet to fork, edit or take
 * back. The stored message replaces it as soon as either reply has it.
 */
function Sending({ pending }: { pending: PendingSend }) {
  const files = pending.attachmentCount;
  return (
    <div aria-label="Message sending" aria-busy className="flex max-w-[80%] flex-col items-end gap-1 self-end">
      <div className="rounded-[16px_16px_4px_16px] bg-canvas-raised px-3.5 py-2.5 text-[14.5px] leading-[1.55] text-ink opacity-60">
        {pending.body.trim() !== "" ? <Markdown>{pending.body.trim()}</Markdown> : null}
        {files > 0 ? <p className="text-[12.5px] text-ink-muted">{files === 1 ? "1 file" : `${files} files`}</p> : null}
      </div>
      <span role="status" className="flex items-center gap-1.5 text-[11.5px] text-ink-subtle">
        <LoaderCircle aria-hidden size={11} className="animate-spin" />
        Sending…
      </span>
    </div>
  );
}

/** The assistant's mark: the one place the room's own colour appears, as a sign rather than a button. */
function Mark() {
  return (
    <span aria-hidden className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-accent-subtle text-accent-soft">
      <Sparkles size={14} />
    </span>
  );
}

/**
 * What the assistant said: full width, beside its mark, with the work its
 * turn did folded above it and its actions under it.
 */
function Turn({ name, live = false, message, actions, children }: { name: string; live?: boolean; message?: DiscussionMessage; actions?: ReactNode; children: ReactNode }) {
  return (
    <article aria-label={live ? "Live agent response" : undefined} className="group grid grid-cols-[26px_minmax(0,1fr)] gap-3">
      <Mark />
      <div className="flex min-w-0 flex-col gap-2 text-[14.5px] leading-[1.6] text-ink">
        <span className="sr-only">{name}: </span>
        {message?.turn ? <TurnFold turn={message.turn} /> : null}
        <div className="min-w-0">{children}</div>
        {actions}
      </div>
    </article>
  );
}

/**
 * Copy, fork from here and — under the last reply — retry: Claude
 * Desktop's row under a message. Faint until the message is hovered or
 * one of them has focus, and reachable by Tab either way (ARCHITECTURE.md,
 * "Interaction": no hover-only controls).
 */
function MessageActions({
  message,
  onFork,
  onRetry,
  onEdit = null,
}: {
  message: DiscussionMessage;
  onFork: (messageId: string) => void;
  onRetry: (() => void) | null;
  onEdit?: (() => void) | null;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dur-short)] focus-within:opacity-100 group-hover:opacity-100">
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
      <IconButton
        label={copied ? "Copied" : "Copy"}
        icon={copied ? <Check size={13} /> : <Copy size={13} />}
        className="h-6 w-6 rounded-[7px]"
        onClick={() => {
          // A refused copy (no permission, no focus) changes nothing on screen.
          void navigator.clipboard?.writeText(message.body).then(() => setCopied(true), () => undefined);
        }}
      />
      <IconButton label="Fork from here" title="Start a new chat with this conversation up to here" icon={<GitBranch size={13} />} className="h-6 w-6 rounded-[7px]" onClick={() => onFork(message.id)} />
      {onEdit ? <IconButton label="Edit" title="Change this message and send it again, in a new chat from here" icon={<Pencil size={13} />} className="h-6 w-6 rounded-[7px]" onClick={onEdit} /> : null}
      {onRetry ? <IconButton label="Retry" title="Send your last message again" icon={<RotateCcw size={13} />} className="h-6 w-6 rounded-[7px]" onClick={onRetry} /> : null}
    </div>
  );
}

/** Something that happened rather than something said: a line between two rules. */
function EventLine({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-xs text-ink-subtle before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      <span className="max-w-[80%] text-center">{children}</span>
    </div>
  );
}

interface CardProps {
  message: DiscussionMessage;
  conversationId: string;
  onDone: () => void;
}

/**
 * The other pipelines a draft's routes may hand work to, so the picture
 * can tell a hand-off from a broken target.
 *
 * `assist:draft` does not answer them, and `pipelineSteps:list` does —
 * for the pipeline the draft changes, as that pipeline's `elsewhere`. A
 * draft that creates a pipeline has no id to ask with (EO-381), so it
 * asks as any pipeline the project already has: that one's own steps and
 * its `elsewhere` are together every pipeline there is to hand off to.
 */
function useHandOffTargets(pipelineId: string | null, pipelines: readonly PipelineView[]): HandOffTargets[] {
  const askAs = pipelineId ?? pipelines[0]?.id ?? null;
  const loaded = useQuery({
    queryKey: pipelineStepsKey(askAs ?? ""),
    queryFn: () => ipcQuery("pipelineSteps:list", { pipelineId: askAs! }),
    enabled: askAs !== null,
  });
  return useMemo(() => {
    const elsewhere = loaded.data?.elsewhere ?? [];
    if (pipelineId !== null || askAs === null || !loaded.data) return elsewhere;
    const asked = { pipelineId: askAs, pipelineName: pipelines.find((pipeline) => pipeline.id === askAs)?.name ?? "Pipeline", steps: loaded.data.steps };
    return [asked, ...elsewhere];
  }, [loaded.data, pipelineId, askAs, pipelines]);
}

/**
 * A pipeline the assistant drafted, drawn as what it is: its steps as
 * boxes, who owns each, and an arrow for where each result goes.
 *
 * The graph is read back with `assist:draft`, the same call Publish makes
 * first, so the card shows exactly what pressing the button would save.
 *
 * A draft that runs modules nobody has approved lists each as a row —
 * what it does, what it needs, how its tests went, its code behind an
 * expand — and offers one button for all of it: Approve and publish
 * (EO-581). That runs every module's tests, and approves them all and
 * publishes the pipeline in one transaction, or does none of it and
 * says which module and case refused. Coverage under the bar is asked
 * about here, on the card, before anything is approved. A module
 * proposed with no draft keeps its own card and its own Approve.
 *
 * Which modules those are is the main process's answer, asked again
 * whenever the catalog changes — so one approved in Settings → Modules
 * meanwhile reads Approved here, and a draft with none left publishes
 * through Publish as before. Nothing is pressed for anybody.
 *
 * A draft whose turn planned a test with real runs is a **design card**
 * (EO-587): the same graph, every module it runs as a row, then the test
 * items with where each must end and every step's mode — and Approve
 * design, with no Publish. Approving makes the trial, grants the modules
 * trial-only permission, files the test items and starts the first
 * round; nothing is published, and the card says the design is under
 * test from then on.
 */
function DraftCard({ message, conversationId, onDone }: CardProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { active } = useProjects();
  const { pipelines } = usePipelines(active?.id ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [published, setPublished] = useState(false);

  const draft = useQuery({
    queryKey: assistDraftKey(message.id),
    queryFn: () => ipcQuery("assist:draft", { conversationId, messageId: message.id }),
    enabled: !published,
  });
  const [createdId, setCreatedId] = useState<string | null>(null);
  // A draft that creates a pipeline has no id until Publish makes one (EO-381).
  const newPipelineName = draft.data?.newPipelineName ?? null;
  const pipelineId = draft.data?.pipelineId ?? createdId;
  const pipelineName = newPipelineName ?? pipelines.find((pipeline) => pipeline.id === pipelineId)?.name ?? "Pipeline";
  // A draft that restores a version (EO-520) says so where the card is named.
  const restoredFrom = draft.data?.restoredFrom;

  const onPublished = (result: PublishedDraft) => {
    setProblem(result.problem);
    setPublished(result.saved);
    // Refused: read the card again, since what it was refused for may be a module it now waits on.
    if (!result.saved) void queryClient.invalidateQueries({ queryKey: assistDraftKey(message.id) });
    if (result.created) setCreatedId(result.pipelineId);
    if (result.saved && result.pipelineId) {
      void queryClient.invalidateQueries({ queryKey: pipelineStepsKey(result.pipelineId) });
      void queryClient.invalidateQueries({ queryKey: itemsKey });
    }
    // A pipeline the draft created (EO-381) is one every list of them is
    // missing, and one it renamed (EO-520) is listed under its old name.
    if (result.created || result.renamed) void queryClient.invalidateQueries({ queryKey: ["pipelines"] });
    onDone();
  };
  const onFailed = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error));

  const publish = useMutation({
    mutationFn: () => publishAssistDraft(conversationId, message.id),
    onSuccess: onPublished,
    onError: onFailed,
  });

  // Approve and publish (EO-581). What each module's tests said, by slug,
  // for its row; and the coverage figures waiting on the person, if any.
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<ApprovedAndPublishedDraft["coverage"] | null>(null);
  const approveAndPublish = useMutation({
    mutationFn: (acknowledged: readonly string[]) => approveAndPublishAssistDraft(conversationId, message.id, acknowledged),
    onSuccess: (result) => {
      const refused = result.modules.flatMap((module) => (module.outcome === "refused" && module.problem !== null ? [{ ...module, problem: module.problem }] : []));
      setRefusals(Object.fromEntries(refused.map((module) => [module.slug, module.problem])));
      // The modules read as approved, or still not, wherever they are listed.
      void queryClient.invalidateQueries({ queryKey: modulesKey });
      if (result.coverage.length > 0) {
        // A question, not a refusal: nothing was written, and the card asks.
        setAsking(result.coverage);
        setProblem(null);
        return;
      }
      setAsking(null);
      // Which case refused is said under its module; the card says what that meant for the rest.
      const named = refused.map((module) => `"${module.name}"`).join(", ");
      const one = refused.length === 1;
      onPublished(
        refused.length === 0
          ? result
          : { ...result, problem: `Nothing was approved and nothing was published: ${named} ${one ? "was" : "were"} not approved. What refused ${one ? "it is shown under the module" : "each is shown under it"}.` },
      );
    },
    onError: onFailed,
  });

  const steps = useMemo(() => [...(draft.data?.steps ?? [])].sort((a, b) => a.position - b.position), [draft.data]);
  const routes = useMemo(() => draft.data?.routes ?? [], [draft.data]);
  const machineSpecific = useMemo(() => pipelineMachineSpecificWarnings(steps), [steps]);
  const elsewhere = useHandOffTargets(pipelineId, pipelines);
  // The steps this draft adds (EO-680): the ones the pipeline as published
  // has not got. Asked only of a pipeline that exists — on a new one every
  // step would be new — and nothing is marked until the answer is in.
  const changing = draft.data?.pipelineId ?? null;
  const asPublished = useQuery({
    queryKey: pipelineStepsKey(changing ?? ""),
    queryFn: () => ipcQuery("pipelineSteps:list", { pipelineId: changing as string }),
    enabled: changing !== null,
  });
  const newStepIds = useMemo(() => {
    const live = asPublished.data?.steps;
    if (changing === null || live === undefined) return undefined;
    const known = new Set(live.map((step) => step.id));
    return new Set(steps.filter((step) => !known.has(step.id)).map((step) => step.id));
  }, [changing, asPublished.data, steps]);

  // Asked again when an approval or a deletion lands, wherever it was made.
  const catalog = useModulesWithDeleted();
  const catalogState = catalog.data ? (catalog.data.modules ?? []).map((module) => `${module.id}:${module.approvedAt}:${module.archivedAt}`).join("|") : null;
  const seenCatalog = useRef(catalogState);
  const { refetch } = draft;
  useEffect(() => {
    const before = seenCatalog.current;
    seenCatalog.current = catalogState;
    // The first answer is not a change: the draft was read beside it.
    if (before !== null && catalogState !== null && before !== catalogState && !published) void refetch();
  }, [catalogState, published, refetch]);

  // What Publish is waiting on now, and every module it has waited on
  // while this card was open — one approved a moment ago stays on the
  // card reading "Approved" rather than vanishing under the pointer.
  const waiting = useMemo(() => draft.data?.waiting ?? [], [draft.data]);
  const [listed, setListed] = useState<AssistWaitingModule[]>([]);
  useEffect(() => {
    setListed((before) => {
      const added = waiting.filter((module) => !before.some((known) => known.slug === module.slug));
      return added.length > 0 ? [...before, ...added] : before;
    });
  }, [waiting]);
  // A design card (EO-587): Approve design, and no Publish.
  const trial = draft.data?.trial ?? null;
  const approveDesign = useMutation({
    mutationFn: () => approveAssistDesign(conversationId, message.id),
    onSuccess: (result) => {
      setProblem(result.problem);
      void queryClient.invalidateQueries({ queryKey: assistDraftKey(message.id) });
      if (result.approved) void queryClient.invalidateQueries({ queryKey: modulesKey });
      onDone();
    },
    onError: onFailed,
  });

  const unapproved = waiting.filter((module) => module.state === "unapproved").length;
  const gone = waiting.some((module) => module.state === "gone");
  const busy = publish.isPending || approveAndPublish.isPending || approveDesign.isPending;
  const label = approveAndPublish.isPending
    ? "Running the tests…"
    : publish.isPending
      ? "Publishing…"
      : published
        ? "Published"
        : gone
          ? "A module was deleted — can’t publish"
          : unapproved > 0
            ? "Approve and publish"
            : "Publish pipeline";
  const press = () => {
    setProblem(null);
    if (unapproved > 0) approveAndPublish.mutate([]);
    else publish.mutate();
  };
  const designApproved = trial?.approved ?? null;
  const designLabel = approveDesign.isPending ? "Starting the trial…" : designApproved !== null ? "Design approved" : "Approve design";
  // The rows a person is granting: every module a design runs, or the ones a publish waits on.
  const moduleRows = trial !== null ? trial.modules.map((module) => module.slug) : listed.map((module) => module.slug);

  return (
    <Turn name="Assistant" message={message}>
      <div className="flex flex-col gap-2.5">
        <Markdown>{message.body}</Markdown>
        <section aria-label="Pipeline draft" className="flex flex-col gap-2.5 rounded-[14px] bg-canvas-subtle px-4 py-3.5">
          <div className="flex items-center gap-2 text-[12.5px] text-ink-muted">
            <GitFork size={14} className="shrink-0" />
            <b className="text-[13px] font-semibold text-ink">{pipelineName}</b>
            <span>· {steps.length} steps</span>
            <span className="ml-auto text-[11.5px] text-ink-subtle">
              {trial !== null
                ? designApproved !== null
                  ? "design approved · under test"
                  : "design"
                : published
                  ? "published"
                  : newPipelineName !== null
                    ? "new pipeline"
                    : restoredFrom != null
                      ? `restores v${restoredFrom}`
                      : "draft"}
            </span>
          </div>
          {/* The picture the pipeline's Graph view draws (EO-400); in a column too narrow for it, it scrolls here. */}
          <PipelineDrawing
            steps={steps}
            routes={routes}
            elsewhere={elsewhere}
            entryStepId={draft.data?.entryStepId ?? null}
            {...(newStepIds === undefined ? {} : { newStepIds })}
          />
          {draft.data?.problem ? <p className="text-xs text-danger">{draft.data.problem}</p> : null}
          {/* What the steps hold that only exists on this machine (EO-450), each by step and field. Advice: Publish is never held for it. */}
          <MachineSpecificValues warnings={machineSpecific} subject="the pipeline" />
          {moduleRows.length > 0 ? (
            <ul aria-label="Modules this draft needs" className="flex flex-col gap-2">
              {moduleRows.map((slug) => (
                <li key={slug} className="rounded-[10px] bg-canvas px-3 py-2.5">
                  <DraftModuleRow slug={slug} refusal={refusals[slug] ?? null} />
                </li>
              ))}
            </ul>
          ) : null}
          {trial !== null ? <DesignPlan trial={trial} steps={steps} /> : null}
          {trial?.problem ? <p className="text-xs text-danger">{trial.problem}</p> : null}
          {asking !== null ? (
            <ConfirmCoverage
              modules={asking}
              busy={approveAndPublish.isPending}
              onConfirm={() => approveAndPublish.mutate(asking.map((module) => module.id))}
              onCancel={() => {
                setAsking(null);
                setProblem(
                  `Nothing was approved or published. Line coverage of ${asking.map((module) => `"${module.name}" is ${module.lineCoverage}%`).join(", ")}, under the ${MODULE_COVERAGE_BAR}% bar.`,
                );
              }}
            />
          ) : null}
          <div className="flex items-center gap-2">
            {trial !== null ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setProblem(null);
                  approveDesign.mutate();
                }}
                disabled={busy || designApproved !== null || trial.problem !== null || draft.data?.problem != null}
              >
                {designLabel}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={press} disabled={busy || published || gone || asking !== null || (pipelineId === null && newPipelineName === null)}>
                {label}
              </Button>
            )}
            {pipelineId ? (
              <Button size="sm" onClick={() => void navigate(`/pipelines/${pipelineId}?view=graph`)}>
                Open the pipeline
              </Button>
            ) : null}
            <span className="ml-auto text-[11px] text-ink-subtle">
              {trial !== null
                ? designApproved !== null
                  ? designApproved.round === null
                    ? "Testing with real runs"
                    : `Testing with real runs — round ${designApproved.round}`
                  : "Grants these modules trial-only permission. Nothing is published."
                : published
                  ? "Running items keep their current step"
                  : unapproved > 0
                    ? "Approving runs every module’s tests"
                    : "or say what should change"}
            </span>
          </div>
          {/* One line per failing module and case, so kept as written. */}
          {problem ? <p className="whitespace-pre-line text-xs text-danger">{problem}</p> : null}
        </section>
      </div>
    </Turn>
  );
}

/**
 * Every case passed and the code they reach is under the bar (EO-581):
 * asked on the draft card itself, before anything is approved, with each
 * figure stated — "approve anyway" means something only next to the
 * number it is anyway of. Confirming runs the tests again, approves and
 * publishes; cancelling writes nothing.
 */
function ConfirmCoverage({
  modules,
  busy,
  onConfirm,
  onCancel,
}: {
  modules: ApprovedAndPublishedDraft["coverage"];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section aria-label="Coverage to confirm" className="flex flex-col gap-2 rounded-[10px] bg-paused/10 px-3 py-2.5 text-[12.5px] text-ink">
      {modules.map((module) => (
        <p key={module.id}>
          Every test case of <b className="font-semibold">{module.name}</b> passed, but they cover{" "}
          <strong className="font-semibold text-paused">{module.lineCoverage}%</strong> of its lines — under the {MODULE_COVERAGE_BAR}% bar. The lines no case reaches are lines
          nobody has seen run.
        </p>
      ))}
      <p className="text-ink-muted">Nothing has been approved or published yet.</p>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={onConfirm}>
          {busy ? "Running the tests…" : "Approve anyway and publish"}
        </Button>
        <Button size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

/**
 * A module the assistant proposed on its own (EO-398): one card per
 * module, with View code and Approve on it. Drawn from the catalog by
 * `ModuleProposal`. A module a draft needs is not one of these: it is a
 * row on the draft card, approved with the draft (EO-581).
 */
function ModuleCard({ slug, replaced }: { slug: string; replaced: "below" | "elsewhere" | null }) {
  return (
    <Turn name="Assistant">
      <section aria-label="Module proposal" className="rounded-[14px] bg-canvas-subtle px-4 py-3.5">
        <ModuleProposal slug={slug} replaced={replaced} />
      </section>
    </Turn>
  );
}
