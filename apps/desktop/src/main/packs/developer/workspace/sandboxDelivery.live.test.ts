import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentProvider, AgentSandbox, Item } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { getItem, listAgents, listCommentsForItem, listRunsForItem, stepForItem, updateAgent } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { createClaudeProvider } from "../../../providers/claude.js";
import { codexClientOptions, createCodexProvider, type CodexProviderOptions } from "../../../providers/codex.js";
import { CodexClient } from "../../../providers/codexClient.js";
import { prepareCodexHome } from "../../../providers/codexHome.js";
import { RUNTIMES } from "../../../runtimes/catalog.js";
import { runtimeRoot } from "../../../runtimes/install.js";
import { CLAUDE_SDK, resolvePackageSet } from "../../../runtimes/packages.js";
import { resolveRuntime } from "../../../runtimes/resolve.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { installedKinds } from "../../../supervisor/testWorkspaceKinds.js";
import { run } from "../../../testing/git.js";
import { developerSectionRenderers } from "../sections.js";
import { createRoleWiring } from "../wiring.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { gitWorkspaceKind } from "./gitKind.js";

/**
 * A sandboxed implementer, on a real repository, through the Delivery
 * pipeline EO seeds, with the real CLI (EO-934): the supervisor, the git
 * kind whole — `prepare` cutting the item's linked worktree, `attach`
 * working out what the sandbox may write, the implement verifier — and
 * the shipped implementer prompt, on a real turn. The turn's commands run
 * in the backend's sandbox, as EO launches it for an agent whose setting
 * is on.
 *
 * What it shows: the item reaches Review, with the run's commit on its
 * branch — the commit a sandboxed agent can only make because EO's
 * writable set holds the worktree's own git directory and the common
 * directory's `objects`, `refs` and `logs` (EO-933) — and the turn was
 * handed a sandbox. Everything else a sandbox refuses is held by
 * `providers/claudeSandbox.live.test.ts` and `codexSandbox.live.test.ts`.
 *
 * **Opt-in, because it spends real credit** — one implementer turn per
 * backend:
 *
 *     EO_LIVE_CLAUDE=1 EO_LIVE_CODEX=1 pnpm exec vitest run --root apps/desktop \
 *       src/main/packs/developer/workspace/sandboxDelivery.live.test.ts
 *
 * Each backend runs at EO's pin, resolved as the app resolves it
 * (`EO_CODEX_BIN` names another Codex). Under `$HOME`, not the temporary
 * directory, because a sandbox makes `/tmp` read-only.
 */
const CLAUDE = process.env["EO_LIVE_CLAUDE"] === "1";
const CODEX = process.env["EO_LIVE_CODEX"] === "1";
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const scratches: string[] = [];
afterAll(() => {
  for (const scratch of scratches) rmSync(scratch, { recursive: true, force: true });
});

function runtimesRoot(): string {
  return process.env["EO_RUNTIME_ROOT"] ?? runtimeRoot(join(homedir(), ".config", "EO"));
}

/** What each backend was launched with, read where it is handed over: Claude's SDK options, Codex's app-server configuration. */
type Launched = { sandbox: unknown; defaultPermissions: unknown }[];

async function claudeProvider(launched: Launched): Promise<AgentProvider> {
  const executable = resolveRuntime({ spec: RUNTIMES.claude, root: runtimesRoot() }).path;
  const sdkEntry = resolvePackageSet(runtimesRoot(), CLAUDE_SDK);
  if (executable === null || sdkEntry === null) throw new Error(`Claude Code or its SDK is not installed at EO's pins under ${runtimesRoot()}.`);
  const real = (await import(pathToFileURL(sdkEntry).href)) as { query: (params: { options?: Record<string, unknown> }) => unknown };
  const sdk = {
    ...real,
    query: (params: { options?: Record<string, unknown> }) => {
      launched.push({ sandbox: params.options?.["sandbox"], defaultPermissions: undefined });
      return real.query(params);
    },
  } as never;
  return createClaudeProvider({ sdk, executablePath: executable, enableCommentTool: false });
}

function codexProvider(root: string, launched: Launched): AgentProvider {
  const executable = process.env["EO_CODEX_BIN"] ?? resolveRuntime({ spec: RUNTIMES.codex, root: runtimesRoot() }).path;
  if (!executable) throw new Error(`Codex is not installed at EO's pin under ${runtimesRoot()}; name one with EO_CODEX_BIN.`);
  const homes = join(root, "codex-homes");
  mkdirSync(homes);
  const options: CodexProviderOptions = {
    executablePath: executable,
    // The implementer's turn is fenced (EO-926), and on Codex the fence is
    // the hook this command runs, as the app sets it up.
    searchHookCommandPath: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "providers", "codexSearchHookCommand.mjs"),
    codexHome: (itemId?: string) => {
      const prepared = prepareCodexHome({ root: homes, agentId: "eo934-live", ...(itemId ? { itemId } : {}), personHome: join(homedir(), ".codex") });
      if (!prepared.ok) throw new Error(prepared.problem);
      return prepared.path;
    },
  };
  return createCodexProvider({
    ...options,
    // The client the provider builds, kept on the way past.
    createCodex: (...args) => {
      const built = codexClientOptions(options, ...args);
      launched.push({ sandbox: args[10], defaultPermissions: built.config?.["default_permissions"] });
      return new CodexClient(built);
    },
  });
}

/** The provider, with each turn's sandbox kept as the supervisor handed it over. */
function recording(provider: AgentProvider, sandboxes: (AgentSandbox | undefined)[]): AgentProvider {
  return {
    ...provider,
    start: (opts) => {
      sandboxes.push(opts.sandbox);
      return provider.start(opts);
    },
    resume: (threadId, message, opts) => {
      sandboxes.push(opts?.sandbox);
      return provider.resume(threadId, message, opts);
    },
  };
}

async function deliver(backend: "claude" | "codex"): Promise<{ handle: DbHandle; item: Item; repoPath: string; worktreeRoot: string; sandboxes: (AgentSandbox | undefined)[]; launched: Launched }> {
  const root = realpathSync(mkdtempSync(join(homedir(), ".eo934-delivery-")));
  scratches.push(root);
  const repoPath = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  mkdirSync(repoPath);
  await run(["init", "-q", "-b", "main"], repoPath);
  for (const [key, value] of [["user.email", "eo@example.com"], ["user.name", "EO Test"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]] as const) await run(["config", key, value], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# greeter\n\nA tiny repository for a live test.\n");
  await run(["add", "-A"], repoPath);
  await run(["commit", "-q", "-m", "initial"], repoPath);

  const handle = openMigratedTestDb();
  setBranchPrefix(handle.db, "eo");
  const repository = attachWorkspace(handle.db, { name: "greeter", keyPrefix: "EO", repoPath, baseBranch: "main" });
  const item = createTestItem(handle.db, {
    type: "story",
    title: "Add a greeting file",
    body: "Add a file named GREETING.md at the top of the repository whose only line is `Hello from a sandbox.` Nothing else changes.",
    spec: { acceptance_criteria: ["GREETING.md exists at the top of the repository and its only line is `Hello from a sandbox.`"] },
    stepId: "todo",
    workspaceId: repository.id,
    projectId: repository.projectId,
  });

  const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  const model = backend === "claude" ? (process.env["EO_LIVE_CLAUDE_MODEL"] ?? "haiku") : process.env["EO_LIVE_CODEX_MODEL"];
  updateAgent(handle.db, implementer.id, { provider: backend, model: model ?? null, config: { ...implementer.config, sandboxed: true } });

  const sandboxes: (AgentSandbox | undefined)[] = [];
  const launched: Launched = [];
  const provider = backend === "claude" ? await claudeProvider(launched) : codexProvider(root, launched);
  const supervisor = createRunSupervisor({
    db: handle.db,
    provider: recording(provider, sandboxes),
    ...createRoleWiring(handle.db),
    sectionRenderers: developerSectionRenderers,
    limits: LIMITS,
    kinds: installedKinds(gitWorkspaceKind({ db: handle.db, worktreeRoot, intelligenceFor: () => null, verifyOptions: { timeoutMs: 60_000 } })),
  });
  await supervisor.runOnce();
  return { handle, item, repoPath, worktreeRoot, sandboxes, launched };
}

describe.each([
  ["claude", CLAUDE],
  ["codex", CODEX],
] as const)("a sandboxed implementer on %s, through Delivery (EO-934)", (backend, optedIn) => {
  it.skipIf(!optedIn)(
    "reaches Review with its commit made, in the sandbox EO worked out",
    async () => {
      const { handle, item, repoPath, worktreeRoot, sandboxes, launched } = await deliver(backend);
      try {
        const runs = listRunsForItem(handle.db, item.id);
        const said = listCommentsForItem(handle.db, item.id)
          .map((comment) => `[${comment.authorType}/${comment.kind}] ${comment.body.slice(0, 600)}`)
          .join("\n---\n");
        expect(runs.map((one) => [one.action, one.status]), said).toEqual([["implement", "succeeded"]]);

        // Launched sandboxed, with the item's own checkout writable.
        expect(sandboxes.length).toBeGreaterThanOrEqual(1);
        expect(sandboxes.every((sandbox) => sandbox !== undefined)).toBe(true);
        expect(sandboxes[0]?.writable[0]?.startsWith(worktreeRoot)).toBe(true);
        expect(sandboxes[0]?.writable).toContain(join(repoPath, ".git", "objects"));
        expect(sandboxes[0]?.writable).not.toContain(join(repoPath, ".git"));
        // And the backend was launched in it: the SDK's sandbox on Claude,
        // EO's permission profile on Codex.
        expect(launched.length).toBeGreaterThanOrEqual(1);
        if (backend === "claude") expect(launched.every((one) => (one.sandbox as { enabled?: unknown } | undefined)?.enabled === true)).toBe(true);
        else expect(launched.every((one) => one.defaultPermissions === "eo")).toBe(true);

        // On Review, with the commit on the item's branch.
        const now = getItem(handle.db, item.id)!;
        expect(stepForItem(handle.db, now)?.entryAction, said).toBe("review");
        const branch = (await run(["for-each-ref", "--format=%(refname:short)", "refs/heads/eo/"], repoPath)).trim();
        expect(branch, said).not.toBe("");
        expect(Number(await run(["rev-list", "--count", `main..${branch}`], repoPath))).toBeGreaterThanOrEqual(1);
        expect(await run(["show", `${branch}:GREETING.md`], repoPath)).toContain("Hello from a sandbox.");
      } finally {
        handle.close();
      }
    },
    900_000,
  );
});
