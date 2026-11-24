# Local judge — Phase 0 results

**Date:** 2026-11-24 · **Plan:** [local-judge-plan.md](./local-judge-plan.md) §4 · **Machine:** RTX 3070 Laptop (8 GB), CUDA 13.5, Linux
**Spike files:** `~/.cache/eo-judge-spike/` (scripts, dataset, labels, raw answers; 3.4 GB with the model)

**Verdict:** 0.1 and 0.2 pass. **0.3 passes for part of the team.** Given the whole ticket and the implementer's account, Kev-4B reliably decides whether the user-facing, security and rules reviewers are needed: 16% of optional passes skipped with no miss, confirmed on 60 held-out reviews with frozen thresholds. It can't decide impact or tests, so those always run. On the file list and diff the plan proposes, it's no better than a path rule. See "Conclusion" at the end.

---

## 0.1 Does `llama-server` serve Kev's probabilities? — pass

- llama.cpp **b12676** (`1.0.0-dev`, commit `d35dc4d9e`), asset `llama-b12676-bin-ubuntu-cuda-13.5-x64.tar.gz`. `/v1/systemone` landed in [ggml-org/llama.cpp#29818](https://github.com/ggml-org/llama.cpp/pull/29818), merged 2026-10-02.
- Flags: `-m Kev-4B-Q4_K_M.gguf --host 127.0.0.1 --port <p> --api-key <k> -ngl 99 -c 8192 -np 1 --no-webui`. `/v1/models` reports `output_modalities: ["decisions"]` — a clean way to check the loaded model is a decision model.
- Load: **5.3 s** (file in page cache; a cold disk load will be longer). VRAM: **+3.9 GB** idle, ~5.1 GB total peak on the card during requests.
- Probabilities move with the text: a docs typo fix → security 0.03; an OAuth token change → 0.70.
- Latency, 5 `noul` questions, 20 real triage states (title + criteria + file list, ~700 tokens each):

  | State | Input tokens (all 5 questions) | p50 | p95 |
  |---|---|---|---|
  | file list (plan §12.1) | ~3.6k | **1.08 s** | 3.0 s |
  | same, `--cache-ram 1024` | ~3.6k | 1.11 s | 3.1 s |
  | file list + first ~5k tokens of diff | ~27k | **11.0 s** | — |

- **Prompt cache buys nothing**, and **every question re-reads the whole state** (the README: "questions … are answered independently"). Cost is questions × state tokens; prefill ran at ~2,500 tokens/s on this card.

## 0.2 Can EO fetch it reproducibly? — pass

- llama.cpp release assets carry a **sha256 digest in the GitHub API** (`assets[].digest`), so EO need not compute its own. Linux x64 has CPU, Vulkan, CUDA 12.8, CUDA 13.5, ROCm, SYCL, OpenVINO builds; the CUDA builds have a separate `cudart-…` bundle (444–594 MB) for machines without a system CUDA. Tags are `bNNNNN`; a build appears several times a day.
- Model: `ggml-org/Kev-4B-GGUF` revision `f4624b6bb7072f1bab726a622c1cad3f96030b9e`, `Kev-4B-Q4_K_M.gguf`, 3,033,489,824 bytes, sha256 `33ae6b18926502b2209a1bf7d3b61a350d65938441515c686bb87d226a19eff9` (the HF tree API's LFS oid). Apache-2.0; base `Qwen/Qwen3.5-4B-Base`.
- Both downloaded files matched their published hashes.

## 0.3 Is it good enough for triage? — fail

**Data.** The Review team has only 7 finished sessions (3 items), too few. Instead: 60 past single-reviewer reviews (30 reject, 30 approve, seeded random from 417 usable) on items merged through a PR. Each review's change was rebuilt from git: the newest branch commit authored before the review started, diffed against its merge-base. Labels: the 48 blocking issues of the 30 rejects, sorted by hand into the passes that would have caught them; approvals count as "no pass blocked". Criteria always runs, so it is not scored. 24 optional-pass blocks in the sample: user-facing 8, impact 5, tests 5, rules 3, security 3.

**Hard rule as the plan has it:** Security forced when a path matches `sensitivePaths` (fired on 14/60), security threshold 0.2.

| Variant | Threshold | Optional passes skipped | Blocking passes missed |
|---|---|---|---|
| Plan wording ("will this pass find a problem?"), file list | 0.4 / 0.5 | 24% / 59% | 6 / 13 |
| Relevance wording ("does this change touch X?"), file list | 0.4 / 0.5 | 13% / 21% | 1 / 2 |
| Relevance wording, file list + diff | 0.5 / 0.6 | 14% / 28% | 1 / 3 |
| **Paths only, no model** (tests/UI by path, security by `sensitivePaths`, impact and rules always) | — | **19%** | **4** |

**Pass bar (plan):** skip ≥ ⅓ of optional passes with ≤ 1 miss. No variant reaches it.

Per-pass separation (AUROC between reviews where the pass blocked and where it didn't; 0.5 is chance), best variant: user-facing 0.75, security 0.68–0.74, impact 0.41–0.54, tests 0.39–0.47, rules 0.41–0.58. With the plan's wording 77% of all probabilities sat between 0.3 and 0.7.

**What Kev does well:** it reads the change. Its user-facing answer separates changes that touch `renderer/`/`.tsx` from those that don't with AUROC 0.97. But a regex already knows that, and "touches the UI" isn't "the UI pass will block".

### Re-run with a richer state (same 60 reviews, same labels)

Facts EO could compute before triage were added to the state (median ~6k characters, ~1.6k tokens per question):
- source files changed with no matching test file changed;
- how many other files import each changed module (at the reviewed commit);
- shared contracts changed (`packages/core`, IPC, schemas, migrations, record/sync);
- which CLAUDE.md invariants govern the touched areas;
- UI files changed, and lines adding user-visible text;
- the reject rate of earlier reviews of other stories in the same areas;
- the previous round's verdict and blocking issues;
- the changed functions (hunk headers).

Only information available before each review was used.

| Variant | Threshold | Skipped | Missed | p50 |
|---|---|---|---|---|
| Richer state, questions that cite the facts | 0.3 / 0.4 | 18% / 29% | 3 / 4 | 3.0 s |
| Richer state, relevance wording | 0.5 / 0.6 | 23% / 29% | 3 / 5 | 3.1 s |
| Either, plus "previous round rejected → full team" | 0.5 | 17–32% | 3–8 | — |
| Rules on the same facts (no model) | — | 36% | 7 | — |
| *Earlier best: file list + diff* | *0.5 / 0.6* | *14% / 28%* | *1 / 3* | *11 s* |

**No better.** Per-pass AUROC stayed between 0.43 and 0.74. Rules rose a little (0.64–0.74) and the others stayed near chance. The bar (≥ ⅓ skipped, ≤ 1 miss) is still not met.

**Why: many blocks are omissions.** The user-facing passes missed in every variant (EO-778, EO-776, EO-798) blocked because the change *didn't* touch the UI the criteria asked for. Each of those changes has zero UI files. EO-705's impact block was a record-side path the change never touched. A file list, a diff or facts about the change can't show what's missing from it. Finding that means reading the criteria against the code, which is the reviewer's job, not a quick judgement.

### Re-run with the whole ticket and the implementer's account — first real signal

The idea (the maintainer's): **decide from what the work says it is, and let the reviewers verify it.** If the ticket or the implementer says the UI changed, the UI reviewer checks it, whether or not UI files are in the diff. That's exactly the omission case.

- **State:** the whole ticket (title, description, acceptance criteria, the spec's `touches` list), the implementer's `summary` and `handoff` from the last implement run before the review (all 60 had one), and a short "what the diff actually touches" section (UI files, shared contracts, untested source files, file list). Median ~8k characters, ~2k tokens per question.
- **Questions:** "Do the story or the implementer's account say this work changes … ?", one per pass (`evaluate3.py`).
- p50 latency **3.6 s**.

| Pass | AUROC before (best earlier variant) | **AUROC now** |
|---|---|---|
| impact | 0.54 | 0.57 |
| tests | 0.60 | **0.76** |
| rules | 0.74 | **0.80** |
| security | 0.74 | **0.88** |
| user_facing | 0.75 | **0.73** (but see below) |

| Triage | Skipped | Missed |
|---|---|---|
| One threshold 0.5 | 15% | 1 |
| One threshold 0.6 | 28% | 2 |
| **Per-pass thresholds** (impact 0.5, tests 0.6, rules 0.65, UI 0.4) | **23%** | **0** |
| **Per-pass thresholds** (same, UI 0.75) | **30%** | **1** |
| Keyword rule on the same text (no model) | 7% | 0 |

- The omission cases are now caught: EO-776 UI 0.79 and EO-798 UI 0.82, both because the ticket and the handoff talk about the board and the message. EO-778 is still low (0.48).
- Kev clearly beats a keyword rule on the same text. The rule matches nearly everything, so it skips almost nothing.
- **Close to the bar (≥ ⅓ skipped, ≤ 1 miss), not over it, and optimistic:** the per-pass thresholds were tuned on the same 60 reviews they were scored on. One more caveat: ticket text was read as it is today, so a ticket edited after its review would leak a little.

### Held-out check (thresholds frozen from round one)

60 new reviews (30 reject, 30 approve) of **53 items not in round one**, labelled before Kev ran (`labels-holdout.json`). 26 optional passes blocked: impact 13, user-facing 5, security 4, tests 3, rules 1. Same state, questions and thresholds (`evaluate_holdout.py`). p50 3.8 s.

| Pass | AUROC round one → **held-out** |
|---|---|
| user_facing | 0.73 → **0.99** |
| security | 0.88 → **0.96** |
| rules | 0.80 → 0.75 (1 positive) |
| tests | 0.76 → 0.44 (3 positives) |
| impact | 0.57 → **0.56** |

| Frozen triage, all five passes | Skipped | Missed |
|---|---|---|
| per-pass (UI 0.75) | 34% | 4 (3 impact, 1 tests) |
| per-pass (UI 0.4) | 28% | 4 |
| single 0.5 | 23% | 3 (all impact) |

**On all five passes, the bar is missed again**, and the misses are all impact or tests. **Impact is near chance in both rounds**. Its blocks are side effects on code paths nobody mentions (EO-830's other callers, EO-833's comment events), which no description states.

| **Triage only UI, security and rules; impact and tests always run** | Round one | **Held-out** |
|---|---|---|
| UI 0.4, security 0.2 + sensitive paths, rules 0.65 | 15% skipped, 0 missed | **16% skipped, 0 missed** |
| UI 0.75 (same otherwise) | 22% skipped, 1 missed | **23% skipped, 0 missed** |

**This holds.** It's the same in both samples, with no misses or one in 120 reviews. The saving is about one reviewer per review, of the six.

### Why impact and tests don't work

Both fail for the same two reasons, and neither is about Kev in particular.

**1. The subject is in almost every change, so "is it relevant?" is always yes.**

| | Kev said yes (P ≥ 0.5) on reviews where the pass found nothing |
|---|---|
| tests | 95–100% |
| impact | 70–82% |
| user-facing | 65–75% |
| security | 23–25% |

That's not Kev being wrong. Nearly every EO story changes behaviour (so it needs tests) and touches contracts, sync or the record (so it has impact). A question whose honest answer is nearly always yes can't skip much. UI and security work because only some changes touch them, and the ticket says which.

**2. What decides a block isn't in any text triage reads.**
- **Impact** blocks are side effects in code paths nobody mentions. EO-830 ("Windows paths in comments lose the backslash") read as a local formatting fix, scored 0.27–0.37, and blocked because other callers still wrote unprotected paths. EO-833 (0.49) blocked because a rollback still fired comment events elsewhere. The lowest scores were on exactly the stories that *look* contained, which is when the omission hides best. Impact is also the commonest block (8% of reviews in round one, 22% held-out), so a skip there costs most.
- **Tests** blocks are about what a test really exercises, not whether tests exist: one scripted provider standing in for both backends (EO-868), a faked nested call (EO-845), a test that never calls `releaseRun` (EO-813). Seeing that needs the test code next to the code under test. Kev never sees test bodies, and the reviewer's job *is* that reading.

**So:** for these two, the review is the check. If they're ever narrowed, it should be by deterministic checks rather than a quick judgement. For impact: callers of changed exported symbols the diff doesn't touch, from CodeWiki's index. For tests: changed source with no test that exercises it. Those are a separate design. The plan now always runs impact and tests (local-judge-plan.md §12.1).

## Conclusion (supersedes the verdict at the top)

- **Build triage for user-facing, security and rules only.** Impact and tests always run, and Criteria always runs. Kev reads the ticket and the implementer's account reliably for "does this work touch the UI, or anything security-sensitive?" (AUROC 0.96–0.99 held-out). It can't predict side effects or test gaps from any text it's given.
- **§12.1 step 3's input changes** from "file list + criteria" to: the whole ticket (description, criteria, `touches`), the implementer's `summary` and `handoff`, and what the diff touches. Ask "do the story or the implementer say this work changes … ?", so a reviewer verifies each claim.
- **The saving is modest:** about 1 of 6 reviewer passes per review, for a 3 GB install and ~4 s per triage. Whether that's worth Phases 1–9 is the maintainer's call. Shadow mode (§13) would still be the first thing to ship.
- **Caveats remaining:** labels are Claude's from single-reviewer verdicts; small positive counts for rules and tests; ticket text as it is today.

## What this means

1. **The plan's premise is the weak point, more than the model.** Whether a review pass will *block* isn't visible in a file list, and only faintly in a diff. Kev is a good fast reader of *relevance*; triage asks it for a *prediction*.
2. **Blocking is common here.** 41% of EO's reviews reject (633 of 1,536), and in the team sessions 14 of 38 passes blocked. With a base rate that high, every skip is expensive and the room to save is small.
3. **The saving is small even when it works.** About 15–20% of optional passes, under one reviewer per review, comes with a 3 GB install, a long-lived GPU process and ~10 s per judgement once the diff is in the state.
4. **A path rule gets most of it with none of the machinery.**
5. **Facts about the diff don't fix it**: the blocks that matter most are omissions, and those aren't in the diff.
6. **What the work claims to be does help.** With the whole ticket and the implementer's account, every pass has a signal and the omission cases are mostly caught. It's near the bar, pending a held-out check. Points 1–4 above were written before this run.

## Caveats

- Labels are a proxy: one person's (Claude's) sorting of single-reviewer blocking issues, and an approval may hide what a focused pass would have found. Small positives per pass (3–8).
- Zero-shot only: questions and state were tried in three shapes, not tuned. One model (Kev-4B Q4_K_M); the same PR serves OpenJev, Laya, Lev and Julia-1, which were not tried.
- No fine-tuning. The plan's §14 (an adapter trained on this installation's reviews) is the most likely way to change the answer; EO has ~1,500 reviews, but their pass labels would have to be made first.

## Corrections to the plan, whatever happens next

- §6.1: the API puts a question's options in **`criteria`** (an object `option → description|null` for `choice` and `noul`, an array of 2–10 levels for `score`), not `options`/`levels`. A `noul` answer is `{ "noul": p }`; a `score` answer is an expected `score` (fractional) with `legend`.
- §6.1 / §15: `calibrated: true` is too strong. The README says the probabilities "are not guaranteed to be calibrated for your data".
- §8.1: drop the prompt-cache flags (no gain; off by default for decision models). Budget latency as questions × state tokens.
- §4 0.1: the model card's command is now `llama serve -hf …`; `llama-server` still works in b12676.
- §17: switching models is cheaper than the plan says, because the same endpoint serves five decision models.

## Options

1. **Stop here.** Put a path-rule triage in the template (no model): about the same saving, no install.
2. **Fine-tune first.** Label ~1,000 past reviews by pass and train a Kev adapter (plan §14). Then re-run this test before building anything.
3. **Keep the judge, change its first user.** Use it where zero-shot relevance is the actual question (routing, inbox triage, "is this about X"), and leave review triage on rules.
