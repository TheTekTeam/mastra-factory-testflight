# Factory acceptance harness

Evidence infrastructure for Factory release qualification
(TheTekTeam/dev-cluster-optimisation#134).

## Boundary

This harness is **evidence only**. It is not a scheduler, a queue, or a source
of lifecycle truth:

- It never polls GitHub to decide what work to start.
- It keeps no durable queue or lifecycle state. Each run is one bounded,
  operator-invoked pass whose only output is an evidence directory.
- It drives Factory only through Factory's own public contracts
  (`/web/factory/...`, including native `/automation-runs` and decision
  approval). Factory's dispatcher, bindings and storage stay the sole lifecycle
  authority.
- It never uses `/runs/start`.
- It targets only this repository (`TheTekTeam/mastra-factory-testflight`) and
  the Factory instance passed with `--factory-url`. Production ModelSpend
  projects are refused.

## Usage

```bash
node harness/run.mjs \
  --factory-url http://127.0.0.1:24111 \
  --project <factory-project-id> \
  --candidate-sha <exact candidate sha> \
  --scenarios ingress,replay,collision,stale,invalid \
  --out evidence/<run-id>
```

Each scenario writes a PASS/FAIL verdict with its assertions and raw API
evidence to `<out>/results.json`, and appends a human-readable line to
`<out>/results.log`. The process exits non-zero if any selected scenario fails.

## Fixture parity (fresh candidate state)

`harness/fixtures/setup-project.mjs` provisions a fresh project through Factory's own API and applies **production-parity Observational Memory**. Fresh Factory state otherwise defaults OM to `google/gemini-3.5-flash`, while Dell production persists OpenAI-based OM (`memory_settings`: observer `openai/gpt-5.6-luna`, reflector `openai/gpt-5.6-terra` for `local/local`, and `openai/gpt-5.6-luna` for both roles at project scope). Without it, large-context runs such as `factory-review` abort in the OM processor for lack of a Google key.

Native intake lists only non-draft PRs (upstream `includeDrafts: false`), so review-board scenarios mark the PR ready first, as a person would.

## Repository-local skills

`.agents/skills/` holds deterministic Factory skills used by the lifecycle
scenarios. Factory discovers them natively from the session workspace
(`.agents/skills`). They're bounded to this repository's `proofs/` directory.
