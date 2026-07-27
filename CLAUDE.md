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
├── src/main.rs               # Windows subprocess suppression + run() call
├── src/bench/mod.rs          # Core engine: concurrency, SSE parsing, metrics, reports
│   ├── BenchConfig           # Test configuration struct
│   ├── RequestMetrics        # Per-request timing data (ttft_us, tpots[], e2e_latency_us, etc.)
│   ├── BenchReport           # Aggregate report with percentiles (P50/P90/P95/P99)
│   ├── SseChunkEvent         # Real-time token streaming event
│   ├── ProgressEvent         # Real-time progress update event
│   ├── run_request()         # Single stream request with SSE parsing
│   ├── start_bench()         # N-way concurrent benchmark engine
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

## Commands

```bash
# Development (full app window)
pnpm tauri dev

# Build for production
pnpm tauri build

# Rust checks
cd src-tauri && cargo check
cd src-tauri && cargo clippy  # must be zero warnings
cd src-tauri && cargo test

# TypeScript type checking
npx tsc --noEmit

# Vite dev server (headless, for debugging)
pnpm dev
```

## File Conventions

- Comments in Chinese, identifiers in English
- `cargo clippy` must pass with zero warnings
- Frontend uses functional components + hooks, no class components
- All invoke payloads and return types have corresponding TS interfaces in `src/types/`
- Backend events are emitted via `app.emit("bench:progress", ...)` etc.
