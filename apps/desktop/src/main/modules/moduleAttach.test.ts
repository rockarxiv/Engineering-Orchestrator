import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModuleManifestSchema } from "@eo/core";
import type { Comment, Item, ModuleManifest } from "@eo/core";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  createRunEventBuffer,
  listAgents,
  listAttachmentsForComment,
  listCommentsForItem,
  listMentionsForComment,
  listRunEvents,
  listRunsForItem,
  needsAttention,
  openMentionsForHuman,
  pendingPushesForItem,
  projectForWorkspace,
  saveJiraBinding,
  saveModule,
} from "../db/repos/index.js";
import { createJiraConnection } from "../db/repos/jiraConnectionsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { RunFileStore } from "../supervisor/runAttachments.js";
import { preparingAt } from "../supervisor/testWorkspaceKinds.js";
import { createModuleRunnerLookup } from "./registry.js";
import { MAX_COMMENTS_PER_RUN, MAX_COMMENT_CHARS } from "./runModule.js";

/**
 * `ctx.attach()`: a module puts files on the item its step is running
 * on (EO-414).
 *
 * Through the registry, a real host and the real attachment store, for
 * the reason `registry.test.ts` gives: everything worth proving crosses
 * the boundary. The host answers the module, the parent checks again
 * and writes, and what is asserted is what ended up on the item and in
 * the run's transcript.
 */

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, ""),
};

const hostPath = join(dirname(fileURLToPath(import.meta.url)), "moduleHost.mjs");
const launcher = { execPath: process.execPath, hostPath, hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

const manifest: ModuleManifest = {
  name: "Reporter",
  description: "Leaves a report.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: true, create: false },
  results: ["ok"],
};

const LINKS = process.platform !== "win32";

let handle: DbHandle;
let root: string;
/** The directory the module runs in — `ctx.cwd`. */
let work: string;
let storage: AttachmentStorage;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  root = mkdtempSync(join(tmpdir(), "eo module attach "));
  work = join(root, "work");
  mkdirSync(work);
  storage = new AttachmentStorage(join(root, "attachments"));
  item = createTestItem(handle.db, { type: "story", title: "Ship it", stepId: "todo" });
});

afterEach(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
});

/**
 * Runs a module body on `on` and answers with what it returned in
 * `detail`, what was posted and what the transcript says.
 *
 * `body` is the inside of the module's function. It has `ctx`, and
 * whatever it assigns to `answer` comes back parsed — which is how a
 * test reads what `ctx.attach()` answered the module with.
 */
async function run(body: string, options: { on?: Item; files?: RunFileStore | null; prelude?: string } = {}) {
  const on = options.on ?? item;
  const saved = saveModule(handle.db, {
    slug: "reporter",
    name: "Reporter",
    description: "Leaves a report.",
    code: `${options.prelude ?? ""}
      export default async function run(ctx) {
        let answer = null;
        ${body}
        return { ok: true, result: "ok", detail: JSON.stringify(answer) };
      }`,
    manifest,
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  const row = createRun(handle.db, { itemId: on.id, agentId: null, action: saved.module.id, status: "running", provider: "module" });
  const buffer = createRunEventBuffer(handle.db);
  const files = options.files === undefined ? storage : options.files;
  const lookup = createModuleRunnerLookup({
    db: handle.db,
    launcher,
    secrets: { directory: join(root, "secrets"), store },
    ...(files ? { attachments: files } : {}),
  });
  const outcome = await lookup(saved.module.id)!({
    db: handle.db,
    item: on,
    prepareWorkspace: preparingAt(work),
    report: (text: string) => {
      buffer.append(row.id, "output", { type: "output", text });
      buffer.flush();
    },
    runId: row.id,
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return {
    runId: row.id,
    answer: JSON.parse(outcome.detail) as unknown,
    comments: listCommentsForItem(handle.db, on.id),
    transcript: listRunEvents(handle.db, row.id)
      .map((event) => (event.payload as { text?: string }).text ?? "")
      .join(""),
  };
}

const filesOn = (comment: Comment | undefined) => (comment ? listAttachmentsForComment(handle.db, comment.id) : []);
/** Every file the store holds. */
const stored = (): string[] => {
  try {
    return readdirSync(join(root, "attachments", "files"));
  } catch {
    return [];
  }
};

describe("a module attaching files to its item", () => {
  it("posts one comment, signed with the module's name, carrying the file under its caption", async () => {
    const bytes = Buffer.from("%PDF-1.7\nnightly\n");
    writeFileSync(join(work, "report.pdf"), bytes);

    const result = await run(`answer = await ctx.attach("report.pdf", "Nightly report");`);

    expect(result.answer).toEqual({ attached: true });
    expect(result.comments).toHaveLength(1);
    const [comment] = result.comments;
    expect(comment).toMatchObject({ authorType: "module", runId: result.runId });
    expect(comment?.body).toContain("**Reporter** (module)");
    expect(comment?.body).toContain("Nightly report");
    const attached = filesOn(comment);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ name: "report.pdf", size: bytes.byteLength });
    expect(readFileSync(attached[0]!.path).equals(bytes)).toBe(true);
    expect(result.transcript).not.toContain("did not attach");
  });

  it("posts one comment with three attachments for an array of three paths", async () => {
    mkdirSync(join(work, "logs"));
    writeFileSync(join(work, "a.txt"), "a");
    writeFileSync(join(work, "b.txt"), "bb");
    writeFileSync(join(work, "logs", "c.log"), "ccc");

    const result = await run(`answer = await ctx.attach(["a.txt", "b.txt", "logs/c.log"]);`);

    expect(result.answer).toEqual({ attached: true });
    expect(result.comments).toHaveLength(1);
    // No caption, so the signature stands alone rather than over a blank.
    expect(result.comments[0]?.body).toBe("**Reporter** (module)");
    const attached = filesOn(result.comments[0]);
    expect(attached.map((file) => readFileSync(file.path, "utf8")).sort()).toEqual(["a", "bb", "ccc"]);
  });

  it("writes an attach the module made in its last line before the run resolves", async () => {
    writeFileSync(join(work, "late.txt"), "late");

    // Not awaited: the module returns with the attach still in flight.
    const result = await run(`ctx.attach("late.txt", "On the way out"); answer = "returned";`);

    expect(filesOn(result.comments[0])).toHaveLength(1);
  });

  it("keeps a comment made after an attach behind it in the thread", async () => {
    writeFileSync(join(work, "a.txt"), "a");

    const result = await run(`await ctx.attach("a.txt", "first"); ctx.comment("second");`);

    expect(result.comments.map((comment) => comment.body.split("\n").pop())).toEqual(["first", "second"]);
  });

  describe("refuses, answering the module and the transcript, and posts nothing", () => {
    const refusals: [name: string, arrange: () => void, call: string, reason: RegExp][] = [
      ["a missing file", () => undefined, `ctx.attach("nope.txt")`, /"nope\.txt" does not exist/],
      ["a directory", () => mkdirSync(join(work, "out")), `ctx.attach("out")`, /"out" is a directory/],
      ["a path resolving outside ctx.cwd", () => writeFileSync(join(root, "secret.txt"), "s"), `ctx.attach("../secret.txt")`, /outside the directory this run works in/],
      ["an absolute path elsewhere", () => writeFileSync(join(root, "secret.txt"), "s"), `ctx.attach(${JSON.stringify(join(tmpdir(), "elsewhere.txt"))})`, /outside the directory/],
      [
        "a file over 20 MB",
        () => {
          writeFileSync(join(work, "huge.bin"), "");
          truncateSync(join(work, "huge.bin"), MAX_ATTACHMENT_BYTES + 1);
        },
        `ctx.attach("huge.bin")`,
        /larger than the 20 MB/,
      ],
      [
        "more than eight paths",
        () => {
          for (let index = 0; index < 9; index += 1) writeFileSync(join(work, `${index}.txt`), "x");
        },
        `ctx.attach(["0.txt","1.txt","2.txt","3.txt","4.txt","5.txt","6.txt","7.txt","8.txt"])`,
        /at most 8 files and this one names 9/,
      ],
      [
        "a caption over the comment cap",
        () => writeFileSync(join(work, "a.txt"), "a"),
        `ctx.attach("a.txt", "x".repeat(${MAX_COMMENT_CHARS + 1}))`,
        new RegExp(`at most ${MAX_COMMENT_CHARS} characters`),
      ],
      ["one good file beside a bad one", () => writeFileSync(join(work, "a.txt"), "a"), `ctx.attach(["a.txt", "nope.txt"])`, /"nope\.txt" does not exist/],
      ["something that is not a path", () => undefined, `ctx.attach(42)`, /takes a file path/],
    ];

    it.each(refusals)("%s", async (_name, arrange, call, reason) => {
      arrange();

      const result = await run(`answer = await ${call};`);

      expect(result.answer).toEqual({ attached: false, reason: expect.stringMatching(reason) as unknown });
      expect(result.comments).toEqual([]);
      expect(stored()).toEqual([]);
      expect(result.transcript).toMatch(/EO did not attach files: /);
      expect(result.transcript).toMatch(reason);
    });

    it.skipIf(!LINKS)("a symbolic link, and a file reached through one", async () => {
      writeFileSync(join(root, "outside.txt"), "outside");
      mkdirSync(join(root, "elsewhere"));
      writeFileSync(join(root, "elsewhere", "inner.txt"), "inner");
      symlinkSync(join(root, "outside.txt"), join(work, "link.txt"));
      symlinkSync(join(root, "elsewhere"), join(work, "linked"));

      const result = await run(`answer = [await ctx.attach("link.txt"), await ctx.attach("linked/inner.txt")];`);

      expect(result.answer).toEqual([
        { attached: false, reason: expect.stringContaining("symbolic link") as unknown },
        { attached: false, reason: expect.stringContaining("symbolic link") as unknown },
      ]);
      expect(result.comments).toEqual([]);
      expect(result.transcript).toContain('"link.txt" is a symbolic link');
    });

    it("a run that has already used all of its comments", async () => {
      writeFileSync(join(work, "a.txt"), "a");

      const result = await run(`
        for (let index = 0; index < ${MAX_COMMENTS_PER_RUN}; index += 1) ctx.comment("note " + index);
        answer = await ctx.attach("a.txt", "one too many");`);

      expect(result.answer).toEqual({ attached: false, reason: expect.stringContaining(`${MAX_COMMENTS_PER_RUN} comments in one run`) as unknown });
      expect(result.comments).toHaveLength(MAX_COMMENTS_PER_RUN);
      expect(result.comments.flatMap(filesOn)).toEqual([]);
      expect(result.transcript).toContain("EO did not attach files: A module may post");
    });

    it("counts an attach as one of the run's comments", async () => {
      writeFileSync(join(work, "a.txt"), "a");

      const result = await run(`
        const attached = [];
        for (let index = 0; index < ${MAX_COMMENTS_PER_RUN}; index += 1) attached.push((await ctx.attach("a.txt", "file " + index)).attached);
        answer = { attached, comment: ctx.comment("after the last") };`);

      expect(result.answer).toMatchObject({ attached: Array.from({ length: MAX_COMMENTS_PER_RUN }, () => true), comment: { posted: false } });
      expect(result.comments).toHaveLength(MAX_COMMENTS_PER_RUN);
    });
  });

  describe("an attach event written straight to fd 3", () => {
    const smuggle = (event: unknown): string => `writeSync(3, ${JSON.stringify(`${JSON.stringify(event)}\n`)});`;
    const prelude = `import { writeSync } from "node:fs";`;

    it("attaches nothing for a path outside the run's directory, and the transcript says why", async () => {
      writeFileSync(join(root, "secret.txt"), "the keys");

      const result = await run(smuggle({ type: "attach", paths: [join(root, "secret.txt")], caption: "smuggled" }), { prelude });

      expect(result.comments).toEqual([]);
      expect(stored()).toEqual([]);
      expect(result.transcript).toContain(`EO did not attach files to ${item.key}:`);
      expect(result.transcript).toContain("is outside the directory this run works in.");
    });

    it.skipIf(!LINKS)("attaches nothing through a symbolic link", async () => {
      writeFileSync(join(root, "secret.txt"), "the keys");
      symlinkSync(join(root, "secret.txt"), join(work, "innocent.txt"));

      const result = await run(smuggle({ type: "attach", paths: ["innocent.txt"] }), { prelude });

      expect(result.comments).toEqual([]);
      expect(result.transcript).toContain("symbolic link");
    });

    it("attaches none of a call with one bad path, and leaves no bytes behind", async () => {
      writeFileSync(join(work, "a.txt"), "a");

      const result = await run(smuggle({ type: "attach", paths: ["a.txt", "../secret.txt"] }), { prelude });

      expect(result.comments).toEqual([]);
      expect(stored()).toEqual([]);
    });

    it("holds the caps the host would have held", async () => {
      writeFileSync(join(work, "a.txt"), "a");

      const result = await run(
        [
          smuggle({ type: "attach", paths: Array.from({ length: 9 }, () => "a.txt") }),
          smuggle({ type: "attach", paths: ["a.txt"], caption: "x".repeat(MAX_COMMENT_CHARS + 1) }),
          smuggle({ type: "attach", paths: "a.txt" }),
          smuggle({ type: "attach", paths: ["a.txt"], caption: 7 }),
          ...Array.from({ length: MAX_COMMENTS_PER_RUN + 1 }, (_, index) => smuggle({ type: "attach", paths: ["a.txt"], caption: `file ${index}` })),
        ].join("\n"),
        { prelude },
      );

      expect(result.comments).toHaveLength(MAX_COMMENTS_PER_RUN);
      expect(result.comments.every((comment) => filesOn(comment).length === 1)).toBe(true);
      expect(result.transcript).toContain("at most 8 files and this one names 9");
      expect(result.transcript).toContain(`a caption may be at most ${MAX_COMMENT_CHARS} characters`);
      expect(result.transcript).toContain("an attach names one or more file paths.");
      expect(result.transcript).toContain("a caption is text.");
      expect(result.transcript).toContain("attachments included, and this run has posted them all.");
    });
  });

  /**
   * The check is about a name, and the module owns the directory the
   * name is in: between the check and the read it can put something
   * else there. Made to happen at a known moment here rather than raced
   * for — the store is asked to keep the first file, and while it does,
   * the second is swapped. Every path was checked before either was
   * read, so this is exactly the gap: a name that passed, read after it
   * stopped meaning what passed.
   */
  describe("a file swapped after it was checked", () => {
    const SECRET = "the keys to everything";

    /** A store that runs `swap` while keeping `a.txt`, and remembers every byte it was ever handed. */
    const swappingStore = (swap: () => void) => {
      const handed: Buffer[] = [];
      const files: RunFileStore = {
        storeImported: (input) => {
          handed.push(Buffer.from(input.data));
          if (input.name === "a.txt") swap();
          return storage.storeImported(input);
        },
        rollback: (records) => storage.rollback(records),
      };
      return { files, handed };
    };

    const swaps: [name: string, second: string, arrange: () => void, swap: () => void, reason: RegExp][] = [
      [
        "for a symbolic link to a file outside",
        "b.txt",
        () => writeFileSync(join(work, "b.txt"), "b"),
        () => {
          unlinkSync(join(work, "b.txt"));
          symlinkSync(join(root, "secret.txt"), join(work, "b.txt"));
        },
        /"b\.txt" changed while EO was reading it/,
      ],
      [
        "by turning its directory into a symbolic link to one outside",
        "sub/b.txt",
        () => {
          mkdirSync(join(work, "sub"));
          writeFileSync(join(work, "sub", "b.txt"), "b");
          mkdirSync(join(root, "elsewhere"));
          writeFileSync(join(root, "elsewhere", "b.txt"), SECRET);
        },
        () => {
          renameSync(join(work, "sub"), join(root, "moved"));
          symlinkSync(join(root, "elsewhere"), join(work, "sub"));
        },
        /"sub\/b\.txt" (changed while EO was reading it|is a symbolic link)/,
      ],
      [
        "by growing it past the size limit",
        "b.txt",
        () => writeFileSync(join(work, "b.txt"), "b"),
        () => truncateSync(join(work, "b.txt"), MAX_ATTACHMENT_BYTES + 1),
        /"b\.txt" is larger than the 20 MB attachment limit/,
      ],
    ];

    const routes: [name: string, body: (second: string) => string, prelude: string][] = [
      ["through ctx.attach", (second) => `answer = await ctx.attach(["a.txt", ${JSON.stringify(second)}], "swapped");`, ""],
      [
        "through an attach event written straight to fd 3",
        (second) => `writeSync(3, ${JSON.stringify(`${JSON.stringify({ type: "attach", paths: ["a.txt", second], caption: "swapped" })}\n`)});`,
        `import { writeSync } from "node:fs";`,
      ],
    ];

    describe.each(routes)("%s", (_route, body, prelude) => {
      it.skipIf(!LINKS).each(swaps)("%s, attaches nothing and never reads the other bytes", async (_name, second, arrange, swap, reason) => {
        writeFileSync(join(root, "secret.txt"), SECRET);
        writeFileSync(join(work, "a.txt"), "a");
        arrange();
        const { files, handed } = swappingStore(swap);

        const result = await run(body(second), { files, prelude });

        // The first file was read and kept before the swap, and taken
        // back when the second was refused: nothing is on the item and
        // nothing is left in the store.
        expect(result.comments).toEqual([]);
        expect(stored()).toEqual([]);
        expect(result.transcript).toMatch(reason);
        // And the store was never handed the outside file or an
        // oversized one — the bytes were refused, not copied and then
        // thrown away.
        expect(handed.map((data) => data.toString())).toEqual(["a"]);
      });
    });
  });

  it("summons nobody with an at-mention in the caption", async () => {
    writeFileSync(join(work, "a.txt"), "a");
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    const runsBefore = listRunsForItem(handle.db, item.id).length;

    const result = await run(`answer = await ctx.attach("a.txt", ${JSON.stringify(`@user have a look, and @${reviewer.name} too`)});`);

    const [comment] = result.comments;
    // Left as written: declined, not edited.
    expect(comment?.body).toContain(`@user have a look, and @${reviewer.name} too`);
    expect(listMentionsForComment(handle.db, comment!.id)).toEqual([]);
    expect(needsAttention(handle.db, item.id)).toBe(false);
    expect(openMentionsForHuman(handle.db, "anybody")).toEqual([]);
    // The module's own run and nothing dispatched after it.
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(runsBefore + 1);
  });

  it("queues each file for upload on an item mirrored to Jira", async () => {
    const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const project = projectForWorkspace(handle.db, workspace.id)!;
    const site = createJiraConnection(handle.db, { baseUrl: "https://jira.example", flavour: "datacenter" });
    saveJiraBinding(handle.db, project.id, { connectionId: site.id, projectKey: "API" });
    const mirrored = createTestItem(handle.db, { type: "story", title: "Upload", stepId: "todo", workspaceId: workspace.id, projectId: project.id, jiraKey: "API-1" });
    writeFileSync(join(work, "a.txt"), "a");
    writeFileSync(join(work, "b.txt"), "b");

    const result = await run(`answer = await ctx.attach(["a.txt", "b.txt"], "For the issue.");`, { on: mirrored });

    const attached = filesOn(result.comments[0]).map((file) => file.id);
    expect(attached).toHaveLength(2);
    const uploads = pendingPushesForItem(handle.db, mirrored.id, "jira").filter((entry) => entry.kind === "attachment_upload");
    expect(uploads.map((entry) => (entry.payload as { attachmentId: string }).attachmentId).sort()).toEqual([...attached].sort());
  });

  it("queues nothing on an item that is not mirrored", async () => {
    writeFileSync(join(work, "a.txt"), "a");

    await run(`answer = await ctx.attach("a.txt");`);

    expect(pendingPushesForItem(handle.db, item.id).filter((entry) => entry.kind === "attachment_upload")).toEqual([]);
  });

  it("says so in the transcript where the installation has nowhere to keep a file", async () => {
    writeFileSync(join(work, "a.txt"), "a");

    const result = await run(`answer = await ctx.attach("a.txt");`, { files: null });

    expect(result.comments).toEqual([]);
    expect(result.transcript).toContain(`EO did not attach files to ${item.key}: this installation has nowhere to keep a file.`);
  });

  it("takes back what it stored when a later file in the call cannot be", async () => {
    writeFileSync(join(work, "a.txt"), "a");
    writeFileSync(join(work, "b.txt"), "b");
    const failing: RunFileStore = {
      storeImported: (input) => (input.name === "b.txt" ? Promise.reject(new Error("no space left on device")) : storage.storeImported(input)),
      rollback: (records) => storage.rollback(records),
    };

    const result = await run(`answer = await ctx.attach(["a.txt", "b.txt"]);`, { files: failing });

    expect(result.comments).toEqual([]);
    expect(stored()).toEqual([]);
    expect(result.transcript).toContain('"b.txt" could not be stored: no space left on device');
  });
});

describe("declaring that a module attaches files", () => {
  const declared = { name: "Reporter", description: "Leaves a report.", inputs: {}, results: ["ok"] };

  it("validates a manifest with needs.attach: true", () => {
    const parsed = ModuleManifestSchema.safeParse({ ...declared, needs: { attach: true, create: false } });

    expect(parsed.success && parsed.data.needs.attach).toBe(true);
  });

  it("reads a manifest written before it as one that attaches nothing", () => {
    const parsed = ModuleManifestSchema.safeParse({ ...declared, needs: { bin: [], env: [], network: false, item: false, comment: true } });

    expect(parsed.success && parsed.data.needs).toMatchObject({ comment: true, attach: false, create: false });
    expect(ModuleManifestSchema.parse(declared).needs.attach).toBe(false);
  });

  it("refuses one where it is not a yes or a no", () => {
    expect(ModuleManifestSchema.safeParse({ ...declared, needs: { attach: "sometimes" } }).success).toBe(false);
  });
});
