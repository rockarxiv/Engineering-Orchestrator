import { useEffect, useState } from "react";

/**
 * The wall clock, re-read on an interval.
 *
 * A duration computed from `Date.now()` is only as live as whatever
 * re-renders it. The run header was redrawn by the transcript's push
 * events, so an agent that thought quietly for two minutes showed a
 * clock frozen at whatever it read when the last tool call landed — the
 * one moment you most want to see it moving.
 *
 * `active: false` never starts an interval: a finished run's duration
 * cannot change, and nothing should wake the renderer once a second to
 * redraw fixed text.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Immediately, so a clock that starts ticking doesn't first show
    // however stale the mount-time reading had become.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}

/**
 * A running duration, the way a conversation shows one: `9s`, then
 * `1:04`.
 *
 * Beside `useNow` because the two are always used together — a clock
 * that ticks and the text it draws — and shared because there are now
 * three rooms drawing it (EO-190). The transcript keeps its own
 * `1m 5s` on purpose: that is a record of a finished run rather than a
 * timer somebody is watching.
 */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}
