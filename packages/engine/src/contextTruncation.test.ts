import { describe, expect, it } from "vitest";
import { fitCommentThread, type AttributedComment } from "./context.js";

/**
 * `fitCommentThread` returns the *fewest* drops that fit the budget, and
 * it finds them by walking upwards from a floor rather than from zero.
 * These tests exist to prove the floor never overshoots.
 *
 * The first attempt at that floor did overshoot, and a differential run
 * over 1680 threads of up to 120 comments could not see it — the
 * divergence needed 200+ comments before it showed. So the sizes here are
 * deliberate, not incidental: a version of this that exercised only small
 * threads would have passed the bug.
 *
 * The comparison is against the same function with `skipImpossible:
 * false`, which is the exhaustive scan from zero that this replaced.
 * Reimplementing the renderer here would test this file against itself.
 */

/** Deterministic, so a failure is a reproduction rather than a report. */
function rng(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

const KINDS = ["note", "question", "decision", "approval", "rejection", "escalation"] as const;

/**
 * A thread carrying the shapes that matter: deep nesting, replies older
 * than their parents, pinned comments, comments with attachments, human
 * comments and questions — everything that changes what may be given up,
 * in what order, or how deeply something is indented.
 */
function thread(seed: number, size: number): AttributedComment[] {
  const random = rng(seed);
  const out: AttributedComment[] = [];
  for (let i = 0; i < size; i++) {
    const human = random() < 0.3;
    const parent = out.length > 0 && random() < 0.55 ? out[Math.floor(random() * out.length)] : undefined;
    const hasAttachment = random() < 0.05;
    out.push({
      id: `${String(i).padStart(8, "0")}-0000-7000-8000-000000000000` as AttributedComment["id"],
      parentId: parent?.id ?? null,
      authorType: human ? "human" : "agent",
      authorName: human ? "you" : "implementer",
      authorRole: human ? null : "implementer",
      kind: KINDS[Math.floor(random() * KINDS.length)]!,
      // Prefixed so a body can be looked for: the tier properties below
      // ask whether a particular comment survived, and 300 x's cannot
      // answer that.
      body: `[c${i}] ` + "x".repeat(1 + Math.floor(random() * 300)),
      // Deliberately not monotonic: a reply may sort before its parent,
      // which is what breaks a depth read off creation order.
      createdAt: Math.floor(random() * size) * 1000,
      pinned: random() < 0.08,
      attachments: hasAttachment
        ? [{ id: `${String(i).padStart(8, "0")}-0000-7000-9000-000000000000` as AttributedComment["id"], name: "diff.patch", mimeType: "text/plain", size: 12, origin: "eo", synchronizationState: "local" }]
        : [],
    });
  }
  return out;
}

/**
 * The same thread with one exchange far larger than a single `comment_read`
 * can bring back.
 *
 * `thread()` never grows one that big at these sizes — measured, not
 * assumed: over every seed and size below, no question had more than fifty
 * comments beneath it. So the retrievability bound would have been asserted
 * only over threads that could not have broken it, which is the way a test
 * passes without checking anything.
 */
function wideThread(seed: number, size: number): AttributedComment[] {
  const comments = thread(seed, size);
  const hub = comments[0];
  if (!hub) return comments;
  // Every parent in `thread` is an earlier comment, so re-parenting later
  // ones onto the first cannot make a cycle.
  return [
    { ...hub, kind: "question" as const, parentId: null },
    ...comments.slice(1).map((comment, index) => (index < 80 ? { ...comment, parentId: hub.id } : comment)),
  ];
}

describe("skipping the impossible drop counts", () => {
  // The reference scan is slow by construction — that is what it is for.
  it("gives the same answer as scanning from zero, on threads long enough to show a difference", { timeout: 120_000 }, () => {
    // `wideThread` is here because the floor's arithmetic has to hold over
    // an exchange too big to collapse as well as over ones that collapse:
    // a refused question leaves answers that no step can remove, and a
    // bound that assumed every answer was reachable would overshoot there.
    for (const [build, size] of [[thread, 220], [thread, 400], [thread, 800], [wideThread, 220]] as const) {
      for (const seed of [1, 2, 3]) {
        for (const budget of [120, 400, 1_500, 6_000, 40_000]) {
          const comments = build(seed, size);
          const fast = fitCommentThread(comments, budget);
          const exhaustive = fitCommentThread(comments, budget, { skipImpossible: false });

          expect({ size, seed, budget, dropped: fast.droppedCount }).toEqual({ size, seed, budget, dropped: exhaustive.droppedCount });
          expect(fast.text).toBe(exhaustive.text);
        }
      }
    }
  });

  it("agrees on small and degenerate threads too", () => {
    for (const size of [0, 1, 2, 7, 40]) {
      for (const seed of [11, 12, 13]) {
        for (const budget of [1, 60, 200, 800, 20_000]) {
          const comments = thread(seed, size);
          expect(fitCommentThread(comments, budget).droppedCount).toBe(fitCommentThread(comments, budget, { skipImpossible: false }).droppedCount);
        }
      }
    }
  });

  it("agrees when nothing may be dropped at all", () => {
    // Every comment human or pinned, and the budget far too small: the
    // answer is "drop everything droppable", which is nothing.
    const comments = thread(21, 60).map((comment) => ({ ...comment, authorType: "human" as const, pinned: true }));
    const fast = fitCommentThread(comments, 50);
    expect(fast.droppedCount).toBe(0);
    expect(fast.text).toBe(fitCommentThread(comments, 50, { skipImpossible: false }).text);
  });

  it("drops nothing when the whole thread fits", () => {
    const comments = thread(5, 12);
    expect(fitCommentThread(comments, 1_000_000).droppedCount).toBe(0);
  });

  it("is fast enough to be on the dispatch path", () => {
    // The regression this guards: 1600 comments with a reply under each
    // took about 3.5s of synchronous work before the floor existed.
    const comments: AttributedComment[] = [];
    for (let i = 0; i < 1600; i++) {
      const id = `${String(i).padStart(8, "0")}-0000-7000-8000-000000000000` as AttributedComment["id"];
      comments.push({ id, parentId: null, authorType: "agent", authorName: "implementer", authorRole: "implementer", kind: "note", body: `Agent note ${i} ${"x".repeat(200)}`, createdAt: i * 1000, pinned: false, attachments: [] });
      comments.push({ id: `${String(i).padStart(8, "0")}-0000-7000-8001-000000000000` as AttributedComment["id"], parentId: id, authorType: "human", authorName: "you", authorRole: null, kind: "note", body: `Human answer to ${i}`, createdAt: i * 1000 + 1, pinned: false, attachments: [] });
    }

    // `Date.now` rather than `performance`, which this package's lib does
    // not declare — and millisecond resolution is ample against a budget
    // of one second.
    const started = Date.now();
    fitCommentThread(comments, 4_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("is fast enough when every step is a collapse", () => {
    // The same thread with the parents asking rather than telling. Nothing
    // here is chatter, so the floor has to bound a range made entirely of
    // collapses — the arithmetic this story changed. If it bounded only
    // drops, this is where the scan would crawl back up from zero.
    const comments: AttributedComment[] = [];
    for (let i = 0; i < 1600; i++) {
      const id = `${String(i).padStart(8, "0")}-0000-7000-8000-000000000000` as AttributedComment["id"];
      comments.push({ id, parentId: null, authorType: "agent", authorName: "implementer", authorRole: "implementer", kind: "question", body: `Question ${i} ${"x".repeat(200)}`, createdAt: i * 1000, pinned: false, attachments: [] });
      comments.push({ id: `${String(i).padStart(8, "0")}-0000-7000-8001-000000000000` as AttributedComment["id"], parentId: id, authorType: "human", authorName: "you", authorRole: null, kind: "note", body: `Human answer to ${i} ${"y".repeat(200)}`, createdAt: i * 1000 + 1, pinned: false, attachments: [] });
    }

    const started = Date.now();
    fitCommentThread(comments, 4_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/**
 * What the tiers promise, over the same random threads.
 *
 * The differential test above proves the fast scan answers what the slow
 * one would; it says nothing about whether that answer is the right shape.
 * These are the two halves of the tier order that a person or an agent
 * would notice being broken — the top two tiers surviving, and the marker
 * that replaces the third telling the truth about it.
 *
 * Both are checked against the input thread, never against the planner, so
 * a mistake in the planner cannot agree with itself here.
 */
describe("what the tiers keep", () => {
  /**
   * The most replies one `comment_read` answers with (KAN-101).
   *
   * Restated here rather than imported. The number is a contract between
   * two modules, and a test that read it off the module under test would
   * agree with any value that module chose — including one the tool cannot
   * meet, which is the whole failure this guards.
   */
  const COMMENT_READ_REPLY_LIMIT = 50;

  /** Walks up by parentId, which is all "is this an answer?" means. */
  function underAQuestion(comment: AttributedComment, byId: Map<string, AttributedComment>): boolean {
    let parent = comment.parentId === null ? undefined : byId.get(comment.parentId);
    for (let guard = 0; parent && guard < 1000; guard++) {
      if (parent.kind === "question") return true;
      parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
    }
    return false;
  }

  /** Everything below an id — what a fetch by it would have to bring back. */
  function descendantsOf(comments: AttributedComment[], id: string): AttributedComment[] {
    const out: AttributedComment[] = [];
    let frontier = [id];
    for (let guard = 0; frontier.length > 0 && guard < 1000; guard++) {
      const children = comments.filter((comment) => comment.parentId !== null && frontier.includes(String(comment.parentId)));
      out.push(...children);
      frontier = children.map((child) => String(child.id));
    }
    return out;
  }

  it("never gives up a question, at any depth or any budget", () => {
    // Tier one is tier one however deep it sits. A question inside another
    // question's exchange used to disappear into that exchange's marker,
    // which spends the cheapest thing in the thread — the line that lets an
    // agent decide whether to spend anything more.
    for (const size of [40, 220]) {
      for (const seed of [31, 32, 33]) {
        const comments = thread(seed, size);
        for (const budget of [1, 60, 400, 6_000]) {
          const { text } = fitCommentThread(comments, budget);
          for (const comment of comments) {
            if (comment.kind !== "question") continue;
            expect({ seed, size, budget, missing: text.includes(comment.body) ? null : comment.id }).toEqual({ seed, size, budget, missing: null });
          }
        }
      }
    }
  });

  it("never gives up a standalone human comment, at any budget", () => {
    for (const size of [40, 220]) {
      for (const seed of [31, 32, 33]) {
        const comments = thread(seed, size);
        const byId = new Map(comments.map((comment) => [String(comment.id), comment]));
        for (const budget of [1, 60, 400, 6_000]) {
          const { text } = fitCommentThread(comments, budget);
          for (const comment of comments) {
            // An answer is tier three and may be collapsed — retrievably,
            // which the marker test below is what checks.
            if (comment.authorType !== "human" || underAQuestion(comment, byId)) continue;
            expect({ seed, size, budget, missing: text.includes(comment.body) ? null : comment.id }).toEqual({ seed, size, budget, missing: null });
          }
        }
      }
    }
  });

  it("hides exactly what its marker claims, and never more than one fetch returns", () => {
    // Two halves of one promise. "3 replies" where two are visible is a
    // marker describing someone else's exchange; "51 replies" against a
    // fetch bounded at 50 is a way back to most of a person's words, which
    // is the KAN-70 defect wearing a pointer.
    //
    // A comment is counted against the *nearest* marker above it, because
    // that is the one whose id would be followed to reach it. A nested
    // exchange's own marker accounts for its own answers, and neither
    // marker may claim the other's.
    const marker = /\((\d+) repl(?:y|ies) hidden to fit the budget — read them with `mcp__eo__comment_read` on ([0-9a-f-]+)\)/g;
    let checked = 0;
    let overBound = 0;

    for (const [build, size] of [[thread, 40], [thread, 220], [wideThread, 220]] as const) {
      for (const seed of [41, 42, 43]) {
        const comments = build(seed, size);
        const byId = new Map(comments.map((comment) => [String(comment.id), comment]));

        for (const budget of [1, 60, 400, 6_000]) {
          const { text } = fitCommentThread(comments, budget);
          const claimed = new Map([...text.matchAll(marker)].map(([, count, id]) => [id!, Number(count)]));

          const accountedFor = new Map<string, number>();
          const strandedIds: string[] = [];
          for (const comment of comments) {
            if (text.includes(comment.body)) continue;
            let ancestorId = comment.parentId === null ? null : String(comment.parentId);
            while (ancestorId !== null && !claimed.has(ancestorId)) {
              const ancestor = byId.get(ancestorId);
              ancestorId = ancestor?.parentId === undefined || ancestor.parentId === null ? null : String(ancestor.parentId);
            }
            if (ancestorId === null) {
              // Chatter is dropped, and its marker names kinds and counts
              // rather than ids. An *answer* with no marker above it would
              // be a person's words gone with nothing pointing at them.
              if (underAQuestion(comment, byId)) strandedIds.push(String(comment.id));
              continue;
            }
            accountedFor.set(ancestorId, (accountedFor.get(ancestorId) ?? 0) + 1);
          }
          expect({ seed, size, budget, stranded: strandedIds }).toEqual({ seed, size, budget, stranded: [] });

          for (const [id, count] of claimed) {
            checked += 1;
            expect({ seed, size, budget, id, claimed: count }).toEqual({ seed, size, budget, id, claimed: accountedFor.get(id) ?? 0 });

            const below = descendantsOf(comments, id).length;
            expect({ seed, size, budget, id, retrievable: below <= COMMENT_READ_REPLY_LIMIT }).toEqual({ seed, size, budget, id, retrievable: true });
          }

          // The bound only means something if some exchange was big enough
          // to be refused by it — and the `stranded` check above is what
          // says the answers it kept are still on the page.
          for (const comment of comments) {
            if (comment.kind !== "question" || claimed.has(String(comment.id))) continue;
            if (descendantsOf(comments, String(comment.id)).length > COMMENT_READ_REPLY_LIMIT) overBound += 1;
          }
        }
      }
    }

    // A regex that stops matching, or a generator that stopped producing
    // the shapes these turn on, would make every assertion above pass by
    // never running. That is the way this test would rot.
    expect(checked).toBeGreaterThan(0);
    expect(overBound).toBeGreaterThan(0);
  });
});
