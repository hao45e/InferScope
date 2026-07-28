# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Roadmap

Planned, not yet scheduled to a hard date — version numbers below are
provisional and may shift as work lands (pre-1.0, so every entry bumps
MINOR per [RELEASING.md](./RELEASING.md)).

| Version | Planned | Why here |
|---|---|---|
| v0.5.0 | Headless/CLI invocation (run a saved config, emit JSON) for CI perf-regression checks | Wait until the config shape from the above settles so CLI args aren't chasing a moving target |
| v0.6.0 (if needed) | Multimodal (image input) benchmarking | Only if there's real demand for testing vision models — lowest priority, may be skipped |
| v1.0.0 | No new features — freeze `BenchConfig`/report schema as a stable API, docs pass | Marks that the core surface (fixed concurrency, sweep, multi-model, CLI) is complete and stable |

## [Unreleased]

### Added

- Synthetic prompt generator: enter a target token count next to the Prompt
  field and generate filler text that encodes to exactly that many tokens
  (via `tiktoken-rs`'s `cl100k_base` tokenizer, embedded at compile time —
  no network access or external tokenizer file needed), useful for
  fixed-length input testing without hand-crafting prompts.
  ([#4](https://github.com/hao45e/InferScope/issues/4))
- Concurrency sweep: run the same prompt/model against a comma-separated
  list of concurrency levels in one batch, chart throughput vs. latency
  (dual-axis, TTFT P50) across levels to find the saturation point, plus a
  per-level data table (best value per metric highlighted, same as the
  multi-model comparison table). Mutually exclusive with multi-model
  compare for now — sweeps one endpoint/model at a range of concurrency
  levels, not yet combined with comparing multiple models.
  ([#3](https://github.com/hao45e/InferScope/issues/3))

### Changed

- History: select reports for comparison by clicking anywhere on the row
  instead of a separate checkbox — the row highlights (tinted background +
  accent border) when selected. Clicking "View Detail" or "Delete" still
  works without toggling selection.
  ([#20](https://github.com/hao45e/InferScope/issues/20))

### Fixed

- History's Saved Reports list had no max height and grew unbounded,
  pushing the Comparison section far down the page once there were more
  than a handful of saved reports. Now capped at a fixed height with an
  internal scrollbar. ([#13](https://github.com/hao45e/InferScope/issues/13))
- Settings' dark theme option was labeled "深灰色" (dark gray) instead of
  "深色" (dark) in both Chinese translations.
- The topbar brand mark next to "InferScope" was a plain CSS gradient
  square that never got updated when the app icon itself was redesigned;
  it now renders the actual pulse/waveform icon.
  ([#18](https://github.com/hao45e/InferScope/issues/18))

## [0.2.0] - 2026-07-28

### Added

- Config presets: save the current form as a named preset, load or clear the
  selection from a compact picker at the top of the Config sidebar, delete a
  preset from its chip. ([#1](https://github.com/hao45e/InferScope/issues/1))
- Multi-model comparison: run the same prompt/params against a list of
  targets in one batch — each target has its own base URL, model, and API
  key, so you can compare across different providers, not just different
  models on the same endpoint. Results show every target side by side, the
  best value per metric highlighted, and each other value annotated with its
  delta from the best. History's report comparison was generalized the same
  way — select any number of saved reports (not just two) to compare.
  ([#2](https://github.com/hao45e/InferScope/issues/2))

### Changed

- Replaced the default Tauri scaffold app icon with a custom one (pulse/
  waveform mark on the same mauve→lavender gradient as the in-app brand
  mark). ([#8](https://github.com/hao45e/InferScope/issues/8))

### Fixed

- In-app update check pointed at a placeholder GitHub repo (`your-org/inferscope`)
  and always failed; it now correctly queries `hao45e/InferScope`.
  ([#10](https://github.com/hao45e/InferScope/issues/10))

## [0.1.0] - 2026-07-27

### Added

- Initial release: concurrent benchmarking engine, live TTFT/TPOT streaming
  view, full percentile report (P50/P90/P95/P99), history browsing and
  A/B comparison, JSON/CSV export, i18n (English / 简体中文 / 繁體中文).

<!--
  Once this repo has a GitHub remote, turn the version headers above into
  links, e.g.:
  [Unreleased]: https://github.com/<owner>/<repo>/compare/v0.1.0...HEAD
  [0.1.0]: https://github.com/<owner>/<repo>/releases/tag/v0.1.0
-->

