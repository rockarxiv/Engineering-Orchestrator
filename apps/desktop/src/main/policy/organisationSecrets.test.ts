import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearOrganisationSecret,
  forgetOrganisationSecrets,
  listOrganisationSecretNames,
  organisationSecretValues,
  readOrganisationSecret,
  readOrganisationSecretEntry,
  replaceOrganisationSecrets,
  storeOrganisationSecret,
  type OrganisationSecretsOptions,
} from "./organisationSecrets.js";

/**
 * The values behind the names an organisation publishes (EO-328, ARCHITECTURE.md, "Secrets").
 *
 * The same `safeStorage` stand-in `modules/secrets.test.ts` uses, and
 * reversing rather than prefixing for its reason: "the plaintext is not
 * in the file" has to be a claim about the code under test rather than
 * about the fake.
 */
const reverse = (text: string) => [...text].reverse().join("");
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};

let directory: string;
let options: OrganisationSecretsOptions;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo organisation secrets "));
  options = { directory, store };
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("organisation secrets", () => {
  it("round-trips a value", () => {
    expect(storeOrganisationSecret(options, "FLY_API_TOKEN", "tok-1").ok).toBe(true);
    expect(readOrganisationSecret(options, "FLY_API_TOKEN")).toBe("tok-1");
  });

  it("never writes the value in the clear", () => {
    storeOrganisationSecret(options, "FLY_API_TOKEN", "tok-1");
    expect(readFileSync(join(directory, "secret-FLY_API_TOKEN.bin"), "utf8")).not.toContain("tok-1");
  });

  it("lists names and never values", () => {
    storeOrganisationSecret(options, "B_TOKEN", "b");
    storeOrganisationSecret(options, "A_TOKEN", "a");
    expect(listOrganisationSecretNames(options)).toEqual(["A_TOKEN", "B_TOKEN"]);
  });

  it("refuses to store anything on a machine with nowhere safe to put it", () => {
    const result = storeOrganisationSecret({ directory, store: { ...store, isEncryptionAvailable: () => false } }, "TOKEN", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("nowhere safe");
  });

  it("tells an unreadable value apart from an absent one", () => {
    // The distinction the resolution depends on: an organisation value
    // that is there but cannot be decrypted must stop the fallback to a
    // personal one rather than passing it.
    storeOrganisationSecret(options, "FLY_API_TOKEN", "tok-1");
    const broken = {
      directory,
      store: {
        ...store,
        decryptString: () => {
          throw new Error("no key");
        },
      },
    };
    expect(readOrganisationSecretEntry(broken, "FLY_API_TOKEN").state).toBe("unreadable");
    expect(readOrganisationSecretEntry(options, "NOTHING_HERE").state).toBe("absent");
    // …and an unreadable one is not listed, because "set" means a run
    // would get a value.
    expect(listOrganisationSecretNames(broken)).toEqual([]);
  });

  it("clears a name", () => {
    storeOrganisationSecret(options, "FLY_API_TOKEN", "tok-1");
    clearOrganisationSecret(options, "FLY_API_TOKEN");
    expect(readOrganisationSecret(options, "FLY_API_TOKEN")).toBeNull();
  });
});

describe("replacing the whole set", () => {
  it("forgets a name the record no longer publishes", () => {
    // The case the whole shape of `replaceOrganisationSecrets` exists
    // for: an admin taking a credential away has to reach every device,
    // and a store that only ever gained names would go on injecting it.
    storeOrganisationSecret(options, "WITHDRAWN", "old");
    storeOrganisationSecret(options, "KEPT", "old");

    replaceOrganisationSecrets(options, { KEPT: "new" });

    expect(listOrganisationSecretNames(options)).toEqual(["KEPT"]);
    expect(readOrganisationSecret(options, "KEPT")).toBe("new");
    expect(readOrganisationSecret(options, "WITHDRAWN")).toBeNull();
  });

  it("removes what it should remove even when it can store nothing", () => {
    storeOrganisationSecret(options, "WITHDRAWN", "old");
    const noKeychain = { directory, store: { ...store, isEncryptionAvailable: () => false } };

    const result = replaceOrganisationSecrets(noKeychain, { ARRIVING: "new" });

    // Failing to forget a secret is a security answer; failing to gain
    // one is an inconvenience, and the caller is told which happened.
    expect(readOrganisationSecret(options, "WITHDRAWN")).toBeNull();
    expect(result).toEqual({ stored: [], refused: ["ARRIVING"] });
  });

  it("forgets every one of them when this machine leaves the organisation", () => {
    storeOrganisationSecret(options, "FLY_API_TOKEN", "tok-1");
    forgetOrganisationSecrets(options);
    expect(listOrganisationSecretNames(options)).toEqual([]);
  });
});

describe("what the record hands a device", () => {
  it("is the only place values come out in bulk, and leaves out what it cannot read", () => {
    storeOrganisationSecret(options, "FLY_API_TOKEN", "tok-1");
    storeOrganisationSecret(options, "SLACK_WEBHOOK", "hook");

    expect(organisationSecretValues(options)).toEqual({ FLY_API_TOKEN: "tok-1", SLACK_WEBHOOK: "hook" });

    const broken = {
      directory,
      store: {
        ...store,
        decryptString: () => {
          throw new Error("no key");
        },
      },
    };
    // Left out rather than sent as an empty string: a variable set to
    // nothing at all is a credential that is present and wrong.
    expect(organisationSecretValues(broken)).toEqual({});
  });
});
