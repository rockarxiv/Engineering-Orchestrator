import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about changing a module that already
 * exists (EO-418): it returns the change, in the help chat and in the
 * scenario chat, and the person applies it on a card.
 *
 * Held here because the prompt is the only place the agent learns the
 * route exists. Before this it was told the opposite — that an approved
 * module, or one a person wrote, is changed by an edit the person makes
 * in Settings → Modules or by a new module under another slug — and a
 * prompt still saying so sends somebody who said "just change it" away
 * from the conversation with the fix unwritten.
 */

const prompt = loadRolePrompt("system")!;
const flat = prompt.replace(/\s+/g, " ");

/** A section, from its heading to the next heading of any depth, with its whitespace flattened. */
function section(heading: string): string {
  const start = prompt.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const next = /\n#{1,3} /.exec(prompt.slice(start + 1));
  return (next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start)).replace(/\s+/g, " ");
}

describe("what the system agent's prompt says about changing a module that exists", () => {
  const changing = () => section("### Changing a module that exists");

  it("has a section for the help chat, beside the one for a module on its own", () => {
    expect(prompt.indexOf("### A module on its own")).toBeLessThan(prompt.indexOf("### Changing a module that exists"));
    expect(prompt.indexOf("### Changing a module that exists")).toBeLessThan(prompt.indexOf("### Fixing a module that failed approval"));
    expect(section("### A module on its own")).toContain("see **Changing a module that exists**");
  });

  it("says it is changed by returning the change, read from the catalog first", () => {
    expect(changing()).toContain("**return the change: `change`, with no `draft` and no `modules` beside it.**");
    expect(changing()).toContain("approved or not, and whether you, a person or an import wrote it");
    expect(changing()).toContain("**Read the module first, from the catalog, in this turn.**");
    expect(changing()).toContain("`modules_list`");
    expect(changing()).toContain("`module_version_get`");
  });

  it("says the change carries the whole code and the whole manifest, and its test cases", () => {
    expect(changing()).toContain("`moduleId`");
    expect(changing()).toContain("the module's **whole** code as it would be");
    expect(changing()).toContain("the module's **whole** manifest as it would be, or `null` to leave the manifest exactly as it is");
    expect(changing()).toContain("They are matched by `description`");
  });

  it("says nothing is saved until Apply, and that applying withdraws an approval", () => {
    expect(changing()).toContain("**Nothing is saved until the person presses Apply.**");
    expect(changing()).toContain("**Applying withdraws an approved module's approval**");
    expect(changing()).toContain("offers **Approve** once they have");
  });

  it("says cases are removed by id, and a change can be removals alone (EO-499)", () => {
    expect(changing()).toContain("`removeTests` — the ids of the test cases the change removes, as `module_tests_list` gives them");
    expect(changing()).toContain("A case is removed by its id, never by its description.");
    expect(changing()).toContain("A change can be removals alone");
    expect(changing()).toContain("a module with none can never be approved again");
  });

  it("says any test-case change on an approved module withdraws its approval, and the reply must say so (EO-499)", () => {
    expect(changing()).toContain(
      "**any test-case change on an approved module — adding a case, replacing one or removing one — withdraws its approval**",
    );
    expect(changing()).toContain("your message must say that applying withdraws its approval, and that the card is where it is applied and approved");
  });

  it("says the direct test tools are refused on approved modules in the help chat (EO-499)", () => {
    expect(changing()).toContain("**On an approved module, change its test cases only through `change`.**");
    expect(changing()).toContain("`eo_admin` refuses `module_test_save` and `module_test_delete` on an approved module and writes nothing");
    expect(changing()).toContain("On a module that is not approved they still work.");
  });

  it("rules out module_save, a new slug, and sending the person to Settings → Modules", () => {
    expect(changing()).toContain("**Never `module_save` a module that exists**");
    expect(changing()).toContain("**Never propose it again under a new slug**");
    expect(changing()).toContain("**Never send the person to Settings → Modules**");
  });

  it("says a turn that asks carries no change", () => {
    expect(changing()).toContain("A turn that asks `questions` carries no change");
  });

  it("lists the change among the proposals a person acts on, for both chats, manifest included", () => {
    const how = section("## How you change anything");
    expect(how).toContain("**A change to a module that exists is a card with Apply on it**, in both chats that can raise one");
    expect(how).toContain("its whole manifest when the manifest changes");
    expect(how).toContain("**Fixing what was decided**");
    expect(how).toContain("**Changing a module that exists**");
  });

  it("no longer sends an approved or person-written module to Settings → Modules or a new slug", () => {
    expect(flat).not.toContain("an edit the person makes in Settings → Modules");
    expect(flat).not.toContain("or a new module under a slug nothing holds");
    const fixing = section("### Fixing a module that failed approval");
    expect(fixing).toContain("Those are changed by returning `change` — see **Changing a module that exists**");
  });

  it("says, in the scenario chat, that the change carries the manifest when the fix needs one", () => {
    const fixing = section("### Fixing what was decided");
    expect(fixing).toContain("`manifest`, the module's **whole** manifest as it would be when the fix needs the manifest changed");
    expect(fixing).toContain("`null` when it does not");
    expect(fixing).toContain("Do not send the person to Settings → Modules to make the edit, and do not write the fix as a new module");
    expect(section("### What you never do")).toContain("`module_save`");
  });

  // Invariant 12: a tool is named by the name every backend agrees on,
  // never with one harness's punctuation around it.
  it("names no backend-specific tool punctuation", () => {
    for (const text of [changing(), section("### Fixing what was decided")]) {
      expect(text).not.toMatch(/mcp__/);
      expect(text).not.toMatch(/\b[a-z_]+\/[a-z_]+\b/);
      expect(text).not.toMatch(/\b(claude|codex)\b/i);
    }
  });

  it("is a newer version than the prompt that knew no change route", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(16);
  });
});
