import type { KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "../kit";

/**
 * The chevrons and "N of M" a paged block in the conversation turns its
 * pages with: a batch of questions (`QuestionCard`), a reply's cards
 * (`CardBlock`, EO-863) and a reply's work proposals (`ProposalBlock`,
 * EO-864). One piece, so they look and behave the same.
 * Nothing at all for a single page.
 *
 * `noun` names a page in the chevrons' labels: "Previous question",
 * "Next card".
 */
export function Pager({
  noun,
  index,
  count,
  disabled = false,
  onChange,
}: {
  noun: string;
  index: number;
  count: number;
  disabled?: boolean;
  onChange: (index: number) => void;
}) {
  if (count < 2) return null;
  return (
    <>
      <IconButton
        label={`Previous ${noun}`}
        icon={<ChevronLeft size={14} />}
        disabled={index === 0 || disabled}
        onClick={() => onChange(index - 1)}
        className="h-[26px] w-[26px] disabled:opacity-30"
      />
      <span aria-live="polite" className="tabular-nums">
        {index + 1} of {count}
      </span>
      <IconButton
        label={`Next ${noun}`}
        icon={<ChevronRight size={14} />}
        disabled={index === count - 1 || disabled}
        onClick={() => onChange(index + 1)}
        className="h-[26px] w-[26px] disabled:opacity-30"
      />
    </>
  );
}

/**
 * The arrow keys, as the pager's chevrons: left and right move a page,
 * and stop at either end. True when the key turned a page.
 */
export function pageByArrow(event: KeyboardEvent, index: number, count: number, onChange: (index: number) => void): boolean {
  if (event.key === "ArrowLeft" && index > 0) {
    event.preventDefault();
    onChange(index - 1);
    return true;
  }
  if (event.key === "ArrowRight" && index < count - 1) {
    event.preventDefault();
    onChange(index + 1);
    return true;
  }
  return false;
}
