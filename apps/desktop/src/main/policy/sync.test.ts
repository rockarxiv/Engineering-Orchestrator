import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedServerIds, McpServerDraftSchema, NO_POLICY, ORGANISATION_SECRETS_PATH, type IpcChannel, type IpcResult, type OrganisationPolicy } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listMcpServers, saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import type { ServerClient } from "../managed/serverClient.js";
import {
  listOrganisationSecretNames,
  readOrganisationSecret,
  storeOrganisationSecret,
  type OrganisationSecretsOptions,
} from "./organisationSecrets.js";
import { readPolicy, writePolicy } from "./policy.js";
import { createPolicySync, syncPolicy } from "./sync.js";

/**
 * Taking the organisation's policy, and the values behind it (EO-328,
 * ARCHITECTURE.md, "Policy", "The record").
 *
 * Two things are being held to: that a device ends up on what the record
 * published, and that a device which cannot reach the record keeps
 * working on the copy it has — except for a withdrawal, which lands as
 * soon as the record has said so.
 */

const reverse = (text: string) => [...text].reverse().join("");
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};

let handle: DbHandle;
let directory: string;
let secrets: OrganisationSecretsOptions;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo policy sync "));
  secrets = { directory, store };
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A record that answers `policy:get` with this, and nothing else. */
function recordServing(policy: OrganisationPolicy): ServerClient {
  return {
    address: "https://eo.example.com",
    request: <K extends IpcChannel>(channel: K): Promise<IpcResult<unknown>> =>
      Promise.resolve(
        channel === "policy:get"
          ? { ok: true, data: { policy, fromServer: true, yours: null } }
          : { ok: false, error: { message: `unexpected ${channel}` } },
      ) as Promise<IpcResult<never>>,
  } as unknown as ServerClient;
}

/** The route, as a `fetch`. */
function serving(values: Record<string, string>): typeof globalThis.fetch {
  return vi.fn((input: Parameters<typeof globalThis.fetch>[0]) => {
    expect(String(input)).toBe(`https://eo.example.com${ORGANISATION_SECRETS_PATH}`);
    return Promise.resolve(new Response(JSON.stringify({ secrets: values }), { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
}

const PUBLISHED: OrganisationPolicy = {
  ...NO_POLICY,
  allowedBackends: ["claude"],
  perPersonDailyBudgetCents: 1_000,
  secretNames: ["FLY_API_TOKEN"],
  publishedAt: 5,
};

describe("a device taking its organisation's policy", () => {
  it("does nothing at all on a desktop with no record to ask", async () => {
    const result = await syncPolicy({ db: handle.db, client: () => null, secrets, secretsKey: () => null });

    expect(result).toEqual({
      reached: false,
      changed: false,
      policy: NO_POLICY,
      unresolved: [],
      servers: { applied: [], refused: [], withdrawn: [] },
    });
  });

  it("caches what the record published, and the values behind it", async () => {
    const result = await syncPolicy({
      db: handle.db,
      client: () => recordServing(PUBLISHED),
      secrets,
      secretsKey: () => "a-secrets-key",
      fetch: serving({ FLY_API_TOKEN: "tok-1" }),
    });

    expect(result.reached).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.unresolved).toEqual([]);
    // Cached, so the next dispatch reads it without a network call — and
    // so the design holds when this machine goes offline an hour from now.
    expect(readPolicy(handle.db).allowedBackends).toEqual(["claude"]);
    expect(readOrganisationSecret(secrets, "FLY_API_TOKEN")).toBe("tok-1");
  });

  it("forgets a name the organisation has stopped publishing", async () => {
    storeOrganisationSecret(secrets, "WITHDRAWN", "old");
    storeOrganisationSecret(secrets, "FLY_API_TOKEN", "old");

    await syncPolicy({
      db: handle.db,
      client: () => recordServing(PUBLISHED),
      secrets,
      secretsKey: () => "a-secrets-key",
      fetch: serving({ FLY_API_TOKEN: "tok-1" }),
    });

    expect(listOrganisationSecretNames(secrets)).toEqual(["FLY_API_TOKEN"]);
  });

  it("withdraws even when the values never arrive", async () => {
    // The half that must not wait for a good network: the record has
    // said what it publishes, so the credential it no longer names goes
    // now, whatever happens to the second request.
    storeOrganisationSecret(secrets, "WITHDRAWN", "old");
    storeOrganisationSecret(secrets, "FLY_API_TOKEN", "old");
    const refusing = vi.fn(() => Promise.resolve(new Response("nope", { status: 503 }))) as unknown as typeof globalThis.fetch;

    const result = await syncPolicy({
      db: handle.db,
      client: () => recordServing(PUBLISHED),
      secrets,
      secretsKey: () => "a-secrets-key",
      fetch: refusing,
    });

    expect(result.reached).toBe(true);
    expect(readOrganisationSecret(secrets, "WITHDRAWN")).toBeNull();
    // …and the last good copy of what is still published stands.
    expect(readOrganisationSecret(secrets, "FLY_API_TOKEN")).toBe("old");
    expect(result.unresolved).toEqual([]);
  });

  it("keeps the copy it has when the record cannot be reached at all", async () => {
    writePolicy(handle.db, PUBLISHED);
    storeOrganisationSecret(secrets, "FLY_API_TOKEN", "old");
    const silent = {
      address: "https://eo.example.com",
      request: () => Promise.resolve({ ok: false, error: { message: "offline" } }),
    } as unknown as ServerClient;

    const result = await syncPolicy({ db: handle.db, client: () => silent, secrets, secretsKey: () => "a-secrets-key" });

    expect(result.reached).toBe(false);
    expect(result.policy.allowedBackends).toEqual(["claude"]);
    expect(readOrganisationSecret(secrets, "FLY_API_TOKEN")).toBe("old");
  });

  it("asks for no values at all when the organisation publishes none", async () => {
    storeOrganisationSecret(secrets, "WITHDRAWN", "old");
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;

    await syncPolicy({
      db: handle.db,
      client: () => recordServing({ ...PUBLISHED, secretNames: [] }),
      secrets,
      secretsKey: () => "a-secrets-key",
      fetch: fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(listOrganisationSecretNames(secrets)).toEqual([]);
  });

  it("says which published names it has no value for", async () => {
    const result = await syncPolicy({
      db: handle.db,
      client: () => recordServing({ ...PUBLISHED, secretNames: ["FLY_API_TOKEN", "SLACK_WEBHOOK"] }),
      secrets,
      secretsKey: () => "a-secrets-key",
      fetch: serving({ FLY_API_TOKEN: "tok-1" }),
    });

    expect(result.unresolved).toEqual(["SLACK_WEBHOOK"]);
  });
});

describe("the tick's rate limit", () => {
  /**
   * A push is not a poll (EO-328, review).
   *
   * The rate limit exists to stop a laptop asking its server for a list
   * of credentials every few seconds, and it was swallowing the one
   * event it should never have applied to: the record saying *this
   * changed*. An admin who disallowed a backend then watched a device go
   * on dispatching to it for up to a minute — and the acceptance
   * criterion is that a device bound to a disallowed backend **cannot**
   * dispatch, not that it stops shortly.
   */
  it("asks immediately when the record says something was published", async () => {
    let now = 1_000_000;
    const published: OrganisationPolicy[] = [{ ...PUBLISHED, secretNames: [] }];
    const run = createPolicySync({
      db: handle.db,
      client: () => recordServing(published[published.length - 1]!),
      secrets,
      secretsKey: () => "a-secrets-key",
      minIntervalMs: 60_000,
      now: () => now,
    });

    // An ordinary tick, which stamps the clock.
    expect(await run()).not.toBeNull();
    // A second tick a moment later is inside the window and is skipped,
    // which is the behaviour being kept rather than removed.
    now += 1_000;
    expect(await run("polling")).toBeNull();

    // …and the admin publishes. The push arrives well inside the same
    // window, and it is not dropped.
    published.push({ ...PUBLISHED, secretNames: [], allowedBackends: ["claude"] });
    const pushed = await run("published");

    expect(pushed).not.toBeNull();
    expect(readPolicy(handle.db).allowedBackends).toEqual(["claude"]);
  });

  it("stamps the clock, so a push and a tick arriving together are one pass", async () => {
    // Otherwise the two would fight: a push that did not stamp would
    // leave the next tick free to ask again a millisecond later.
    let now = 1_000_000;
    const client = vi.fn(() => recordServing({ ...PUBLISHED, secretNames: [] }));
    const run = createPolicySync({
      db: handle.db,
      client,
      secrets,
      secretsKey: () => "a-secrets-key",
      minIntervalMs: 60_000,
      now: () => now,
    });

    expect(await run("published")).not.toBeNull();
    now += 1_000;
    expect(await run("polling")).toBeNull();
    expect(client).toHaveBeenCalledTimes(1);
  });

  it("asks once and then skips until the interval has passed", async () => {
    let now = 1_000_000;
    const client = vi.fn(() => recordServing(PUBLISHED));
    const run = createPolicySync({
      db: handle.db,
      client,
      secrets,
      secretsKey: () => "a-secrets-key",
      fetch: serving({ FLY_API_TOKEN: "tok-1" }),
      minIntervalMs: 60_000,
      now: () => now,
    });

    expect(await run()).not.toBeNull();
    // Null rather than a stale result, so a caller can tell "nothing was
    // asked" from "nothing had changed".
    now += 59_000;
    expect(await run()).toBeNull();
    now += 2_000;
    expect(await run()).not.toBeNull();
    expect(client).toHaveBeenCalledTimes(2);
  });
});

describe("the MCP servers the organisation publishes", () => {
  const GITHUB = {
    id: "01a0b000-0000-7000-8000-000000000001",
    name: "github",
    description: "reads your issues",
    config: { transport: "stdio" as const, command: "gh-mcp", args: [] },
    envNames: ["GITHUB_TOKEN"],
  };

  function withServers(servers: OrganisationPolicy["mcpServers"]): OrganisationPolicy {
    return { ...PUBLISHED, secretNames: [], mcpServers: servers };
  }

  it("lands in this machine's own catalogue, under the record's id", async () => {
    // The same table every consumer downstream already reads, so the
    // attachment picker, the generated configuration and the dispatch
    // all work unchanged — and the record's id, so an attachment made on
    // one desktop names something the next desktop also has.
    const result = await syncPolicy({
      db: handle.db,
      client: () => recordServing(withServers([GITHUB])),
      secrets,
      secretsKey: () => "a-secrets-key",
    });

    expect(result.servers).toEqual({ applied: [GITHUB.id], refused: [], withdrawn: [] });
    const installed = listMcpServers(handle.db, false);
    expect(installed.map((server) => [server.id, server.name])).toEqual([[GITHUB.id, "github"]]);
    expect(installed[0]?.envNames).toEqual(["GITHUB_TOKEN"]);
    expect(managedServerIds(readPolicy(handle.db))).toEqual([GITHUB.id]);
  });

  it("refuses rather than renames when this machine already has that name", async () => {
    // Somebody's own row is somebody's own work. Taking its name would
    // break whatever refers to it, in order to install something they
    // never asked for.
    const mine = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "my-own" }));
    expect(mine.ok).toBe(true);
    const said: string[] = [];

    const result = await syncPolicy({
      db: handle.db,
      client: () => recordServing(withServers([GITHUB])),
      secrets,
      secretsKey: () => "a-secrets-key",
      onProblem: (line) => said.push(line),
    });

    expect(result.servers.applied).toEqual([]);
    expect(result.servers.refused[0]?.name).toBe("github");
    expect(result.servers.refused[0]?.problem).toContain("Rename yours");
    expect(listMcpServers(handle.db, false)).toHaveLength(1);
    // …and it is said out loud rather than left to be discovered by an
    // agent that was never given the server (invariant #12).
    expect(said).toHaveLength(1);
  });

  it("archives one the organisation stops publishing, and leaves a person's own alone", async () => {
    const client = { current: withServers([GITHUB]) };
    const mine = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "mine", transport: "stdio", command: "my-own" }));

    await syncPolicy({ db: handle.db, client: () => recordServing(client.current), secrets, secretsKey: () => "a-secrets-key" });
    client.current = withServers([]);
    const second = await syncPolicy({ db: handle.db, client: () => recordServing(client.current), secrets, secretsKey: () => "a-secrets-key" });

    expect(second.servers.withdrawn).toEqual([GITHUB.id]);
    // Archived rather than deleted: an attachment that named it still
    // resolves (invariant #3).
    expect(listMcpServers(handle.db, true).find((server) => server.id === GITHUB.id)?.archivedAt).not.toBeNull();
    expect(listMcpServers(handle.db, false).map((server) => server.name)).toEqual(["mine"]);
    expect(mine.ok).toBe(true);
  });
});

describe("what a pass says changed", () => {
  it("says nothing changed when nothing did, so no screen is told to redraw", async () => {
    // A push a minute, every minute, on every desktop, for a policy
    // nobody touched would be EO reporting its own timer.
    const options = {
      db: handle.db,
      client: () => recordServing({ ...PUBLISHED, secretNames: [] }),
      secrets,
      secretsKey: () => "a-secrets-key",
    };

    expect((await syncPolicy(options)).changed).toBe(true);
    expect((await syncPolicy(options)).changed).toBe(false);
  });
});
