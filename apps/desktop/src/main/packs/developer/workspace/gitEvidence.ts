import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceSourceRef } from "@eo/core";
import { listedEvidence, type EvidenceCaptureOutcome, type EvidenceEntry, type EvidenceMatch, type EvidenceResult, type WorkspaceEvidence, type WorkspaceEvidenceCapability } from "../../../supervisor/teamEvidence.js";
import { composeGitArgs } from "./git.js";

/**
 * A repository's evidence for a report-only team (EO-845): the tree object
 * of its working tree as it is now.
 *
 * Built in a temporary index — never the repository's own — by reading
 * HEAD into it and adding every file `git add -A` would: committed,
 * modified and untracked alike, ignored ones left out. `git write-tree`
 * then names every byte of it in one id, which is what a participant's
 * baseline records beside the commit it was taken on. HEAD alone would
 * not say what a participant saw while a file was dirty.
 *
 * **Consistent, or refused.** The tree is taken twice; a working tree that
 * changed between the two is taken again, and one still changing after
 * three tries is refused rather than handed over mid-change.
 *
 * **Read from the object store.** Listing, reading and searching go to
 * the tree's own objects (`ls-tree`, `cat-file`, `grep` on the tree), so
 * nothing on disk — a file edited since, a symbolic link pointing out of
 * the checkout — is ever read. A link is a blob holding its target's
 * name, and is listed as a link and never read through; a submodule's
 * files are not part of the tree, and are said to be missing.
 *
 * The blobs `git add` writes are unreachable objects, which Git keeps for
 * two weeks by default before a `gc` may prune them; a baseline opened
 * after that is refused as gone, never captured afresh in its place.
 */

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const TRIES = 3;

type Raw = { ok: true; stdout: Buffer } | { ok: false; code: number | null; error: string };

/** One `git` invocation, bytes in and out, never through a shell. */
function gitRaw(args: string[], cwd: string, env: Record<string, string> = {}, signal?: AbortSignal): Promise<Raw> {
  return new Promise((resolve) => {
    execFile(
      "git",
      composeGitArgs(["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args], process.platform),
      { cwd, encoding: "buffer", windowsHide: true, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS, env: { ...process.env, ...env }, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
          resolve({ ok: false, code, error: (stderr.toString("utf8").trim() || error.message).split("\n")[0] ?? error.message });
        } else resolve({ ok: true, stdout });
      },
    );
  });
}

async function gitText(args: string[], cwd: string, env?: Record<string, string>, signal?: AbortSignal): Promise<EvidenceResult<string>> {
  const raw = await gitRaw(args, cwd, env, signal);
  return raw.ok ? { ok: true, value: raw.stdout.toString("utf8").trim() } : { ok: false, problem: raw.error };
}

/** The capability the git kind lends a team. */
export function gitEvidenceCapability(): WorkspaceEvidenceCapability {
  return {
    async capture(_item, workspace, signal) {
      const top = await gitText(["rev-parse", "--show-toplevel"], workspace.cwd, undefined, signal);
      if (!top.ok) return { ok: false, problem: `\`${workspace.cwd}\` is not in a Git repository EO can read, so it was not captured for the team: ${top.problem}` };
      const head = await gitText(["rev-parse", "--verify", "-q", "HEAD"], top.value, undefined, signal);
      const commit = head.ok && OID.test(head.value) ? head.value : null;
      const scratch = await mkdtemp(join(tmpdir(), "eo-team-evidence-"));
      try {
        const env = { GIT_INDEX_FILE: join(scratch, "index") };
        if (commit !== null) {
          const read = await gitText(["read-tree", commit], top.value, env, signal);
          if (!read.ok) return { ok: false, problem: `EO could not read ${commit} to capture the working tree: ${read.problem}` };
        }
        let previous: string | null = null;
        for (let attempt = 0; attempt < TRIES + 1; attempt++) {
          const added = await gitText(["add", "-A", "--", "."], top.value, env, signal);
          if (!added.ok) return { ok: false, problem: `EO could not capture the working tree of \`${top.value}\`: ${added.problem}` };
          const tree = await gitText(["write-tree"], top.value, env, signal);
          if (!tree.ok || !OID.test(tree.value)) return { ok: false, problem: `EO could not capture the working tree of \`${top.value}\`: ${tree.ok ? "git named no tree" : tree.problem}` };
          if (tree.value === previous) return openTree(top.value, tree.value, commit, signal);
          previous = tree.value;
        }
        return { ok: false, problem: `Files in \`${top.value}\` kept changing while EO captured them, so EO did not capture it for the team: a team is handed one consistent copy or none.` };
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    async open(_item, workspace, source, signal) {
      if (source.kind !== "git") return { ok: false, problem: "That evidence was not captured from a repository." };
      const top = await gitText(["rev-parse", "--show-toplevel"], workspace.cwd, undefined, signal);
      if (!top.ok) return { ok: false, problem: `\`${workspace.cwd}\` is not in a Git repository EO can read, so the team's evidence could not be opened.` };
      return openTree(top.value, source.tree, source.head, signal);
    },
  };
}

interface TreeEntry extends EvidenceEntry {
  oid: string;
}

async function openTree(repository: string, tree: string, head: string | null, signal?: AbortSignal): Promise<EvidenceCaptureOutcome> {
  const type = await gitText(["cat-file", "-t", tree], repository, undefined, signal);
  if (!type.ok || type.value !== "tree") return { ok: false, problem: `The tree EO captured for the team (${tree.slice(0, 12)}) is no longer in \`${repository}\`, so it cannot be read.` };
  const listed = await gitRaw(["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", tree], repository, undefined, signal);
  if (!listed.ok) return { ok: false, problem: `EO could not list the tree it captured: ${listed.error}` };
  const entries: TreeEntry[] = [];
  for (const record of listed.stdout.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, kind, oid, size] = record.slice(0, tab).split(/\s+/);
    const path = record.slice(tab + 1);
    if (oid === undefined) continue;
    const entryType: EvidenceEntry["type"] = kind === "tree" ? "directory" : kind === "commit" ? "submodule" : mode === "120000" ? "symlink" : "file";
    entries.push({ path, type: entryType, size: entryType === "file" ? Number(size) || 0 : 0, oid });
  }
  const files = entries.filter((entry) => entry.type === "file");
  const source: EvidenceSourceRef = { kind: "git", tree, head, files: files.length, bytes: files.reduce((sum, entry) => sum + entry.size, 0) };
  const oids = new Map(entries.map((entry) => [entry.path, entry.oid]));
  const base = listedEvidence(source, entries, async (entry) => {
    const oid = oids.get(entry.path);
    if (oid === undefined) return { ok: false, problem: `EO captured no \`${entry.path}\`.` };
    const blob = await gitRaw(["cat-file", "blob", oid], repository, undefined, signal);
    return blob.ok ? { ok: true, value: blob.stdout } : { ok: false, problem: `EO could not read \`${entry.path}\` from the tree it captured: ${blob.error}` };
  });
  const evidence: WorkspaceEvidence = {
    source,
    list: base.list,
    read: base.read,
    // Through `git grep` on the tree rather than blob by blob: the same
    // objects, read by one process. Literal text only (`-F`).
    async search(text, { ignoreCase, under, max }) {
      if (under !== "" && !oids.has(under) && !entries.some((entry) => entry.path.startsWith(`${under}/`))) return { ok: false, problem: `EO captured no \`${under}\`.` };
      const found = await gitRaw(["grep", "-F", "-I", "-n", "-z", "--no-color", ...(ignoreCase ? ["-i"] : []), "-e", text, tree, "--", ...(under === "" ? [] : [under])], repository, undefined, signal);
      if (!found.ok) return found.code === 1 ? { ok: true, value: [] } : { ok: false, problem: `EO could not search the tree it captured: ${found.error}` };
      const matches: EvidenceMatch[] = [];
      for (const line of found.stdout.toString("utf8").split("\n")) {
        if (line === "") continue;
        const [name, number, ...rest] = line.split("\0");
        if (name === undefined || number === undefined) continue;
        const path = name.startsWith(`${tree}:`) ? name.slice(tree.length + 1) : name;
        const said = rest.join("\0");
        matches.push({ path, line: Number(number), text: said.length > 500 ? `${said.slice(0, 500)}…` : said });
        if (matches.length >= max) break;
      }
      return { ok: true, value: matches };
    },
  };
  return { ok: true, evidence };
}
