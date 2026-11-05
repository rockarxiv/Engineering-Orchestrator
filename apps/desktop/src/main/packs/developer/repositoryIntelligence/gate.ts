import {
  DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER,
  type RepositoryIntelligenceConfig,
  type RepositoryIntelligenceConfigPatch,
} from "@eo/core";
import type { Db } from "../../../db/client.js";
import { getSetting, setSetting } from "../../../db/repos/index.js";

/**
 * Whether EO builds and serves repository intelligence at all, and which
 * implementation does it (EO-148).
 *
 * Shaped after `mcpHost/gate.ts`, down to the reason it exists as its
 * own module: own keys, own read and write, own channels, own settings
 * section. It is deliberately *not* part of `settings:get`/`settings:set`
 * — that channel carries a closed object of preferences shared with the
 * inbox's Do Not Disturb toggle, and a screen should only be able to
 * change the setting it is showing. Putting a rollout switch in there
 * means the inbox refetches when somebody turns this on, and vice versa.
 *
 * **Read at call time, never cached at startup.** Every caller calls
 * `readRepositoryIntelligenceConfig` where it needs an answer, the way
 * `mcpHost/gate.ts` re-reads its own switch on every tool call and the
 * way `createEngine` passes `limits` and `guards` as functions. Flipping
 * this must take effect on the next dispatch rather than the next
 * launch: a person turning it off because it is spawning something they
 * do not want should not have to quit the app to be believed.
 *
 * This module holds nothing from any implementation. It stores an
 * opaque id and hands it on; what that id resolves to is somebody
 * else's business, and `architecturalInvariants.test.ts` beside this
 * file is what keeps it that way.
 */

/**
 * Two keys rather than one object.
 *
 * `app_settings` is a key/value table and both spellings work, but two
 * keys mean a write of one field cannot lose the other under a
 * last-writer-wins update, which is the same failure `settings:set`
 * takes a partial payload to avoid. It also makes the defaults merge
 * below per-field, so a database written before `provider` existed
 * reads back with a provider rather than with `undefined`.
 */
export const REPOSITORY_INTELLIGENCE_ENABLED_KEY = "repositoryIntelligence.enabled";
export const REPOSITORY_INTELLIGENCE_PROVIDER_KEY = "repositoryIntelligence.provider";

/**
 * Off, and pointed at the only implementation there is.
 *
 * Off is the whole rollout decision (EO-141): with this false, dispatch
 * is what it was before any of this shipped — no binary fetched, no
 * index built, no server injected, no extra process, no new run events.
 */
export const DEFAULT_REPOSITORY_INTELLIGENCE_CONFIG: RepositoryIntelligenceConfig = {
  enabled: false,
  provider: DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER,
};

/**
 * The configuration as it stands right now.
 *
 * Merged against the defaults rather than returned raw, for the reason
 * `readGuards` gives: a configuration saved before a field existed must
 * not leave that field undefined. Here that is per key — a row written
 * by a build that only knew about `enabled` reads back with the default
 * provider, and a caller never has to ask whether a field is really
 * there.
 */
export function readRepositoryIntelligenceConfig(db: Db): RepositoryIntelligenceConfig {
  return {
    enabled: getSetting<boolean>(db, REPOSITORY_INTELLIGENCE_ENABLED_KEY, DEFAULT_REPOSITORY_INTELLIGENCE_CONFIG.enabled),
    provider: getSetting<string>(db, REPOSITORY_INTELLIGENCE_PROVIDER_KEY, DEFAULT_REPOSITORY_INTELLIGENCE_CONFIG.provider),
  };
}

/**
 * Writes what was asked for, and answers with the whole configuration.
 *
 * A patch, so the screen showing the switch cannot reset the provider
 * on its way past. Answering with the merged result rather than the
 * patch means the caller's next render is the stored truth rather than
 * its own optimistic guess.
 *
 * There is no change listener here, unlike `mcpHost/gate.ts`. Nothing
 * needs telling: that module has a long-lived HTTP server whose
 * existence depends on the setting, and this one has readers who look
 * it up on every dispatch. A subscription would be a second way to
 * learn something already true.
 */
export function writeRepositoryIntelligenceConfig(db: Db, patch: RepositoryIntelligenceConfigPatch): RepositoryIntelligenceConfig {
  if (patch.enabled !== undefined) setSetting(db, REPOSITORY_INTELLIGENCE_ENABLED_KEY, patch.enabled);
  if (patch.provider !== undefined) setSetting(db, REPOSITORY_INTELLIGENCE_PROVIDER_KEY, patch.provider);

  return readRepositoryIntelligenceConfig(db);
}

/**
 * The configuration as one string, for `providerCacheKey`.
 *
 * That key is what makes a configuration change reach an agent: it
 * hashes everything that changes what an agent can *do*, and a cached
 * provider outlives any number of settings writes. Repository
 * intelligence changes what an agent can do — a dispatch under it is
 * handed a query server it is otherwise not — so a key blind to it
 * would keep handing out the old capability and the switch would appear
 * not to work until the app was restarted.
 *
 * Both fields, always, including the provider while the feature is off.
 * Rebuilding a provider nobody asked to change costs one object; the
 * alternative is a rule about when a field counts, and a rule like that
 * is where the bug goes next time.
 */
export function repositoryIntelligenceFingerprint(config: RepositoryIntelligenceConfig): string {
  return `${config.enabled ? "on" : "off"}/${config.provider}`;
}
