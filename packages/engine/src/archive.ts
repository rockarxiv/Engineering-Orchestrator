import type { Item, Uuid } from "@eo/core";

export interface ArchiveCandidate {
  item: Item;
  /**
   * When it entered the terminal state it is in now, from the
   * `transitions` row that put it there.
   *
   * Deliberately not `updatedAt`: any edit bumps that, so a comment on
   * a finished item would reset its clock and a busy thread could
   * keep a done item on the project indefinitely. Null when no
   * transition recorded it — an item seeded straight into a terminal
   * state, or one that predates the audit — and null means not
   * archivable, because there is no honest answer to "how long".
   */
  terminalSince: number | null;
  /**
   * Whether this item is standing on a terminal step **of the version it
   * entered on** (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * Per candidate rather than one `terminalStepIds` set for the whole
   * sweep, and that is the whole of the change: whether a step is
   * terminal is a property of a *version*, so two items on the same step
   * can honestly disagree about it. One entered before a save marked the
   * step terminal and has more to do; the other entered after and is
   * done. A single set could only ever have told them the same thing —
   * and the wrong answer here does not draw something oddly, it puts
   * live work in the Archive.
   *
   * False for an item on no step: a feature is finished when its stories
   * are, which is decided below from theirs.
   */
  finished: boolean;
}

export interface ArchiveInput {
  candidates: ArchiveCandidate[];
  /** How long an item must have been finished. 0 archives as soon as it is done. */
  delayMs: number;
  now: number;
}

/**
 * Which items have been finished long enough to leave the project
 * (KAN-33).
 *
 * Pure, because the rule is worth testing without a database and
 * `packages/engine` may not touch one (invariant 2). The caller reads
 * the rows, this decides, the caller writes.
 *
 * Two things it will not do:
 *
 * **Archive anything that is not finished.** Age alone is never a
 * reason. An item sitting in `blocked` for a month is exactly what
 * someone needs to see, and quietly hiding it would turn this from
 * tidying into losing work.
 *
 * **Archive a feature with live work under it.** A feature can be
 * terminal while a story below it is not — a rejected story reopens the
 * work without reopening its parent — and archiving the parent would
 * leave the child visible with nothing above it. The subtree goes
 * together or not at all.
 */
export function archivableItems(input: ArchiveInput): Item[] {
  const { candidates, delayMs, now } = input;

  const longEnough = (terminalSince: number | null): boolean => terminalSince !== null && now - terminalSince >= delayMs;

  /**
   * An item on a pipeline is finished when its step is terminal.
   *
   * An item on none is a feature (ARCHITECTURE.md, "One work entity"), and asking which column it
   * is
   * in was always the wrong question: it is finished when the work it
   * owns is. Its clock is the last of its stories to finish, so a feature
   * whose final story landed a minute ago is a minute old here, not as
   * old as whenever someone approved its plan.
   */
  const childrenOf = new Map<Uuid, ArchiveCandidate[]>();
  for (const candidate of candidates) {
    const parentId = candidate.item.parentId;
    if (parentId === null) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(candidate);
    else childrenOf.set(parentId, [candidate]);
  }

  const isDone = ({ item, terminalSince, finished }: ArchiveCandidate): boolean => {
    if (item.stepId !== null) return finished && longEnough(terminalSince);

    // No stories means no evidence it is done — a feature whose plan
    // nobody approved yet is not finished, it has not started.
    const children = childrenOf.get(item.id) ?? [];
    if (children.length === 0) return false;
    if (!children.every((child) => child.item.stepId !== null && child.finished)) return false;
    const last = children.map((child) => child.terminalSince).reduce<number | null>((latest, at) => (at === null || latest === null ? null : Math.max(latest, at)), 0);
    return longEnough(last);
  };

  const eligible = new Map<Uuid, ArchiveCandidate>();
  for (const candidate of candidates) {
    if (isDone(candidate)) eligible.set(candidate.item.id, candidate);
  }

  // A parent waits for its whole subtree. Checked against *every*
  // candidate rather than only the eligible ones, so a child that is
  // still in `todo` — and therefore never in `eligible` at all — is
  // what holds its feature back.
  const liveChildParents = new Set<Uuid>();
  for (const { item } of candidates) {
    if (item.parentId !== null && !eligible.has(item.id)) {
      liveChildParents.add(item.parentId);
    }
  }

  return [...eligible.values()].filter(({ item }) => !liveChildParents.has(item.id)).map(({ item }) => item);
}
