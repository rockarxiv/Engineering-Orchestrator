import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGNED_OUT_BY_ORGANISATION } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { listPublishedSections, publishSection } from "../db/repos/index.js";
import { markRevoked, readSecretsKey, readToken, type SessionStoreOptions } from "../managed/session.js";
import { sessionStatusCommand, signInCommand, signOutCommand } from "./sessionCommands.js";

/**
 * This machine's sign-in (EO-323, ARCHITECTURE.md, "Identity", the story's first and
 * third acceptance criteria).
 *
 * Two things are proved here that nothing else can: that a plain-http
 * address to somewhere other than this machine is refused **before a
 * socket is opened**, and that the device token the server issues lands
 * in the keychain rather than in the database.
 */
describe("signing this desktop in", () => {
  let handle: DbHandle;
  let directory: string;
  let session: SessionStoreOptions;
  /** Every address `fetch` was actually called with, so "refused before it was sent" is checkable. */
  let asked: string[];

  /**
   * A keychain, as `safeStorage` is one — reversible here, because what
   * these tests are about is *where* the token goes rather than how
   * strong the cipher is. The real one is Electron's; this one is the
   * same interface, which is why `SecretStore` is an interface.
   */
  const keychain = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`sealed:${text}`, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^sealed:/, ""),
  };

  beforeEach(() => {
    handle = openMigratedTestDb();
    directory = mkdtempSync(join(tmpdir(), "eo-session-"));
    session = { db: handle.db, directory: join(directory, "managed"), store: keychain };
    asked = [];
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A server that answers one sign-in, and records what it was asked. */
  function serverAnswering(body: unknown, sent?: unknown[], status = 200): typeof globalThis.fetch {
    return vi.fn((input: unknown, init?: { body?: string }) => {
      asked.push(String(input));
      if (sent !== undefined && typeof init?.body === "string") sent.push(JSON.parse(init.body));
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof globalThis.fetch;
  }

  const SESSION_BODY = {
    ok: true,
    data: {
      session: {
        token: "a-device-token",
        // The second credential this sign-in earns (EO-328, ARCHITECTURE.md, "Secrets") — the
        // one that opens the organisation-secrets route, which the
        // device token deliberately does not.
        secretsKey: "a-secrets-key",
        deviceId: "device-1",
        person: { id: "p1", name: "Anna Ruiz", email: "anna@example.com", isAdmin: false, invitedAt: 1, acceptedAt: 2, credentialKind: "password" },
      },
      problem: null,
    },
  };

  it("refuses plain http to somewhere that is not this machine, without sending anything", async () => {
    const fetchImpl = serverAnswering(SESSION_BODY);

    const result = await signInCommand(
      { session, fetch: fetchImpl, machineName: () => "anna-macbook" },
      { address: "http://eo.example.com", email: "anna@example.com", password: "a memorable passphrase" },
    );

    expect(result.problem).toContain("in the clear");
    expect(result.status.state).toBe("signed-out");
    // The whole point of checking the address rather than the answer: a
    // password that has already crossed the network cannot be un-sent.
    expect(asked).toEqual([]);
  });

  it("signs in over loopback, and keeps the token in the keychain rather than the database", async () => {
    const result = await signInCommand(
      { session, fetch: serverAnswering(SESSION_BODY), machineName: () => "anna-macbook" },
      { address: "http://127.0.0.1:8765/", email: "Anna@Example.com", password: "a memorable passphrase" },
    );

    expect(result.problem).toBeNull();
    expect(result.status).toMatchObject({
      state: "signed-in",
      // Normalised: `${address}/ipc/…` is one path rather than sometimes two.
      address: "http://127.0.0.1:8765",
      personName: "Anna Ruiz",
      deviceId: "device-1",
      deviceName: "anna-macbook",
    });
    expect(asked).toEqual(["http://127.0.0.1:8765/ipc/auth%3AsignIn"]);

    // In the keychain's directory, and nowhere in the database —
    // the original design, "Secrets: OS keychain, never the DB".
    expect(readToken(session)).toBe("a-device-token");
    // Both credentials, both in the keychain's directory, and neither in
    // the database. The secrets key is a separate file so that a device
    // whose key is withdrawn loses exactly that and keeps its session
    // (EO-328).
    expect(readSecretsKey(session)).toBe("a-secrets-key");
    expect(readdirSync(join(directory, "managed")).sort()).toEqual(["device-token.bin", "organisation-secrets-key.bin"]);
    const settings = JSON.stringify(handle.db.all(sql`select * from app_settings`));
    expect(settings).not.toContain("a-device-token");
    expect(settings).not.toContain("a-secrets-key");
  });

  it("declares that it runs work, which is what earns the secrets key", async () => {
    // The desktop is the machine that runs the work, so it is the one
    // client that asks for the credential the organisation-secrets route
    // wants. The renderer a server serves says nothing here and is
    // issued none — see `SignInRequest.runsWork`.
    const sent: unknown[] = [];
    const fetchImpl = serverAnswering(SESSION_BODY, sent);

    await signInCommand({ session, fetch: fetchImpl }, { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "s3cret" });

    expect(sent[0]).toMatchObject({ payload: { runsWork: true } });
  });

  it("forgets the secrets key with the token when a person signs out", async () => {
    await signInCommand({ session, fetch: serverAnswering(SESSION_BODY) }, { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "s3cret" });
    expect(readSecretsKey(session)).toBe("a-secrets-key");

    signOutCommand({ session });

    // A machine that has left has no business holding the credential
    // that fetches somebody else's secrets.
    expect(readSecretsKey(session)).toBeNull();
  });

  it("holds no key at all from a server too old to mint one", async () => {
    // `ServerClient` hands the body over unparsed, so an absent member
    // arrives as `undefined` rather than as the schema's null. Both are
    // one thing: this device was issued no key.
    const older = { ok: true, data: { session: { token: "a-device-token", deviceId: "device-1", person: SESSION_BODY.data.session.person }, problem: null } };

    await signInCommand({ session, fetch: serverAnswering(older) }, { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "s3cret" });

    expect(readToken(session)).toBe("a-device-token");
    expect(readSecretsKey(session)).toBeNull();
    expect(readdirSync(join(directory, "managed"))).toEqual(["device-token.bin"]);
  });

  it("says what the server said when it refuses, and stays signed out", async () => {
    const result = await signInCommand(
      { session, fetch: serverAnswering({ ok: true, data: { session: null, problem: "That email address and password do not match anybody on this server." } }) },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "not it" },
    );

    expect(result.problem).toContain("do not match anybody");
    expect(result.status.state).toBe("signed-out");
    expect(readToken(session)).toBeNull();
  });

  it("does not call a wrong password a revocation", async () => {
    // A 401 on a request that carried no token is a password that was
    // wrong. Saying "your organisation signed you out" to somebody who
    // has never signed in would be a lie in the one place a person is
    // least able to check it.
    const result = await signInCommand(
      { session, fetch: serverAnswering({ ok: false, error: { message: "This EO server did not accept that token." } }, undefined, 401) },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "not it" },
    );

    expect(result.status.state).toBe("signed-out");
  });

  it("sends the device it last held, so signing in again does not grow the admin's list", async () => {
    const context = { session, fetch: serverAnswering(SESSION_BODY), machineName: () => "anna-macbook" };
    await signInCommand(context, { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "a memorable passphrase" });

    const bodies: unknown[] = [];
    const recording = vi.fn((_input: unknown, init: { body?: string } = {}) => {
      bodies.push(JSON.parse(init.body ?? "{}"));
      return Promise.resolve(new Response(JSON.stringify(SESSION_BODY), { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof globalThis.fetch;

    await signInCommand(
      { session, fetch: recording, machineName: () => "anna-macbook" },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "a memorable passphrase" },
    );

    expect(bodies).toMatchObject([{ payload: { deviceId: "device-1", deviceName: "anna-macbook" } }]);
  });

  it("says who signed this machine out, and keeps saying it until somebody signs in again", async () => {
    // The story's first acceptance criterion, at this end: "the desktop
    // shows 'signed out by your organisation'."
    await signInCommand(
      { session, fetch: serverAnswering(SESSION_BODY), machineName: () => "anna-macbook" },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "a memorable passphrase" },
    );

    markRevoked(session);

    const status = sessionStatusCommand({ session });
    expect(status).toMatchObject({ state: "revoked", address: "http://127.0.0.1:8765", email: "anna@example.com" });
    expect(status.state === "revoked" && status.line).toContain(SIGNED_OUT_BY_ORGANISATION);
    // The dead credential is gone — keeping it would only mean
    // presenting it again — while the address and the email stay, so the
    // form comes back pre-filled under the sentence.
    expect(readToken(session)).toBeNull();

    const back = await signInCommand(
      { session, fetch: serverAnswering(SESSION_BODY), machineName: () => "anna-macbook" },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "a memorable passphrase" },
    );
    expect(back.status.state).toBe("signed-in");
  });

  it("forgets the token on the way out, and leaves the device row for the admin to revoke", async () => {
    await signInCommand(
      { session, fetch: serverAnswering(SESSION_BODY), machineName: () => "anna-macbook" },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "a memorable passphrase" },
    );

    expect(signOutCommand({ session }).status.state).toBe("signed-out");
    expect(readToken(session)).toBeNull();
    // Nothing was sent to the server: this end cannot prove it is the
    // machine giving the token up, and a call that let it would let
    // anybody holding a stolen token erase the row naming the machine it
    // was stolen from.
    expect(asked).toHaveLength(1);
  });

  it("forgets what the organisation had published, so nothing stays locked by nobody", async () => {
    await signInCommand(
      { session, fetch: serverAnswering(SESSION_BODY), machineName: () => "anna-macbook" },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "a memorable passphrase" },
    );
    // What the sync had delivered: the organisation's statement that
    // this section is managed (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
    publishSection(handle.db, { section: "pipelines", subjectId: "default", publishedAt: Date.now(), publishedBy: "dana", publishedByName: "Dana" });

    signOutCommand({ session });

    // A lock outliving the link that justified it would be a
    // configuration nobody on earth could unlock: not the admin, who is
    // never asked about this machine again, and not the person sitting
    // at it.
    expect(listPublishedSections(handle.db)).toEqual([]);
  });

  it("refuses to record a sign-in it cannot keep the token for", async () => {
    const noKeychain = {
      ...session,
      store: { ...keychain, isEncryptionAvailable: () => false },
    };

    const result = await signInCommand(
      { session: noKeychain, fetch: serverAnswering(SESSION_BODY), machineName: () => "anna-macbook" },
      { address: "http://127.0.0.1:8765", email: "anna@example.com", password: "a memorable passphrase" },
    );

    // A session recorded without the credential it needs is a desktop
    // that believes it is signed in and cannot prove it to anybody.
    expect(result.problem).toContain("no OS keychain");
    expect(result.status.state).toBe("signed-out");
  });
});
