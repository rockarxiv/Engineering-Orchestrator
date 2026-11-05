import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { getSetting, setSetting } from "../../../db/repos/index.js";
import { openMigratedTestDb, openMigratedTestDbAt } from "../../../db/testHelpers.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../../../ipc/domainCommands.js";
import {
  DEFAULT_REPOSITORY_INTELLIGENCE_CONFIG,
  readRepositoryIntelligenceConfig,
  repositoryIntelligenceFingerprint,
  REPOSITORY_INTELLIGENCE_ENABLED_KEY,
  REPOSITORY_INTELLIGENCE_PROVIDER_KEY,
  writeRepositoryIntelligenceConfig,
} from "./gate.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("the repository intelligence configuration", () => {
  it("is off on a database that has never been asked about it", () => {
    // The rollout decision, asserted rather than assumed (EO-141):
    // nobody starts indexing their checkouts by upgrading.
    expect(readRepositoryIntelligenceConfig(handle.db)).toEqual({ enabled: false, provider: "codewiki" });
    expect(DEFAULT_REPOSITORY_INTELLIGENCE_CONFIG).toEqual({ enabled: false, provider: "codewiki" });
  });

  it("stores each field under its own key in app_settings, with no migration", () => {
    writeRepositoryIntelligenceConfig(handle.db, { enabled: true, provider: "somebody-elses" });

    expect(getSetting(handle.db, REPOSITORY_INTELLIGENCE_ENABLED_KEY, null)).toBe(true);
    expect(getSetting(handle.db, REPOSITORY_INTELLIGENCE_PROVIDER_KEY, null)).toBe("somebody-elses");
  });

  it("writes only the keys it was given", () => {
    // A screen showing the switch must not reset the provider on its way
    // past — the same property `settings:set` takes a partial payload for.
    writeRepositoryIntelligenceConfig(handle.db, { provider: "somebody-elses" });
    writeRepositoryIntelligenceConfig(handle.db, { enabled: true });

    expect(readRepositoryIntelligenceConfig(handle.db)).toEqual({ enabled: true, provider: "somebody-elses" });
  });

  it("answers with the whole configuration rather than the patch it was handed", () => {
    expect(writeRepositoryIntelligenceConfig(handle.db, { enabled: true })).toEqual({ enabled: true, provider: "codewiki" });
  });

  it("fills in a field a database written before it existed has never heard of", () => {
    // The defaults merge, and the reason for it: a configuration saved
    // by a build that only knew about `enabled` must not read back with
    // an undefined provider that every caller then has to defend
    // against. Written through `setSetting` rather than the gate,
    // because that is what such a database actually holds.
    setSetting(handle.db, REPOSITORY_INTELLIGENCE_ENABLED_KEY, true);

    const config = readRepositoryIntelligenceConfig(handle.db);

    expect(config).toEqual({ enabled: true, provider: "codewiki" });
    expect(config.provider).toBeDefined();
  });

  it("survives the application being closed and reopened", () => {
    // `:memory:` cannot answer this one — the bytes have to be on disk.
    const directory = mkdtempSync(join(tmpdir(), "eo repository intelligence "));
    const path = join(directory, "eo.db");
    try {
      const first = openMigratedTestDbAt(path);
      writeRepositoryIntelligenceConfig(first.db, { enabled: true, provider: "somebody-elses" });
      first.close();

      const second = openMigratedTestDbAt(path);
      expect(readRepositoryIntelligenceConfig(second.db)).toEqual({ enabled: true, provider: "somebody-elses" });
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is read when it is asked for, not when the process started", () => {
    // The third layer of `mcpHost/gate.ts`'s gate, and the reason
    // `createEngine` passes `limits` and `guards` as functions. A reader
    // that held the first answer would need a restart to believe the
    // second.
    expect(readRepositoryIntelligenceConfig(handle.db).enabled).toBe(false);

    writeRepositoryIntelligenceConfig(handle.db, { enabled: true });

    expect(readRepositoryIntelligenceConfig(handle.db).enabled).toBe(true);
  });
});

describe("what the fingerprint puts in providerCacheKey", () => {
  it("moves when either field does", () => {
    const off = repositoryIntelligenceFingerprint({ enabled: false, provider: "codewiki" });

    expect(repositoryIntelligenceFingerprint({ enabled: true, provider: "codewiki" })).not.toBe(off);
    expect(repositoryIntelligenceFingerprint({ enabled: false, provider: "somebody-elses" })).not.toBe(off);
    expect(repositoryIntelligenceFingerprint({ enabled: false, provider: "codewiki" })).toBe(off);
  });
});

describe("the preferences channel", () => {
  it("does not carry this setting, in either direction", async () => {
    // The whole reason this gate exists as its own module (EO-148).
    // `settings:get` is a closed object of preferences shared with the
    // inbox's Do Not Disturb toggle: a rollout switch in there means the
    // inbox refetches when somebody turns an indexer on, and a screen
    // that shows one setting can silently rewrite another.
    const before = await readSettings(handle.db);
    expect(before).not.toHaveProperty("repositoryIntelligence");
    expect(before).not.toHaveProperty("enabled");

    writeRepositoryIntelligenceConfig(handle.db, { enabled: true, provider: "somebody-elses" });
    expect(await readSettings(handle.db)).toEqual(before);

    // And the other way: the preferences a person edits on another
    // screen leave this one exactly where it was.
    await writeSettings(handle.db, { doNotDisturb: true });
    expect(readRepositoryIntelligenceConfig(handle.db)).toEqual({ enabled: true, provider: "somebody-elses" });
  });
});
