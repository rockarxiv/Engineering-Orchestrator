import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Query, query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { CLAUDE_USAGE, fakeClaudeQuery } from "../testing/fakeClaudeUsage.js";
import { CLAUDE_USAGE_METHOD, claudeUsageAnswer, readClaudePlanUsage } from "./claudeUsage.js";

/**
 * Claude's plan windows read through the SDK's experimental usage method
 * (EO-896), against a fake `query`.
 */

/**
 * Fails `pnpm typecheck` when the bundled SDK's `Query` stops declaring
 * the method; the test below fails the same way at run time.
 */
type Declared = Query[typeof CLAUDE_USAGE_METHOD];
const declared: Declared | null = null;

const here = dirname(fileURLToPath(import.meta.url));

describe("reading Claude's plan usage", () => {
  it("is declared on the bundled SDK's Query", () => {
    expect(declared).toBeNull();
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const types = readFileSync(join(dirname(entry), "sdk.d.ts"), "utf8");
    const start = types.indexOf("export declare interface Query ");
    expect(start).toBeGreaterThan(-1);
    const body = types.slice(start, types.indexOf("\n}\n", start));
    expect(body).toContain(`${CLAUDE_USAGE_METHOD}(`);
  });

  it("is named in exactly one non-test file of the main process", () => {
    const main = join(here, "..");
    const naming: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && readFileSync(path, "utf8").includes(CLAUDE_USAGE_METHOD)) naming.push(relative(main, path));
      }
    };
    walk(main);
    expect(naming).toEqual([join("providers", "claudeUsage.ts")]);
  });

  it("opens a session that is sent nothing, asks it with skipBehaviors, closes it, and maps the windows", async () => {
    const { runQuery, sessions } = fakeClaudeQuery(() => CLAUDE_USAGE(34, 100));
    const answer = await readClaudePlanUsage(runQuery, { executablePath: "/runtimes/claude" });

    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    await session!.promptEnded;
    expect(session!.yielded).toEqual([]);
    expect(session!.closed).toBe(true);
    expect(session!.usageCalls).toEqual([{ skipBehaviors: true }]);
    expect(session!.options).toMatchObject({ pathToClaudeCodeExecutable: "/runtimes/claude" });
    expect(answer).toEqual({
      ok: true,
      limitsApply: true,
      readings: [
        { type: "quota", provider: "claude", window: "five_hour", utilization: 34, status: "allowed", resetsAt: Date.parse("2026-11-23T15:40:00.000Z") },
        { type: "quota", provider: "claude", window: "seven_day", utilization: 100, status: "rejected", resetsAt: Date.parse("2026-11-26T09:00:00.000Z") },
        { type: "quota", provider: "claude", window: "seven_day_opus", utilization: 12, status: "allowed" },
      ],
    });
  });

  it("opens a new session for every read", async () => {
    const { runQuery, sessions } = fakeClaudeQuery(() => CLAUDE_USAGE(1, 2));
    await readClaudePlanUsage(runQuery, { executablePath: null });
    await readClaudePlanUsage(runQuery, { executablePath: null });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.closed && session.usageCalls.length === 1)).toBe(true);
  });

  it("reads as a run would on the key EO holds", async () => {
    const { runQuery, sessions } = fakeClaudeQuery(() => ({ ...CLAUDE_USAGE(0, 0), rate_limits_available: false, rate_limits: null }));
    expect(await readClaudePlanUsage(runQuery, { executablePath: null, apiKey: "sk-ant-test" })).toEqual({ ok: true, limitsApply: false, readings: [] });
    expect((sessions[0]!.options?.["env"] as Record<string, string>)["ANTHROPIC_API_KEY"]).toBe("sk-ant-test");
  });

  it("answers ok: false, and closes the session, when the method is missing or throws", async () => {
    const missing = fakeClaudeQuery(() => CLAUDE_USAGE(1, 2), { missing: true });
    expect(await readClaudePlanUsage(missing.runQuery, { executablePath: null })).toEqual({ ok: false });
    expect(missing.sessions[0]!.closed).toBe(true);

    const throwing = fakeClaudeQuery(() => new Error("Control request failed"));
    expect(await readClaudePlanUsage(throwing.runQuery, { executablePath: null })).toEqual({ ok: false });
    expect(throwing.sessions[0]!.closed).toBe(true);

    const opening = (() => {
      throw new Error("spawn ENOENT");
    }) as unknown as typeof query;
    expect(await readClaudePlanUsage(opening, { executablePath: null })).toEqual({ ok: false });
  });

  it("does not take an answer of another shape as a reading", () => {
    expect(claudeUsageAnswer(null)).toEqual({ ok: false });
    expect(claudeUsageAnswer({ rate_limits: {} })).toEqual({ ok: false });
  });
});
