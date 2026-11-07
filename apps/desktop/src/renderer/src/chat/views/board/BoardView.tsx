import { useCallback, useEffect, useMemo, useState } from "react";
import { DndContext, DragOverlay, MeasuringStrategy, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import {
  JOB_ID_FACET,
  STEP_ID_FACET,
  ghostColumnLabel,
  matchesBoardQuery,
  namesAnOwner,
  pipelineChangesPath,
  pipelineUpdatedBanner,
  saysWhatIsChecked,
  verificationLine,
  type ItemSummary,
} from "@eo/core";
import { HAND_OFF_DROPPABLE_ID, PAUSED_RAIL_DROPPABLE_ID, boardViewFilter, resolveDropTarget, hasRunInFlight, newestFirst, ownerIdOf } from "../../../shared/pipeline/dashboard";
import {
  useChromeVocabulary,
  useClaimItem,
  useHoldItem,
  useModules,
  useMoveItem,
  usePeople,
  usePipelineData,
  usePipelines,
  useResumeItem,
  useSetStepOwner,
  useSyncStatus,
} from "../../../query/hooks";
import { useConfiguredRepository, useFeatureJiraProject, useProjects } from "../../../query/useRepositories";
import { useInFlight } from "../../../query/useInFlight";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { Button, EmptyState, ErrorLine, Loading, Notice, SearchInput, ViewHeader } from "../../kit";
import { PickFromJira } from "../../dialogs/PickFromJira";
import { usePipelineName } from "../shared";
import { CardBody } from "./BoardCard";
import { GhostColumn, StepColumn, type CardHandlers } from "./BoardColumn";
import { ConfirmItemHold, ConfirmItemMove } from "./MoveDialogs";
import { PausedRail } from "./PausedRail";
import { LinkButton } from "../../kit";
import { PipelineViews } from "../shared";
import { AskAssistantButton, EMPTY_PIPELINE_TEXT, PipelineTitle } from "./header";

/**
 * The board, in the chat layout (addresses `/project` and
 * `/pipelines/:pipelineId`): a column per step with who owns it, the work
 * standing on each, the paused rail beside them, and every way the
 * classic board had to move, hold, hand off, claim and narrow that work.
 *
 * Only the drawing is this layout's. The rules are the classic board's,
 * read from it rather than copied — what a drop means
 * (`resolveDropTarget` and the two droppable ids), what the assistant is
 * told the board shows (`boardViewFilter`), and which work is in flight,
 * in what order, waiting on whom and from where (`hasRunInFlight`,
 * `newestFirst`, `ownerIdOf`, `descriptionFor`, `originHover`) — so the
 * two boards cannot disagree.
 */

/** A pipeline a card can be handed to, and where it lands there (EO-70). One with no entry step is never one. */
interface HandOffTarget {
  id: string;
  name: string;
  entryStepId: string;
}

/**
 * A move a gesture proposed, waiting on its dialog. A hand-off holds only
 * the chosen pipeline's id: the step it lands on is looked up when it is
 * sent, so a `config:changed` push under an open dialog cannot send a
 * stale entry step.
 */
type PendingMove = {
  item: ItemSummary;
  cancelActiveRun: boolean;
  problem: string | null;
} & ({ kind: "step"; toStepId: string } | { kind: "handOff"; toPipelineId: string | null });

/** A column with nothing on it, the same array every render. */
const NO_CARDS: ItemSummary[] = [];

/**
 * Where a card dropped on another column is drawn until the move lands
 * (EO-564): in the column it was dropped on, marked as moving, from the
 * drop until the record says it has left the step it was on. Only the
 * drawing — the step is written by `items:move` alone, and the record
 * wins the moment it says the card is anywhere but `fromStepId`.
 */
interface Placement {
  itemId: string;
  fromStepId: string | null;
  toStepId: string;
}

export function BoardView({ pipelineId }: { pipelineId: string }) {
  const navigate = useNavigate();
  const name = usePipelineName(pipelineId);
  const vocabulary = useChromeVocabulary();
  const { items: projectItems, states, verification, version, finishingOn, ghosts, isLoading, error } = usePipelineData(pipelineId);
  const { repository } = useConfiguredRepository();
  const { active } = useProjects();
  const { pipelines } = usePipelines(active?.id ?? null);
  const jira = useFeatureJiraProject();
  const jiraConnected = Boolean(jira?.jira.credentialsConfigured && jira.jira.projectKey);
  const move = useMoveItem();
  const hold = useHoldItem();
  const resume = useResumeItem();
  const claim = useClaimItem();
  // Which cards have a claim in flight (EO-562): per card, so one claim
  // pending dims no other card's Claim, and a second press sends nothing.
  const claims = useInFlight<string>();
  const { people, groups } = usePeople();
  const sync = useSyncStatus();
  const queued = useMemo(() => new Set(sync.data?.queuedItemIds ?? []), [sync.data?.queuedItemIds]);
  const setOwner = useSetStepOwner(pipelineId);
  const modules = useModules();
  const moduleById = useMemo(() => new Map((modules.data?.modules ?? []).map((module) => [module.id, module])), [modules.data]);

  // The narrowing comes from the address (EO-230, EO-308): the configure
  // screen and the Job page hand this board a filter by linking to it.
  const [searchParams, setSearchParams] = useSearchParams();
  const stepFilter = searchParams.get(STEP_ID_FACET);
  const jobFilter = searchParams.get(JOB_ID_FACET);
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);

  const [dragging, setDragging] = useState<ItemSummary | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  // A move that has landed, held until the board has been read again
  // (EO-564): the reply settles a macrotask before the redrawn list
  // reaches this component, and the card must not flash back meanwhile.
  const [landing, setLanding] = useState<Placement | null>(null);
  // The card the last confirmed column move applied to (EO-634): shown in
  // its new column however far down it sorts, until another move.
  const [moved, setMoved] = useState<string | null>(null);
  const [pendingHold, setPendingHold] = useState<{
    item: ItemSummary;
    cancelActiveRun: boolean;
  } | null>(null);
  const [holdNotes, setHoldNotes] = useState<Record<string, string>>({});
  const [resumeBlockedId, setResumeBlockedId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // This pipeline's work only, narrowed by the search and the address —
  // and that narrowed set is what the columns, the rail and the running
  // count are all of.
  const narrowed = useMemo(
    () => projectItems.filter((item) => item.pipelineId === pipelineId && matchesBoardQuery(item, boardViewFilter(query, stepFilter, jobFilter))),
    [projectItems, pipelineId, query, stepFilter, jobFilter],
  );

  const columns = useMemo(() => [...states].sort((a, b) => a.position - b.position), [states]);

  // A column drop is drawn where it was dropped while its dialog is open
  // and while the move applies, then until the record catches up. A
  // refusal or a failure puts it back, with the dialog saying why.
  const placement = useMemo<Placement | null>(
    () =>
      pendingMove?.kind === "step" && pendingMove.problem === null
        ? { itemId: pendingMove.item.id, fromStepId: pendingMove.item.stepId, toStepId: pendingMove.toStepId }
        : landing,
    [pendingMove, landing],
  );
  const items = useMemo(() => {
    if (placement === null) return narrowed;
    const stepName = columns.find((step) => step.id === placement.toStepId)?.name;
    return narrowed.map((item) =>
      item.id === placement.itemId && item.stepId === placement.fromStepId
        ? { ...item, stepId: placement.toStepId, ...(stepName === undefined ? {} : { stepName }) }
        : item,
    );
  }, [narrowed, columns, placement]);

  // The record has the card somewhere else now — or no longer has it —
  // so the landed move stops being drawn and the record is.
  useEffect(() => {
    if (landing === null) return;
    const recorded = projectItems.find((item) => item.id === landing.itemId);
    if (recorded === undefined || recorded.stepId !== landing.fromStepId) setLanding(null);
  }, [landing, projectItems]);

  // What the board is narrowed to, for the assistant (EO-192): the main
  // process applies the same predicate, so it answers about this board.
  useViewParameters({ filter: boardViewFilter(query, stepFilter, jobFilter) });

  const narrowedTo = stepFilter === null ? null : (columns.find((step) => step.id === stepFilter)?.name ?? "a step that is no longer here");
  const narrowedToJob = jobFilter === null ? null : (items[0]?.origin?.jobName ?? "a job with nothing on this board");
  const paused = useMemo(() => items.filter((item) => item.heldAt !== null || item.latestRunStatus === "awaiting_input"), [items]);
  const running = items.filter(hasRunInFlight).length;
  const explainsVerification = useMemo(() => saysWhatIsChecked(columns, verification), [columns, verification]);

  const destinations = useMemo<HandOffTarget[]>(
    () =>
      pipelines.flatMap((candidate) =>
        candidate.id === pipelineId || candidate.entryStepId === null
          ? []
          : [
              {
                id: candidate.id,
                name: candidate.name,
                entryStepId: candidate.entryStepId,
              },
            ],
      ),
    [pipelines, pipelineId],
  );

  // Stable, with the hand-off and the claim below: every card is handed
  // these, and a card is redrawn only when one of its props changes (EO-565).
  const open = useCallback((itemId: string) => void navigate(`/items/${itemId}`), [navigate]);

  /** Both ways into a hand-off — the card's control and the rail's target — end at one dialog (EO-71). */
  const beginHandOff = useCallback(
    (item: ItemSummary) => {
      setPendingMove({
        kind: "handOff",
        item,
        // Chosen for you only when there is exactly one answer.
        toPipelineId: destinations.length === 1 ? (destinations[0]?.id ?? null) : null,
        cancelActiveRun: hasRunInFlight(item),
        problem: null,
      });
    },
    [destinations],
  );

  // The claim settles once the board has been read again, so the card
  // drops "Claiming…" for the answer rather than for "Claim". A refusal
  // says nothing here, as before: the card is redrawn from the record.
  const runClaim = claims.run;
  const claimItem = claim.mutateAsync;
  const onClaim = useCallback(
    (claimed: ItemSummary) => void runClaim(claimed.id, true, () => claimItem({ itemId: claimed.id })).catch(() => undefined),
    [runClaim, claimItem],
  );

  function handleDragEnd(event: DragEndEvent) {
    setDragging(null);
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : undefined;

    if (overId === PAUSED_RAIL_DROPPABLE_ID) {
      const item = items.find((candidate) => candidate.id === activeId);
      // A card already in the rail dropped back on it is the rail's no-op.
      if (!item || item.heldAt !== null) return;
      setPendingHold({ item, cancelActiveRun: hasRunInFlight(item) });
      return;
    }
    if (overId === HAND_OFF_DROPPABLE_ID) {
      const item = items.find((candidate) => candidate.id === activeId);
      if (!item || destinations.length === 0) return;
      beginHandOff(item);
      return;
    }
    const target = resolveDropTarget(columns, items, activeId, overId);
    if (!target) return;
    setPendingMove({
      kind: "step",
      ...target,
      cancelActiveRun: hasRunInFlight(target.item),
      problem: null,
    });
  }

  function handleResume(itemId: string) {
    resume.mutate(
      { itemId, cancelActiveRun: false },
      {
        onSuccess: (result) => {
          // Resume refuses rather than doubling up on a run in flight
          // (EO-45); the card says so rather than appearing to do nothing.
          setResumeBlockedId(result.blockedByActiveRun ? itemId : null);
          if (!result.blockedByActiveRun) setHoldNotes(({ [itemId]: _ended, ...rest }) => rest);
        },
      },
    );
  }

  function confirmMove(comment: string) {
    if (!pendingMove) return;
    // A hand-off's step is read from the destinations now, not from when
    // the dialog opened, so what is shown and what is sent agree.
    const chosen = pendingMove.kind === "handOff" ? destinations.find((candidate) => candidate.id === pendingMove.toPipelineId) : undefined;
    const toPipelineId = pendingMove.kind === "handOff" ? chosen?.id : undefined;
    const toStepId = pendingMove.kind === "handOff" ? chosen?.entryStepId : pendingMove.toStepId;
    if (toStepId === undefined) return;
    const moving = pendingMove.item;
    // Each attempt is answered afresh: the last refusal is put away, so a
    // retried column move is drawn where it was dropped again while it
    // applies, and a new refusal or failure brings both back.
    if (pendingMove.problem !== null) setPendingMove((current) => (current ? { ...current, problem: null } : current));
    move.mutate(
      {
        itemId: pendingMove.item.id,
        toStepId,
        ...(toPipelineId === undefined ? {} : { toPipelineId }),
        cancelActiveRun: pendingMove.cancelActiveRun,
        comment,
      },
      {
        onSuccess: (result) => {
          // A run started meanwhile: keep the dialog and its comment, and
          // turn it into the destructive one.
          if (result.blockedByActiveRun) {
            setPendingMove((current) => (current ? { ...current, cancelActiveRun: true, problem: null } : current));
            return;
          }
          const problem = result.problem;
          if (problem !== null) {
            setPendingMove((current) => (current ? { ...current, problem } : current));
            return;
          }
          // A column move stays drawn where it was dropped until the board
          // has been read again; a hand-off leaves this board on the reply.
          if (result.moved && pendingMove.kind === "step") {
            setLanding({ itemId: moving.id, fromStepId: moving.stepId, toStepId });
            setMoved(moving.id);
          }
          setPendingMove(null);
        },
        // Nothing moved: the card goes back and the dialog says why, as a
        // refusal does.
        onError: (error) => setPendingMove((current) => (current ? { ...current, problem: error.message } : current)),
      },
    );
  }

  function confirmHold(comment: string) {
    if (!pendingHold) return;
    const held = pendingHold.item;
    hold.mutate(
      {
        itemId: held.id,
        cancelActiveRun: pendingHold.cancelActiveRun,
        comment,
      },
      {
        onSuccess: (result) => {
          if (result.blockedByActiveRun) {
            setPendingHold((current) => (current ? { ...current, cancelActiveRun: true } : current));
            return;
          }
          const note = comment.trim();
          if (note !== "") setHoldNotes((current) => ({ ...current, [held.id]: note }));
          // A hold you asked for has to land somewhere you can see it.
          setRailOpen(true);
          setPendingHold(null);
        },
      },
    );
  }

  const moving = placement?.itemId ?? null;
  const handlers = useMemo<CardHandlers>(
    () => ({
      mixed: vocabulary.mixed,
      queued,
      canHandOff: destinations.length > 0,
      onHandOff: beginHandOff,
      claiming: claims.pending,
      moving,
      moved,
      onClaim,
      onOpen: open,
    }),
    [vocabulary.mixed, queued, destinations.length, beginHandOff, claims.pending, moving, moved, onClaim, open],
  );

  // Each column's cards, newest first, worked out once per change to the
  // board rather than once per column per render (EO-565). A held card is
  // in the rail and not in its column.
  const cardsByStep = useMemo(() => {
    const byStep = new Map<string, ItemSummary[]>();
    for (const item of items) {
      if (item.heldAt !== null || item.stepId === null) continue;
      const column = byStep.get(item.stepId);
      if (column) column.push(item);
      else byStep.set(item.stepId, [item]);
    }
    return new Map([...byStep].map(([stepId, column]) => [stepId, newestFirst(column)]));
  }, [items]);

  const filterPlaceholder = vocabulary.mixed ? `Filter ${vocabulary.items.toLowerCase()}…` : "Filter tasks…";
  // The rail rests open while anything is paused, and shows itself for
  // the length of any drag — dismissed or empty — because dragging is
  // when somewhere to drop is needed. A drag never writes `railOpen`.
  const showRail = (paused.length > 0 && railOpen) || dragging !== null;

  return (
    // As tall as the canvas, so the columns below the head can be bounded
    // to what is left of it (EO-634) — and no shorter than the head and
    // the columns' least, so a short canvas scrolls rather than squeezing.
    <div className="@container flex min-w-0 flex-1 flex-col">
      <ViewHeader
        title={<PipelineTitle name={name} pipelineId={pipelineId} />}
        stackActions
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className={running > 0 ? "h-[7px] w-[7px] rounded-full bg-running" : "h-[7px] w-[7px] rounded-full bg-idle"} />
              <span className="tabular-nums">{running === 1 ? "1 agent running" : `${running} agents running`}</span>
            </span>
            {repository ? (
              <>
                <span>
                  Worktree <span className="font-mono text-ink-muted">{repository.name}</span>
                </span>
                <span>
                  Base <span className="font-mono text-ink-muted">{repository.baseBranch}</span>
                </span>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            <PipelineViews pipelineId={pipelineId} current="board" />
            {/* The chat layout's one way to import from Jira (EO-518): its own
                button, now that nothing else on the head adds work. */}
            <Button
              icon={<Download size={13} />}
              disabled={!jiraConnected}
              {...(jiraConnected ? {} : { title: "No Jira project is connected" })}
              onClick={() => setPicking(true)}
            >
              Import from Jira
            </Button>
          </>
        }
      >
        <SearchInput value={query} onChange={setQuery} label="Filter the board" placeholder={filterPlaceholder} className="w-full max-w-[22rem]" />
        {narrowedTo !== null || narrowedToJob !== null ? (
          <Notice
            role="status"
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSearchParams((current) => {
                    const next = new URLSearchParams(current);
                    next.delete(STEP_ID_FACET);
                    next.delete(JOB_ID_FACET);
                    return next;
                  })
                }
              >
                Show the whole board
              </Button>
            }
          >
            <span>
              {narrowedToJob === null
                ? `Showing only what ${narrowedTo} holds`
                : narrowedTo === null
                  ? `Showing only what "${narrowedToJob}" filed`
                  : `Showing only what "${narrowedToJob}" filed on ${narrowedTo}`}{" "}
              — {items.length === 1 ? "1 item" : `${items.length} items`}.
            </span>
          </Notice>
        ) : null}
        {/* The pipeline has moved on and some of this board has not
            (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). Only while something is still
            finishing on an
            older version, so it goes by itself. */}
        {version !== null && finishingOn.length > 0 ? (
          <Notice
            role="status"
            action={
              // The Changes view on the versions still finishing (EO-524):
              // from the oldest anything here entered on, to the one work
              // takes now.
              <LinkButton
                to={pipelineChangesPath(pipelineId, { kind: "versions", from: Math.min(...finishingOn.map((older) => older.number)), to: version.number })}
                className="h-[26px] px-2.5 text-xs"
              >
                View changes
              </LinkButton>
            }
          >
            <span>
              {pipelineUpdatedBanner({
                current: version.number,
                older: finishingOn,
                by: version.createdByName,
              })}
            </span>
          </Notice>
        ) : null}
      </ViewHeader>

      <PickFromJira open={picking} onOpenChange={setPicking} onImported={open} />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorLine>{error.message}</ErrorLine>
      ) : columns.length === 0 && ghosts.length === 0 ? (
        <EmptyState title="This pipeline has no steps yet." action={<AskAssistantButton />}>
          {EMPTY_PIPELINE_TEXT}
        </EmptyState>
      ) : (
        <DndContext
          sensors={sensors}
          // The rail appears for a drag and can move the columns as it
          // does, so the targets are measured throughout, not only once.
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={(event: DragStartEvent) => setDragging(items.find((item) => item.id === String(event.active.id)) ?? null)}
          onDragEnd={handleDragEnd}
          // Escape ends a drag without a drop; the rail goes back to how it rested.
          onDragCancel={() => setDragging(null)}
        >
          {/* The rail after the columns: beside them on a wide canvas, under
              them on a narrow one — never above, where appearing for a drag
              would push every column down under the pointer mid-drag. */}
          <div className="flex min-w-0 flex-1 flex-col gap-3 @4xl:flex-row @4xl:items-start">
            {showRail ? (
              <div className="order-2 min-w-0 @4xl:sticky @4xl:top-0 @4xl:w-[17rem] @4xl:shrink-0">
                <PausedRail
                  paused={paused}
                  notes={holdNotes}
                  handOff={dragging !== null && destinations.length > 0}
                  resumeBlockedId={resumeBlockedId}
                  resumingId={resume.isPending ? (resume.variables?.itemId ?? null) : null}
                  onResume={handleResume}
                  onClose={() => setRailOpen(false)}
                  onOpen={open}
                />
              </div>
            ) : null}
            {/* The columns scroll here, both ways, as one, inside the board
                and never the page (EO-634): filling what the head leaves of
                the canvas, so the sideways scrollbar is at the canvas's foot
                rather than under the longest column. The scroller is laid
                over its box, so the columns' height never props the board
                open; the box's least height, about two cards, does. */}
            <div className="relative order-1 min-h-[13rem] min-w-0 flex-1 @4xl:self-stretch">
              <div aria-label="Columns" role="group" data-tour="board" className="absolute inset-0 overflow-auto pb-1">
                {/* Each column as tall as its own cards, not the tallest one's. */}
                <div className="grid auto-cols-[minmax(14rem,1fr)] grid-flow-col items-start gap-2.5">
                  {columns.map((step) => (
                    <StepColumn
                      key={step.id}
                      step={step}
                      module={step.type === "module" && step.entryAction !== null ? moduleById.get(step.entryAction) : undefined}
                      verifies={explainsVerification || namesAnOwner(step, verification) ? verificationLine(step, verification) : null}
                      ownerId={ownerIdOf(step, verification)}
                      people={people}
                      groups={groups}
                      onSetOwner={(owner) =>
                        setOwner.mutate({
                          stepId: step.id,
                          personId: owner?.kind === "person" ? owner.id : null,
                          groupId: owner?.kind === "group" ? owner.id : null,
                        })
                      }
                      items={cardsByStep.get(step.id) ?? NO_CARDS}
                      handlers={handlers}
                      vocabulary={vocabulary}
                    />
                  ))}
                  {/* Steps only an older version has, still finishing work
                      (EO-327, ARCHITECTURE.md, "Publish, lock and versions"), gone when the last card leaves. */}
                  {ghosts.map((ghost) => (
                    <GhostColumn
                      key={ghost.stepId}
                      label={ghostColumnLabel({
                        stepName: ghost.name,
                        number: ghost.version,
                        holding: ghost.holding,
                      })}
                      items={cardsByStep.get(ghost.stepId) ?? NO_CARDS}
                      handlers={handlers}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <DragOverlay>
            {dragging ? (
              <div className="w-[15rem] rotate-1 rounded-[10px] bg-canvas-raised px-[9px] py-2 shadow-panel">
                <CardBody item={dragging} mixed={vocabulary.mixed} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {pendingMove ? (
        <ConfirmItemMove
          item={pendingMove.item}
          destination={
            pendingMove.kind === "handOff"
              ? {
                  kind: "pipeline",
                  options: destinations,
                  selectedId: pendingMove.toPipelineId,
                  onSelect: (toPipelineId) =>
                    setPendingMove((current) =>
                      // A refusal was about the destination chosen then.
                      current && current.kind === "handOff" ? { ...current, toPipelineId, problem: null } : current,
                    ),
                }
              : {
                  kind: "step",
                  name: columns.find((step) => step.id === pendingMove.toStepId)?.name ?? pendingMove.toStepId,
                }
          }
          cancelActiveRun={pendingMove.cancelActiveRun}
          problem={pendingMove.problem}
          busy={move.isPending}
          onCancel={() => setPendingMove(null)}
          onConfirm={confirmMove}
        />
      ) : null}

      {pendingHold ? (
        <ConfirmItemHold
          item={pendingHold.item}
          cancelActiveRun={pendingHold.cancelActiveRun}
          busy={hold.isPending}
          onCancel={() => setPendingHold(null)}
          onConfirm={confirmHold}
        />
      ) : null}
    </div>
  );
}
