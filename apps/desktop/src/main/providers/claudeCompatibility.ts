/**
 * What EO hands the Claude CLI so its agents behave as they did on the
 * pins before this one (EO-599, EO-644).
 *
 * claude@0.3.312 (Claude Code 2.1.312) changed defaults that claude@0.3.302
 * (2.1.302) decided differently, each in a configuration EO's agents can be
 * dispatched in — behind a person's gateway, or on Bedrock, Vertex,
 * Foundry or Mantle. claude@0.3.318 (2.1.318), the pin now, keeps those
 * four switches as 2.1.312 read them, and adds one more change EO's own
 * default setup meets: a built-in plugin that refuses an unattended agent
 * some calls holding the person's account email (`privacyPluginHeldOff`).
 * A pin bump is not a decision to adopt them, so each
 * that can be kept exactly is held here to the old answer, in exactly the
 * case the old CLI gave it and nowhere else, and never over a choice the
 * person made themselves. One that cannot be kept exactly is left to the
 * pinned CLI whole rather than held in part (the Monitor note below).
 * Every rule below was read off both binaries and measured against them with
 * a capture server; what each measurement showed is recorded beside it.
 *
 * **Decided on what the CLI will actually see.** That is EO's spawn
 * environment with the `env` block of every settings file the turn loads
 * laid over it — measured at both pins with a capture server, a base URL
 * set only in a settings file is honoured, and a settings file's value
 * wins over the spawn environment's. In the CLI's order, later winning:
 *
 *   1. the legacy global config, `$CLAUDE_CONFIG_DIR/.claude.json` or
 *      `~/.claude.json` — read even when only `project` is a setting
 *      source, so for a locked-down agent too, and taken to be read for a
 *      side call, which loads no source at all;
 *   2. user settings, `$CLAUDE_CONFIG_DIR/settings.json` or
 *      `~/.claude/settings.json` — only when the agent uses the person's
 *      own setup (`settingSources` left unset loads user, project, local);
 *   3. project settings, `<cwd>/.claude/settings.json`;
 *   4. local settings, `<cwd>/.claude/settings.local.json` — own setup only;
 *   5. managed settings, `managed-settings.json` then
 *      `managed-settings.d/*.json` in the platform's managed directory.
 *      Read off the binary rather than measured: writing one needs root,
 *      and the CLI ignored `CLAUDE_CODE_MANAGED_SETTINGS_PATH` at both pins.
 *
 * Settings an organisation serves remotely, and MDM or registry policy,
 * are not files EO can read; a value only they set is not seen here.
 *
 * Every switch the CLI reads with a plain truthiness check is "set" when it
 * is non-empty, `"0"` included — measured: `CLAUDE_CODE_USE_VERTEX=0` still
 * puts the CLI on Vertex, and `DISABLE_TELEMETRY=0` still turns telemetry
 * off.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type ClaudeEnvironment = Readonly<Record<string, string | undefined>>;

/** Which of the person's and the repository's settings files a turn loads. */
export type ClaudeSettingSources = "none" | "project" | "all";

/** Where a value came from, in the CLI's order, later winning. */
export type ClaudeSettingsSource = "globalConfig" | "userSettings" | "projectSettings" | "localSettings" | "policySettings";

export interface ClaudeSettingsLayer {
  source: ClaudeSettingsSource;
  path: string;
  /** The file's `env` block, string values only. */
  env: Record<string, string>;
  /** The file's `model`, when it names one. */
  model: string | null;
  /** The plugin ids its `enabledPlugins` names, whatever it says of each. */
  plugins: string[];
}

export interface ClaudeSettingsReader {
  /** The file's text, or null when there is none to read. */
  readText(path: string): string | null;
  /** The entries of a directory, or none when it cannot be read. */
  listDir(path: string): string[];
}

const DISK: ClaudeSettingsReader = {
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  listDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function layerFrom(source: ClaudeSettingsSource, path: string, reader: ClaudeSettingsReader): ClaudeSettingsLayer | null {
  const text = reader.readText(path);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A file the CLI cannot parse is one it skips; so does this.
    return null;
  }
  if (!isRecord(parsed)) return null;
  const env: Record<string, string> = {};
  if (isRecord(parsed["env"])) {
    for (const [key, value] of Object.entries(parsed["env"])) if (typeof value === "string") env[key] = value;
  }
  const model = typeof parsed["model"] === "string" && parsed["model"].trim() !== "" ? parsed["model"].trim() : null;
  const plugins = isRecord(parsed["enabledPlugins"]) ? Object.keys(parsed["enabledPlugins"]) : [];
  return { source, path, env, model, plugins };
}

/** The directory the CLI reads managed settings from, by platform (from the binary). */
export function claudeManagedSettingsDirectory(platform: NodeJS.Platform): string | null {
  if (platform === "linux") return "/etc/claude-code";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return null;
}

/**
 * The settings files a turn loads, in the CLI's order — see the head of
 * this file for where each lives and what was measured about it.
 */
export function claudeSettingsLayers(options: {
  cwd: string;
  /** The environment the CLI is spawned with: where `HOME` and `CLAUDE_CONFIG_DIR` come from. */
  env: ClaudeEnvironment;
  /**
   * The setting sources the turn loads: none (a side call), the project's
   * (a locked-down agent), or all of user, project and local (an agent on
   * the person's own setup, whose `settingSources` is left unset).
   */
  sources: ClaudeSettingSources;
  platform?: NodeJS.Platform;
  reader?: ClaudeSettingsReader;
}): ClaudeSettingsLayer[] {
  const all = options.sources === "all";
  const reader = options.reader ?? DISK;
  const platform = options.platform ?? process.platform;
  // Joined the way `platform` joins paths, as the managed directory is
  // chosen by it, so that naming a platform names its paths too.
  const { join } = platform === "win32" ? win32 : posix;
  const home = options.env["HOME"] || homedir();
  const configDir = options.env["CLAUDE_CONFIG_DIR"] || null;
  const layers: (ClaudeSettingsLayer | null)[] = [
    layerFrom("globalConfig", configDir ? join(configDir, ".claude.json") : join(home, ".claude.json"), reader),
    all ? layerFrom("userSettings", join(configDir ?? join(home, ".claude"), "settings.json"), reader) : null,
    options.sources !== "none" ? layerFrom("projectSettings", join(options.cwd, ".claude", "settings.json"), reader) : null,
    all ? layerFrom("localSettings", join(options.cwd, ".claude", "settings.local.json"), reader) : null,
  ];
  const managed = claudeManagedSettingsDirectory(platform);
  if (managed) {
    layers.push(layerFrom("policySettings", join(managed, "managed-settings.json"), reader));
    const dropIns = join(managed, "managed-settings.d");
    for (const name of [...reader.listDir(dropIns)].filter((entry) => entry.endsWith(".json")).sort()) {
      layers.push(layerFrom("policySettings", join(dropIns, name), reader));
    }
  }
  return layers.filter((layer): layer is ClaudeSettingsLayer => layer !== null);
}

/** The spawn environment with every layer's `env` laid over it, as the CLI applies them. */
export function effectiveClaudeEnvironment(spawnEnv: ClaudeEnvironment, layers: readonly ClaudeSettingsLayer[]): Record<string, string | undefined> {
  const effective: Record<string, string | undefined> = { ...spawnEnv };
  for (const layer of layers) Object.assign(effective, layer.env);
  return effective;
}

/**
 * The model the CLI will run, as far as EO can tell: what EO names on
 * the command line, then `ANTHROPIC_MODEL`, then the highest settings
 * file naming one. Null when the CLI picks its own default — which is a
 * model it knows, at either pin.
 */
export function effectiveClaudeModel(explicit: string | null | undefined, effective: ClaudeEnvironment, layers: readonly ClaudeSettingsLayer[]): string | null {
  const named = explicit || effective["ANTHROPIC_MODEL"] || [...layers].reverse().find((layer) => layer.model !== null)?.model || null;
  if (!named) return null;
  // An alias is resolved through the person's own pins for it, as the CLI resolves it.
  const alias = named.replace(/\[1m\]$/i, "").toLowerCase();
  const pinned: Record<string, string | undefined> = {
    opus: effective["ANTHROPIC_DEFAULT_OPUS_MODEL"],
    sonnet: effective["ANTHROPIC_DEFAULT_SONNET_MODEL"],
    haiku: effective["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
  };
  return pinned[alias] || named;
}

/** Set, by the CLI's reading of most switches: any non-empty value. */
function set(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

export type ClaudeProvider = "firstParty" | "bedrock" | "foundry" | "anthropicAws" | "anthropicGoogleCloud" | "mantle" | "vertex";

/**
 * The provider, as both pins decide it, in the same order. The CLI's
 * gateway sign-in (an account setting, not a variable) is not visible here.
 */
export function claudeProvider(env: ClaudeEnvironment): ClaudeProvider {
  if (set(env["CLAUDE_CODE_USE_BEDROCK"])) return "bedrock";
  if (set(env["CLAUDE_CODE_USE_FOUNDRY"])) return "foundry";
  if (set(env["CLAUDE_CODE_USE_ANTHROPIC_AWS"])) return "anthropicAws";
  if (set(env["CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD"])) return "anthropicGoogleCloud";
  if (set(env["CLAUDE_CODE_USE_MANTLE"])) return "mantle";
  if (set(env["CLAUDE_CODE_USE_VERTEX"])) return "vertex";
  return "firstParty";
}

/** The four the 2.1.311 and 2.1.312 notes name: Bedrock, Foundry, Mantle and Vertex. */
function isCloudPlatform(provider: ClaudeProvider): boolean {
  return provider === "bedrock" || provider === "foundry" || provider === "mantle" || provider === "vertex";
}

/**
 * A model name no spelling of a Claude model matches — a custom
 * deployment, say. Both changes below are about names the CLI does not
 * recognise; EO cannot read the CLI's model registry, so it holds only
 * for names that cannot be in it: none of `claude-`, `sonnet`, `haiku`,
 * `opus`, `fable` or `mythos`, and not an application inference profile
 * ARN, which the old CLI resolved to whatever model it fronts — a lookup
 * EO cannot make, and whose old answer depended on the model behind it.
 */
export function isCustomModelName(model: string | null): boolean {
  if (model === null) return false;
  const name = model.toLowerCase();
  if (name.includes("application-inference-profile")) return false;
  return !/claude-|sonnet|haiku|opus|fable|mythos/.test(name);
}

/**
 * Tool search off behind a person's own gateway, as before Claude Code
 * 2.1.304 turned it on there.
 *
 * Up to 2.1.302 the CLI decided this itself: with `ENABLE_TOOL_SEARCH`
 * unset and on Anthropic's own provider, an `ANTHROPIC_BASE_URL` whose
 * host is not `api.anthropic.com` switched tool search off
 * ("[ToolSearch:optimistic] disabled: ANTHROPIC_BASE_URL=… is not a
 * first-party Anthropic host"), unless `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`
 * said the host was one. 2.1.312 has no such branch: the mode is
 * `ENABLE_TOOL_SEARCH` when it is set and on when it is not. Measured with
 * a capture server and the variable unset, 2.1.302 put an attached
 * server's tools in the prompt and 2.1.312 put them behind `ToolSearch` —
 * whether the base URL came from the spawn environment or only from a
 * settings file (project, user, local or the legacy global config). EO's
 * own servers are `alwaysLoad` either way.
 */
export function toolSearchHeldOff(env: ClaudeEnvironment): boolean {
  if (set(env["ENABLE_TOOL_SEARCH"])) return false;
  if (set(env["_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"])) return false;
  if (claudeProvider(env) !== "firstParty" || set(env["CLAUDE_CODE_USE_GATEWAY"])) return false;
  const baseUrl = env["ANTHROPIC_BASE_URL"];
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host !== "api.anthropic.com";
  } catch {
    // The old CLI read a base URL it could not parse as not first-party.
    return true;
  }
}

/*
 * Not held: the Monitor tool (2.1.310 "Added the Monitor tool and plugin
 * monitors on Bedrock, Vertex, and Foundry, and when telemetry or
 * nonessential traffic is disabled"). A scope decision on EO-599, not an
 * oversight.
 *
 * At 2.1.302 the tool, the Bash tool's refusal of a foreground `sleep` of
 * 25 s or more, the Monitor guidance in the Bash and Cron prompts and
 * plugin monitors were all gated on one GrowthBook flag
 * (`tengu_amber_sentinel`), which read as off wherever GrowthBook was not
 * consulted: nonessential traffic or telemetry off, `DO_NOT_TRACK`,
 * `DISABLE_GROWTHBOOK`, a cloud provider, a custom OAuth URL. 2.1.312
 * turns all four on there, and has no switch that takes back the sleep
 * refusal, the guidance or plugin monitors short of
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, which would also remove
 * `run_in_background`. Withholding only the tool was measured to leave an
 * agent refused a long `sleep` and pointed at a tool it did not have.
 *
 * So EO leaves the whole of it to 2.1.312, as one consistent behaviour:
 * where 2.1.302's answer cannot be kept exactly, an EO agent behaves as
 * the pinned CLI does. It reaches only setups where the person turned one
 * of those switches on themselves; EO sets none of them.
 */

/**
 * The full prompt for a custom deployment on a cloud platform, as before
 * 2.1.312 ("Changed Bedrock, Vertex, Foundry and Mantle to use the shorter
 * system prompt for model names Claude Code doesn't recognize … set
 * `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` to keep the full prompt").
 *
 * 2.1.302 counted a name it did not know as recognised on those four
 * (`he(e)`: `return !pu()`), and 2.1.312 does not. EO replaces the
 * preset prompt with its own instructions, but the switch still decides
 * the tool descriptions: measured on Vertex with a deployment named
 * `my-custom-deployment` and EO's kind of system prompt, 2.1.302 sent the
 * full descriptions, 2.1.312 the lean ones (byte for byte what
 * `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=1` sends), and 2.1.312 with the
 * switch at `0` the full ones again.
 */
export function fullPromptHeld(env: ClaudeEnvironment, model: string | null): boolean {
  return !set(env["CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT"]) && isCloudPlatform(claudeProvider(env)) && isCustomModelName(model);
}

/**
 * No automatic model switch after a flagged message for a custom model
 * name, as before 2.1.312 ("Changed automatic model switches after a
 * flagged message to also cover model names Claude Code doesn't
 * recognize … set `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` to turn them
 * off").
 *
 * Read off both binaries rather than measured end to end: 2.1.302's
 * fallback target returned none for a name with no model configuration
 * (`if(!n&&!z1e(r)&&…)return`), and 2.1.312 returns none there only for a
 * name it recognises (`…&&(xX()||NB(n))&&…`). No capture-server refusal
 * armed a fallback at either pin, for a known model or a custom one, so
 * the switch itself is the measurement: it is the gate both pins read
 * before any of that (`!CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK&&…`).
 *
 * The switch is for the session, not the model, so a subagent on a model
 * the CLI knows loses its fallback too. That is the price of the only
 * switch there is.
 */
export function refusalFallbackHeldOff(env: ClaudeEnvironment, model: string | null): boolean {
  return !set(env["CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK"]) && isCustomModelName(model);
}

/**
 * No downloaded model catalogue on a cloud platform, as before 2.1.311
 * ("Changed Claude Code on Bedrock, Mantle, Vertex, and Foundry to load
 * model settings from a signed file on downloads.claude.ai; set
 * CLAUDE_CODE_MODEL_CATALOG=off to turn this off").
 *
 * Measured with the CLI's own debug log on Vertex and Foundry (Bedrock
 * the same, until its stream format stopped the turn): 2.1.312 builds a
 * published catalogue ("[publishedCatalog] primary: using seed rows …")
 * that 2.1.302 has no step for at all; with the switch at `off` it is
 * gone again ("[servedCatalog] off (env_off)").
 */
export function modelCatalogHeldOff(env: ClaudeEnvironment): boolean {
  return !set(env["CLAUDE_CODE_MODEL_CATALOG"]) && isCloudPlatform(claudeProvider(env));
}

/** The built-in plugin 2.1.317 added, by the id `enabledPlugins` names it with. */
export const CLAUDE_PRIVACY_PLUGIN = "cc-plugin-privacy@builtin";

/**
 * The account-email check off, as before 2.1.317 ("Added a check that
 * asks before a web or shell tool call sends your account email address
 * to the network").
 *
 * It is a built-in plugin, `cc-plugin-privacy`, on by default: a
 * `tool.check` hook on Bash, PowerShell, Monitor, Tmux, WebFetch,
 * WebSearch and WebBrowser that answers `ask` when a call's input holds the
 * signed-in account's email — and, for a shell, also a network word
 * (`curl`, `ssh`, `http`, `scp`, …). The email is the stored claude.ai
 * login's, so a session on an API key alone is never asked. An unattended
 * agent has nobody to ask, and the ask is a refusal. Measured with a
 * capture server, a stand-in claude.ai token and the CLI in
 * `bypassPermissions`, the mode every EO turn runs in: `echo curl
 * <the account's email>` ran at 2.1.312 and was refused at 2.1.318 ("Permission
 * to use Bash denied by plugin cc-plugin-privacy: …"), under `project`
 * setting sources too; with `{"enabledPlugins":{"cc-plugin-privacy@builtin":false}}`
 * passed as `--settings` it ran again, exactly as at 2.1.312, which had no
 * such plugin.
 *
 * The CLI reads this plugin's switch only from trusted settings — user,
 * `--settings` (flag) and managed, later winning — and never from project
 * or local settings. So the person's own choice is one their user settings
 * (when the turn loads them) or managed settings make, under any spelling
 * of the id; EO's flag would win over the first, so it is not sent then.
 */
export function privacyPluginHeldOff(layers: readonly ClaudeSettingsLayer[]): boolean {
  return !layers.some(
    (layer) => (layer.source === "userSettings" || layer.source === "policySettings") && layer.plugins.some((id) => id.toLowerCase().startsWith("cc-plugin-privacy@")),
  );
}

export interface ClaudeCompatibilityHolds {
  /** Variables to add to the spawn environment. Never one a settings file defines. */
  env: Record<string, string>;
  /** Settings to hand the CLI as `--settings` (the SDK's `settings`); empty when none is held. */
  settings: { enabledPlugins?: Record<string, boolean> };
}

/**
 * Every hold a turn needs, decided on the environment and model the CLI
 * will see. A variable already non-empty anywhere is the person's answer,
 * and one a settings file defines at all is that file's — the CLI lays it
 * over EO's spawn environment, empty or not — so neither is held.
 */
export function claudeCompatibilityHolds(options: {
  spawnEnv: ClaudeEnvironment;
  cwd: string;
  sources: ClaudeSettingSources;
  model?: string | null | undefined;
  platform?: NodeJS.Platform;
  reader?: ClaudeSettingsReader;
}): ClaudeCompatibilityHolds {
  const layers = claudeSettingsLayers({
    cwd: options.cwd,
    env: options.spawnEnv,
    sources: options.sources,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.reader ? { reader: options.reader } : {}),
  });
  const effective = effectiveClaudeEnvironment(options.spawnEnv, layers);
  const model = effectiveClaudeModel(options.model, effective, layers);
  // A name any settings file defines, even as empty, is that file's: the CLI
  // lays it over whatever EO spawns with, so a hold there could not take.
  const named = new Set(layers.flatMap((layer) => Object.keys(layer.env)));
  const env: Record<string, string> = {};
  const hold = (name: string, value: string, applies: boolean): void => {
    if (applies && !named.has(name)) env[name] = value;
  };
  hold("ENABLE_TOOL_SEARCH", "false", toolSearchHeldOff(effective));
  hold("CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT", "0", fullPromptHeld(effective, model));
  hold("CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", "1", refusalFallbackHeldOff(effective, model));
  hold("CLAUDE_CODE_MODEL_CATALOG", "off", modelCatalogHeldOff(effective));
  return { env, settings: privacyPluginHeldOff(layers) ? { enabledPlugins: { [CLAUDE_PRIVACY_PLUGIN]: false } } : {} };
}
