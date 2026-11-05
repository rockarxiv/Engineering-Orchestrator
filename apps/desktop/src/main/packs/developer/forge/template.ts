import type { ForgeKind } from "./remote.js";

/**
 * Finding the repository's pull/merge request template (F-06).
 *
 * A template is a property of the repository, so it is read out of the
 * **base branch** rather than off disk: `repoPath`'s checkout is
 * wherever the user last left it, which may be a half-finished branch or
 * a different feature entirely.
 *
 * This matters because `gh pr create --body` and `glab mr create
 * --description` both *override* the template — only the web UI applies
 * it. If EO does not find and fill it, a repository that requires one
 * silently stops getting it.
 */

/** Just enough git to look inside a ref, injected so none of this needs a repository to test. */
export interface TreeReader {
  showFile(ref: string, path: string): Promise<string | null>;
  listTree(ref: string, path: string): Promise<string[]>;
}

/** A body this long is nobody's template; it is a document that wandered in. */
export const MAX_TEMPLATE_CHARS = 4_000;

/**
 * In GitHub's own documented order. The name is matched in either case
 * because GitHub accepts both and repositories use both.
 */
const GITHUB_FILES = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
];

const GITHUB_DIR = ".github/PULL_REQUEST_TEMPLATE";
const GITLAB_DIR = ".gitlab/merge_request_templates";

export interface TemplateLookup {
  /** The template's text, or null when there is none — which is the ordinary case, not a failure. */
  body: string | null;
  /** Where it came from, for the Settings panel and the engine note. */
  path: string | null;
  /** Set when several were found and none is the default: EO uses none and says which it saw. */
  ambiguous: string[] | null;
  truncated: boolean;
}

const NONE: TemplateLookup = { body: null, path: null, ambiguous: null, truncated: false };

export interface FindTemplateInput {
  reader: TreeReader;
  ref: string;
  forge: ForgeKind;
  /** `repositories.forge_template_path` — an explicit answer, used before anything is searched. */
  override?: string | null;
}

export async function findTemplate({ reader, ref, forge, override }: FindTemplateInput): Promise<TemplateLookup> {
  if (override) return read(reader, ref, override);

  if (forge === "github") {
    for (const candidate of GITHUB_FILES) {
      const found = await read(reader, ref, candidate);
      if (found.body !== null) return found;
    }
    // GitHub applies *none* of a PULL_REQUEST_TEMPLATE/ directory
    // automatically — they are chosen by a `?template=` query parameter
    // in the web UI. So there is no default to fall back on, and the
    // only honest answers are "the single one" or "say which you meant".
    return fromDirectory(reader, ref, GITHUB_DIR, { defaultName: null });
  }

  // GitLab does have a default, and it is `Default.md`.
  return fromDirectory(reader, ref, GITLAB_DIR, { defaultName: "default.md" });
}

async function fromDirectory(
  reader: TreeReader,
  ref: string,
  dir: string,
  { defaultName }: { defaultName: string | null },
): Promise<TemplateLookup> {
  const entries = (await reader.listTree(ref, dir)).filter((path) => path.toLowerCase().endsWith(".md"));
  if (entries.length === 0) return NONE;

  if (defaultName) {
    const preferred = entries.find((path) => basename(path).toLowerCase() === defaultName);
    if (preferred) return read(reader, ref, preferred);
  }

  if (entries.length === 1) return read(reader, ref, entries[0]!);

  // Several, and no default. Guessing between `bug_fix.md` and
  // `security_fix.md` is how a security patch gets filed as a bug
  // report, so EO picks none and names what it saw.
  return { ...NONE, ambiguous: entries };
}

async function read(reader: TreeReader, ref: string, path: string): Promise<TemplateLookup> {
  const body = await reader.showFile(ref, path);
  if (body === null || body.trim() === "") return NONE;

  const truncated = body.length > MAX_TEMPLATE_CHARS;
  return {
    body: truncated ? `${body.slice(0, MAX_TEMPLATE_CHARS)}\n\n_(template truncated by EO)_` : body,
    path,
    ambiguous: null,
    truncated,
  };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
