import { ModuleManifestSchema, type AgentWriteAnswer, type CustomModule, type Item, type ModuleManifest } from "@eo/core";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { approveModule, archiveModule, createRun, deleteItem, getModule, listAgents, listModuleTests, listModuleVersions, saveModule, saveModuleTest } from "../db/repos/index.js";
import { moduleChangeProposals } from "../db/schema.js";
import { createTestItem, openMigratedTestDb, openMigratedTestDbAt } from "../db/testHelpers.js";
import { openAssistConversation } from "./assist.js";
import { ASSIST_ACTION, SCENARIO_ACTION } from "./conversationSteps.js";
import { applyModuleChange, changeBaseOf } from "./moduleChange.js";
import {
  MAX_STAGED_FILE_BYTES,
  STAGED_CODE_FILE,
  STAGED_MANIFEST_FILE,
  createModuleChangeStaging,
  resolveModuleChangeProposal,
  type ModuleChangeCaller,
  type ModuleChangeStaging,
} from "./moduleChangeProposals.js";
import { openScenarioConversation } from "./scenario.js";

/**
 * Preparing and freezing a module change for a card (EO-813), asserted
 * against the rows: "nothing about the module changes" is a claim about
 * the catalog, not about what a tool says.
 */

const MANIFEST: ModuleManifest = ModuleManifestSchema.parse({
  name: "Deploy",
  description: "Deploys the release.",
  inputs: { stage: { type: "string", default: "prod" } },
  needs: { bin: ["aws"], env: ["AWS_PROFILE", "DEPLOY_TOKEN"], network: true },
  results: ["deployed"],
});

const DEPLOY = `export default async function (ctx) {
  const stage = ctx.inputs.stage;
  const done = await ctx.exec("aws", ["deploy", stage]);
  if (done.code !== 0) return { ok: false, reason: "deploy failed" };
  return { ok: true, result: "deployed" };
}
`;

const DEPLOYS = `export default async function (harness) {
  await harness.run({ exec: [{ bin: "aws", args: ["deploy", "prod"], code: 0 }] });
}
`;

let handle: DbHandle;
let root: string;
let staging: ModuleChangeStaging;

beforeEach(() => {
  handle = openMigratedTestDb();
  root = mkdtempSync(join(tmpdir(), "eo-module-staging-"));
  staging = createModuleChangeStaging({ db: handle.db, root });
});

afterEach(() => {
  handle.close();
  rmSync(root, { recursive: true, force: true });
});

function saveDeploy(slug = "deploy"): CustomModule {
  const saved = saveModule(handle.db, { slug, name: slug === "deploy" ? "Deploy" : "Other", description: "Deploys the release.", code: DEPLOY, manifest: MANIFEST, source: "user" });
  if (!saved.ok) throw new Error(saved.reason);
  const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description: "deploys to prod", source: DEPLOYS });
  if (!test.ok) throw new Error(test.reason);
  approveModule(handle.db, saved.module.id);
  return getModule(handle.db, saved.module.id)!;
}

function runOn(conversation: Item, action: string): ModuleChangeCaller {
  const agent = listAgents(handle.db)[0]!;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action });
  return { itemId: conversation.id, runId: run.id };
}

function assistTurn(): ModuleChangeCaller {
  return runOn(openAssistConversation(handle.db, null), ASSIST_ACTION);
}

function ok(answer: AgentWriteAnswer): Record<string, unknown> {
  if (!answer.ok) throw new Error(`${answer.code}: ${answer.problem}`);
  return answer.data;
}

function refusal(answer: AgentWriteAnswer): { code: string; problem: string } {
  if (answer.ok) throw new Error(`expected a refusal, got: ${answer.text}`);
  return answer;
}

/** Everything about a module a change could write, as the rows hold it. */
function rows(moduleId: string) {
  const module = getModule(handle.db, moduleId)!;
  return {
    code: module.code,
    manifest: module.manifest,
    approvedAt: module.approvedAt,
    updatedAt: module.updatedAt,
    tests: listModuleTests(handle.db, moduleId).map((test) => [test.id, test.description, test.source, test.updatedAt]),
    versions: listModuleVersions(handle.db, moduleId).length,
  };
}

describe("preparing a change in the assistant's chat", () => {
  it("stages the saved module as files, lets the turn change one line, and freezes the whole result without touching the module", () => {
    const deploy = saveDeploy();
    const before = rows(deploy.id);
    const caller = assistTurn();

    const prepared = ok(staging.prepare(caller, { moduleId: deploy.id }));
    const directory = prepared["directory"] as string;
    expect(readFileSync(join(directory, STAGED_CODE_FILE), "utf8")).toBe(DEPLOY);
    expect(JSON.parse(readFileSync(join(directory, STAGED_MANIFEST_FILE), "utf8"))).toEqual(JSON.parse(JSON.stringify(MANIFEST)));
    const [staged] = prepared["tests"] as { id: string; file: string }[];
    expect(readFileSync(join(directory, staged!.file), "utf8")).toBe(DEPLOYS);

    // The change, as an edit of one line: nothing else is restated.
    ok(staging.edit(caller, { stagingId: prepared["stagingId"], file: STAGED_CODE_FILE, edits: [{ old_text: '"deploy failed"', new_text: '"deploy failed: " + done.tail' }] }));
    const frozen = ok(staging.freeze(caller, { stagingId: prepared["stagingId"], summary: "Says what the deploy printed." }));
    expect(frozen).toMatchObject({ moduleId: deploy.id, codeChanged: true, manifestChanged: false, tests: 0, removeTests: 0 });

    const resolved = resolveModuleChangeProposal(handle.db, frozen["proposalId"] as string, { itemId: caller.itemId, runId: caller.runId, moduleId: deploy.id });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.proposal.change).toEqual({
      moduleId: deploy.id,
      summary: "Says what the deploy printed.",
      code: DEPLOY.replace('"deploy failed"', '"deploy failed: " + done.tail'),
      manifest: null,
      tests: [],
      removeTests: [],
    });
    expect(resolved.proposal.room).toBe("assist");
    // The source version: the hashes of what was staged.
    expect(resolved.proposal.base).toMatchObject(changeBaseOf(deploy));

    // Installed code, manifest, test cases, history and approval: unchanged.
    expect(rows(deploy.id)).toEqual(before);
  });

  it("freezes a manifest change, an added case from a staged file and a removal, and the frozen change applies as a card's would", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const prepared = ok(staging.prepare(caller, { moduleId: deploy.id }));
    const stagingId = prepared["stagingId"];
    const removed = (prepared["tests"] as { id: string }[])[0]!.id;

    const trimmed = { ...MANIFEST, needs: { ...MANIFEST.needs, env: ["DEPLOY_TOKEN"] } };
    ok(staging.edit(caller, { stagingId, file: STAGED_MANIFEST_FILE, content: JSON.stringify(trimmed, null, 2) }));
    ok(staging.edit(caller, { stagingId, file: "tests/new-case.js", content: DEPLOYS.replace("prod", "staging") }));
    const frozen = ok(
      staging.freeze(caller, { stagingId, summary: "Drops AWS_PROFILE.", tests: [{ description: "deploys to staging", file: "tests/new-case.js" }], removeTests: [removed] }),
    );
    expect(frozen).toMatchObject({ codeChanged: false, manifestChanged: true, tests: 1, removeTests: 1 });

    const resolved = resolveModuleChangeProposal(handle.db, frozen["proposalId"] as string, { itemId: caller.itemId });
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.proposal.change.manifest).toEqual(trimmed);
    expect(resolved.proposal.change.tests).toEqual([{ description: "deploys to staging", source: DEPLOYS.replace("prod", "staging") }]);
    expect(resolved.proposal.change.removeTests).toEqual([removed]);
    expect(resolved.proposal.base.removes?.[removed]?.description).toBe("deploys to prod");

    // Still nothing applied; the card's Apply is what writes it.
    expect(getModule(handle.db, deploy.id)!.manifest).toEqual(MANIFEST);
    const { change } = resolved.proposal;
    const applied = applyModuleChange(handle.db, getModule(handle.db, deploy.id)!, change, resolved.proposal.base, { tests: change.tests, removeTests: change.removeTests, requireCases: true });
    expect(applied.ok).toBe(true);
    expect(getModule(handle.db, deploy.id)!.manifest).toEqual(ModuleManifestSchema.parse(trimmed));
  });

  it("needs no repository workspace: the staging area is EO's own, outside any checkout", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const prepared = ok(staging.prepare(caller, { moduleId: deploy.id }));
    expect((prepared["directory"] as string).startsWith(root)).toBe(true);
  });
});

describe("refusing a change that does not hold to the rules", () => {
  it("refuses malformed content with what to fix, and keeps nothing", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId } = ok(staging.prepare(caller, { moduleId: deploy.id }));

    // Nothing changed at all.
    expect(refusal(staging.freeze(caller, { stagingId, summary: "Nothing." })).problem).toContain("as it is already saved");
    // A manifest that is not JSON, then one that is not a manifest.
    ok(staging.edit(caller, { stagingId, file: STAGED_MANIFEST_FILE, content: "{ not json" }));
    expect(refusal(staging.freeze(caller, { stagingId, summary: "Broken." }))).toMatchObject({ code: "INVALID_MANIFEST" });
    ok(staging.edit(caller, { stagingId, file: STAGED_MANIFEST_FILE, content: JSON.stringify({ ...MANIFEST, inputs: "everything" }) }));
    expect(refusal(staging.freeze(caller, { stagingId, summary: "Broken." }))).toMatchObject({ code: "INVALID_CHANGE" });
    // An empty module.
    ok(staging.edit(caller, { stagingId, file: STAGED_MANIFEST_FILE, content: JSON.stringify(MANIFEST) }));
    ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, content: "" }));
    expect(refusal(staging.freeze(caller, { stagingId, summary: "Empty." }))).toMatchObject({ code: "INVALID_CHANGE" });
    // Every case removed, none added: a module that could not be approved again.
    ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, content: DEPLOY.replace("deployed", "released") }));
    const caseId = listModuleTests(handle.db, deploy.id)[0]!.id;
    expect(refusal(staging.freeze(caller, { stagingId, summary: "Removes all.", removeTests: [caseId] })).problem).toContain("no test cases");
    // A case the module does not hold.
    expect(refusal(staging.freeze(caller, { stagingId, summary: "Removes a stranger.", removeTests: ["not-a-case"] })).problem).toContain("does not hold");
    // Arguments the tool does not take.
    expect(refusal(staging.freeze(caller, { stagingId, summary: "x", code: "y" }))).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(refusal(staging.freeze(caller, { stagingId, summary: "x", tests: [{ description: "both", source: "a", file: "b" }] }))).toMatchObject({ code: "INVALID_ARGUMENT" });

    expect(handle.db.select().from(moduleChangeProposals).all()).toEqual([]);
  });

  it("refuses an edit that does not match exactly once, and changes nothing", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId, directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
    expect(refusal(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, edits: [{ old_text: "nowhere", new_text: "x" }] }))).toMatchObject({ code: "EDIT_NOT_UNIQUE" });
    expect(
      refusal(
        staging.edit(caller, {
          stagingId,
          file: STAGED_CODE_FILE,
          edits: [
            { old_text: "const stage", new_text: "let stage" },
            { old_text: "return", new_text: "yield" },
          ],
        }),
      ),
    ).toMatchObject({ code: "EDIT_NOT_UNIQUE" });
    expect(readFileSync(join(directory as string, STAGED_CODE_FILE), "utf8")).toBe(DEPLOY);
  });

  it("refuses a staging area the module has been saved over since, so a stale change is never frozen", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId } = ok(staging.prepare(caller, { moduleId: deploy.id }));
    ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, edits: [{ old_text: '"deploy failed"', new_text: '"failed"' }] }));
    const saved = saveModule(handle.db, { ...deploy, code: DEPLOY.replace("deployed", "shipped") });
    expect(saved.ok).toBe(true);
    expect(refusal(staging.freeze(caller, { stagingId, summary: "Stale." }))).toMatchObject({ code: "STALE_STAGING" });
  });
});

describe("who may prepare and use a change", () => {
  it("refuses a run in any other room, an unknown or another run's staging id, and an archived module", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId } = ok(staging.prepare(caller, { moduleId: deploy.id }));

    const story = createTestItem(handle.db, { type: "story", title: "Something else", stepId: "todo" });
    expect(refusal(staging.prepare(runOn(story, "implement"), { moduleId: deploy.id }))).toMatchObject({ code: "TOOL_NOT_SERVED" });
    // An assistant chat's item, but a run that is not its turn.
    const conversation = openAssistConversation(handle.db, null);
    expect(refusal(staging.prepare(runOn(conversation, "learning_review"), { moduleId: deploy.id }))).toMatchObject({ code: "TOOL_NOT_SERVED" });

    // Another run on the same conversation, and another conversation.
    const sameChat = runOn({ id: caller.itemId } as Item, ASSIST_ACTION);
    expect(refusal(staging.edit(sameChat, { stagingId, file: STAGED_CODE_FILE, content: "x" }))).toMatchObject({ code: "STAGING_NOT_FOUND" });
    expect(refusal(staging.freeze(assistTurn(), { stagingId, summary: "Mine now." }))).toMatchObject({ code: "STAGING_NOT_FOUND" });
    expect(refusal(staging.freeze(caller, { stagingId: "no-such-staging", summary: "x" }))).toMatchObject({ code: "STAGING_NOT_FOUND" });

    expect(refusal(staging.prepare(caller, { moduleId: "no-such-module" }))).toMatchObject({ code: "MODULE_NOT_FOUND" });
    expect(refusal(staging.prepare(caller, {}))).toMatchObject({ code: "INVALID_ARGUMENT" });
    archiveModule(handle.db, deploy.id);
    expect(refusal(staging.prepare(caller, { moduleId: deploy.id }))).toMatchObject({ code: "MODULE_NOT_FOUND" });
  });

  it("holds a scenario chat to its own module, and to code and manifest alone", () => {
    const deploy = saveDeploy();
    const other = saveDeploy("other");
    const caller = runOn(openScenarioConversation(handle.db, deploy, null), SCENARIO_ACTION);

    expect(refusal(staging.prepare(caller, { moduleId: other.id }))).toMatchObject({ code: "WRONG_MODULE" });
    const prepared = ok(staging.prepare(caller, {}));
    expect(prepared["moduleId"]).toBe(deploy.id);
    expect(prepared["tests"]).toEqual([]);
    const stagingId = prepared["stagingId"];
    ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, edits: [{ old_text: '"deploy failed"', new_text: '"failed"' }] }));
    expect(refusal(staging.freeze(caller, { stagingId, summary: "x", tests: [{ description: "a", source: "b" }] }))).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(refusal(staging.freeze(caller, { stagingId, summary: "x", removeTests: ["a"] }))).toMatchObject({ code: "INVALID_ARGUMENT" });

    const frozen = ok(staging.freeze(caller, { stagingId, summary: "Shorter reason." }));
    const resolved = resolveModuleChangeProposal(handle.db, frozen["proposalId"] as string, { itemId: caller.itemId, runId: caller.runId, moduleId: deploy.id });
    expect(resolved.ok && resolved.proposal.room).toBe("scenario");
  });

  it("resolves a proposal only for its own conversation, run and module", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId } = ok(staging.prepare(caller, { moduleId: deploy.id }));
    ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, edits: [{ old_text: '"deploy failed"', new_text: '"failed"' }] }));
    const proposalId = ok(staging.freeze(caller, { stagingId, summary: "x" }))["proposalId"] as string;

    expect(resolveModuleChangeProposal(handle.db, proposalId, { itemId: caller.itemId, runId: caller.runId, moduleId: deploy.id }).ok).toBe(true);
    expect(resolveModuleChangeProposal(handle.db, "unknown", { itemId: caller.itemId }).ok).toBe(false);
    expect(resolveModuleChangeProposal(handle.db, proposalId, { itemId: openAssistConversation(handle.db, null).id }).ok).toBe(false);
    expect(resolveModuleChangeProposal(handle.db, proposalId, { itemId: caller.itemId, runId: "another-run" }).ok).toBe(false);
    expect(resolveModuleChangeProposal(handle.db, proposalId, { itemId: caller.itemId, moduleId: saveDeploy("other").id }).ok).toBe(false);
  });
});

describe("the staging area's boundary", () => {
  it("refuses paths outside the staging area, symbolic links out of it, and files over the size limit", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId, directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
    const outside = mkdtempSync(join(tmpdir(), "eo-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "do not read");
      for (const file of ["../secret.txt", join(outside, "secret.txt"), "tests/../../x.js", "/etc/passwd", "."]) {
        expect(refusal(staging.edit(caller, { stagingId, file, edits: [{ old_text: "a", new_text: "b" }] })), file).toMatchObject({ code: "FILE_REFUSED" });
        expect(refusal(staging.edit(caller, { stagingId, file, content: "x" })), file).toMatchObject({ code: "FILE_REFUSED" });
        expect(refusal(staging.freeze(caller, { stagingId, summary: "x", tests: [{ description: "a", file }] })), file).toMatchObject({ code: "FILE_REFUSED" });
      }
      // A link to a file outside, and a linked directory leading outside.
      symlinkSync(join(outside, "secret.txt"), join(directory as string, "link.js"));
      symlinkSync(outside, join(directory as string, "out"));
      for (const file of ["link.js", "out/secret.txt"]) {
        expect(refusal(staging.freeze(caller, { stagingId, summary: "x", tests: [{ description: "a", file }] })), file).toMatchObject({ code: "FILE_REFUSED" });
        expect(refusal(staging.edit(caller, { stagingId, file, content: "overwritten" })), file).toMatchObject({ code: "FILE_REFUSED" });
      }
      expect(refusal(staging.edit(caller, { stagingId, file: "out/new.js", content: "x" }))).toMatchObject({ code: "FILE_REFUSED" });
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("do not read");
      expect(existsSync(join(outside, "new.js"))).toBe(false);
      // The staged code replaced by a link: freezing will not follow it.
      rmSync(join(directory as string, STAGED_CODE_FILE));
      symlinkSync(join(outside, "secret.txt"), join(directory as string, STAGED_CODE_FILE));
      expect(refusal(staging.freeze(caller, { stagingId, summary: "x" }))).toMatchObject({ code: "FILE_REFUSED" });
      rmSync(join(directory as string, STAGED_CODE_FILE));

      // Too large, written either way.
      const huge = "x".repeat(MAX_STAGED_FILE_BYTES + 1);
      expect(refusal(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, content: huge }))).toMatchObject({ code: "FILE_REFUSED" });
      writeFileSync(join(directory as string, STAGED_CODE_FILE), huge);
      expect(refusal(staging.freeze(caller, { stagingId, summary: "x" })).problem).toContain("limit");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /**
   * The staging directory itself swapped after prepare (EO-813 review): the
   * boundary is the directory EO made, not what its path leads to now.
   */
  describe("when the staging directory is replaced after it is prepared", () => {
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "eo-outside-"));
    });
    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    /** A directory laid out as a staging area, holding content that must never be read or written. */
    function decoy(at: string): void {
      mkdirSync(join(at, "tests"), { recursive: true });
      writeFileSync(join(at, STAGED_CODE_FILE), "outside code");
      writeFileSync(join(at, STAGED_MANIFEST_FILE), JSON.stringify(MANIFEST));
      writeFileSync(join(at, "tests", "case.js"), "outside case");
    }

    function expectRefusedAndUntouched(caller: ModuleChangeCaller, stagingId: unknown, at: string): void {
      for (const file of [STAGED_CODE_FILE, "tests/case.js", "new.js"]) {
        expect(refusal(staging.edit(caller, { stagingId, file, content: "overwritten" })), file).toMatchObject({ code: "FILE_REFUSED" });
      }
      expect(refusal(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, edits: [{ old_text: "outside", new_text: "overwritten" }] }))).toMatchObject({ code: "FILE_REFUSED" });
      expect(refusal(staging.freeze(caller, { stagingId, summary: "Ingest what is outside." }))).toMatchObject({ code: "FILE_REFUSED" });
      expect(refusal(staging.freeze(caller, { stagingId, summary: "x", tests: [{ description: "a", file: "tests/case.js" }] }))).toMatchObject({ code: "FILE_REFUSED" });
      expect(readFileSync(join(at, STAGED_CODE_FILE), "utf8")).toBe("outside code");
      expect(readFileSync(join(at, "tests", "case.js"), "utf8")).toBe("outside case");
      expect(existsSync(join(at, "new.js"))).toBe(false);
      expect(handle.db.select().from(moduleChangeProposals).all()).toHaveLength(0);
    }

    it("refuses edit and freeze when the directory is moved aside and a link to elsewhere put in its place", () => {
      const deploy = saveDeploy();
      const caller = assistTurn();
      const { stagingId, directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
      decoy(outside);
      renameSync(directory as string, `${directory as string}-aside`);
      symlinkSync(outside, directory as string);
      expectRefusedAndUntouched(caller, stagingId, outside);
      // Ending the run removes the link, not what it leads to.
      staging.releaseRun(caller.runId);
      expect(readFileSync(join(outside, STAGED_CODE_FILE), "utf8")).toBe("outside code");
      expect(readFileSync(join(outside, "tests", "case.js"), "utf8")).toBe("outside case");
      expect(existsSync(directory as string)).toBe(false);
    });

    it("refuses edit and freeze when the directory is replaced by another directory", () => {
      const deploy = saveDeploy();
      const caller = assistTurn();
      const { stagingId, directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
      renameSync(directory as string, `${directory as string}-aside`);
      decoy(directory as string);
      expectRefusedAndUntouched(caller, stagingId, directory as string);
    });

    it("refuses edit and freeze when a directory above it is replaced by a link", () => {
      const deploy = saveDeploy();
      const caller = assistTurn();
      const { stagingId, directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
      // The whole staging root moved aside, and a link to a look-alike outside in its place.
      const id = readdirSync(root)[0]!;
      decoy(join(outside, id));
      renameSync(root, `${root}-aside`);
      try {
        symlinkSync(outside, root);
        expectRefusedAndUntouched(caller, stagingId, join(outside, id));
        // And a link back to the very same directory still is not the directory EO made.
        rmSync(root);
        symlinkSync(`${root}-aside`, root);
        expect(refusal(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, content: "x" }))).toMatchObject({ code: "FILE_REFUSED" });
        expect(refusal(staging.freeze(caller, { stagingId, summary: "x" }))).toMatchObject({ code: "FILE_REFUSED" });
        expect(readFileSync(join(`${root}-aside`, id, STAGED_CODE_FILE), "utf8")).toBe(DEPLOY);
        expect(directory as string).toBe(join(root, id));
      } finally {
        rmSync(root, { force: true });
        rmSync(`${root}-aside`, { recursive: true, force: true });
      }
    });

    it("leaves everything outside untouched when the run ends after a directory above it is replaced by a link", () => {
      const deploy = saveDeploy();
      const caller = assistTurn();
      const { stagingId, directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
      const id = readdirSync(root)[0]!;
      decoy(join(outside, id));
      writeFileSync(join(outside, id, "valuable.txt"), "keep me");
      renameSync(root, `${root}-aside`);
      try {
        symlinkSync(outside, root);
        expect(refusal(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, content: "x" }))).toMatchObject({ code: "FILE_REFUSED" });
        staging.releaseRun(caller.runId);
        expect(readFileSync(join(outside, id, "valuable.txt"), "utf8")).toBe("keep me");
        expect(readFileSync(join(outside, id, STAGED_CODE_FILE), "utf8")).toBe("outside code");
        expect(readFileSync(join(outside, id, "tests", "case.js"), "utf8")).toBe("outside case");
        // The staging id is gone with the run, whatever was left on disk.
        expect(refusal(staging.freeze(caller, { stagingId, summary: "x" }))).toMatchObject({ code: "STAGING_NOT_FOUND" });
        // The directory EO made is left where it was moved, for the sweep at the next start.
        expect(readFileSync(join(`${root}-aside`, id, STAGED_CODE_FILE), "utf8")).toBe(DEPLOY);
        expect(directory as string).toBe(join(root, id));
        // And that sweep removes the link in the root's place, not what it leads to.
        staging.sweep();
        expect(existsSync(root)).toBe(false);
        expect(readFileSync(join(outside, id, "valuable.txt"), "utf8")).toBe("keep me");
      } finally {
        rmSync(root, { force: true });
        rmSync(`${root}-aside`, { recursive: true, force: true });
      }
    });

    it("leaves the directory put in its place when the run ends after the staging directory is replaced", () => {
      const deploy = saveDeploy();
      const caller = assistTurn();
      const { directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
      renameSync(directory as string, `${directory as string}-aside`);
      decoy(directory as string);
      staging.releaseRun(caller.runId);
      expect(readFileSync(join(directory as string, STAGED_CODE_FILE), "utf8")).toBe("outside code");
    });
  });

  it("reads a file the turn wrote itself inside the staging area", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId, directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
    mkdirSync(join(directory as string, "tests"), { recursive: true });
    writeFileSync(join(directory as string, STAGED_CODE_FILE), DEPLOY.replace("deployed", "released"));
    const frozen = ok(staging.freeze(caller, { stagingId, summary: "Edited with the turn's own tools." }));
    expect(frozen["codeChanged"]).toBe(true);
  });
});

describe("a frozen proposal's life", () => {
  it("is its own copy: editing or deleting the staging files afterwards, or sweeping them, does not change it", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId, directory } = ok(staging.prepare(caller, { moduleId: deploy.id }));
    ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, edits: [{ old_text: '"deploy failed"', new_text: '"failed"' }] }));
    const proposalId = ok(staging.freeze(caller, { stagingId, summary: "x" }))["proposalId"] as string;
    const before = resolveModuleChangeProposal(handle.db, proposalId, { itemId: caller.itemId });

    writeFileSync(join(directory as string, STAGED_CODE_FILE), "changed afterwards");
    ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, content: "changed again" }));
    expect(resolveModuleChangeProposal(handle.db, proposalId, { itemId: caller.itemId })).toEqual(before);

    // The run ends: its staging goes, the proposal stays.
    staging.releaseRun(caller.runId);
    expect(existsSync(directory as string)).toBe(false);
    expect(refusal(staging.freeze(caller, { stagingId, summary: "x" }))).toMatchObject({ code: "STAGING_NOT_FOUND" });
    staging.sweep();
    expect(existsSync(root)).toBe(false);
    expect(resolveModuleChangeProposal(handle.db, proposalId, { itemId: caller.itemId })).toEqual(before);
  });

  it("goes with its conversation when a person deletes it, and only then", () => {
    const deploy = saveDeploy();
    const caller = assistTurn();
    const { stagingId } = ok(staging.prepare(caller, { moduleId: deploy.id }));
    ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, edits: [{ old_text: '"deploy failed"', new_text: '"failed"' }] }));
    ok(staging.freeze(caller, { stagingId, summary: "x" }));
    expect(handle.db.select().from(moduleChangeProposals).all()).toHaveLength(1);
    deleteItem(handle.db, caller.itemId as Item["id"]);
    expect(handle.db.select().from(moduleChangeProposals).all()).toEqual([]);
  });

  it("survives a restart: the database keeps it, and a new process's staging knows nothing of the old one's", () => {
    const directory = mkdtempSync(join(tmpdir(), "eo-proposal-restart-"));
    try {
      const dbPath = join(directory, "eo.db");
      let first: DbHandle | null = openMigratedTestDbAt(dbPath);
      handle.close();
      handle = first;
      staging = createModuleChangeStaging({ db: handle.db, root });
      const deploy = saveDeploy();
      const caller = assistTurn();
      const { stagingId } = ok(staging.prepare(caller, { moduleId: deploy.id }));
      ok(staging.edit(caller, { stagingId, file: STAGED_CODE_FILE, edits: [{ old_text: '"deploy failed"', new_text: '"failed"' }] }));
      const proposalId = ok(staging.freeze(caller, { stagingId, summary: "Kept." }))["proposalId"] as string;
      const before = resolveModuleChangeProposal(handle.db, proposalId, { itemId: caller.itemId, runId: caller.runId });
      expect(before.ok).toBe(true);
      first.close();
      first = null;

      handle = openMigratedTestDbAt(dbPath);
      const restarted = createModuleChangeStaging({ db: handle.db, root });
      restarted.sweep();
      expect(resolveModuleChangeProposal(handle.db, proposalId, { itemId: caller.itemId, runId: caller.runId })).toEqual(before);
      expect(refusal(restarted.freeze(caller, { stagingId, summary: "x" }))).toMatchObject({ code: "STAGING_NOT_FOUND" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
