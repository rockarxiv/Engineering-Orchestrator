import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MemoryConsolidationView, MemoryEntryView, MemoryListEntry, MemoryRetirementReason, MemoryScope, MemoryUsage, MemoryWriteResult } from "@eo/core";
import { ipcQuery } from "../query/client";
import { engineStatusKey } from "../query/engine";
import { useChromeVocabulary } from "../query/hooks";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";

/**
 * A project's or a workspace's memory, as a person reads and corrects it
 * in settings (EO-481, ARCHITECTURE.md, "What an agent is given").
 *
 * What is listed, what each entry and each consolidation says about
 * itself, and every write — all through the `memory:*` channels (EO-478,
 * EO-480) — are here, once, for both layouts. Only the drawing is the
 * layout's own: `settings/MemoryPanel.tsx` for the classic one and
 * `chat/views/settings/sections/MemoryPanel.tsx` for the chat one, which
 * may take nothing drawn from the classic folders (`noClassicUi.test.ts`).
 */

/** Every memory query, so one invalidation reaches every scope on screen. */
export const memoryRootKey = ["memory"] as const;

/** One scope's entries, active and retired. */
export const memoryEntriesKey = (scope: MemoryScope) => [...memoryRootKey, scope.kind, scope.id, "entries"] as const;

/** One scope's consolidations. */
export const memoryConsolidationsKey = (scope: MemoryScope) => [...memoryRootKey, scope.kind, scope.id, "consolidations"] as const;

/** A scope's entries split as the panel draws them: what is delivered, then the history behind it. */
export interface MemoryLists {
  /** Newest first: the entries dispatches are given. */
  active: MemoryListEntry[];
  /** Most recently retired first: what a person can restore. */
  retired: MemoryListEntry[];
}

/**
 * The active entries newest first, and the retired ones after them.
 *
 * `memory:list` already answers in this order; it is sorted again here
 * so the panel does not depend on the order of an answer it did not
 * write, and so the rule the acceptance criterion names is said where it
 * can be tested on its own.
 */
export function splitMemory(entries: readonly MemoryListEntry[]): MemoryLists {
  const active = entries.filter((entry) => entry.retiredAt === null).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const retired = entries.filter((entry) => entry.retiredAt !== null).sort((a, b) => (b.retiredAt ?? 0) - (a.retiredAt ?? 0) || (a.id < b.id ? 1 : -1));
  return { active, retired };
}

/**
 * How often an active entry was given to a run and how often a run said
 * it relied on it (EO-597), so one given often and never used stands out.
 */
export function memoryUsageLine(usage: MemoryUsage): string {
  if (usage.deliveries === 0) return "Not given to a run yet";
  return `Given to ${usage.deliveries} ${usage.deliveries === 1 ? "run" : "runs"}, used by ${usage.uses}`;
}

/** When something happened, as a person reads a date and time. */
export function memoryWhen(at: number): string {
  return new Date(at).toLocaleString();
}

/** Why a retired entry is not delivered, said as a person would say it. */
export function retiredReasonLabel(reason: MemoryRetirementReason | null): string {
  if (reason === "edited") return "Replaced by an edit";
  if (reason === "consolidated") return "Folded into a consolidation";
  // A skill a consolidation proposed was applied (EO-483, EO-719); restoring that
  // consolidation puts it back.
  if (reason === "moved_to_skill") return "Moved into a skill";
  // An agent's note named it as the entry it corrects or repeats (EO-594).
  if (reason === "superseded") return "Superseded by a newer note";
  return "Retired";
}

/** What the mark on an entry that contradicts the workspace's own file says. */
export const CONTRADICTS_LABEL = "Contradicts CLAUDE.md or AGENTS.md";

/** Its longer sentence, for a tooltip and a screen reader. */
export const CONTRADICTS_DESCRIPTION =
  "A consolidation kept this entry although it disagrees with this workspace's CLAUDE.md or AGENTS.md, because the entry is newer and says it corrects the file. The file was not changed.";

/** What the mark on an entry EO drew out of a finished run says. */
export const EXTRACTED_LABEL = "Extracted";

/** Its longer sentence. */
export const EXTRACTED_DESCRIPTION = "EO drew this out of what the run produced after it ended; the agent did not write it itself.";

/**
 * One consolidation as a row says it: when, how many entries it replaced,
 * what came of it, and whether Restore is offered.
 *
 * Restore is offered only on one that succeeded and has not been undone:
 * a failed or skipped one changed nothing, a running one has nothing to
 * put back yet, and a restored one already has been — a button there
 * would be a control `memory:restoreConsolidation` could only refuse.
 */
export interface ConsolidationLine {
  when: string;
  replaced: number;
  wrote: number;
  /** "Replaced 12 entries with 5", or what it did instead. */
  summary: string;
  canRestore: boolean;
}

function entries(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

export function consolidationLine(consolidation: MemoryConsolidationView): ConsolidationLine {
  const replaced = consolidation.retiredIds.length;
  const wrote = consolidation.writtenIds.length;
  const when = memoryWhen(consolidation.finishedAt ?? consolidation.startedAt);
  const summary = (() => {
    // A container's memory ending (EO-596): what it wrote is the
    // project's, and what it retired was the container's.
    if (consolidation.trigger === "container_done" && (consolidation.status === "succeeded" || consolidation.status === "restored")) {
      const ended = `Work finished: kept ${wrote} of ${entries(replaced)} as project memory, retired the rest`;
      return consolidation.status === "succeeded" ? ended : `${ended}; restored ${memoryWhen(consolidation.restoredAt ?? consolidation.finishedAt ?? consolidation.startedAt)}`;
    }
    switch (consolidation.status) {
      case "succeeded":
        return `Replaced ${entries(replaced)} with ${wrote}`;
      case "restored":
        return `Replaced ${entries(replaced)} with ${wrote}; restored ${memoryWhen(consolidation.restoredAt ?? consolidation.finishedAt ?? consolidation.startedAt)}`;
      case "running":
        return "Running";
      case "failed":
        return "Failed; memory was left as it was";
      case "skipped":
        // A container's end whose work was reopened meanwhile (EO-596).
        return consolidation.trigger === "container_done" ? "Skipped; work under it resumed, so nothing was changed" : "Skipped; nothing it may rewrite";
    }
  })();
  return { when, replaced, wrote, summary, canRestore: consolidation.status === "succeeded" };
}

/**
 * Where an entry came from, as the panel draws it.
 *
 * A run's entry names its item, by key once `items:get` has answered —
 * the cache entry the item view itself reads — and links to it and to
 * its runs. There is no address for one run on its own; its item's runs
 * are where it is read.
 */
export type MemorySourceView =
  | { kind: "person" }
  | { kind: "run"; itemId: string; itemLabel: string; itemPath: string; runsPath: string; extracted: boolean }
  | { kind: "run-gone"; extracted: boolean };

export function useMemorySource(entry: MemoryEntryView): MemorySourceView {
  const vocabulary = useChromeVocabulary();
  const itemId = entry.source.type === "run" ? entry.source.itemId : null;
  const detail = useQuery({
    queryKey: ["item", itemId],
    queryFn: () => ipcQuery("items:get", { itemId: itemId! }),
    enabled: itemId !== null,
  });
  if (entry.source.type === "person") return { kind: "person" };
  const extracted = entry.source.extracted === true;
  if (itemId === null) return { kind: "run-gone", extracted };
  const key = detail.data?.item?.key;
  return {
    kind: "run",
    itemId,
    itemLabel: typeof key === "string" && key !== "" ? key : `its ${vocabulary.item.toLowerCase()}`,
    itemPath: `/items/${itemId}`,
    runsPath: `/items/${itemId}/runs`,
    extracted,
  };
}

/**
 * Why Consolidate now cannot be pressed (EO-589), or null when it can:
 * one of the scope's is already queued or running, EO is paused, or no
 * active entry here was written by an agent — what `memory:consolidateNow`
 * would refuse or answer with nothing added. A scope held by an
 * organisation's record is not known here, and is refused when pressed.
 */
export function consolidateNowBlocker(input: {
  where: MemoryScope["kind"];
  pending: "queued" | "running" | null;
  paused: boolean;
  agentEntries: number;
}): string | null {
  if (input.pending === "running") return `A consolidation of this ${input.where} is running.`;
  if (input.pending === "queued") return `A consolidation of this ${input.where} is queued, and starts once nothing is ahead of it.`;
  if (input.paused) return "EO is paused, and no consolidation starts while it is.";
  if (input.agentEntries === 0) return `No active entry in this ${input.where} was written by an agent, so there is nothing to consolidate.`;
  return null;
}

/** A scope's memory as the panel draws it, and every write a person can make from it. */
export interface MemoryPanelState {
  lists: MemoryLists;
  consolidations: MemoryConsolidationView[];
  isLoading: boolean;
  /** Why the list could not be read, or why the last write wrote nothing. */
  problem: string | null;
  busy: boolean;
  add: (body: string, done?: () => void) => void;
  edit: (id: string, body: string, done?: () => void) => void;
  retire: (id: string) => void;
  restore: (id: string) => void;
  restoreConsolidation: (consolidationId: string) => void;
  /**
   * Asking for the scope to be consolidated now (EO-589): why it cannot
   * be (`blocker`), what the last answer said (`message`), and the ask.
   */
  consolidateNow: { blocker: string | null; message: string | null; pending: boolean; ask: () => void };
}

/**
 * A scope's memory and every write a person can make to it.
 *
 * Each write is one `memory:*` command and re-reads the scope after it.
 * A write the main process refused answers `{ ok: false, problem }`
 * rather than throwing, so that sentence is shown where the person
 * pressed, exactly as a thrown error is.
 *
 * Agents write memory too (`memory_note`, extraction after a run), so a
 * run changing is also a reason to read the scope again.
 */
export function useMemoryPanel(scope: MemoryScope): MemoryPanelState {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const list = useQuery({
    queryKey: memoryEntriesKey(scope),
    queryFn: () => ipcQuery("memory:list", { scope, includeRetired: true }),
  });
  const consolidations = useQuery({
    queryKey: memoryConsolidationsKey(scope),
    queryFn: () => ipcQuery("memory:consolidations", { scope }),
  });
  useInvalidateOnPush("runs:changed", [...memoryRootKey, scope.kind, scope.id]);
  // …and on a sync, which is how an entry another desktop wrote to a
  // project the organisation holds arrives here (EO-482).
  useInvalidateOnPush("items:changed", [...memoryRootKey, scope.kind, scope.id]);
  // …and when one of its consolidations is queued, starts or finishes
  // (EO-589): the history, its entries and Consolidate now.
  useInvalidateOnPush("memory:changed", [...memoryRootKey, scope.kind, scope.id], {
    filter: (push) => push.scope.kind === scope.kind && push.scope.id === scope.id,
  });
  // Whether EO is paused, as the rail's toggle reads and writes it.
  const engine = useQuery({ queryKey: engineStatusKey, queryFn: () => ipcQuery("engine:status", undefined) });
  useInvalidateOnPush("runs:changed", engineStatusKey);
  const [consolidateMessage, setConsolidateMessage] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: [...memoryRootKey, scope.kind, scope.id] });
  const settle = (result: MemoryWriteResult | { ok: false; problem: string } | { ok: true }, done?: () => void) => {
    if (result.ok) {
      setProblem(null);
      done?.();
    } else {
      setProblem(result.problem);
    }
    refresh();
  };
  const onError = (error: Error) => setProblem(error.message);

  const add = useMutation({ mutationFn: (body: string) => ipcQuery("memory:add", { scope, body }), onError });
  const edit = useMutation({ mutationFn: (input: { id: string; body: string }) => ipcQuery("memory:edit", input), onError });
  const retire = useMutation({ mutationFn: (id: string) => ipcQuery("memory:retire", { id }), onSuccess: (result) => settle(result), onError });
  const restore = useMutation({ mutationFn: (id: string) => ipcQuery("memory:restore", { id }), onSuccess: (result) => settle(result), onError });
  const undo = useMutation({
    mutationFn: (consolidationId: string) => ipcQuery("memory:restoreConsolidation", { consolidationId }),
    onSuccess: (result) => settle(result),
    onError,
  });

  const consolidate = useMutation({
    mutationFn: () => ipcQuery("memory:consolidateNow", { scope }),
    onSuccess: (result) => {
      setConsolidateMessage(result.message);
      refresh();
    },
    onError,
  });

  const readProblem = list.error?.message ?? consolidations.error?.message ?? null;
  const agentEntries = (list.data?.entries ?? []).filter((entry) => entry.retiredAt === null && entry.source.type !== "person").length;
  return {
    lists: splitMemory(list.data?.entries ?? []),
    consolidations: consolidations.data?.consolidations ?? [],
    isLoading: list.isLoading,
    problem: problem ?? readProblem,
    busy: add.isPending || edit.isPending || retire.isPending || restore.isPending || undo.isPending,
    add: (body, done) => add.mutate(body, { onSuccess: (result) => settle(result, done) }),
    edit: (id, body, done) => edit.mutate({ id, body }, { onSuccess: (result) => settle(result, done) }),
    retire: (id) => retire.mutate(id),
    restore: (id) => restore.mutate(id),
    restoreConsolidation: (consolidationId) => undo.mutate(consolidationId),
    consolidateNow: {
      blocker: consolidateNowBlocker({
        where: scope.kind,
        pending: consolidations.data?.pending ?? null,
        paused: engine.data?.paused ?? false,
        agentEntries,
      }),
      message: consolidateMessage,
      pending: consolidate.isPending,
      ask: () => consolidate.mutate(),
    },
  };
}

/** The sentence under the panel's heading: what memory is, for somebody meeting it here first. */
export function memoryIntro(scope: MemoryScope): string {
  if (scope.kind === "container") {
    return "What agents should know only while the work filed here is in progress. Every run on an item under it is given the entries that bear on its task. When every item is finished, EO moves what still holds to the project and retires the rest; Restore puts them back.";
  }
  return scope.kind === "project"
    ? "What agents should know across this whole project. Every run on it is given the entries that bear on its task."
    : "What agents should know about this workspace. Every run whose step works here is given the entries that bear on its task.";
}

/** The count beside the heading. */
export function memoryCount(active: number): string {
  return `${active} active ${active === 1 ? "entry" : "entries"}`;
}
