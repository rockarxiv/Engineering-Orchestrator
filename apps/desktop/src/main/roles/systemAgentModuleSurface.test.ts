import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CustomModule, Item, Uuid } from "@eo/core";
import { TOOLS } from "../mcpHost/catalog.js";
// @ts-expect-error — the host is plain JavaScript, deliberately: it ships
// unbundled because another process executes it by path.
import { FIXTURE_NAMES } from "../modules/moduleHost.mjs";
import { runModule, type ModuleHostLauncher } from "../modules/runModule.js";
import { loadRolePrompt } from "./prompts.js";

/**
 * The system agent's picture of a module, held to the module host (EO-712).
 *
 * The agent learns what a module can do only from its prompt and from
 * module_test_save's description, and the host is free to grow without
 * either. So the lists come from the host itself: the keys of the `ctx`
 * a real host run hands a module, and the `FIXTURE_NAMES` set
 * `harness.run` refuses anything outside of. A member or a fixture added
 * there without being described here fails this test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const launcher: ModuleHostLauncher = { execPath: process.execPath, hostPath: join(here, "..", "modules", "moduleHost.mjs"), hostEnv: { ELECTRON_RUN_AS_NODE: "1" } };

/** Every key of the `ctx` the module host hands a module, read by running one. */
async function ctxMembers(): Promise<string[]> {
  const module = {
    id: "019fb8c6-0000-7000-8000-0000000000aa" as Uuid,
    slug: "probe",
    name: "Probe",
    description: "Reports what ctx holds.",
    code: `export default async function run(ctx) { return { ok: true, result: "ok", detail: JSON.stringify(Object.keys(ctx)) }; }`,
    manifest: { name: "Probe", description: "A module.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["ok"] },
    originalScript: null,
    source: "user",
    approvedAt: 1,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  } as CustomModule;
  const item = { id: "019fb8c6-0000-7000-8000-000000000001" as Uuid, key: "EO-1", type: "story", title: "Probe", branch: null, prUrl: null } as unknown as Item;
  const outcome = await runModule(launcher, { module, item, cwd: process.cwd(), env: {} });
  if (!outcome.ok) throw new Error(`The probe module did not run: ${outcome.reason}`);
  const keys: unknown = JSON.parse(outcome.detail);
  if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string")) throw new Error(`The probe answered ${outcome.detail}`);
  return keys;
}

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = text.indexOf(to, start);
  expect(end, to).toBeGreaterThan(start);
  return text.slice(start, end);
}

const prompt = (): string => loadRolePrompt("system")!;

/** `ctx.<name>` in backticks, and not the start of a longer name — `ctx.item` is not `ctx.items`. */
const namesMember = (text: string, name: string): boolean => new RegExp("`ctx\\." + name + "(?![A-Za-z0-9_$])").test(text);

describe("the system agent's description of ctx", () => {
  it("names every ctx member the host gives a module in the index that says which need await", async () => {
    const members = await ctxMembers();
    // A probe that came back empty would make every check below pass.
    expect(members).toContain("item");
    const index = between(prompt(), "- `ctx` is the entire surface", "- `ctx.cwd` is the directory");
    expect(members.filter((name) => !namesMember(index, name))).toEqual([]);
  });

  it("says, in that index, which members are values, which answer at once and which need await", () => {
    const index = between(prompt(), "- `ctx` is the entire surface", "- `ctx.cwd` is the directory");
    expect(index).toContain("Values, read as they are:");
    expect(index).toContain("Calls that answer at once, no `await`:");
    expect(index).toContain("Calls that answer with a promise, so `await` them:");
  });
});

describe("the harness.run fixtures the system agent is told about", () => {
  const fixtures: string[] = [...(FIXTURE_NAMES as ReadonlySet<string>)];

  it("takes the list from the host", () => {
    expect(fixtures).toContain("exec");
    expect(fixtures.length).toBeGreaterThan(1);
  });

  it("names every fixture in the prompt's list of them", () => {
    const list = between(prompt(), "`harness.run(fixtures)` runs the module once", "- What `run` answers");
    expect(fixtures.filter((name) => !list.includes("`" + name + "`"))).toEqual([]);
  });

  it("names every fixture in module_test_save's description, as `name — what it is`", () => {
    const description = TOOLS.find((tool) => tool.name === "module_test_save")?.description ?? "";
    expect(description).not.toBe("");
    expect(fixtures.filter((name) => !new RegExp("(?<![A-Za-z0-9_.])" + name + " — ").test(description))).toEqual([]);
  });
});

describe("the manifest's needs, as the prompt teaches them", () => {
  it("declares reading a ticket as `item: true`, the field the schema has, and never `ticket`", () => {
    const text = prompt();
    expect(text).toContain("`item: true`");
    expect(text).not.toContain("`ticket: true`");
    expect(text).not.toMatch(/`ticket`,\s+`comment` and `attach` are not enforced/);
  });

  it("does not say a module cannot post a comment", () => {
    const paragraph = between(prompt(), "**If a step needs something `ctx` cannot do**", "\n\n");
    expect(paragraph).not.toMatch(/comment/i);
  });
});
