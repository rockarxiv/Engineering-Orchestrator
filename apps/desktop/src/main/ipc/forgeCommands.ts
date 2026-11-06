import type { IpcPayload, IpcResponse, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getGitWorkspace } from "../db/repos/index.js";
import { describeSearchedDirectories } from "../process/searchPath.js";
import { CLI_FOR, createCliRunner, type CliRunner } from "../packs/developer/forge/cli.js";
import { guessForge, parseRemoteUrl } from "../packs/developer/forge/remote.js";
import { findTemplate, type TreeReader } from "../packs/developer/forge/template.js";
import { listTree, remoteUrl, showFile } from "../packs/developer/workspace/git.js";

/**
 * What EO can see about a repository's forge (F-06).
 *
 * Every step separately, the way `jira:test` reports its own: a single
 * "it did not work" sends people to check the wrong thing, and there
 * are four different things here that can be wrong on their own.
 */
export async function detectForge(db: Db, input: IpcPayload<"forge:detect">, run: CliRunner = createCliRunner(20_000)): Promise<IpcResponse<"forge:detect">> {
  const blank = { remoteUrl: null, host: null, kind: null, cliInstalled: false, authenticated: false, templatePath: null };

  const workspace = getGitWorkspace(db, input.repositoryId as Uuid);
  if (!workspace) return { ...blank, problem: "That repository no longer exists." };

  const { repoPath, baseBranch, forgeKind, forgeRemote, forgeTemplatePath } = workspace.config;

  const url = await remoteUrl(repoPath, forgeRemote);
  if (!url.ok) {
    return { ...blank, problem: `No remote named \`${forgeRemote}\` in ${repoPath}.` };
  }

  const host = parseRemoteUrl(url.stdout)?.host ?? null;
  const kind = forgeKind ?? (host ? guessForge(host) : null);
  if (!kind) {
    return {
      ...blank,
      remoteUrl: url.stdout,
      host,
      problem: `EO cannot tell whether ${host ?? url.stdout} is GitHub or GitLab. Say which below — guessing from a self-hosted hostname is how work ends up on the wrong kind of server.`,
    };
  }

  const cli = CLI_FOR[kind];
  const auth = await run(cli, ["auth", "status"], repoPath);
  const template = await findTemplate({ reader: treeReader(repoPath), ref: baseBranch, forge: kind, override: forgeTemplatePath });

  return {
    remoteUrl: url.stdout,
    host,
    kind,
    cliInstalled: !auth.notFound,
    authenticated: auth.ok,
    templatePath: template.path,
    problem: auth.notFound
      ? `\`${cli}\` is not installed. EO opens pull requests through it. ${describeSearchedDirectories()}`
      : auth.ok
        ? null
        : `\`${cli}\` is not signed in: run \`${cli} auth login\`.`,
  };
}

function treeReader(repoPath: string): TreeReader {
  return {
    showFile: async (ref, path) => {
      const result = await showFile(repoPath, ref, path);
      return result.ok ? result.stdout : null;
    },
    listTree: async (ref, path) => {
      const result = await listTree(repoPath, ref, path);
      return result.ok && result.stdout !== "" ? result.stdout.split("\n").filter((line) => line !== "") : [];
    },
  };
}
