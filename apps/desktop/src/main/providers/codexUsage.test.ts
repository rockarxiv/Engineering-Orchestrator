import { describe, expect, it } from "vitest";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { codexUsageAnswer, readCodexPlanUsage } from "./codexUsage.js";

/** Codex's plan windows read with `account/rateLimits/read` (EO-896), against the fake app-server. */
describe("reading Codex's plan usage", () => {
  const snapshot = (fiveHour: number, week: number, limitId: string | null = "codex") =>
    note.rateLimits({ usedPercent: fiveHour, resetsAt: 1_795_440_000 }, { usedPercent: week, resetsAt: 1_795_700_000 }, limitId).params.rateLimits;

  it("asks the app-server after the handshake and reads its windows as quota readings", async () => {
    const server = fakeAppServer({ replies: { "account/rateLimits/read": { result: { rateLimits: snapshot(12, 100), rateLimitsByLimitId: null } } } });
    const answer = await readCodexPlanUsage("/runtimes/codex", server.spawn);

    expect(server.sent.filter((message) => message.id !== undefined).map((message) => message.method)).toEqual(["initialize", "account/rateLimits/read"]);
    expect(answer).toEqual({
      ok: true,
      limitsApply: true,
      readings: [
        { type: "quota", provider: "codex", window: "5_hour", utilization: 12, status: "allowed", resetsAt: 1_795_440_000 },
        { type: "quota", provider: "codex", window: "7_day", utilization: 100, status: "rejected", resetsAt: 1_795_700_000 },
      ],
    });
  });

  it("reads every bucket where the server lists them, a named limit under its own name", () => {
    const answer = codexUsageAnswer({ rateLimits: snapshot(1, 2), rateLimitsByLimitId: { codex: snapshot(1, 2), spark: snapshot(70, 3, "spark") } });
    expect(answer.ok && answer.readings.map((reading) => reading.window)).toEqual(["5_hour", "7_day", "spark_5_hour", "spark_7_day"]);
  });

  /** `account/rateLimits/read` from a real Business sign-in on 0.171.0 (EO-922), the account id removed. */
  const business = (over: Record<string, unknown> = {}, individualLimit: Record<string, unknown> = {}) => {
    const snapshot = {
      limitId: "codex",
      limitName: null,
      normalModelSlug: null,
      primary: null,
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: null },
      individualLimit: { limit: "60000", used: "8412.35610795021", remainingPercent: 86, resetsAt: 1_797_292_800, ...individualLimit },
      spendControlReached: false,
      planType: "business",
      rateLimitReachedType: null,
      ...over,
    };
    return {
      ordinaryUsageAllowed: null,
      rateLimits: snapshot,
      rateLimitsByLimitId: { codex: snapshot },
      rateLimitResetCredits: { availableCount: 0, credits: [] },
      rateLimitUpsell: null,
    };
  };

  it("reads a Business sign-in's monthly credit limit as one monthly_credits reading (EO-922)", () => {
    expect(codexUsageAnswer(business())).toEqual({
      ok: true,
      limitsApply: true,
      readings: [{ type: "quota", provider: "codex", window: "monthly_credits", utilization: 14, status: "allowed", resetsAt: 1_797_292_800 }],
    });
  });

  it("refuses the monthly limit when nothing remains, or when the workspace says its spend control is reached at any share", () => {
    const status = (answer: ReturnType<typeof codexUsageAnswer>) => answer.ok && answer.readings.map((reading) => [reading.window, reading.utilization, reading.status]);
    expect(status(codexUsageAnswer(business({}, { remainingPercent: 0 })))).toEqual([["monthly_credits", 100, "rejected"]]);
    expect(status(codexUsageAnswer(business({ spendControlReached: true })))).toEqual([["monthly_credits", 14, "rejected"]]);
    expect(status(codexUsageAnswer(business({ spendControlReached: true }, { remainingPercent: 100 })))).toEqual([["monthly_credits", 0, "rejected"]]);
  });

  it("names a monthly limit on a limit other than the plan's own after that limit", () => {
    const windows = (answer: ReturnType<typeof codexUsageAnswer>) => answer.ok && answer.readings.map((reading) => reading.window);
    expect(windows(codexUsageAnswer(business({ limitId: "codex_other", limitName: "GPT-5-Codex-Spark" })))).toEqual(["GPT-5-Codex-Spark_monthly_credits"]);
    expect(windows(codexUsageAnswer(business({ limitId: "spark" })))).toEqual(["spark_monthly_credits"]);
  });

  it("still reads a snapshot with no window and no monthly limit as saying nothing", () => {
    expect(codexUsageAnswer(business({ individualLimit: null }))).toEqual({ ok: false });
  });

  it("answers ok: false for a refused request, a missing runtime, or an answer with no windows", async () => {
    const refused = fakeAppServer({ replies: { "account/rateLimits/read": { error: { code: -32603, message: "not signed in" } } } });
    expect(await readCodexPlanUsage("/runtimes/codex", refused.spawn)).toEqual({ ok: false });
    expect(await readCodexPlanUsage(null)).toEqual({ ok: false });
    expect(codexUsageAnswer({ rateLimits: null })).toEqual({ ok: false });
  });
});
