---
name: agent-watch
description: Inspect, create, or safely modify Agent Watch's Jev evaluations and Pi harness improvement rules. Use when a user wants to add a custom eval, change when it runs, understand a Jev decision, edit built-in questions or thresholds in a cloned Agent Watch repo, or test the improvement loop without touching real Pi configuration.
license: MIT
---

# Agent Watch evaluation authoring

Find this skill's package root (two directories above `SKILL.md`). Read `docs/evaluations.md` and `docs/jev-decision-loop.md` there before proposing any change. Do **not** assume the future architecture is already implemented: the reference lists what Jev actually asks today.

## First decide which edit is needed

- **New user question:** use `agent-watch eval-add "Did the agent stay within the requested scope?" --schedule settled --project /path/to/disposable-project`. Other schedules: `turn --every 10` and `shutdown`. The tool-free Pi compiler proposes a typed Jev question; show the exact compiled question and ask the user to confirm. User evals are informational and do **not** steer autonomous changes.
- **Existing user question:** `agent-watch evals --project /path/to/project` lists definitions and IDs. Use `eval-edit <id> "new question"` for a recompiled, confirmed replacement; `eval-disable <id>`, `eval-enable <id>`, or `eval-remove <id> --yes` to manage it. The dashboard has the same controls. Past results remain in history; do not modify SQLite by hand.
- **Built-in autonomous question:** work in a **cloned source checkout**, not in the installer-managed npm package. Questions and branch order are in `src/tree.mjs`; target/direction options, redaction and Choice thresholds are in `src/core.mjs`; schedules and question compilation are in `src/evals.mjs`; daemon triggers are in `src/daemon.mjs`. Keep `docs/evaluations.md` and the decision-tree documentation aligned with any code change.

## Safe editing loop

1. Read the relevant source and every caller before editing. Identify whether the requested change affects an informational user eval or a built-in autonomous gate.
2. Make the smallest change. Keep a Noul gate before a Choice when the correct answer could be “no change”; include `none` or `unclear` in relative choices. Do not turn Jev probabilities into authorization for file access or side effects.
3. Add or update one focused test in `tests/tree.test.mjs` covering both the intended branch and its stop/abstain path. Run `npm test` and `npm run build`.
4. Run `npm run demo`. It creates an isolated temp project and uses **fake** Jev/Pi decisions; it never edits the user's real Pi settings. Inspect `.agent-watch/changes.md` in that disposable project and try Pause & rollback in its dashboard.
5. If the user separately requests a live Jev check and has exported `TYPESAFE_API_KEY` in their own shell, run `npm run jev:smoke`; it sends only synthetic text. If the user explicitly authorizes loading a project `.env`, use `node --env-file=.env scripts/jev-smoke.mjs` without printing secret values. Never inspect Pi auth files, Keychain or other secret stores to obtain a key.
6. For a real Pi integration trial, use a disposable project and explicit `pi -e /path/to/clone/extensions/agent-watch.js`. Do not install globally or enable autonomous edits against the user's real project without explicit approval.

## Current limitations to state plainly

The built-in tree asks whether a change is warranted, which observed file contributed, what direction fits, whether any draft is suitable, which exact candidate wins, and whether later behavior improved. A separate seven-question signal pack covers correction, looping, progress, completion, tool fit, instruction adherence and error recovery, but remains informational; it does not feed back into the tree. Custom evals also do not feed back. No thresholds are calibrated. Extension edits pass syntax checks, not a true security sandbox. More detail: `docs/evaluations.md`.
