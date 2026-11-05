import type { Item } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { getGitWorkspace } from "../../../db/repos/index.js";
import { packMeaningInForce } from "../../../registry.js";
import { listTree, showFile } from "../workspace/git.js";
import { guessForge, parseRemoteUrl } from "./remote.js";
import { findTemplate, type TreeReader } from "./template.js";
import { remoteUrl } from "../workspace/git.js";
import { workNameFor } from "../workspace/workName.js";

/**
 * Asking the reviewer for the pull request description (F-06).
 *
 * Delivered through the dispatch context, never through `reviewer.md`.
 * `syncRolePrompts` updates the prompts EO wrote and deliberately not
 * the ones a human edited (U-06), so a reviewer prompt someone has
 * customised would never receive a change made there — and the feature
 * would silently produce empty descriptions for exactly the people who
 * have been using EO longest.
 *
 * Returns null whenever there is nothing to ask for, which is most of
 * the time: a repository with no forge configured, any action that is
 * not a review, or a `review` that is the dispatched role's own rather
 * than this pack's (EO-422).
 */
export async function reviewAppendix(db: Db, item: Item, action: string, role: string | null = null): Promise<string | null> {
  if (action !== "review" || !item.workspaceId) return null;
  // A `review` the dispatched role defined for itself is not this
  // pack's review (EO-422): its answer is the role's generated shape,
  // which has no `pull_request_body` to return, and nothing reads a
  // verdict off it to approve.
  if (!packMeaningInForce(db, item, role, action)) return null;

  const workspace = getGitWorkspace(db, item.workspaceId);
  if (!workspace?.config.forgeOpenPr) return null;

  const { repoPath, baseBranch, forgeKind, forgeRemote, forgeTemplatePath } = workspace.config;
  const template = await templateFor(repoPath, baseBranch, forgeKind, forgeRemote, forgeTemplatePath);
  const naming = referenceNaming(db, item);

  if (!template) {
    return [
      "## If you approve",
      "",
      "Approving this opens a pull request. Return a `pull_request_body`: two or three paragraphs for someone who has not read the ticket — what changed, and why it is the right shape. Do not list the files; the diff already does.",
      ...naming,
      "",
      "Leave it out if you are rejecting.",
    ].join("\n");
  }

  return [
    "## If you approve",
    "",
    "Approving this opens a pull request, and this repository has a template for one. Return it filled in as `pull_request_body` — keep every heading exactly as written, since the repository may check for them, and answer each from what you have just reviewed.",
    ...naming,
    "",
    "Leave it out if you are rejecting.",
    "",
    "```markdown",
    template,
    "```",
  ].join("\n");
}

/**
 * The paragraph that keeps EO's and Jira's keys out of the description
 * when a Reference names the work (EO-638), or nothing when one does
 * not. Asked of the reviewer rather than enforced on its prose: EO does
 * not search and rewrite what an agent wrote.
 */
function referenceNaming(db: Db, item: Item): string[] {
  const name = workNameFor(db, item);
  if (name.kind !== "reference") return [];
  return [
    "",
    `This pull request is filed under ${name.value}: refer to the work by that name. Do not mention ${item.key}, its feature's key or any Jira key anywhere in \`pull_request_body\`.`,
  ];
}

async function templateFor(
  repoPath: string,
  baseBranch: string,
  forgeKind: "github" | "gitlab" | null,
  remote: string,
  override: string | null,
): Promise<string | null> {
  const url = await remoteUrl(repoPath, remote);
  const forge = forgeKind ?? guessForge(url.ok ? (parseRemoteUrl(url.stdout)?.host ?? "") : "");
  // Without knowing the forge there is no list of places to look. The
  // reviewer still gets asked for a description; it just writes its own.
  if (!forge) return null;

  const reader: TreeReader = {
    showFile: async (ref, path) => {
      const result = await showFile(repoPath, ref, path);
      return result.ok ? result.stdout : null;
    },
    listTree: async (ref, path) => {
      const result = await listTree(repoPath, ref, path);
      return result.ok && result.stdout !== "" ? result.stdout.split("\n").filter((line) => line !== "") : [];
    },
  };

  return (await findTemplate({ reader, ref: baseBranch, forge, override })).body;
}
