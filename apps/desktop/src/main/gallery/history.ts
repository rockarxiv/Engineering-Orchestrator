import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_HISTORY_VERSION, TemplateHistoryEntrySchema } from "@eo/core";
import type { TemplateDocument } from "../db/repos/index.js";
import { parseExport } from "../modules/pipelineTransfer.js";

/**
 * Every version of every bundled template (EO-531).
 *
 * The gallery shows a template's newest version; this is the rest of
 * them. A pipeline made from a template remembers which version it came
 * from, and a later release compares it against that version — its
 * *base* — to tell what the person changed from what the template did.
 * So the app ships every version it has ever bundled, under
 * `gallery/history/<slug>/<version>.json`, each with release notes.
 *
 * The base a pipeline is compared against is read from EO's database
 * once it has been recorded (`pipelineOriginsRepo`), so a release that
 * dropped an old file here would not take anybody's base with it. What
 * this directory is for is the moments before a base is recorded: the
 * one-time backfill, which matches pipelines that predate origins
 * against these versions, and the update itself, which needs the new
 * version and its notes.
 */

/** One version of one template, as shipped. */
export interface TemplateVersion {
  slug: string;
  version: string;
  /** What changed in this version and why, in a person's words. */
  notes: string;
  /** The pack as this version shipped it, through the same gate as every other. */
  document: TemplateDocument;
}

/** Each template's versions by slug, oldest first. */
export type TemplateHistory = ReadonlyMap<string, readonly TemplateVersion[]>;

/** Where the history lives inside the gallery directory (`ResourcePaths.gallery`). */
export function templateHistoryDirectory(galleryDirectory: string): string {
  return join(galleryDirectory, "history");
}

/**
 * The order of two versions of one template.
 *
 * A template's `version` is the author's own and free-form — "1.0",
 * "2026-09-01" — so this compares runs of digits as numbers and the rest
 * as text. That orders "1.9" before "1.10" and one date before a later
 * one, which is every scheme a bundled template uses.
 */
export function compareTemplateVersions(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/**
 * The shipped history, read from the gallery directory.
 *
 * A file that will not parse, or whose path disagrees with the slug and
 * version its pack names, is **skipped** rather than thrown on — the
 * same bargain `bundledTemplates` makes, and for its reason: this is read
 * at startup, and a damaged file is a missing version rather than an EO
 * that will not start. `history.test.ts` is what notices one, by
 * checking every bundled template's history file by file.
 */
export function loadTemplateHistory(galleryDirectory: string): TemplateHistory {
  const root = templateHistoryDirectory(galleryDirectory);
  const history = new Map<string, TemplateVersion[]>();

  for (const slug of listing(root)) {
    const versions: TemplateVersion[] = [];
    for (const name of listing(join(root, slug))) {
      if (!name.endsWith(".json")) continue;
      const version = readVersion(join(root, slug, name));
      if (version === null) continue;
      if (version.slug !== slug || `${version.version}.json` !== name) continue;
      versions.push(version);
    }
    if (versions.length === 0) continue;
    versions.sort((a, b) => compareTemplateVersions(a.version, b.version));
    history.set(slug, versions);
  }
  return history;
}

/** One history file as a version, or null if it is not one. */
export function readVersion(path: string): TemplateVersion | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const entry = TemplateHistoryEntrySchema.safeParse(raw);
  if (!entry.success || entry.data.eoTemplateHistory > TEMPLATE_HISTORY_VERSION) return null;

  // Through `parseExport` again, for the reason `templateOf` gives: the
  // version check and the admin-grant refusal every other door into
  // this build has. The entry schema has already parsed the pack, so
  // this re-reads the raw value rather than the parsed one — the gate
  // is meant to see what shipped.
  const pack = parseExport(JSON.stringify((raw as { pack: unknown }).pack));
  if (!pack.ok) return null;
  const template = pack.document.template;
  if (template === null) return null;
  return {
    slug: template.slug,
    version: template.version,
    notes: entry.data.notes,
    document: { ...pack.document, template },
  };
}

/** Lists a directory, or nothing if it is not there. */
function listing(directory: string): string[] {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
}
