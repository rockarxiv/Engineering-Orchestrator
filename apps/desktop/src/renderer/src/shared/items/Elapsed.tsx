import { memo } from "react";
import { useMinuteTick } from "../../hooks/useMinuteTick";
import { elapsed } from "./status";

/**
 * How long ago `since` was — `4m`, `3h`, `2d` — kept current on the
 * shared minute clock (EO-570).
 *
 * A leaf of its own so that the tick redraws this text and nothing
 * around it: a board card is memoised (EO-565), and a clock read in the
 * card would redraw every card on the board once a minute to change one
 * word in each.
 */
export const Elapsed = memo(function Elapsed({ since }: { since: number }) {
  useMinuteTick();
  return <>{elapsed(since)}</>;
});
