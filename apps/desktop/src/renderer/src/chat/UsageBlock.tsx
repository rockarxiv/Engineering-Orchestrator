import { useEffect, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  nextPlanUsageChange,
  PLAN_USAGE_BARS,
  planUsageRuntimeQualifies,
  quotaWindowPhrase,
  shownPlanWindow,
  type PlanUsageBackend,
  type PlanWindowTone,
  type ShownPlanWindow,
} from "@eo/core";
import { cn } from "@eo/ui";
import { machineAvailable } from "../ipc/bridge";
import { ipcQuery } from "../query/client";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";
import { MANAGED_RUNTIMES } from "../shared/agents/catalog";
import { runtimeKey } from "../shared/agents/runtimeStatus";
import { GroupLabel } from "./parts";

export const planUsageKey = ["planUsage"] as const;

/** How often the age in the header is redrawn while nothing else changes. */
const AGE_REFRESH_MS = 30_000;
/** The longest a timer may wait; anything later is caught by the next refresh. */
const LONGEST_WAIT_MS = 2 ** 31 - 1;

const FILL: Record<PlanWindowTone, string> = { neutral: "bg-ink-subtle", warning: "bg-warning", danger: "bg-danger" };
const FIGURE: Record<PlanWindowTone, string> = { neutral: "text-ink-subtle", warning: "text-warning", danger: "text-danger" };

interface Group {
  provider: string;
  name: string;
  backend: PlanUsageBackend | null;
}

/**
 * Each signed-in backend's plan usage, above the rail's footer (EO-896):
 * a 5-hour and a weekly bar per backend, neutral until a window reaches
 * 80% (amber, with when it resets) or is refused (red, with when it is
 * back).
 *
 * A backend is drawn when its runtime is installed, enabled and signed
 * in, as `runtime:status` says, unless it said plan limits do not apply
 * to its sign-in. With none, nothing is drawn. The readings are the main
 * process's (`planUsage:get`), asked again on `planUsage:changed`.
 *
 * Drawn by walking the managed runtimes, never by asking which backend
 * one is (invariant 12).
 */
export function UsageBlock() {
  const available = machineAvailable();
  const statuses = useQueries({
    queries: MANAGED_RUNTIMES.map((choice) => ({
      queryKey: runtimeKey(choice.id),
      queryFn: () => ipcQuery("runtime:status", { provider: choice.id }),
      enabled: available,
    })),
  });
  const usage = useQuery({ queryKey: planUsageKey, queryFn: () => ipcQuery("planUsage:get", undefined), enabled: available });
  useInvalidateOnPush("planUsage:changed", planUsageKey, available);

  const backends = usage.data?.backends ?? [];
  const groups: Group[] = MANAGED_RUNTIMES.flatMap((choice, index) => {
    if (!planUsageRuntimeQualifies(statuses[index]?.data?.runtime)) return [];
    const backend = backends.find((entry) => entry.provider === choice.id) ?? null;
    if (backend && !backend.limitsApply) return [];
    return [{ provider: choice.id, name: choice.shortLabel ?? choice.label, backend }];
  }).sort((a, b) => a.name.localeCompare(b.name));

  const shownBackends = groups.flatMap((group) => (group.backend ? [group.backend] : []));
  const clock = useUsageClock(shownBackends);
  if (groups.length === 0) return null;

  const newest = Math.max(0, ...shownBackends.flatMap((backend) => backend.windows.map((reading) => reading.readAt)));
  // The main process stamped the reading; a clock a moment behind it is still "just now".
  const now = Math.max(clock, newest);

  return (
    <section aria-label="Usage" className="flex shrink-0 flex-col gap-2.5 px-2.5 pb-2 pt-3">
      <GroupLabel trailing={newest > 0 ? age(now - newest) : undefined}>Usage</GroupLabel>
      {groups.map((group) => (
        <BackendGroup key={group.provider} group={group} now={now} />
      ))}
    </section>
  );
}

function BackendGroup({ group, now }: { group: Group; now: number }) {
  const readings = group.backend?.windows ?? [];
  const shown = readings.map((reading) => shownPlanWindow(reading, now));
  const bars = PLAN_USAGE_BARS.flatMap((bar) => {
    const reading = shown.find((entry) => (bar.windows as readonly string[]).includes(entry.window));
    return reading ? [{ label: bar.label, reading }] : [];
  });
  const barWindows: readonly string[] = PLAN_USAGE_BARS.flatMap((bar) => bar.windows);
  const otherRefusals = shown.filter((entry) => entry.refused && !barWindows.includes(entry.window));
  const mark: PlanWindowTone = shown.some((entry) => entry.tone === "danger") ? "danger" : shown.some((entry) => entry.tone === "warning") ? "warning" : "neutral";

  return (
    <div role="group" aria-label={group.name} className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-muted">
        {mark !== "neutral" ? <span data-testid="usage-mark" data-tone={mark} aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", FILL[mark])} /> : null}
        <span className="truncate">{group.name}</span>
      </div>
      {readings.length === 0 ? (
        <p className="text-[11px] text-ink-subtle">No reading yet — shown after the next run</p>
      ) : (
        <>
          {bars.map((bar) => (
            <Meter key={bar.label} label={bar.label} reading={bar.reading} now={now} />
          ))}
          {otherRefusals.map((entry) => (
            <p key={entry.window} className="text-[11px] text-danger">
              {`${windowName(entry.window)}: ${refusedLine(entry, now)}`}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

function Meter({ label, reading, now }: { label: string; reading: ShownPlanWindow; now: number }) {
  const note = reading.refused ? refusedLine(reading, now) : reading.tone === "warning" && reading.resetAt !== null ? `Resets ${clockTime(reading.resetAt, now)}` : null;
  const figure = reading.percent === null ? "—" : `${Math.round(reading.percent)}%`;
  return (
    <div role="group" aria-label={label} data-tone={reading.tone} className="flex flex-col gap-1">
      <div className="grid grid-cols-[34px_1fr_36px] items-center gap-2 text-[11px]">
        <span className="text-ink-subtle">{label}</span>
        <div className="h-1 overflow-hidden rounded-full bg-canvas-active">
          <div data-testid="usage-fill" className={cn("h-full rounded-full", FILL[reading.tone])} style={{ width: `${reading.percent ?? 0}%` }} />
        </div>
        <span className={cn("text-right font-mono tabular-nums", FIGURE[reading.tone])}>{figure}</span>
      </div>
      {note !== null ? <p className={cn("pl-[42px] text-[11px]", reading.refused ? "text-danger" : "text-ink-subtle")}>{note}</p> : null}
    </div>
  );
}

function refusedLine(reading: ShownPlanWindow, now: number): string {
  return reading.resetAt === null ? "Refused" : `Refused · back at ${clockTime(reading.resetAt, now)}`;
}

/** A window that is not drawn as a bar, named the way an item names it — "seven-day-opus". */
function windowName(window: string): string {
  const phrase = quotaWindowPhrase(window);
  return phrase.startsWith("its ") ? window.trim().replace(/_/g, "-") : "A window it did not name";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "15:40" today, "Thu 09:00" on another day, in this machine's zone. */
export function clockTime(at: number, now: number): string {
  const when = new Date(at);
  const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return when.toDateString() === new Date(now).toDateString() ? time : `${WEEKDAYS[when.getDay()]} ${time}`;
}

/** "just now" under a minute, "N min ago" under an hour, "N h ago" after. */
export function age(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/**
 * The time the block is drawn at: redrawn every 30 seconds, so the age
 * advances while no reading arrives, and at the next reset, so a window
 * comes back at the moment it does rather than at the next reading.
 */
function useUsageClock(backends: readonly PlanUsageBackend[]): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const next = nextPlanUsageChange(backends, now);
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(LONGEST_WAIT_MS, Math.max(0, next - Date.now())));
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}
