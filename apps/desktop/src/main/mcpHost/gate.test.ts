import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { TOOLS } from "./catalog.js";
import { DEFAULT_PORT, gateRefusal, onMcpConfigChanged, readMcpConfig, toolAllowed, toolOffered, toolsFor, writeMcpConfig } from "./gate.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("the MCP server's configuration", () => {
  it("is off on a database that has never been asked about it", () => {
    // Nobody gets a listening socket by upgrading.
    expect(readMcpConfig(handle.db)).toEqual({ enabled: false, port: DEFAULT_PORT, dangerousOperations: false });
  });

  it("writes only the keys it was given", () => {
    writeMcpConfig(handle.db, { enabled: true });
    writeMcpConfig(handle.db, { port: 5000 });

    expect(readMcpConfig(handle.db)).toEqual({ enabled: true, port: 5000, dangerousOperations: false });
  });

  it("tells whoever is listening that something changed", () => {
    // How the host learns to start, stop or rebind without handlers.ts
    // ever knowing the MCP SDK exists.
    const listener = vi.fn();
    const dispose = onMcpConfigChanged(listener);

    writeMcpConfig(handle.db, { enabled: true });
    expect(listener).toHaveBeenCalledOnce();

    dispose();
    writeMcpConfig(handle.db, { enabled: false });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("the destructive-operations gate", () => {
  it("has something to withhold", () => {
    // Without this, every test below passes on an empty gate:
    // reclassifying all 17 destructive tools as ordinary writes left
    // this whole file green, and only one assertion in http.test.ts
    // noticed. A gate that guards nothing is the failure state, not a
    // trivially satisfied precondition.
    expect(TOOLS.filter((tool) => tool.kind === "dangerous").length).toBeGreaterThanOrEqual(10);
    // Named rather than counted, so a rename cannot quietly empty it.
    for (const name of ["ticket_delete", "module_secret_set", "runtime_install", "runtime_remove"]) {
      expect(TOOLS.find((tool) => tool.name === name)?.kind, name).toBe("dangerous");
    }
  });

  it("withholds nothing that is not destructive", () => {
    // Asked of the admin listener, so this is a property of the *gate*
    // alone. The external one withholds the admin-only tools as well
    // (EO-192), and asking it here would blur two decisions into one
    // number — after which neither could be got wrong visibly.
    const offered = toolsFor(false, "admin");

    expect(offered.filter((tool) => tool.kind === "dangerous")).toEqual([]);
    expect(offered.length).toBe(TOOLS.filter((tool) => tool.kind !== "dangerous" && tool.personOnly !== true).length);
  });

  it("offers everything once it is open", () => {
    // The admin listener's, because that is the audience the whole
    // catalogue is for. The external one is a tool short (EO-192), which
    // is the point of the case below.
    expect(toolsFor(true, "admin").length).toBe(TOOLS.filter((tool) => tool.personOnly !== true).length);
    // Strictly more than when closed, which is the property Settings
    // reports to the person deciding whether to flip it.
    expect(toolsFor(true).length).toBeGreaterThan(toolsFor(false).length);
    expect(toolsFor(false).map((tool) => tool.name)).not.toContain("ticket_delete");
    expect(toolsFor(true).map((tool) => tool.name)).toContain("ticket_delete");
  });

  it("is checked per call as well as per listing", () => {
    // A client can call a tool it was never shown — a stale list, or a
    // guess. Filtering the listing alone would let that through.
    expect(toolAllowed({ kind: "dangerous" }, false)).toBe(false);
    expect(toolAllowed({ kind: "dangerous" }, true)).toBe(true);
    expect(toolAllowed({ kind: "read" }, false)).toBe(true);
  });

  it("names the switch when it refuses, and says nothing changed", () => {
    // A model told only "not allowed" retries, or goes looking for
    // another tool that achieves the same thing.
    const refusal = gateRefusal("ticket_delete");

    expect(refusal).toContain("Settings → MCP server");
    expect(refusal).toContain("Nothing has been changed");
  });
});

/**
 * Which listener you reached, which is a different question from the
 * gate (EO-192).
 *
 * The gate is a switch a person flips; this is a property of the socket.
 * Keeping them apart matters because one of them is reachable from
 * outside and the other is not, and a tool withheld from strangers must
 * not become reachable by turning something on in Settings.
 */
describe("the admin-only surface", () => {
  const adminOnly = TOOLS.filter((tool) => tool.adminOnly === true).map((tool) => tool.name);

  it("has something in it, so the checks below are not passing on an empty set", () => {
    expect(adminOnly).toContain("view_current");
  });

  it("withholds those tools from the external listener, gate open or shut", () => {
    for (const dangerous of [false, true]) {
      const offered = toolsFor(dangerous, "external").map((tool) => tool.name);
      for (const name of adminOnly) expect(offered, `${name} with dangerousOperations=${dangerous}`).not.toContain(name);
    }
  });

  it("offers them to the admin listener", () => {
    const offered = toolsFor(true, "admin").map((tool) => tool.name);
    for (const name of adminOnly) expect(offered).toContain(name);
  });

  it("treats a caller that does not say which listener it is as external", () => {
    // The fail-safe direction. Anything built later that forgets to pass
    // an audience gets the narrower surface rather than the wider one.
    expect(toolsFor(true).map((tool) => tool.name)).not.toContain("view_current");
  });

  it("answers per tool as well as per list, since a client can call what it was never shown", () => {
    const view = TOOLS.find((tool) => tool.name === "view_current")!;
    const ordinary = TOOLS.find((tool) => tool.name === "ticket_move")!;

    expect(toolOffered(view, "external")).toBe(false);
    expect(toolOffered(view, "admin")).toBe(true);
    expect(toolOffered(ordinary, "external")).toBe(true);
  });
});

/**
 * The other direction (EO-714): a tool only a person may call, which the
 * administrative listener — the one EO's own agents reach — never offers.
 */
describe("the person-only surface", () => {
  const personOnly = TOOLS.filter((tool) => tool.personOnly === true).map((tool) => tool.name);

  it("holds the skill lock, so the checks below are not passing on an empty set", () => {
    expect(personOnly).toEqual(["skill_set_locked"]);
  });

  it("withholds those tools from the admin listener, and offers them to the external one", () => {
    for (const dangerous of [false, true]) {
      const admin = toolsFor(dangerous, "admin").map((tool) => tool.name);
      const external = toolsFor(dangerous, "external").map((tool) => tool.name);
      for (const name of personOnly) {
        expect(admin, `${name} with dangerousOperations=${dangerous}`).not.toContain(name);
        expect(external, `${name} with dangerousOperations=${dangerous}`).toContain(name);
      }
    }
  });

  it("answers per tool as well as per list", () => {
    const lock = TOOLS.find((tool) => tool.name === "skill_set_locked")!;
    expect(toolOffered(lock, "admin")).toBe(false);
    expect(toolOffered(lock, "external")).toBe(true);
  });
});
