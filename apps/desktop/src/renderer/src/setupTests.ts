import * as jestDom from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { developerRegistry, NO_POLICY, toRegistryView } from "@eo/core";

/**
 * jest-dom's matchers, extended onto *this* package's `expect` (EO-305).
 *
 * `@testing-library/jest-dom/vitest` does the same thing in one import,
 * and did until this story — but it does it by importing `vitest`
 * itself, and pnpm resolves that from the workspace root rather than
 * from here. Root and `apps/desktop` get two peer-resolved copies of
 * vitest 4.1.10 in the store, so the `expect` jest-dom extended was a
 * different object from the `expect` these tests call, and the one the
 * tests call ended up without its snapshot client: every
 * `toMatchSnapshot` in the renderer project failed with "The snapshot
 * state ... is not found", whatever it was asserting about.
 *
 * Extending here keeps both halves on one instance, because this file is
 * in this package and resolves this package's vitest. Nothing about the
 * matchers changes — `toBeInTheDocument` and the rest are the same set,
 * from the same package, by the entry point that exports them without
 * choosing a test runner.
 *
 * The types come with it, written out here because they arrived with
 * that import: `@testing-library/jest-dom/vitest` augments vitest's
 * `Assertion` as well as extending it, and dropping the import dropped
 * `toBeInTheDocument` from every renderer test's types. This is that
 * declaration, copied from the package's own `types/vitest.d.ts`.
 */
declare module "vitest" {
  // `Matchers` is the seam vitest 4 documents for custom matchers, and
  // `Assertion` extends it — so augmenting it reaches both `expect(x)`
  // and the asymmetric forms without redeclaring either. Its own
  // parameter default is `any`, and an augmentation whose defaults
  // differ is refused outright ("All declarations of 'Matchers' must
  // have identical type parameters"), which is why this one is spelled
  // the way the package that owns it spells it.
  // Empty on purpose: the members are what it extends. That is what a
  // matcher augmentation is, and both rules below are about code that
  // means something else.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
  interface Matchers<T = any> extends TestingLibraryMatchers<unknown, T> {}
}

expect.extend(jestDom);

// findBy*/waitFor give up after 1s by default, which is its own budget and
// not the one `testTimeout` controls. On a hosted Windows runner a query
// waiting on a settled fetch can lose that race while the code is correct.
configure({ asyncUtilTimeout: 5_000 });

// Testing Library only auto-cleans when vitest runs with `globals: true`,
// which this repository doesn't — without this, each render stacks another
// copy of the tree into the same document and every getBy* starts
// finding duplicates.
afterEach(cleanup);

/**
 * Empty-but-correctly-shaped responses per channel.
 *
 * A blanket `{}` satisfies the envelope but not the payload, so any
 * component reading `data.items` silently got undefined — which looks
 * like a component bug rather than a missing mock. Tests that care about
 * specific data still override `invoke` entirely.
 */
const EMPTY_RESPONSES: Record<string, unknown> = {
  "app:getVersion": { version: "0.0.0-test" },
  /*
   * The registry as EO ships it (EO-309).
   *
   * Not an empty one, because an empty registry is not a quiet default
   * here: since `chromeVocabulary` reads the project's vocabulary off
   * the packs its types came from, "no packs" is the answer that makes
   * the whole application say "Items" — so a test that simply forgot to
   * mock this channel would be asserting against a screen no shipped
   * installation draws. The developer pack is what a test means when it
   * says nothing, exactly as `items:list` meaning "no items" is.
   */
  "registry:get": toRegistryView(developerRegistry()),
  // EO-201. A shape rather than a blank: the Updates section branches
  // on `state`, and an empty object would put it in none of its states.
  "updates:status": { state: "idle", lastCheckedAt: null },
  "items:list": { items: [] },
  // EO-316. A gallery with no templates and no index reached — which is
  // a real state of that screen (ARCHITECTURE.md, "The gallery") rather than a missing mock.
  "gallery:list": { templates: [], fetched: false, people: [] },
  /*
   * First run, behind them (EO-317).
   *
   * An installation with something of its own is what nearly every
   * renderer test is about: a board with items, a settings screen, an
   * agent. The flow is asserted by its own tests, which stub this
   * channel and say so.
   */
  "firstRun:state": { done: true, mode: "solo" },
  "items:listArchived": { items: [] },
  "pipelineSteps:list": { steps: [], routes: [] },
  "agents:list": { agents: [] },
  "inbox:list": { items: [] },
  "runs:listEvents": { events: [], nextSeq: null },
  "engine:status": { paused: false, activeRunCount: 0, finishingRunCount: 0 },
  "attachments:pick": { attachments: [], omitted: 0 },
  // The two catalogues and the join between them (EO-109). The agent
  // editor asks for all three, so every test that renders an agent gets
  // them whether it cares about tools or not.
  "mcpServers:list": { servers: [], keychain: { available: true, backend: null, weak: false, warning: null }, managedIds: [], organisationSecrets: [], environmentVariables: [] },
  /*
   * An installation nobody has published a policy to (EO-328).
   *
   * `NO_POLICY` rather than `{}`, because the screens read fields off it
   * on every render — the agent editor's picker, the top bar's budget
   * line — and an empty object would leave them reading `undefined`
   * rather than "the organisation has not said", which is a different
   * answer and the one every solo installation actually gives.
   */
  "policy:get": { policy: NO_POLICY, fromServer: false, yours: null },
  "moduleSecrets:list": { names: [], overrides: [], organisation: [] },
  "environmentVariables:list": { variables: [] },
  "skills:list": { skills: [] },
  "agentAttachments:list": { attachments: [] },
};

/**
 * Web Storage, which this environment does not otherwise have.
 *
 * jsdom implements `localStorage`, but vitest's jsdom environment copies
 * a fixed list of window properties onto the global and that list does
 * not include it — the property is an accessor on `Window.prototype`
 * rather than an own property of the window, so it falls through. The
 * Electron renderer has the real one; without this, anything that
 * remembers a person's view state has nowhere to remember it (EO-193).
 *
 * Backed by a `Map` and cleared between cases, so one test's stored
 * preference cannot decide another test's first render.
 */
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }
}

// The property *name* is reachable through jsdom's prototype chain even
// though its value is not, so this asks for the value rather than for the
// key. A real one, if this ever runs somewhere that has it, is left alone.
if ((globalThis as { localStorage?: Storage }).localStorage === undefined) {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true });
}

beforeEach(() => {
  window.localStorage.clear();
});

// Default preload bridge so components using the IPC hooks don't crash
// in tests that don't care about IPC specifically.
beforeEach(() => {
  window.eo = {
    versions: { electron: "0.0.0-test", chrome: "0.0.0-test", node: "0.0.0-test" },
    ipc: {
      invoke: vi.fn(async (channel: string) => ({ ok: true, data: EMPTY_RESPONSES[channel] ?? {} })) as never,
      subscribe: vi.fn().mockReturnValue(() => {}),
    },
  };
});
