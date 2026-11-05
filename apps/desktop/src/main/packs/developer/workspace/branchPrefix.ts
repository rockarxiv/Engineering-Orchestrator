import type { Db } from "../../../db/client.js";
import { getSetting, setSetting } from "../../../db/repos/index.js";
import { globalUserEmail } from "./git.js";

/** Where the branch prefix lives in `app_settings` (EO-15). */
export const BRANCH_PREFIX_KEY = "workspace.branchPrefix";

/**
 * What every branch used before this setting existed, and what a git
 * config with no usable `user.email` still gets today — changing nothing
 * for a user who never opens Settings.
 */
export const DEFAULT_BRANCH_PREFIX = "eo";

/**
 * Lowercases a raw string and strips or collapses whatever a git ref
 * disallows, so it is safe to use as the path segment before `/<KEY>` in
 * a branch name.
 *
 * Pure — no DB, no git, no I/O — so the rules can be exercised directly
 * rather than through a getter that also happens to touch a database.
 */
export function sanitizeBranchPrefix(raw: string): string {
  // Control characters first, and outside the regex below: a character
  // class spanning \x00-\x1f trips eslint's no-control-regex, which
  // exists because that range is so often an accidental typo — here it
  // is deliberate, so it is filtered by code point instead.
  const withoutControlChars = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("");

  return withoutControlChars
    .trim()
    .toLowerCase()
    // Everything else `git check-ref-format` refuses outright: space and ~^:?*[\
    .replace(/[\s~^:?*[\\]/g, "")
    // Doubled `.` or `/` collapse to one rather than disappearing
    // entirely — "a..b" becoming "ab" would silently merge two names
    // that were never meant to collide.
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    // A ref component may not begin or end with `.`, and may not end
    // with `/`; trimming both ends of the whole segment covers all of
    // it, since it is stored and used as a single component.
    .replace(/^[./]+|[./]+$/g, "");
}

/**
 * The default prefix derived from a `git config user.email` value: the
 * local part before `@`, sanitized. Falls back to {@link
 * DEFAULT_BRANCH_PREFIX} when there is no email, or sanitizing it leaves
 * nothing usable (e.g. an address that is all punctuation).
 *
 * Pure, like {@link sanitizeBranchPrefix} — the getter below is the only
 * place this touches git or the database.
 */
export function defaultBranchPrefixFromEmail(email: string | null): string {
  if (!email) return DEFAULT_BRANCH_PREFIX;
  const local = email.split("@")[0] ?? "";
  const sanitized = sanitizeBranchPrefix(local);
  return sanitized || DEFAULT_BRANCH_PREFIX;
}

/**
 * The global branch prefix (EO-15 / EO-14), or the seeded default on the
 * very first read.
 *
 * With no stored row, this derives a default from `git config --global
 * user.email` and persists it before returning — the same "seed once"
 * shape `jiraPullMinutes()` and `archiveAfterDays()` use for their own
 * preferences. Persisting immediately is what makes the derivation a
 * one-time thing rather than a live setting: a later change to git
 * config, or git going missing, must never move a prefix branches have
 * already been cut under.
 *
 * `readEmail` is overridable for tests, which want to control what
 * `user.email` resolves to without touching the machine's real global
 * git config.
 */
export async function branchPrefix(db: Db, readEmail: () => Promise<string | null> = globalUserEmail): Promise<string> {
  const stored = getSetting<{ prefix: string | null }>(db, BRANCH_PREFIX_KEY, { prefix: null });
  if (stored.prefix !== null) return stored.prefix;

  const email = await readEmail();
  const prefix = defaultBranchPrefixFromEmail(email);
  setSetting(db, BRANCH_PREFIX_KEY, { prefix });
  return prefix;
}

export function setBranchPrefix(db: Db, prefix: string): void {
  setSetting(db, BRANCH_PREFIX_KEY, { prefix });
}
