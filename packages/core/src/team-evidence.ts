import { z } from "zod";
import type { TeamEvidenceBaseline } from "./teamSession.js";

/**
 * What a report-only team participant may read, and how what it read is
 * named (EO-845, ARCHITECTURE.md, "A team on an agent step").
 *
 * A participant is dispatched with four tools and nothing else: three
 * that read the **evidence** it was given — the files of its workspace as
 * they were captured, and the item's attachments as they were captured —
 * and one that reads the item and the part of its thread it may see.
 * Each is a tool of the `eo` server answered in EO's main process over
 * the agent write bridge, which holds the participant's scope (its
 * attempt, its captured evidence, where its thread ends) and answers from
 * it alone. The `eo` server lists nothing else on such a turn and refuses
 * anything else it is asked, and each backend's `PreToolUse` hook refuses
 * every other call before it runs.
 *
 * Named here for the reason every bridged tool is: the service lists it,
 * the main process answers it, the call rule lets it through and the
 * prompt names it, and a literal in four places is one rename away from a
 * tool that is listed and never answered.
 */
export const EVIDENCE_LIST_TOOL_NAME = "evidence_list";
export const EVIDENCE_READ_TOOL_NAME = "evidence_read";
export const EVIDENCE_SEARCH_TOOL_NAME = "evidence_search";
export const ITEM_CONTEXT_TOOL_NAME = "item_context";

/** Every tool a report-only participant is served, and the only ones. */
export const TEAM_EVIDENCE_TOOLS = [EVIDENCE_LIST_TOOL_NAME, EVIDENCE_READ_TOOL_NAME, EVIDENCE_SEARCH_TOOL_NAME, ITEM_CONTEXT_TOOL_NAME] as const;
export type TeamEvidenceTool = (typeof TEAM_EVIDENCE_TOOLS)[number];

export function isTeamEvidenceTool(name: string): name is TeamEvidenceTool {
  return (TEAM_EVIDENCE_TOOLS as readonly string[]).includes(name);
}

/**
 * Where a piece of evidence comes from: the workspace's captured files,
 * or the item's captured attachments.
 */
export const EvidenceSourceSchema = z.enum(["workspace", "attachments"]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/** A relative path, as the agent names it. Held to the captured source when it is answered, never to a disk. */
const EvidencePathSchema = z.string().max(4096);

/** The most lines one read answers with. */
export const EVIDENCE_READ_MAX_LINES = 2000;
/** The most matches one search answers with. */
export const EVIDENCE_SEARCH_MAX_RESULTS = 200;

export const EvidenceListArgsSchema = z.strictObject({
  source: EvidenceSourceSchema.default("workspace"),
  /** A directory of the workspace, relative; the root when left out. Ignored for attachments. */
  path: EvidencePathSchema.optional(),
  /** How many entries to skip, to page a long directory. */
  offset: z.number().int().min(0).optional(),
});
export type EvidenceListArgs = z.infer<typeof EvidenceListArgsSchema>;

export const EvidenceReadArgsSchema = z.strictObject({
  source: EvidenceSourceSchema.default("workspace"),
  /** A file of the workspace, relative — or, for attachments, the attachment's id. */
  path: EvidencePathSchema.min(1),
  /** The first line to answer with, counting from 1. */
  startLine: z.number().int().min(1).optional(),
  /** How many lines, at most `EVIDENCE_READ_MAX_LINES`. */
  lineCount: z.number().int().min(1).max(EVIDENCE_READ_MAX_LINES).optional(),
});
export type EvidenceReadArgs = z.infer<typeof EvidenceReadArgsSchema>;

export const EvidenceSearchArgsSchema = z.strictObject({
  /**
   * Text to find, matched literally — not a regular expression, so a
   * search cannot be made to run for ever in EO's own process.
   */
  text: z.string().min(1).max(500),
  source: EvidenceSourceSchema.default("workspace"),
  /** A directory or file of the workspace to search under, relative; everything when left out. */
  path: EvidencePathSchema.optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(EVIDENCE_SEARCH_MAX_RESULTS).optional(),
});
export type EvidenceSearchArgs = z.infer<typeof EvidenceSearchArgsSchema>;

export const ItemContextArgsSchema = z.strictObject({});
export type ItemContextArgs = z.infer<typeof ItemContextArgsSchema>;

/**
 * What a workspace's evidence was captured as — content, not a place:
 *
 * - **git**: the tree object of the working tree as it was, committed,
 *   modified and untracked files alike (ignored files are not part of
 *   it), with the commit it was taken on. The tree identifies every
 *   byte; HEAD alone would not, while a file was dirty.
 * - **folder**: a copy EO keeps, named by the SHA-256 of its manifest —
 *   every file's path, size and SHA-256.
 * - **none**: no files: the item has no disk, or its step works on none.
 */
export const EvidenceSourceRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("git"),
    tree: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    head: z
      .string()
      .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
      .nullable(),
    files: z.number().int().min(0),
    bytes: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal("folder"),
    manifest: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.number().int().min(0),
    bytes: z.number().int().min(0),
  }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type EvidenceSourceRef = z.infer<typeof EvidenceSourceRefSchema>;

/** One attachment as it was captured: which, and the SHA-256 of what it held. */
export const EvidenceAttachmentRefSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EvidenceAttachmentRef = z.infer<typeof EvidenceAttachmentRefSchema>;

/** The most attachments one baseline names. */
export const EVIDENCE_MAX_ATTACHMENTS = 100;

/**
 * Everything one participant was given to read, as it is kept on its
 * attempt (`TeamEvidenceBaselineSchema.ref`): when it was captured, the
 * workspace kind it came from, what the workspace held, and every
 * attachment with what it held. Enough to open the same evidence again
 * on recovery and to refuse any of it that is no longer what it was;
 * nothing in it names a path on this machine.
 */
export const EvidenceBaselineRefSchema = z.strictObject({
  version: z.literal(1),
  capturedAt: z.number().int(),
  /** The workspace kind's slug, or `none`. */
  workspaceKind: z.string().min(1),
  source: EvidenceSourceRefSchema,
  attachments: z.array(EvidenceAttachmentRefSchema).max(EVIDENCE_MAX_ATTACHMENTS),
});
export type EvidenceBaselineRef = z.infer<typeof EvidenceBaselineRefSchema>;

/** The baseline as an attempt keeps it: the kind, and the whole reference as canonical JSON. */
export function evidenceBaselineOf(ref: EvidenceBaselineRef): TeamEvidenceBaseline {
  const parsed = EvidenceBaselineRefSchema.parse(ref);
  return { kind: parsed.workspaceKind, ref: JSON.stringify(parsed) };
}

/** The reference an attempt's baseline holds, or null for one this build cannot read. */
export function readEvidenceBaseline(baseline: TeamEvidenceBaseline): EvidenceBaselineRef | null {
  let raw: unknown;
  try {
    raw = JSON.parse(baseline.ref);
  } catch {
    return null;
  }
  const parsed = EvidenceBaselineRefSchema.safeParse(raw);
  if (!parsed.success || parsed.data.workspaceKind !== baseline.kind) return null;
  return parsed.data;
}

/**
 * The sentence a report-only participant is answered with when it makes
 * any call but its four: by the `PreToolUse` hook, by the `eo` server and
 * by the bridge alike.
 */
export function reportOnlyRefusal(tool: string): string {
  return (
    `EO refused this call: this turn is a report-only team participant, which may read the evidence it was given — with ` +
    `${TEAM_EVIDENCE_TOOLS.join(", ")} — and answer with its report, and nothing else. \`${tool}\` was not run, and nothing it would have done happened.`
  );
}
