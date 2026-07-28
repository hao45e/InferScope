# InferScope

A desktop GUI benchmarking tool for LLM inference services (OpenAI-compatible APIs) — think NVIDIA's `genai-perf`, but with a graphical interface. Built with [Tauri v2](https://tauri.app), React, and Rust.

[English](./README.md)｜[简体中文](./README.zh-CN.md)

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-informational)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)

## Why InferScope

Benchmarking an LLM inference endpoint usually means either scripting `curl` loops or reaching for a CLI tool and squinting at a terminal. InferScope gives you a real desktop app: configure a run, watch tokens stream in live, and get charted P50/P90/P95/P99 percentiles the moment the run finishes — all without leaving a GUI.

## Screenshots

**Config** — connection, load parameters, and prompt setup, with a live token stream and TTFT/TPOT chart while a run is in progress

![Config view](.github/assets/screenshot-config.png)

**Results** — percentile comparison chart and per-request detail table

![Results view](.github/assets/screenshot-results.png)

**History** — browse saved runs and diff any number of them side by side

![History view](.github/assets/screenshot-history.png)

## Features

**Benchmarking**
- Configurable concurrency, batched request scheduling
- Live token-by-token streaming view of the response as it's generated
- Real-time TTFT/TPOT charts that update as requests complete
- Full report: TTFT / TPOT / end-to-end latency at P50/P90/P95/P99, average throughput, success rate
- Automatic **cache-defeat marker** injected into every request so results reflect real inference latency, not KV-cache hits from repeated identical prompts
- Compare multiple models in one batch, each with its own base URL / model / API key — so you can pit different providers against each other, not just different models on the same endpoint — with a side-by-side results table highlighting the best value per metric
- Concurrency sweep: run one model against a comma-separated list of concurrency levels in one batch, chart throughput vs. latency to find the saturation point

**Request configuration**
- Save/load named configuration presets — capture the whole form (connection, load parameters, prompt) and switch between them from a compact picker
- Bearer token / custom Authorization header support
- Arbitrary custom HTTP headers (JSON)
- Single-turn or multi-turn (system/user/assistant) conversation testing
- Bulk prompt import from `.txt` / `.jsonl`, cycled one-per-request
- Generate a synthetic prompt with an exact target token count (tokenizer-backed), for fixed-length input testing without hand-crafting prompts
- Attach a local image to a single-turn prompt to benchmark vision models
- Fetch the live model list from the target server instead of typing the model name blind

**Reliability controls**
- Per-batch and per-request delay (rate limiting)
- Configurable retry count with exponential backoff
- Cancel a run at any time — in-flight requests stop cleanly

**Reports & history**
- Every run auto-saves to disk as JSON
- Browse past runs and reload any of them into the full results view
- Side-by-side comparison of any number of historical reports, with per-metric deltas against the best value
- Export a report as JSON or CSV via the native file dialog

**App**
- Language: English (default), 简体中文, 繁體中文
- Theme: Light, Dark, or follow system
- Structured log panel (Debug/Info/Warn/Error) with search and export
- In-app update check against GitHub Releases

## Requirements

- macOS 12+, Windows 10+, or Linux (GTK3)
- [Rust](https://rustup.rs) 1.85+ (required by the `tiktoken-rs` dependency)
- Node.js 18+ and [pnpm](https://pnpm.io) 8+

## Getting started

```bash
# install dependencies
pnpm install

# run the app in development mode
pnpm tauri dev

# build a production bundle for your platform
pnpm tauri build
```

## Headless / CI mode

The built binary also runs benchmarks without opening the GUI, for scripting into CI perf-regression checks:

```bash
# run a config file, print the full report as JSON
inferscope bench --config bench.json

# also write the report to a file
inferscope bench --config bench.json --output report.json

# or run one of the app's saved presets by name instead of a file
inferscope bench --preset my-preset
```

`bench.json` is a `BenchConfig` JSON object — see [Configuration reference](#configuration-reference) below for the field list. Exit code reflects whether the run itself completed (`0`) or failed outright — an unreadable/invalid config (`2`) or zero responses at all (`1`). A 0% success rate still exits `0` with the rate visible in the JSON; comparing metrics against a threshold is left to the calling script. Runs the exact same benchmarking engine as the GUI, so results can't drift between the two.

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `http://localhost:11434/v1` | OpenAI-compatible API base URL |
| `model` | string | `qwen3.6:35b` | Model name to test |
| `prompt` | string | — | Prompt text (single-turn mode) |
| `concurrency` | number | `2` | Concurrent in-flight requests |
| `num_requests` | number | `5` | Total number of requests |
| `max_tokens` | number | `64` | Max output tokens per request |
| `temperature` | number | `0.7` | Sampling temperature |
| `auth_header` | string? | — | e.g. `Bearer sk-xxx` |
| `custom_headers` | object? | — | Extra HTTP headers (JSON) |
| `batch_interval_ms` | number | `0` | Delay between batches (ms) |
| `per_request_interval_ms` | number | `0` | Delay between individual requests (ms) |
| `max_retries` | number | `0` | Max retries per request |
| `request_timeout_ms` | number | `60000` | Per-request timeout (ms) |
| `messages` | Message[]? | `[]` | Multi-turn conversation messages |
| `image_data_url` | string? | — | Image as a data URI (`data:image/png;base64,...`) attached to a single-turn prompt |

## Stability

As of v1.0, `BenchConfig` (the shape above — used by presets, `last_config.json`,
saved reports, and the CLI's `--config` file) and `BenchReport` (the shape of
every saved report and the CLI's JSON output) are a stable API:

- New fields are added as optional with a default — never required. Config
  and report files written by an older version keep working with newer ones.
- A field is never removed, renamed, or repurposed within a MINOR/PATCH
  release. That kind of change is a breaking change (see
  [CONTRIBUTING.md](./CONTRIBUTING.md)) and bumps MAJOR (MINOR pre-1.0, per
  [RELEASING.md](./RELEASING.md)).
- The table above is the source of truth for the current field list — no
  separate schema file to keep in sync.

Because changes are strictly additive, saved presets/reports and CI configs
don't need their own version marker to stay readable across app versions.

## Metrics

- **TTFT** (Time to First Token) — P50/P90/P95/P99
- **TPOT** (Time per Output Token) — P50/P90/P95/P99
- **E2E Latency** — request start to stream end, P50/P90/P95/P99
- **Throughput** — average tokens/second
- **Success rate**

## Where data is stored

| What | Path |
|---|---|
| Saved reports | `~/.config/inferscope/.inferscope_reports/report_YYYYMMDD_HHMMSS.json` |
| Last-used config | `~/.config/inferscope/last_config.json` |
| App settings (language/theme/log level) | `~/.config/inferscope/settings.json` |

*(Path shown is for Linux/macOS via `dirs::config_dir()`; on Windows this resolves under `%APPDATA%`.)*

## FAQ

**How do I benchmark Ollama?**
Set the base URL to `http://localhost:11434/v1` and enter the model name you have pulled (or click "Fetch Models" to list what's available).

**How do I test a service that requires an API key?**
Put the full header value in the "API Key" field, e.g. `Bearer sk-xxx` for OpenAI-compatible services, or whatever scheme the provider expects.

**I'm getting 429 errors.**
The target is rate-limiting you. Increase the batch/per-request interval, or lower concurrency.

**Where are my reports?**
Auto-saved after every run — see "Where data is stored" above. Browse them from the History tab.

**Does this support Windows/Linux?**
Yes — `pnpm tauri build` produces a native installer for whichever platform you build on.

## Contributing

Issues and pull requests are welcome. Before submitting a change:

```bash
cd src-tauri && cargo test && cargo clippy --all-targets --all-features -- -D warnings
npx tsc --noEmit
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the commit message convention
(Conventional Commits) and [RELEASING.md](./RELEASING.md) for how versions
are bumped and releases are cut. CI runs the checks above automatically on
every push and pull request (`.github/workflows/ci.yml`); pushing a `vX.Y.Z`
tag builds and publishes installers for macOS/Windows/Linux as a draft
GitHub Release (`.github/workflows/release.yml`).

## License

[Apache License 2.0](./LICENSE). See [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for open-source dependency attributions.
