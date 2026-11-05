import { describe, expect, it } from "vitest";
import { fillTemplate } from "./template.js";

const BLANKS = { dueAt: new Date(2026, 8, 14, 9, 30).getTime(), job: "Monday report" };

describe("a job template's blanks", () => {
  it("fills the date with the occurrence's own day, not the day it is written", () => {
    // The distinction that matters for catch-up (the next story): an
    // occurrence fired late is still *for* the day it was due.
    expect(fillTemplate("Report for {{date}}", BLANKS)).toBe("Report for 2026-09-14");
  });

  it("fills the job's name", () => {
    expect(fillTemplate("{{job}} — {{date}}", BLANKS)).toBe("Monday report — 2026-09-14");
  });

  it("tolerates the spacing somebody actually types", () => {
    expect(fillTemplate("{{ job }} on {{  date  }}", BLANKS)).toBe("Monday report on 2026-09-14");
  });

  it("leaves a blank it does not know exactly as it was typed", () => {
    // Not emptied. A person who wrote `{{owner}}` sees what they wrote
    // and can fix the template; a hole in the title would leave them
    // guessing what had been there.
    expect(fillTemplate("{{owner}}'s {{job}}", BLANKS)).toBe("{{owner}}'s Monday report");
  });

  it("leaves text with no blanks alone, braces and all", () => {
    expect(fillTemplate("Deploy { staging } — no substitution here", BLANKS)).toBe("Deploy { staging } — no substitution here");
  });
});
