import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { CHAT_HOME_ROUTE, isChatHomeRoute } from "@eo/core";
import { Sparkles } from "lucide-react";
import { cn } from "@eo/ui";
import { bridge } from "../ipc/bridge";
import { itemsKey } from "../query/hooks";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";
import { ipcQuery } from "../query/client";
import { CanvasChip, ChatCanvas } from "./ChatCanvas";
import { ChatBanners } from "./ChatBanners";
import { ChatConversation } from "./ChatConversation";
import { ChatRail } from "./ChatRail";
import { CanvasWindow } from "./CanvasWindow";
import { canPopOutCanvas, clearCanvasRestore, isCanvasWindow, setCanvasPoppedOut, useCanvasWindowState, useCanvasWindowSync } from "./canvasPopOut";
import { useCanvasTabs } from "./useCanvasTabs";
import { AskAssistantContext } from "./askAssistant";
import { ChatDrawer } from "./ChatHome";
import { useChatTheme } from "./theme";
import { TourHost } from "./tour/Tour";
import { chatViewFor, isWide, movedAddressOf, tabKeyOf, type ChatViewKind } from "./views/registry";

/**
 * The window (ARCHITECTURE.md, "The chat-centric layout"): the assistant
 * as its spine, and what it is about beside it.
 *
 * Two states, read off the address:
 *
 * - **The home** (`/chat`): the rail, the conversation wide, and the
 *   overview column — what is waiting on you and what is working.
 * - **A view**: anything else — a board, an item, Settings, an agent —
 *   drawn by `ChatCanvas` (`views/`), with the conversation beside it and
 *   a tab for each view opened.
 *
 * An address no view draws — `/`, a stale bookmark, an address an older
 * EO had and this one does not (`/assist`, `/discussions`) — is the home.
 *
 * Drawn above the addresses rather than by a route, for the
 * conversation's sake: a conversation mounted under a route is remade on
 * every navigation, and the walk from an item to its board mid-sentence
 * is exactly the one a person makes while talking about it.
 *
 * The canvas's own window (EO-383) is the other half of the same frame:
 * that window draws the canvas and nothing else, whatever address it is
 * on.
 */
export function ChatWindow() {
  if (isCanvasWindow()) return <CanvasWindow />;
  return <ChatFrame />;
}

function ChatFrame() {
  useChatTheme();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const home = isChatHomeRoute(pathname);
  const view = home ? null : chatViewFor(pathname, search);
  const tabKey = view ? tabKeyOf(view) : null;
  const here = `${pathname}${search}`;
  /*
   * The canvas may be in a window of its own (EO-383). Then this window
   * draws no canvas whatever its address, the conversation keeps its
   * full width, and a view asked for here is opened over there.
   */
  useCanvasWindowSync();
  const { poppedOut, restore } = useCanvasWindowState();
  /** A view is drawn beside the conversation, in this window. */
  const beside = view !== null && !poppedOut;
  /*
   * Beside a view drawn for the whole width — Settings, an editor — the
   * conversation starts folded to a strip; beside a board or an item it
   * starts open. Either way one press changes it, and the choice holds
   * for that kind of view until it is changed back.
   */
  const [foldChoice, setFoldChoice] = useState<Partial<Record<ChatViewKind, boolean>>>({});
  const folded = beside && view !== null && (foldChoice[view.kind] ?? isWide(view));
  const toggleFold = () => {
    if (view) setFoldChoice((current) => ({ ...current, [view.kind]: !folded }));
  };
  /*
   * The one place to talk to an agent in this layout. A view that used
   * to host its own room (the board's planning, the pipeline editor's
   * architect) hands the person here instead: the column opens if it was
   * folded, and the box takes the cursor.
   */
  const [focusRequest, setFocusRequest] = useState(0);
  const kind = view?.kind ?? null;
  const askAssistant = useCallback(() => {
    if (kind !== null) setFoldChoice((current) => ({ ...current, [kind]: false }));
    setFocusRequest((count) => count + 1);
  }, [kind]);
  // The same hand-off from the canvas in its own window (EO-408): a view
  // there asked for the composer, which is here. The main process has
  // already brought this window forward.
  useEffect(() => bridge().subscribe("canvas:asked", () => askAssistant()), [askAssistant]);
  const [drawerOpen, setDrawerOpen] = useState(true);

  // A tab for each view opened this session (`useCanvasTabs`). Not
  // recorded while the canvas is out: those are the other window's tabs.
  const { tabs, closeTab, replaceTabs } = useCanvasTabs({
    view,
    tabKey,
    here,
    recording: !poppedOut,
    onEmpty: () => void navigate(CHAT_HOME_ROUTE),
  });

  /*
   * Pop out (EO-383): the canvas goes to a window of its own with these
   * tabs, and this window goes home to the conversation.
   *
   * `handedOver` is the address that went with it. The effect below
   * sends every view this window is asked for across to the canvas
   * window, and the one the canvas was popped out *on* is already there.
   */
  const handedOver = useRef<string | null>(null);
  const popOut = () => {
    handedOver.current = here;
    void ipcQuery("canvas:window", { tabs: tabs.map((tab) => tab.path), active: here })
      .then((answer) => {
        if (answer.opened) setCanvasPoppedOut(true);
        else handedOver.current = null;
      })
      .catch(() => {
        handedOver.current = null;
      });
  };
  // The tabs went with it: what comes back is what a pop-in hands over.
  useEffect(() => {
    if (poppedOut) replaceTabs([]);
  }, [poppedOut, replaceTabs]);
  /*
   * While the canvas is out, where things open: an item's link in a
   * message, a board in the rail, a notification — anything that brings
   * this window to a view's address opens as a tab over there instead,
   * and this window stays on the conversation at its full width.
   */
  useEffect(() => {
    if (!poppedOut || view === null) return;
    const path = here;
    if (handedOver.current === path) {
      handedOver.current = null;
    } else {
      void ipcQuery("canvas:open", { path })
        .then((answer) => {
          if (answer.opened) return;
          // No canvas window after all (it closed as this was sent), so
          // the view opens here, as it would have.
          setCanvasPoppedOut(false);
          void navigate(path);
        })
        .catch(() => {});
    }
    void navigate(CHAT_HOME_ROUTE, { replace: true });
  }, [poppedOut, here]);
  // Pop in: the tabs the canvas window had, drawn here again with the
  // same one open.
  useEffect(() => {
    if (restore === null) return;
    replaceTabs(restore.tabs);
    clearCanvasRestore();
    void navigate(restore.active);
  }, [restore]);

  // Done here once for the whole window: the item list and a desktop
  // notification's click have to work whichever view is open.
  useInvalidateOnPush("items:changed", itemsKey);
  useInvalidateOnPush("runs:changed", itemsKey);
  useEffect(
    () =>
      bridge().subscribe("navigate", ({ to }) => {
        void navigate(to);
      }),
    [navigate],
  );

  // An address this layout has retired — a pipeline's configure screen
  // (EO-525) — is replaced by where it went. From an effect, with the
  // frame still drawn (`chatViewFor` already reads the old address as
  // the graph): a frame swapped for a <Navigate> unmounts the
  // conversation, and takes what was typed in its box with it. Not while
  // the canvas is out: the address goes over there, which replaces it.
  const moved = movedAddressOf(pathname);
  useEffect(() => {
    if (moved !== null && !poppedOut) void navigate(moved, { replace: true });
  }, [moved, poppedOut, navigate]);
  // An address nothing in this layout draws — `/`, a stale bookmark — is
  // the conversation.
  if (!home && view === null) return <Navigate to={CHAT_HOME_ROUTE} replace />;

  return (
    // The first-board tour (EO-667) over the whole window: it points at the rail and the conversation as well as at views.
    <TourHost view={view}>
      {/* Positioned and clipped, so nothing in the layout ever lengthens the
          document: an absolutely placed element with no positioned ancestor
          (a screen-reader label in a long transcript) escapes its scroller,
          and a document taller than the window scrolls the whole frame away. */}
      <div className="relative flex h-full overflow-hidden bg-canvas text-ink">
        <ChatRail onNewPipeline={askAssistant} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatBanners />
          <div className="flex min-h-0 min-w-0 flex-1">
            {/* One element in every state: a column that changed type between
                the home and a view would be remounted, and take what was
                typed in the composer with it. */}
            {folded ? (
              <div className="flex w-12 shrink-0 flex-col items-center border-r border-line pt-3">
                <button
                  type="button"
                  aria-label="Show the conversation"
                  title="Show the conversation"
                  onClick={toggleFold}
                  className="grid h-[30px] w-[30px] place-items-center rounded-[10px] bg-accent-subtle text-accent-soft hover:bg-canvas-raised"
                >
                  <Sparkles size={15} />
                </button>
              </div>
            ) : null}
            <section
              aria-label="Conversation"
              data-tour="assistant"
              hidden={folded}
              className={cn("flex min-h-0 min-w-0 flex-col", beside ? "w-[30rem] shrink-0" : "flex-1", folded && "hidden")}
            >
              <ChatConversation
                narrow={beside}
                hidden={folded}
                focusRequest={focusRequest}
                {...(beside ? { onFold: toggleFold } : {})}
                context={beside && view ? <CanvasChip view={view} /> : undefined}
                {...(home ? { drawerOpen, onToggleDrawer: () => setDrawerOpen((open) => !open) } : {})}
              />
            </section>

            {home ? (
              // The overview column.
              drawerOpen ? (
                <div className="flex min-h-0 w-[300px] shrink-0 flex-col border-l border-line">
                  <ChatDrawer />
                </div>
              ) : null
            ) : view && tabKey && !poppedOut ? (
              <AskAssistantContext.Provider value={askAssistant}>
                <ChatCanvas
                  view={view}
                  tabKey={tabKey}
                  tabs={tabs}
                  onCloseTab={closeTab}
                  onClose={() => void navigate(CHAT_HOME_ROUTE)}
                  pop={canPopOutCanvas() ? { label: "Pop out", onPress: popOut } : undefined}
                />
              </AskAssistantContext.Provider>
            ) : null}
          </div>
        </div>
      </div>
    </TourHost>
  );
}
