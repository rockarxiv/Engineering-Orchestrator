import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { adminDeliveryFor, adminDispatchFor, type AdminMcpLookup } from "./adminDelivery.js";

/**
 * Who is dispatched with EO's administrative server, and who is not
 * (EO-182).
 *
 * The whole of invariant #11 in two functions. Everything below is one
 * of two questions: does this agent hold the grant, and is there a host
 * to point it at — and the answer has to be the same for the file and
 * for the environment, because a `.mcp.json` naming a server whose
 * bearer never arrives is a 401 on every call from a server that
 * connected.
 */
const ENDPOINT = { url: "http://127.0.0.1:54321/mcp", token: "eo-admin-token-nobody-may-write-down" };

/** A host at `url` whose every lease is `token` — what a listener answers, minus the socket. */
function hostAt(url: string, token: string) {
  return { url, lease: () => ({ token, release: () => {} }) };
}
const host = () => hostAt(ENDPOINT.url, ENDPOINT.token);

/** What the CLI's environment is given for the admin server: the bearer, or nothing. */
function adminEnvironment(subject: Pick<Agent, "config">, lookup: AdminMcpLookup): Record<string, string> {
  return adminDispatchFor(subject, lookup)?.environment ?? {};
}

function agent(config: Record<string, unknown>): Pick<Agent, "config"> {
  return { config };
}

const systemAgent = agent({ allowedTools: ["mcp__eo_admin", "mcp__eo__comment", "Read"] });
const implementer = agent({ allowedTools: ["Read", "Write", "Bash", "mcp__eo__ticket_detail"] });
/** The ordinary shape: no allowlist at all, which is most of EO's agents. */
const unlisted = agent({ model: "claude-sonnet-4" });

describe("delivering EO's administrative server", () => {
  let handle: DbHandle | null = null;
  afterEach(() => {
    handle?.close();
    handle = null;
  });

  it("delivers to the agent a migrated database actually has, not one this file invented (EO-185)", () => {
    // Every other case here hand-builds its subject, and for a while
    // that was the whole of the coverage: `systemAgent` above grants
    // itself the server, so these tests passed against an installation
    // where nothing had ever written the grant and the feature had never
    // once run. This is the case that cannot be satisfied by the fixture
    // — the agent comes out of the seed and the migrations, and if 0063
    // stops writing the grant it fails here rather than in production.
    handle = openMigratedTestDb();
    const system = listAgents(handle.db).find((agent) => agent.role === "system")!;

    expect(adminDeliveryFor(system, host)).toEqual({ url: ENDPOINT.url, envName: "EO_ADMIN_TOKEN" });
    expect(adminEnvironment(system, host)).toEqual({ EO_ADMIN_TOKEN: ENDPOINT.token });

    // And nobody else in the seeded set, which is the other half of
    // invariant #11: the implementer and the reviewer own steps.
    for (const other of listAgents(handle.db).filter((agent) => agent.role !== "system")) {
      expect(adminDeliveryFor(other, host), other.role).toBeNull();
    }
  });

  it("gives the agent that holds the grant a URL and a variable name, and the value separately", () => {
    expect(adminDeliveryFor(systemAgent, host)).toEqual({ url: ENDPOINT.url, envName: "EO_ADMIN_TOKEN" });
    expect(adminEnvironment(systemAgent, host)).toEqual({ EO_ADMIN_TOKEN: ENDPOINT.token });
  });

  it("keeps the token out of everything that reaches disk", () => {
    // The delivery object is what `.mcp.json` is written from. A field
    // holding the bearer here would be one careless `JSON.stringify`
    // away from a file under `userData`.
    expect(JSON.stringify(adminDeliveryFor(systemAgent, host))).not.toContain(ENDPOINT.token);
  });

  it("gives a step-owning agent nothing, whatever it has been allowlisted for", () => {
    expect(adminDeliveryFor(implementer, host)).toBeNull();
    expect(adminEnvironment(implementer, host)).toEqual({});
  });

  it("gives an agent with no allowlist nothing, which is most of them", () => {
    // The failing-safe half. Absent means the provider permits everything
    // advertised; it must never mean EO advertises more.
    expect(adminDeliveryFor(unlisted, host)).toBeNull();
    expect(adminEnvironment(unlisted, host)).toEqual({});
  });

  it("delivers nothing when the host is not up, rather than an entry pointing at no socket", () => {
    // Both spellings of "there is no host": a caller that has none at all
    // — the v1 gate, every test that is not about this — and a listener
    // that has not bound yet or failed to.
    for (const lookup of [undefined, () => null]) {
      expect(adminDeliveryFor(systemAgent, lookup)).toBeNull();
      expect(adminEnvironment(systemAgent, lookup)).toEqual({});
    }
  });

  it("leases the turn's credential for the agent being dispatched, which is how what it presses is recorded as its own (EO-585)", () => {
    // One call both backends make — Claude for its environment, Codex
    // for its configuration and environment — so the agent's id reaches
    // the host the same way whichever runs the turn.
    const lease = vi.fn((_agentId?: string) => ({ token: ENDPOINT.token, release: () => {} }));
    const lookup = () => ({ url: ENDPOINT.url, lease });
    adminDispatchFor({ ...systemAgent, id: "the-system-agent" as Agent["id"] }, lookup);
    expect(lease).toHaveBeenCalledWith("the-system-agent");
  });

  it("asks the host again on every dispatch rather than remembering one", () => {
    // The provider is cached for the life of the process and the port is
    // ephemeral, so an endpoint read once at construction would go on
    // being written into directories after the listener behind it had
    // been restarted onto a different port.
    let current: ReturnType<typeof hostAt> | null = null;
    const lookup = () => current;

    expect(adminDeliveryFor(systemAgent, lookup)).toBeNull();
    current = host();
    expect(adminDeliveryFor(systemAgent, lookup)).toEqual({ url: ENDPOINT.url, envName: "EO_ADMIN_TOKEN" });
    current = hostAt("http://127.0.0.1:65000/mcp", "a-second-token");
    expect(adminDeliveryFor(systemAgent, lookup)?.url).toBe("http://127.0.0.1:65000/mcp");
    expect(adminEnvironment(systemAgent, lookup)).toEqual({ EO_ADMIN_TOKEN: "a-second-token" });
  });
});

/**
 * Both halves at once, for the backend that has no generated directory
 * (EO-203).
 *
 * Codex builds its own `mcp_servers` and its own spawn environment inside
 * one function, so it asks one question and gets both answers. These
 * assert the property that makes that worth a separate reader: the URL
 * and the token come off *one* reading of the host, so a listener
 * restarted mid-dispatch cannot hand a CLI one socket's address and
 * another's credential.
 */
describe("delivering it to a backend that assembles its own configuration", () => {
  it("answers with the entry and the credential, off one reading of the host", () => {
    expect(adminDispatchFor(systemAgent, host)).toEqual({
      server: { url: ENDPOINT.url, envName: "EO_ADMIN_TOKEN" },
      environment: { EO_ADMIN_TOKEN: ENDPOINT.token },
      release: expect.any(Function),
    });
  });

  it("keeps the token out of the half that becomes configuration", () => {
    // On this path `server` is flattened into `--config key=value` on the
    // CLI's command line, which anything running as this person can read
    // out of /proc/<pid>/cmdline. The token travels in the environment,
    // which is not readable that way.
    expect(JSON.stringify(adminDispatchFor(systemAgent, host)?.server)).not.toContain(ENDPOINT.token);
  });

  it("answers null on both counts of nothing, so a dispatch gets both halves or neither", () => {
    // No grant, and no host — the two ways there is nothing to deliver.
    // Neither may produce a half: an entry with no bearer behind it is a
    // 401 on every call, and a bearer with no entry is a variable nothing
    // reads.
    expect(adminDispatchFor(implementer, host)).toBeNull();
    expect(adminDispatchFor(unlisted, host)).toBeNull();
    for (const lookup of [undefined, () => null]) expect(adminDispatchFor(systemAgent, lookup)).toBeNull();
  });

  it("agrees with the reader the generated directory is written from, on the same host", () => {
    // Two functions, one decision. If these ever disagree, one backend
    // is delivering a server the other is not — which is the whole of
    // EO-203 restated as a test.
    expect(adminDispatchFor(systemAgent, host)?.server).toEqual(adminDeliveryFor(systemAgent, host));
  });

  it("asks the host again on every dispatch rather than remembering one", () => {
    let current: ReturnType<typeof hostAt> | null = null;
    const lookup = () => current;

    expect(adminDispatchFor(systemAgent, lookup)).toBeNull();
    current = host();
    expect(adminDispatchFor(systemAgent, lookup)?.server.url).toBe(ENDPOINT.url);
    current = hostAt("http://127.0.0.1:65000/mcp", "a-second-token");
    // And both halves move together, which is why this is one call.
    expect(adminDispatchFor(systemAgent, lookup)).toEqual({
      server: { url: "http://127.0.0.1:65000/mcp", envName: "EO_ADMIN_TOKEN" },
      environment: { EO_ADMIN_TOKEN: "a-second-token" },
      release: expect.any(Function),
    });
  });
});

/**
 * A bearer per turn (EO-444).
 *
 * Every turn is a fresh CLI that opens a session on the admin host and
 * leaves without closing it. What lets the host close it is the turn
 * letting its bearer go — so the bearer has to be the turn's own, minted
 * when the turn asks and handed back with the means to let it go.
 */
describe("a bearer of the turn's own", () => {
  function leasingHost() {
    const minted: string[] = [];
    const released: string[] = [];
    const lookup = () => ({
      url: ENDPOINT.url,
      lease: () => {
        const token = `turn-${minted.length + 1}`;
        minted.push(token);
        return { token, release: () => released.push(token) };
      },
    });
    return { lookup, minted, released };
  }

  it("mints one for each dispatch that asks, and hands back the way to let it go", () => {
    const { lookup, minted, released } = leasingHost();

    const first = adminDispatchFor(systemAgent, lookup);
    const second = adminDispatchFor(systemAgent, lookup);

    expect(first?.environment).toEqual({ EO_ADMIN_TOKEN: "turn-1" });
    expect(second?.environment).toEqual({ EO_ADMIN_TOKEN: "turn-2" });
    first?.release();
    expect(released).toEqual(["turn-1"]);
    expect(minted).toEqual(["turn-1", "turn-2"]);
  });

  it("mints nothing to say where the host is, which is all the generated directory needs", () => {
    // `.mcp.json` carries the URL and a variable's *name*. Minting a
    // bearer for it would be one nobody lets go of.
    const { lookup, minted } = leasingHost();

    expect(adminDeliveryFor(systemAgent, lookup)?.url).toBe(ENDPOINT.url);
    expect(minted).toEqual([]);
  });

  it("mints nothing for an agent that holds no grant", () => {
    const { lookup, minted } = leasingHost();
    const lease = vi.fn();

    expect(adminDispatchFor(implementer, lookup)).toBeNull();
    expect(adminDispatchFor(unlisted, () => ({ url: ENDPOINT.url, lease }))).toBeNull();
    expect(minted).toEqual([]);
    expect(lease).not.toHaveBeenCalled();
  });
});
