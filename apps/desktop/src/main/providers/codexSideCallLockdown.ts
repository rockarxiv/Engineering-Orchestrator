import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Switching off a Codex side call's tools and skills (EO-477).
 *
 * Codex has no single "no tools" switch. A read-only sandbox and web
 * search off still leave a turn able to read any file the person can, so
 * this is the whole of what EO found it takes, **measured rather than
 * read off a type**: the CLI pinned at the time (0.163.0) was pointed at a local
 * capture server as its model provider (`model_provider` with a
 * `base_url` of 127.0.0.1, no credit spent) and the tools and prompt in
 * the request it sent were read back. `codexSideCall.live.test.ts`
 * (`EO_LIVE_CODEX=1`) repeats the measurement through EO's own client
 * and the app-server, and is what to run when the CLI is bumped.
 *
 * Under a bare home, `gpt-6-luna` was offered: `exec` (a JavaScript
 * isolate whose `tools` object carries `exec_command`, `apply_patch` and
 * the MCP resource readers), `wait`, `request_user_input`,
 * `request_user_input_async`, `clock.sleep` and six multi-agent tools
 * (`spawn_agent` and its kin) — and a skills catalogue listing the
 * person's own `~/.agents/skills` beside Codex's bundled ones, under a
 * redirected `CODEX_HOME`.
 *
 * - **The shell** went with `features.shell_tool` and
 *   `features.unified_exec` off (`exec_command` left `exec`'s tools).
 * - **`clock.sleep`** went with `features.sleep_tool` off.
 * - **`exec`, `wait`, the multi-agent tools and `apply_patch` ignore
 *   every feature flag**: they come from the model's catalogue entry —
 *   `tool_mode: "code_mode_only"`, `multi_agent_version: "v2"`,
 *   `apply_patch_tool_type: "freeform"`. They went when Codex was handed
 *   a catalogue (`model_catalog_json`) holding that one model's entry
 *   with those three keys removed and `experimental_supported_tools`
 *   emptied. That entry is copied from the catalogue Codex itself
 *   cached (`models_cache.json`), so everything else about the model —
 *   its context window, its reasoning levels — is what Codex would have
 *   used.
 * - **The person's skills** went with `skills.include_instructions` off;
 *   `skills.bundled.enabled` off is the documented switch for Codex's
 *   own, and is set too.
 *
 * What was left, through EO's own client and the app-server, was
 * `request_user_input` alone. It says of itself "only available in Plan
 * mode", which a side call never is, and EO's client refuses every
 * request the app-server makes of it (`refuseServerRequest`), so a call
 * to it comes back as an error and reaches nothing. No flag accepted by
 * `--strict-config` removed it.
 *
 * The other switches below were each accepted by `--strict-config`
 * (which refuses an unknown field) and turn off a surface a side call
 * has no use for; none of them is load-bearing for the list above, and
 * they are here so that a CLI that starts honouring one cannot hand a
 * side call that surface.
 *
 * Re-measured at 0.165.0 (EO-599): `codexSideCall.live.test.ts` passed,
 * so the request still offers `request_user_input` alone, and the 29
 * overrides a side call is launched with were replayed under
 * `--strict-config` and accepted, as they are by 0.163.0.
 *
 * Re-measured at 0.166.0 (EO-644): `codexSideCall.live.test.ts` passed
 * again, and the 21 overrides a side call is now launched with besides
 * its catalogue path (which the live test exercises) were replayed under `--strict-config` beside 0.165.0 and accepted by both,
 * while an invented feature name was refused by both.
 */
/*
 * All of this assumes the launch is in a Codex home of the side calls'
 * own. In the person's home their `config.toml` applies — its MCP
 * servers start whatever these overrides say — so the adapter refuses a
 * side call that has no home of its own rather than inheriting theirs
 * (`codex.ts`, `sideCallCodexHome`), and the live test holds it.
 */
export const CODEX_SIDE_CALL_SWITCHES = {
  features: {
    shell_tool: false,
    unified_exec: false,
    sleep_tool: false,
    code_mode_host: false,
    multi_agent: false,
    view_image: false,
    image_generation: false,
    apps: false,
    plugins: false,
    skill_search: false,
    goals: false,
    browser_use: false,
    computer_use: false,
    in_app_browser: false,
    tool_suggest: false,
    default_mode_request_user_input: false,
  },
  skills: { include_instructions: false, bundled: { enabled: false } },
} as const;

/** The catalogue keys that hand a model tools whatever the features say. */
const TOOL_BEARING_KEYS = ["tool_mode", "multi_agent_version", "apply_patch_tool_type"] as const;

export type SideCallCatalog = { ok: true; path: string; remove: () => void } | { ok: false; problem: string };

function readCatalogEntry(cachePath: string, model: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const entry = models.find((candidate): candidate is Record<string, unknown> => typeof candidate === "object" && candidate !== null && (candidate as { slug?: unknown }).slug === model);
  return entry ?? null;
}

/**
 * Writes the one-model catalogue a side call is launched with, in a
 * directory of its own (never the empty one the call runs in).
 *
 * `caches` are the `models_cache.json` files to copy the entry from, in
 * order: the side calls' own Codex home, then the person's — Codex
 * writes one into every home it runs in, so the second is what a first
 * side call on a fresh home reads. Where no cache names the model, the
 * call is refused rather than run with the tools on: a side call that
 * could read the disk is not one EO was asked to make.
 */
export function writeSideCallCatalog(model: string | null, caches: readonly string[]): SideCallCatalog {
  if (model === null) {
    return { ok: false, problem: "A Codex side call needs a model EO can name, to switch that model's tools off, and none was named: set the small model on the Runtimes tab, or a model on the system agent for its consolidation." };
  }
  let entry: Record<string, unknown> | null = null;
  for (const cache of caches) {
    entry = readCatalogEntry(cache, model);
    if (entry) break;
  }
  if (!entry) {
    return {
      ok: false,
      problem: `Codex's model catalogue does not name ${model} on this machine, so EO cannot switch its tools off and did not make the call. Run any Codex agent once, or choose another model: the small model on the Runtimes tab, or the system agent's for its consolidation.`,
    };
  }
  const locked: Record<string, unknown> = { ...entry, experimental_supported_tools: [] };
  for (const key of TOOL_BEARING_KEYS) delete locked[key];
  const directory = mkdtempSync(join(tmpdir(), "eo-side-call-catalog-"));
  const path = join(directory, "models.json");
  writeFileSync(path, JSON.stringify({ models: [locked] }));
  return { ok: true, path, remove: () => rmSync(directory, { recursive: true, force: true }) };
}
