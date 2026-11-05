import {
  buildRegistry,
  type BuiltinEntry,
  connectorSetupProblems,
  CORE_ENTRY_RULE_KINDS,
  coreBuiltins,
  declaredActionOverrides,
  isCoreBuiltin,
  type ConnectorSetup,
  type EntryRuleKind,
  type Item,
  type ItemTypeEntry,
  type PackVocabulary,
  type Registry,
  type RoleEntry,
  type Uuid,
} from "@eo/core";
import type { SectionRenderer } from "@eo/engine";
import type { BuiltinRunner } from "../supervisor/builtins.js";
import { createCoreBuiltinRunners } from "../supervisor/coreBuiltins.js";
import type { RunSupervisorOptions } from "../supervisor/runSupervisor.js";
import type { WorkspaceKind } from "../supervisor/workspaceKind.js";
import type { registerHandler } from "../ipc/registry.js";

/**
 * What a code pack is (ARCHITECTURE.md, "The core is domain-neutral", "Where the seams are",
 * KAN-144).
 *
 * EO's core is domain-neutral and a pack is what makes an installation
 * about something: the developer pack is what makes this one a
 * developer tool. The first draft of the design said the boundary was
 * three lookups in `engine.ts`. The review (ARCHITECTURE.md, "Two kinds of pack, two trust
 * classes") found it is the run supervisor's options object — eight of
 * them were typed on a worktree path or called git, and are the five
 * methods of one `WorkspaceKind` since EO-295 — plus the role wiring,
 * which hard-codes the review, refine and intake result keys and posts
 * a comment per role. A pack that contributed only prompts and schemas
 * would have left all of that in the core, where a second pack could not
 * replace it and a core with no pack would still have cut branches.
 *
 * So a pack is a *value*: the workspace kinds, the two scheduling
 * hooks, the functions a `builtin` step can run, the wiring, what it
 * contributes to the registry, and — for now — the IPC handlers it
 * registers. `createEngine(options, packs)` folds them into the
 * supervisor's options and refuses a collision between two packs
 * (`foldPacks`). Nothing here is registered, subscribed or discovered:
 * import order decides nothing, because a fold over a list has an order
 * the caller wrote down.
 */

/**
 * The supervisor options a pack supplies, by name.
 *
 * One, now: what a pack requires of a step before it will run. A
 * single-valued decision rather than a contribution, so it collides like
 * a hook rather than composing like wiring — a silently dropped gate is
 * a rule an installation believes it has.
 *
 * It was ten. The eight that touched a workspace — preparing one,
 * checking what had been done in one, releasing one, lending the agent
 * what it had to offer — are `CodePack.kinds` now (EO-295): five
 * methods on one value, keyed by the slug a workspace row names, so
 * that a second kind of disk costs a registry entry rather than eight
 * more options on this type. The ninth, which capacity bucket an item's
 * run consumes, went the same way in EO-296 and for a sharper reason:
 * **concurrency is per shared filesystem**, so the question belongs to
 * whatever prepares a filesystem. A pack-wide answer had to be one
 * answer for every item it touched, which is how every item with no
 * repository ended up sharing one bucket.
 *
 * Listed as a value rather than only as a type because the fold has to
 * iterate them, and a `Pick<…>` cannot be iterated — the two would then
 * be a type and a list that agree today. `satisfies` below ties them
 * together, so adding a hook to the type without adding it here fails
 * to compile.
 */
export const PACK_HOOKS = [
  "dispatchGate",
] as const satisfies readonly (keyof RunSupervisorOptions)[];

export type PackHook = (typeof PACK_HOOKS)[number];

/** The one, as the supervisor declares it. A pack may supply it or not. */
export type PackHooks = Pick<RunSupervisorOptions, PackHook>;

/**
 * A pack's opinion about what a run's result means, and what to say
 * about it.
 *
 * `resolveNextState` returning `undefined` is "not mine" — the
 * supervisor then routes on the reported result key, else `done`, which
 * is what it does with no pack installed and what the pack's own wiring
 * already does for a builtin and for a module. `null` is different and
 * load-bearing: it means "do not move this item" *and let the run
 * finish*, which is what a conversation turn is.
 */
export type RoleWiring = Pick<Required<RunSupervisorOptions>, "resolveNextState" | "onRunSucceeded">;

/**
 * What writes the record of a run whose type named it (KAN-163).
 *
 * An item type's action override names its poster rather than holding
 * one, because the registry is plain data and posting a comment is a
 * write: the pack keeps the table from name to function, the way it
 * keeps one from a builtin's action to its runner, and the fold refuses
 * an override naming a name nothing registers.
 *
 * The database is closed over rather than passed, for the same reason
 * `BuiltinRunner`'s is: a pack builds its table once, from the handle it
 * was composed with.
 */
export type CommentPoster = (item: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown) => void;

/**
 * A connector a pack ships, bound to the server it describes (EO-315,
 * ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
 *
 * The *name* of the server rather than its id, because the servers a
 * pack has anything to say about are the ones EO injects — `repo` — and
 * those have no `mcp_servers` row to carry an id. A name is also what a
 * catalogue row is unique on, so a pack describing a server the person
 * does happen to have catalogued lands on the right one without the pack
 * knowing a uuid it could not possibly have.
 *
 * A setup and a label, and that is the boundary. A pack says what a
 * person has to do to connect a server; it does not say what to spawn. A
 * pack that could write a transport would be a pack shipping executable
 * configuration with none of a module's reading and approving. What the
 * server *reaches* is not here either — that is `mcp_servers.description`
 * or `EO_SERVER_CAPABILITIES` (EO-314), so the sentence is written once.
 */
export interface PackConnector {
  /** The key the model sees in every tool id: `repo`, `slack`. */
  serverName: string;
  setup: ConnectorSetup;
}

export interface CodePack extends PackHooks {
  /**
   * How this pack is named in a collision, and nowhere else.
   *
   * A refusal that says "two packs both supply the `git-worktree` kind"
   * and cannot say which two is a refusal nobody can act on, and a pack
   * is a value rather than a row, so there is no id to fall back on.
   */
  id: string;
  /**
   * What this pack adds to the registry: its roles, the functions its
   * `builtin` steps can run, and the item types it ships (KAN-124).
   *
   * `Partial` because a pack contributing only roles is a reasonable
   * thing to be. The fold merges the three maps and refuses a key two
   * packs both claim.
   */
  registry: Partial<Registry>;
  /**
   * The workspace kinds this pack ships (EO-295).
   *
   * A list rather than a map, because each kind already carries the slug
   * it answers to — the same string a `workspaces` row holds — and a
   * second spelling of it here is a second thing to keep in step. The
   * fold keys them, and refuses two packs claiming one slug on the same
   * grounds it refuses two claiming one builtin action: whichever is
   * dropped is a disk an installation believes it can work on.
   *
   * A pack with no kinds is an ordinary pack. It contributes roles,
   * prompts and functions, and its steps run wherever the item's
   * workspace says.
   */
  kinds?: readonly WorkspaceKind[];
  /**
   * The connectors this pack ships (EO-315).
   *
   * A list rather than a map, for `kinds`' reason: each entry already
   * carries the server name it answers to, and a second spelling of it
   * here is a second thing to keep in step. The fold keys them and
   * refuses two packs claiming one server — whichever was dropped would
   * be words an installation believes it is showing.
   *
   * A pack with none is an ordinary pack: with no pack installed the
   * connector list is what the catalogue's own rows say, which is
   * nothing until somebody imports one.
   */
  connectors?: readonly PackConnector[];
  /** What each of `registry.builtins`' actions actually runs. */
  builtins: Record<string, BuiltinRunner>;
  /**
   * What each name an action override may use actually posts.
   *
   * Optional, like every other contribution: a pack whose types override
   * nothing needs no table. What it must not be is short — an override
   * naming a poster no pack registers is refused by the fold, on the
   * same grounds `buildRegistry` refuses one naming a schema no role
   * declares.
   */
  posters?: Record<string, CommentPoster>;
  wiring?: RoleWiring;
  /**
   * The prompt sections this pack writes itself (KAN-161).
   *
   * A list rather than a hook, and it composes rather than colliding:
   * two packs each with something to say about the item in front of an
   * agent both get to say it, the way two wirings both get to comment.
   * The fold concatenates them in pack order, and each renderer says
   * which of the engine's sections it lands after.
   */
  sectionRenderers?: readonly SectionRenderer[];
  /**
   * The IPC handlers this pack owns (the forge, Jira, repository and
   * worktree commands).
   *
   * Declared now and unused: the phase's scope leaves those handlers
   * where they are until the import allowlist forces them out (KAN-177).
   * It is here so that a pack's surface is one type rather than a type
   * plus a convention, and so that the fold that would call it is
   * written before anything depends on it.
   */
  registerIpc?: (register: typeof registerHandler) => void;
}

/**
 * Two packs claiming the same thing, refused at startup.
 *
 * A typed error rather than a console warning and a winner, because
 * there is no correct winner: if two packs both supply the
 * `git-worktree` kind, whichever is dropped is a capability an
 * installation believes it has.
 * Thrown while the engine is being composed, which is a programmer
 * error in a pack — the same grounds `buildRegistry` throws on, and the
 * same moment.
 */
/** What a collision names as the other party when a pack claims one of the core's own functions (EO-459). */
const CORE_CLAIMANT = "core";

export class PackCollisionError extends Error {
  constructor(
    readonly what: string,
    readonly key: string,
    readonly packs: [string, string],
  ) {
    super(`The "${packs[0]}" and "${packs[1]}" packs both supply the ${what} "${key}"; only one may, so EO cannot compose an engine from both.`);
    this.name = "PackCollisionError";
  }
}

/** What the fold hands `createRunSupervisor`, beside everything the caller supplies. */
export type FoldedPacks = PackHooks & {
  kinds: ReadonlyMap<string, WorkspaceKind>;
  /** By server name, in pack order. Collisions are refused above. */
  connectors: ReadonlyMap<string, ConnectorSetup>;
  builtins: Record<string, BuiltinRunner>;
  posters: Record<string, CommentPoster>;
  registry: Registry;
  sectionRenderers: readonly SectionRenderer[];
  resolveNextState: NonNullable<RunSupervisorOptions["resolveNextState"]>;
  onRunSucceeded: NonNullable<RunSupervisorOptions["onRunSucceeded"]>;
};

/**
 * Every installed pack's item types, in pack order (KAN-129).
 *
 * What `syncItemTypes` seeds. Each entry already says which pack shipped
 * it and under what word, which is the pair `item_types` is unique on —
 * so this is a flattening rather than a transformation, and two packs
 * that both ship a `case` contribute two entries rather than one
 * overwriting the other.
 */
export function itemTypeContributions(packs: readonly CodePack[]): ItemTypeEntry[] {
  return packs.flatMap((pack) => [...(pack.registry.itemTypes ?? new Map<string, ItemTypeEntry>()).values()]);
}

/**
 * Every installed pack as one set of supervisor options and one
 * registry.
 *
 * Collisions are refused rather than resolved, for `PackCollisionError`'s
 * reason. A hook, a builtin runner, a role slug, a builtin action and a
 * qualified item type (`packSlug:slug`) are each a key two packs may not
 * share — and the qualified spelling is what lets two packs both ship a
 * `case` while still refusing a pack that claims another's. Two things
 * compose instead: wiring, where each pack is asked in turn and the
 * first that claims the action answers, because a pack having no
 * opinion about another pack's action is the ordinary case rather than
 * a clash; and section renderers, which are concatenated, because a
 * prompt with two packs' sections in it is not a prompt with a
 * collision in it.
 *
 * With no packs at all this returns the supervisor's own defaults and the
 * core's own registry — no roles, no types, and the core's functions
 * (`coreRegistry`, EO-459) — the core, built and running with nothing
 * installed, which is the invariant this phase adds (ARCHITECTURE.md,
 * "The invariants"). The core's functions are claimed before any pack's,
 * by "core", so a pack shipping a `wait_until` of its own is refused
 * like any other collision rather than quietly replacing the core's.
 */
export function foldPacks(packs: readonly CodePack[]): FoldedPacks {
  const hooks: Record<string, unknown> = {};
  const claimedBy = new Map<string, string>();

  const claim = (what: string, key: string, pack: CodePack): void => {
    const other = claimedBy.get(`${what}:${key}`);
    if (other !== undefined) throw new PackCollisionError(what, key, [other, pack.id]);
    claimedBy.set(`${what}:${key}`, pack.id);
  };

  // The core's own functions (EO-459), installed whatever else is.
  const core = coreBuiltins();
  const coreRunners: Record<string, BuiltinRunner> = createCoreBuiltinRunners();
  for (const action of core.keys()) {
    claimedBy.set(`builtin:${action}`, CORE_CLAIMANT);
    claimedBy.set(`builtin action:${action}`, CORE_CLAIMANT);
  }

  for (const pack of packs) {
    for (const hook of PACK_HOOKS) {
      const supplied = pack[hook];
      if (supplied === undefined) continue;
      claim("hook", hook, pack);
      hooks[hook] = supplied;
    }
    for (const kind of pack.kinds ?? []) claim("workspace kind", kind.slug, pack);
    for (const connector of pack.connectors ?? []) {
      claim("connector", connector.serverName, pack);
      // Refused at composition rather than at the screen, on
      // `declaredActionOverrides`' grounds a few lines down: a pack is
      // code this process imported, so a malformed setup in one is
      // a programmer error, and the alternative is a Connect button
      // whose flow cannot complete — a guard dropping work in silence
      // (invariant 8) at the one moment a person is trying to sign in.
      const problems = connectorSetupProblems(connector.setup);
      if (problems.length > 0) {
        throw new Error(`The "${pack.id}" pack's "${connector.serverName}" connector is not well-formed: ${problems.join(" ")}`);
      }
    }
    for (const action of Object.keys(pack.builtins)) claim("builtin", action, pack);
    for (const name of Object.keys(pack.posters ?? {})) claim("comment poster", name, pack);
  }

  const roles = new Map<string, RoleEntry>();
  const builtinEntries = new Map<string, BuiltinEntry>(core);
  const itemTypes = new Map<string, ItemTypeEntry>();
  const vocabularies = new Map<string, PackVocabulary>();
  const entryRuleKinds = new Map<string, EntryRuleKind>();
  // The core's own kinds, claimed first for the reason its functions are.
  for (const kind of CORE_ENTRY_RULE_KINDS) claimedBy.set(`entry rule kind:${kind}`, CORE_CLAIMANT);
  for (const pack of packs) {
    for (const [slug, role] of pack.registry.roles ?? []) {
      claim("role", slug, pack);
      roles.set(slug, role);
    }
    for (const [action, entry] of pack.registry.builtins ?? []) {
      claim("builtin action", action, pack);
      builtinEntries.set(action, entry);
    }
    // A pack's own words, under its own slug (EO-309). Claimed like
    // everything else: two packs answering for one slug's vocabulary is
    // one of them lying about whose work it labels.
    for (const [slug, vocabulary] of pack.registry.packs ?? []) {
      claim("vocabulary", slug, pack);
      vocabularies.set(slug, vocabulary);
    }
    for (const [kind, entry] of pack.registry.entryRuleKinds ?? []) {
      claim("entry rule kind", kind, pack);
      entryRuleKinds.set(kind, entry);
    }
    // Claimed by `packSlug:slug`, not by the word (KAN-129). Two packs
    // both shipping a `case` is the settled case rather than a
    // collision — ARCHITECTURE.md, "An item type is data" namespaces a type by the pack that
    // shipped it,
    // and the picker shows "Case (Support)" to tell them apart. What is
    // still a collision is one pack claiming a key another pack already
    // has, which means a pack lying about whose type it ships.
    for (const [key, type] of pack.registry.itemTypes ?? []) {
      claim("item type", key, pack);
      itemTypes.set(key, type);
    }
  }

  const wirings = packs.map((pack) => pack.wiring).filter((wiring): wiring is RoleWiring => wiring !== undefined);

  const posters: Record<string, CommentPoster> = Object.assign({}, ...packs.map((pack) => pack.posters ?? {}));
  const registry = buildRegistry({ roles, builtins: builtinEntries, itemTypes, packs: vocabularies, ...(entryRuleKinds.size === 0 ? {} : { entryRuleKinds }) });

  // The other half of an override's validation (KAN-163). `buildRegistry`
  // has already refused one naming a schema no role declares; this is the
  // half it cannot do, because a poster is a function a pack holds rather
  // than registry data. Here for the same reason the collisions above
  // are: it is the one moment every installed pack is in one hand, and an
  // override naming a poster nobody registers would otherwise be a run
  // that finishes, routes, and leaves nothing in the thread — a guard
  // dropping work on the floor in silence (invariant 8).
  for (const { declaredBy, action, override } of declaredActionOverrides(registry)) {
    if (Object.hasOwn(posters, override.poster)) continue;
    throw new Error(
      `${declaredBy} names "${override.poster}" as what posts the record of "${action}", but no installed pack registers a comment poster by that name.`,
    );
  }

  return {
    ...(hooks as PackHooks),
    // Keyed by slug, in pack order. A map rather than a list because
    // every reader has a slug in hand — an item's workspace row names
    // one — and because "two packs both ship `git-worktree`" is a
    // collision the claim above has already refused by the time this is
    // built.
    kinds: new Map(packs.flatMap((pack) => (pack.kinds ?? []).map((kind) => [kind.slug, kind] as const))),
    // Keyed by server name for `kinds`' reason: every reader has a name
    // in hand — a catalogue row's, or the one EO injects a server under.
    connectors: new Map(packs.flatMap((pack) => (pack.connectors ?? []).map((entry) => [entry.serverName, entry.setup] as const))),
    builtins: Object.assign({}, coreRunners, ...packs.map((pack) => pack.builtins)) as Record<string, BuiltinRunner>,
    // Concatenated in pack order, like the wirings below and unlike the
    // hooks above: a section is something added to a prompt, and two
    // packs adding one each is not a clash.
    sectionRenderers: packs.flatMap((pack) => pack.sectionRenderers ?? []),
    posters,
    // `buildRegistry` rather than the maps alone: a pack whose builtin
    // declares no `failed`, or two roles declaring one action's schema,
    // are refused above on the same grounds two packs colliding are.
    // With nothing installed it is `coreRegistry()` — the same value,
    // built by the same call, so there is no second spelling of "no pack".
    registry,
    resolveNextState: (currentStep, steps, parsedResult, action, item, role) => {
      for (const wiring of wirings) {
        const next = wiring.resolveNextState(currentStep, steps, parsedResult, action, item, role);
        // Not `?? continue`: `null` is an answer — "do not move it" —
        // and only `undefined` is "I have no opinion".
        if (next !== undefined) return next;
      }
      // Nothing claimed it, which is what the supervisor reads as "use
      // your own default": the reported result key, else `done`.
      return undefined;
    },
    onRunSucceeded: (item, agent, action, parsedResult, runId) => {
      // Every pack, not the first: this is a side effect on the thread
      // rather than a decision, and two packs with something to say
      // about one action both get to say it.
      for (const wiring of wirings) wiring.onRunSucceeded(item, agent, action, parsedResult, runId);
    },
  };
}

/**
 * Why this dispatch cannot happen, when nothing is installed to run it
 * (KAN-144).
 *
 * The core composes and ticks with no pack — that is the invariant —
 * and what it must not do is dispatch anyway, or throw. A role is
 * configuration rather than code (ARCHITECTURE.md, "An agent is a row"), so "the registry
 * has never heard of this role" is *not* grounds to refuse: somebody
 * inventing a role in the Agents editor and writing its prompt is a
 * supported thing to do, and it stays supported. What is refused is the
 * narrower and more absolute case — no pack at all, so nothing supplies
 * a workspace, a verifier, a function or a word of wiring.
 *
 * The refusal names whichever of the two the dispatch had: the role a
 * step is owned by, or — on a `builtin` step, which is owned by nobody
 * — the function it names. Both, because both are what a person reads
 * on the item and neither is available on both paths: without this
 * the builtin half said "a module is missing, deleted, or no longer
 * approved", which is a sentence about something the pipeline never
 * named.
 *
 * Returned as a sentence for the supervisor's `dispatchRefusal` seam,
 * which posts it on the item and parks the step without starting
 * anything. Invariant #8 through the refusal path that already exists.
 */
export function missingPackRefusal(packs: readonly CodePack[], subject: { role: string | null; action: string }): string | null {
  if (packs.length > 0) return null;
  // A function the core ships itself is provided whatever is installed
  // (EO-459), so its step runs rather than being refused.
  if (subject.role === null && isCoreBuiltin(subject.action)) return null;
  const missing =
    subject.role === null
      ? `nothing provides the "${subject.action}" function this step runs`
      : `nothing provides the "${subject.role}" role and this step cannot run`;
  return (
    `No pack is installed, so ${missing}. EO's core knows how to schedule work, dispatch it and record what happened; what a step ` +
    `*does* — its prompt, the shape of its answer, the function behind it, the workspace it runs in and what is verified afterwards ` +
    `— comes from a pack. Install one and this ticket carries on from here.`
  );
}
