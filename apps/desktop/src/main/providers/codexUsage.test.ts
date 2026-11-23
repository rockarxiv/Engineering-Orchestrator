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

  it("answers ok: false for a refused request, a missing runtime, or an answer with no windows", async () => {
    const refused = fakeAppServer({ replies: { "account/rateLimits/read": { error: { code: -32603, message: "not signed in" } } } });
    expect(await readCodexPlanUsage("/runtimes/codex", refused.spawn)).toEqual({ ok: false });
    expect(await readCodexPlanUsage(null)).toEqual({ ok: false });
    expect(codexUsageAnswer({ rateLimits: null })).toEqual({ ok: false });
  });
});
