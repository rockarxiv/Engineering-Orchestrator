import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcPayload, SandboxAvailability } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getAgent, listAgents, updateAgent } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { RUNTIMES, versionFor } from "../runtimes/catalog.js";
import type { Machine, RuntimeContext } from "./runtimeCommands.js";
import { saveAgentChecked, sandboxStatus, setAgentBindingChecked, type SandboxCheck } from "./sandboxCommands.js";

/**
 * Whether the sandbox can start, asked of the binary the agent would run
 * (EO-935) — its own `executablePath` where it names one, EO's managed
 * copy otherwise, as dispatch resolves it — and a save refused where it
 * would turn a sandbox on that this machine cannot start.
 */
const CODEX_VERSION = versionFor(RUNTIMES.codex, "linux", "x64")!;
const CAN: SandboxAvailability = { available: true, how: "Codex's bubblewrap, which it carries with it" };
const CANNOT: SandboxAvailability = { available: false, reason: "Codex could not start its sandbox on this machine: bwrap: No permissions to create a new namespace", fix: "Allow unprivileged user namespaces." };

let handle: DbHandle;
let scratch: string;
let context: RuntimeContext;
let machine: Machine;

beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "eo-935-")));
  handle = openMigratedTestDb();
  context = { root: join(scratch, "runtimes"), fetchImpl: async () => new Response("", { status: 500 }), db: handle.db };
  machine = { platform: "linux", arch: "x64", env: { PATH: "" }, home: join(scratch, "home") };
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** EO's managed Codex, where the runtime cache keeps it. */
function managedCodex(): string {
  return executable(join(context.root, `codex@${CODEX_VERSION}`, "vendor", "x86_64-unknown-linux-gnu", "bin", "codex"));
}

/** A check whose answer depends on which binary it is asked about, recording each. */
function answering(byPath: Record<string, SandboxAvailability>): { check: SandboxCheck; asked: (string | null)[] } {
  const asked: (string | null)[] = [];
  return {
    asked,
    check: async (_provider, path) => {
      asked.push(path);
      return path === null ? CANNOT : (byPath[path] ?? CANNOT);
    },
  };
}

describe("the editor's answer", () => {
  it("is about the agent's own executable, not EO's managed copy, where the two differ", async () => {
    const managed = managedCodex();
    const custom = executable(join(scratch, "opt", "codex"));
    const { check, asked } = answering({ [managed]: CAN, [custom]: CANNOT });

    expect(await sandboxStatus(context, { provider: "codex" }, check, machine)).toEqual({ sandbox: CAN });
    expect(await sandboxStatus(context, { provider: "codex", executablePath: custom }, check, machine)).toEqual({ sandbox: CANNOT });
    expect(asked).toEqual([managed, custom]);
  });

  it("asks the agent's own executable where EO has no managed copy, rather than finding nothing", async () => {
    const custom = executable(join(scratch, "opt", "codex"));
    const { check, asked } = answering({ [custom]: CAN });

    expect(await sandboxStatus(context, { provider: "codex", executablePath: custom }, check, machine)).toEqual({ sandbox: CAN });
    expect(asked).toEqual([custom]);
  });
});

describe("saving an agent's sandbox setting", () => {
  function implementer() {
    const found = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    updateAgent(handle.db, found.id, { provider: "codex" });
    return getAgent(handle.db, found.id)!;
  }

  function saving(agent: ReturnType<typeof implementer>, config: Record<string, unknown>, provider = agent.provider): IpcPayload<"agents:save"> {
    return { id: agent.id, name: agent.name, role: agent.role, provider, model: agent.model, instructions: agent.instructions, enabled: agent.enabled, config };
  }

  it("refuses turning it on where this machine cannot start it, says why and what would fix it, and writes nothing", async () => {
    managedCodex();
    const agent = implementer();

    const saved = await saveAgentChecked(handle.db, context, saving(agent, { ...agent.config, sandboxed: true }), async () => CANNOT, machine);

    expect(saved.saved).toBe(false);
    expect(saved.problem).toContain(`This machine cannot start the "codex" sandbox, so EO did not turn the sandbox on for ${agent.name}`);
    expect(saved.problem).toContain(CANNOT.reason);
    expect(saved.problem).toContain(CANNOT.fix);
    expect(getAgent(handle.db, agent.id)?.config["sandboxed"]).toBeUndefined();
  });

  it("turns it on where it can start, asking about the agent's own executable", async () => {
    managedCodex();
    const custom = executable(join(scratch, "opt", "codex"));
    const agent = implementer();
    const { check, asked } = answering({ [custom]: CAN });

    const saved = await saveAgentChecked(handle.db, context, saving(agent, { ...agent.config, executablePath: custom, sandboxed: true }), check, machine);

    expect(saved.saved).toBe(true);
    expect(asked).toEqual([custom]);
    expect(getAgent(handle.db, agent.id)?.config["sandboxed"]).toBe(true);
  });

  it("still saves, and turns off, an agent already sandboxed on a machine that cannot start it, asking nothing", async () => {
    managedCodex();
    const agent = implementer();
    updateAgent(handle.db, agent.id, { config: { ...agent.config, sandboxed: true } });
    const sandboxed = getAgent(handle.db, agent.id)!;
    let asked = 0;
    const check: SandboxCheck = async () => {
      asked += 1;
      return CANNOT;
    };

    expect((await saveAgentChecked(handle.db, context, { ...saving(sandboxed, sandboxed.config), name: "Renamed" }, check, machine)).saved).toBe(true);
    const off = { ...sandboxed.config };
    delete off["sandboxed"];
    expect((await saveAgentChecked(handle.db, context, saving(sandboxed, off), check, machine)).saved).toBe(true);
    expect(getAgent(handle.db, agent.id)?.config["sandboxed"]).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("asks again when a sandboxed agent moves to another backend, which is turning it on there", async () => {
    managedCodex();
    const agent = implementer();
    updateAgent(handle.db, agent.id, { config: { ...agent.config, sandboxed: true } });
    const sandboxed = getAgent(handle.db, agent.id)!;
    const providers: string[] = [];

    const saved = await saveAgentChecked(handle.db, context, saving(sandboxed, sandboxed.config, "claude"), async (provider) => {
      providers.push(provider);
      return CANNOT;
    }, machine);

    expect(providers).toEqual(["claude"]);
    expect(saved.saved).toBe(false);
    expect(getAgent(handle.db, agent.id)?.provider).toBe("codex");
  });

  it("asks nothing of a save that leaves the sandbox off", async () => {
    const agent = implementer();
    let asked = 0;

    const saved = await saveAgentChecked(handle.db, context, saving(agent, agent.config), async () => {
      asked += 1;
      return CANNOT;
    }, machine);

    expect(saved.saved).toBe(true);
    expect(asked).toBe(0);
  });

  it("refuses to bind a sandboxed agent onto a backend whose sandbox cannot start here, and binds it where it can", async () => {
    const agent = implementer();
    updateAgent(handle.db, agent.id, { config: { ...agent.config, sandboxed: true } });

    const refused = await setAgentBindingChecked(handle.db, context, { agentId: agent.id, provider: "claude", model: null }, async () => CANNOT, machine);
    expect(refused.bound).toBe(false);
    expect(refused.problem).toContain(`${agent.name} runs sandboxed, and this machine cannot start the "claude" sandbox`);
    expect(refused.problem).toContain(CANNOT.fix);
    expect(getAgent(handle.db, agent.id)?.provider).toBe("codex");

    const bound = await setAgentBindingChecked(handle.db, context, { agentId: agent.id, provider: "claude", model: null }, async () => CAN, machine);
    expect(bound.bound).toBe(true);
    expect(getAgent(handle.db, agent.id)?.provider).toBe("claude");
  });
});
