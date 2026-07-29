# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

InferScope is a desktop GUI benchmarking tool for LLM inference services (OpenAI-compatible APIs). Similar to NVIDIA genai-perf but with a graphical interface. Built with Tauri v2 + React frontend + Rust backend.

## Architecture

```
src/                          # React frontend (Vite)
├── App.tsx                   # Single-file app component with all logic
├── App.css                   # Dark theme styling (Catppuccin Mocha palette)
├── types/bench.ts            # TS interfaces matching Rust serde structs
└── main.tsx                  # Entry point

src-tauri/                    # Rust backend (Tauri)
├── src/lib.rs                # Tauri builder + command registration entry
├── src/main.rs               # Windows subprocess suppression; dispatches argv[1] "bench"/"compare"
│                              #   to cli::run()/compare::run(), otherwise calls run() for the GUI
├── src/cli.rs                # Headless `inferscope bench` subcommand (CI perf-regression checks)
├── src/compare.rs            # `inferscope compare` subcommand — diffs two BenchReport JSON files
│                              #   against a --max-regression threshold, for CI gating
├── src/synthetic_prompt.rs   # tiktoken-backed synthetic prompt generator (exact token count)
├── src/settings.rs           # App settings persistence + GitHub Releases update check
├── src/bench/mod.rs          # Core engine: concurrency, SSE parsing, metrics, reports
│   ├── BenchConfig           # Test configuration struct
│   ├── RequestMetrics        # Per-request timing data (ttft_us, tpots[], e2e_latency_us, etc.)
│   ├── BenchReport           # Aggregate report with percentiles (P50/P90/P95/P99)
│   ├── SseChunkEvent         # Real-time token streaming event
│   ├── ProgressEvent         # Real-time progress update event
│   ├── BenchEventSink        # Trait abstracting event emission — AppHandle (GUI) or
│   │                         #   NullEventSink (CLI) — see Key Design Decisions below
│   ├── run_bench_core()      # N-way concurrent benchmark engine, generic over BenchEventSink
│   ├── start_bench()         # GUI entry point: thin wrapper, run_bench_core(app_handle, ...)
│   ├── run_headless()        # CLI entry point: thin wrapper, run_bench_core(NullEventSink, ...)
│   ├── export_report()       # JSON/CSV file export
│   └── cancel_bench()        # Sets a cancel flag; running requests self-terminate on next check
├── Cargo.toml                # Dependencies
├── tauri.conf.json           # App metadata, window config, bundle settings
└── capabilities/default.json # Permission policy
```

## Key Design Decisions

- **Single-file frontend**: App.tsx contains all components rather than splitting into separate files. This is intentional per project setup.
- **In-memory log store**: Logs are stored in a global `OnceLogStore` (not persisted to disk). Cleared on app close.
- **Batch concurrency**: Benchmarks run requests in batches of `concurrency` size to avoid overwhelming the target service.
- **Timestamps in microseconds**: All timing metrics use microseconds internally, converted to milliseconds for display.
- **serde rename fields**: `BenchReport` uses `#[serde(rename = "...")]` on percentile fields — frontend TS types must match the renamed JSON keys (e.g., `ttft_p50_ms`).
- **BenchEventSink trait**: `run_bench_core` is generic over this trait rather than a concrete Tauri `AppHandle`, so the GUI and the headless CLI (`inferscope bench`) share the exact same engine code — `AppHandle` forwards events to the frontend, `NullEventSink` (CLI path) is a no-op. This means the CLI needs no window/event loop/Tauri runtime at all, which matters for running on headless CI machines. When touching the request loop, edit `run_bench_core`/`run_request`/`run_request_inner`, not `start_bench` or `run_headless` directly — those are both thin wrappers.
- **Result state is a discriminated union**: `App.tsx`'s `result: ResultState | null` (`{kind: "single"|"batch"|"sweep", ...}`) is the single source of truth for what's shown on the Results tab. This replaced three independent nullable states (one per result kind) that were manually kept mutually exclusive by convention — don't reintroduce parallel nullable slots for a new result kind; extend the union instead.
- **`BenchConfig`/`BenchReport` are a frozen, stable schema** as of v1.0 (see the README's "Stability" section): new fields must be optional with a default; never remove, rename, or repurpose a field within a MINOR/PATCH release.

## Commands

```bash
# Development (full app window)
pnpm tauri dev

# Build for production
pnpm tauri build

# Rust checks
cd src-tauri && cargo check
cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings
cd src-tauri && cargo test

# TypeScript type checking
npx tsc --noEmit

# Vite dev server (headless, for debugging)
pnpm dev

# Headless CLI mode (no GUI) — see cli.rs
cd src-tauri && cargo run -- bench --config path/to/bench.json
```

## File Conventions

- Comments in Chinese, identifiers in English
- `cargo clippy` must pass with zero warnings
- Frontend uses functional components + hooks, no class components
- All invoke payloads and return types have corresponding TS interfaces in `src/types/`
- Backend events are emitted via `app.emit("bench:progress", ...)` etc.
