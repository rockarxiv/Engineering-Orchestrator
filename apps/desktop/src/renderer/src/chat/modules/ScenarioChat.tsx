import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Plus, Sparkles, X } from "lucide-react";
import type { DiscussionMessage, ModuleView } from "@eo/core";
import { Markdown, cn } from "@eo/ui";
import { drawScenarioReply, useScenarioRoom } from "../../shared/modules/useScenarioRoom";
import { guardedTurn, type CaseWriteGuard } from "../../shared/modules/caseApproval";
import { useWithdrawnApproval } from "../../shared/modules/useWithdrawnApproval";
import { useLiveDrafts } from "../../shared/assist/liveDeltas";
import { LiveTurnBody, TurnFold } from "../conversation/TurnView";
import { ipcQuery } from "../../query/client";
import { modulesKey } from "../../query/hooks";
import { AttachmentCard } from "../conversation/AttachmentCard";
import { Composer } from "../conversation/Composer";
import { QuestionCard, transcriptRows } from "../conversation/QuestionCard";
import { WorkingLine } from "../conversation/WorkingLine";
import { Button, Chip, IconButton } from "../kit";
import { useModuleApproval } from "./useModuleApproval";

/**
 * "+ Add scenario" on a module's page, and the chat it opens (EO-356), in
 * the chat layout's terms.
 *
 * A conversation with the system agent about this module, drawn the way
 * the layout's own conversation is drawn — what you said on the right in a
 * bubble, what the agent said full width beside its mark, question cards
 * where they were asked — because it is the same kind of room:
 * `ipc/conversationView.ts` decides what is live and this only renders it.
 *
 * The one card is a **proposed change to the module**, with Apply: nothing
 * is written until it is pressed, and pressing it is a module save that
 * withdraws approval exactly as an edit in Settings does.
 *
 * And when a case the agent wrote withdrew the module's approval, EO's
 * record of it under the reply carries Approve (EO-501).
 */

function Attachments({ message }: { message: DiscussionMessage }) {
  if (message.attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" aria-label="Attachments">
      {message.attachments.map((attachment) => (
        <AttachmentCard key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

/** What you said: on the right, in a bubble. */
function Mine({ message }: { message: DiscussionMessage }) {
  return (
    <div className="max-w-[85%] self-end rounded-[14px_14px_4px_14px] bg-canvas-raised px-3 py-2 text-[13px] leading-[1.55] text-ink">
      <Markdown>{message.body}</Markdown>
      <Attachments message={message} />
    </div>
  );
}

/** What the agent said: full width, beside its mark. */
function Turn({ name, live = false, danger = false, children }: { name: string; live?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <article
      aria-label={live ? "Live agent response" : undefined}
      className={cn("grid grid-cols-[22px_minmax(0,1fr)] gap-2.5", danger && "rounded-[10px] shadow-[inset_0_0_0_1px_var(--color-danger)] p-2")}
    >
      <span aria-hidden className="grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-canvas-active text-ink-muted">
        <Sparkles size={12} />
      </span>
      <div className={cn("min-w-0 text-[13px] leading-[1.6]", live ? "text-ink-subtle" : "text-ink")}>
        <span className="sr-only">{name}: </span>
        {children}
      </div>
    </article>
  );
}

/**
 * A change to the module, with the button that applies it. Once applied,
 * the comment filed under it makes it an ordinary message again — the
 * diff stays readable, and the button is gone because nothing is left to
 * decide.
 */
function ChangeCard({ message, moduleId, conversationId, onDone }: { message: DiscussionMessage; moduleId: string; conversationId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const apply = useMutation({
    mutationFn: () => ipcQuery("scenario:apply", { conversationId, messageId: message.id }),
    onSuccess: (result) => {
      setProblem(result.problem);
      // The card as applying left it, before `onDone` re-reads the thread (EO-548).
      drawScenarioReply(queryClient, moduleId, result.conversation);
      if (result.applied) void queryClient.invalidateQueries({ queryKey: modulesKey });
      onDone();
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  return (
    <Turn name={message.authorName}>
      <section aria-label="Proposed change" className="flex flex-col gap-2.5 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
        <Markdown className="text-[13px] leading-relaxed">{message.body}</Markdown>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={apply.isPending} onClick={() => apply.mutate()}>
            {apply.isPending ? "Applying…" : "Apply change"}
          </Button>
          <span className="text-[11.5px] text-ink-subtle">or say what should change</span>
        </div>
        {problem ? <p className="text-[12px] text-danger">{problem}</p> : null}
      </section>
    </Turn>
  );
}

/**
 * EO's record that a case this turn wrote withdrew the module's approval
 * (EO-501), with the Approve that gives it back.
 *
 * The record's words are EO's, written when the turn ended; what it
 * offers is the catalog's now (`useWithdrawnApproval`), so once the
 * module is approved — here, in Settings, anywhere — it says so instead.
 * Approve is `useModuleApproval`, the same `modules:approve` every screen
 * calls: it runs the tests and names each failing case when it refuses.
 */
function WithdrawnApproval({ message }: { message: DiscussionMessage }) {
  const { offer, module, refreshCatalog } = useWithdrawnApproval(message);
  const approval = useModuleApproval({ onApproved: refreshCatalog });

  return (
    <Turn name={message.authorName}>
      <section aria-label="Approval withdrawn" className="flex flex-col gap-2.5 rounded-[12px] bg-canvas-subtle px-3.5 py-3">
        <Markdown className="text-[13px] leading-relaxed">{message.body}</Markdown>
        {offer === "approve" && module ? (
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="paused">Not approved</Chip>
            <Button variant="primary" size="sm" disabled={approval.approving} onClick={() => approval.approve(module)}>
              {approval.approving ? "Running its tests…" : "Approve"}
            </Button>
            <span className="text-[11px] text-ink-subtle">Approving runs its tests</span>
          </div>
        ) : null}
        {offer === "approved" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="success">Approved</Chip>
            <span className="text-[11.5px] text-ink-subtle">{module?.name ?? "The module"} has been approved since.</span>
          </div>
        ) : null}
        {offer === "deleted" ? <p className="text-[12px] text-ink-muted">The module has been deleted since, so there is nothing here to approve.</p> : null}
        {/* One line per failing case, so kept as written. */}
        {approval.problem && offer === "approve" ? (
          <p role="alert" className="whitespace-pre-line text-[12.5px] text-danger">
            {approval.problem}
          </p>
        ) : null}
        {approval.dialog}
      </section>
    </Turn>
  );
}

export interface ScenarioPanelProps {
  module: Pick<ModuleView, "id" | "name">;
  onClose: () => void;
  /**
   * Asked before each turn this chat starts — a message, or answers to
   * its questions — since the agent saves the cases it writes with no
   * further question (EO-500). A kept approval leaves what was typed
   * where it was.
   */
  guardCaseWrites?: CaseWriteGuard | undefined;
}

/** The chat itself: header, transcript, composer. */
export function ScenarioPanel({ module, onClose, guardCaseWrites }: ScenarioPanelProps) {
  const room = useScenarioRoom(module.id, true);
  const queryClient = useQueryClient();
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const view = room.conversation;
  const messages = useMemo(() => view?.messages ?? [], [view]);
  const { refresh } = room;
  // The words of the running turn as they are written, drawn as the assistant's chat draws them.
  const drafts = useLiveDrafts(view?.liveTurn, view?.id, useCallback(() => refresh(), [refresh]));
  const rows = useMemo(() => transcriptRows(messages), [messages]);
  const thinking = view?.thinking ?? false;

  const answer = useMutation({
    mutationFn: async (answers: { questionId: string; answer: string | null }[]) => {
      if (view === null) throw new Error("The conversation is not open yet.");
      const result = await ipcQuery("scenario:answer", { conversationId: view.id, answers });
      // Closed on the conversation the answer came back with, not on a
      // refetch (EO-548) — a refused answer's too, since the thread it
      // carries is the one that closed or replaced the card.
      drawScenarioReply(queryClient, module.id, result.conversation);
      // Thrown so the card shows it.
      if (result.problem) throw new Error(result.problem);
      return result;
    },
    onSettled: () => room.refresh(),
  });

  useEffect(() => {
    const scroller = transcript.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages.length, view?.liveOutput]);

  useEffect(() => {
    if (room.available && !room.sending) composer.current?.focus();
  }, [room.available, room.sending]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-line px-3.5">
        <FlaskConical aria-hidden size={14} className="shrink-0 text-ink-subtle" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">Scenarios · {module.name}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => room.clear()}
          disabled={messages.length === 0 || room.clearing}
          title="Archives this conversation and starts an empty one"
        >
          Clear
        </Button>
        <IconButton label="Close the scenario chat" icon={<X size={14} />} onClick={onClose} />
      </header>

      <div ref={transcript} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto relative px-3.5 py-3.5 *:shrink-0" aria-label="Scenario transcript">
        {!room.available && !room.loading ? (
          <p className="text-[13px] leading-relaxed text-ink-muted">
            There is no enabled system agent, so there is nobody here to write a scenario. Enable one on the Agents screen and try again.
          </p>
        ) : null}

        {room.available && messages.length === 0 && !room.loading ? (
          <p className="text-[13px] leading-relaxed text-ink-subtle">
            Describe a scenario for {module.name} in your own words — what the step is given, what the commands it runs answer, and what it
            should do. The system agent writes it as a test case, runs it and tells you how it went. It never changes the module unless you
            ask it to and apply the change.
          </p>
        ) : null}

        {/* Each batch of questions where it was asked (EO-362), not after the thread. */}
        {rows.map((row) => {
          if (row.kind === "questions") {
            return row.live ? (
              <QuestionCard
                key={row.batch.id}
                questions={row.batch.questions}
                live
                busy={answer.isPending || thinking}
                onSubmit={(answers) => guardedTurn(guardCaseWrites, module.name, () => answer.mutateAsync(answers))}
              />
            ) : (
              <QuestionCard key={row.batch.id} questions={row.batch.questions} live={false} busy={false} onSubmit={async () => undefined} />
            );
          }
          const { message } = row;
          if (message.canApprove && view !== null) {
            return <ChangeCard key={message.id} message={message} moduleId={module.id} conversationId={view.id} onDone={room.refresh} />;
          }
          if (message.approvalWithdrawn) return <WithdrawnApproval key={message.id} message={message} />;
          if (message.authorType === "human") return <Mine key={message.id} message={message} />;
          return (
            <Turn key={message.id} name={message.authorName} danger={message.kind === "rejection"}>
              {message.turn ? <TurnFold turn={message.turn} /> : null}
              <Markdown>{message.body}</Markdown>
              <Attachments message={message} />
            </Turn>
          );
        })}

        {thinking && view?.liveTurn ? (
          <Turn name={view.settings.agentName} live>
            <LiveTurnBody turn={view.liveTurn} drafts={drafts} />
          </Turn>
        ) : thinking && view?.liveOutput ? (
          <Turn name={view.settings.agentName} live>
            <Markdown>{view.liveOutput}</Markdown>
          </Turn>
        ) : null}
      </div>

      {thinking ? <WorkingLine since={view?.thinkingSince ?? null} /> : null}
      {room.problem ? <p className="shrink-0 border-t border-line px-3.5 py-2 text-[12px] text-danger">{room.problem}</p> : null}

      {room.available ? (
        <div className="shrink-0 border-t border-line p-2.5">
          <Composer
            appearance="chat"
            mentionables={[]}
            textareaRef={composer}
            ariaLabel="Describe a scenario"
            busy={room.sending}
            placeholder="Describe a scenario…"
            statusText="Attach, paste or drop files"
            onSubmit={(body, _mentions, attachmentIds) => guardedTurn(guardCaseWrites, module.name, () => room.send(body, attachmentIds))}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The button on a module's page, and the floating panel behind it.
 *
 * Mounted only while open, so the conversation is neither opened nor
 * created until somebody presses the button; closing ends nothing, and
 * reopening resumes the same thread. Escape closes it and focus goes back
 * to the button. Not modal: the module's Tests panel behind it is where
 * the new case appears.
 */
export function AddScenario({
  module,
  guardCaseWrites,
}: {
  module: Pick<ModuleView, "id" | "name">;
  /**
   * Asked before the chat opens and before each turn it starts, so the
   * Tests panel can put its question in front of a room that writes
   * cases directly (EO-500). Not calling `proceed` keeps the chat closed,
   * or the message unsent.
   */
  guardCaseWrites?: CaseWriteGuard | undefined;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const node = panel.current;
    if (!node) return;
    if (!node.contains(document.activeElement)) node.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  return (
    <>
      <Button ref={trigger} size="sm" icon={<Plus size={12} />} aria-expanded={open} onClick={() => (open ? close() : guardCaseWrites ? guardCaseWrites({ what: "open", proceed: () => setOpen(true), cancel: () => {} }) : setOpen(true))}>
        Add scenario
      </Button>
      {open
        ? createPortal(
            <div
              ref={panel}
              role="dialog"
              aria-label={`Scenarios for ${module.name}`}
              aria-modal={false}
              tabIndex={-1}
              className="fixed bottom-4 right-4 z-[var(--z-raised)] flex h-[min(640px,calc(100vh-2rem))] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[16px] bg-canvas shadow-panel"
            >
              <ScenarioPanel module={module} onClose={close} guardCaseWrites={guardCaseWrites} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
