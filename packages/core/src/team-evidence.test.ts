import { describe, expect, it } from "vitest";
import { AGENT_WRITE_TOOLS, AgentWriteBridgeAddressSchema } from "./agent-writes.js";
import { evidenceBaselineOf, EvidenceReadArgsSchema, EvidenceSearchArgsSchema, readEvidenceBaseline, reportOnlyRefusal, TEAM_EVIDENCE_TOOLS, type EvidenceBaselineRef } from "./team-evidence.js";

/** A report-only participant's evidence contract (EO-845). */

const REF: EvidenceBaselineRef = {
  version: 1,
  capturedAt: 1_760_000_000_000,
  workspaceKind: "git-worktree",
  source: { kind: "git", tree: "a".repeat(40), head: "b".repeat(40), files: 3, bytes: 120 },
  attachments: [{ id: "att-1", name: "spec.md", mimeType: "text/markdown", size: 12, sha256: "c".repeat(64) }],
};

describe("an evidence baseline", () => {
  it("is kept as its kind and the whole reference, and read back as it was", () => {
    const baseline = evidenceBaselineOf(REF);
    expect(baseline.kind).toBe("git-worktree");
    expect(readEvidenceBaseline(baseline)).toEqual(REF);
  });

  it("is refused when it cannot be read, or says another kind than it holds", () => {
    expect(readEvidenceBaseline({ kind: "git-worktree", ref: "tree-abc" })).toBeNull();
    expect(readEvidenceBaseline({ kind: "folder", ref: evidenceBaselineOf(REF).ref })).toBeNull();
    expect(() => evidenceBaselineOf({ ...REF, source: { kind: "git", tree: "HEAD", head: null, files: 0, bytes: 0 } })).toThrow();
  });

  it("names content: a tree for a repository, a manifest hash for a folder, nothing for no disk", () => {
    expect(readEvidenceBaseline(evidenceBaselineOf({ ...REF, workspaceKind: "folder", source: { kind: "folder", manifest: "d".repeat(64), files: 1, bytes: 1 } }))?.source.kind).toBe("folder");
    expect(readEvidenceBaseline(evidenceBaselineOf({ ...REF, workspaceKind: "none", source: { kind: "none" }, attachments: [] }))?.source).toEqual({ kind: "none" });
  });
});

describe("the evidence tools", () => {
  it("are bridged tools, and a report-only address says so", () => {
    for (const tool of TEAM_EVIDENCE_TOOLS) expect(AGENT_WRITE_TOOLS).toContain(tool);
    expect(AgentWriteBridgeAddressSchema.parse({ url: "u", token: "t", writes: [...TEAM_EVIDENCE_TOOLS], reportOnly: true }).reportOnly).toBe(true);
  });

  it("take only what they list, and search literal text with bounded results", () => {
    expect(EvidenceReadArgsSchema.safeParse({ path: "a.ts", command: "rm -rf /" }).success).toBe(false);
    expect(EvidenceReadArgsSchema.safeParse({ path: "a.ts", lineCount: 5000 }).success).toBe(false);
    expect(EvidenceSearchArgsSchema.safeParse({ text: "x", maxResults: 1000 }).success).toBe(false);
    expect(EvidenceSearchArgsSchema.parse({ text: "x" }).source).toBe("workspace");
  });

  it("refuse anything else in one sentence naming the tool and the four that are allowed", () => {
    const said = reportOnlyRefusal("Bash");
    expect(said).toContain("`Bash` was not run");
    for (const tool of TEAM_EVIDENCE_TOOLS) expect(said).toContain(tool);
  });
});
