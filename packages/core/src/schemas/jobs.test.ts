import { describe, expect, it } from "vitest";
import { EMPTY_WEBHOOK_MAPPING } from "../webhook.js";
import {
  DEFAULT_CATCH_UP_MINUTES,
  JOB_TEMPLATE_BLANKS,
  JobTemplateSchema,
  JobTriggerSchema,
  describeItemOriginKind,
  describeJobSchedule,
  describeJobTrigger,
} from "./jobs.js";

describe("a job's trigger", () => {
  it("accepts the kinds this version can fire", () => {
    expect(JobTriggerSchema.parse({ kind: "manual" })).toEqual({ kind: "manual" });
    expect(JobTriggerSchema.parse({ kind: "from-discussion", conversationId: "i1" })).toEqual({
      kind: "from-discussion",
      conversationId: "i1",
    });
  });

  it("takes a webhook with its path, its secret and its mapping", () => {
    const parsed = JobTriggerSchema.parse({ kind: "webhook", path: "deploys", secret: "s".repeat(32) });
    expect(parsed).toEqual({ kind: "webhook", path: "deploys", secret: "s".repeat(32), mapping: EMPTY_WEBHOOK_MAPPING });
  });

  it("refuses a webhook that could not be verified or delivered", () => {
    // A bare kind was refused before EO-332 because nothing could fire
    // it; it is refused now because a webhook with no address and no
    // secret is an endpoint nobody can reach and nothing can sign.
    expect(JobTriggerSchema.safeParse({ kind: "webhook" }).success).toBe(false);
    expect(JobTriggerSchema.safeParse({ kind: "webhook", path: "deploys", secret: "short" }).success).toBe(false);
    expect(JobTriggerSchema.safeParse({ kind: "webhook", path: "Deploys/2", secret: "s".repeat(32) }).success).toBe(false);
  });

  it("takes a schedule in either form, with its zone", () => {
    expect(JobTriggerSchema.parse({ kind: "schedule", schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 }, timeZone: "Europe/Berlin" })).toEqual({
      kind: "schedule",
      schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
      timeZone: "Europe/Berlin",
      // On by default, which is the review's own decision (ARCHITECTURE.md, "Schedules, and a
      // machine that was off"): a
      // lid closed at 08:00 and opened at 09:10 should produce the report.
      catchUpWithinMinutes: DEFAULT_CATCH_UP_MINUTES,
    });
    expect(JobTriggerSchema.parse({ kind: "schedule", schedule: { kind: "cron", expression: "0 8 * * 1" }, timeZone: "UTC", catchUpWithinMinutes: 0 }).kind).toBe(
      "schedule",
    );
  });

  it("refuses a schedule with no zone to be stated in", () => {
    // The zone is the point: 08:00 in Berlin stays 08:00 in Berlin
    // whatever the machine is set to, and a schedule without one is a
    // fact about where the computer is.
    expect(JobTriggerSchema.safeParse({ kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 } }).success).toBe(false);
    expect(JobTriggerSchema.safeParse({ kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "" }).success).toBe(false);
  });

  it("refuses a clock time that is not one", () => {
    expect(JobTriggerSchema.safeParse({ kind: "schedule", schedule: { kind: "daily", hour: 24, minute: 0 }, timeZone: "UTC" }).success).toBe(false);
    expect(JobTriggerSchema.safeParse({ kind: "schedule", schedule: { kind: "weekly", weekday: 7, hour: 8, minute: 0 }, timeZone: "UTC" }).success).toBe(false);
  });

  it("refuses a from-discussion trigger that names no conversation", () => {
    expect(JobTriggerSchema.safeParse({ kind: "from-discussion" }).success).toBe(false);
    expect(JobTriggerSchema.safeParse({ kind: "from-discussion", conversationId: "" }).success).toBe(false);
  });
});

describe("a job's template", () => {
  it("defaults an unwritten body to nothing rather than an empty string", () => {
    expect(JobTemplateSchema.parse({ type: "developer:story", title: "{{job}}" })).toEqual({
      type: "developer:story",
      title: "{{job}}",
      body: null,
    });
  });

  it("insists on a type and a title, since both are what an item is made of", () => {
    expect(JobTemplateSchema.safeParse({ type: "", title: "x" }).success).toBe(false);
    expect(JobTemplateSchema.safeParse({ type: "developer:story", title: "" }).success).toBe(false);
  });

  it("names its blanks once, for the substitution and the help text to share", () => {
    expect([...JOB_TEMPLATE_BLANKS]).toEqual(["date", "job"]);
  });
});

/**
 * The one sentence a job's trigger reads as (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * In `@eo/core` because the Jobs list's second column and the Job
 * page's summary line are the same sentence about the same job, and two
 * spellings of it would drift the first time a schedule kind is added.
 */
describe("a trigger said in words", () => {
  it("says what makes each kind happen", () => {
    expect(describeJobTrigger({ kind: "manual" })).toBe("When you run it");
    expect(describeJobTrigger({ kind: "from-discussion", conversationId: "c1" })).toBe("When you press Create in its conversation");
  });

  /**
   * The rail reads "From: job 'Monday report'" and the card's hover
   * reads "From job 'Monday report' · 12¢" — one word, spelled once
   * (EO-333, ARCHITECTURE.md, "What a job records").
   */
  it("names an item's provenance by how it arrived, not by what made it", () => {
    expect(describeItemOriginKind("manual")).toBe("job");
    expect(describeItemOriginKind("schedule")).toBe("job");
    expect(describeItemOriginKind("from-discussion")).toBe("conversation");
    expect(describeItemOriginKind("webhook")).toBe("webhook");
  });

  it("reads a schedule as a person would say it", () => {
    expect(describeJobSchedule({ kind: "daily", hour: 8, minute: 0 })).toBe("Daily at 08:00");
    expect(describeJobSchedule({ kind: "daily", hour: 17, minute: 5 })).toBe("Daily at 17:05");
    // Sunday 0, cron's own numbering, so the form and the expression agree.
    expect(describeJobSchedule({ kind: "weekly", weekday: 1, hour: 8, minute: 0 })).toBe("Mondays at 08:00");
    expect(describeJobSchedule({ kind: "weekly", weekday: 0, hour: 9, minute: 30 })).toBe("Sundays at 09:30");
  });

  /**
   * An expression is quoted rather than translated. EO can compute from
   * `0 8 1 * *`; turning it back into English is a second parser, and
   * the one thing a schedule may not have is two readings.
   */
  it("quotes an expression rather than paraphrasing it", () => {
    expect(describeJobSchedule({ kind: "cron", expression: "0 8 1 * *" })).toBe('Whenever "0 8 1 * *" comes round');
  });
});
