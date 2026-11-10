import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useNavigate } from "react-router-dom";
import { Check, ChevronDown, Inbox, LoaderCircle, Pause, Play, Plus, Search, Settings } from "lucide-react";
import { CHAT_HOME_ROUTE, type IpcResponse } from "@eo/core";
import { cn } from "@eo/ui";
import { assistRoomKey, assistThreadsKey } from "../shared/assist/useAssistRoom";
import { pipelineIcon, places } from "../shared/layout/sidebar";
import { ipcQuery } from "../query/client";
import { engineStatusKey } from "../query/engine";
import { isDispatchable } from "@eo/core";
import { agentsKey, jobsKey, useChromeVocabulary, useMe, usePipelines, useProjectItems } from "../query/hooks";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";
import { useProjects } from "../query/useRepositories";
import { ConfirmDialog, ContextMenu, contextMenuAt, isContextMenuKey, StatusDot, type ContextMenuAt } from "./kit";
import { DEEP, GroupLabel, WaitingCount, useWaitingOnYou, withArticle } from "./parts";
import { CONTROLS_START, useTitleBar } from "./windowChrome";

/** One row of the rail: a glyph, a name, and whatever trails it. */
const ROW = "flex h-[30px] items-center gap-[9px] overflow-hidden whitespace-nowrap rounded-[10px] px-2.5 text-[13px]";
const rowTone = (active: boolean) => (active ? "bg-canvas-raised text-ink" : "text-ink-muted hover:bg-canvas-subtle");

/**
 * The chat layout's rail (ARCHITECTURE.md, "The chat-centric layout").
 *
 * Top to bottom: the project, a new conversation, search, what is waiting
 * on you, the conversation, and the project's pipelines with what each
 * holds. Every pipeline the project has is listed, whoever made it — the
 * rail reads `pipelines:list` and nothing else, so a template from the
 * gallery and a pipeline drawn last week are the same row.
 *
 * The places the mockup has no row for — items, agents and the rest —
 * are behind the gear at the bottom, beside who you are.
 */
export function ChatRail({ onNewPipeline }: { onNewPipeline: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { active, projects, activeProjectId, setActive, switchingTo } = useProjects();
  const switchingName = switchingTo === null ? null : (projects.find((project) => project.id === switchingTo)?.name ?? null);
  const projectId = active?.id ?? null;
  const { pipelines } = usePipelines(projectId);
  const { items } = useProjectItems();
  const { person: me } = useMe();

  // Kept live by `useWaitingOnYou` itself, the same cache entry as the top bar's bell.
  const { blocking: parked, messages } = useWaitingOnYou();
  // Parked runs and EO's open messages: both need you before anything moves.
  const blocking = parked + messages;

  const jobs = useQuery({ queryKey: jobsKey(projectId), queryFn: () => ipcQuery("jobs:list", { projectId }) });
  const hasJobs = (jobs.data?.jobs ?? []).length > 0;

  // Added up from what the main process said about each item — the
  // needs-attention flag is derived there (invariant 6), never here, and
  // so is whether the step an item stands on is terminal (EO-384): a
  // step's name is not evidence of either. Each item counts on the
  // pipeline it is on now, as planned until it reaches a terminal step
  // and as finished from then until the archive sweep takes it.
  const counts = useMemo(() => {
    const byPipeline = new Map<string, { planned: number; finished: number; attention: number }>();
    for (const item of items) {
      if (item.pipelineId === null) continue;
      const entry = byPipeline.get(item.pipelineId) ?? { planned: 0, finished: 0, attention: 0 };
      if (item.atTerminalStep) entry.finished += 1;
      else entry.planned += 1;
      if (item.needsAttention) entry.attention += 1;
      byPipeline.set(item.pipelineId, entry);
    }
    return byPipeline;
  }, [items]);

  // Why the last thing pressed here did not happen, in the main process's words.
  const [problem, setProblem] = useState<string | null>(null);
  const report = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error));

  // Whether there is an assistant to start a chat with: the same predicate
  // the room itself opens on (`useAssistRoom`).
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined) });
  const assistant = (agents.data?.agents ?? []).some((agent) => agent.role === "system" && isDispatchable(agent));

  // A new chat is another chat, not this one put away (EO-391): the one
  // that was open stays open in the list below, and a turn running in it
  // runs on. It was `assist:clear` while there could be one live thread.
  const newChat = useMutation({
    mutationFn: () => ipcQuery("assist:new", undefined),
    onSuccess: (result) => {
      setProblem(null);
      queryClient.setQueryData(assistRoomKey, result);
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
      void navigate(CHAT_HOME_ROUTE);
    },
    onError: report,
  });

  const [switching, setSwitching] = useState(false);
  const [searching, setSearching] = useState(false);
  const titleBar = useTitleBar();

  return (
    <nav aria-label="Main" data-tour="rail" className={cn("relative flex w-[250px] shrink-0 flex-col gap-px overflow-y-auto border-r border-line px-2.5 pb-3.5 pt-1", DEEP)}>
      {/* The top of the rail is the title bar's left end (EO-668): on macOS
          the traffic lights sit in this inset (`mainWindowChrome` puts
          them there), and everywhere it is a handle that moves the
          window. Not drawn where there is no title bar — full screen, or
          a browser tab. */}
      {titleBar ? <div className="app-drag h-6 shrink-0" /> : null}

      {/* Clear of window controls a Linux desktop puts at the top left. */}
      <div className="app-drag relative px-2 pb-3 pt-0.5" style={titleBar ? { paddingLeft: `calc(0.5rem + ${CONTROLS_START})` } : undefined}>
        <button
          type="button"
          aria-label="Switch project"
          aria-expanded={switching}
          aria-busy={switchingTo !== null}
          onClick={() => setSwitching((open) => !open)}
          className="flex max-w-full items-center gap-2 rounded-md text-[14px] font-semibold"
        >
          <span className="text-[17px] font-bold tracking-[-0.02em] text-ink">EO</span>
          <span className="truncate font-medium text-ink-muted">{switchingName ?? active?.name ?? "No project"}</span>
          {switchingTo === null ? (
            <ChevronDown size={14} className="shrink-0 text-ink-subtle" />
          ) : (
            <LoaderCircle size={14} aria-hidden className="shrink-0 animate-spin text-ink-subtle" />
          )}
        </button>
        {switching ? (
          <Popover onClose={() => setSwitching(false)} label="Projects" role="dialog">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                aria-current={project.id === activeProjectId}
                onClick={() => {
                  setActive(project.id);
                  setSwitching(false);
                }}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", rowTone(project.id === activeProjectId))}
              >
                <span className="truncate">{project.name}</span>
                {project.id === activeProjectId ? <Check size={13} className="ml-auto shrink-0" /> : null}
              </button>
            ))}
            {projects.length === 0 ? <p className="px-2 py-1.5 text-[13px] text-ink-subtle">No projects yet</p> : null}
          </Popover>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => newChat.mutate()}
        disabled={newChat.isPending || !assistant}
        className="mb-1 flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] bg-canvas-raised px-3 text-[12.5px] font-medium text-ink hover:bg-canvas-hover disabled:opacity-50"
      >
        <Plus size={14} />
        New chat
      </button>

      <div className="relative">
        <button type="button" onClick={() => setSearching(true)} className={cn(ROW, "w-full", rowTone(false))}>
          <Search size={14} className="shrink-0" />
          <span className="flex-1 text-left">Search</span>
          {/* ⌘K on a Mac, Ctrl+K elsewhere, opens it from anywhere in the layout. Spelled out off a Mac, where ^ is not how a key is named. */}
          <span className="font-mono text-[11.5px] text-ink-subtle">{isMac() ? "⌘K" : "Ctrl+K"}</span>
        </button>
        {searching ? <SearchBox onClose={() => setSearching(false)} /> : null}
      </div>
      <SearchShortcut onOpen={() => setSearching(true)} />

      <NavLink to="/inbox" data-tour="waiting" className={({ isActive }) => cn(ROW, "shrink-0", rowTone(isActive))}>
        <Inbox size={14} className="shrink-0" />
        <span className="flex-1 truncate">Waiting on you</span>
        {blocking > 0 ? <WaitingCount count={blocking} label={`${blocking} waiting on you`} /> : null}
      </NavLink>

      <ChatList onProblem={(message) => setProblem(message)} />

      <div className="px-2.5 pb-1.5 pt-3.5">
        <GroupLabel
          trailing={
            // The classic rail's "+" (ARCHITECTURE.md, "The classic layout"): the way in to Jobs
            // for a
            // project that has no job yet.
            <button
              type="button"
              aria-label="New job"
              title="New job"
              onClick={() => void navigate("/jobs")}
              className="grid place-items-center rounded-sm p-0.5 text-ink-subtle hover:bg-canvas-subtle hover:text-ink"
            >
              <Plus size={12} />
            </button>
          }
        >
          Pipelines
        </GroupLabel>
      </div>
      {pipelines.map((pipeline, index) => {
        const Icon = pipelineIcon(pipeline.icon, index);
        const count = counts.get(pipeline.id);
        return (
          <NavLink key={pipeline.id} to={`/pipelines/${pipeline.id}`} className={({ isActive }) => cn(ROW, "shrink-0", rowTone(isActive))}>
            <Icon size={14} className="shrink-0" />
            <span className="flex-1 truncate">{pipeline.name}</span>
            {count && count.attention > 0 ? (
              <WaitingCount count={count.attention} label={`${count.attention} need${count.attention === 1 ? "s" : ""} attention`} />
            ) : count ? (
              <span className="font-mono text-[11px] text-ink-subtle">
                <span aria-hidden>
                  {count.planned}/<span className="text-success">{count.finished}</span>
                </span>
                <span className="sr-only">{`${count.planned} planned, ${count.finished} finished`}</span>
              </span>
            ) : null}
          </NavLink>
        );
      })}
      {hasJobs ? (
        <NavLink to="/jobs" className={({ isActive }) => cn(ROW, "shrink-0", rowTone(isActive))}>
          <span className="w-3.5 shrink-0" />
          <span className="truncate">Jobs</span>
        </NavLink>
      ) : null}
      {/* A pipeline is drawn by saying what it is for (EO-525): this hands
          the person to the conversation, box focused, and creates nothing.
          An empty pipeline opened in an editor was the other way, and the
          editor is gone. */}
      <button type="button" onClick={onNewPipeline} className={cn(ROW, "shrink-0 text-ink-subtle hover:bg-canvas-subtle")}>
        <Plus size={14} className="shrink-0" />
        New pipeline
      </button>

      <div className="flex-1" />
      {problem ? <p className="px-2.5 pb-2 text-xs text-danger">{problem}</p> : null}
      <Footer name={me?.name ?? "you"} />
    </nav>
  );
}

/** What the open chat is called until something is said in it: the room's own name. */
const EMPTY_CHAT = "Assistant";

/** How many earlier chats the rail shows before "Show all". */
const CHATS_SHOWN = 6;

/**
 * The chats: the open ones, in the order the person keeps them in, then
 * the earlier ones, newest first.
 *
 * An open chat stays where it is (EO-438). The one on show is marked in
 * its place rather than drawn above the others, and nothing that happens
 * in a chat moves it: the order is `assist:list`'s, and what changes it
 * is a row pressed and dragged to another place, or Move up and Move
 * down on the row's menu — the way without a pointer, since Enter and
 * Space on a row are how its chat is opened.
 *
 * The one on show is the conversation itself. Any other is shown with
 * `assist:resume`, which is navigation (EO-391): the conversation, the
 * help widget and the assistant's window all follow, and nothing is put
 * away or stopped in the chat left behind. An open chat and an earlier
 * one are two lists because they are two states — an open one may be
 * mid-turn and answers a message as it stands, an earlier one was put
 * away by Clear or by the idle expiry and is made live again by going
 * back to it.
 *
 * What deletes is Remove (EO-390), on the menu a row opens on a
 * right-click and from the keyboard: the chat and everything in it gone
 * for good, after a warning that says so. Removing the one on show
 * leaves a new empty chat.
 *
 * Several go at once from a selection (EO-442), made either way a file
 * list is: Ctrl-click (⌘-click on a Mac) toggles a row and Shift-click
 * takes the range from the last row clicked, within the same list; or
 * Select, which puts a checkbox on every row and makes a click or Space
 * toggle it. Both make one selection, removed behind one warning with
 * one `assist:removeMany`. A plain click outside select mode opens the
 * chat, as ever, and lets the selection go.
 */
function ChatList({ onProblem }: { onProblem: (message: string | null) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const threads = useQuery({ queryKey: assistThreadsKey, queryFn: () => ipcQuery("assist:list", undefined) });
  const [showingAll, setShowingAll] = useState(false);

  // When the list moves: a thread is started, put away or shown (all push
  // `items:changed`, from any window), or the open one gets its first
  // words and so its title. The last is read off the room the
  // conversation already holds — observed, never fetched from here.
  useInvalidateOnPush("items:changed", assistThreadsKey);
  // A chat moved, here or in another window: the one push a move sends (EO-439).
  useInvalidateOnPush("assist:changed", assistThreadsKey);
  // A turn starting or ending in any chat changes its mark.
  useInvalidateOnPush("runs:changed", assistThreadsKey);
  const room = useQuery({ queryKey: assistRoomKey, queryFn: () => ipcQuery("assist:open", undefined), enabled: false });
  const open = room.data?.conversation;
  const titled = open ? `${open.id}:${open.messages.some((message) => message.authorType === "human")}` : null;
  useEffect(() => {
    if (titled !== null) void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
  }, [titled, queryClient]);

  const resume = useMutation({
    mutationFn: (conversationId: string) => ipcQuery("assist:resume", { conversationId }),
    onSuccess: (result) => {
      onProblem(result.problem);
      queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
      // Which row is the current one is the list's to say (EO-438), now
      // that the chat on show is a row of it and not one drawn apart.
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
      void navigate(CHAT_HOME_ROUTE);
    },
    onError: (error: unknown) => onProblem(error instanceof Error ? error.message : String(error)),
  });

  // The order is the main process's (EO-438), and moving a chat is the
  // person's (EO-439). A drop, or Move up or down, draws the new order in
  // the same render, from `placed`; storing it goes on behind. Until the
  // latest move's write answers, `placed` is drawn over whatever the
  // list holds, so that neither a refetch nor an earlier move's reply
  // landing meanwhile can put back an order the person has already
  // left. Only the latest reply is heard, and only to settle: the
  // stored order it answers with takes over from `placed` — the same
  // order when the move was stored, the one there was when it was not.
  const [placed, setPlaced] = useState<string[] | null>(null);
  const latestMove = useRef(0);
  const reorder = useMutation({
    mutationFn: ({ conversationId, index }: { conversationId: string; index: number; move: number }) => ipcQuery("assist:reorder", { conversationId, index }),
    onSuccess: (result, { move }) => {
      if (move !== latestMove.current) return;
      onProblem(result.problem);
      queryClient.setQueryData<IpcResponse<"assist:list">>(assistThreadsKey, { conversations: result.conversations });
      setPlaced(null);
    },
    onError: (error: unknown, { move }) => {
      if (move !== latestMove.current) return;
      onProblem(error instanceof Error ? error.message : String(error));
      setPlaced(null);
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
    },
  });
  // Four pixels of travel before a press is a drag, so a click is still a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Where dnd-kit's own screen-reader text goes: out of the accessibility
  // tree. It is written for its keyboard sensor — "press space to pick
  // up" — which these rows do not have, and it names what moved by id.
  const [unspoken, setUnspoken] = useState<HTMLElement | null>(null);

  // The chat a row's menu is open for, and the one the warning is about.
  const [menu, setMenu] = useState<{ thread: ChatRow; at: ContextMenuAt } | null>(null);
  const [removing, setRemoving] = useState<ChatRow | null>(null);
  const [removeProblem, setRemoveProblem] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (conversationId: string) => ipcQuery("assist:remove", { conversationId }),
    onSuccess: (result) => {
      // Either way the list is not what it was: removed, or refused
      // because the chat had already gone from another window.
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
      if (!result.removed) {
        setRemoveProblem(result.problem);
        return;
      }
      setRemoving(null);
      // The open chat was the one removed: the room is the new empty one, as after New chat.
      if (result.conversation) {
        queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
        void queryClient.invalidateQueries({ queryKey: assistRoomKey });
        void navigate(CHAT_HOME_ROUTE);
      }
    },
    onError: (error: unknown) => setRemoveProblem(error instanceof Error ? error.message : String(error)),
  });

  // The selection (EO-442): which chats, whether Select is on, and the
  // row a Shift-click measures its range from.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [anchor, setAnchor] = useState<{ list: ChatListName; id: string } | null>(null);
  // The chats the one warning is about, and what it says was refused.
  const [removingMany, setRemovingMany] = useState<ChatRow[] | null>(null);
  const [manyProblem, setManyProblem] = useState<ReactNode>(null);

  const endSelection = () => {
    setSelected(new Set());
    setSelecting(false);
    setAnchor(null);
  };

  const removeMany = useMutation({
    mutationFn: (conversationIds: string[]) => ipcQuery("assist:removeMany", { conversationIds }),
    onSuccess: (result, conversationIds) => {
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
      // The chat on show was among them: the room is the one new empty chat, as after New chat.
      if (result.conversation) {
        queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
        void queryClient.invalidateQueries({ queryKey: assistRoomKey });
        void navigate(CHAT_HOME_ROUTE);
      }
      if (result.refused.length === 0) {
        setRemovingMany(null);
        endSelection();
        return;
      }
      // What went is gone from the selection and the warning; what was
      // refused stays in both, each with the reason.
      const refused = new Map(result.refused.map((entry) => [entry.conversationId, entry.problem]));
      setSelected((previous) => new Set([...previous].filter((id) => refused.has(id) || !conversationIds.includes(id))));
      setRemovingMany((rows) => rows?.filter((row) => refused.has(row.id)) ?? null);
      const named = new Map((removingMany ?? []).map((row) => [row.id, row.title]));
      setManyProblem(
        <>
          {result.refused.map((entry) => (
            <span key={entry.conversationId} className="block">
              {`“${named.get(entry.conversationId) ?? "A chat"}” was not removed. ${entry.problem}`}
            </span>
          ))}
        </>,
      );
    },
    onError: (error: unknown) => setManyProblem(error instanceof Error ? error.message : String(error)),
  });

  /**
   * What makes a row open its menu: a right-click, at the pointer, and
   * the context-menu key or Shift+F10 on the focused row, at the row.
   * Nothing else about the row changes — a left click still opens it.
   */
  const menuOn = (thread: ChatRow) => ({
    "aria-haspopup": "menu" as const,
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      setMenu({ thread, at: contextMenuAt(event.currentTarget, event) });
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!isContextMenuKey(event)) return;
      event.preventDefault();
      setMenu({ thread, at: contextMenuAt(event.currentTarget) });
    },
  });

  const all = threads.data?.conversations ?? [];
  const openOnes = arrangedAs(placed, all.filter((thread) => thread.live));
  const earlier = all.filter((thread) => !thread.live);
  const shown = showingAll ? earlier : earlier.slice(0, CHATS_SHOWN);
  // Until the list names the chat on show, the room the conversation
  // holds does: the room's own name, and its menu once there is an id.
  const listed = openOnes.some((thread) => thread.shown);
  const unlisted: ChatRow | null = !listed && open ? { id: open.id, title: EMPTY_CHAT, shown: true, live: true } : null;

  // Each list as rows, in the order drawn: what a range and Select all are counted over.
  const rowOf = (thread: (typeof all)[number]): ChatRow => ({ id: thread.id, title: thread.title, shown: thread.shown, live: thread.live });
  const rowsOf: Record<ChatListName, ChatRow[]> = {
    open: [...(unlisted ? [unlisted] : []), ...openOnes.map(rowOf)],
    earlier: earlier.map(rowOf),
  };
  const byId = new Map([...rowsOf.open, ...rowsOf.earlier].map((row) => [row.id, row]));
  // Only what is still listed counts: a chat removed from another window drops out of the selection.
  const picked = [...rowsOf.open, ...rowsOf.earlier].filter((row) => selected.has(row.id));
  const isPicked = (id: string) => selected.has(id) && byId.has(id);

  const toggle = (list: ChatListName, id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor({ list, id });
  };

  /**
   * What a click on a row does to the selection, and whether that was all
   * it did. True for a modifier click, and for any click in select mode:
   * the row is not opened. False for a plain click, which lets the
   * selection go and opens the chat as it always has.
   */
  const pick = (event: ReactMouseEvent<HTMLElement>, list: ChatListName, id: string): boolean => {
    if (event.shiftKey) {
      const ids = rowsOf[list].map((row) => row.id);
      const from = anchor?.list === list ? ids.indexOf(anchor.id) : -1;
      const to = ids.indexOf(id);
      if (from < 0 || to < 0) {
        toggle(list, id);
        return true;
      }
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
      setSelected((previous) => new Set([...previous, ...range]));
      return true;
    }
    if (event.ctrlKey || event.metaKey || selecting) {
      toggle(list, id);
      return true;
    }
    setSelected(new Set());
    setAnchor({ list, id });
    return false;
  };

  /** Space toggles a row in select mode, where it would otherwise open the chat. */
  const spaceToggles = (event: ReactKeyboardEvent<HTMLElement>, list: ChatListName, id: string): boolean => {
    if (!selecting || event.key !== " " || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    event.preventDefault();
    toggle(list, id);
    return true;
  };

  /** Select all for one list, and again to let that list go. */
  const allOf = (list: ChatListName) => {
    const ids = rowsOf[list].map((row) => row.id);
    const every = ids.length > 0 && ids.every((id) => selected.has(id));
    return {
      every,
      press: () =>
        setSelected((previous) => {
          const next = new Set(previous);
          for (const id of ids) {
            if (every) next.delete(id);
            else next.add(id);
          }
          return next;
        }),
    };
  };

  // Escape lets the selection go, unless something on top of the rail took it first.
  const holding = selecting || picked.length > 0;
  const covered = menu !== null || removing !== null || removingMany !== null;
  useEffect(() => {
    if (!holding || covered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setSelected(new Set());
      setSelecting(false);
      setAnchor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [holding, covered]);

  const warnMany = () => {
    setManyProblem(null);
    setRemovingMany(picked);
  };

  const moveTo = (conversationId: string, index: number) => {
    const from = openOnes.findIndex((thread) => thread.id === conversationId);
    if (from < 0) return;
    onProblem(null);
    setPlaced(arrayMove(openOnes, from, index).map((thread) => thread.id));
    latestMove.current += 1;
    reorder.mutate({ conversationId, index, move: latestMove.current });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const to = over ? openOnes.findIndex((thread) => thread.id === over.id) : -1;
    if (to < 0 || active.id === over?.id) return;
    moveTo(String(active.id), to);
  };

  const opening = (thread: (typeof all)[number]) =>
    resume.isPending && resume.variables === thread.id ? <LoaderCircle size={12} className="shrink-0 animate-spin" aria-label="Opening" /> : null;

  /** A selected row is marked whichever way it was selected; a checkbox beside it is select mode's. */
  const marked = (id: string) => (isPicked(id) ? "bg-accent-subtle text-ink hover:bg-accent-subtle" : null);
  const selectedNote = (id: string) => (isPicked(id) ? { "aria-description": "Selected" } : {});
  const withBox = (list: ChatListName, row: ChatRow | null, content: ReactNode) =>
    selecting && row ? (
      <div className="flex items-center gap-1.5 pl-1">
        <input
          type="checkbox"
          aria-label={`Select “${row.title}”`}
          checked={isPicked(row.id)}
          onChange={() => toggle(list, row.id)}
          // The row is the stop for the keyboard, and Space on it toggles this box.
          tabIndex={-1}
          className="h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
        />
        <div className="min-w-0 flex-1">{content}</div>
      </div>
    ) : (
      content
    );

  /** The chat on show, in its place: the conversation itself, marked while that is what is on screen. */
  const current = (title: string, about: ChatRow | null, tooltip?: string, state?: ChatState) => {
    const menuKeys = about ? menuOn(about) : null;
    return withBox(
      "open",
      about,
      <NavLink
        to={CHAT_HOME_ROUTE}
        title={tooltip}
        // A link is something the browser drags on its own; this one is dragged as a row.
        draggable={false}
        className={({ isActive }) => cn(ROW, "shrink-0 select-none", rowTone(isActive), about && marked(about.id))}
        {...menuKeys}
        {...(about ? selectedNote(about.id) : {})}
        onClick={(event) => {
          // A modifier click, or any in select mode, is about the
          // selection: no navigation, and no window opened for a link.
          if (about && pick(event, "open", about.id)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (about && spaceToggles(event, "open", about.id)) return;
          // A link answers Enter and not Space, and the rows beside this
          // one are buttons that answer both: every row opens its chat on
          // either key, whichever element it happens to be.
          if (event.key === " " && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            event.preventDefault();
            void navigate(CHAT_HOME_ROUTE);
            return;
          }
          menuKeys?.onKeyDown(event);
        }}
      >
        <span className="truncate">{title}</span>
        <StateMark state={state} />
      </NavLink>,
    );
  };

  const another = (list: ChatListName, thread: (typeof all)[number]) => {
    const menuKeys = menuOn(rowOf(thread));
    return withBox(
      list,
      rowOf(thread),
      <button
        type="button"
        title={`${thread.title} · ${new Date(thread.lastActivityAt).toLocaleDateString()}`}
        disabled={resume.isPending && !selecting}
        onClick={(event) => {
          if (pick(event, list, thread.id)) {
            event.preventDefault();
            return;
          }
          resume.mutate(thread.id);
        }}
        className={cn(ROW, "w-full select-none text-left disabled:opacity-60", rowTone(false), marked(thread.id))}
        {...menuKeys}
        {...selectedNote(thread.id)}
        onKeyDown={(event) => {
          if (spaceToggles(event, list, thread.id)) return;
          menuKeys.onKeyDown(event);
        }}
      >
        <span className="flex-1 truncate">{thread.title}</span>
        <StateMark state={thread.state} />
        {opening(thread)}
      </button>,
    );
  };

  // Where the chat the menu is about stands among the open ones, if it is one of them.
  const place = menu ? openOnes.findIndex((thread) => thread.id === menu.thread.id) : -1;
  // A right-click on a selected row is about the selection.
  const menuOnSelection = menu !== null && isPicked(menu.thread.id);
  const openAll = allOf("open");
  const earlierAll = allOf("earlier");
  const naming = removingMany ?? [];

  return (
    <>
      <div className="px-2.5 pb-1.5 pt-3.5">
        <GroupLabel
          trailing={
            <button
              type="button"
              aria-pressed={selecting}
              onClick={() => (selecting ? endSelection() : setSelecting(true))}
              className={cn("rounded-sm px-1 text-[11px] hover:bg-canvas-subtle hover:text-ink", selecting ? "text-ink" : "text-ink-subtle")}
            >
              Select
            </button>
          }
        >
          Chats
        </GroupLabel>
      </div>
      {holding ? (
        <div role="group" aria-label="Selected chats" className="mb-1 flex shrink-0 items-center gap-1.5 rounded-[10px] bg-canvas-subtle px-2.5 py-1 text-[12px]">
          <span role="status" className="flex-1 truncate text-ink-muted">{`${picked.length} selected`}</span>
          <button
            type="button"
            disabled={picked.length === 0}
            onClick={warnMany}
            className="rounded-md px-1.5 py-0.5 font-medium text-danger hover:bg-canvas-hover disabled:opacity-50"
          >
            Remove
          </button>
          <button type="button" onClick={endSelection} className="rounded-md px-1.5 py-0.5 text-ink-muted hover:bg-canvas-hover hover:text-ink">
            Cancel
          </button>
        </div>
      ) : null}
      {selecting && rowsOf.open.length > 0 ? (
        <button
          type="button"
          aria-pressed={openAll.every}
          aria-label="Select all open chats"
          onClick={openAll.press}
          className="shrink-0 self-start rounded-sm px-2.5 pb-0.5 text-[11px] text-ink-subtle hover:text-ink"
        >
          Select all
        </button>
      ) : null}
      {/* One list, and the chat on show is a row of it like any other.
          There is always a row for it: the room's own name until
          something is said in it, then what was said first. */}
      <div ref={setUnspoken} aria-hidden hidden />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={onDragEnd}
        {...(unspoken ? { accessibility: { container: unspoken } } : {})}
      >
        <SortableContext items={openOnes.map((thread) => thread.id)} strategy={verticalListSortingStrategy}>
          <ul aria-label="Open chats" className="flex shrink-0 flex-col gap-px">
            {listed ? null : <li>{current(EMPTY_CHAT, unlisted)}</li>}
            {openOnes.map((thread) => (
              // Not draggable in select mode, where a press is a choice.
              <SortableChat key={thread.id} id={thread.id} disabled={selecting}>
                {thread.shown
                  ? current(thread.title, rowOf(thread), `${thread.title} · ${new Date(thread.lastActivityAt).toLocaleDateString()}`, thread.state)
                  : another("open", thread)}
              </SortableChat>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {earlier.length > 0 ? (
        <>
          {/* Said, not implied by position: these were put away, and the
              ones above were not. */}
          <div className="flex shrink-0 items-center px-2.5 pb-0.5 pt-2">
            <p className="flex-1 text-[11px] text-ink-subtle">Earlier</p>
            {selecting ? (
              // Every earlier chat, the ones behind "Show all" too.
              <button
                type="button"
                aria-pressed={earlierAll.every}
                aria-label="Select all earlier chats"
                onClick={earlierAll.press}
                className="rounded-sm text-[11px] text-ink-subtle hover:text-ink"
              >
                Select all
              </button>
            ) : null}
          </div>
          <ul aria-label="Earlier chats" className="flex shrink-0 flex-col gap-px">
            {shown.map((thread) => (
              <li key={thread.id}>{another("earlier", thread)}</li>
            ))}
          </ul>
        </>
      ) : null}
      {earlier.length > CHATS_SHOWN ? (
        <button
          type="button"
          aria-expanded={showingAll}
          onClick={() => setShowingAll((value) => !value)}
          className={cn(ROW, "shrink-0 text-[12px] text-ink-subtle hover:bg-canvas-subtle")}
        >
          {showingAll ? "Show fewer" : `Show all ${earlier.length}`}
        </button>
      ) : null}
      <ContextMenu
        label={menu ? `Chat “${menu.thread.title}”` : "Chat"}
        at={menu?.at ?? null}
        onClose={() => setMenu(null)}
        entries={[
          // Reordering without a pointer (EO-438), offered where there is
          // somewhere to move to: not on an earlier chat, and not past an end.
          ...(place > 0 ? [{ label: "Move up", onSelect: () => moveTo(menu!.thread.id, place - 1) }] : []),
          ...(place >= 0 && place < openOnes.length - 1 ? [{ label: "Move down", onSelect: () => moveTo(menu!.thread.id, place + 1) }] : []),
          menuOnSelection
            ? { label: `Remove ${chatsCounted(picked.length)}`, tone: "danger" as const, onSelect: warnMany }
            : {
                label: "Remove",
                tone: "danger" as const,
                onSelect: () => {
                  setRemoveProblem(null);
                  setRemoving(menu?.thread ?? null);
                },
              },
        ]}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove “${removing?.title ?? ""}”?`}
        confirmLabel={remove.isPending ? "Removing…" : "Remove chat"}
        cancelLabel="Keep chat"
        tone="danger"
        busy={remove.isPending}
        error={removeProblem}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
        }}
        onCancel={() => setRemoving(null)}
      >
        <p>This chat will be permanently removed and cannot be recovered.</p>
        <p>
          Its messages, run history, queued requests and attachments go with it.
          {removing?.live ? " Anything it is running is cancelled." : ""}
          {removing?.shown ? " You are left in a new, empty chat." : ""}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removingMany !== null}
        title={`Remove ${chatsCounted(naming.length)}?`}
        confirmLabel={removeMany.isPending ? "Removing…" : `Remove ${chatsCounted(naming.length)}`}
        cancelLabel="Keep chats"
        tone="danger"
        busy={removeMany.isPending}
        error={manyProblem}
        onConfirm={() => {
          if (naming.length > 0) removeMany.mutate(naming.map((row) => row.id));
        }}
        onCancel={() => setRemovingMany(null)}
      >
        <ul aria-label="Chats to remove" className="flex flex-col">
          {naming.slice(0, CHATS_NAMED).map((row) => (
            <li key={row.id} className="truncate">{`“${row.title}”`}</li>
          ))}
          {naming.length > CHATS_NAMED ? <li>{`and ${naming.length - CHATS_NAMED} more`}</li> : null}
        </ul>
        <p>{naming.length === 1 ? "This chat" : "These chats"} will be permanently removed and cannot be recovered.</p>
        <p>
          {naming.length === 1 ? "Its" : "Their"} messages, run history, queued requests and attachments go with {naming.length === 1 ? "it" : "them"}.
          {naming.some((row) => row.live) ? " Anything they are running is cancelled." : ""}
          {naming.some((row) => row.shown) ? " You are left in a new, empty chat." : ""}
        </p>
      </ConfirmDialog>
    </>
  );
}

/** Which of the rail's two lists of chats a row is in: a range never crosses from one to the other. */
type ChatListName = "open" | "earlier";

/** How many selected chats the warning names before "and N more". */
const CHATS_NAMED = 5;

/** "1 chat", "3 chats". */
function chatsCounted(count: number): string {
  return `${count} chat${count === 1 ? "" : "s"}`;
}

/**
 * The open chats in the order a move left them in, while that move is
 * being stored (EO-439). One started meanwhile, which the move never
 * saw, stands first, where a new chat goes; one gone meanwhile is not
 * drawn.
 */
function arrangedAs<T extends { id: string }>(placed: string[] | null, open: T[]): T[] {
  if (placed === null) return open;
  const place = new Map(placed.map((id, index) => [id, index]));
  return [...open.filter((thread) => !place.has(thread.id)), ...open.filter((thread) => place.has(thread.id)).sort((a, b) => place.get(a.id)! - place.get(b.id)!)];
}

/**
 * An open chat's place in the list, which a press and a drag moves.
 *
 * Pointer only, and none of `useSortable`'s attributes: those make the
 * row a button that Space and Enter pick up, and on these rows Space and
 * Enter open the chat. The row inside keeps its own role and its keys.
 * `disabled` in select mode (EO-442), where a press chooses a row and
 * moves nothing.
 */
function SortableChat({ id, disabled = false, children }: { id: string; disabled?: boolean; children: ReactNode }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "relative z-10 opacity-60")}
      data-draggable={!disabled}
      {...(disabled ? {} : listeners)}
    >
      {children}
    </li>
  );
}

type ChatState = "working" | "waiting" | "idle";

/**
 * What a chat is doing, at the end of its row — Claude Desktop's sidebar
 * marks: a turn running in it, or something in it waiting on you. Status
 * colours, never the accent, and words for a screen reader beside each.
 */
function StateMark({ state }: { state: ChatState | undefined }) {
  if (state === "working") return <StatusDot tone="running" label="Working" />;
  if (state === "waiting") return <StatusDot tone="paused" label="Waiting on you" />;
  return null;
}

/** A chat as a row's menu and the warning know it. */
interface ChatRow {
  id: string;
  title: string;
  /** The chat on show, whose removal leaves a new empty one. */
  shown: boolean;
  /** Not put away, so it may be running a turn. */
  live: boolean;
}

/** Who you are, and the gear behind which every other place lives. */
function Footer({ name }: { name: string }) {
  const navigate = useNavigate();
  const vocabulary = useChromeVocabulary();
  const { organisation } = useMe();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <div className={cn(ROW, "h-10 text-ink-muted")}>
        <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-canvas-active text-[10px] font-semibold text-ink">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex-1 truncate">{name}</span>
        {/* Pausing every agent, where no top bar is drawn to carry it. */}
        <EngineToggle />
        <button
          type="button"
          aria-label="More places"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="grid h-6 w-6 place-items-center rounded-md text-ink-subtle hover:bg-canvas-subtle hover:text-ink"
        >
          <Settings size={14} />
        </button>
      </div>
      {open ? (
        <Popover onClose={() => setOpen(false)} label="Places" above>
          {places(vocabulary.items, organisation)
            // The inbox has its own row.
            .filter((place) => place.to !== "/inbox")
            .map((place) => (
              <button
                key={place.to}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void navigate(place.to);
                }}
                className={cn("flex w-full rounded-lg px-2 py-1.5 text-left text-[13px]", rowTone(false))}
              >
                {place.label}
              </button>
            ))}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void navigate("/settings?section=layout");
            }}
            className={cn("flex w-full rounded-lg px-2 py-1.5 text-left text-[13px]", rowTone(false))}
          >
            Colours
          </button>
        </Popover>
      ) : null}
    </div>
  );
}

/** A small floating list with a click-away catcher, closed by Escape. */
function Popover({
  onClose,
  label,
  above = false,
  role = "menu",
  children,
}: {
  onClose: () => void;
  label: string;
  above?: boolean;
  /** A menu holds only commands; a list with a field in it, or choices that are not commands, is a dialog. */
  role?: "menu" | "dialog";
  children: ReactNode;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <>
      <button type="button" aria-hidden tabIndex={-1} onClick={onClose} className="fixed inset-0 z-[var(--z-dropdown)] cursor-default" />
      <div
        role={role}
        aria-label={label}
        className={cn(
          "absolute left-0 z-[calc(var(--z-dropdown)+1)] flex w-[14rem] flex-col gap-px rounded-[14px] bg-canvas-raised p-1.5 shadow-panel",
          above ? "bottom-full mb-1" : "top-full mt-1",
        )}
      >
        {children}
      </div>
    </>
  );
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
}

/** ⌘K / Ctrl+K opens the search, as the row says. */
function SearchShortcut({ onOpen }: { onOpen: () => void }) {
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if (event.key !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, [onOpen]);
  return null;
}

/**
 * Find an item or a pipeline by name or key, and open it beside the
 * conversation. Matches what the classic list matches: the key and the
 * title, case-insensitively.
 */
function SearchBox({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { active } = useProjects();
  const { pipelines } = usePipelines(active?.id ?? null);
  const { items } = useProjectItems();
  const vocabulary = useChromeVocabulary();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const needle = query.trim().toLowerCase();
  const results = needle
    ? [
        ...pipelines
          .filter((pipeline) => pipeline.name.toLowerCase().includes(needle))
          .map((pipeline) => ({ key: pipeline.id, label: pipeline.name, hint: "Pipeline", to: `/pipelines/${pipeline.id}` })),
        ...items
          .filter((item) => item.key.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle))
          .map((item) => ({ key: item.id, label: item.title, hint: item.key, to: `/items/${item.id}` })),
      ].slice(0, 8)
    : [];

  const go = (to: string) => {
    onClose();
    void navigate(to);
  };

  return (
    <Popover onClose={onClose} label="Search" role="dialog">
      <input
        ref={input}
        aria-label={`Search ${vocabulary.items.toLowerCase()} and pipelines`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && results[0]) go(results[0].to);
        }}
        placeholder={`Find ${withArticle(vocabulary.item.toLowerCase())} or a pipeline`}
        className="mb-1 h-8 rounded-lg bg-canvas px-2 text-[13px] text-ink placeholder:text-ink-subtle"
      />
      {results.map((result) => (
        <button
          key={result.key}
          type="button"
          onClick={() => go(result.to)}
          className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", rowTone(false))}
        >
          <span className="min-w-0 flex-1 truncate">{result.label}</span>
          <span className="shrink-0 font-mono text-[11px] text-ink-subtle">{result.hint}</span>
        </button>
      ))}
      {needle && results.length === 0 ? <p className="px-2 py-1.5 text-[13px] text-ink-subtle">Nothing matches.</p> : null}
    </Popover>
  );
}

/**
 * Pausing every agent: the classic top bar's control, drawn as the rail's.
 * Paused, it says so in the waiting colour; paused with runs still
 * finishing, it says how many. The system agent's are not counted: they
 * carry on while paused, so they are not what a pause is waiting for.
 */
function EngineToggle() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: engineStatusKey, queryFn: () => ipcQuery("engine:status", undefined) });
  const toggle = useMutation({
    mutationFn: (paused: boolean) => (paused ? ipcQuery("engine:resume", undefined) : ipcQuery("engine:pause", { cancelRunning: false })),
    onSuccess: async (next) => {
      // A status read begun before the write must not land after it (EO-562).
      await queryClient.cancelQueries({ queryKey: engineStatusKey });
      queryClient.setQueryData(engineStatusKey, next);
    },
  });
  useInvalidateOnPush("runs:changed", engineStatusKey);
  const paused = status.data?.paused ?? false;
  const finishing = status.data?.finishingRunCount ?? 0;
  const draining = paused && finishing > 0;
  // While the request is in flight the control is disabled and says what it
  // is doing (EO-562): a second click would send the same request again.
  const pending = toggle.isPending;
  const sending = useRef(false);
  const label = pending
    ? paused
      ? "Resuming agent activity…"
      : "Pausing agent activity…"
    : draining
      ? `${finishing} agent${finishing === 1 ? " is" : "s are"} finishing`
      : paused
        ? "Resume agent activity"
        : "Pause agent activity";
  return (
    <button
      type="button"
      aria-pressed={paused}
      aria-label={label}
      aria-busy={pending}
      title={`${label}. The system agent carries on while paused.`}
      disabled={pending}
      onClick={() => {
        // The ref, not `isPending`: TanStack draws the pending state a
        // macrotask late, and a double click lands inside that gap.
        if (sending.current) return;
        sending.current = true;
        toggle.mutate(paused, {
          onSettled: () => {
            sending.current = false;
          },
        });
      }}
      className={cn(
        "grid h-6 w-6 place-items-center rounded-md hover:bg-canvas-subtle disabled:cursor-default disabled:opacity-60",
        paused ? "text-paused" : "text-ink-subtle hover:text-ink",
      )}
    >
      {draining || pending ? <LoaderCircle size={14} className="animate-spin" /> : paused ? <Play size={14} /> : <Pause size={14} />}
    </button>
  );
}
