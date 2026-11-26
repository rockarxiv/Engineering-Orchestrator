import { describeSearchedDirectories } from "../../../process/searchPath.js";

/**
 * Whether a failure is worth trying again (F-06).
 *
 * The default is **retryable**, deliberately. Classification from a
 * CLI's stderr is a heuristic, and the two mistakes are not equal:
 * retrying a permanent error six times costs half an hour of nothing,
 * while dropping a transient one loses the pull request and tells
 * somebody their work is up for review when it is not.
 */

export interface Classification {
  final: boolean;
  /** A sentence someone can act on, replacing the CLI's own phrasing where it is unhelpful. */
  message: string;
  /**
   * True for exactly one failure: a push git rejected because the remote
   * branch holds commits the local one does not (EO-429).
   *
   * Narrower than the pattern below that makes it final, on purpose.
   * `failed to push some refs` closes every rejected push — a declined
   * hook and a protected branch print it too — and this is what tells
   * the pull request step to send the ticket back to be rebased and
   * pushed with a lease. Saying that about a push a hook refused would
   * be advice to force something no force can fix.
   */
  diverged: boolean;
}

/** Git's own two names for it, as they appear on the `! [rejected]` line. */
const DIVERGED_PUSH = /non-fast-forward|\(fetch first\)/;

const DIVERGED_MESSAGE =
  "The remote branch has moved on since EO pushed it. EO will not force-push over work it did not write — reconcile the branch by hand and this can be retried.";

/** Matched against the CLI's stderr, lower-cased. Order matters only for readability. */
const FINAL_PATTERNS: { pattern: RegExp; message: (raw: string) => string }[] = [
  {
    // The one failure git states clearly and EO must never paper over:
    // the remote branch has moved and only a human should decide what
    // happens to it. `--force` is not an option EO gets to take.
    pattern: /non-fast-forward|failed to push some refs|fetch first|rejected.*\(non-fast-forward\)/,
    message: () => DIVERGED_MESSAGE,
  },
  {
    pattern: /could not read username|authentication failed|permission denied \(publickey\)|\b403\b|\bforbidden\b|not authorized|requires authentication/,
    message: (raw) => `The forge refused the credentials: ${raw}`,
  },
  {
    pattern: /repository not found|404 not found|does not exist|no such remote/,
    message: (raw) => `The forge could not find the repository: ${raw}`,
  },
  {
    // A protected base branch, or a repo that forbids the operation.
    pattern: /protected branch|you do not have permission|insufficient permission/,
    message: (raw) => `The forge would not accept this: ${raw}`,
  },
  {
    pattern: /must be a valid|invalid.*branch|is not a valid/,
    message: (raw) => `The forge rejected something in the request: ${raw}`,
  },
];

/** ENOENT and friends: the binary is not there, and no amount of waiting installs it. */
export function missingCli(cli: string): Classification {
  return {
    final: true,
    diverged: false,
    message: `\`${cli}\` is not on PATH. EO opens pull requests through it — install it, or turn this off in Settings → Forge. ${describeSearchedDirectories()}`,
  };
}

export function classifyForgeError(raw: string): Classification {
  const text = raw.trim();
  const lower = text.toLowerCase();

  if (/enoent|not found: |command not found/.test(lower) && !/repository not found/.test(lower)) {
    return { final: true, diverged: false, message: text };
  }

  for (const { pattern, message } of FINAL_PATTERNS) {
    if (pattern.test(lower)) return { final: true, diverged: DIVERGED_PUSH.test(lower), message: message(text) };
  }

  // Network trouble, a 5xx, a rate limit, a timeout — and anything this
  // does not recognise, which is the case that matters.
  return { final: false, diverged: false, message: text };
}

/**
 * A failed `git push`, where whether it diverged is known from the ref's
 * own status (`pushBranch`'s `rejection`) rather than guessed from the
 * text, which names the branch — a branch called `…non-fast-forward…`
 * says nothing about how it was refused (EO-910).
 *
 * Every message is EO's own sentence, never git's words: what git
 * printed carries whatever a hook or the server chose to print beside
 * it, a URL with its credential included, in any language. A refused ref
 * is said from its status alone (`pushRefusal`). Where git gave the ref
 * no status, `raw` only chooses which sentence, and whether it is worth
 * trying again; what it does not recognise — a git that speaks another
 * language, above all — is the retryable default, as everywhere here.
 */
export function classifyPushError(raw: string, diverged: boolean, status: string | null): Classification {
  if (diverged) return { final: true, diverged: true, message: DIVERGED_MESSAGE };
  const said = (final: boolean, message: string): Classification => ({ final, diverged: false, message });
  if (status !== null) return said(true, `The remote refused the push: git reported the branch as ${status}. EO did not force-push.`);
  const lower = raw.toLowerCase();
  if (/\benoent\b/.test(lower)) return said(true, "git could not be started for the push: it is not on PATH, or the worktree it runs in is gone.");
  if (/src refspec .* matches more than one/.test(lower)) {
    return said(true, "git would not push the branch because another ref has the same name (a tag `refs/tags/refs/heads/…`, say). EO did not force-push.");
  }
  if (/could not read username|authentication failed|permission denied \(publickey\)|\b403\b|not authorized|requires authentication/.test(lower)) {
    return said(true, "The remote refused the credentials git pushed with. Sign git in to the forge again, and this can be retried.");
  }
  if (/repository not found|does not appear to be a git repository|\b404\b/.test(lower)) return said(true, "git could not find the repository it was pushing to.");
  if (/failed to push some refs/.test(lower)) {
    return said(true, "git refused the push without the remote saying anything of the branch — a local pre-push hook, most likely. EO did not force-push.");
  }
  return said(false, "git could not push the branch — the remote may be unreachable, or git said something EO does not recognise. Nothing was forced.");
}
