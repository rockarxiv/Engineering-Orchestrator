import { gitStateOf, jiraStateOf, type DependencyWait, type Item, type Uuid } from "@eo/core";
import { unwrapAnswer } from "@eo/engine";

/**
 * Where a same-feature dependency's merge request stands, as far as EO
 * can tell (EO-10 / KAN-42).
 *
 * Only a forge lookup can ever produce `'closed'` — a local git check
 * can tell "merged" from "not yet merged" but has no way to tell a
 * still-open MR apart from one closed without merging, so a fallback
 * path must never report this value.
 */
export type MergeState = "merged" | "open" | "closed";

export interface StackDependency {
  /**
   * The dependency item. Its `parentId` and `workspaceId`, with the
   * edge's `wait`, decide whether it is in scope at all (`stacksOn`).
   */
  item: Item;
  /**
   * The dependency's branch: its stored one, or for a dependency not yet
   * dispatched the name it will be cut under (EO-638, `itemBranchName`).
   * Resolved by the caller, which has the database this pure resolver
   * does not, so that a stack target names the same branch dispatch
   * would cut rather than a guess at `eo/<KEY>`.
   */
  branch: string;
  mergeState: MergeState;
  /**
   * Every item *this dependency* depends on, directly or through
   * another item (`dependencyClosure` in the engine's `dag.ts`).
   *
   * This is what tells a genuine sibling apart from a dependency that
   * already contains the others. Optional because a caller that hasn't
   * gathered it yet is asking a narrower question, not a wrong one:
   * absent, every unmerged dependency looks equally close, which is the
   * conservative reading and exactly the behaviour before this existed.
   */
  dependsOn?: Uuid[];
  /**
   * The rule the edge to this dependency waits by (EO-780), which decides
   * whether it can be stacked on at all — `stacksOn`. Absent is
   * `finished`, as everywhere a rule can be left out.
   */
  wait?: DependencyWait;
}

/**
 * Whether `item` may be stacked on `dependency`, by the rule of the edge
 * between them (EO-780, the pinned decision "Which edges stack").
 *
 * - `reached` stacks whenever the two are in the same repository, across
 *   features too: it is the rule that releases an item before its
 *   dependency has finished, so the dependency's work is on a branch the
 *   item has to build on.
 * - `none` never stacks: it is a link kept for the board and the
 *   dependency summary, not a statement about code.
 * - `finished` keeps the same-feature rule stacking always had.
 *
 * The repository is checked here for `reached` because nothing else
 * scopes it; for `finished` the gatherers check it, as they always have.
 */
export function stacksOn(item: Pick<Item, "parentId" | "workspaceId">, dependency: Pick<Item, "parentId" | "workspaceId">, wait: DependencyWait = "finished"): boolean {
  if (wait === "none") return false;
  if (wait === "reached") return dependency.workspaceId !== null && dependency.workspaceId === item.workspaceId;
  return dependency.parentId !== null && dependency.parentId === item.parentId;
}

/**
 * A person's answer to "which of these should this story build on?"
 *
 * `unusable` is not a failure to be swallowed: it carries what was said
 * and why EO could not act on it, so the escalation that follows quotes
 * the reply back rather than repeating the original question word for
 * word — which is what made an unread answer look like EO ignoring it.
 */
export type StackAnswer =
  | { kind: "dependency"; key: string }
  | { kind: "branch"; branch: string }
  | { kind: "unusable"; answer: string; problem: string };

export type StackTargetDecision =
  | { kind: "base" }
  /** `branch` is the dependency's, as its `StackDependency` named it. */
  | { kind: "stack"; dependency: Item; branch: string }
  /** A branch a person named, rather than one EO worked out for itself. */
  | { kind: "branch"; branch: string }
  /**
   * The base branch a person set on the item itself (EO-364) — its
   * `git` extension's `baseBranch`.
   *
   * Its own kind rather than `branch`, though it is handled the same way
   * where the pull request is concerned (no rebase before it opens),
   * because two things about it differ. It is also what the "commits
   * beyond the base" check measures against, where a stacking answer is
   * still judged against the repository's base. And a name the remote
   * does not have is refused, where a stacking answer falls back to the
   * local branch: this one was set before anything was cut, nobody has
   * looked at the remote since, and quietly cutting from a stale local
   * copy is the failure resolving on the remote exists to prevent.
   */
  | { kind: "named-base"; branch: string }
  | {
      kind: "escalate";
      reason: string;
      /**
       * The dependencies a person may pick between, when that is what
       * the escalation is asking. Empty when the escalation is not a
       * choice at all (a dependency closed without merging), which is
       * also what stops a caller offering buttons for a question EO is
       * not asking.
       */
      choices: Item[];
    };

/**
 * Decides where a dependent story's branch/MR should target: the
 * repository's base branch, or a still-unmerged same-parent-feature
 * dependency's branch instead (EO-10 / KAN-42).
 *
 * Pure, and looks only at `item`'s *direct* `depends_on` edges — no
 * graph traversal of its own. A chain resolves itself: if story3 depends
 * only on story2 (which itself depends on story1), story3 only ever sees
 * story2, and story2 is responsible for its own stacking on story1.
 *
 * `dependencies` is the *unfiltered* set of direct dependency edges
 * (annotated with each one's merge state); this function does the
 * filtering itself (`stacksOn`): a dependency its edge's rule does not
 * stack on — another feature under `finished`, any under `none` — is out
 * of scope entirely, not treated as merged.
 *
 * `answer` is what a person replied to a previous escalation from here,
 * and is consulted only when the decision is the one EO asked about: two
 * or more unmerged dependencies with nothing to choose between them.
 * Everything else — a closed dependency, a lone open one — is decided
 * the same way whether an answer exists or not.
 */
export function resolveStackTarget(item: Item, dependencies: StackDependency[], answer?: StackAnswer): StackTargetDecision {
  // A base the person set wins over everything below (EO-364, the pinned
  // decision on EO-363): it is their answer to the question stacking
  // exists to work out, given before anyone asked. That includes a
  // dependency closed without merging — the escalation there is EO
  // refusing to guess, and nothing is being guessed.
  const { baseBranch } = gitStateOf(item);
  if (baseBranch !== null) return { kind: "named-base", branch: baseBranch };

  const stackable = dependencies.filter((dep) => stacksOn(item, dep.item, dep.wait));

  // A dependency closed without merging always escalates, regardless of
  // any other dependency's state — EO must not guess what the dependent
  // should target instead, and must not keep stacking on a dead branch.
  const closed = stackable.filter((dep) => dep.mergeState === "closed");
  if (closed.length > 0) {
    const names = joinKeys(closed.map((dep) => dep.item));
    const verb = closed.length === 1 ? "was" : "were";
    return {
      kind: "escalate",
      reason: `${names} ${verb} closed without merging, so EO will not guess what ${item.key} should target.`,
      choices: [],
    };
  }

  const open = stackable.filter((dep) => dep.mergeState === "open");

  if (open.length === 1) return { kind: "stack", dependency: open[0]!.item, branch: open[0]!.branch };

  if (open.length > 1) {
    // Not every set of unmerged dependencies is a tie. If one of them
    // already depends on all the others, its branch was cut from theirs
    // — stacking on it stacks on all of them, and there is nothing for a
    // person to decide.
    const dominant = dominatingDependency(open);
    if (dominant) return { kind: "stack", dependency: dominant.item, branch: dominant.branch };

    return tiedEscalation(item, open, answer);
  }

  // Zero or zero-remaining unmerged same-feature dependencies.
  return { kind: "base" };
}

/**
 * The one unmerged dependency that transitively depends on every other
 * one, or undefined if no single dependency covers the rest.
 *
 * At most one can qualify: two dependencies that each contained the
 * other would be a cycle, and `addDependency` refuses to persist one.
 * A dependency with no `dependsOn` gathered can only ever cover a set of
 * one other, so an absent closure never invents a winner.
 */
function dominatingDependency(open: StackDependency[]): StackDependency | undefined {
  return open.find((candidate) => {
    const closure = new Set(candidate.dependsOn ?? []);
    return open.every((other) => other === candidate || closure.has(other.item.id));
  });
}

/**
 * Genuine siblings: two or more unmerged dependencies at equal distance,
 * none of them containing the others.
 *
 * EO does not pick, but it does *ask*, and asking means saying what the
 * answers are — one of the dependencies, or a branch to cut from
 * instead. An answer already given is applied here rather than sent back
 * as another identical question, which is the whole point: replying
 * "EO-32" to this escalation and getting it verbatim again is the bug
 * this path exists to fix.
 */
function tiedEscalation(item: Item, open: StackDependency[], answer?: StackAnswer): StackTargetDecision {
  const choices = open.map((dep) => dep.item);

  if (answer?.kind === "branch") return { kind: "branch", branch: answer.branch };

  if (answer?.kind === "dependency") {
    const chosen = open.find((dep) => namesItem(answer.key, dep.item));
    if (chosen) return { kind: "stack", dependency: chosen.item, branch: chosen.branch };
  }

  const names = joinKeys(choices);
  const quantifier = open.length === 2 ? "are both" : "are all";
  const head = `${names} ${quantifier} still open, and none of them builds on the others, so EO does not pick one of equally close dependencies to stack on.`;

  // What was said, and why it did not answer the question. Without this
  // the second escalation is indistinguishable from the first, and a
  // person who did reply has no way to tell that their reply was read.
  const rejected =
    answer?.kind === "unusable"
      ? `EO could not use "${answer.answer}": ${answer.problem}`
      : answer?.kind === "dependency"
        ? `EO could not use "${answer.key}": it is not one of ${item.key}'s unmerged dependencies.`
        : null;

  const invitation = `Reply with the one ${item.key} should build on — ${joinKeys(choices, "or")} — or with the name of a branch to cut from instead.`;

  return {
    kind: "escalate",
    reason: [head, rejected, invitation].filter((part) => part !== null).join("\n\n"),
    choices,
  };
}

/** Does `text` name this item — by EO key, linked Jira key, or branch? */
function namesItem(text: string, item: Item): boolean {
  const candidate = text.trim().toLowerCase();
  return [item.key, jiraStateOf(item).key, gitStateOf(item).branch].some((name) => name !== null && name.toLowerCase() === candidate);
}

/**
 * Reads a person's reply as an answer to a stacking question, against
 * the dependencies they were offered.
 *
 * Null means the reply says nothing about this decision at all (it is
 * empty), which is different from saying something EO cannot use — that
 * comes back as `unusable`, so the caller can quote it (invariant #8:
 * nothing is dropped on the floor silently).
 *
 * Deliberately tolerant about wrapping — a person answering a question
 * about branches types backticks — and deliberately strict about
 * ambiguity: a reply naming two of the choices has not chosen.
 */
export function readStackAnswer(text: string, choices: Item[]): StackAnswer | null {
  const answer = unwrapAnswer(text);
  if (answer === "") return null;

  const named = choices.filter((choice) => mentions(answer, choice));
  if (named.length === 1) return { kind: "dependency", key: named[0]!.key };
  if (named.length > 1) {
    return { kind: "unusable", answer, problem: `it names ${joinKeys(named, "and")}, and EO needs exactly one.` };
  }

  // A single token is either a branch or an item key that isn't on
  // offer. Telling those apart matters: "EO-9" is almost certainly a
  // mistyped choice rather than a branch anyone has, and saying so beats
  // going looking for a branch called EO-9 and reporting it missing.
  if (looksLikeItemKey(answer)) return { kind: "dependency", key: answer };
  if (isPlausibleRef(answer)) return { kind: "branch", branch: answer };

  return {
    kind: "unusable",
    answer,
    problem: "it does not name one of the dependencies, and it is not usable as a branch name.",
  };
}

/**
 * Does the reply name this item? Exactly, or as a word inside a
 * sentence — "let's go with EO-32" is an answer, and refusing to read it
 * as one would be pedantry at the user's expense. Bounded by word
 * boundaries so EO-3 never matches inside EO-32.
 */
function mentions(answer: string, item: Item): boolean {
  if (namesItem(answer, item)) return true;
  return [item.key, jiraStateOf(item).key, gitStateOf(item).branch].some((name) => {
    if (name === null) return false;
    return new RegExp(`(^|[^\\w/-])${escapeRegExp(name)}($|[^\\w-])`, "i").test(answer);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeItemKey(text: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(text);
}

/**
 * Could this be a git ref name? A subset of `git check-ref-format`'s
 * rules — enough to reject a sentence, a path fragment or a control
 * character, and permissive enough not to reject a name git would
 * accept. Whether the ref actually *exists* is not a question a pure
 * function can answer; the adapter checks that against the repository
 * (invariant #5).
 */
function isPlausibleRef(text: string): boolean {
  if (text.length === 0 || text.length > 255) return false;
  if (/\s/.test(text)) return false;
  if (/[~^:?*[\\]/.test(text)) return false;
  if (text.includes("..") || text.includes("@{") || text.includes("//")) return false;
  if (text.startsWith("/") || text.startsWith("-") || text.startsWith(".")) return false;
  if (text.endsWith("/") || text.endsWith(".") || text.endsWith(".lock")) return false;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }

  return true;
}

/** "A" | "A and B" | "A, B, and C" — or with any other final conjunction. */
function joinKeys(items: Item[], conjunction = "and"): string {
  const keys = items.map((item) => item.key);
  if (keys.length === 1) return keys[0]!;
  if (keys.length === 2) return `${keys[0]} ${conjunction} ${keys[1]}`;
  return `${keys.slice(0, -1).join(", ")}, ${conjunction} ${keys[keys.length - 1]}`;
}
