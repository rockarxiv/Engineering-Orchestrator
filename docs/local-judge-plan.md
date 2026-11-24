# Plan: a local System 1 model in EO, and review triage built on it

**Status:** draft for the maintainer, revised after Phase 0 · **Date:** 2026-11-24
**Phase 0 result:** done; see [local-judge-phase0.md](./local-judge-phase0.md). Kev reliably decides whether the **user-facing, security and rules** reviewers are needed. It cannot decide **impact** or **tests**, so those always run (§12.1). The saving is about one reviewer of six per review.
**Scope of v1:** EO fetches, verifies and runs **one pinned local decision model** (Kev-4B, 4-bit, on llama.cpp). Modules ask it quick questions through a new `ctx` call. The first user is a **Review triage** step that decides whether three of the Review team's passes (user-facing, security, rules) should run. Criteria, impact and tests always run.
**Later (designed for now, built later):** other providers — a hosted System One endpoint ("subscription"), a person's own Ollama, or the person's Claude/Codex sign-in through side calls.

Every file path and function name below was checked against the repository on 2026-11-24. Anything not checked is marked **(verify)**.

---

## 0. Words used in this plan

| Word | Meaning |
|---|---|
| **Judge** | The new capability: a quick, single-step answer to typed questions about a piece of text, with probabilities. The working name avoids "decide", which EO already uses for a person's decision on a user step (`items:decide`, `ipc/decisions.ts`). The final name is an open question (§18). |
| **Judgement** | One request to the judge and its answers. |
| **Decision model** | A model built for judgements rather than chat — Kev (Jared Palmer, Apache-2.0) is the one v1 pins. It returns probabilities from a pointer head over the options, not generated text. They are temperature-scaled on Kev's own training data. llama.cpp's README says they "are not guaranteed to be calibrated for your data", so thresholds are set on EO's own reviews (§13). |
| **System One API** | The wire format Kev's server, TypeSafe's hosted Jev, and llama.cpp's `llama-server` speak (confirmed in Phase 0: [ggml-org/llama.cpp#29818](https://github.com/ggml-org/llama.cpp/pull/29818), merged 2026-10-02). `POST /v1/systemone` takes a `state` and typed `questions`: `noul` yes/no, `choice` and `score`, with options in `criteria`. EO's own contract mirrors it, so later providers that speak it need almost no adapter. The same endpoint serves five decision models (Kev, OpenJev, Laya, Lev, Julia-1). |
| **Provider** | Where judgements are answered: `managed_local` in v1; `system_one_http`, `ollama`, `side_call` later. |

---

## 1. Goals and non-goals

### Goals (v1)
1. A person can install the local judge from EO with one consent, the way they install the Claude or Codex CLI today (ARCHITECTURE.md §12.6): pinned versions, verified hashes, sizes and licences shown first.
2. EO starts the model server when the first judgement needs it, stops it when idle and when EO quits, contains it, and cleans up after a crash. The person never starts or stops anything by hand.
3. A module can ask the judge questions with `ctx.judge(...)`, declared in its manifest and shown at approval, scriptable in its tests.
4. The *Software feature to merge* template gets a **Review triage** step that decides whether the user-facing, security and rules reviewers run. Criteria, impact and tests always run. The Review lead assigns the ones it names and still writes the verdict.
5. Nothing is ever skipped silently: if the judge is missing, off, failing or unsure, triage asks for the full team and says why on the item (invariant 8).
6. Every judgement is recorded, so thresholds can be tuned and, later, Kev can be fine-tuned on this installation's own reviews.

### Non-goals (v1)
- No judge for **agents**. Only modules call it. Serving it to agents would make it a capability under invariant 12 (both backends) and invariant 11 (tool surface), and is a separate decision.
- No **user-chosen model**, no Ollama, no hosted provider, no side-call provider — designed for in §15, not built.
- No judgement on the **organisation server** (it has no machine, `platform.hasMachine === false`): `ctx.judge` answers "unavailable here" there, and triage falls back to the full team.
- No **fine-tuning** inside EO. v1 only records the data that makes it possible (§14).
- The engine package is untouched (invariant 2).

---

## 2. How it fits together

```
                         ┌───────────────────────── EO main process ─────────────────────────┐
 Implement (agent) ──→   │  Review triage (module step)                                       │
                         │    ticket + implementer's summary/handoff (ctx.ticket, ctx.runs)   │
                         │    git diff --name-only / --shortstat   (ctx.exec, needs.bin: git) │
                         │    hard rules in code (Criteria, Impact, Tests always;              │
                         │                        Security on sensitive paths)                │
                         │    ctx.judge({ state, questions })  ──fd 3 event──┐                 │
                         │                                                   ▼                 │
                         │                       JudgeService (src/main/judge/)               │
                         │                         ├─ provider: managed_local                 │
                         │                         │    JudgeServer: ensureRunning()          │
                         │                         │      llama-server (child, contained,     │
                         │                         │      127.0.0.1, random port + API key)   │
                         │                         │    POST /v1/systemone                    │
                         │                         └─ records a `judgements` row              │
                         │    ctx.comment("Reviewers: …")  → returns { ok, result: "triaged" } │
                         └────────────────────────────────────────────────────────────────────┘
 Review (team) ──→ lead reads the triage comment (latestCommentPerStep), assigns those members,
                   merges their reports into the verdict, as today
```

Why a module and not an agent step: a module is code a person approved, its claims are verified like anyone's, its `ctx.exec` and comments are already bounded, and its comment reaches the next step exactly as an agent's does — `latestCommentPerStep` counts "a module's note" as the step's own account (`apps/desktop/src/main/supervisor/stepAttribution.ts:115`).

---

## 3. Invariants this touches, and how the plan keeps them

| # | Invariant | How this plan holds it |
|---|---|---|
| 1 | Engine owns transitions | Triage returns a result; `transitionItem()` routes it. |
| 2 | Engine is pure | Nothing goes in `packages/engine`. |
| 3 | `run_events` append-only | Judgements go in a new append-only table, not `run_events`. |
| 4 | Comments are the item's channel | The reviewer list reaches the lead as a comment on the item. |
| 5 | Verify, don't trust | Sensitive paths, and "Criteria, Impact and Tests always", are code, not the model's judgement. The judge reads what the ticket and the implementer *claim*; the reviewers it sends check those claims against the code. |
| 8 | Every guard ends in a comment | Judge unavailable / failed / unsure → the triage comment says so and names the full team. |
| 9 | Escalation ends the run | No waiting on a person; the judge answers in seconds or fails. |
| 10 | Concurrency at 1 | A judgement is part of the module run that asks it, which already holds the slot. The server answers one request at a time. |
| 11 | No agent widens its tool surface | Agents get nothing new. A module's use of the judge is a declared need a person approves. |
| 12 | Both backends | Not an agent capability in v1. Later side-call provider uses `sideCall`, already in `providerParity.test.ts`. No `"claude"`/`"codex"` comparisons outside `providers/` and `runtimes/` (`backendBranching.test.ts`). |
| 13 | Core builds without a pack | The judge lives in `src/main/judge/` and is domain-neutral (inbox triage could use it). The triage module ships inside the developer template. Nothing outside `packs/developer/` imports from it (`importAllowlist.test.ts`). |

Spawn rule: every `child_process` spawn must set `windowsHide: true` (`apps/desktop/src/main/spawnInvariants.test.ts`), and go through `launchTree` (`apps/desktop/src/main/process/runScope.ts:133`).

---

## 4. Phase 0 — prove it before building (no code merged)

Each step has a clear pass/fail. Phase 1 starts only when 0.1–0.4 pass.

> **Done 2026-11-24** — [local-judge-phase0.md](./local-judge-phase0.md) has the numbers.
> - **0.1 passes:** b12676 with CUDA 13.5 on the RTX 3070. Load 5.3 s, +3.9 GB VRAM. ~3.6 s per triage with the §12.1 state.
> - **0.2 passes:** GitHub publishes a sha256 for each release asset; Hugging Face publishes one per file.
> - **0.3 passes for three passes, fails for two.** User-facing, security and rules: 16% of optional passes skipped with no miss, confirmed on 60 held-out reviews with frozen thresholds. Impact and tests: no better than chance (§12.1, "Why impact and tests always run").
> - Only the input in §12.1 works. The file list and criteria alone did no better than a path rule.
> - 0.4 is still open.

### 0.1 Does `llama-server` really serve Kev's probabilities?
- On the RTX 3070: `llama-server -hf ggml-org/Kev-4B-GGUF:Q4_K_M -ngl 99 -c 8192 --port 8080`.
- `POST /v1/systemone` with one `noul` and one `choice` question.
- **Pass:** a JSON answer with a `noul` probability and `choice` probabilities that move when the text changes. **Fail:** 501, an error, or numbers that never change.
- Record: llama.cpp build number (`bNNNN`), exact flags, load time, VRAM at idle and during a request, p50 latency over 20 requests with a realistic state (file list + criteria, ~1.5k tokens), and the same with `--cache-reuse`/prompt cache if offered.
- **If it fails:** stop. The fallback is Kev's own Python server, which EO should *not* manage (a PyTorch environment per platform, gigabytes). Revisit in §15 as a `system_one_http` provider the person runs themselves, or wait for llama.cpp support.

### 0.2 Can EO fetch it reproducibly?
- llama.cpp release assets: list the asset name per platform and accelerator for the chosen build — Windows x64 CUDA 12, Windows x64 Vulkan, Windows x64 CPU, macOS arm64 (Metal), Linux x64 Vulkan/CPU, Linux x64 CUDA if published **(verify)**. Whether releases publish checksums **(verify)**; if not, EO pins the sha256 it computes at pin time, in its own catalog.
- Model: the GGUF file's exact Hugging Face revision (commit) and its sha256 (the HF API reports one per LFS file **(verify)**). Size 3.03 GB for Q4_K_M per the person's check.
- Licences: llama.cpp MIT; Kev adapter/head Apache-2.0; Qwen3.5 base Apache-2.0 **(verify on the model card)**. Terms URLs for the consent panel.

### 0.3 Is it good enough for triage?
- Take 30–50 past reviews from EO where the six passes ran. For each: file list, shortstat, task; and which passes came back `blocking`/`needs_decision`.
- Ask Kev the five optional questions (§12.1) for each. Compare probabilities with what actually blocked.
- **Pass:** at a threshold where Kev skips at least a third of optional passes, it skips almost none that blocked (target: ≤1 skipped blocking pass in the sample, and that one would have been caught by the hard rules). Pick the starting thresholds here.

### 0.4 Decisions the maintainer makes (CLAUDE.md: ask before adding dependencies)
1. Accept llama.cpp + Kev as a fetched (not bundled) dependency, like the agent CLIs.
2. Accept a long-lived child process. ARCHITECTURE.md §21.3 lists "a second process to start, health-check, and clean up when the app is force-quit" as a cost of the rejected sidecar. That was about EO's own logic, not a model server; this plan pays the cost deliberately and records why (Phase 1).
3. The name (`judge` or another — §18).
4. Organisation mode in v1: "unavailable on the server, fall back to the full team" (this plan's default).

**Exit:** a short note per step with the numbers, attached to the epic.

---

## 5. Phase 1 — write the decision down

- **ARCHITECTURE.md**: a new subsection under §12 (beside "Runtimes and sign-in"), "12.7 The local judge": what it is, why a decision model and not a chat model, why fetched not bundled, the server's lifecycle, the provider seam, why agents don't get it yet, and the organisation-mode gap. A paragraph in §21 on why the long-lived server is accepted despite §21.3.
- **The stack line** in ARCHITECTURE.md ("The stack") names llama.cpp and Kev as fetched components.
- **docs/**: a short user-facing page later (Phase 7), not now.
- **Tracker**: the epic and the issues in §16, each with its acceptance criteria copied from this plan.

---

## 6. Phase 2 — the contract (`packages/core`)

Zod is the source of truth for anything crossing a boundary (CLAUDE.md). New file `packages/core/src/judge.ts`, exported from the package index.

### 6.1 Request and answer

```ts
// Mirrors the System One API so providers that speak it need no translation.
// Options go in `criteria`, as llama-server's /v1/systemone takes them (checked in Phase 0).
export const JudgeQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"),   instructions: z.string().min(1).max(2000),
             criteria: z.object({ true: z.string().max(200), false: z.string().max(200) }).optional() }),
  z.object({ type: z.literal("choice"), instructions: z.string().min(1).max(2000),
             criteria: z.record(z.string().min(1).max(200), z.string().max(200).nullable())   // option → description
               .refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 255) }),
  z.object({ type: z.literal("score"),  instructions: z.string().min(1).max(2000),
             criteria: z.array(z.string().min(1).max(200)).min(2).max(10) }),          // levels, lowest first
]);
// On the wire, a noul answer is { noul: p }, and a score answer is { score: expected level, legend, probabilities }.
// The provider maps them to JudgeAnswerSchema below.

export const JudgeRequestSchema = z.object({
  state: z.string().min(1).max(JUDGE_MAX_STATE_CHARS),          // e.g. 24_000 chars ≈ 6k tokens, under Kev's 8k
  questions: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), JudgeQuestionSchema)
               .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= JUDGE_MAX_QUESTIONS), // e.g. 16
});

export const JudgeAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"),   probability: z.number().min(0).max(1) }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number()), confidence: z.number() }),
  z.object({ type: z.literal("score"),  level: z.number().int(), probabilities: z.array(z.number()), confidence: z.number() }),
]);

export const JudgeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), answers: z.record(z.string(), JudgeAnswerSchema),
             provider: JudgeProviderIdSchema, model: z.string(), calibrated: z.boolean(),
             latencyMs: z.number().int(), judgementId: z.string() }),
  z.object({ ok: z.literal(false), reason: JudgeFailureReasonSchema, message: z.string() }),
]);

export const JudgeFailureReasonSchema = z.enum([
  "not_installed", "disabled", "unavailable_here",     // organisation server, no machine
  "starting_failed", "out_of_memory", "crashed",
  "timeout", "invalid_request", "invalid_answer", "busy", "cancelled",
]);
export const JudgeProviderIdSchema = z.enum(["managed_local"]); // later: "system_one_http", "ollama", "side_call"
```

- `calibrated` is in the answer from day one. It means the provider returns real probabilities from a decision head: Kev's are, a generative provider's (later) are not, and a module must be able to tell. It does **not** mean they're calibrated for EO's questions. llama.cpp says so plainly, and Phase 0's useful thresholds ranged from 0.2 to 0.75 by pass. So thresholds are per question and set from data (§13).
- **Cost is questions × state tokens.** Each question re-reads the whole state, and the prompt cache doesn't help (Phase 0). Keep the question count small.
- `provider`, `model` and `judgementId` give every answer its provenance; the triage comment prints them.
- Limits are constants in `packages/core/src/limits.ts` beside `DEFAULT_MODULE_TIMEOUT_MS`.

### 6.2 Settings

```ts
export const JudgeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: JudgeProviderIdSchema.default("managed_local"),
  accelerator: z.enum(["auto", "cuda", "metal", "vulkan", "cpu"]).default("auto"),
  gpuLayers: z.number().int().min(0).max(999).default(999),   // -ngl; lowered automatically on VRAM failure
  idleStopMinutes: z.number().int().min(1).max(240).default(10),
  requestTimeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
  recordState: z.boolean().default(true),                     // keep the judged text for tuning/training (§14)
});
```

Stored per machine with `getSetting`/`setSetting` (`db/repos/settingsRepo.ts:6,21`) under a key like `"machine.judge"`, read/written by `readJudgeConfig`/`writeJudgeConfig` beside `readGuards`/`writeGuards` (`ipc/configCommands.ts:169,224`). It is machine configuration (a GPU is a machine's), so it belongs to the **machine half** of the contract, not the record half where `guards:*` live.

### 6.3 IPC channels (machine half, `packages/core/src/ipc.ts` `machineContract`, ~:7268)

| Channel | Request → response | Notes |
|---|---|---|
| `judge:status` | `{}` → `JudgeStatus` | installed artifacts + versions, accelerator detected/selected, server state (`absent`, `stopped`, `starting`, `running {port, pid, vramMb?}`, `failed {reason, message, at}`), last judgement latency, disk used |
| `judge:describe` | `{}` → what would be fetched | per artifact: name, publisher, version/revision, size, licence, terms URL, source URL, problem (unsupported platform). The only channel that touches the network before consent, like `runtime:describe` |
| `judge:install` | `{ accelerator? }` → stream/progress id | only after `describe` was shown and agreed, like `runtime:install` |
| `judge:installProgress` | `{ id }` → bytes done/total, phase | 3 GB needs progress; the npm path never did **(new)** |
| `judge:cancelInstall` | `{ id }` → `{}` | |
| `judge:remove` | `{}` → `{}` | stops the server, deletes the files |
| `judge:getConfig` / `judge:setConfig` | `JudgeConfig` | |
| `judge:start` / `judge:stop` | `{}` → `JudgeStatus` | manual control for the settings screen; normal use never needs them |
| `judge:try` | `{ state?, questions? }` → `JudgeResult` | "Run a test judgement" on the settings screen, with a built-in sample |

Each new channel must also be:
- listed in `packages/core/src/ipc.test.ts` (the sorted machine-half list, ~:95–140);
- registered in `apps/desktop/src/main/ipc/handlers.ts`, and answered (`ipc/handlers.test.ts:61`);
- either an MCP tool or in `NOT_CATALOGUED_MACHINE` with a real reason (`apps/desktop/src/main/mcpHost/catalog.test.ts:589`). Suggest: `judge:status` and `judge:try` catalogued read/act tools for the system agent later; all others not catalogued in v1 ("machine installation, needs a person's consent").

**Acceptance (Phase 2):** schemas exported and unit-tested (limits, discriminators, failure reasons); channels in the contract; `pnpm typecheck` and the contract tests pass with stub handlers answering `not_installed`.

---

## 7. Phase 3 — fetch and verify the artifacts (`src/main/judge/install/`)

### 7.1 Reuse, don't copy
EO already has a GitHub-release + sha256 installer: CodeWiki's, in `apps/desktop/src/main/packs/developer/repositoryIntelligence/binary/` (`assetUrl`, `checksumUrl`, `parseChecksum`, `matchesSha256`, `fetchChecksum`, `installCodeWiki`, `pruneSupersededInstalls`, zip support). The judge must not import it from the pack (`importAllowlist.test.ts`). So, first, a small refactor issue:
- Move the pack-neutral pieces (sha256 check, checksum parsing, download-verify-extract-rename, prune) to `apps/desktop/src/main/downloads/`, beside `runtimes/tar.ts` and `FetchLike` (`runtimes/install.ts`).
- CodeWiki imports them from there (the pack importing core is allowed).
- Add what both lack: **streamed download with progress and resume** (Range requests) for multi-GB files, and **free-disk check** before starting.

### 7.2 Catalog (`src/main/judge/catalog.ts`)

```ts
export interface JudgeServerSpec {               // llama.cpp
  repository: "ggml-org/llama.cpp";
  build: string;                                  // e.g. "b7xxx" — pinned in Phase 0.2
  assetFor(platform, arch, accelerator): { name: string; sha256: string; format: "zip" | "tar.gz" } | null;
  binaryName(platform): string;                   // "llama-server" / "llama-server.exe"
  licence: { name: "MIT"; url: string };
}
export interface JudgeModelSpec {                 // Kev-4B Q4_K_M
  id: "kev-4b-q4_k_m";
  source: { repo: "ggml-org/Kev-4B-GGUF"; revision: string; file: string };   // revision pinned
  sha256: string; bytes: number;                  // ~3.03 GB
  contextTokens: 8192;
  licence: { name: "Apache-2.0"; url: string }; publisher: "Jared Palmer (Kev)";
}
```

- `unsupportedReason(platform, arch, accelerator)` names the gap plainly (e.g. "No CUDA build for Linux in this release; Vulkan or CPU will be used").
- Accelerator **auto-detection** (`src/main/judge/accelerator.ts`): Apple Silicon → `metal`; NVIDIA driver present → `cuda` (Windows) or `vulkan` (Linux, unless a CUDA asset exists); otherwise `vulkan` if available, else `cpu`. The person can override.

### 7.3 On disk
- `<userData>/judge/server/llama.cpp@<build>-<accelerator>/…`
- `<userData>/judge/models/<model-id>@<revision>.gguf`
- Written to `*.partial`, verified, then renamed into place (as `installRuntime` does, `runtimes/install.ts:115`). A superseded version is pruned once nothing references it.

### 7.4 Consent (renderer)
- Reuse the shape of `ConsentPanel` (`renderer/src/chat/views/agents/runtime.tsx:126`): publisher, version, size, licence, terms link — for **both** artifacts, with the total (~3.1 GB + the server zip) and free disk space.
- Then a progress bar fed by `judge:installProgress`, cancellable, resumable after an EO restart.

**Acceptance (Phase 3):** on each supported platform the install fetches exactly the pinned files, refuses any byte that doesn't match its sha256 (test with a tampered fixture), survives a cancel and a restart mid-download, prunes the old version, and shows a plain reason on an unsupported platform. Tests use a fake `FetchLike`; nothing hits the network.

---

## 8. Phase 4 — run the server (`src/main/judge/server.ts`)

### 8.1 Lifecycle

| Moment | What EO does |
|---|---|
| EO starts | Nothing runs. A startup sweep removes a server left by a crashed EO (§8.3). |
| First judgement | `ensureRunning()`: one start at a time (a mutex; concurrent callers wait on the same start). |
| Start | Pick a free loopback port; generate a 32-byte API key; spawn `llama-server --model <gguf> --host 127.0.0.1 --port <p> --api-key <k> -ngl <gpuLayers> -c 8192 -np 1 --no-webui` (no prompt-cache flags: off by default for decision models, and no gain in 0.1). Check `GET /v1/models` reports `output_modalities` containing `"decisions"` before the first judgement through `launchTree` with `windowsHide: true`; poll `GET /health` until ready (timeout e.g. 60 s for a cold model load). |
| Each judgement | One request at a time (EO queues); `POST /v1/systemone` with `Authorization: Bearer <k>`; per-request timeout from config; reset the idle timer. |
| Idle `idleStopMinutes` | Stop the server (graceful, then `killTree` after `END_PROCESS_GRACE_MS`, `process/endProcess.ts:43`). The idle timer is `unref`'d, as the warm-backend timers are (`providers/codexClient.ts:520–537`). |
| EO quits | Stop it from `stopBackgroundServices` (`startMain.ts:826–841`), which the shutdown coordinator already runs; also from the engine's `shutdown()` path if judgements are in flight. |
| Crash | Mark `failed {crashed}`, fail in-flight judgements with `crashed`, restart on the next judgement; after 3 crashes in 10 minutes stop retrying until a person presses Start or EO restarts, and say so on the settings screen. |
| Out of GPU memory at load | Retry once with `gpuLayers` lowered (e.g. half, then 0 = CPU) and report it in status ("running on CPU: the GPU had too little free memory"). Never silently: the status line and the next triage comment name the slower path. |
| Out of system memory | On Linux with systemd, give it a scope with a memory limit (as runs have, EO-738) and read `outOfMemory`; elsewhere, report the exit. |

### 8.2 Containment
- `launchTree(name, command, args, env, cwd, scope)` plans the spawn (`runScope.ts:133`); the `RunScopes` interface only needs a key string, so file the server under its own key (e.g. `judge:server`) the way warm processes use `warm:<itemId>` (`runSupervisor.ts:7416`).
- Environment: an empty-but-for-what-it-needs env (PATH, GPU driver variables), never EO's secrets.
- Mark the process with the `EO_PROCESS_TREE` marker (`process/processTree.ts:86`) so the sweep can recognise it.

### 8.3 Crash leftovers (new: EO has directory sweeps, not process sweeps)
- On start, EO writes `<userData>/judge/server.json`: pid, port, start time, executable path.
- On EO start, if that file exists and that pid is alive **and** its executable/command line matches the recorded one, stop it; then delete the file. A pid reused by an unrelated process is never killed.

### 8.4 Where it doesn't run
- **Organisation server** (`platform.hasMachine === false`, `ipc/platform.ts:196`): no install, no server; every judgement answers `unavailable_here`.
- **Unsupported platform/accelerator:** status says why; judgements answer `not_installed` with that reason.

**Acceptance (Phase 4):** starts on first use and only then; answers a sample judgement; stops after the idle time and on quit (tested through the shutdown coordinator); a crash leftover from a killed EO is stopped on the next start and an unrelated process with a reused pid is not; a forced GPU out-of-memory falls back with a visible status; `spawnInvariants.test.ts` passes. Process tests use a scripted fake server binary, as the provider tests use scripted CLIs.

---

## 9. Phase 5 — the judge service and its record (`src/main/judge/service.ts`)

### 9.1 Provider seam (built now, one implementation)

```ts
export interface JudgeProvider {
  id: JudgeProviderId;
  status(): Promise<JudgeProviderStatus>;
  judge(request: JudgeRequest, signal: AbortSignal): Promise<JudgeResult>;   // never throws
}
```
- `managedLocalProvider` = `JudgeServer` + HTTP + Zod-validated answer → `JudgeResult` (`calibrated: true`).
- `JudgeService.judge(request, { itemId, runId, purpose, signal })` picks the provider from config, enforces limits, records the judgement, and returns the result. A table keyed by provider id, never a `switch` on backend names (keeps `backendBranching.test.ts` quiet when side calls arrive).

### 9.2 Record every judgement (new table, append-only)
`judgements`: `id` (UUIDv7, client-side), `created_at`, `item_id`, `run_id`, `purpose` (e.g. `"module:<slug>@<version>"`), `provider`, `model`, `calibrated`, `questions` (JSON), `state` (text, or null when `recordState` is off), `state_sha256`, `answers` (JSON) or `failure_reason`, `latency_ms`.
- Drizzle schema + migration; deleted only with the item (as invariant 3's exception allows for item deletion), otherwise never updated or deleted.
- Shown on the run's transcript as one line ("Judge: 5 questions, 0.4 s, Kev-4B") so a person can see a module used it.

**Acceptance (Phase 5):** a judgement through the service writes exactly one row; failures write a row with the reason; an aborted run cancels its in-flight judgement (`cancelled`); limits are enforced before anything is sent; the row carries enough to rebuild the request for training.

---

## 10. Phase 6 — `ctx.judge` for modules

### 10.1 Manifest
- Add `judge: z.boolean().default(false)` to `ModuleNeedsSchema` (`packages/core/src/schemas/modules.ts:37`) and the default object (:114).
- Approval shows it ("Asks the local judge"). A trial grant records it (the grant's covered needs, ARCHITECTURE.md §4.6), so asking for it after the grant withdraws the grant, as any wider need does.
- Allowed for entry checks (read-only) and intake checks: decide in review; default **yes**, it reads nothing secret and writes nothing.

### 10.2 Host side (`apps/desktop/src/main/modules/moduleHost.mjs`)
- `ctx.judge({ state, questions }) → Promise<JudgeResult>`, never throws (like `ctx.comment`, :2557).
- Refused in the host when the manifest doesn't declare `needs.judge` (like `needs.bin` in `makeExec`, :1588).
- Transport: an **asynchronous** request/reply like `ctx.createItem`'s creation channel (fd 5, `makeCreationChannel` ~:2792–2900), not the synchronous fd-6 read — a judgement can take seconds while the server starts. Event `{ type: "judge", id, request }` on fd 3; signed reply on fd 5.
- Per-run cap (e.g. 20 judgements), counted in the host and again in the parent.

### 10.3 Parent side (`apps/desktop/src/main/modules/runModule.ts`)
- Handle the `judge` event next to `read`/creation (:1224); call `JudgeService` injected through `ModuleHostLauncher` (:450) the way `items: moduleItemReader(...)` is (`engine.ts:375–395`); answer signed.
- Tie each judgement to the module's timeout and cancellation (:1304–1320): the remaining module time bounds the judgement's timeout.
- On the organisation server, answer `unavailable_here` without touching anything.

### 10.4 Tests (`harness.run`)
- New fixture `judge`: a list of scripted results consumed in order, each `{ questions?: string[] /* keys it must match */, result: JudgeResult }`. An unscripted call fails the case, naming the questions (like `exec`, :248–251).
- Add `"judge"` to `FIXTURE_NAMES` (:3149) with a hand-written validator beside the others (:3140–3330).
- `harness.run` returns `judgements: [{ request, result }]` beside `execs`.
- Update the duplicated fixture docs: the host header (:97–270), the `module_test_save` tool description (`mcpHost/catalog.ts:4280–4320`), and the system agent's prompt (`packs/developer/prompts/system-agent.md:1016–1080`).

**Acceptance (Phase 6):** a module without `needs.judge` is refused at the call; with it, a scripted test passes and an unscripted call fails; a live run records a `judgements` row tied to the run; a cancelled run cancels its judgement; the system agent can write and test a judging module from its prompt alone.

---

## 11. Phase 7 — the settings screen

A section **"Local judge"** — in Settings beside Guardrails (`renderer/src/chat/views/settings/sections/`), or as a row in Agents → Runtimes (`RuntimesPanel.tsx:27`); the maintainer picks (§18).

- **Status line:** Not installed · Installing 1.2 / 3.1 GB · Stopped (starts when needed) · Running on GPU — 3.8 GB · Running on CPU (why) · Failed (why, when).
- **Install** → consent panel (§7.4) → progress → done. **Remove.** **Enable** switch.
- **Settings:** accelerator (auto + detected value), idle stop minutes, keep judged text (`recordState`).
- **Try it:** runs `judge:try` with a sample, shows each answer, probability and latency.
- Organisation server: the section says the judge runs on people's own machines, not on the server, and triage there uses the full team.
- Follows ARCHITECTURE.md's visual design system; strings plain, no model jargon beyond the model's name.

**Acceptance (Phase 7):** every server state above is reachable in a Playwright test against a fake server; install consent cannot be skipped; the screen never offers a control that does nothing on the current platform (invariant 12's spirit).

---

## 12. Phase 8 — Review triage in the software template

### 12.1 The module ("Review triage")
Manifest:
```json
{
  "name": "Review triage",
  "description": "Decides whether the user-facing, security and rules reviewers of the Review team look at this change. Criteria, impact and tests always do.",
  "results": ["triaged"],
  "needs": { "bin": ["git"], "item": true, "comment": true, "judge": true },
  "inputs": {
    "mode":              { "type": "string", "default": "shadow", "description": "shadow: name everyone, report what would be skipped. enforce: name only the picked reviewers." },
    "userFacingThreshold": { "type": "number", "default": 0.4, "description": "Phase 0: no miss in 120 reviews at 0.4 (16% skipped); 0.75 skipped 22–23% with one miss." },
    "rulesThreshold":    { "type": "number", "default": 0.65 },
    "securityThreshold": { "type": "number", "default": 0.2 },
    "sensitivePaths":    { "type": "string", "default": "auth|permission|session|token|secret|crypt|sanitiz|password|oauth|\\.env|migrations?/|package\\.json|pnpm-lock|yarn\\.lock|Cargo\\.(toml|lock)|go\\.(mod|sum)|requirements.*\\.txt" }
  }
}
```

Behaviour, in order:
1. **Facts from git** (`ctx.exec("git", …)` in the item's worktree, `ctx.cwd`): `--name-only` and `--shortstat` against `ctx.workspace.git.baseBranch`, including uncommitted changes. `ctx.exec` keeps the *tail* of stdout, so cap and say so ("+312 more files") rather than trust a long list **(verify the tail size)**.
2. **Hard rules (code):** Criteria, Impact and Tests reviewers always (see "Why impact and tests always run" below). Security reviewer when any path matches `sensitivePaths`. **Sticky:** any reviewer whose pass came back `blocking` or `needs_decision` in this item's previous review round is kept — read with `ctx.runs(key)` (ARCHITECTURE.md §4.6, EO-710).
3. **What the work says it is.** Read with `ctx.item()`: the whole ticket (title, description, acceptance criteria, the spec's `touches`). Read with `ctx.runs(key)`: the implementer's account, meaning the `summary` and `handoff` in the `answer` of the latest succeeded `implement` run (`moduleRunsView` passes the parsed result, `ipc/domainQueries.ts:1247`). Then a short "what the diff actually touches" section from step 1: UI files, shared contracts, source files with no matching test file, and the capped file list. Caps used in Phase 0: description 5,000 chars, criteria 4,000, summary 3,500, handoff 3,500, 60 files. That's ~2k tokens median and ~4k at most, under Kev's 8k.
4. **Judgement:** one `noul` question each for User-facing, Rules and Security (if not already forced), asked about what the work *claims*, so the reviewer it sends verifies the claim. The Phase 0 wording, which these thresholds belong to:
   - user_facing: *"Do the story or the implementer's account say this work changes what a person sees or reads: a screen, a card, a button, a message, wording, CLI output, a public API or docs?"*
   - rules: *"Do the story or the implementer's account involve the repository's written rules or architecture invariants, such as the engine, comments, guards, run events, pipelines, agents' tools, prompts or the organisation record?"*
   - security: *"Do the story or the implementer's account involve authentication, permissions, input handling, secrets, network or file-system access, or dependencies?"*

   This catches the commonest UI miss, a change that *should* have touched the UI and didn't (EO-776, EO-798 in Phase 0): the ticket and the handoff mention the board, so the reviewer goes and finds it unchanged. The file list or diff alone did no better than a path rule.
5. **Pick:** a reviewer is picked when its probability ≥ its threshold.
6. **Fail closed:** any `ok: false` → every optional reviewer is picked; the comment says why (e.g. "The local judge isn't installed on this machine, so the full team reviews").
7. **Mode:** `shadow` names all six reviewers but lists which the judge *would* have skipped; `enforce` names only the picked ones.
8. **Comment** (`ctx.comment`), machine-readable first line, human reasons after:
   ```
   Reviewers: Criteria reviewer, Impact reviewer, Tests reviewer, Security reviewer
   - Criteria, Impact, Tests reviewers: always run
   - Security reviewer: sensitive path changed (src/auth/session.ts)
   Skipped: Rules reviewer (0.31), User-facing reviewer (0.12)
   Judge: Kev-4B Q4 (local), 3.4 s
   ```
9. Return `{ ok: true, result: "triaged" }`.

**Why impact and tests always run** (Phase 0, 120 reviews): Kev's answers for these two were no better than chance (impact AUROC 0.56–0.57; tests 0.44–0.76 on 3–5 cases). Two reasons, and both would hold for any model given this input:
- **The subject is in almost every EO change.** Kev said "yes, shared behaviour" on 70–82% of reviews whose impact pass found nothing, and "needs tests" on 95–100%. That's true: EO's stories nearly all touch contracts, sync or the record, and nearly all change behaviour. A relevance question that is always yes can't skip anything. Impact is also the commonest block (8–22% of reviews), so a skip there costs most.
- **What decides a block isn't in any text triage reads.** Impact blocks are side effects on code paths nobody mentions. EO-830's other callers still wrote unprotected paths, and EO-833's rollback still fired comment events. Those stories *read* as local fixes, which is why they scored lowest (0.27–0.49). Tests blocks are about what a test actually exercises: one scripted provider standing in for both backends (EO-868), a faked nested call (EO-845), a test that never calls `releaseRun` (EO-813). That needs the test code and the code under test, side by side. The only check is the review itself.

If these are ever triaged, it shouldn't be by a quick judgement over text. Deterministic checks would be the honest tool. For impact: callers of changed exported symbols that the diff doesn't touch, from CodeWiki's index. For tests: changed source with no test exercising it. Those are code, not a model, and a separate design.

Test cases (all scripted; approval requires them):
- sensitive path forces Security regardless of the judge;
- Criteria, Impact and Tests are named on every run, whatever the judge answers;
- the state carries the ticket's description and the implementer's summary and handoff; with no implement run, it says so and triage still runs;
- high/low probabilities pick/skip as thresholds say;
- judge `not_installed`, `timeout`, `unavailable_here` → full team with the reason;
- sticky reviewer from a previous blocking report is kept;
- shadow vs enforce wording;
- no changed files → Criteria only, with a note;
- very long file list → capped, says how many were left out.

### 12.2 The template (*Software feature to merge*, 1.8 → 1.9)
- Embed the module in the template's `modules` array — the export schema allows it (`packages/core/src/schemas/pipelineExport.ts:872`) but **no template has done it yet**, so verify the install path: does installing a template with a module create it unapproved and ask the person to approve, or install it approved? **(verify — likely its own issue.)**
- Insert step `review_triage` (type module) between `todo` (Implement) and `review`: retarget the route from `todo` that goes to `review` onto `review_triage`; add `review_triage —triaged→ review`. Every other route unchanged — including `review —changes_requested→ todo`, so each new round is triaged again (with the sticky rule).
- **Lead reviewer's team instructions** (the "the leader reads the change, then assigns" text in the template, docs/teams.md:221–223): replace "on every review, a pass on…" with: *assign the reviewers the Review triage comment names on its `Reviewers:` line, by name; you may add a reviewer when you see a reason, saying why; never leave out one it names; if there is no triage comment, assign the four standing passes as before.* The last clause keeps items that predate 1.9, and pipelines without the step, behaving as today.
- **Fallback is today's behaviour:** with the judge missing, triage names the full team and the lead assigns them — so 1.9 is safe for every installation, judge or not.
- Template history: add `resources/gallery/history/software-feature-to-merge/1.9`.

### 12.3 Tests to update
- `apps/desktop/src/main/gallery/templateTeam.test.ts`: version `"1.9"` (:141); the leader's pass lines (:214–235) to the new wording.
- `apps/desktop/src/main/packs/developer/reviewTeam.test.ts`: the scripted leader reads assignments from the leader instructions — extend it to read a triage comment, and add a case where triage names three reviewers and the lead assigns exactly those; keep the "approves over a blocking report and is refused" case.
- Template update tests (`gallery/templateUpdates.test.ts`, `gallery/history.test.ts`): 1.8 → 1.9 updates cleanly; a person's edited Review step is held as a conflict as today.
- A new end-to-end test: implement → triage (scripted judge) → review with only the picked members → verdict, on Claude, Codex and both (as `reviewTeam.test.ts` does).

**Acceptance (Phase 8):** with the judge installed and `enforce`, a small change runs fewer members and the verdict still routes; with no judge, the review is identical to 1.8; shadow mode changes nothing but the comment; every test above passes on both backends.

---

## 13. Phase 9 — roll out safely and measure

1. **Shadow first.** Ship 1.9 with `mode: shadow`. For the first N reviews (e.g. 50) every reviewer runs, and the comment records what would have been skipped.
2. **Measure** from `judgements` + team reports: for each skipped-in-shadow reviewer, did its report block? Target: no blocking report among the would-be-skipped, beyond what the hard rules catch. Also: average members per review, judge latency, judge failures by reason.
3. **Tune** `userFacingThreshold`, `rulesThreshold` and `securityThreshold` per installation from that data (step inputs, no code). The defaults come from Phase 0. They hold only for the question wording in §12.1, so changing a question means re-measuring.
4. **Enforce** by changing the step input to `enforce` — a pipeline edit a person publishes.
5. A small read-only report (a module or a saved query, later a screen) showing members saved per week and any blocking report the judge would have skipped.

---

## 14. Phase 10 — later: fine-tune on this installation's reviews (not v1)
- Export `judgements` joined with each review's pass outcomes as Kev's JSONL training format (one record per review; label per question = "that pass came back blocking").
- Kev's own tooling trains an adapter (~$1 on a rented H100 per its README; ~1,000 records gave a measurable gain, ~400 did not).
- EO pins the resulting GGUF by sha256 as a second model in the catalog — which is also the first step toward "bring your own model".

---

## 15. Later providers (designed now, built later)

The seam in §9.1 and the `calibrated` flag make each of these an adapter plus settings, with no change to modules.

| Provider | What it is | Calibrated? | Works on org server? | Data leaves the machine? | Effort | Notes |
|---|---|---|---|---|---|---|
| **`system_one_http`** ("subscription") | Any endpoint speaking the System One API: TypeSafe's hosted Jev (paid), a team's own `kev.serve` on a GPU box, a hosted Kev if one offers the API **(verify OpenRouter)** | Yes | **Yes** — fixes the v1 gap | Yes (to that endpoint) | Small: same wire format; URL + API key | Key stored encrypted through `SecretStore` (`secrets/store.ts:26`), never in the DB (§14.2). Consent screen names where text goes. Organisation-scoped setting. |
| **`ollama`** | The person's own Ollama (`localhost:11434`) with any model they pulled | **No** (generative; JSON-schema enum via `format`; logprobs if Ollama exposes them **(verify)**) | Only if the server runs Ollama | No | Medium: map questions to a schema-constrained generation, answers to 0/1 or logprob-based scores | Kev's classifier head isn't served by Ollama, so this is a different kind of answer; thresholds must be set separately. gutcheck-bench's generative baseline (Qwen3 8B via Ollama) was wrong 17.3% of the time when ≥90% confident vs Kev-4B's 0.1% — say so in the UI. |
| **`side_call`** | The person's Claude/Codex sign-in, through EO's existing side calls (`sideCalls/sideCall.ts`, `createSideCaller` :262) | No | Where a sign-in is | Yes (to Anthropic/OpenAI) | Small–medium: add `judge` to `SIDE_CALL_PURPOSES` (`packages/core/src/side-calls.ts:26`), a model class (`small`, i.e. `DEFAULT_CLAUDE_SMALL_MODEL`), a spend group; expose a narrow caller to `JudgeService` (today only the supervisor holds it, `runSupervisor.ts:2225`) | Zero-install fallback; counts against plan limits; seconds, not milliseconds. Both backends for free — `sideCall` is already in `providerParity.test.ts`. |

**Recommended order:** `system_one_http` first (smallest change, true System 1, and it closes the organisation-mode gap), then `side_call` as a zero-install fallback, then `ollama` for people who already run it.

What the provider choice changes for a person: one "Provider" picker in the Local judge section; per-provider thresholds in triage (because `calibrated` differs); the triage comment always names the provider and whether its numbers are calibrated.

---

## 16. Issue breakdown and order

| # | Issue | Depends on | Size |
|---|---|---|---|
| 0 | Spikes: llama.cpp serves Kev; pin assets and hashes; accuracy on 30–50 past reviews; maintainer decisions | — | S |
| 1 | ARCHITECTURE.md §12.7 + §21 note + stack line | 0 | S |
| 2 | Move CodeWiki's pack-neutral download/verify helpers to `src/main/downloads/`; add progress, resume, disk check | — | M |
| 3 | Core contract: `judge.ts` schemas, limits, config, machine-half channels + contract tests | 1 | M |
| 4 | Catalog + accelerator detection + install (`src/main/judge/install/`) | 2, 3 | M |
| 5 | Server lifecycle: start on demand, idle stop, quit, crash/OOM handling, leftover sweep | 4 | L |
| 6 | `JudgeService`, provider seam, `judgements` table + migration, transcript line | 5 | M |
| 7 | `ctx.judge`: manifest need, host + parent transport, limits, harness fixture, docs in three places | 6 | L |
| 8 | Settings section: status, consent, progress, try-it, config | 3, 5 | M |
| 9 | Embedding a module in a gallery template: install + approval path | — | M **(verify scope)** |
| 10 | Review triage module + its tests | 7 | M |
| 11 | Template 1.9: step, routes, lead instructions, history, test updates, e2e on both backends | 9, 10 | M |
| 12 | Shadow-mode report and threshold tuning; switch to enforce | 11 + 50 reviews | S |
| later | `system_one_http` · `side_call` · `ollama` providers · fine-tuning export · `ctx.judge` for agents | 6 | — |

Issues 2, 3 and 9 can start in parallel. The critical path is 0 → 3 → 4 → 5 → 6 → 7 → 10 → 11.

---

## 17. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| llama.cpp doesn't actually serve Kev's head | No managed path | Phase 0.1 gates everything; fallback is a `system_one_http` provider pointed at a person-run `kev.serve` |
| Kev under-calls a risky change | A needed reviewer skipped | Impact and tests are never judged (§12.1); hard rules for sensitive paths; sticky reviewers; low security threshold; shadow mode first; lead may add reviewers |
| The saving doesn't pay for the machinery | ~1 of 6 reviewer passes saved per review (Phase 0), for a 3 GB install, a GPU process and ~4 s per triage | Ship shadow mode and measure members saved per week (§13.5) before enforcing; the judge's other users (inbox routing, "is this about X") may carry more of the cost |
| 3 GB download on poor connections | Install fails or annoys | Resume, progress, cancel; never auto-download |
| GPU memory contention (games, other apps) | Load failure or slow CPU fallback | Lazy start, idle stop, automatic layer reduction with a visible status |
| A second long-lived process (§21.3's cost) | Orphans, "failed to start" states | Lazy, contained, swept, status always visible; judgement failure never blocks work |
| New projects with little history | Accuracy check (0.3) is thin | Start in shadow; hard rules carry the risky cases |
| Kev is new (Sept 2026), one maintainer | Upstream churn or abandonment | Pinned version and hash; provider seam lets EO switch to another System One endpoint or model |
| Template embedding of modules is untested territory | Install friction | Its own issue (#9) before the template change |

---

## 18. Open questions for the maintainer

1. **Name:** `judge` / `ctx.judge`, or another (`quickJudgement`, `systemOne`, `classify`)? "decide" is taken.
2. **Where the settings live:** Settings → "Local judge" section, or a row in Agents → Runtimes beside Claude and Codex?
3. **Install prompt:** offered from the template (when Review triage first runs without a judge, the comment links to the install), from settings only, or both?
4. **Entry checks and intake modules:** may they use `ctx.judge` in v1?
5. **Recording the judged text** (`recordState` default on): fine on a person's own machine; what on an organisation's record?
6. **Shadow → enforce:** a person flips it per pipeline, or EO suggests it once the shadow report is clean?
7. **Should agents ever call the judge?** If yes, it becomes a capability under invariants 11 and 12 — a separate design.
