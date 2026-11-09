import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Archive as ArchiveIcon, Check, ExternalLink, GitBranch, GitPullRequest, RefreshCw, Trash2, X } from "lucide-react";
import { describeItemOriginKind, itemWatchLines, type CommentView, type IpcRequest, type IpcResponse } from "@eo/core";
import { cn, Markdown } from "@eo/ui";
import { useItemAuthority } from "../../../shared/admin/authority";
import { buildTimeline, describeActor } from "../../../shared/item/timeline";
import { DONE_PREVIEWING } from "../../../shared/items/previewBanner";
import { archivedKey } from "../../../shared/pipeline/archive";
import { PRIORITY_LEVELS, priorityLabel } from "../../../shared/pipeline/priority";
import { ipcQuery } from "../../../query/client";
import { agentsKey, itemsKey, useChromeVocabulary, usePipelineData, useStepAuthority } from "../../../query/hooks";
import { useInFlight } from "../../../query/useInFlight";
import { namesItemOrNone, useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { runStatusOf } from "../../../shared/items/status";
import { groupRuns, isQuietRun, liveRunOf } from "../../../shared/transcript/grouping";
import { ActAsAdmin } from "../../admin/ActAsAdmin";
import { ReadOnlyFence } from "../../admin/ReadOnlyFence";
import { useMayEdit } from "../../HolderGate";
import { Button, Card, Chip, ErrorLine, Facts, Field, GroupLabel, Loading, Select } from "../../kit";
import { DecisionButtons } from "../../parts";
import { ItemRef, RefText } from "../items/ItemReference";
import { PreviewBanner } from "../items/PreviewBanner";
import { useFollowItemProject, usePipelineName } from "../shared";
import { AssigneePicker } from "./AssigneePicker";
import { ConfirmDeleteComment } from "./ConfirmDeleteComment";
import { ConfirmDeleteItem } from "./ConfirmDeleteItem";
import { CriteriaSection, SpecSection } from "./Fields";
import { ItemHeader } from "./ItemHeader";
import { JiraLink } from "./JiraLink";
import { ReferenceField } from "./ReferenceField";
import { MemoryPanel } from "../settings/sections/MemoryPanel";
import { OutputSection } from "./Output";
import { RunComposer } from "./RunComposer";
import { StepStateDot, Stepper } from "./Stepper";
import { SuggestionReview } from "./SuggestionReview";
import { CommentThread } from "./Thread";
import { transitionsShown, useItemThread } from "./useEarlierComments";
import { useOutstandingPosts } from "./useOutstandingPosts";
import { excerpt, spoken, StatusLine, when } from "./parts";

/**
 * `/items/:itemId`: an item, whole (the classic `ItemDetail`, drawn in the
 * chat layout — ARCHITECTURE.md, "The chat-centric layout").
 *
 * Everything the classic page does is here, in the order a person works
 * through it: what the item is and where it stands; its fields, criteria
 * and dependencies; a suggested pipeline change where it is one; what it
 * produced; the decision its step asks for; then the thread and the box
 * to add to it. The facts the classic page kept in a right-hand rail are
 * a card of their own, beside the reading column where the canvas is wide
 * and under the item where it is not.
 *
 * Read-only until an admin looking into another team's work says
 * otherwise (EO-326, ARCHITECTURE.md, "Identity"): the whole page sits in one fence, so a
 * control added to it later is fenced without anybody remembering to.
 */
export function ItemView({ itemId }: { itemId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const vocabulary = useChromeVocabulary();
  const detailKey = useMemo(() => ["item", itemId] as const, [itemId]);

  // The item, its thread carrying the newest page with older ones read on demand (EO-559).
  const earlier = useItemThread(itemId);
  const detail = earlier.detail;
  // Only for the child count the delete confirmation states.
  const allItems = useQuery({ queryKey: itemsKey, queryFn: () => ipcQuery("items:list", undefined) });
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined) });
  const cost = useQuery({ queryKey: ["costs", "item", itemId], queryFn: () => ipcQuery("costs:getForItem", { itemId }) });

  useFollowItemProject(itemId, detail.data?.item.projectId ?? null);
  // New comments and moves arrive as pushes, so the thread stays live
  // without polling — this item's pushes, or ones naming no item, and no
  // other item's (EO-560).
  const ours = namesItemOrNone(itemId);
  // And its parent's (EO-637): an item without a Reference of its own
  // shows its feature's, so a change to the feature — by an agent or
  // another window — changes this page too.
  const parentId = detail.data?.item.parentId ?? null;
  useInvalidateOnPush("items:changed", detailKey, { filter: (payload) => ours(payload) || (parentId !== null && payload.itemId === parentId) });
  useInvalidateOnPush("runs:changed", detailKey, { filter: ours });
  useInvalidateOnPush("runs:changed", ["costs", "item", itemId], { filter: ours });

  // Returned rather than fired: TanStack awaits it, so a composer clears
  // exactly when the real comment is on screen.
  const invalidate = () => Promise.all([queryClient.invalidateQueries({ queryKey: detailKey }), queryClient.invalidateQueries({ queryKey: itemsKey })]);

  const update = useMutation({ mutationFn: (input: IpcRequest<"items:update">) => ipcQuery("items:update", input), onSuccess: invalidate });

  // Each editor that can be told no has its own problem, shown beside the
  // box it was typed into: a refusal arrives as a *successful* reply.
  const [jiraProblem, setJiraProblem] = useState<string | null>(null);
  const editJira = useMutation({
    mutationFn: (input: IpcRequest<"items:update">) => ipcQuery("items:update", input),
    onSuccess: (result) => {
      setJiraProblem(result.problem);
      return invalidate();
    },
    onError: (error: Error) => setJiraProblem(error.message),
  });
  const [referenceProblem, setReferenceProblem] = useState<string | null>(null);
  const editReference = useMutation({
    mutationFn: (input: IpcRequest<"items:update">) => ipcQuery("items:update", input),
    onSuccess: (result) => {
      setReferenceProblem(result.problem);
      // Every item's detail, not only this one's: a story without a
      // Reference of its own shows its feature's, so a feature's edit
      // changes pages other than its own.
      return Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: ["item"] })]);
    },
    onError: (error: Error) => setReferenceProblem(error.message),
  });
  const [criteriaProblem, setCriteriaProblem] = useState<string | null>(null);
  const editCriteria = useMutation({
    mutationFn: (input: IpcRequest<"items:update">) => ipcQuery("items:update", input),
    onSuccess: (result) => {
      setCriteriaProblem(result.problem);
      return invalidate();
    },
    onError: (error: Error) => setCriteriaProblem(error.message),
  });
  const [specProblem, setSpecProblem] = useState<string | null>(null);
  const editSpec = useMutation({
    mutationFn: (input: IpcRequest<"items:update">) => ipcQuery("items:update", input),
    onSuccess: (result) => {
      setSpecProblem(result.problem);
      return invalidate();
    },
    onError: (error: Error) => setSpecProblem(error.message),
  });
  const [outputProblem, setOutputProblem] = useState<string | null>(null);
  const saveOutput = useMutation({
    mutationFn: (input: IpcRequest<"items:setOutput">) => ipcQuery("items:setOutput", input),
    onSuccess: (result) => {
      setOutputProblem(result.problem);
      return invalidate();
    },
    onError: (error: Error) => setOutputProblem(error.message),
  });

  // KAN-30. A live run and uncommitted work come back as `deleted: false`
  // — normal answers the dialog reads — and a checkout the delete could
  // not remove (issue #131) keeps the dialog up to name it.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [refusal, setRefusal] = useState<IpcResponse<"items:delete"> | null>(null);
  const [leftover, setLeftover] = useState<IpcResponse<"items:delete">["leftoverWorktrees"]>([]);
  const remove = useMutation({
    mutationFn: (input: IpcRequest<"items:delete">) => ipcQuery("items:delete", input),
    onSuccess: (result) => {
      if (!result.deleted) {
        setRefusal(result);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: itemsKey });
      if (result.leftoverWorktrees.length > 0) {
        setRefusal(null);
        setLeftover(result.leftoverWorktrees);
        return;
      }
      setConfirmingDelete(false);
      void navigate("/");
    },
  });

  // Pulling Jira's side on demand, and saying what came back — a sync
  // that found nothing says so rather than looking broken.
  const [syncReport, setSyncReport] = useState<string | null>(null);
  const sync = useMutation({
    mutationFn: (input: IpcRequest<"jira:pull">) => ipcQuery("jira:pull", input),
    onSuccess: (result) => {
      void invalidate();
      if (result.problem) {
        setSyncReport(result.problem);
        return;
      }
      const parts = [
        result.comments > 0 ? `${result.comments} comment${result.comments === 1 ? "" : "s"}` : null,
        result.edits > 0 ? `${result.edits} edit${result.edits === 1 ? "" : "s"}` : null,
        result.attachments > 0 ? `${result.attachments} attachment change${result.attachments === 1 ? "" : "s"}` : null,
      ].filter((part): part is string => part !== null);
      const skipped =
        result.skippedAttachments > 0 ? ` Skipped ${result.skippedAttachments} attachment${result.skippedAttachments === 1 ? "" : "s"} over 20 MB.` : "";
      setSyncReport((parts.length > 0 ? `Pulled ${parts.join(" and ")} from Jira.` : "Already up to date with Jira.") + skipped);
    },
    onError: (error: Error) => setSyncReport(error.message),
  });

  // KAN-33: the gentler sibling of delete — nothing is lost, so nothing to confirm.
  const archive = useMutation({
    mutationFn: (input: IpcRequest<"items:setArchived">) => ipcQuery("items:setArchived", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: itemsKey });
      void queryClient.invalidateQueries({ queryKey: archivedKey });
      void navigate("/project");
    },
  });

  // Acting on the thread can change a comment read back as well as the
  // page — an answer settles an old question, a pin or a delete lands on
  // whichever comment it was pressed on — so these read the history again
  // too. Ordinary pushes do not (`useItemThread`).
  const invalidateThread = () => Promise.all([invalidate(), earlier.invalidateHistory()]);
  const post = useMutation({ mutationFn: (input: IpcRequest<"comments:post">) => ipcQuery("comments:post", input), onSuccess: invalidateThread });
  const setPinned = useMutation({ mutationFn: (input: IpcRequest<"comments:setPinned">) => ipcQuery("comments:setPinned", input), onSuccess: invalidateThread });
  // A pin is drawn the way it is going the moment it is pressed, as
  // pending, until the thread has been read again; a refusal takes it back
  // and says why (EO-562).
  const pins = useInFlight<string, boolean>();
  const [pinReport, setPinReport] = useState<string | null>(null);
  // Stable, like every handler a thread is handed: a thread is redrawn
  // only when something it shows has changed (EO-565).
  const runPin = pins.run;
  const pinComment = setPinned.mutateAsync;
  const togglePin = useCallback(
    (commentId: string, pinned: boolean) => {
      setPinReport(null);
      void runPin(commentId, pinned, () => pinComment({ commentId, pinned })).catch((error: unknown) =>
        setPinReport(`Could not ${pinned ? "pin" : "unpin"} the comment: ${error instanceof Error ? error.message : String(error)}`),
      );
    },
    [runPin, pinComment],
  );

  // The local half of a comment delete either happened or did not, so the
  // dialog closes on success and whatever Jira refused is said beside the thread.
  const [deleting, setDeleting] = useState<{ comment: CommentView; replies: CommentView[] } | null>(null);
  const [deleteReport, setDeleteReport] = useState<string | null>(null);
  const askToDelete = useCallback((comment: CommentView, replies: CommentView[]) => {
    setDeleteReport(null);
    setDeleting({ comment, replies });
  }, []);
  const removeComment = useMutation({
    mutationFn: (input: IpcRequest<"comments:delete">) => ipcQuery("comments:delete", input),
    onSuccess: (result) => {
      void invalidateThread();
      setDeleting(null);
      setDeleteReport(result.problem ?? result.jira?.problem ?? null);
    },
    onError: (error: Error) => setDeleteReport(error.message),
  });

  const { readOnly } = useItemAuthority(itemId);
  // Who decides here, where a group's step says only the holder does (EO-368).
  const stepAuthority = useStepAuthority(itemId);
  const authority = stepAuthority.known ? stepAuthority.authority : null;
  // Not before the answer is known: an editor offered while it is still
  // being asked would be offered to whoever happens to be looking.
  const mayEdit = useMayEdit(itemId);
  const agentNames = useMemo(() => new Map((agents.data?.agents ?? []).map((agent) => [agent.id, agent.name])), [agents.data]);
  // Live agents only (EO-186): a retired one would be autocompleted and then refused.
  const mentionables = useMemo(
    () => ["user", ...(agents.data?.agents ?? []).filter((agent) => agent.archivedAt === null).map((agent) => agent.role)],
    [agents.data],
  );
  const { states: pipelineSteps } = usePipelineData(detail.data?.item.pipelineId ?? "default");
  const pipelineName = usePipelineName(detail.data?.item.pipelineId ?? "");

  // Worked out when the thread or the moves change, not on every render
  // of the page (EO-565): its entries are what each thread is memoised on.
  const transitions = detail.data?.transitions;
  const timeline = useMemo(
    () => buildTimeline({ comments: earlier.comments, transitions: transitionsShown(transitions ?? [], earlier.comments, earlier.remaining) }),
    [earlier.comments, transitions, earlier.remaining],
  );
  // Each post held by where it goes until it settles: a thread is busy
  // while its own reply is on its way, however many others are, and a
  // second press on it sends nothing (`useOutstandingPosts`).
  const posts = useOutstandingPosts();
  const sendPost = post.mutateAsync;
  const sendOnce = posts.send;
  const reply = useCallback(
    (parentId: string, body: string, mentions: string[], attachmentIds: string[]) =>
      sendOnce(parentId, () => sendPost({ itemId, body, mentions, attachmentIds, pinned: false, parentId })),
    [sendOnce, sendPost, itemId],
  );

  if (detail.isLoading) return <Loading />;
  if (detail.error)
    return (
      <ErrorLine>
        <RefText>{detail.error.message}</RefText>
      </ErrorLine>
    );
  if (!detail.data) return <p className="text-[13px] text-ink-subtle">That {vocabulary.item.toLowerCase()} no longer exists.</p>;

  const { item, dependsOn, decision, currentOutput, watch } = detail.data;
  const { branch, pullRequest } = item.git;
  // Conversations, not `runs` rows: counted as the runs view groups them.
  const runCount = groupRuns(detail.data.runs).length;
  const latestRun = detail.data.runs.filter((run) => !isQuietRun(run)).at(-1);
  // The current step wears its run's state (EO-689): the run the "Run" section below shows, idle with none.
  const runState = runStatusOf(latestRun?.status ?? null);
  const steps = item.stepId === null ? [] : pipelineSteps;
  const stepName = (id: string) => pipelineSteps.find((step) => step.id === id)?.name ?? spoken(id);
  const current = pipelineSteps.find((step) => step.id === item.stepId);
  const costCents = cost.data?.costCents ?? 0;
  const knownPriority = PRIORITY_LEVELS.some((level) => level.value === item.priority);
  const attachmentSync = detail.data.attachmentSync;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Above everything, the preview banner included: an admin has to
          know whose work this is before reading any of it, and this
          carries the one control the fence below must not contain. */}
      <ActAsAdmin itemId={itemId} />
      <ReadOnlyFence readOnly={readOnly}>
        {item.preview ? (
          <PreviewBanner
            action={
              // The one deletion without a confirmation: a preview has no
              // live work or uncommitted changes worth keeping.
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ itemId, cancelActiveRun: true, deleteInJira: false, discardUncommitted: true })}
              >
                {DONE_PREVIEWING}
              </Button>
            }
          />
        ) : null}

        <ItemHeader
          itemId={itemId}
          current="item"
          runCount={runCount}
          title={item.title}
          meta={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ItemRef itemKey={item.key} itemId={item.id} className="font-mono text-ink-muted" />
              <span>{item.typeLabel}</span>
              {/* The step's name, never its id: only seeded ids read as words. */}
              <Chip tone={item.needsAttention ? "paused" : "neutral"} className="gap-1.5">
                <StepStateDot tone={runState.tone} />
                {current?.name ?? item.stepName}
              </Chip>
              {item.needsAttention ? <Chip tone="paused">waiting on you</Chip> : null}
            </span>
          }
          actions={
            <>
              {item.jiraKey ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RefreshCw size={12} />}
                  disabled={sync.isPending}
                  onClick={() => {
                    setSyncReport(null);
                    sync.mutate({ itemId });
                  }}
                >
                  {sync.isPending ? "Syncing…" : "Sync now"}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" icon={<ArchiveIcon size={12} />} disabled={archive.isPending} onClick={() => archive.mutate({ itemId, archived: true })}>
                Archive
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={12} />}
                disabled={remove.isPending}
                onClick={() => {
                  setRefusal(null);
                  setConfirmingDelete(true);
                }}
              >
                Delete
              </Button>
            </>
          }
        />

        {syncReport ? (
          <StatusLine>
            <RefText>{syncReport}</RefText>
          </StatusLine>
        ) : null}
        {(attachmentSync?.pending ?? 0) > 0 ? (
          <StatusLine tone={attachmentSync?.error ? "danger" : "plain"}>
            <RefText>
              {attachmentSync?.error
                ? `Jira attachment synchronization is retrying: ${attachmentSync.error}`
                : `${attachmentSync?.pending} Jira attachment operation${attachmentSync?.pending === 1 ? " is" : "s are"} pending.`}
            </RefText>
          </StatusLine>
        ) : null}
        {deleteReport ? (
          <StatusLine tone="danger">
            <RefText>{deleteReport}</RefText>
          </StatusLine>
        ) : null}
        {pinReport ? (
          <StatusLine tone="danger">
            <RefText>{pinReport}</RefText>
          </StatusLine>
        ) : null}

        <div className="@container min-w-0">
          <div className="grid min-w-0 grid-cols-1 gap-3 @4xl:grid-cols-[minmax(0,1fr)_17rem] @4xl:grid-rows-[auto_1fr]">
            <article aria-label={item.title} className="flex min-w-0 flex-col gap-3 @4xl:col-start-1 @4xl:row-start-1">
              <Card>
                <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-2">
                  <Field label="Priority" className="w-[8.5rem]">
                    <Select value={item.priority} disabled={update.isPending} onChange={(event) => update.mutate({ itemId, priority: Number(event.target.value) })}>
                      {PRIORITY_LEVELS.map((level) => (
                        <option key={level.value} value={level.value}>
                          {level.label}
                        </option>
                      ))}
                      {/* An open integer: a value set elsewhere is shown, never reset to Normal by rendering. */}
                      {knownPriority ? null : <option value={item.priority}>{priorityLabel(item.priority)}</option>}
                    </Select>
                  </Field>
                  <AssigneePicker itemId={itemId} assignee={item.assigneePerson} />
                  <span className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-3 gap-y-1 pb-1.5 text-[12px] text-ink-subtle">
                    {branch ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <GitBranch size={12} className="shrink-0" />
                        <span className="truncate font-mono text-ink-muted">{branch}</span>
                      </span>
                    ) : null}
                    {/* `target="_blank"` reaches the window-open handler, which sends it to the real browser. */}
                    {item.jiraKey ? (
                      item.jiraUrl ? (
                        <a href={item.jiraUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-accent-soft hover:underline">
                          <ExternalLink size={12} />
                          <span className="font-mono">{item.jiraKey}</span>
                        </a>
                      ) : (
                        <span className="font-mono text-ink-muted">{item.jiraKey}</span>
                      )
                    ) : null}
                    {pullRequest ? (
                      <a href={pullRequest} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-accent-soft hover:underline">
                        <GitPullRequest size={12} />
                        <span>pull request</span>
                      </a>
                    ) : null}
                    {costCents > 0 ? <span className="tabular-nums">{(costCents / 100).toFixed(2)} USD so far</span> : null}
                  </span>
                </div>

                {/* A container is on no pipeline (ARCHITECTURE.md, "One work entity"), so it has no stepper. */}
                {steps.length > 0 ? <Stepper steps={steps} currentId={item.stepId} state={runState.tone} stateLabel={runState.label} /> : null}

                {item.body ? (
                  <div className="min-w-0 text-ink">
                    <Markdown>{item.body}</Markdown>
                  </div>
                ) : null}

                {/* The item's own content is the holder's to change on a
                    step that waits on a group (EO-368); the thread stays open. */}
                <ReadOnlyFence readOnly={!mayEdit}>
                <SpecSection
                  item={item}
                  busy={editSpec.isPending}
                  problem={specProblem}
                  onSave={(spec) =>
                    editSpec
                      .mutateAsync({ itemId, spec })
                      .then((result) => result.problem === null)
                      .catch(() => false)
                  }
                  onCancel={() => setSpecProblem(null)}
                />

                <CriteriaSection
                  criteria={item.acceptanceCriteria}
                  // A container is decomposed rather than implemented: the
                  // type's flag, never the word `feature` (KAN-146).
                  offerToAdd={!item.container}
                  busy={editCriteria.isPending}
                  problem={criteriaProblem}
                  onSave={(next) =>
                    editCriteria
                      .mutateAsync({ itemId, acceptanceCriteria: next })
                      .then((result) => result.problem === null)
                      .catch(() => false)
                  }
                  onCancel={() => setCriteriaProblem(null)}
                />
                </ReadOnlyFence>

                {/* A step that keeps checking (EO-456): when it last looked and when it looks next. */}
                {watch != null ? (
                  <section aria-label="Keep checking" className="flex min-w-0 flex-col gap-2 border-t border-line/60 pt-3">
                    <GroupLabel>Keep checking</GroupLabel>
                    <ul className="flex flex-col gap-1 text-[13px] text-ink">
                      {itemWatchLines(watch).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {dependsOn.length > 0 ? (
                  <section aria-label="Dependencies" className="flex min-w-0 flex-col gap-2 border-t border-line/60 pt-3">
                    <GroupLabel>Blocked by</GroupLabel>
                    <ul className="flex flex-col gap-1.5">
                      {dependsOn.map((dependency) => (
                        <li key={dependency.id} className="flex min-w-0 items-center gap-2 text-[13px]">
                          {/* By id, so a dependency on another project still links. */}
                          <ItemRef itemKey={dependency.key} itemId={dependency.id} className="shrink-0 font-mono text-[12px] text-ink-subtle" />
                          <span className="min-w-0 flex-1 truncate text-ink">{dependency.title}</span>
                          {/* Its own pipeline's step name, which travels with it. */}
                          <Chip>{dependency.stepName}</Chip>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </Card>

              {/* A suggested pipeline change, read before it is decided on (EO-331, ARCHITECTURE.md, "Divergence and suggestions"). */}
              <SuggestionReview itemId={itemId} />

              {/* The deliverable, above the buttons that decide about it (ARCHITECTURE.md, "The item"): read, correct, then approve. */}
              <ReadOnlyFence readOnly={!mayEdit}>
              <OutputSection
                output={currentOutput}
                itemId={itemId}
                busy={saveOutput.isPending}
                problem={outputProblem}
                onSave={(body) =>
                  saveOutput
                    .mutateAsync({ itemId, body })
                    .then((result) => result.problem === null)
                    .catch(() => false)
                }
                onCancel={() => setOutputProblem(null)}
              />
              </ReadOnlyFence>

              {/* The step's results, with where each sends the item (EO-310). Nothing where nobody decides. */}
              {decision.length > 0 ? (
                <section aria-label="Decide" className="flex min-w-0 flex-col gap-2 rounded-[14px] bg-paused/12 px-[18px] py-3.5">
                  <span className="text-[12px] text-paused">
                    {authority !== null && authority.you !== "holder" ? `This step waits on ${authority.group.name}` : "This step is yours"} ·{" "}
                    {current?.name ?? item.stepName}
                  </span>
                  <DecisionButtons itemId={itemId} decision={decision} adminControl={false} onDecided={invalidate} />
                </section>
              ) : null}
            </article>

            <aside aria-label="About" className="flex min-w-0 flex-col gap-3 @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1 @4xl:self-start">
              <Card>
                <GroupLabel>About</GroupLabel>
                <Facts
                  items={[
                    { term: "Status", value: current?.name ?? item.stepName },
                    { term: "Pipeline", value: item.pipelineId === null ? "—" : pipelineName === "Pipeline" ? item.pipelineId : pipelineName },
                    ...(item.repositoryName ? [{ term: "Repository", value: item.repositoryName }] : []),
                    ...(branch ? [{ term: "Branch", value: <span className="font-mono text-[12px]">{branch}</span> }] : []),
                    // Which job made it, said as the original design says it: "From: job ‘Monday
                    // report’".
                    ...(item.origin ? [{ term: "From", value: `${describeItemOriginKind(item.origin.trigger)} “${item.origin.jobName}”` }] : []),
                    { term: "Created", value: new Date(item.createdAt).toLocaleDateString() },
                    { term: "Updated", value: new Date(item.updatedAt).toLocaleDateString() },
                  ]}
                />

                {/* The outside issue its work is filed under (EO-637), on every item. */}
                <ReferenceField
                  key={item.git.reference ?? "none"}
                  own={item.git.reference ?? null}
                  // Absent from a detail answered by a main process that predates it.
                  reference={item.reference ?? null}
                  busy={editReference.isPending}
                  problem={referenceProblem}
                  onSave={(next) => {
                    setReferenceProblem(null);
                    editReference.mutate({ itemId, reference: next });
                  }}
                  onCancel={() => setReferenceProblem(null)}
                />

                {/* Only where the repository names a Jira site (EO-126). */}
                {item.jiraConnected ? (
                  <JiraLink
                    key={item.jiraKey ?? "unattached"}
                    jiraKey={item.jiraKey}
                    jiraSync={item.jiraSync}
                    isContainer={item.container}
                    busy={editJira.isPending}
                    problem={jiraProblem}
                    onLink={(next) => {
                      setJiraProblem(null);
                      editJira.mutate({ itemId, jiraKey: next });
                    }}
                    onSync={(enabled) => {
                      setJiraProblem(null);
                      editJira.mutate({ itemId, jiraSync: enabled });
                    }}
                    onCancel={() => setJiraProblem(null)}
                  />
                ) : null}

                {latestRun ? (
                  <section aria-label="Run" className="flex min-w-0 flex-col gap-1.5 border-t border-line/60 pt-3 text-[12.5px]">
                    <GroupLabel>Run</GroupLabel>
                    <p className="text-ink-muted">
                      {/* A built-in run has no agent: EO did the work. */}
                      {latestRun.agentId === null ? "EO" : (agentNames.get(latestRun.agentId) ?? latestRun.agentId)} · {spoken(latestRun.status)}
                    </p>
                    {/* What the workspace checked, with a mark each (EO-312): a verdict alone says nothing about what was looked at. */}
                    {latestRun.checks.length > 0 ? (
                      <ul aria-label="Checks" className="flex flex-col gap-1">
                        {latestRun.checks.map((check) => (
                          <li key={check.key} className="flex items-start gap-1.5 text-ink-muted">
                            <span aria-hidden className="pt-0.5">
                              {check.passed ? <Check size={12} className="text-running" /> : <X size={12} className="text-danger" />}
                            </span>
                            <span className="sr-only">{check.passed ? "Passed:" : "Failed:"}</span>
                            <span className="min-w-0">{check.describes}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <Link to={`/items/${itemId}/runs`} className="text-accent-soft hover:underline">
                      View run details
                    </Link>
                  </section>
                ) : null}
              </Card>

              {/* A container's memory (EO-596): what the items filed under it share while its work is in progress. The type's flag, never its word. */}
              {item.container && item.projectId !== null ? (
                <Card>
                  <MemoryPanel scope={{ kind: "container", id: item.id }} name={item.title} />
                </Card>
              ) : null}
            </aside>

            <div className="flex min-w-0 flex-col gap-3 @4xl:col-start-1 @4xl:row-start-2">
              <Card label="Timeline">
                <GroupLabel>Thread</GroupLabel>
                {timeline.length === 0 ? <p className="text-[12.5px] text-ink-subtle">Nothing has been said here yet.</p> : null}
                <div className="flex min-w-0 flex-col gap-2.5">
                  {earlier.remaining > 0 ? (
                    // Not a `<button>`, for CollapsibleMarkdown's reason:
                    // reading back is reading, and the page's read-only
                    // fence disables every real form control inside it.
                    <div
                      role="button"
                      tabIndex={0}
                      aria-disabled={earlier.loading}
                      aria-busy={earlier.loading}
                      onClick={earlier.load}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        // Space would otherwise scroll the page.
                        event.preventDefault();
                        earlier.load();
                      }}
                      className={cn(
                        "cursor-pointer select-none self-center rounded-[10px] px-3 py-1.5 text-[12px] text-ink-subtle hover:bg-canvas-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                        earlier.loading && "pointer-events-none opacity-60",
                      )}
                    >
                      {earlier.loading ? "Reading earlier comments…" : `Show earlier comments (${earlier.remaining})`}
                    </div>
                  ) : null}
                  {earlier.problem ? (
                    <ErrorLine>
                      <RefText>{earlier.problem}</RefText>
                    </ErrorLine>
                  ) : null}
                  {timeline.map((entry) =>
                    entry.kind === "transition" ? (
                      // Not a comment: a state change is not something anybody said.
                      <div key={`t-${entry.transition.id}`} className="flex min-w-0 items-baseline gap-2 px-1 text-[11.5px] text-ink-subtle">
                        <span aria-hidden className="h-[7px] w-[7px] shrink-0 translate-y-[-1px] rounded-full border border-line-strong" />
                        <span className="min-w-0 flex-1">
                          {entry.transition.fromStepId ? `${stepName(entry.transition.fromStepId)} → ` : ""}
                          <span className="text-ink-muted">{stepName(entry.transition.toStepId)}</span> by {describeActor(entry.transition.actor, agentNames)}
                          {entry.transition.reason ? (
                            <>
                              {" — "}
                              <RefText>{entry.transition.reason}</RefText>
                            </>
                          ) : null}
                        </span>
                        <span className="shrink-0">{when(entry.at)}</span>
                      </div>
                    ) : (
                      <CommentThread
                        key={entry.comment.id}
                        comment={entry.comment}
                        replies={entry.replies}
                        mentionables={mentionables}
                        busy={posts.pending.has(entry.comment.id)}
                        readOnly={readOnly}
                        pinning={pinsIn(pins.pending, entry.comment, entry.replies)}
                        onTogglePin={togglePin}
                        onDelete={askToDelete}
                        onReply={reply}
                      />
                    ),
                  )}
                </div>
              </Card>

              {/* The thread's own box, which knows when an agent is working (EO-176). */}
              <RunComposer
                live={liveRunOf(latestRun)}
                mentionables={mentionables}
                // Busy while anything posted from this page is still on its way.
                busy={posts.pending.size > 0}
                readOnly={readOnly}
                submitLabel="Comment"
                onSubmit={async (body, mentions, attachmentIds, delivery) => {
                  const result = await posts.send(null, () =>
                    post.mutateAsync({
                      itemId,
                      body,
                      mentions,
                      attachmentIds,
                      pinned: false,
                      parentId: null,
                      ...(delivery === undefined ? {} : { delivery }),
                    }),
                  );
                  return result.delivery;
                }}
              />
            </div>
          </div>
        </div>

        {confirmingDelete ? (
          <ConfirmDeleteItem
            target={{
              key: item.key,
              title: item.title,
              container: item.container,
              jiraKey: item.jiraKey,
              childCount: (allItems.data?.items ?? []).filter((entry) => entry.parentId === item.id).length,
              runCount: detail.data.runs.length,
              costCents,
            }}
            // A key with no URL behind it means the connection is gone.
            jiraConnected={item.jiraUrl !== null}
            busy={remove.isPending}
            refusal={refusal}
            leftover={leftover}
            onCancel={() => {
              setConfirmingDelete(false);
              setRefusal(null);
              // Dismissing the leftover report is what leaves: the item is gone.
              if (leftover.length > 0) {
                setLeftover([]);
                void navigate("/");
              }
            }}
            onConfirm={(extra) => remove.mutate({ itemId, cancelActiveRun: false, deleteInJira: false, discardUncommitted: false, ...extra })}
          />
        ) : null}

        {deleting ? (
          <ConfirmDeleteComment
            target={{
              authorName: deleting.comment.authorName,
              excerpt: excerpt(deleting.comment.body),
              replyCount: deleting.replies.length,
              // The replies go too, so any of them in Jira is reason to ask.
              mirrored: deleting.comment.mirroredInJira || deleting.replies.some((reply) => reply.mirroredInJira),
              jiraKey: item.jiraKey,
            }}
            busy={removeComment.isPending}
            onCancel={() => setDeleting(null)}
            onConfirm={(extra) => removeComment.mutate({ commentId: deleting.comment.id, deleteInJira: true, ...extra })}
          />
        ) : null}
      </ReadOnlyFence>
    </div>
  );
}

const NO_PINS: ReadonlyMap<string, boolean> = new Map();

/**
 * The pins in flight, for a thread with one of them in it, and one empty
 * map for every other thread — so pinning a comment redraws its own
 * thread and no other (EO-565).
 */
function pinsIn(pending: ReadonlyMap<string, boolean>, comment: CommentView, replies: readonly CommentView[]): ReadonlyMap<string, boolean> {
  if (pending.size === 0) return NO_PINS;
  return pending.has(comment.id) || replies.some((reply) => pending.has(reply.id)) ? pending : NO_PINS;
}
