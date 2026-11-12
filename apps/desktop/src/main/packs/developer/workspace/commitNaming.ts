import { jiraStateOf, type Item } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { getGitWorkspace, getItem } from "../../../db/repos/index.js";
import { packMeaningInForce } from "../../../registry.js";
import type { Check } from "../../../supervisor/workspaceKind.js";
import { git } from "./git.js";
import { resolveRemoteRef, type RemoteRefResolver } from "./remoteRef.js";
import { workNameOf } from "./workName.js";

/**
 * Keeping EO's and Jira's keys out of commit messages when a Reference
 * names the work (EO-768).
 *
 * The pull request title and description already name only the Reference
 * (EO-638), but commits are the implementer's to write, and with nothing
 * said it copies the repository's history and writes the EO key into
 * every one — which a squash merge then carries into the base branch.
 * So the implementer is told, and its branch is checked. Neither applies
 * when the work is named by a Jira key or the EO key itself.
 */
interface CommitNaming {
  reference: string;
  /** Every key no commit may name: the item's and its parent's EO and Jira keys. */
  keys: string[];
}

/** What a Reference forbids for this item, or null when no Reference names its work. */
export function commitNamingFor(db: Db, item: Item): CommitNaming | null {
  const parent = item.parentId === null ? null : getItem(db, item.parentId);
  const name = workNameOf(item, parent);
  if (name.kind !== "reference") return null;
  const candidates = [item.key, parent?.key ?? null, jiraStateOf(item).key, parent ? jiraStateOf(parent).key : null];
  // A Reference spelled the same as one of the keys is the name the
  // commits are told to use, so it cannot also be one they must not.
  const keys = [...new Set(candidates.filter((key): key is string => key !== null && key.toLowerCase() !== name.value.toLowerCase()))];
  return { reference: name.value, keys };
}

/**
 * The instruction, for the pack's `implement` dispatch.
 *
 * Delivered through the dispatch context rather than `implementer.md`
 * for `reviewAppendix`'s reason: `syncRolePrompts` never updates a prompt
 * a person customised (U-06), so a line added there would not reach them.
 */
export function implementAppendix(db: Db, item: Item, action: string, role: string | null = null): string | null {
  if (action !== "implement" || !packMeaningInForce(db, item, role, action)) return null;
  const naming = commitNamingFor(db, item);
  if (naming === null) return null;
  return [
    "## Commit messages",
    "",
    `This work is filed under ${naming.reference}: refer to it by that name in commit messages. ` +
      `Do not put ${naming.keys.join(", ")} or any other Jira key in any commit message, subject or body, even where the repository's history does. ` +
      `EO checks the commits this branch adds and sends the work back if one of them names such a key.`,
  ].join("\n");
}

/** Whether `message` names `key` as a whole key: `EO-12` is not in `EO-123`. */
export function namesKey(message: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![0-9])`, "i").test(message);
}

/**
 * Whether any commit this item added names a key it must not (EO-768).
 *
 * `range` is what the implementation check measured, so a stacked
 * dependency's commits and a named branch's commits from before EO
 * attached it are already outside it. Commits already on the remote
 * branch are left out too, matched by patch rather than by hash so one
 * the verifier has since rebased still counts as pushed: rewording it now
 * would mean force-pushing over what was published.
 *
 * Null when no Reference names the work: nothing is checked.
 */
export async function commitNamingCheck(
  db: Db,
  item: Item,
  range: { from: string; to: string } | null,
  resolve: RemoteRefResolver = resolveRemoteRef,
): Promise<Check | null> {
  const naming = commitNamingFor(db, item);
  if (naming === null || range === null || item.workspaceId === null) return null;
  const workspace = getGitWorkspace(db, item.workspaceId);
  if (!workspace) return null;
  const { repoPath, forgeRemote } = workspace.config;

  const remote = await resolve(repoPath, forgeRemote, range.to);
  const revisions =
    remote.kind === "remote" ? ["--cherry-pick", "--right-only", `${remote.ref}...${range.to}`, `^${range.from}`] : [`${range.from}..${range.to}`];
  const listed = await git(["log", "--format=%h%x1f%s%x1f%B%x1e", ...revisions, "--"], repoPath);
  if (!listed.ok) {
    return {
      key: "commit-naming",
      passed: false,
      blocks: true,
      describes: `EO could not read the commit messages on ${range.to}: ${listed.error}`,
    };
  }

  const offending = listed.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .flatMap((record) => {
      const [hash = "", subject = "", body = ""] = record.split("\x1f");
      const keys = naming.keys.filter((key) => namesKey(body, key));
      return keys.length === 0 ? [] : [{ hash, subject, keys }];
    });

  if (offending.length === 0) {
    return { key: "commit-naming", passed: true, blocks: true, describes: `No commit this branch adds names this work's EO or Jira keys; it is filed under ${naming.reference}.` };
  }

  const count = offending.length === 1 ? "A commit" : `${offending.length} commits`;
  return {
    key: "commit-naming",
    passed: false,
    blocks: true,
    describes: `${count} on this branch name${offending.length === 1 ? "s" : ""} a key, where this work is filed under ${naming.reference}.`,
    comment:
      `This work is filed under ${naming.reference}, and ${offending.length === 1 ? "a commit this branch adds names a key" : `${offending.length} commits this branch adds name keys`} that should stay out of commit messages:\n` +
      offending.map((commit) => `- ${commit.hash} ${commit.subject} — names ${commit.keys.join(", ")}`).join("\n") +
      `\n\nReword ${offending.length === 1 ? "it" : "them"} so the message${offending.length === 1 ? "" : "s"} refer to the work as ${naming.reference}, ` +
      `and keep ${naming.keys.join(", ")} and every Jira key out of the subject and the body.`,
  };
}
