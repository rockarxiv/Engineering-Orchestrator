import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  EVIDENCE_MAX_ATTACHMENTS,
  evidenceBaselineOf,
  NONE_KIND,
  readEvidenceBaseline,
  type EvidenceAttachmentRef,
  type EvidenceBaselineRef,
  type EvidenceSourceRef,
  type Item,
  type TeamEvidenceBaseline,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getAttachment, listAttachmentsForItem } from "../db/repos/attachmentsRepo.js";
import type { PreparedWorkspace, WorkspaceKind } from "./workspaceKind.js";

/**
 * A report-only team participant's evidence (EO-845, ARCHITECTURE.md, "A
 * team on an agent step"): what its workspace held and what the item's
 * attachments held when EO captured them, read through the three evidence
 * tools and nothing else.
 *
 * **Captured once, the same for every participant.** A team's first pass
 * is handed one baseline, so participants working side by side read the
 * same bytes whatever changes on disk meanwhile, and a report can always
 * be read against what its author saw. The baseline is content, not a
 * place: a git tree object for a repository (committed, modified and
 * untracked files alike — not HEAD while dirty files are ignored), a copy
 * EO keeps named by its manifest's hash for a folder, nothing for an item
 * with no disk, and each attachment's SHA-256.
 *
 * **Captured by the workspace kind.** Git is the developer pack's
 * business and a folder is the core's, so capturing and opening are an
 * optional capability of `WorkspaceKind` (`evidence`), and `packages/engine`
 * never sees any of it. A kind without the capability — or one that
 * cannot capture what it holds consistently — is refused with the reason,
 * never read live as a stand-in.
 *
 * **Read only within what was captured.** Every path is relative, held to
 * the captured listing rather than to a disk, with no `..`, no absolute
 * path and no symbolic link followed: a link is listed as one and never
 * read through.
 */

/** One entry of a captured workspace. */
export interface EvidenceEntry {
  /** Relative to the workspace's root, with `/` between segments. */
  path: string;
  type: "file" | "directory" | "symlink" | "submodule";
  /** Bytes, for a file. */
  size: number;
}

/** A search hit: where, and the line. */
export interface EvidenceMatch {
  path: string;
  line: number;
  text: string;
}

export type EvidenceResult<T> = { ok: true; value: T } | { ok: false; problem: string };

/** A captured workspace, opened for reading. Never reaches past what was captured. */
export interface WorkspaceEvidence {
  readonly source: EvidenceSourceRef;
  /** The entries directly under a directory (`""` for the root), sorted by path. */
  list(directory: string): Promise<EvidenceResult<EvidenceEntry[]>>;
  /** A file's bytes as captured. */
  read(path: string): Promise<EvidenceResult<Buffer>>;
  /** Lines holding `text` literally, under `under` (`""` for everything), at most `max`. */
  search(text: string, options: { ignoreCase: boolean; under: string; max: number }): Promise<EvidenceResult<EvidenceMatch[]>>;
}

export type EvidenceCaptureOutcome = { ok: true; evidence: WorkspaceEvidence } | { ok: false; problem: string };

/**
 * What a workspace kind lends a team's evidence (EO-845): capturing what
 * its prepared workspace holds now, and opening a capture again — on a
 * recovery, or for a participant started later — from its reference.
 */
export interface WorkspaceEvidenceCapability {
  capture(item: Item, workspace: PreparedWorkspace, signal?: AbortSignal): Promise<EvidenceCaptureOutcome>;
  open(item: Item, workspace: PreparedWorkspace, source: EvidenceSourceRef, signal?: AbortSignal): Promise<EvidenceCaptureOutcome>;
}

/** The most bytes of one file a read or a search looks at. */
export const EVIDENCE_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** The most bytes one attachment's capture reads. */
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * A relative evidence path, normalised — or why it is not one. No
 * absolute path, no drive, no backslash, no NUL, no `..` and no `.`
 * segment: what the agent names is held to the capture, never resolved
 * against a disk.
 */
export function evidencePath(raw: string | undefined): EvidenceResult<string> {
  if (raw === undefined) return { ok: true, value: "" };
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === ".") return { ok: true, value: "" };
  if (trimmed.includes("\0")) return { ok: false, problem: "A path cannot hold a NUL character." };
  if (trimmed.includes("\\")) return { ok: false, problem: "Name a path with `/` between its parts; `\\` is not one." };
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("~")) return { ok: false, problem: `\`${trimmed}\` is not relative to the work's root, and only what EO captured there can be read.` };
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === ".." || segment === ".")) return { ok: false, problem: `\`${trimmed}\` steps out of where it names, and only what EO captured can be read.` };
  return { ok: true, value: segments.join("/") };
}

/** Whether a file's bytes look like text: no NUL in its first eight kilobytes. */
export function looksLikeText(bytes: Buffer): boolean {
  return !bytes.subarray(0, 8192).includes(0);
}

/**
 * Evidence over a captured listing: listing and searching are answered
 * from it, reading from `readFile`, and nothing outside it is reachable —
 * a path not in the listing is not there, whatever a disk holds.
 */
export function listedEvidence(
  source: EvidenceSourceRef,
  entries: readonly EvidenceEntry[],
  readFile: (entry: EvidenceEntry) => Promise<EvidenceResult<Buffer>>,
): WorkspaceEvidence {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const directories = new Set<string>([""]);
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join("/"));
    if (entry.type === "directory") directories.add(entry.path);
  }
  const fileAt = (path: string): EvidenceResult<EvidenceEntry> => {
    const entry = byPath.get(path);
    if (entry === undefined) return { ok: false, problem: directories.has(path) ? `\`${path}\` is a directory; list it with evidence_list.` : `EO captured no \`${path}\`.` };
    if (entry.type === "symlink") return { ok: false, problem: `\`${path}\` is a symbolic link, and EO does not follow links: read what it points at by its own path, if EO captured it.` };
    if (entry.type === "submodule") return { ok: false, problem: `\`${path}\` is a submodule, whose files EO did not capture.` };
    if (entry.type === "directory") return { ok: false, problem: `\`${path}\` is a directory; list it with evidence_list.` };
    return { ok: true, value: entry };
  };
  return {
    source,
    async list(directory) {
      if (!directories.has(directory)) return { ok: false, problem: byPath.has(directory) ? `\`${directory}\` is not a directory.` : `EO captured no directory \`${directory}\`.` };
      const prefix = directory === "" ? "" : `${directory}/`;
      const children = new Map<string, EvidenceEntry>();
      for (const entry of entries) {
        if (!entry.path.startsWith(prefix)) continue;
        const rest = entry.path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) children.set(entry.path, entry);
        else {
          const path = prefix + rest.slice(0, slash);
          if (!children.has(path)) children.set(path, { path, type: "directory", size: 0 });
        }
      }
      return { ok: true, value: [...children.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
    },
    async read(path) {
      const entry = fileAt(path);
      if (!entry.ok) return entry;
      if (entry.value.size > EVIDENCE_FILE_MAX_BYTES) return { ok: false, problem: `\`${path}\` is ${String(entry.value.size)} bytes, more than EO reads of one file.` };
      return readFile(entry.value);
    },
    async search(text, { ignoreCase, under, max }) {
      if (under !== "" && !directories.has(under) && !byPath.has(under)) return { ok: false, problem: `EO captured no \`${under}\`.` };
      const needle = ignoreCase ? text.toLowerCase() : text;
      const matches: EvidenceMatch[] = [];
      for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        if (entry.type !== "file" || entry.size > EVIDENCE_FILE_MAX_BYTES) continue;
        if (under !== "" && entry.path !== under && !entry.path.startsWith(`${under}/`)) continue;
        const bytes = await readFile(entry);
        if (!bytes.ok || !looksLikeText(bytes.value)) continue;
        const lines = bytes.value.toString("utf8").split("\n");
        for (const [index, line] of lines.entries()) {
          if ((ignoreCase ? line.toLowerCase() : line).includes(needle)) {
            matches.push({ path: entry.path, line: index + 1, text: line.length > 500 ? `${line.slice(0, 500)}…` : line });
            if (matches.length >= max) return { ok: true, value: matches };
          }
        }
      }
      return { ok: true, value: matches };
    },
  };
}

/** No files at all: an item with no disk (EO-845). */
export function noEvidence(): WorkspaceEvidence {
  return listedEvidence({ kind: "none" }, [], async () => ({ ok: false, problem: "EO captured no files." }));
}

/** The capability the `none` kind lends: nothing to capture, said as such. */
export const NO_DISK_EVIDENCE: WorkspaceEvidenceCapability = {
  async capture() {
    return { ok: true, evidence: noEvidence() };
  },
  async open(_item, _workspace, source) {
    if (source.kind !== "none") return { ok: false, problem: "This item has no disk, so it holds none of the files that baseline names." };
    return { ok: true, evidence: noEvidence() };
  },
};

/** One participant's evidence, whole: the baseline and the workspace as it was captured. */
export interface TeamEvidence {
  ref: EvidenceBaselineRef;
  baseline: TeamEvidenceBaseline;
  workspace: WorkspaceEvidence;
}

export type TeamEvidenceOutcome = { ok: true; evidence: TeamEvidence } | { ok: false; problem: string };

export interface CaptureTeamEvidenceInput {
  db: Db;
  item: Item;
  /**
   * The kind the item's step works in, and its prepared workspace; null
   * for an item with no disk.
   */
  workspace: { kind: WorkspaceKind; prepared: PreparedWorkspace } | null;
  /** The attachments to give, by id; every attachment of the item when left out. */
  attachmentIds?: readonly string[];
  now?: number;
  signal?: AbortSignal;
}

/** The same JSON whatever order its keys were written in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, canonical(inner)]),
  );
}

/**
 * The item's task as a team's turns are given it (EO-847): its title, its
 * body, its spec and its type, hashed. What a person edits to change what
 * is asked — so a report made against what was asked before is not kept
 * once it changes, on an item with no disk as on one with a repository.
 * The thread is not part of it: a reply, a report or a note asks nothing
 * new of the work, and a team's own comments must never move its evidence.
 */
export function taskContextOf(item: Pick<Item, "title" | "body" | "spec" | "typeId">): { sha256: string } {
  const text = JSON.stringify(canonical({ title: item.title, body: item.body ?? "", spec: item.spec ?? null, type: item.typeId }));
  return { sha256: createHash("sha256").update(text).digest("hex") };
}

/**
 * Captures a team's evidence baseline (EO-845): the workspace through its
 * kind's capability, and the attachments with their SHA-256s. Refused
 * with the reason where either cannot be captured consistently — a kind
 * that cannot capture, an attachment that cannot be read — rather than
 * handing a participant something that is still changing.
 */
export async function captureTeamEvidence(input: CaptureTeamEvidenceInput): Promise<TeamEvidenceOutcome> {
  const capturedAt = input.now ?? Date.now();
  const workspace = await captureWorkspace(input);
  if (!workspace.ok) return workspace;
  const attachments = await captureAttachments(input.db, input.item, input.attachmentIds);
  if (!attachments.ok) return attachments;
  const ref: EvidenceBaselineRef = {
    version: 1,
    capturedAt,
    workspaceKind: input.workspace === null ? NONE_KIND : input.workspace.kind.slug,
    source: workspace.evidence.source,
    attachments: attachments.value,
    task: taskContextOf(input.item),
  };
  return { ok: true, evidence: { ref, baseline: evidenceBaselineOf(ref), workspace: workspace.evidence } };
}

async function captureWorkspace(input: CaptureTeamEvidenceInput): Promise<EvidenceCaptureOutcome> {
  if (input.workspace === null) return { ok: true, evidence: noEvidence() };
  const { kind, prepared } = input.workspace;
  if (kind.evidence === undefined) {
    return {
      ok: false,
      problem: `A ${kind.slug} workspace cannot be captured for a team: EO could not hand every participant the same copy of it, and does not let a team read a workspace that may change under it.`,
    };
  }
  return kind.evidence.capture(input.item, prepared, input.signal);
}

export interface OpenTeamEvidenceInput {
  db: Db;
  item: Item;
  workspace: { kind: WorkspaceKind; prepared: PreparedWorkspace } | null;
  baseline: TeamEvidenceBaseline;
  signal?: AbortSignal;
}

/**
 * Opens an attempt's baseline again (EO-845) — on a recovery, a retry or a
 * later round — from its reference alone, or refuses where what it names
 * is no longer there to be read. Never captures afresh in its place.
 */
export async function openTeamEvidence(input: OpenTeamEvidenceInput): Promise<TeamEvidenceOutcome> {
  const ref = readEvidenceBaseline(input.baseline);
  if (ref === null) return { ok: false, problem: "EO cannot read that evidence baseline, so it was not opened." };
  const expected = input.workspace === null ? NONE_KIND : input.workspace.kind.slug;
  if (ref.workspaceKind !== expected) return { ok: false, problem: `That evidence was captured from a ${ref.workspaceKind} workspace, and this item now works in a ${expected} one.` };
  let opened: EvidenceCaptureOutcome;
  if (input.workspace === null) opened = ref.source.kind === "none" ? { ok: true, evidence: noEvidence() } : { ok: false, problem: "This item has no disk, so it holds none of the files that baseline names." };
  else if (input.workspace.kind.evidence === undefined) opened = { ok: false, problem: `A ${input.workspace.kind.slug} workspace cannot be captured for a team, so its evidence cannot be opened.` };
  else opened = await input.workspace.kind.evidence.open(input.item, input.workspace.prepared, ref.source, input.signal);
  if (!opened.ok) return opened;
  return { ok: true, evidence: { ref, baseline: input.baseline, workspace: opened.evidence } };
}

async function captureAttachments(db: Db, item: Item, ids: readonly string[] | undefined): Promise<EvidenceResult<EvidenceAttachmentRef[]>> {
  const all = listAttachmentsForItem(db, item.id as Uuid);
  const chosen = ids === undefined ? all : ids.map((id) => all.find((attachment) => attachment.id === id) ?? id);
  const missing = chosen.filter((entry): entry is string => typeof entry === "string");
  if (missing.length > 0) return { ok: false, problem: `${item.key} has no attachment ${missing.map((id) => `\`${id}\``).join(", ")}, so the team's evidence was not captured.` };
  const records = chosen.filter((entry): entry is Exclude<(typeof chosen)[number], string> => typeof entry !== "string");
  if (records.length > EVIDENCE_MAX_ATTACHMENTS) {
    return { ok: false, problem: `${item.key} has ${String(records.length)} attachments, more than the ${String(EVIDENCE_MAX_ATTACHMENTS)} EO captures for a team; name the ones the team should read.` };
  }
  const captured: EvidenceAttachmentRef[] = [];
  for (const record of records) {
    const bytes = await readAttachmentBytes(record.path, record.size);
    if (!bytes.ok) return { ok: false, problem: `EO could not capture ${record.name} (\`${record.id}\`): ${bytes.problem}` };
    captured.push({ id: record.id, name: record.name, mimeType: record.mimeType, size: bytes.value.length, sha256: sha256(bytes.value) });
  }
  return { ok: true, value: captured };
}

async function readAttachmentBytes(path: string, size: number): Promise<EvidenceResult<Buffer>> {
  if (size > ATTACHMENT_MAX_BYTES) return { ok: false, problem: `it is ${String(size)} bytes, more than EO reads of one attachment.` };
  try {
    const bytes = await readFile(path);
    if (bytes.length > ATTACHMENT_MAX_BYTES) return { ok: false, problem: `it is ${String(bytes.length)} bytes, more than EO reads of one attachment.` };
    return { ok: true, value: bytes };
  } catch (error) {
    return { ok: false, problem: `it could not be read from EO's storage (${error instanceof Error ? error.message : String(error)}).` };
  }
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * One captured attachment's bytes (EO-845): named by the baseline, still
 * on the item, and still holding exactly what was captured — otherwise
 * refused, saying which.
 */
export async function readCapturedAttachment(db: Db, item: Item, ref: EvidenceBaselineRef, id: string): Promise<EvidenceResult<{ attachment: EvidenceAttachmentRef; bytes: Buffer }>> {
  const attachment = ref.attachments.find((each) => each.id === id) ?? ref.attachments.find((each) => each.name === id);
  if (attachment === undefined) return { ok: false, problem: `EO gave you no attachment \`${id}\`; evidence_list with source "attachments" names the ones it did.` };
  const record = getAttachment(db, attachment.id as Uuid);
  if (record === undefined || record.itemId !== item.id) return { ok: false, problem: `${attachment.name} is no longer on ${item.key}, so it cannot be read.` };
  const bytes = await readAttachmentBytes(record.path, record.size);
  if (!bytes.ok) return { ok: false, problem: `${attachment.name} ${bytes.problem}` };
  if (sha256(bytes.value) !== attachment.sha256) return { ok: false, problem: `${attachment.name} no longer holds what EO captured for the team, so it is not read.` };
  return { ok: true, value: { attachment, bytes: bytes.value } };
}
