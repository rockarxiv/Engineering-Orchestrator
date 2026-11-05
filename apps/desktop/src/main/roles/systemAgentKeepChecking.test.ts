import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is told about keep checking where it is told to
 * use it (EO-506). It used to say "put it on a step that keeps checking"
 * and nothing about the field that makes a step one — so an agent that
 * republished a pipeline over MCP had no way to know there was a setting
 * on the step to carry, and the shipped pull request watch came back
 * running once.
 */

const flat = loadRolePrompt("system")!.replace(/\s+/g, " ");

describe("what the system agent's prompt says about keep checking", () => {
  it("names the field and its shape where it tells the agent to put watch_pull_request on a step that keeps checking", () => {
    const start = flat.indexOf("`watch_pull_request` is made to be checked");
    expect(start).toBeGreaterThan(-1);
    const paragraph = flat.slice(start, flat.indexOf("Its results are", start));
    expect(paragraph).toContain('its `watch` field is set — `{ "everyMinutes": 5, "giveUpAfterHours": 168 }`');
    expect(paragraph).toContain("leaving `watch` out of a step keeps what that step already has, and `null` turns it off");
  });

  it("names the field and its shape where it tells a module that waits to run on a step that keeps checking", () => {
    expect(flat).toContain(
      'run it on a step that keeps checking — one whose `watch` is `{ "everyMinutes": N, "giveUpAfterHours": H }`, or `{ "everyMinutes": N, "neverGivesUp": true }` to wait with no deadline.',
    );
  });

  /**
   * Never giving up (EO-571), in each place the prompt gives the shape:
   * how to say it, and that leaving the hours out is still a week.
   */
  it("says how to make a step never give up, and that leaving the give-up time out is still a week", () => {
    const start = flat.indexOf("`watch_pull_request` is made to be checked");
    const paragraph = flat.slice(start, flat.indexOf("Its results are", start));
    expect(paragraph).toContain("`giveUpAfterHours` left out is a week");
    expect(paragraph).toContain('`{ "everyMinutes": 5, "neverGivesUp": true }` never gives up');

    const draft = flat.slice(flat.indexOf("- `watch` makes a builtin or module step keep checking"));
    expect(draft).toContain("`giveUpAfterHours` left out is a week");
    expect(draft).toContain('`{ "everyMinutes": 5, "neverGivesUp": true }` checks every five minutes and never gives up');
  });
});
