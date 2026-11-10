import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AtSign, BellOff, Clock, GitBranch, GitPullRequest, HelpCircle, Inbox, MessageSquare, UserCheck } from "lucide-react";
import { answerOptions, matchesInboxFilter, waitingOnLabel, type ChromeVocabulary, type InboxItem, type IpcRequest, type Message, type ViewFilter } from "@eo/core";
import { Markdown, cn } from "@eo/ui";
import { inboxViewFilter } from "../../../shared/inbox/inbox";
import { PREVIEW_BANNER } from "../../../shared/items/previewBanner";
import { ipcQuery } from "../../../query/client";
import { inboxKey, itemsKey, settingsKey, useChromeVocabulary } from "../../../query/hooks";
import { useInFlight } from "../../../query/useInFlight";
import { useInvalidateOnPush } from "../../../query/useInvalidateOnPush";
import { useViewParameters } from "../../../shared/view/ViewPublisher";
import { Button, Card, Chip, EmptyState, ErrorLine, Facts, GroupLabel, Loading, Notice, SearchInput, StatusDot, Tabs, TextArea, ViewHeader, VirtualRows } from "../../kit";
import { CommentActions } from "../../CommentActions";
import { ItemKeyLink, ItemText, age } from "./references";

/**
 * The filters, and the distinction the design insists on keeping straight: a
 * mention does not by itself block an item; an item is blocked because
 * its run *ended awaiting a reply*. Blocking comes from the run
 * (`InboxItem.blocking`), never from the mention row.
 */
type Filter = "all" | "blocking" | "mentions" | "fyi" | "unassigned";

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "blocking", label: "Blocking" },
  { value: "mentions", label: "Mentions" },
  { value: "fyi", label: "FYI" },
  { value: "unassigned", label: "Unassigned" },
];

/**
 * One row of the list: a question on an item, or a message EO sent you
 * about no item (EO-725, ARCHITECTURE.md §7.1). Both are waiting on you and
 * are listed together, newest first; only an item question has an item to
 * open and a thread to reply on.
 */
type Row = { kind: "item"; id: string; createdAt: number; item: InboxItem } | { kind: "message"; id: string; createdAt: number; message: Message };

/**
 * Whether a row survives the tab and the search box. A message is under
 * All only: Blocking, Mentions, FYI and Unassigned are about an item's
 * run and step, and a message has neither.
 */
function rowMatches(row: Row, view: ViewFilter): boolean {
  if (row.kind === "item") return matchesInboxFilter(row.item, view);
  if ((view.facets["category"] ?? "all") !== "all") return false;
  const needle = view.text.trim().toLowerCase();
  return needle === "" || row.message.body.toLowerCase().includes(needle);
}

function matches(row: Row, filter: Filter): boolean {
  return rowMatches(row, inboxViewFilter(filter));
}

/** The round glyph in front of each row, by what the comment is. Amber only when a run is stopped on it. */
function KindIcon({ item }: { item: InboxItem }) {
  const Icon =
    item.kind === "question" ? HelpCircle : item.kind === "approval" ? UserCheck : item.kind === "rejection" ? GitBranch : item.kind === "decision" ? GitPullRequest : AtSign;
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg",
        item.blocking ? "bg-paused/15 text-paused" : "bg-canvas-raised text-ink-subtle",
      )}
    >
      <Icon size={13} />
    </span>
  );
}

/**
 * The one sentence a preview says (EO-313, ARCHITECTURE.md, "Preview"), on a row of its own:
 * persistent, never dismissible, in the paused scale because nothing is
 * wrong and nothing is asked — it is only not what it appears to be.
 */
function PreviewMark() {
  return (
    <div role="note" aria-label="Preview" className="relative z-10 mb-1 rounded-[7px] bg-paused/15 px-2 py-0.5 text-[11px] text-paused">
      <span>{PREVIEW_BANNER}</span>
    </div>
  );
}

/**
 * `/inbox`: every pipeline's questions in one list, answered in place.
 *
 * The same record, filters and publication as the classic inbox — the
 * tab and the search box are the filter the assistant is told about, and
 * the row on screen is the selection — drawn as the chat layout draws a
 * list beside a conversation: the rows above, the open one below them
 * when the canvas is narrow, beside them when it is wide.
 */
export function InboxView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inbox = useQuery({ queryKey: inboxKey, queryFn: () => ipcQuery("inbox:list", undefined) });
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => ipcQuery("settings:get", undefined) });
  const vocabulary = useChromeVocabulary();

  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Picking a row brings its detail into sight: on a narrow canvas the
  // detail sits under the whole list, and a pick that changed nothing
  // visible would look like it did nothing.
  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedId !== null) detail.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  useInvalidateOnPush("items:changed", inboxKey);
  useInvalidateOnPush("runs:changed", inboxKey);
  useInvalidateOnPush("messages:changed", inboxKey);

  const reply = useMutation({
    mutationFn: (input: IpcRequest<"comments:post">) => ipcQuery("comments:post", input),
    // Settles once the inbox has been read again (EO-562): until then the
    // answered row is still on the list, and must not take a second reply.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: itemsKey });
      return queryClient.invalidateQueries({ queryKey: inboxKey });
    },
  });
  // Which rows have an answer on its way, by the comment answered: that
  // row waits, and any other can still be answered.
  const answering = useInFlight<string>();
  // A message is answered or dismissed through its own channel (EO-725):
  // it has no item, so there is no comment to post. Settles once the
  // inbox has been read again, for the reply's reason above.
  const handleMessage = useMutation({
    mutationFn: (input: { messageId: string; answer: string | null }) =>
      input.answer === null ? ipcQuery("messages:dismiss", { messageId: input.messageId }) : ipcQuery("messages:answer", { messageId: input.messageId, answer: input.answer }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inboxKey }),
  });
  const setDnd = useMutation({
    mutationFn: (input: IpcRequest<"settings:set">) => ipcQuery("settings:set", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
  });

  const rows = useMemo<Row[]>(
    () => [
      ...(inbox.data?.items ?? []).map((item): Row => ({ kind: "item", id: item.commentId, createdAt: item.createdAt, item })),
      // Absent from an answer written before messages existed — a mocked one, say.
      ...(inbox.data?.messages ?? []).map((message): Row => ({ kind: "message", id: message.id, createdAt: message.createdAt, message })),
    ],
    [inbox.data],
  );
  // Newest first; the oldest unanswered is called out on its own line.
  const sorted = useMemo(() => [...rows].sort((a, b) => b.createdAt - a.createdAt), [rows]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(({ value }) => [value, value === "all" ? rows.length : rows.filter((row) => matches(row, value)).length])) as Record<Filter, number>,
    [rows],
  );
  const visible = useMemo(() => {
    const view = inboxViewFilter(filter, search);
    return sorted.filter((row) => rowMatches(row, view));
  }, [sorted, filter, search]);

  // The *effective* selection (EO-192): nothing clicked shows the first
  // row, so that row is the one reported — ids only.
  const highlighted = visible.find((row) => row.id === selectedId) ?? visible[0];
  useViewParameters({
    filter: inboxViewFilter(filter, search),
    selection: highlighted === undefined ? [] : [highlighted.id],
  });

  const summary = inbox.data?.summary;
  const doNotDisturb = settings.data?.doNotDisturb ?? false;

  const header = (
    <ViewHeader
      icon={<Inbox size={15} />}
      title="Inbox"
      meta="Every question an agent is waiting on, from every pipeline."
      actions={
        <>
          {summary && summary.openCount > 0 ? <Chip tone="paused">{summary.openCount} open</Chip> : null}
          <Button size="sm" variant="ghost" icon={<BellOff size={12} />} aria-pressed={doNotDisturb} onClick={() => setDnd.mutate({ doNotDisturb: !doNotDisturb })}>
            {doNotDisturb ? "Do Not Disturb on" : "Do Not Disturb off"}
          </Button>
        </>
      }
    />
  );

  if (inbox.isLoading) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (inbox.error) {
    return (
      <>
        {header}
        <ErrorLine>
          <ItemText>{inbox.error.message}</ItemText>
        </ErrorLine>
      </>
    );
  }

  const oldest = sorted.at(-1);
  const dayOf = (ts: number) => new Date(ts).toDateString();
  const today = dayOf(Date.now());

  return (
    <div className="flex min-w-0 flex-col">
      {header}

      {summary?.everythingBlocked ? (
        // Worth saying out loud: an idle pipeline looks identical to a
        // finished one, and nothing will move until somebody answers.
        <div className="mb-4">
          <Notice tone="paused" role="status" title="Everything is waiting on you.">
            No {vocabulary.item.toLowerCase()} can move until you answer below — the agents have nothing else to work on.
          </Notice>
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState title="Nothing needs you.">The agents will ask here when they get stuck.</EmptyState>
      ) : (
        <div className="@container">
          <div className="grid min-w-0 grid-cols-1 gap-4 @3xl:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]">
            <Card className="gap-2.5 px-2.5 py-3" label="Waiting">
              <div className="px-1">
                <Tabs
                  label="Filter"
                  value={filter}
                  onChange={setFilter}
                  tabs={FILTERS.map(({ value, label }) => ({ value, label, count: counts[value] }))}
                />
              </div>
              <SearchInput label="Filter inbox" value={search} onChange={setSearch} className="mx-1" />

              {/* A screenful at a time (EO-565). */}
              <VirtualRows label="Waiting" data={visible} rowKey={(row) => row.id} className="flex min-w-0 flex-col [&>li+li]:pt-0.5">
                {(row, index) => {
                  const day = dayOf(row.createdAt);
                  const firstOfDay = index === 0 || dayOf(visible[index - 1]!.createdAt) !== day;
                  const on = highlighted?.id === row.id;
                  return (
                    <>
                      {firstOfDay ? (
                        <div className="px-2 pb-1 pt-2">
                          <GroupLabel>{day === today ? "Today" : "Earlier"}</GroupLabel>
                        </div>
                      ) : null}
                      {row.kind === "item" ? (
                        <InboxRow
                          item={row.item}
                          on={on}
                          mixed={vocabulary.mixed}
                          answering={answering.pending.has(row.id)}
                          onSelect={() => setSelectedId(row.id)}
                        />
                      ) : (
                        <MessageRow message={row.message} on={on} answering={answering.pending.has(row.id)} onSelect={() => setSelectedId(row.id)} />
                      )}
                    </>
                  );
                }}
              </VirtualRows>
              {visible.length === 0 ? <p className="px-2 py-2 text-[12.5px] text-ink-subtle">Nothing under this filter.</p> : null}

              {sorted.length > 1 && oldest ? (
                <p className="flex items-center gap-1.5 border-t border-line/60 px-2 pt-2 text-[11.5px] text-ink-subtle">
                  <Clock size={12} />
                  Oldest unanswered: {oldest.kind === "item" ? <ItemKeyLink itemKey={oldest.item.itemKey} /> : "a message from EO"}, {age(oldest.createdAt)}
                </p>
              ) : null}
            </Card>

            {highlighted ? (
              <div ref={detail} className="min-w-0 @3xl:sticky @3xl:top-0 @3xl:self-start">
                {highlighted.kind === "item" ? (
                  <InboxDetail
                    key={highlighted.id}
                    item={highlighted.item}
                    vocabulary={vocabulary}
                    busy={answering.pending.has(highlighted.id)}
                    onOpenItem={(itemId) => void navigate(`/items/${itemId}`)}
                    // Filed under the comment being answered (D-05): one
                    // question at a time, so the answer has a parent.
                    onReply={(body) =>
                      answering.run(highlighted.id, true, () =>
                        reply.mutateAsync({ itemId: highlighted.item.itemId, body, mentions: [], pinned: false, parentId: highlighted.id }),
                      )
                    }
                  />
                ) : (
                  <MessageDetail
                    key={highlighted.id}
                    message={highlighted.message}
                    busy={answering.pending.has(highlighted.id)}
                    onHandle={(answer) => answering.run(highlighted.id, true, () => handleMessage.mutateAsync({ messageId: highlighted.id, answer }))}
                  />
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One row: a button laid over the whole of it selects it, and the keys
 * drawn on it are links above that button, so following one never
 * selects the row it is on.
 */
function InboxRow({
  item,
  on,
  mixed,
  answering,
  onSelect,
}: {
  item: InboxItem;
  on: boolean;
  mixed: boolean;
  /** Answered, and the inbox not yet read again (EO-562): drawn as on its way, and closed to another answer. */
  answering: boolean;
  onSelect: () => void;
}) {
  return (
    <div className={cn("relative rounded-[10px] px-2.5 py-2", on ? "bg-canvas-raised" : "hover:bg-canvas-subtle", answering && "opacity-60")}>
      <button
        type="button"
        aria-label={`Select ${item.itemKey}: ${item.itemTitle}`}
        aria-current={on}
        aria-busy={answering}
        onClick={onSelect}
        className="absolute inset-0 rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      />
      {item.preview ? <PreviewMark /> : null}
      <div className="pointer-events-none relative flex min-w-0 items-start gap-2.5">
        <KindIcon item={item} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{item.itemTitle}</span>
            <span className="ml-auto shrink-0 text-[11px] text-ink-subtle">{answering ? "Sending reply…" : age(item.createdAt)}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-ink-subtle">
            <ItemKeyLink itemKey={item.itemKey} />
            {/* Which kind of thing is waiting, where the project has more than one word for it (EO-309, ARCHITECTURE.md, "What a pack labels"). */}
            {mixed ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{item.itemTypeLabel}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span className="truncate">{item.authorName}</span>
            {/* ARCHITECTURE.md, "The inbox, the archive and jobs": "Waiting on you", "Waiting on Anna", or "Unclaimed". */}
            <span aria-hidden>·</span>
            <span className="truncate">{waitingOnLabel(item.waitingOn)}</span>
            {item.blocking ? (
              <span className="ml-auto">
                <StatusDot tone="paused" label="Blocking" />
              </span>
            ) : null}
          </div>
          <span className="line-clamp-1 text-[12.5px] text-ink-muted">
            <ItemText>{item.body.replace(/\s+/g, " ")}</ItemText>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A message's first line: what a row and a title can show of it. */
function firstLine(body: string): string {
  return body.split("\n").find((line) => line.trim() !== "")?.replace(/^#+\s*/, "").trim() ?? "";
}

/** A message from EO, as a row: no item, no step, no `!` — EO is asking you something. */
function MessageRow({ message, on, answering, onSelect }: { message: Message; on: boolean; answering: boolean; onSelect: () => void }) {
  const title = firstLine(message.body);
  return (
    <div className={cn("relative rounded-[10px] px-2.5 py-2", on ? "bg-canvas-raised" : "hover:bg-canvas-subtle", answering && "opacity-60")}>
      <button
        type="button"
        aria-label={`Select message from EO: ${title}`}
        aria-current={on}
        aria-busy={answering}
        onClick={onSelect}
        className="absolute inset-0 rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      />
      <div className="pointer-events-none relative flex min-w-0 items-start gap-2.5">
        <span aria-hidden className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-canvas-raised text-ink-subtle">
          <MessageSquare size={13} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-ink">{title}</span>
            <span className="ml-auto shrink-0 text-[11px] text-ink-subtle">{answering ? "Sending…" : age(message.createdAt)}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-ink-subtle">
            <span className="truncate">Message from EO</span>
            <span aria-hidden>·</span>
            <span className="truncate">Waiting on you</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A message from EO, open (EO-725): what it says, its actions, its
 * answers — one press each, since there is no thread to add guidance to —
 * and Dismiss, which closes it without answering.
 */
function MessageDetail({ message, busy, onHandle }: { message: Message; busy: boolean; onHandle: (answer: string | null) => Promise<unknown> }) {
  const [problem, setProblem] = useState<string | null>(null);
  const answers = answerOptions(message.options);

  async function handle(answer: string | null) {
    if (busy) return;
    setProblem(null);
    try {
      await onHandle(answer);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Card label="Message from EO" className="gap-3.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip>message</Chip>
        <span className="ml-auto text-[11.5px] text-ink-subtle">{age(message.createdAt)}</span>
      </div>
      <h2 className="text-[16px] font-semibold text-ink">Message from EO</h2>

      <blockquote className="rounded-[12px] bg-canvas-subtle px-3.5 py-2.5 text-[13px] leading-relaxed text-ink">
        <Markdown>{message.body}</Markdown>
      </blockquote>

      {/* The message's id places the chat as a pressed notice's comment did (EO-727). */}
      <CommentActions options={message.options} commentId={message.id} />

      {answers.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answers">
          {answers.map((answer) => (
            <Button key={answer} size="sm" variant="secondary" disabled={busy} onClick={() => void handle(answer)}>
              {answer}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" className="ml-auto" disabled={busy} onClick={() => void handle(null)}>
          {busy ? "Sending…" : "Dismiss"}
        </Button>
      </div>

      {problem ? (
        <ErrorLine>
          <ItemText>{problem}</ItemText>
        </ErrorLine>
      ) : null}
    </Card>
  );
}

function InboxDetail({
  item,
  vocabulary,
  busy,
  onReply,
  onOpenItem,
}: {
  item: InboxItem;
  vocabulary: ChromeVocabulary;
  busy: boolean;
  onReply: (body: string) => Promise<unknown>;
  onOpenItem: (itemId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const replyId = useId();

  /** Clears only once the reply has landed: a failed send keeps what was typed. */
  async function send(body: string) {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setProblem(null);
    try {
      await onReply(trimmed);
      setDraft("");
      setChosen(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  // The answers a reply can pick from. An action (EO-533) opens something
  // instead, and is drawn on its own above the reply.
  const answers = answerOptions(item.options);
  const hasOptions = answers.length > 0;
  /** An offered option answers on its own; free text is the fallback or an addition to it. */
  const outgoing = () => (chosen ? `${chosen}\n\n${draft}`.trim() : draft);
  const word = vocabulary.item.toLowerCase();

  return (
    <Card label={item.itemTitle} className="gap-3.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {item.blocking ? <Chip tone="paused">blocking</Chip> : <Chip>FYI</Chip>}
        <ItemKeyLink itemKey={item.itemKey} className="text-[11.5px] text-ink-subtle" />
        <span className="ml-auto text-[11.5px] text-ink-subtle">{age(item.createdAt)}</span>
      </div>
      <h2 className="text-[16px] font-semibold text-ink">{item.itemTitle}</h2>
      <p className="text-[12.5px] text-ink-subtle">
        From <span className="text-ink-muted">{item.authorName}</span>
      </p>

      {/* Quoted, so it reads as theirs rather than as the view's own prose. */}
      <blockquote className="rounded-[12px] bg-canvas-subtle px-3.5 py-2.5 text-[13px] leading-relaxed text-ink">
        <Markdown>{item.body}</Markdown>
      </blockquote>

      <Facts
        label={`${vocabulary.item} context`}
        items={[
          {
            term: "Why",
            value: item.blocking
              ? `This ${word}'s run ended waiting for your reply. Nothing on it moves until you answer.`
              : "Nothing is held up — this is for your information.",
          },
          { term: "Step", value: item.itemState },
          { term: "Elapsed", value: age(item.createdAt) },
        ]}
      />

      <CommentActions options={item.options} commentId={item.commentId} />

      {hasOptions ? (
        <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
          <legend className="pb-1.5 text-[12px] font-medium text-ink-muted">Choose a response</legend>
          {answers.map((option) => {
            const on = chosen === option;
            return (
              <div key={option} className="relative">
                <button
                  type="button"
                  aria-label={option}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => setChosen(option)}
                  className={cn(
                    "absolute inset-0 rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:pointer-events-none",
                    on ? "bg-accent" : "bg-canvas-raised hover:bg-canvas-hover",
                  )}
                />
                <span
                  className={cn(
                    "pointer-events-none relative flex min-h-8 items-center px-3 py-1.5 text-[13px]",
                    on ? "text-accent-ink" : "text-ink",
                    busy && "opacity-50",
                  )}
                >
                  <span>
                    <ItemText>{option}</ItemText>
                  </span>
                </span>
              </div>
            );
          })}
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-1 text-[12px] font-medium text-ink-muted">
          <label htmlFor={replyId}>{hasOptions ? `Add guidance for ${item.authorName} (optional)` : "Reply to"}</label>
          {!hasOptions ? <ItemKeyLink itemKey={item.itemKey} /> : null}
        </div>
        <TextArea
          id={replyId}
          aria-label={hasOptions ? `Add guidance for ${item.itemKey}` : `Reply to ${item.itemKey}`}
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send(outgoing());
            }
          }}
          placeholder={hasOptions ? "Add guidance…" : "Reply… ⌘↵ to send"}
          disabled={busy}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || (chosen === null && draft.trim() === "")} onClick={() => void send(outgoing())}>
          {busy ? "Sending…" : "Reply and resume"}
        </Button>
        <Button variant="ghost" className="ml-auto" onClick={() => onOpenItem(item.itemId)}>
          Open {word}
        </Button>
      </div>

      {problem ? (
        <ErrorLine>
          <ItemText>{problem}</ItemText>
        </ErrorLine>
      ) : null}
    </Card>
  );
}
