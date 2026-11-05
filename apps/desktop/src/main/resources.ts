import { join } from "node:path";

/**
 * Where the files that ship *alongside* the bundle live (P-01).
 *
 * Three things are read from disk at runtime rather than bundled:
 * SQL migrations, the role prompt files, and the shared EO MCP service
 * script that both real providers launch as a subprocess. Rollup bundles JavaScript
 * into `out/main/index.js`; it does not bundle `.sql`, `.md`, or a file
 * that has to exist as a real path for another process to execute.
 *
 * So they are shipped as `extraResources` and resolved from
 * `process.resourcesPath` when packaged. Unpackaged, they are read from
 * the source tree. Getting this wrong is invisible in development and
 * fatal on first launch of a release build — the app would fail to
 * migrate, or start every agent with an empty prompt.
 */
export interface ResourcePaths {
  migrations: string;
  prompts: string;
  eoMcpServer: string;
  /**
   * The wrapper that bounds a delivered MCP server's life by the backend
   * that started it (EO-151).
   *
   * Here for the same reason `eoMcpServer` is: it is executed as a real
   * path by a process EO does not own, so it cannot live inside the asar.
   */
  mcpServerSupervisor: string;
  /**
   * The command Codex runs as EO's broad-search hook (EO-379).
   *
   * Here for the reason the two above are: a Codex hook is a command the
   * CLI executes by path, so it cannot live inside the asar.
   */
  codexSearchHookCommand: string;
  /** The custom-module host (KAN-105), launched as a subprocess like the MCP service. */
  moduleHost: string;
  /**
   * The gallery's bundled templates (EO-316,
   * `ARCHITECTURE.md`, "The gallery").
   *
   * Here for the same reason the migrations are: a directory of `.json`
   * files read at runtime, which Rollup does not bundle. And here for
   * one more — "the app bundles a small set of templates so first run
   * works offline and on the day the installer does". A packaged build
   * that could not find this directory would show an empty gallery to
   * exactly the person the gallery exists for, and would show it as
   * "nothing available" rather than as an error.
   */
  gallery: string;
}

export function resolveResourcePaths(options: { isPackaged: boolean; resourcesPath: string; mainDir: string }): ResourcePaths {
  if (options.isPackaged) {
    const root = join(options.resourcesPath, "app-resources");
    return {
      migrations: join(root, "migrations"),
      prompts: join(root, "prompts"),
      eoMcpServer: join(root, "mcp", "eoServer.mjs"),
      mcpServerSupervisor: join(root, "mcp", "superviseStdioServer.mjs"),
      codexSearchHookCommand: join(root, "providers", "codexSearchHookCommand.mjs"),
      moduleHost: join(root, "modules", "moduleHost.mjs"),
      gallery: join(root, "gallery"),
    };
  }

  // Dev and `pnpm build`: out/main/index.js, so two levels up is the app root.
  const sourceRoot = join(options.mainDir, "..", "..", "src", "main");
  return {
    migrations: join(sourceRoot, "db", "migrations"),
    prompts: join(sourceRoot, "packs", "developer", "prompts"),
    eoMcpServer: join(sourceRoot, "mcp", "eoServer.mjs"),
    mcpServerSupervisor: join(sourceRoot, "mcp", "superviseStdioServer.mjs"),
    codexSearchHookCommand: join(sourceRoot, "providers", "codexSearchHookCommand.mjs"),
    moduleHost: join(sourceRoot, "modules", "moduleHost.mjs"),
    // Outside `src/main`, unlike every other entry: the templates are
    // content rather than code, and `resources/` is where the app's
    // shipped content already goes.
    gallery: join(sourceRoot, "..", "..", "resources", "gallery"),
  };
}
