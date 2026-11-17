import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ItemBriefPart } from "@eo/core";
import { CollapsibleMarkdown } from "@eo/ui";
import { ipcQuery } from "../../../query/client";
import { ErrorLine, Loading } from "../../kit";
import { RefText } from "../items/ItemReference";
import { when } from "./parts";

/**
 * What the decision is about, behind "Show details" on the decision bar
 * (EO-827, ARCHITECTURE.md, "The decision's brief").
 *
 * Resolved in the main process (`items:brief`) and read only once somebody
 * opens it: the step's declared parts in order, or the default — its
 * instructions summary, the item's current output and the newest verdict
 * from the step before. Each body is clipped as the Output section's is,
 * and the whole brief scrolls inside the bar rather than growing it over
 * the page, so a long plan never covers what it is about.
 */
export function DecisionBrief({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const brief = useQuery({
    // Under the item's own key, so every push that refreshes the page refreshes this.
    queryKey: ["item", itemId, "brief"],
    queryFn: () => ipcQuery("items:brief", { itemId }),
    enabled: open,
  });
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((was) => !was)}
        className="flex items-center gap-1 self-start rounded-[7px] text-[12px] text-ink-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Chevron aria-hidden size={13} />
        {open ? "Hide details" : "Show details"}
      </button>
      {open ? (
        <div id={regionId} role="region" aria-label="Details" className="flex max-h-[50vh] min-w-0 flex-col gap-3 overflow-y-auto border-t border-line pt-2">
          {brief.isLoading ? <Loading /> : null}
          {brief.error ? (
            <ErrorLine>
              <RefText>{brief.error.message}</RefText>
            </ErrorLine>
          ) : null}
          {brief.data === null ? <p className="text-[12.5px] text-ink-subtle">This item no longer exists.</p> : null}
          {brief.data?.parts.length === 0 ? <p className="text-[12.5px] text-ink-subtle">Nothing to show about this decision.</p> : null}
          {brief.data?.parts.map((part, index) => <BriefPart key={`${index}-${part.heading}`} part={part} />)}
        </div>
      ) : null}
    </div>
  );
}

function BriefPart({ part }: { part: ItemBriefPart }) {
  return (
    <section aria-label={part.heading} className="flex min-w-0 flex-col gap-1">
      <h3 className="text-[12px] font-semibold text-ink">
        {part.heading}
        {part.author === null ? null : (
          <span className="font-normal text-ink-subtle">
            {" "}
            · {part.author}
            {part.createdAt === null ? "" : `, ${when(part.createdAt)}`}
          </span>
        )}
      </h3>
      {part.body === null ? (
        <p className="text-[12.5px] text-ink-subtle">{emptyLine(part)}</p>
      ) : (
        <CollapsibleMarkdown className="min-w-0 text-[13px] text-ink" toggleClassName="rounded-[7px] text-[12px] focus-visible:outline-focus">
          {part.body}
        </CollapsibleMarkdown>
      )}
    </section>
  );
}

/** What a part with nothing to show says, so its heading is never over nothing. */
function emptyLine(part: ItemBriefPart): string {
  if (part.show === "output") return "No output yet.";
  if (part.show === "field") return "Not filled in.";
  if (part.show === "comment") return "Nothing said yet.";
  return "None.";
}
