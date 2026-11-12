import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { invitationCodeFrom, type IpcResponse } from "@eo/core";
import { clearHandlerRegistry } from "../ipc/registry.js";
import { sourceTreeResources } from "../testing/platform.js";
import type { ServerConfig } from "./config.js";
import { startServer, type RunningServer } from "./start.js";
import { removeScratch } from "../testing/scratch.js";

/**
 * An administrator looking into every project, and a colleague looking
 * into their own (EO-326, `ARCHITECTURE.md`, "Identity").
 *
 * This story's first and third acceptance criteria, against a **real
 * server**: a real `startServer` on an empty directory, real migrations,
 * a real socket, real `fetch`, real device tokens minted by a real
 * sign-in. Nothing is stubbed between the request and SQLite, because
 * everything this story is about happens at the door — who the caller
 * is, what they may be shown, and whose name a move is recorded under.
 * A test that called the handlers directly would be a test of code with
 * the one interesting question already answered.
 *
 * `smoke.test.ts`'s mocks, for its reason: a single `import "electron"`
 * anywhere in this graph fails the file with the sentence it throws, and
 * a server binary that loaded Electron would not be a server binary.
 */
vi.mock("electron", () => {
  throw new Error("The server loaded Electron. A headless host has none.");
});
vi.mock("electron-updater", () => {
  throw new Error("The server loaded electron-updater. A server is updated by whatever installed it.");
});

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** The operator's key: how somebody reaches a server whose people list is still empty. */
const OPERATOR = "an-admin-token-from-the-environment";
const SECRET_KEY = Buffer.alloc(32, 7);
const PASSWORD = "correct horse battery staple";

let running: { server: RunningServer; directories: string[] } | null = null;

afterEach(async () => {
  clearHandlerRegistry();
  if (!running) return;
  const { server, directories } = running;
  running = null;
  await server.main.stop();
  await server.platform.stopServing();
  server.release();
  for (const directory of directories) removeScratch(directory);
});

function start(): RunningServer {
  const userDataPath = join(mkdtempSync(join(tmpdir(), "eo-admin-")), "data");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: OPERATOR,
    secretKey: SECRET_KEY,
    userDataPath,
    rendererDirectory: null,
    version: "7.7.7",
  };
  const started = startServer(config, { resources: sourceTreeResources(), exit: () => {} });
  if (!started.ok) throw new Error(started.problem);
  running = { server: started.server, directories: [join(userDataPath, "..")] };
  return started.server;
}

async function origin(server: RunningServer): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const address = server.platform.address();
    if (address !== null) return `http://${address.host}:${address.port}`;
    await new Promise((settle) => setTimeout(settle, 10));
  }
  throw new Error("The server never bound a port.");
}

/** One channel, as a browser or a desktop sends it. Unwrapped, because every call below expects an answer. */
async function ask<K extends keyof typeof import("@eo/core").ipcContract>(
  base: string,
  channel: K,
  payload: unknown,
  token?: string,
): Promise<IpcResponse<K>> {
  const response = await fetch(`${base}/ipc/${channel}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ payload }),
  });
  const envelope = (await response.json()) as { ok: boolean; data?: unknown; error?: { message: string } };
  if (!envelope.ok) throw new Error(`${channel}: ${envelope.error?.message ?? "refused"}`);
  return envelope.data as IpcResponse<K>;
}

/**
 * Somebody on the organisation's list, signed in from a browser.
 *
 * The whole path rather than a row written behind the door: invite,
 * accept, sign in. It is the path this story adds the last step of — a
 * browser holding a device token rather than the operator's stand-in —
 * and a fixture that skipped it would prove the narrowing works for a
 * caller no server can actually have.
 */
async function member(base: string, name: string, email: string, isAdmin: boolean): Promise<{ personId: string; token: string }> {
  const invited = await ask(base, "people:invite", { email, name, isAdmin }, OPERATOR);
  if (invited.person === null || invited.invitePath === null) throw new Error(invited.problem ?? "not invited");

  const code = invitationCodeFrom(invited.invitePath);
  if (code === null) throw new Error(`no code in ${invited.invitePath}`);
  const accepted = await ask(base, "auth:acceptInvitation", { code, password: PASSWORD, name });
  if (accepted.accepted === null) throw new Error(accepted.problem ?? "not accepted");

  const session = await ask(base, "auth:signIn", { email, password: PASSWORD, deviceName: `${name}'s browser` });
  if (session.session === null) throw new Error(session.problem ?? "not signed in");
  return { personId: invited.person.id, token: session.session.token };
}

async function project(base: string, name: string, keyPrefix: string): Promise<string> {
  const created = await ask(base, "projects:create", { name, keyPrefix, repositoryIds: [] }, OPERATOR);
  if (!created.ok || created.project === undefined) throw new Error(created.problem ?? "not created");
  return created.project.id;
}

async function item(base: string, projectId: string, title: string, token: string): Promise<string> {
  const submitted = await ask(
    base,
    "work:submitItem",
    { projectId, pipeline: "Delivery", type: "story", title, body: "Something to do.", acceptanceCriteria: ["It is done."] },
    token,
  );
  if (!submitted.created || submitted.key === null) throw new Error(submitted.problem ?? "not submitted");
  return submitted.key;
}

describe("an admin's browser, against a real server", () => {
  it("lists every project, including one they have no work on", async () => {
    // The design's first sentence. An admin is not a member of Support and
    // never will be; the board is theirs to see because the record syncs
    // up, not because somebody put them on it.
    const server = start();
    const base = await origin(server);
    const dana = await member(base, "Dana", "dana@example.com", true);
    const anna = await member(base, "Anna", "anna@example.com", false);
    const support = await project(base, "Support", "SUP");
    await item(base, support, "A customer is stuck", anna.token);

    const seen = await ask(base, "projects:list", undefined, dana.token);

    expect(seen.projects.map((one) => one.name)).toContain("Support");
  });

  it("shows a colleague only the projects they have work on", async () => {
    // The third acceptance criterion. Anna filed one thing on Support
    // and has never touched Marketing, so Marketing is not hers to
    // browse — and the switcher is where that has to be true, because it
    // is the control that would otherwise offer it.
    const server = start();
    const base = await origin(server);
    await member(base, "Dana", "dana@example.com", true);
    const anna = await member(base, "Anna", "anna@example.com", false);
    const support = await project(base, "Support", "SUP");
    await project(base, "Marketing", "MKT");
    await item(base, support, "A customer is stuck", anna.token);

    const seen = await ask(base, "projects:list", undefined, anna.token);

    expect(seen.projects.map((one) => one.name)).toEqual(["Support"]);
  });

  it("points a colleague at a project they can see rather than at the installation's", async () => {
    // The board and the switcher have to agree. `activeProjectId` is a
    // setting on the installation, so without this it would hand Anna
    // the first project on the server — cards from a board her own
    // switcher does not list, with nothing on screen explaining it.
    const server = start();
    const base = await origin(server);
    await member(base, "Dana", "dana@example.com", true);
    const anna = await member(base, "Anna", "anna@example.com", false);
    await project(base, "Marketing", "MKT");
    const support = await project(base, "Support", "SUP");
    const key = await item(base, support, "A customer is stuck", anna.token);

    const seen = await ask(base, "projects:list", undefined, anna.token);
    const board = await ask(base, "items:list", {}, anna.token);

    expect(seen.activeProjectId).toBe(support);
    expect(board.items.map((one) => one.key)).toEqual([key]);
  });

  it("records a decision under the admin's own name, and the item moves", async () => {
    // The first acceptance criterion, both halves. "Through the same
    // transition path as anyone else" (the original design) means the audit row is an
    // ordinary one — no flag, no second table — and the admin is on it
    // through the device that asked, which is the column
    // `transitions.device_id` exists for.
    //
    // "Moves on the owner's desktop" is the record's changes feed, which
    // is how any desktop hears about any move (EO-324). Read here with
    // Anna's own token, which is as close to standing at her machine as
    // a test gets.
    const server = start();
    const base = await origin(server);
    const dana = await member(base, "Dana", "dana@example.com", true);
    const anna = await member(base, "Anna", "anna@example.com", false);
    const support = await project(base, "Support", "SUP");
    await item(base, support, "A customer is stuck", anna.token);

    const board = await ask(base, "items:list", { projectId: support }, dana.token);
    const card = board.items[0]!;
    const steps = await ask(base, "pipelineSteps:list", { pipelineId: card.pipelineId! }, dana.token);
    const elsewhere = steps.steps.find((step) => step.id !== card.stepId)!;

    const moved = await ask(base, "items:move", { itemId: card.id, toStepId: elsewhere.id }, dana.token);
    expect(moved).toMatchObject({ moved: true, problem: null });

    // The item moved, and the record is the one that says so.
    const detail = await ask(base, "items:get", { itemId: card.id }, dana.token);
    expect(detail?.item.stepId).toBe(elsewhere.id);

    // And the move is attributed. `whoMovedIt` is what turns the device
    // on the row back into a person, and it is the sentence a colleague
    // is shown when their own move is superseded — so asking it is
    // asking exactly what an audit of this is for.
    const superseded = await ask(
      base,
      "record:apply",
      { commands: [{ kind: "transition", id: "cmd-1", transitionId: "t-1", itemId: card.id, fromStepId: card.stepId, toStepId: card.stepId, actor: "human" }] },
      anna.token,
    );
    expect(superseded.results[0]?.superseded?.by).toBe("Dana");
  });

});
