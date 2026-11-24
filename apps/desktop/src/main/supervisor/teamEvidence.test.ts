import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_KIND, NONE_KIND, readEvidenceBaseline, uuidv7, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { insertAttachments, listAttachmentsForItem } from "../db/repos/attachmentsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { folderEvidenceCapability, type FolderCaptureProbe } from "./folderEvidence.js";
import { NO_DISK_EVIDENCE, captureTeamEvidence, evidencePath, openTeamEvidence, readCapturedAttachment, taskContextOf } from "./teamEvidence.js";
import type { PreparedWorkspace, WorkspaceKind } from "./workspaceKind.js";

/**
 * A team's evidence baseline (EO-845): captured once, read only within
 * what was captured, and refused rather than read live.
 */

let handle: DbHandle;
let item: Item;
const scratch: string[] = [];
function directory(): string {
  const made = mkdtempSync(join(tmpdir(), "eo-team-evidence-test-"));
  scratch.push(made);
  return made;
}

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Review the report", stepId: "todo" });
});

afterEach(() => {
  handle.close();
  for (const made of scratch.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** A folder kind as the core ships it, over a copy root of the test's own. */
function folderKind(root: string, limits?: { files: number; bytes: number }, probe?: FolderCaptureProbe): WorkspaceKind {
  return { slug: FOLDER_KIND, evidence: folderEvidenceCapability(root, limits, probe) } as unknown as WorkspaceKind;
}

/** Every file's content under a copy root, finished copies and partial ones alike. */
function everythingCopied(root: string): string {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}
const prepared = (cwd: string, kind = FOLDER_KIND): PreparedWorkspace => ({ cwd, kind, workspaceId: null }) as PreparedWorkspace;

function attach(name: string, content: string, mimeType = "text/plain"): string {
  const stored = join(directory(), name);
  writeFileSync(stored, content);
  const id = uuidv7();
  insertAttachments(handle.db, [{ id: id as Uuid, itemId: item.id, commentId: null, storagePath: stored, name, mimeType, size: Buffer.byteLength(content) }]);
  return stored;
}

describe("an evidence path", () => {
  it("is relative to the captured root and never steps out of it", () => {
    expect(evidencePath("src/a.ts")).toEqual({ ok: true, value: "src/a.ts" });
    expect(evidencePath("src//a.ts/")).toEqual({ ok: true, value: "src/a.ts" });
    expect(evidencePath(undefined)).toEqual({ ok: true, value: "" });
    for (const escape of ["../secret", "src/../../etc/passwd", "/etc/passwd", "C:/Windows", "~/.ssh/id_rsa", "src\\..\\x", "a/./b", "a\0b"]) {
      expect(evidencePath(escape).ok, escape).toBe(false);
    }
  });
});

describe("folder evidence", () => {
  it("is a copy named by its manifest: what changes in the folder afterwards is not what a participant reads", async () => {
    const folder = directory();
    mkdirSync(join(folder, "notes"));
    writeFileSync(join(folder, "report.md"), "Revenue rose.\n");
    writeFileSync(join(folder, "notes", "q3.txt"), "One\nTwo\nThree\n");
    const root = directory();
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root), prepared: prepared(folder) }, now: 1_000 });
    if (!captured.ok) throw new Error(captured.problem);
    expect(captured.evidence.ref.source).toMatchObject({ kind: "folder", files: 2 });
    expect(captured.evidence.baseline.kind).toBe(FOLDER_KIND);

    writeFileSync(join(folder, "report.md"), "Revenue fell.\n");
    writeFileSync(join(folder, "added.md"), "New.\n");
    const read = await captured.evidence.workspace.read("report.md");
    expect(read.ok && read.value.toString()).toBe("Revenue rose.\n");
    expect((await captured.evidence.workspace.read("added.md")).ok).toBe(false);
    const listed = await captured.evidence.workspace.list("");
    expect(listed.ok && listed.value.map((entry) => `${entry.path}:${entry.type}`)).toEqual(["notes:directory", "report.md:file"]);
    const found = await captured.evidence.workspace.search("two", { ignoreCase: true, under: "", max: 10 });
    expect(found.ok && found.value).toEqual([{ path: "notes/q3.txt", line: 2, text: "Two" }]);

    // Opened again from the baseline alone — a recovery — it is the same copy.
    const reopened = await openTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root), prepared: prepared(folder) }, baseline: captured.evidence.baseline });
    if (!reopened.ok) throw new Error(reopened.problem);
    const again = await reopened.evidence.workspace.read("report.md");
    expect(again.ok && again.value.toString()).toBe("Revenue rose.\n");
  });

  it("lists a symbolic link as one and never reads or copies what it points at, inside or out", async () => {
    const outside = directory();
    writeFileSync(join(outside, "secret.txt"), "the secret\n");
    const folder = directory();
    writeFileSync(join(folder, "inside.txt"), "inside\n");
    symlinkSync(join(outside, "secret.txt"), join(folder, "escape.txt"));
    symlinkSync(outside, join(folder, "escape-dir"));
    symlinkSync(join(folder, "inside.txt"), join(folder, "alias.txt"));
    const root = directory();
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root), prepared: prepared(folder) } });
    if (!captured.ok) throw new Error(captured.problem);
    const listed = await captured.evidence.workspace.list("");
    expect(listed.ok && listed.value.map((entry) => `${entry.path}:${entry.type}`)).toEqual(["alias.txt:symlink", "escape-dir:symlink", "escape.txt:symlink", "inside.txt:file"]);
    for (const path of ["escape.txt", "alias.txt", "escape-dir/secret.txt"]) {
      const read = await captured.evidence.workspace.read(path);
      expect(read.ok, path).toBe(false);
    }
    expect((await captured.evidence.workspace.list("escape-dir")).ok).toBe(false);
    const found = await captured.evidence.workspace.search("secret", { ignoreCase: false, under: "", max: 10 });
    expect(found.ok && found.value).toEqual([]);
    // Nothing outside the folder was copied in.
    const copy = readdirSync(join(root, readdirSync(root).find((name) => !name.startsWith("."))!, "files"));
    expect(copy.sort()).toEqual(["inside.txt"]);
  });

  it("refuses a copy changed after it was captured, rather than reading it", async () => {
    const folder = directory();
    writeFileSync(join(folder, "a.txt"), "as captured\n");
    const root = directory();
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root), prepared: prepared(folder) } });
    if (!captured.ok) throw new Error(captured.problem);
    const manifest = readEvidenceBaseline(captured.evidence.baseline)!.source;
    if (manifest.kind !== "folder") throw new Error("not a folder");
    writeFileSync(join(root, manifest.manifest, "files", "a.txt"), "tampered\n");
    const read = await captured.evidence.workspace.read("a.txt");
    expect(read.ok).toBe(false);
    rmSync(join(root, manifest.manifest), { recursive: true });
    const reopened = await openTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root), prepared: prepared(folder) }, baseline: captured.evidence.baseline });
    expect(reopened.ok).toBe(false);
  });

  it("never hands over files from either side of a writer: one copied before it and another after starts the capture again", async () => {
    const folder = directory();
    writeFileSync(join(folder, "a.txt"), "a, before\n");
    writeFileSync(join(folder, "b.txt"), "b, before\n");
    const root = directory();
    const attempts: number[] = [];
    // On the first copy, a.txt is copied, then a writer changes both files
    // before b.txt is looked at: that copy holds a pair that never existed.
    const probe: FolderCaptureProbe = ({ attempt, pass, action, path }) => {
      if (pass === "copy" && action === "list" && path === "") attempts.push(attempt);
      if (attempt === 0 && pass === "copy" && action === "entry" && path === "b.txt") {
        writeFileSync(join(folder, "a.txt"), "a, after\n");
        writeFileSync(join(folder, "b.txt"), "b, after\n");
      }
    };
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root, undefined, probe), prepared: prepared(folder) } });
    if (!captured.ok) throw new Error(captured.problem);
    expect(attempts).toEqual([0, 1]);
    const a = await captured.evidence.workspace.read("a.txt");
    const b = await captured.evidence.workspace.read("b.txt");
    expect([a.ok && a.value.toString(), b.ok && b.value.toString()]).toEqual(["a, after\n", "b, after\n"]);
    // Only the consistent copy was kept.
    expect(readdirSync(root)).toHaveLength(1);
  });

  it("notices an entry added to or removed from a directory after it was listed", async () => {
    for (const change of ["added", "removed"] as const) {
      const folder = directory();
      mkdirSync(join(folder, "notes"));
      writeFileSync(join(folder, "notes", "one.txt"), "one\n");
      writeFileSync(join(folder, "notes", "two.txt"), "two\n");
      writeFileSync(join(folder, "z.txt"), "z\n");
      const probe: FolderCaptureProbe = ({ attempt, pass, action, path }) => {
        if (attempt !== 0 || pass !== "copy" || action !== "entry" || path !== "z.txt") return;
        if (change === "added") writeFileSync(join(folder, "notes", "three.txt"), "three\n");
        else rmSync(join(folder, "notes", "two.txt"));
      };
      const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(directory(), undefined, probe), prepared: prepared(folder) } });
      if (!captured.ok) throw new Error(captured.problem);
      const listed = await captured.evidence.workspace.list("notes");
      expect(listed.ok && listed.value.map((entry) => entry.path), change).toEqual(change === "added" ? ["notes/one.txt", "notes/three.txt", "notes/two.txt"] : ["notes/one.txt"]);
    }
  });

  it("refuses a folder that changes on every attempt, saying so, and keeps nothing it copied", async () => {
    const folder = directory();
    writeFileSync(join(folder, "a.txt"), "0\n");
    writeFileSync(join(folder, "b.txt"), "b\n");
    const root = directory();
    let writes = 0;
    const probe: FolderCaptureProbe = ({ pass, action, path }) => {
      if (pass === "copy" && action === "entry" && path === "b.txt") writeFileSync(join(folder, "a.txt"), `${String((writes += 1))}\n`);
    };
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root, undefined, probe), prepared: prepared(folder) } });
    expect(captured.ok).toBe(false);
    expect(!captured.ok && captured.problem).toContain("kept changing while EO copied them");
    expect(writes).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  });

  it("never copies through a directory swapped for a link while it is captured, whether the swap stays or is undone", async () => {
    for (const undone of [false, true]) {
      const outside = directory();
      writeFileSync(join(outside, "secret.txt"), "the secret\n");
      const folder = directory();
      mkdirSync(join(folder, "sub"));
      writeFileSync(join(folder, "sub", "inner.txt"), "inside\n");
      const root = directory();
      const swaps: number[] = [];
      // Between `sub` being looked at as a directory and being listed, it
      // becomes a link to a folder outside; undone, it is put back before
      // the capture starts again.
      const probe: FolderCaptureProbe = ({ attempt, pass, action, path }) => {
        if (attempt === 0 && pass === "copy" && action === "list" && path === "sub") {
          renameSync(join(folder, "sub"), join(folder, "sub-moved"));
          symlinkSync(outside, join(folder, "sub"));
          swaps.push(attempt);
        }
        if (undone && attempt === 1 && pass === "copy" && action === "list" && path === "") {
          unlinkSync(join(folder, "sub"));
          renameSync(join(folder, "sub-moved"), join(folder, "sub"));
        }
      };
      const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root, undefined, probe), prepared: prepared(folder) } });
      if (!captured.ok) throw new Error(captured.problem);
      expect(swaps, `undone: ${String(undone)}`).toEqual([0]);
      const listed = async (under: string) => {
        const entries = await captured.evidence.workspace.list(under);
        return entries.ok ? entries.value.map((entry) => `${entry.path}:${entry.type}`) : entries.problem;
      };
      // The folder as it stood when a capture held still: the link listed as one, never as what it pointed at.
      expect(await listed(""), `undone: ${String(undone)}`).toEqual(undone ? ["sub:directory"] : ["sub:symlink", "sub-moved:directory"]);
      expect(await listed(undone ? "sub" : "sub-moved"), `undone: ${String(undone)}`).toEqual([`${undone ? "sub" : "sub-moved"}/inner.txt:file`]);
      expect((await captured.evidence.workspace.read("sub/secret.txt")).ok).toBe(false);
      const found = await captured.evidence.workspace.search("secret", { ignoreCase: false, under: "", max: 10 });
      expect(found.ok && found.value).toEqual([]);
      expect(everythingCopied(root)).not.toContain("the secret");
    }
  });

  it("refuses a folder whose directory is swapped for a link on every attempt, copying nothing from outside", async () => {
    const outside = directory();
    writeFileSync(join(outside, "secret.txt"), "the secret\n");
    const folder = directory();
    mkdirSync(join(folder, "sub"));
    writeFileSync(join(folder, "sub", "inner.txt"), "inside\n");
    const root = directory();
    let swaps = 0;
    const probe: FolderCaptureProbe = ({ attempt, pass, action, path }) => {
      // Put back before each attempt after the first looks at the folder…
      if (attempt > 0 && pass === "copy" && action === "list" && path === "") {
        unlinkSync(join(folder, "sub"));
        renameSync(join(folder, "sub-moved"), join(folder, "sub"));
      }
      // …and swapped again between `sub` being looked at and listed.
      if (pass === "copy" && action === "list" && path === "sub") {
        renameSync(join(folder, "sub"), join(folder, "sub-moved"));
        symlinkSync(outside, join(folder, "sub"));
        swaps += 1;
      }
    };
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(root, undefined, probe), prepared: prepared(folder) } });
    expect(captured.ok).toBe(false);
    expect(!captured.ok && captured.problem).toContain("kept changing");
    expect(swaps).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a folder larger than a team copies, saying so", async () => {
    const folder = directory();
    for (let n = 0; n < 4; n++) writeFileSync(join(folder, `f${String(n)}.txt`), "x");
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(directory(), { files: 3, bytes: 1024 }), prepared: prepared(folder) } });
    expect(captured.ok).toBe(false);
    expect(!captured.ok && captured.problem).toContain("more than 3 files");
  });
});

describe("evidence with no disk, attachments, and a kind that cannot capture", () => {
  it("gives an item with no workspace its attachments and no files", async () => {
    attach("brief.md", "# Brief\nShip the importer.\n", "text/markdown");
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: null, now: 5 });
    if (!captured.ok) throw new Error(captured.problem);
    expect(captured.evidence.ref).toMatchObject({ workspaceKind: NONE_KIND, source: { kind: "none" }, capturedAt: 5 });
    expect(captured.evidence.ref.attachments.map((attachment) => attachment.name)).toEqual(["brief.md"]);
    const listed = await captured.evidence.workspace.list("");
    expect(listed.ok && listed.value).toEqual([]);
    expect((await captured.evidence.workspace.read("anything")).ok).toBe(false);
    const read = await readCapturedAttachment(handle.db, item, captured.evidence.ref, "brief.md");
    expect(read.ok && read.value.bytes.toString()).toContain("Ship the importer.");
  });

  it("reads the none kind's capability the same way, and opens it again from its baseline", async () => {
    const kind = { slug: NONE_KIND, evidence: NO_DISK_EVIDENCE } as unknown as WorkspaceKind;
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind, prepared: prepared(directory(), NONE_KIND) } });
    if (!captured.ok) throw new Error(captured.problem);
    const reopened = await openTeamEvidence({ db: handle.db, item, workspace: { kind, prepared: prepared(directory(), NONE_KIND) }, baseline: captured.evidence.baseline });
    expect(reopened.ok).toBe(true);
  });

  it("refuses an attachment that no longer holds what was captured, or was removed", async () => {
    const stored = attach("data.csv", "a,b\n1,2\n", "text/csv");
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: null });
    if (!captured.ok) throw new Error(captured.problem);
    writeFileSync(stored, "a,b\n9,9\n");
    const read = await readCapturedAttachment(handle.db, item, captured.evidence.ref, "data.csv");
    expect(!read.ok && read.problem).toContain("no longer holds what EO captured");
    expect((await readCapturedAttachment(handle.db, item, captured.evidence.ref, "other.csv")).ok).toBe(false);
  });

  it("captures only the attachments named, and refuses one the item does not have", async () => {
    attach("one.txt", "1");
    attach("two.txt", "2");
    const ids = captureIds();
    const one = await captureTeamEvidence({ db: handle.db, item, workspace: null, attachmentIds: [ids[0]!] });
    expect(one.ok && one.evidence.ref.attachments.map((attachment) => attachment.name)).toEqual(["one.txt"]);
    const missing = await captureTeamEvidence({ db: handle.db, item, workspace: null, attachmentIds: ["nope"] });
    expect(missing.ok).toBe(false);
  });

  it("explains a workspace kind that cannot capture, rather than reading it live", async () => {
    const scratchKind = { slug: "scratch" } as unknown as WorkspaceKind;
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: { kind: scratchKind, prepared: prepared(directory(), "scratch") } });
    expect(captured.ok).toBe(false);
    expect(!captured.ok && captured.problem).toContain("A scratch workspace cannot be captured for a team");
  });

  it("refuses to open a baseline against a workspace of another kind", async () => {
    const captured = await captureTeamEvidence({ db: handle.db, item, workspace: null });
    if (!captured.ok) throw new Error(captured.problem);
    const opened = await openTeamEvidence({ db: handle.db, item, workspace: { kind: folderKind(directory()), prepared: prepared(directory()) }, baseline: captured.evidence.baseline });
    expect(!opened.ok && opened.problem).toContain("captured from a none workspace");
  });
});

function captureIds(): string[] {
  return listAttachmentsForItem(handle.db, item.id)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((attachment) => attachment.id);
}

describe("the item's task in a team's evidence (EO-847)", () => {
  const base = { title: "Export", body: "Export as CSV.", spec: { criteria: ["CSV"], owner: "ops" }, typeId: "t1" as Uuid };

  it("changes with what the item asks — title, body, spec or type — and with nothing else", () => {
    const sha = taskContextOf(base).sha256;
    expect(taskContextOf({ ...base, spec: { owner: "ops", criteria: ["CSV"] } }).sha256).toBe(sha);
    for (const changed of [{ title: "Import" }, { body: "Export as JSON." }, { spec: { criteria: ["CSV", "JSON"], owner: "ops" } }, { typeId: "t2" as Uuid }]) {
      expect(taskContextOf({ ...base, ...changed }).sha256).not.toBe(sha);
    }
    expect(taskContextOf({ ...base, body: null }).sha256).toBe(taskContextOf({ ...base, body: "" }).sha256);
  });
});
