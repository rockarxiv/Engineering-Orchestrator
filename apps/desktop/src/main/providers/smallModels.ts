import { DEFAULT_CLAUDE_SMALL_MODEL, type ProviderModel, type SmallModelView } from "@eo/core";
import type { Db } from "../db/client.js";
import { clearSetting, getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { fetchCodexModels } from "./codexModels.js";
import { codexModelPrice } from "./codexPricing.js";

/**
 * Each backend's small model: what EO's side calls run on (EO-477).
 *
 * Here, among the providers, because the default is a fact about each
 * backend and spelling one out is branching on its name, which only
 * `providers/` and `runtimes/` may do (`backendBranching.test.ts`).
 */

/** The backends that have a small model. The fake has none to choose: it answers from a script. */
export const SMALL_MODEL_BACKENDS = ["claude", "codex"] as const;
export type SmallModelBackend = (typeof SMALL_MODEL_BACKENDS)[number];

export function isSmallModelBackend(backend: string): backend is SmallModelBackend {
  return (SMALL_MODEL_BACKENDS as readonly string[]).includes(backend);
}

const settingKey = (backend: SmallModelBackend): string => `sideCalls.smallModel.${backend}`;

/** What the person chose for this backend, or null for the default. */
export function chosenSmallModel(db: Db, backend: string): string | null {
  if (!isSmallModelBackend(backend)) return null;
  const value = getSetting<unknown>(db, settingKey(backend), null);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Writes the choice; null goes back to the default. */
export function chooseSmallModel(db: Db, backend: string, model: string | null): { ok: boolean; problem: string | null } {
  if (!isSmallModelBackend(backend)) return { ok: false, problem: `"${backend}" has no small model to choose: only Claude and Codex make side calls on a model of their own.` };
  if (model === null) clearSetting(db, settingKey(backend));
  else setSetting(db, settingKey(backend), model.trim());
  return { ok: true, problem: null };
}

/**
 * The smallest model the Codex runtime reports, by what it costs.
 *
 * Codex's `model/list` says nothing about size, so "smallest" is read as
 * cheapest: input and output per million at the price EO ships
 * (`codexPricing.ts`). A model EO has no price for is passed over rather
 * than guessed at, and a tie keeps the runtime's own order, which lists
 * its newest first.
 */
export function smallestCodexModel(models: readonly Pick<ProviderModel, "value">[]): string | null {
  let best: { value: string; cost: number } | null = null;
  for (const model of models) {
    const price = codexModelPrice(model.value);
    if (!price) continue;
    const cost = price.inputCentsPerMillion + price.outputCentsPerMillion;
    if (best === null || cost < best.cost) best = { value: model.value, cost };
  }
  return best?.value ?? null;
}

/** What `fetchCodexModels` answers. */
export type CodexModelList = { ok: true; models: ProviderModel[] } | { ok: false; reason: string };

/** Where the small model's default comes from, asked only when it is needed. */
export interface SmallModelSources {
  /** The models the Codex runtime reports. Spawns the CLI, so it is asked lazily and cached by the caller; `signal` stops it. */
  codexModels: (signal?: AbortSignal) => Promise<CodexModelList>;
}

/** One backend's default, and the sentence that says where it comes from. */
export async function defaultSmallModel(backend: string, sources: SmallModelSources, signal?: AbortSignal): Promise<{ model: string | null; note: string }> {
  if (backend === "claude") return { model: DEFAULT_CLAUDE_SMALL_MODEL, note: `EO's default for Claude, ${DEFAULT_CLAUDE_SMALL_MODEL}.` };
  if (backend === "codex") {
    const listed = await sources.codexModels(signal);
    if (!listed.ok) return { model: null, note: `The smallest model the Codex runtime reports, which it could not be asked: ${listed.reason}` };
    const smallest = smallestCodexModel(listed.models);
    return smallest === null
      ? { model: null, note: "The smallest model the Codex runtime reports — none of the ones it reports has a price EO knows, so Codex's own default is used." }
      : { model: smallest, note: `The smallest model the Codex runtime reports, ${smallest}.` };
  }
  return { model: null, note: "This backend has no small model of its own." };
}

/** The model a side call on this backend runs on: the person's choice, or the default. Null leaves the backend's own. */
export async function resolveSmallModel(db: Db, backend: string, sources: SmallModelSources, signal?: AbortSignal): Promise<string | null> {
  return chosenSmallModel(db, backend) ?? (await defaultSmallModel(backend, sources, signal)).model;
}

/**
 * The model a backend's agents run on when they name none (EO-578): what
 * a side call on the system agent's model runs on when that agent, and
 * its consolidation override, leave the model empty.
 *
 * Claude's CLI picks its own default when none is named, so null leaves
 * it to it. A Codex side call cannot leave it — it must name the model
 * to switch that model's tools off (`writeSideCallCatalog`) — so it is
 * the one the runtime's `model/list` marks default. Null when the
 * runtime could not be asked or marks none, and the call then says it
 * needs a model.
 */
export async function defaultAgentModel(backend: string, sources: SmallModelSources, signal?: AbortSignal): Promise<string | null> {
  if (backend !== "codex") return null;
  const listed = await sources.codexModels(signal);
  return listed.ok ? (listed.models.find((model) => model.isDefault === true)?.value ?? null) : null;
}

/**
 * The reasoning effort an agent is configured with, from the key its own
 * backend's adapter reads it under — Claude's `effort`, Codex's
 * `reasoningEffort` (EO-578). Null for none, or a backend with no effort.
 */
export function agentReasoningEffort(agent: { provider: string; config: Readonly<Record<string, unknown>> }): string | null {
  const key = agent.provider === "claude" ? "effort" : agent.provider === "codex" ? "reasoningEffort" : null;
  if (key === null) return null;
  const value = agent.config[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Both backends, as the Runtimes tab draws them. */
export async function describeSmallModels(db: Db, sources: SmallModelSources): Promise<SmallModelView[]> {
  return Promise.all(
    SMALL_MODEL_BACKENDS.map(async (backend) => {
      const fallback = await defaultSmallModel(backend, sources);
      return { backend, chosen: chosenSmallModel(db, backend), defaultModel: fallback.model, defaultNote: fallback.note };
    }),
  );
}

/**
 * The Codex model list, asked once per executable and kept for a while.
 *
 * Asking spawns the app-server, and a side call should not pay a CLI
 * start to learn a default it learned a minute ago. Only an answer is
 * kept: a failure is asked again next time, since the usual cause is a
 * runtime installed or signed in since.
 */
export function cachedCodexModels(fetch: (executablePath: string | null, signal?: AbortSignal) => Promise<CodexModelList>, ttlMs = 10 * 60_000, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; list: CodexModelList }>();
  return async (executablePath: string | null, signal?: AbortSignal): Promise<CodexModelList> => {
    const key = executablePath ?? "";
    const held = cache.get(key);
    if (held && now() - held.at < ttlMs) return held.list;
    // Each asker's own exchange, not a shared one, so its signal stops
    // only what it started.
    const list = await fetch(executablePath, signal);
    if (list.ok) cache.set(key, { at: now(), list });
    return list;
  };
}

/** One list for the process: the Runtimes tab and a side call ask the same question of the same binary. */
const sharedCodexModels = cachedCodexModels((executablePath, signal) => fetchCodexModels(executablePath, undefined, signal));

/**
 * Where a default is read from, given where each backend's CLI is — the
 * one place that knows which backend's list that is.
 */
export function smallModelSources(
  executablePathFor: (backend: string) => string | null,
  list: (executablePath: string | null, signal?: AbortSignal) => Promise<CodexModelList> = sharedCodexModels,
): SmallModelSources {
  return { codexModels: (signal) => list(executablePathFor("codex"), signal) };
}
