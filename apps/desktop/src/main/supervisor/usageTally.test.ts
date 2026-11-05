import { describe, expect, it } from "vitest";
import type { UsageEvent } from "@eo/core";
import { createUsageTally, sessionTotalBefore, type ThreadRunUsage, type ThreadUsage, type UsageTally } from "./usageTally.js";

const turn = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  type: "usage",
  scope: "turn",
  tokensIn: 1_000,
  tokensOut: 100,
  ...overrides,
});

const session = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  type: "usage",
  scope: "session",
  tokensIn: 1_000,
  tokensOut: 100,
  ...overrides,
});

describe("createUsageTally", () => {
  it("adds turn-scoped readings up — the Codex shape", () => {
    const tally = createUsageTally();
    tally.record(turn({ tokensIn: 16_000, tokensOut: 200, cacheReadTokens: 0 }));
    tally.record(turn({ tokensIn: 17_500, tokensOut: 300, cacheReadTokens: 16_000 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 33_500, tokensOut: 500, cacheReadTokens: 16_000, turns: 2 });
  });

  it("replaces session-scoped readings — the Claude shape", () => {
    // The SDK re-reports a running total on every result and says to
    // read the latest. Summing these would charge the first turn again
    // for every turn after it.
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 40_000, tokensOut: 900, turns: 3 }));
    tally.record(session({ tokensIn: 95_000, tokensOut: 2_100, turns: 7 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 95_000, tokensOut: 2_100, turns: 7 });
  });

  it("counts a turn-scoped reading that does not say as the one turn it is", () => {
    const tally = createUsageTally();
    tally.record(turn());
    tally.record(turn());

    expect(tally.totals().turns).toBe(2);
  });

  it("banks the running total when the run opens a second stream", () => {
    // A corrective turn (A-02) is a fresh `resume()`, and a resumed
    // Claude session starts its running total again from zero. Without
    // the commit the second stream's first reading would replace the
    // account of everything already paid for.
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 95_000, tokensOut: 2_100, turns: 7 }));

    tally.commit();
    tally.record(session({ tokensIn: 12_000, tokensOut: 400, turns: 1 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 107_000, tokensOut: 2_500 });
  });

  it("takes a session's turn count as a high-water mark rather than banking it", () => {
    // Tokens are documented to start fresh on a resumed session; the
    // turn count carries no such note, and the fields either side of it
    // do. If it is counting the whole conversation, adding the readings
    // reports a 15-turn run that took 8 — so the larger claim wins and a
    // reset costs at most the corrective turn.
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 95_000, turns: 7 }));
    tally.commit();
    tally.record(session({ tokensIn: 12_000, turns: 1 }));

    expect(tally.totals().turns).toBe(7);
  });

  it("follows a conversation-wide turn count upwards", () => {
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 95_000, turns: 7 }));
    tally.commit();
    tally.record(session({ tokensIn: 12_000, turns: 8 })); // the same conversation, one turn further on

    expect(tally.totals().turns).toBe(8);
  });

  it("still banks turn-scoped counts across streams — those are one reading per turn", () => {
    const tally = createUsageTally();
    tally.record(turn({ tokensIn: 16_000 }));
    tally.record(turn({ tokensIn: 16_000 }));
    tally.commit();
    tally.record(turn({ tokensIn: 16_000 }));

    expect(tally.totals().turns).toBe(3);
  });

  it("leaves a figure the backend never reported as null, not as zero", () => {
    // The distinction the run row exists to keep: a backend that says
    // nothing about caching has not told us the cache was cold. Rendered
    // as 0 it becomes "0% cached", which is a claim nobody made.
    const tally = createUsageTally();
    tally.record(turn({ tokensIn: 16_000, tokensOut: 200 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 16_000, cacheReadTokens: null, cacheWriteTokens: null });
  });

  it("keeps a reported zero as a zero — that one is an answer", () => {
    const tally = createUsageTally();
    tally.record(turn({ tokensIn: 16_000, cacheReadTokens: 0 }));

    expect(tally.totals().cacheReadTokens).toBe(0);
  });

  it("adds a reported figure to readings that carried none, rather than dropping either", () => {
    // A stream can report the cache split on some turns and not others.
    // Two unknowns must not make a zero — `cacheWriteTokens` here, which
    // nothing reported — and one unknown must not erase the number
    // beside it.
    const tally = createUsageTally();
    tally.record(turn({ tokensIn: 16_000 }));
    tally.record(turn({ tokensIn: 17_000, cacheReadTokens: 16_000 }));
    tally.record(turn({ tokensIn: 12_000 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 45_000, cacheReadTokens: 16_000, cacheWriteTokens: null });
  });

  it("will not let a later session reading move a figure backwards", () => {
    // A running total is meant to grow. The SDK names a way it may not —
    // a mid-session `/clear` "resets the running total" — which arrives
    // as a smaller reading rather than an empty one, and would write a
    // number backwards, or a figure the earlier reading carried back to
    // null.
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 90_000, tokensOut: 2_000, cacheReadTokens: 70_000, costCents: 63 }));
    tally.record(session({ tokensIn: 12_000, tokensOut: 300, costCents: 0 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 90_000, tokensOut: 2_000, cacheReadTokens: 70_000, costCents: 63 });
  });

  it("keeps a reading that carries money but no tokens — cost is what the budget guards count", () => {
    const tally = createUsageTally();

    expect(tally.record(session({ tokensIn: 0, tokensOut: 0, costCents: 17 }))).toBe(true);
    expect(tally.totals().costCents).toBe(17);
  });

  describe("the cost to the micro-cent (EO-510)", () => {
    it("sums turn readings and keeps the latest session reading, as costCents does", () => {
      const codex = createUsageTally();
      codex.record(turn({ costCents: 0, costMicrocents: 40_000 }));
      codex.record(turn({ costCents: 0, costMicrocents: 32_130 }));
      expect(codex.costMicrocents()).toBe(72_130);
      expect(codex.totals().costCents).toBe(0);

      const claude = createUsageTally();
      claude.record(session({ costCents: 0, costMicrocents: 400_000 }));
      claude.record(session({ costCents: 1, costMicrocents: 650_000 }));
      expect(claude.costMicrocents()).toBe(650_000);
    });

    it("reads a reading with only whole cents as that many cents", () => {
      const tally = createUsageTally();
      tally.record(turn({ costCents: 3 }));
      tally.record(turn({}));

      expect(tally.costMicrocents()).toBe(3_000_000);
    });

    it("keeps a reading whose only money is a fraction of a cent", () => {
      const tally = createUsageTally();

      expect(tally.record(session({ tokensIn: 0, tokensOut: 0, costCents: 0, costMicrocents: 400_000 }))).toBe(true);
      expect(tally.costMicrocents()).toBe(400_000);
    });

    it("leaves the totals a run's row is written from as they were", () => {
      const tally = createUsageTally();
      tally.record(session({ costCents: 2, costMicrocents: 2_340_000 }));

      expect(tally.totals()).not.toHaveProperty("costMicrocents");
      expect(tally.totals().costCents).toBe(2);
    });
  });

  it("reports an entirely empty reading as nothing to record", () => {
    // The caller persists only what changed, so a run whose sole reading
    // was an empty crash result keeps its nulls instead of claiming
    // `0 in / 0 out`.
    const tally = createUsageTally();

    expect(tally.record(session({ tokensIn: 0, tokensOut: 0 }))).toBe(false);
  });

  it("says which rule the turn count follows, since the two do not aggregate alike", () => {
    const codex = createUsageTally();
    codex.record(turn({ tokensIn: 1_000 }));
    expect(codex.totals().turnsScope).toBe("turn");

    const claude = createUsageTally();
    claude.record(session({ tokensIn: 1_000, turns: 9 }));
    expect(claude.totals().turnsScope).toBe("session");
  });

  it("ignores a zeroed session reading rather than letting it wipe the account", () => {
    // The SDK documents that a crash or startup-error result may carry
    // zeroed values. A session reading *replaces*, so an empty one would
    // discard everything the stream had reported up to that point — and
    // the run would end recording nothing at all.
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 95_000, tokensOut: 2_100, turns: 7 }));
    tally.record(session({ tokensIn: 0, tokensOut: 0, turns: 0 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 95_000, tokensOut: 2_100, turns: 7 });
  });

  it("says nothing before anything has been said", () => {
    expect(createUsageTally().totals()).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      turns: null,
      turnsScope: null,
      costCents: 0,
    });
  });
});

describe("a resumed thread (EO-490)", () => {
  // EO-486's two implement runs, as the CLI's transcript has them: the
  // second run's every reading is the first run's spend plus its own.
  const run1 = { tokensIn: 5_826_855, tokensOut: 43_410, cacheWriteTokens: 120_181, costCents: 297 };
  const run2 = { tokensIn: 2_661_773, tokensOut: 12_255, cacheWriteTokens: 33_293, costCents: 104 };
  const recorded = (totals: ReturnType<ReturnType<typeof createUsageTally>["totals"]>): ThreadUsage => ({
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costCents: totals.costCents,
  });

  it("records only the resumed run's own usage when the session total carried on from the earlier run", () => {
    const first = createUsageTally();
    first.record(session({ ...run1, turns: 31 }));

    const second = createUsageTally({ earlierOnThread: recorded(first.totals()) });
    // T1 + part of T2, then T1 + T2: repeated readings still replace.
    second.record(
      session({ tokensIn: run1.tokensIn + 1_000_000, tokensOut: run1.tokensOut + 5_000, cacheWriteTokens: run1.cacheWriteTokens + 10_000, costCents: run1.costCents + 40, turns: 6 }),
    );
    second.record(
      session({
        tokensIn: run1.tokensIn + run2.tokensIn,
        tokensOut: run1.tokensOut + run2.tokensOut,
        cacheWriteTokens: run1.cacheWriteTokens + run2.cacheWriteTokens,
        costCents: run1.costCents + run2.costCents,
        turns: 18,
      }),
    );

    // The turn count is the query's own already, and is not touched.
    expect(second.totals()).toMatchObject({ ...run2, turns: 18 });
  });

  it("takes a first reading smaller than the thread's earlier spend as the run's own — the session started again", () => {
    const earlierOnThread: ThreadUsage = { tokensIn: 900_000, tokensOut: 9_000, cacheReadTokens: 800_000, cacheWriteTokens: 50_000, costCents: 120 };
    const tally = createUsageTally({ earlierOnThread });
    tally.record(session({ tokensIn: 300_000, tokensOut: 2_000, cacheReadTokens: 250_000, cacheWriteTokens: 20_000, costCents: 40 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 300_000, tokensOut: 2_000, cacheReadTokens: 250_000, cacheWriteTokens: 20_000, costCents: 40 });
  });

  it("reads a running total that fell short in any one figure as restarted, not as a negative or a zero", () => {
    // More input than the earlier run, less output: a total that had
    // carried on from it could not be smaller anywhere.
    const tally = createUsageTally({ earlierOnThread: { tokensIn: 100_000, tokensOut: 9_000, cacheReadTokens: null, cacheWriteTokens: null, costCents: 30 } });
    tally.record(session({ tokensIn: 150_000, tokensOut: 1_000, costCents: 35 }));
    tally.record(session({ tokensIn: 180_000, tokensOut: 1_500, costCents: 41 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 180_000, tokensOut: 1_500, costCents: 41 });
  });

  it("counts a corrective turn once when the session total carries on into it", () => {
    // The CLI restores the session's cost on every resume, the corrective
    // one included: the second stream's reading holds the first stream's.
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 95_000, tokensOut: 2_100, costCents: 60, turns: 7 }));
    tally.commit();
    tally.record(session({ tokensIn: 107_000, tokensOut: 2_500, costCents: 68, turns: 1 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 107_000, tokensOut: 2_500, costCents: 68 });
  });

  it("measures a resumed run's corrective turn against the thread and the run's own first stream together", () => {
    const tally = createUsageTally({ earlierOnThread: { tokensIn: 500_000, tokensOut: 5_000, cacheReadTokens: null, cacheWriteTokens: null, costCents: 200 } });
    tally.record(session({ tokensIn: 600_000, tokensOut: 6_000, costCents: 250 })); // this run: 100k / 1k / 50¢
    tally.commit();
    tally.record(session({ tokensIn: 610_000, tokensOut: 6_200, costCents: 254 })); // the correction: 10k / 200 / 4¢

    expect(tally.totals()).toMatchObject({ tokensIn: 110_000, tokensOut: 1_200, costCents: 54 });
  });

  it("measures a corrective turn after a restart from the restarted session's total, not the thread's", () => {
    // The first stream proved the thread's earlier spend absent from the
    // session. The correction then carries on from the restarted total,
    // and must be measured against that: measured against the obsolete
    // figure, it would look restarted too and count the first stream again.
    const tally = createUsageTally({ earlierOnThread: { tokensIn: 900_000, tokensOut: 9_000, cacheReadTokens: null, cacheWriteTokens: null, costCents: 120 } });
    tally.record(session({ tokensIn: 300_000, tokensOut: 2_000, costCents: 40 }));
    tally.commit();
    tally.record(session({ tokensIn: 310_000, tokensOut: 2_200, costCents: 44 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 310_000, tokensOut: 2_200, costCents: 44 });
  });

  it("still adds a corrective turn that restarted again after a restart", () => {
    const tally = createUsageTally({ earlierOnThread: { tokensIn: 900_000, tokensOut: 9_000, cacheReadTokens: null, cacheWriteTokens: null, costCents: 120 } });
    tally.record(session({ tokensIn: 300_000, tokensOut: 2_000, costCents: 40 }));
    tally.commit();
    tally.record(session({ tokensIn: 10_000, tokensOut: 200, costCents: 4 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 310_000, tokensOut: 2_200, costCents: 44 });
  });

  it("leaves turn-scoped readings alone — a Codex turn is already its own", () => {
    const tally = createUsageTally({ earlierOnThread: { tokensIn: 500_000, tokensOut: 5_000, cacheReadTokens: 400_000, cacheWriteTokens: null, costCents: 0 } });
    tally.record(turn({ tokensIn: 16_000, tokensOut: 200, cacheReadTokens: 12_000 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 16_000, tokensOut: 200, cacheReadTokens: 12_000, turns: 1 });
  });
});

describe("a thread with rows from before EO-490 (EO-504)", () => {
  const usage = (tokensIn: number, tokensOut: number, costCents: number): ThreadUsage => ({ tokensIn, tokensOut, cacheReadTokens: null, cacheWriteTokens: null, costCents });
  /** A row written before EO-504: what the run recorded and nothing about the session. */
  const before504 = (recorded: ThreadUsage): ThreadRunUsage => ({ recorded, sessionEndedOn: null });
  const own = (tally: UsageTally): ThreadUsage => {
    const { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costCents } = tally.totals();
    return { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costCents };
  };
  /** A run as the supervisor has it: started from the thread's history, its row both figures. */
  const runOn = (history: readonly ThreadRunUsage[], readings: readonly ThreadUsage[]): { row: ThreadRunUsage; tally: UsageTally } => {
    const tally = createUsageTally({ earlierOnThread: sessionTotalBefore(history) });
    for (const reading of readings) tally.record(session({ tokensIn: reading.tokensIn, tokensOut: reading.tokensOut, costCents: reading.costCents }));
    return { row: { recorded: own(tally), sessionEndedOn: tally.sessionTotal() }, tally };
  };

  // Thread 35736da7's shape: three resumed runs from before EO-490, each
  // recording the session's whole total. Their sum is 6.49M in, the
  // session's real total 3.06M.
  const preFix = [before504(usage(1_000_000, 10_000, 120)), before504(usage(2_430_000, 18_000, 260)), before504(usage(3_060_000, 22_156, 386))];

  it("records a new run's own spend, not the whole total, when the earlier rows add up to more than the session", () => {
    const sumOfRows = preFix.reduce((total, row) => total + row.recorded!.tokensIn, 0);
    expect(sumOfRows).toBe(6_490_000);

    // The fourth run spends 500k in, 5k out and 60¢.
    const { row } = runOn(preFix, [usage(3_560_000, 27_156, 446)]);

    expect(row.recorded).toEqual(usage(500_000, 5_000, 60));
  });

  it("is what the sum of the rows got wrong: read against it, the same run is recorded whole", () => {
    const summed = preFix.reduce((total, row) => ({ ...total, tokensIn: total.tokensIn + row.recorded!.tokensIn, tokensOut: total.tokensOut + row.recorded!.tokensOut, costCents: total.costCents + row.recorded!.costCents }), usage(0, 0, 0));
    const tally = createUsageTally({ earlierOnThread: summed });
    tally.record(session({ tokensIn: 3_560_000, tokensOut: 27_156, costCents: 446 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 3_560_000, tokensOut: 27_156, costCents: 446 });
  });

  it("and every run after it records its own share too, rather than the inflation compounding", () => {
    const fourth = runOn(preFix, [usage(3_560_000, 27_156, 446)]).row;
    const fifth = runOn([...preFix, fourth], [usage(3_800_000, 30_000, 480)]).row;
    const sixth = runOn([...preFix, fourth, fifth], [usage(3_900_000, 31_000, 500)]).row;

    expect(fifth.recorded).toEqual(usage(240_000, 2_844, 34));
    expect(sixth.recorded).toEqual(usage(100_000, 1_000, 20));
  });

  it("reads a row between EO-490 and EO-504 that recorded a share as a share", () => {
    // A pre-fix row, then one that EO-490 read correctly: 200k of its own.
    const history = [before504(usage(3_060_000, 22_156, 386)), before504(usage(200_000, 2_000, 30))];
    expect(sessionTotalBefore(history)).toEqual(usage(3_260_000, 24_156, 416));

    const { row } = runOn(history, [usage(3_760_000, 29_156, 476)]);
    expect(row.recorded).toEqual(usage(500_000, 5_000, 60));
  });

  it("reads a row between EO-490 and EO-504 that this bug made record the whole total as the whole total", () => {
    const history = [before504(usage(1_000_000, 10_000, 120)), before504(usage(1_000_000, 10_000, 120)), before504(usage(1_300_000, 12_000, 150))];
    expect(sessionTotalBefore(history)).toEqual(usage(1_300_000, 12_000, 150));
  });

  it("misreads a session that restarted before EO-490 as a share, charging the next run whole once and no more", () => {
    // Two whole totals from before EO-490, the second after a restart:
    // the session really stands at 10k. A row below the total so far is
    // read as a share, because a share recorded between EO-490 and EO-504
    // looks exactly like it, so the thread is taken to stand at 110k.
    const history = [before504(usage(100_000, 1_000, 100)), before504(usage(10_000, 100, 10))];
    expect(sessionTotalBefore(history)).toEqual(usage(110_000, 1_100, 110));

    // The next run spends 10k / 100 / 10¢; its reading is below 110k, so
    // it is read as a restart and recorded whole — never as a negative
    // or a zero.
    const next = runOn(history, [usage(20_000, 200, 20)]).row;
    expect(next.recorded).toEqual(usage(20_000, 200, 20));
    // It records where the session really stands, so the run after it is exact.
    expect(next.sessionEndedOn).toEqual(usage(20_000, 200, 20));
    expect(runOn([...history, next], [usage(25_000, 260, 26)]).row.recorded).toEqual(usage(5_000, 60, 6));
  });

  it("skips a run that recorded nothing", () => {
    expect(sessionTotalBefore([before504(usage(1_000_000, 10_000, 120)), { recorded: null, sessionEndedOn: null }])).toEqual(usage(1_000_000, 10_000, 120));
    expect(sessionTotalBefore([])).toBeNull();
    expect(sessionTotalBefore([{ recorded: null, sessionEndedOn: null }])).toBeNull();
  });
});

describe("where a run left the session (EO-504)", () => {
  const usage = (tokensIn: number, tokensOut: number, costCents: number): ThreadUsage => ({ tokensIn, tokensOut, cacheReadTokens: null, cacheWriteTokens: null, costCents });

  it("records each run's own share on a thread whose runs all came after the fix", () => {
    const history: ThreadRunUsage[] = [];
    const shares: ThreadUsage[] = [];
    // The CLI's running total at the end of each of three runs.
    for (const total of [usage(400_000, 4_000, 50), usage(700_000, 6_000, 90), usage(1_000_000, 9_500, 125)]) {
      const tally = createUsageTally({ earlierOnThread: sessionTotalBefore(history) });
      tally.record(session({ tokensIn: total.tokensIn, tokensOut: total.tokensOut, costCents: total.costCents }));
      const { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costCents } = tally.totals();
      shares.push({ tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, costCents });
      history.push({ recorded: shares.at(-1)!, sessionEndedOn: tally.sessionTotal() });
      expect(tally.sessionTotal()).toEqual(total);
    }

    expect(shares).toEqual([usage(400_000, 4_000, 50), usage(300_000, 2_000, 40), usage(300_000, 3_500, 35)]);
  });

  it("starts from the session figure the newest run read, however wrong the recorded shares are", () => {
    const history: ThreadRunUsage[] = [
      { recorded: usage(9_000_000, 90_000, 900), sessionEndedOn: usage(400_000, 4_000, 50) },
      { recorded: usage(8_000_000, 80_000, 800), sessionEndedOn: usage(700_000, 6_000, 90) },
    ];
    expect(sessionTotalBefore(history)).toEqual(usage(700_000, 6_000, 90));
  });

  it("takes a real restart — a reading below where the last run left the session — whole, never as a negative or a zero", () => {
    const history: ThreadRunUsage[] = [{ recorded: usage(300_000, 2_000, 40), sessionEndedOn: usage(700_000, 6_000, 90) }];
    const tally = createUsageTally({ earlierOnThread: sessionTotalBefore(history) });
    tally.record(session({ tokensIn: 120_000, tokensOut: 1_500, costCents: 20 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 120_000, tokensOut: 1_500, costCents: 20 });
    // And the session is now the restarted one, for the run after.
    expect(tally.sessionTotal()).toEqual(usage(120_000, 1_500, 20));
  });

  it("is the session's running total across a corrective turn, not the run's share", () => {
    const tally = createUsageTally({ earlierOnThread: usage(500_000, 5_000, 200) });
    tally.record(session({ tokensIn: 600_000, tokensOut: 6_000, costCents: 250 }));
    expect(tally.sessionTotal()).toEqual(usage(600_000, 6_000, 250));
    tally.commit();
    // Between streams it stays where the first one left it.
    expect(tally.sessionTotal()).toEqual(usage(600_000, 6_000, 250));
    tally.record(session({ tokensIn: 610_000, tokensOut: 6_200, costCents: 254 }));

    expect(tally.sessionTotal()).toEqual(usage(610_000, 6_200, 254));
    expect(tally.totals()).toMatchObject({ tokensIn: 110_000, tokensOut: 1_200, costCents: 54 });
  });

  it("keeps a cache figure the carried total knew and the reading did not say", () => {
    const tally = createUsageTally({ earlierOnThread: { ...usage(500_000, 5_000, 200), cacheReadTokens: 400_000 } });
    tally.record(session({ tokensIn: 600_000, tokensOut: 6_000, costCents: 250 }));

    expect(tally.sessionTotal()).toEqual({ ...usage(600_000, 6_000, 250), cacheReadTokens: 400_000 });
  });

  it("is the newest reading after a `/clear` reset the running total part-way, not the high-water mark", () => {
    // The spend keeps the high-water mark, as it always has; where the
    // session stands is the smaller figure it was reset to.
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 90_000, tokensOut: 2_000, costCents: 63 }));
    tally.record(session({ tokensIn: 12_000, tokensOut: 300, costCents: 4 }));
    expect(tally.totals()).toMatchObject({ tokensIn: 90_000, tokensOut: 2_000, costCents: 63 });
    expect(tally.sessionTotal()).toEqual(usage(12_000, 300, 4));

    // The next run on the thread ends at 22k / 500 / 8¢: 10k / 200 / 4¢ of its own.
    const next = createUsageTally({ earlierOnThread: sessionTotalBefore([{ recorded: usage(90_000, 2_000, 63), sessionEndedOn: tally.sessionTotal() }]) });
    next.record(session({ tokensIn: 22_000, tokensOut: 500, costCents: 8 }));
    expect(next.totals()).toMatchObject({ tokensIn: 10_000, tokensOut: 200, costCents: 4 });
  });

  it("measures a corrective turn after a `/clear` from where the reset left the session", () => {
    const tally = createUsageTally();
    tally.record(session({ tokensIn: 90_000, tokensOut: 2_000, costCents: 63 }));
    tally.record(session({ tokensIn: 12_000, tokensOut: 300, costCents: 4 }));
    tally.commit();
    // The correction carries on from 12k and spends 10k / 200 / 4¢.
    tally.record(session({ tokensIn: 22_000, tokensOut: 500, costCents: 8 }));

    expect(tally.totals()).toMatchObject({ tokensIn: 100_000, tokensOut: 2_200, costCents: 67 });
    expect(tally.sessionTotal()).toEqual(usage(22_000, 500, 8));
  });

  it("is null while no session total has been read, and on a backend that reports turn by turn", () => {
    expect(createUsageTally({ earlierOnThread: usage(500_000, 5_000, 200) }).sessionTotal()).toBeNull();

    const codex = createUsageTally();
    codex.record(turn());
    codex.commit();
    codex.record(turn());
    expect(codex.sessionTotal()).toBeNull();
  });
});
