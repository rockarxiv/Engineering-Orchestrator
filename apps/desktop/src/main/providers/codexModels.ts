import type { ProviderModel } from "@eo/core";
import { AppServerConnection, AppServerExitedError, AppServerRequestError } from "./codexAppServer.js";

interface CodexModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  description?: unknown;
  hidden?: unknown;
  supportedReasoningEfforts?: unknown;
  isDefault?: unknown;
}

type ModelReader = (executablePath: string, signal?: AbortSignal) => Promise<CodexModel[]>;

/** Ask the exact managed/configured CLI EO will run, then adapt its catalog to the shared UI shape. */
export async function fetchCodexModels(
  executablePath: string | null,
  readModels: ModelReader = readModelsFromAppServer,
  /** Ends the exchange and the app-server it spawned (EO-477): a side call stopped meanwhile leaves nothing running. */
  signal?: AbortSignal,
): Promise<{ ok: true; models: ProviderModel[] } | { ok: false; reason: string }> {
  if (!executablePath) return { ok: false, reason: "The Codex CLI is not installed. You can still type a model name." };

  try {
    const models = (await readModels(executablePath, signal)).filter((model) => model.hidden !== true).map(toProviderModel).filter(isPresent);
    if (models.length === 0) {
      return { ok: false, reason: "Codex returned no models. You may not be signed in on this machine. You can still type a model name." };
    }
    return { ok: true, models };
  } catch (error) {
    return {
      ok: false,
      reason: `Could not ask Codex which models are available: ${error instanceof Error ? error.message : String(error)}. You can still type a model name.`,
    };
  }
}

function toProviderModel(model: CodexModel): ProviderModel | null {
  const value = typeof model.model === "string" && model.model ? model.model : typeof model.id === "string" ? model.id : "";
  if (!value) return null;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const effort = (entry as { reasoningEffort?: unknown }).reasoningEffort;
        return typeof effort === "string" && effort ? [effort] : [];
      })
    : [];
  const description = typeof model.description === "string" && model.description ? model.description : undefined;
  return {
    value,
    label: typeof model.displayName === "string" && model.displayName ? model.displayName : value,
    ...(description ? { description } : {}),
    supportsEffort: efforts.length > 0,
    effortLevels: efforts,
    ...(model.isDefault === true ? { isDefault: true } : {}),
  };
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * One paginated `model/list` exchange with the CLI's app-server.
 *
 * Over the same connection every Codex turn runs on (`codexAppServer.ts`,
 * EO-372), which is where the spawn — and its `windowsHide`, which this
 * exchange was the first to need (EO-204) — now lives.
 */
async function readModelsFromAppServer(executablePath: string, signal?: AbortSignal): Promise<CodexModel[]> {
  if (signal?.aborted) throw new Error("model discovery was cancelled");
  const connection = new AppServerConnection({ executablePath });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("model discovery timed out")), 15_000);
    // Closed in `finally`, which is what stops the process.
    onAbort = () => reject(new Error("model discovery was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([listAllModels(connection), timeout]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    connection.close();
  }
}

async function listAllModels(connection: AppServerConnection): Promise<CodexModel[]> {
  const models: CodexModel[] = [];
  try {
    await connection.initialize();
    let cursor: string | null = null;
    for (;;) {
      const result = (await connection.request("model/list", { cursor, includeHidden: false })) as { data?: unknown; nextCursor?: unknown } | undefined;
      if (!result || !Array.isArray(result.data)) throw new Error("model/list returned an invalid response");
      models.push(...(result.data as CodexModel[]));
      if (typeof result.nextCursor === "string" && result.nextCursor) cursor = result.nextCursor;
      else return models;
    }
  } catch (error) {
    // Said the way this exchange always said it: the server's own words
    // for a refused request, and what the process wrote for one that died.
    if (error instanceof AppServerRequestError) throw new Error(error.message, { cause: error });
    if (error instanceof AppServerExitedError) {
      const { stderr, signal, code } = error.exit;
      throw new Error(stderr.trim() || `app-server exited before replying (${signal ?? code ?? "unknown"})`, { cause: error });
    }
    throw error;
  }
}
