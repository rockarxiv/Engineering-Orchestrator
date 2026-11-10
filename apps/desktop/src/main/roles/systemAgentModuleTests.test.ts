import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about a module's tests (EO-355).
 *
 * Every module it proposes has to arrive with its test cases, since a
 * module with none cannot be approved (EO-353) — so the configure
 * section teaches the harness the cases are written against, and the
 * dry run those tests replaced is gone from it.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** The pipeline drafts section (the configure section until EO-526): from its heading to the next top-level one. */
function configureSection(): string {
  const prompt = loadRolePrompt("system")!;
  const start = prompt.indexOf("## Pipeline drafts");
  const end = prompt.indexOf("\n# ", start);
  expect(start).toBeGreaterThan(-1);
  return prompt.slice(start, end === -1 ? undefined : end);
}

describe("the configure section of the system agent's prompt", () => {
  it("tells the agent every module it proposes comes with its tests, in `tests`", () => {
    const section = configureSection();
    expect(section).toContain("### Every module you propose comes with its tests");
    expect(section).toContain("`tests`");
    expect(section).toContain("`{ description, source }`");
    // The assistant's way to a module, said the same way.
    expect(section).toContain("`module_save`");
  });

  it("teaches the harness: harness.run, its fixtures and what it answers", () => {
    const section = configureSection();
    for (const term of ["harness.run(fixtures)", "harness.cwd", "`exec`", "`item`", "`itemByKey`", "`answer`", "`inputs`", "`timeoutMs`", "`createItem`", "`run`", "`workspace`", "`project`", "{ outcome, comments, attachments, created, logs, execs }", "node:assert"]) {
      expect(section).toContain(term);
    }
  });

  it("names the four rules: case by case, every result and refusal, every exec scripted, 80% line coverage", () => {
    const section = configureSection();
    expect(section).toContain("**Case by case.**");
    expect(section).toContain("**Cover every result the manifest declares, and every refusal.**");
    expect(section).toContain("**Script every `ctx.exec` call**");
    expect(section).toContain("**Aim for 80% line coverage or more.**");
  });

  it("no longer mentions a dry run anywhere", () => {
    expect(configureSection()).not.toMatch(/dry[\s-]?run/i);
    expect(loadRolePrompt("system")!).not.toMatch(/dry[\s-]?run/i);
  });

  /**
   * The prompt restates the harness for the agent; the host's header is
   * where it is implemented. A fixture the prompt teaches and the host
   * refuses as a typo would fail every case the agent writes with it.
   */
  it("teaches only fixtures the module host accepts", () => {
    const host = readFileSync(join(here, "..", "modules", "moduleHost.mjs"), "utf8");
    const accepted = /It takes ([a-zA-Z, ]+) and timeoutMs\./.exec(host)?.[1];
    expect(accepted).toBeDefined();
    const names = [...accepted!.split(/,\s*/), "timeoutMs"].map((name) => name.trim());
    expect(names.sort()).toEqual(["answer", "attachments", "createItem", "exec", "inputs", "item", "itemByKey", "items", "project", "run", "runs", "timeoutMs", "transitions", "workspace"]);
  });
});
