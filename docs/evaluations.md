# What Jev actually evaluates

Agent Watch has **three evaluation paths**: a built-in informational signal pack, the autonomous decision tree, and user-created informational evaluations. This document describes the current code in [`src/tree.mjs`](../src/tree.mjs), [`src/core.mjs`](../src/core.mjs), [`src/evals.mjs`](../src/evals.mjs), and [`src/daemon.mjs`](../src/daemon.mjs). It is not a proposed future question pack.

## Built-in signal pack (informational)

With per-project Jev consent, each settled Pi agent response sends **one batched request** over a redacted, session/branch-scoped rolling window. This pack records signals; it does **not** authorize edits or feed into the autonomous tree today. The exact questions live in `signalQuestions` in [`src/evals.mjs`](../src/evals.mjs):

| Key / type | Exact question |
| --- | --- |
| `correction` / Noul | “Does the latest message in `recentInputs` correct an earlier assistant misunderstanding shown in `turns`?” |
| `looping` / Noul | “Are the recent `turns` or `tools` repeating an approach without useful new evidence?” |
| `progress` / Score | “How much progress do the recent `turns` show toward the latest user request in `recentInputs`?” Levels: no meaningful progress, partial progress, substantial progress. |
| `completion` / Noul | “Based only on the available `turns` and `tools`, has the latest user request been addressed?” |
| `tool_fit` / Noul | “If tools were used, did the observed tools fit the user request? Answer low if there is no evidence of appropriate tool use.” |
| `instruction_adherence` / Noul | “Did the assistant follow the scope and constraints stated in `recentInputs`?” |
| `error_recovery` / Noul | “If a tool failed, did later `turns` respond constructively to that failure? Answer low if no recovery is shown.” |

The result appears under `signals` in the decision history. A low answer to a conditional question (for example, tool fit when no tool ran) is **not** automatically a failure. The raw probabilities have no calibrated pass/fail threshold yet.

## Built-in decision tree

The daemon invokes the tree when Pi emits `agent_settled` and the project has consented to Jev and enabled autonomous changes. It builds a redacted window of the latest **six** turns by default, scoped to the settled session and its active branch. It requires at least two recent user inputs, a settled turn, and an observed project-local harness file. Ineligible or uncertain paths stop without edits. The daemon budget defaults to 100 decision records/day per project. The thresholds below are **uncalibrated prototype values**.

| Order | Key / type | Exact question sent to Jev | Proceed when |
| --- | --- | --- | --- |
| 1 | `yes` / Noul (`warranted`) | “Would changing the project-local Pi harness likely fix a recurring issue shown in `recentInputs`, `turns` or `tools`, rather than merely continuing the user task?” | Probability ≥ 0.8 **twice**, on distinct settled turns in the same session. |
| 2 | `target` / Choice | “Which observed harness file most likely contributed to this issue? Select none when evidence does not identify one.” | Winner is not `none`, probability ≥ 0.65, and lead over runner-up ≥ 0.15. |
| 3 | `direction` / Choice | “Which change to `selectedFile` best addresses the observed failure?” | Same Choice rule. Options depend on selected file type. |
| — | Headless Pi drafts, code filters | Draft 2–3 distinct full-file replacements with **no tools**, and reject invalid, duplicate, forbidden, or secret-bearing candidates. | At least one valid candidate remains. |
| 4 | `yes` / Noul (`suitable`) | “Is at least one of `patches` likely to correct the observed harness issue without unacceptable side effects?” | Probability ≥ 0.8. |
| 5 | `candidate` / Choice | “Which exact patch in `patches` best fixes the issue with the smallest suitable change?” | Same Choice rule; winner matches a validated candidate ID, not `none`. |
| 6 | `outcome` / Choice, on later turns | “Compared with the earlier harness failure, what do `laterTurns` show? Choose unclear if tasks are not comparable.” | After two later turns: `better` keeps, `worse` rolls back, `unclear` waits; Choice confidence rules still apply. |

**Absolute vs relative:** Noul gates can answer “not warranted.” A Choice always nominates an option, so each Choice includes `none` or `unclear` and the controller applies a minimum probability/margin rule. A Choice result alone never authorizes a file write.

### Available directions today

| Observed component | Choice options |
| --- | --- |
| Skill | `narrow_trigger`, `clarify_instructions`, `remove_conflict`, `none` |
| AGENTS.md / instruction | `clarify_scope`, `remove_conflict`, `add_example`, `none` |
| Prompt | `clarify_scope`, `remove_conflict`, `none` |
| Extension | `fix_hook`, `narrow_effect`, `none` |
| Pi settings | `adjust_setting`, `none` |

A target must be an existing project-local `AGENTS.md`, `.pi/settings.json`, `.pi/prompts/*.md`, `.pi/skills/**/SKILL.md`, or `.pi/extensions/**/*.{js,ts}`. Most targets must appear among context files, active-tool extension sources, or files read in the recent trace. `.pi/settings.json` may also be offered if it exists. Agent Watch does not edit application source or global Pi configuration.

### Other hard limits

- A selected file must be unchanged since drafting; writes are atomic and a pre-edit copy is stored locally.
- An active change is rolled back if a later turn costs **more than $1**, takes **more than 180 seconds**, or the later window has **more than three tool errors**. These are absolute limits, not evidence that a change caused the problem; all are configurable in `.agent-watch/config.json`.
- `/watch-pause` stops further work and rolls back the provisional edit unless the file changed since application; conflicts are reported rather than overwritten.
- Each gate and its full answer distribution are saved in the local decisions database. An applied change, evidence IDs, questions, alternatives, diff, and subsequent outcome also appear in `.agent-watch/changes.md`.

## User-created evaluations

Run `agent-watch eval-add "Did the agent stay within the requested scope?" --schedule turn --every 10 --project /path/to/project` or use the local dashboard. A separate tool-free Pi call turns the plain-language request into **one** Jev `noul`, `choice`, or `score` question, shows its wording and criteria, and requires confirmation. Schedules are `turn` (every N turns, 1–100), `settled`, or `shutdown`. Their state contains the latest goal, user inputs, turn text, and redacted tool outputs alongside tool names/error flags. Without source text or tool output, Jev cannot establish factual correctness. Runs and errors are saved under `eval:<id>` in the decision history.

Definitions can be edited, enabled/disabled, or removed in the dashboard or CLI (`eval-edit <id> "new question"`, `eval-enable <id>`, `eval-disable <id>`, `eval-remove <id> --yes`). Edits are recompiled by a tool-free Pi call and confirmed before activation. Past results remain in the decision history after removal.

**Current limitation:** these custom results are informational. They do not change the autonomous tree's thresholds, choose targets, block an edit, or trigger a proposal; there is no per-eval success threshold or regression comparison. Do not mistake “add an eval” for “make that eval a safety guard.”

## Gaps to fix before claiming systematic evaluation

1. **Signal pack is not actionable:** the seven explicit built-in questions now run as one informational batch, but no finding grouping, threshold calibration, per-signal history, or promotion into the autonomous tree exists yet. The tree still uses its separate warrant and outcome questions.
2. **No labeled calibration:** 0.8 / 0.65 / 0.15 thresholds and two-turn evidence rules have not been measured on real labeled Pi traces. Jev probabilities are not guarantees of correctness.
3. **No direct custom-eval feedback loop:** custom questions are not protected regression guards or decision-tree inputs. A calibrated policy is needed before promotion can depend on them.
4. **Limited real validation:** an isolated Pi session and a synthetic autonomous loop have run against real Jev. One correct answer scored 0.32 when the state lacked the tool's source text, then 0.95 with tool output included. The autonomous loop selected a synthetic skill diff and later marked it kept, but manufactured feedback does not validate real-world benefit.
5. **Limited causal evidence:** later sessions may have different goals. An `outcome` Choice cannot by itself prove the harness edit caused improvement. Baselines, comparable tasks, and human review will be needed for stronger claims.
6. **Extension edits are high risk:** syntactic checks and path limits do not establish that generated extension code is safe. Do not enable autonomous extension edits on a sensitive project without stronger isolation and review.

For the intended architecture, see [Jev decision tree](jev-decision-loop.md). For source-edit guidance, load the bundled `/skill:agent-watch` in Pi.
