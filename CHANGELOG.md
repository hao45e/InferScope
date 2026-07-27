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
| v0.2.0 | Config presets (save/load named configs) + multi-model comparison in one batch | Pure additions, don't touch `BenchConfig`/report structures — lowest risk, fastest payoff |
| v0.3.0 | Concurrency sweep — auto-run a range of concurrency levels and chart throughput vs. latency to find the saturation point | Biggest single feature; introduces a new "sweep mode" report shape, worth its own release |
| v0.4.0 | Synthetic prompt generator with tokenizer-controlled input/output length | Needs a tokenizer dependency; best done after sweep mode since sweeps usually want fixed-length synthetic input |
| v0.5.0 | Headless/CLI invocation (run a saved config, emit JSON) for CI perf-regression checks | Wait until the config shape from the above settles so CLI args aren't chasing a moving target |
| v0.6.0 (if needed) | Multimodal (image input) benchmarking | Only if there's real demand for testing vision models — lowest priority, may be skipped |
| v1.0.0 | No new features — freeze `BenchConfig`/report schema as a stable API, docs pass | Marks that the core surface (fixed concurrency, sweep, multi-model, CLI) is complete and stable |

## [Unreleased]

### Added

- Config presets: save the current form as a named preset, load or clear the
  selection from a compact picker at the top of the Config sidebar, delete a
  preset from its chip. ([#1](https://github.com/hao45e/InferScope/issues/1))

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

