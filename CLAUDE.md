# EO — working agreement

EO is a platform for running work through pipelines of agent and human steps. A piece of work is an item; it sits on a step that says who is responsible for it right now — an agent, a person, EO itself or a script — and the routes between steps are data. Software delivery is one pack among several.

> **A note on the word "ticket."** The entity that moves through a pipeline is
> called an **item** in the code, the database, the IPC contract and the schemas
> as of KAN-145 — `items`, `item_deps`, `item_id`, `Item`, `items:*`. The
> developer pack still calls it a *ticket* in every word it shows a person
> ([`ARCHITECTURE.md`](./ARCHITECTURE.md), "Where "ticket" survives"), and the MCP tool names (`ticket_get`,
> `work_submit_ticket`, …) and the module host's `ctx.ticket()` keep the old
> spelling for external callers. So "ticket" below means *item*, and the text
> was left as written rather than rewritten.

**Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) before writing any code.** It is the one design document: what EO is, how it is put together, and why it is shaped the way it is — the core and its packs, pipelines and routes, the engine, both backends, organisation mode, the stack with the alternatives it was chosen over, and the visual design system. Don't relitigate the decisions it records. This file is the working agreement it refers to.

Work is tracked in the maintainer's own tracker, which is not public. The `EO-###` and `KAN-###` keys in commit history and code comments refer to issues there, and each issue states its own scope and acceptance criteria.

The `stories/` folder that preceded it is gone as of August 2026; the 53 files remain in git history if you need to read how something was originally specified.

## Stack

Electron 45 · TypeScript · React 19 · Tailwind v4 · shadcn/ui · @dnd-kit · zustand · TanStack Query · SQLite (better-sqlite3 + Drizzle) · pnpm workspaces + Turborepo · Vitest + Playwright.

## Invariants

These are load-bearing. Code that breaks one of them is wrong even if its own tests pass. If a story seems to require breaking one, stop and ask.

1. **The engine owns transitions.** Agents return results; only `transitionItem()` writes `items.stepId`.
2. **`packages/engine` is pure.** No `node:*`, no `electron`, no DB access. Data in, data out.
3. **`run_events` is append-only.** Never UPDATE, never DELETE — it's the durability substrate. The one exception is deleting the ticket itself (KAN-30): a person asking for a ticket to be gone is not the same as rewriting what happened while it existed. Nothing else may remove a row, and archiving (KAN-33) removes none at all.
4. **Comments are the only communication channel.** No side-channel messaging, no separate inbox table.
5. **Verify, don't trust.** Where the engine can check an agent's claim independently, it must.
6. **`!` / needs-attention is derived, never stored.**
7. **The pipeline graph is data** — the steps and the edges between them. Inserting a `qa` step between Implementer and Reviewer, and wiring what routes into and out of it, must require zero TypeScript. (`workflow_states` is gone: steps are `pipeline_steps` rows and edges are `step_routes` rows.)
8. **Every guard ends in a comment.** Nothing silently drops work on the floor.
9. **Escalation ends the run** — it does not hold a subprocess waiting on a human.
10. **Concurrency stays at 1** until the loop is provably reliable. The one exception is a step the `system` role owns, which a person chose on ASK-56: none of the three caps holds it back (EO-616). Its runs still count as active, so they take up slots against other work, and an item still has one run at a time.
11. **No step-owning agent may widen its own tool surface.** The tool surface is what an agent is dispatched with to act: its MCP servers, its `allowedTools` and the grants in them. An implementer or a reviewer must not be able to decide what it will be dispatched with next. Skills are not the tool surface: they are instructions, and agents may write them — the learning review creates and patches them without a person's approval (EO-718) — answerable instead through every write being a version a person can restore, a person's lock, and the archival of agent skills nobody loads. The system agent is the one exception: it owns no pipeline step, and reconfiguring the installation is the whole of its job — the person's authority delegated, not an implementer reaching sideways mid-run. It is the only agent served the `eo_admin` MCP server, and the grant is a named entry in its `allowedTools`.
12. **A capability reaches both backends, or names the one it does not.** Anything EO hands an agent — an MCP server, a tool named in a prompt, a skill, an affordance in the UI — works the same whichever backend the agent runs on. Parity is work rather than a default, because the two differ in both spelling and delivery: Claude advertises `mcp__repo__x` where Codex sends `repo/x` (EO-198), and Claude reads a generated plugin directory where Codex takes `mcp_servers` inline (EO-203). So a prompt written around one backend's punctuation, or a delivery path only one adapter reads, leaves the other silently without the capability while every test still passes and the agent reports the thing missing on a run where EO believes it was provided. Where a backend genuinely cannot do something — Codex has no way into a turn already running (EO-176) — EO says so where the person choosing the backend will see it, and offers no control that would do nothing. An absence is never left to be discovered by an agent. Two tests hold it (EO-380): `apps/desktop/src/main/providers/providerParity.test.ts` runs both adapters through one shared list of capabilities, so one added to the list fails until both backends pass it; `apps/desktop/src/main/providers/backendBranching.test.ts` holds every line outside `providers/`, `runtimes/` and the sign-in screens that branches on `"claude"` or `"codex"` to a checked-in allowlist that says why.
13. **A pack contributes to the registry, and the core builds without any pack installed.** Two tests, because one was not enough: `packages/engine/src/domainNeutrality.test.ts` greps the engine's non-test sources for `repositoryId`, `.branch`, `worktree`, `"feature"` and `"story"`, since an import-graph check cannot see a domain that arrives as vocabulary; `apps/desktop/src/main/packs/importAllowlist.test.ts` holds every file reaching into `packs/developer/**` to a checked-in allowlist that names the phase each entry leaves in, since "delete the pack directory and typecheck" is the phase-7 exit criterion and not today's.

## Conventions

- TypeScript strict. No `any` — use `unknown` and narrow.
- Zod schemas in `packages/core` are the single source of truth for anything crossing a boundary (IPC, agent output, config).
- IDs are UUIDv7, generated client-side. Never DB autoincrement.
- Errors: return typed results across boundaries; throw only for programmer error.
- Native modules (`better-sqlite3`, `node-pty`) get exactly one import site each, behind an interface.
- Tests live beside the code. Engine logic is unit-tested; anything touching SQLite uses an in-memory DB.

## Ground rules

- **Do not invent scope.** If a story says out of scope, it's out of scope. Note the idea and move on.
- **Acceptance criteria are the definition of done** — every box checked and demonstrable.
- **Tests are part of the story**, not a follow-up.
- **Ask rather than guess.** Ambiguity compounds; a question costs a minute.
- Match existing codebase conventions over personal preference.
- Don't add dependencies not named in the story or in [`ARCHITECTURE.md`](./ARCHITECTURE.md), "The stack", without asking.

## Commands

```bash
pnpm dev         # run the desktop app
pnpm typecheck   # must pass before any story is done
pnpm lint
pnpm test
```
