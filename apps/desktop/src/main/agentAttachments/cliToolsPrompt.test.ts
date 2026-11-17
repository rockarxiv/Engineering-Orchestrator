import { describe, expect, it } from "vitest";
import { cliToolsPromptSection, openingPrompt } from "./cliToolsPrompt.js";

const gh = { command: "gh", description: "GitHub's own CLI.\nUse it for pull requests,\n\n  issues and CI runs.", path: "/usr/bin/gh", version: "gh version 2.62.0 (2024-11-14)" };

describe("cliToolsPromptSection (EO-820)", () => {
  it("names each found CLI on one bullet line: command, description, path and version", () => {
    const section = cliToolsPromptSection([gh, { command: "psql", description: "", path: "/opt/pg/bin/psql", version: null }]);
    expect(section).toBe(
      [
        "## Command-line tools",
        "",
        "These command-line tools are installed on this machine.",
        "You may run them through your shell when they fit what you are doing:",
        "",
        "- `gh` — GitHub's own CLI. Use it for pull requests, issues and CI runs. (`/usr/bin/gh`, gh version 2.62.0 (2024-11-14))",
        "- `psql` (`/opt/pg/bin/psql`)",
      ].join("\n"),
    );
  });

  it("renders a description with newlines as one bullet line", () => {
    const bullets = cliToolsPromptSection([gh])
      .split("\n")
      .filter((line) => line.includes("GitHub") || line.includes("issues"));
    expect(bullets).toEqual(["- `gh` — GitHub's own CLI. Use it for pull requests, issues and CI runs. (`/usr/bin/gh`, gh version 2.62.0 (2024-11-14))"]);
  });

  it("is nothing at all when none is found — no heading with nothing under it", () => {
    expect(cliToolsPromptSection([])).toBe("");
    expect(openingPrompt("The context.", "", [])).toBe("The context.");
    expect(openingPrompt("The context.", "", undefined)).toBe("The context.");
  });

  it("follows the context and the Skills section in the prompt that opens a thread", () => {
    expect(openingPrompt("The context.", "## Skills\n\nsome", [gh])).toBe(`The context.\n\n## Skills\n\nsome\n\n${cliToolsPromptSection([gh])}`);
  });
});
