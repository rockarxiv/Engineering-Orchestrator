import { pathToFileURL } from "node:url";
import type { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";

/**
 * Loading the Claude Agent SDK from where EO put it (A-08).
 *
 * The import above is `import type` and is erased at compile time — the
 * package is a devDependency now, present for its types and absent from
 * everything EO distributes. The runtime import is by absolute path,
 * because a bare specifier would resolve against the app's own
 * `node_modules`, which is exactly where the package must not be.
 *
 * This is the one import site for the SDK (ARCHITECTURE.md, "One interface, two backends"), and the
 * reason it is worth a file of its own: `import()` of a path that came
 * from a download is the sharpest edge in the application, so it happens
 * once, somewhere it can be read.
 */
export interface ClaudeSdkModule {
  query: typeof query;
  tool: typeof tool;
  createSdkMcpServer: typeof createSdkMcpServer;
}

/**
 * Thrown, not returned: every caller is inside an async generator that
 * already reports failures as agent errors.
 *
 * The message names the **Claude Agent SDK** row specifically, because
 * the Agents screen shows two and this is only ever about the second.
 * It used to say "choose the Claude backend, and download it", which
 * describes the row above — someone following it installs the 275 MB
 * CLI they already had and arrives back here unchanged. Found by a real
 * run that did exactly that.
 */
export class ClaudeSdkMissing extends Error {
  constructor() {
    super(
      "The Claude Agent SDK is not installed. EO does not ship it — it is Anthropic's software, fetched on request. " +
        "Open Agents, pick an agent using the Claude backend, and download the one labelled \"Claude Agent SDK\". " +
        "It is a separate download from Claude Code itself, and having Claude Code is not enough.",
    );
    this.name = "ClaudeSdkMissing";
  }
}

/**
 * Cached per path, so a run does not re-import a megabyte of JavaScript
 * on every dispatch — and so installing a new version is picked up
 * without a restart, because a new path is a new entry.
 */
const loaded = new Map<string, Promise<ClaudeSdkModule>>();

export function loadClaudeSdk(entryPath: string | null): Promise<ClaudeSdkModule> {
  if (!entryPath) return Promise.reject(new ClaudeSdkMissing());

  const existing = loaded.get(entryPath);
  if (existing) return existing;

  // pathToFileURL, not a raw path: on Windows `import("C:\...")` is
  // read as a specifier with a scheme and fails.
  const pending = import(pathToFileURL(entryPath).href).then((module: unknown) => module as ClaudeSdkModule);
  // A failed import must not be remembered as the answer — the usual
  // cause is a download that has since been retried.
  pending.catch(() => loaded.delete(entryPath));
  loaded.set(entryPath, pending);
  return pending;
}
