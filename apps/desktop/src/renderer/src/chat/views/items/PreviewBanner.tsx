import type { ReactNode } from "react";
import { cn } from "@eo/ui";
import { PREVIEW_BANNER } from "../../../shared/items/previewBanner";

/**
 * The one sentence a preview says (EO-313, ARCHITECTURE.md, "Preview"), in the chat layout.
 *
 * The same words the classic banner prints — `PREVIEW_BANNER` is the one
 * spelling of them — on the paused ground, because nothing is wrong but
 * this is the one thing on screen that is not what it appears to be.
 * Never dismissible: the only way to be rid of it is "Done previewing",
 * which is rid of the item too.
 */
export function PreviewBanner({ action, compact = false }: { action?: ReactNode; compact?: boolean }) {
  return (
    <div
      role="note"
      aria-label="Preview"
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-[10px] bg-paused/15 text-paused",
        compact ? "px-2 py-0.5 text-[11px]" : "px-3 py-2 text-[12.5px]",
      )}
    >
      <span className="min-w-0 flex-1">{PREVIEW_BANNER}</span>
      {action}
    </div>
  );
}
