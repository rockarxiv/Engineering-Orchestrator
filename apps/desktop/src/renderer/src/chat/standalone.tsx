import type { ReactNode } from "react";
import { cn } from "@eo/ui";
import { DEEP } from "./parts";
import { useChatTheme } from "./theme";
import { useTitleBar, useTitleBarColours } from "./windowChrome";

/**
 * A screen that is the whole window, before the window's frame is drawn
 * (EO-527): first run, a served browser's sign-in, accepting an
 * invitation.
 *
 * Those sit above `ChatWindow` in `App.tsx`, because each is a state the
 * whole window is in rather than a place in it, and so the frame is not
 * there to paint them. This is what does: the chosen chat theme on the
 * document — read from this device, so a window that has never chosen
 * one gets the default preset rather than the design system's slate —
 * and the canvas's darker ground, with the content in a column on it,
 * as a view sits in the canvas.
 *
 * The theme goes on the document rather than on this element because a
 * dialog opened from one of these screens (signing in to a backend from
 * the needs check) is portalled to the body, and must wear the same
 * colours as the screen it opens over. Unmounting takes it off again,
 * and the frame that is drawn next puts its own on.
 */
export function StandaloneScreen({
  children,
  width = "max-w-2xl",
  centred = true,
}: {
  children: ReactNode;
  /** The column's measure. A form keeps a reading width; a set of cards wants more. */
  width?: string;
  /** Centred in the window's height, for a short screen; from the top, for one that scrolls. */
  centred?: boolean;
}) {
  useChatTheme();
  useTitleBarColours("deep");
  const titleBar = useTitleBar();
  return (
    <div className={cn("flex h-dvh flex-col text-ink", DEEP)}>
      {/* The desktop's main window has no native title bar (EO-668), and
          this screen has no top row to stand in for one: a strip as tall
          as the frame's top row, to move the window by and to keep the
          content clear of the window controls drawn over it. */}
      {titleBar ? <div aria-hidden className="app-drag h-[52px] shrink-0" /> : null}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex min-h-full w-full flex-col px-6 py-8", width, centred && "justify-center")}>{children}</div>
      </main>
    </div>
  );
}
