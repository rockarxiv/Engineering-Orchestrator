import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createProject } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { forgetListed } from "../gallery/session.js";
import { previewGalleryCommand, useGalleryCommand } from "../ipc/galleryCommands.js";
import { finishFirstRunCommand, firstRunStateCommand, setFirstRunModeCommand } from "./firstRun.js";

/**
 * When first run is first run (EO-317, `ARCHITECTURE.md`, "What a person sees first").
 *
 * Almost all of the flow is a screen; what the main process owns is
 * which mode was chosen and whether somebody has been through it. The
 * cases below are the three ways that second question is easy to get
 * wrong, and each of them is somebody being shown the wrong thing:
 *
 *  - an installation with work on its board being sent back to step 1;
 *  - a rehearsal — step 3 of the flow — counting as a beginning, which
 *    drops somebody out of the middle of it with nothing of their own;
 *  - the "Continue with Preview only" exit, which creates no real
 *    project by design, putting them back at step 1 on the next launch.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const NO_SECRETS = {
  directory: join(tmpdir(), "eo-first-run-no-secrets"),
  store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
};

let handle: DbHandle;
let folder: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  folder = mkdtempSync(join(tmpdir(), "eo first run folder "));
  forgetListed();
});

afterEach(() => {
  handle.close();
  rmSync(folder, { recursive: true, force: true });
});

function context() {
  return { directory: GALLERY_DIRECTORY, moduleSecrets: NO_SECRETS, signedInBackends: [] as string[] };
}

describe("whether the flow is behind them", () => {
  it("is not, on an installation that has nothing of its own", () => {
    expect(firstRunStateCommand(handle.db)).toEqual({ done: false, mode: null });
  });

  it("is, the moment there is a real project — which is every installation that predates this", () => {
    createProject(handle.db, { name: "Acme API", keyPrefix: "ACME" });
    expect(firstRunStateCommand(handle.db).done).toBe(true);
  });

  /** Preview is step 3. A rehearsal must not end the flow it is in the middle of. */
  it("is not, after Preview has made its own project", async () => {
    const preview = await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    expect(preview.problem).toBeNull();
    expect(preview.projectId).not.toBeNull();

    expect(firstRunStateCommand(handle.db).done).toBe(false);
  });

  /**
   * Step 4 is not the end of the flow, and the project it writes must not
   * behave as though it were.
   *
   * "Use this" creates the project *and* produces the needs check's
   * lines. Counting that project would take the needs check off the
   * screen at the moment it was produced, and drop somebody onto a board
   * without ever telling them what their template still needed.
   */
  it("is not, on the project first run itself just installed", async () => {
    const used = await useGalleryCommand(handle.db, context(), {
      slug: "weekly-report",
      answers: { folder, schedule: "monday 08:00", keyPrefix: "REP" },
      roleSlots: {},
    });
    expect(used.problem).toBeNull();

    expect(firstRunStateCommand(handle.db).done).toBe(false);
    // And the exit is what ends it.
    finishFirstRunCommand(handle.db);
    expect(firstRunStateCommand(handle.db).done).toBe(true);
  });

  /**
   * Any *other* project does end it, including one attached from
   * somewhere else entirely — the Workspaces screen, an MCP client, a
   * second window.
   */
  it("is, when a project arrives from outside the flow", async () => {
    await useGalleryCommand(handle.db, context(), {
      slug: "weekly-report",
      answers: { folder, schedule: "monday 08:00", keyPrefix: "REP" },
      roleSlots: {},
    });
    createProject(handle.db, { name: "Acme API", keyPrefix: "ACME" });

    expect(firstRunStateCommand(handle.db).done).toBe(true);
  });

  /**
   * "A person who cannot get a line green can leave with Preview only"
   * (the original design) — and stays left. That exit creates no real project, so
   * nothing else could have said this for them.
   */
  it("is, when they left by Preview only — which creates no project of their own", async () => {
    await previewGalleryCommand(handle.db, context(), { slug: "weekly-report" });
    expect(finishFirstRunCommand(handle.db)).toEqual({ done: true });

    expect(firstRunStateCommand(handle.db).done).toBe(true);
  });
});

describe("step 1: solo or organisation", () => {
  it("remembers the answer, so nobody is asked twice", () => {
    expect(setFirstRunModeCommand(handle.db, { mode: "solo", address: "" })).toEqual({ mode: "solo" });
    expect(firstRunStateCommand(handle.db)).toEqual({ done: false, mode: "solo" });
  });

  /**
   * The sign-in is `session:signIn`, made by the screen before this is
   * sent (EO-661); this only records the answer and the address.
   */
  it("records organisation mode and the address it signed in to", () => {
    setFirstRunModeCommand(handle.db, { mode: "organisation", address: " eo.acme.com " });
    expect(firstRunStateCommand(handle.db).mode).toBe("organisation");
    // Nothing was created on the strength of it — no project, no
    // sign-in, no work.
    expect(firstRunStateCommand(handle.db).done).toBe(false);
  });
});
