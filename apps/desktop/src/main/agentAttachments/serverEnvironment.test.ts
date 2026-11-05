import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerDraftSchema, type Agent } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, saveMcpServer, setAgentAttachment } from "../db/repos/index.js";
import { archiveMcpServer, setMcpServerEnabled } from "../db/repos/mcpServersRepo.js";
import { agentRunVariables, storeVariable, type ModuleSecretsOptions } from "../modules/secrets.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import type { SecretStore } from "../secrets/store.js";
import { storeMcpServerSecret, type McpServerSecretsOptions } from "../mcp/serverSecrets.js";
import { toolDirectoryFiles } from "./pluginDirectory.js";
import { attachmentEnvironment } from "./serverEnvironment.js";
import { resolveAgentAttachments } from "../db/repos/agentAttachmentsRepo.js";

/**
 * The values behind the names a generated `.mcp.json` refers to
 * (EO-107).
 *
 * Reversing rather than prefixing, for the reason `serverSecrets.test.ts`
 * gives: "the plaintext is not in the file" has to stay a claim about the
 * code under test rather than about the fake.
 */
const reverse = (text: string) => [...text].reverse().join("");
/** Stamped so the fake can refuse what it did not write — see the "unreadable" case below. */
const SEAL = "|eo|";
const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`${SEAL}${reverse(text)}`),
  decryptString: (buffer: Buffer) => {
    const text = buffer.toString();
    // What `safeStorage` does with ciphertext from another machine or
    // from before a keychain reset: it throws. A fake that decoded
    // anything would make the third answer untestable.
    if (!text.startsWith(SEAL)) throw new Error("cannot decrypt");
    return reverse(text.slice(SEAL.length));
  },
};

const TOKEN = "ghp_liveSecretValue_0000";

let handle: DbHandle;
let directory: string;
let secrets: McpServerSecretsOptions;
let implementer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo attachment env "));
  secrets = { directory, store };
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

function attach(name: string, envNames: string[]) {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command: "gh-mcp", envNames }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: saved.server.id, attached: true });
  return saved.server;
}

describe("attachmentEnvironment", () => {
  it("answers with the value behind each declared name", () => {
    const github = attach("github", ["GITHUB_TOKEN"]);
    storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", TOKEN);

    expect(attachmentEnvironment(handle.db, implementer.id, secrets)).toEqual({
      env: { GITHUB_TOKEN: TOKEN },
      unresolved: [],
      withheld: [],
    });
  });

  it("keeps the value out of everything that is written down", () => {
    const github = attach("github", ["GITHUB_TOKEN"]);
    storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", TOKEN);

    // What reaches disk is the reference. Asserted here as well as in
    // `pluginDirectory.test.ts` because this is the test that has a real
    // stored value to look for.
    const generated = toolDirectoryFiles(resolveAgentAttachments(handle.db, implementer.id));
    expect(generated.map((file) => file.content).join("\n")).toContain("${GITHUB_TOKEN}");
    for (const file of generated) expect(file.content, file.path).not.toContain(TOKEN);
  });

  it("tells a name nobody set apart from one the keychain can no longer read", () => {
    const github = attach("github", ["GITHUB_TOKEN", "GITHUB_HOST"]);
    // Written by another machine, or before a keychain reset: the file is
    // there and does not decrypt. Only one of the two is fixed by typing
    // it in again, which is why they are not the same answer.
    mkdirSync(join(directory, github.id), { recursive: true });
    writeFileSync(join(directory, github.id, "secret-GITHUB_HOST.bin"), Buffer.from([0]));

    const resolved = attachmentEnvironment(handle.db, implementer.id, secrets);

    expect(resolved.env).toEqual({});
    expect(resolved.unresolved).toEqual([
      { server: "github", name: "GITHUB_TOKEN", reason: "absent" },
      { server: "github", name: "GITHUB_HOST", reason: "unreadable" },
    ]);
  });

  it("reads nothing for a server that is not delivered", () => {
    const github = attach("github", ["GITHUB_TOKEN"]);
    storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", TOKEN);
    setMcpServerEnabled(handle.db, github.id, false);

    // A disabled server is not in the generated directory, so putting its
    // token in the environment would hand a value to a process for a
    // server that is not there.
    expect(attachmentEnvironment(handle.db, implementer.id, secrets)).toEqual({ env: {}, unresolved: [], withheld: [] });
  });

  it("is read now rather than remembered, so clearing a value takes effect on the next turn", () => {
    const github = attach("github", ["GITHUB_TOKEN"]);
    storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", TOKEN);
    const read = () => attachmentEnvironment(handle.db, implementer.id, secrets).env;
    expect(read()).toEqual({ GITHUB_TOKEN: TOKEN });

    rmSync(join(directory, github.id), { recursive: true, force: true });

    expect(read()).toEqual({});
  });

  it("resolves one value per name when two servers want the same one, deterministically", () => {
    const first = attach("alpha", ["SHARED_TOKEN"]);
    const second = attach("zulu", ["SHARED_TOKEN"]);
    storeMcpServerSecret(secrets, first.id, "SHARED_TOKEN", "alpha-value");
    storeMcpServerSecret(secrets, second.id, "SHARED_TOKEN", "zulu-value");

    // The environment is flat; the first server by name wins, rather than
    // whichever row happened to read first.
    expect(attachmentEnvironment(handle.db, implementer.id, secrets).env).toEqual({ SHARED_TOKEN: "alpha-value" });
  });
});

/**
 * What an organisation's value does to a name this machine also holds
 * (EO-328, `ARCHITECTURE.md`, "Secrets").
 *
 * The story's sentence is "a personal secret with the same name shadows
 * nothing; the two namespaces are distinct", and the interesting case is
 * the failure one: an organisation value that is *there but unreadable*
 * must stop the fallback rather than pass it. Collapsing that into
 * "absent" is how a personal token ends up being sent to a server the
 * organisation had provisioned, in the one state nobody would look at.
 */
describe("an organisation's value for a declared name", () => {
  const OURS = "org_liveSecretValue_1111";

  it("wins over the value this machine holds", () => {
    const github = attach("github", ["GITHUB_TOKEN"]);
    storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", TOKEN);

    const resolved = attachmentEnvironment(handle.db, implementer.id, secrets, () => ({ state: "value", value: OURS }));

    expect(resolved.env).toEqual({ GITHUB_TOKEN: OURS });
    expect(resolved.unresolved).toEqual([]);
  });

  it("falls through to this machine's own for a name it does not publish", () => {
    const github = attach("github", ["GITHUB_TOKEN"]);
    storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", TOKEN);

    const resolved = attachmentEnvironment(handle.db, implementer.id, secrets, () => ({ state: "absent" }));

    expect(resolved.env).toEqual({ GITHUB_TOKEN: TOKEN });
  });

  it("stops the fallback when it is there and cannot be read", () => {
    // The regression this case exists for. A wrong credential is worse
    // than no credential, and the personal value of the same name is the
    // wrong credential here — the organisation provisioned this server.
    const github = attach("github", ["GITHUB_TOKEN"]);
    storeMcpServerSecret(secrets, github.id, "GITHUB_TOKEN", TOKEN);

    const resolved = attachmentEnvironment(handle.db, implementer.id, secrets, () => ({ state: "unreadable" }));

    expect(resolved.env).toEqual({});
    expect(resolved.unresolved).toEqual([{ server: "your organisation", name: "GITHUB_TOKEN", reason: "unreadable" }]);
    expect(resolved.withheld).toEqual(["GITHUB_TOKEN"]);
  });
});

/**
 * A declared name no secret fills, filled from the run's environment
 * variables (EO-488, ARCHITECTURE.md §14.2).
 *
 * The order is the organisation's value, the server's own secret, the
 * step's variable, the shared variable. The last two arrive composed —
 * `agentRunVariables` is what the supervisor hands each turn — so the
 * step case is asserted through the real store.
 */
describe("the run's environment variables for a declared name", () => {
  let variableDirectory: string;
  let variables: ModuleSecretsOptions;

  beforeEach(() => {
    variableDirectory = mkdtempSync(join(tmpdir(), "eo attachment variables "));
    variables = { directory: variableDirectory, store };
  });

  afterEach(() => rmSync(variableDirectory, { recursive: true, force: true }));

  it("fill a name that has no secret", () => {
    attach("cloud", ["REGION"]);
    storeVariable(variables, "REGION", "eu-west-1");

    expect(attachmentEnvironment(handle.db, implementer.id, secrets, undefined, agentRunVariables(variables, null))).toEqual({
      env: { REGION: "eu-west-1" },
      unresolved: [],
      withheld: [],
    });
  });

  it("fill only names a delivered server declares", () => {
    attach("cloud", ["REGION"]);

    expect(attachmentEnvironment(handle.db, implementer.id, secrets, undefined, { REGION: "eu-west-1", TIER: "gold" }).env).toEqual({ REGION: "eu-west-1" });
  });

  it("give the step's value over the shared one, for a run on that step only", () => {
    attach("cloud", ["REGION"]);
    storeVariable(variables, "REGION", "eu-west-1");
    storeVariable(variables, "REGION", "us-east-2", "step-a");

    const on = (stepId: string) => attachmentEnvironment(handle.db, implementer.id, secrets, undefined, agentRunVariables(variables, stepId)).env;

    expect(on("step-a")).toEqual({ REGION: "us-east-2" });
    expect(on("step-b")).toEqual({ REGION: "eu-west-1" });
  });

  it("lose to the server's own secret, and both lose to the organisation's", () => {
    const cloud = attach("cloud", ["REGION", "ZONE"]);
    storeMcpServerSecret(secrets, cloud.id, "REGION", "from-the-servers-secret");
    storeMcpServerSecret(secrets, cloud.id, "ZONE", "from-the-servers-secret");
    storeVariable(variables, "REGION", "from-a-shared-variable");
    storeVariable(variables, "ZONE", "from-a-step-variable", "step-a");
    const organisation = (name: string) => (name === "ZONE" ? { state: "value" as const, value: "from-the-organisation" } : { state: "absent" as const });

    expect(attachmentEnvironment(handle.db, implementer.id, secrets, organisation, agentRunVariables(variables, "step-a")).env).toEqual({
      REGION: "from-the-servers-secret",
      ZONE: "from-the-organisation",
    });
  });

  it("do not displace another delivered server's secret of the same name", () => {
    // `alpha` is earlier by name and has no secret; `zulu` has one. The
    // environment is flat, so a variable filling `alpha`'s gap while the
    // servers were walked would have taken the name from `zulu`'s secret.
    attach("alpha", ["REGION"]);
    const zulu = attach("zulu", ["REGION"]);
    storeMcpServerSecret(secrets, zulu.id, "REGION", "from-zulus-secret");

    const resolved = attachmentEnvironment(handle.db, implementer.id, secrets, undefined, { REGION: "from-a-variable" });

    expect(resolved.env).toEqual({ REGION: "from-zulus-secret" });
    // `alpha`'s gap is still reported, as it was before variables: a
    // name another server filled is not one a variable did.
    expect(resolved.unresolved).toEqual([{ server: "alpha", name: "REGION", reason: "absent" }]);
  });

  it("fill a name no delivered server has a secret for, and report no gap for it", () => {
    attach("alpha", ["REGION"]);
    attach("zulu", ["REGION"]);

    expect(attachmentEnvironment(handle.db, implementer.id, secrets, undefined, { REGION: "from-a-variable" })).toEqual({
      env: { REGION: "from-a-variable" },
      unresolved: [],
      withheld: [],
    });
  });

  it("do not stand in for an organisation value that cannot be read", () => {
    attach("cloud", ["REGION"]);

    const resolved = attachmentEnvironment(handle.db, implementer.id, secrets, () => ({ state: "unreadable" }), { REGION: "eu-west-1" });

    expect(resolved.env).toEqual({});
    expect(resolved.withheld).toEqual(["REGION"]);
  });

  it("fill a name whose stored secret no longer decrypts, as the inherited environment always has", () => {
    const cloud = attach("cloud", ["REGION"]);
    mkdirSync(join(directory, cloud.id), { recursive: true });
    writeFileSync(join(directory, cloud.id, "secret-REGION.bin"), Buffer.from([0]));

    const resolved = attachmentEnvironment(handle.db, implementer.id, secrets, undefined, { REGION: "eu-west-1" });

    expect(resolved.env).toEqual({ REGION: "eu-west-1" });
    expect(resolved.unresolved).toEqual([]);
  });

  it("are given to no server that is disabled or archived", () => {
    const disabled = attach("disabled", ["REGION"]);
    const archived = attach("archived", ["ZONE"]);
    setMcpServerEnabled(handle.db, disabled.id, false);
    archiveMcpServer(handle.db, archived.id);

    expect(attachmentEnvironment(handle.db, implementer.id, secrets, undefined, { REGION: "eu-west-1", ZONE: "a" })).toEqual({ env: {}, unresolved: [], withheld: [] });
  });

  it("keep a declared name called __proto__ as an own property", () => {
    attach("cloud", ["__proto__"]);

    const env = attachmentEnvironment(handle.db, implementer.id, secrets, undefined, Object.fromEntries([["__proto__", "a-variable"]])).env;

    expect(Object.getOwnPropertyDescriptor(env, "__proto__")?.value).toBe("a-variable");
  });
});
