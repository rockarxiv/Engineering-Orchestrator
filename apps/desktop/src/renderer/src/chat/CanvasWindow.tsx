import { useCallback, useEffect } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { bridge } from "../ipc/bridge";
import { ipcQuery } from "../query/client";
import { itemsKey } from "../query/hooks";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";
import { AskAssistantContext } from "./askAssistant";
import { ChatCanvas } from "./ChatCanvas";
import { useChatTheme } from "./theme";
import { useCanvasTabs } from "./useCanvasTabs";
import { chatViewFor, movedAddressOf, tabKeyOf } from "./views/registry";

/**
 * The canvas, as a whole window (EO-383).
 *
 * What the desktop's canvas window renders: the same bundle as the main
 * window, told apart by its URL's query (`canvasPopOut.ts`), drawing the
 * tab row and the open view and nothing else — no rail, no conversation.
 * The conversation is in the main window, at its full width, which is
 * the point of popping the canvas out.
 *
 * The window walks between the same addresses the canvas always has, so
 * every link inside a view works as it does beside the conversation, and
 * `ViewPublisher` above this publishes the page it is on: while the
 * canvas is out, this is the screen the assistant reads.
 *
 * A fresh renderer holds nothing, so the tabs it was popped out with are
 * asked for once (`canvas:state`). After that the row is this window's
 * own, until "Pop in" hands it back.
 */
export function CanvasWindow() {
  useChatTheme();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const view = chatViewFor(pathname, search);
  const tabKey = view ? tabKeyOf(view) : null;
  const here = `${pathname}${search}`;

  /** "Close the canvas": this window goes, and the main one stays on the conversation. */
  const close = useCallback(() => {
    void ipcQuery("canvas:close", { restore: null }).catch(() => {});
  }, []);

  const { tabs, closeTab, replaceTabs } = useCanvasTabs({ view, tabKey, here, onEmpty: close });

  /*
   * A view's hand-off to the conversation (`askAssistant.tsx`). The
   * conversation is in the main window, so this asks for that window to
   * come forward with the cursor in its box (EO-408).
   */
  const askAssistant = useCallback(() => {
    void ipcQuery("canvas:ask", undefined).catch(() => {});
  }, []);

  /** "Pop in": this window goes, and the main one draws these tabs again. */
  const popIn = () => {
    void ipcQuery("canvas:close", { restore: { tabs: tabs.map((tab) => tab.path), active: here } }).catch(() => {});
  };

  // The tabs this window was popped out with, and anything opened in it
  // before it had loaded far enough to hear about it.
  useEffect(() => {
    let current = true;
    void ipcQuery("canvas:state", undefined)
      .then((answer) => {
        if (!current || !Array.isArray(answer.tabs)) return;
        const active = answer.active ?? null;
        // The address this window loaded at is one of them; if it is not
        // the one to be open, something was opened since.
        replaceTabs(active === null || answer.tabs.includes(active) ? answer.tabs : [...answer.tabs, active]);
        if (active !== null && active !== `${window.location.hash.slice(1)}`) void navigate(active);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  // A view opened from the main window while the canvas is out: an item's
  // link in a message, a board in the sidebar.
  useEffect(
    () =>
      bridge().subscribe("canvas:opened", ({ path }) => {
        void navigate(path);
      }),
    [navigate],
  );

  // What the frame does for the main window, done here for this one.
  useInvalidateOnPush("items:changed", itemsKey);
  useInvalidateOnPush("runs:changed", itemsKey);

  // Nothing to draw is the canvas closed: an address no view has (a link
  // home to the conversation, which is in the other window).
  const nothingToDraw = view === null || tabKey === null;
  useEffect(() => {
    if (nothingToDraw) close();
  }, [nothingToDraw, close]);

  // As in the main window's frame: a retired address is replaced by where it went (EO-525).
  const moved = movedAddressOf(pathname);
  if (moved !== null) return <Navigate to={moved} replace />;
  if (view === null || tabKey === null) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-ink">
      <AskAssistantContext.Provider value={askAssistant}>
        <ChatCanvas view={view} tabKey={tabKey} tabs={tabs} onCloseTab={closeTab} onClose={close} pop={{ label: "Pop in", onPress: popIn }} />
      </AskAssistantContext.Provider>
    </div>
  );
}
