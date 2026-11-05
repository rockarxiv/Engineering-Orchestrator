import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ipcContract } from "@eo/core";
import { describe, expect, it } from "vitest";

/**
 * What EO offers the outside world about repository intelligence, and
 * what it deliberately does not (EO-151).
 *
 * The operations EO exposes are the high-level ones — configure it,
 * and, when the screens for it arrive, ask its status or rebuild it.
 * There is no `runCodeWiki(args)`, on either channel a caller could
 * reach: not over IPC, where the renderer speaks, and not as a tool on
 * the agent-facing MCP service, where a model does.
 *
 * That is a *design* rather than an omission, and it is worth a test
 * because the shortcut is so easy to take. A channel taking an argument
 * array would satisfy every screen this feature will ever need in one
 * line — and would hand the renderer, and anything that can reach it, a
 * way to run a third-party binary with arguments EO never wrote, in a
 * directory it did not choose. It would also put the implementation's
 * command line in the renderer, which is the one place the port's whole
 * argument says it must never be.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Every channel this feature exposes, whoever added it. */
const repositoryChannels = (): string[] => Object.keys(ipcContract).filter((name) => name.startsWith("repositoryIntelligence:")).sort();

describe("the IPC surface", () => {
  it("offers the high-level operations and nothing else", () => {
    // Pinned exactly, because a new channel here is a decision worth
    // making on purpose and this is where the argument above has to be
    // answered. The three operations are the ones EO-151 names in as
    // many words — initialize, sync, rebuild — beside the switch that
    // decides whether any of it runs. Every one of them is a *verb EO
    // owns*, not a way to pass one through.
    expect(repositoryChannels()).toEqual([
      "repositoryIntelligence:getConfig",
      "repositoryIntelligence:initializeRepositoryIndex",
      "repositoryIntelligence:rebuildRepositoryIndex",
      "repositoryIntelligence:setConfig",
      "repositoryIntelligence:syncRepositoryIndex",
    ]);
  });

  it("names no implementation in any channel, anywhere in the contract", () => {
    // Not scoped to this feature's channels: the shortcut this guards
    // against would not necessarily be spelled `repositoryIntelligence:`.
    expect(Object.keys(ipcContract).filter((name) => /codewiki/i.test(name))).toEqual([]);
  });

  /**
   * The criterion itself, over every channel rather than the one that
   * happened to exist when this was written.
   *
   * The first version of this test asserted the *list* and then probed a
   * single channel by name. That was a snapshot: three operations landed
   * beside it and the probe went on examining `setConfig`. Written as a
   * rule it covers whatever the list grows to, which is the only version
   * worth having — the shortcut this guards against is one line in a new
   * channel, and a new channel is exactly what a snapshot stops seeing.
   */
  it("lets no channel of this feature's carry arguments to a tool", () => {
    // Everything a caller might try to smuggle, alongside enough valid
    // payload that the closed channels actually parse and can be
    // inspected rather than merely refusing.
    const probe = {
      id: "0199cf00-0000-7000-8000-00000000000a",
      enabled: true,
      args: ["index", "--path", "/etc"],
      argv: ["serve", "--mcp"],
      command: "/bin/sh",
    };
    let inspected = 0;

    for (const name of repositoryChannels()) {
      const parsed = ipcContract[name as keyof typeof ipcContract].request.safeParse(probe);
      // Refused outright is the strongest possible answer — `getConfig`
      // takes nothing at all — and needs no further inspection.
      if (!parsed.success) continue;
      inspected += 1;
      // Accepted, because a caller sending extra keys is not an attack
      // to refuse. What matters is that none of them reaches a handler:
      // every one of these channels carries closed values, which is what
      // makes "there is no way to pass arguments" true rather than
      // merely unimplemented.
      const data = (parsed.data ?? {}) as Record<string, unknown>;
      for (const smuggled of ["args", "argv", "command"]) {
        expect(data, `${name} let "${smuggled}" through`).not.toHaveProperty(smuggled);
      }
    }

    // Non-vacuous: a loop that inspected nothing would pass just as
    // happily, and every channel refusing the probe outright is not the
    // shape this feature has.
    expect(inspected).toBeGreaterThanOrEqual(4);
  });
});

describe("the agent-facing MCP service", () => {
  /**
   * `eo` gains no tool from this story.
   *
   * An agent reaches the index through the `repo` server, whose process
   * the *backend* starts from a configuration EO composed — never
   * through EO's own service, and never with arguments a model chose.
   * `mcp/eoServer.test.ts` pins the tool list exactly, so a new tool
   * cannot appear unnoticed; this asserts the other half, which is that
   * no tool there has learned what is underneath the port.
   */
  it("has no tool that names an index, or what builds one", () => {
    const source = readFileSync(join(here, "..", "..", "..", "mcp", "eoServer.mjs"), "utf8");
    const declared = [...source.matchAll(/\bname:\s*"([a-z_]+)"/g)].map((match) => match[1]);

    // Non-vacuous: the scan found the tools that are there.
    expect(declared).toContain("ticket_detail");
    expect(declared.filter((name) => /codewiki|index|repo(sitory)?_/i.test(name ?? ""))).toEqual([]);
    expect(source).not.toMatch(/codewiki/i);
  });
});
