import { GIT_WORKTREE_KIND, type IpcResponse, type PipelineExport, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { asGitWorkspace, projectWorkspaceList } from "../db/repos/index.js";
import { describeSearchedDirectories } from "../process/searchPath.js";
import { forgeCardNeed, opensPullRequests, type GalleryNeed } from "./form.js";

/**
 * The forge CLI lines of the needs check (EO-663, ARCHITECTURE.md, "The needs check").
 *
 * A pipeline with a step that opens a pull request opens it through `gh`
 * or `glab`, and which one is a fact about each repository's remote — so
 * there is one line per repository attached, each read from `forge:detect`'s
 * answer for it. Before any repository is attached, the card's line stands
 * in (`forgeCardNeed`).
 *
 * EO does not install either CLI. A red line says which one is needed and
 * why, links to where it is installed from, and its button asks again.
 */

/** `forge:detect`, for one repository. Injected so a test need not run `gh`. */
export type DetectForge = (repositoryId: string) => Promise<IpcResponse<"forge:detect">>;

const CLIS = {
  github: { forge: "GitHub", name: "GitHub CLI", bin: "gh", host: "github.com", install: "https://cli.github.com" },
  gitlab: { forge: "GitLab", name: "GitLab CLI", bin: "glab", host: "gitlab.com", install: "https://gitlab.com/gitlab-org/cli#installation" },
} as const;

export async function forgeNeeds(db: Db, projectId: Uuid, document: Pick<PipelineExport, "steps">, detect: DetectForge): Promise<GalleryNeed[]> {
  if (!opensPullRequests(document)) return [];
  const repositories = projectWorkspaceList(db, projectId).flatMap((workspace) => {
    const git = workspace.kind === GIT_WORKTREE_KIND ? asGitWorkspace(workspace) : null;
    return git ? [git] : [];
  });
  if (repositories.length === 0) return forgeCardNeed(document);
  return Promise.all(repositories.map(async (repository) => forgeLine(repository.id, repository.config.name, await detect(repository.id))));
}

/** One repository's line, from what `forge:detect` found about it. */
export function forgeLine(repositoryId: string, name: string, found: IpcResponse<"forge:detect">): GalleryNeed {
  const key = `forge:${repositoryId}`;
  const checkAgain = { kind: "forge" as const, label: "Check again", target: repositoryId };

  if (found.kind === null) {
    return {
      key,
      line: `GitHub or GitLab CLI, for ${name}`,
      met: false,
      // forge:detect's own words — no remote, or a host it cannot place.
      why: found.problem ?? `EO cannot tell whether ${name} is on GitHub or GitLab.`,
      // A remote EO cannot place is answered by saying which it is; no
      // remote at all is not, and is checked again once one is added.
      fix: found.remoteUrl === null ? checkAgain : { kind: "forgeKind", label: "Say which", target: repositoryId },
    };
  }

  const cli = CLIS[found.kind];
  const line = `${cli.name} (${cli.bin}) installed and signed in, for ${name}`;
  if (!found.cliInstalled) {
    return {
      key,
      line,
      met: false,
      why: `${name} is on ${cli.forge}, and EO opens its pull requests through the ${cli.name}, ${cli.bin}, which is not installed on this machine. Install it, then check again. ${describeSearchedDirectories()}`,
      fix: { ...checkAgain, link: { label: `Install ${cli.bin}`, url: cli.install } },
    };
  }
  if (!found.authenticated) {
    // A self-hosted server is signed in to by name; the public one is the CLI's default.
    const login = found.host === null || found.host === cli.host ? `${cli.bin} auth login` : `${cli.bin} auth login --hostname ${found.host}`;
    return {
      key,
      line,
      met: false,
      why: `${cli.bin} is installed but not signed in, so EO cannot open pull requests for ${name}. In a terminal, run: ${login}`,
      fix: checkAgain,
    };
  }
  return { key, line, met: true, why: null, fix: null };
}
