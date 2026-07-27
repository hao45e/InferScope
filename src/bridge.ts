// ─── Tauri API shim for running as plain web page ─────────────
// When inside Tauri shell, use real invoke/listen via globals.
// When running as pure web (pnpm dev), provide in-memory mock so the UI still works.

// ─── In-memory bridge (used when no Tauri shell) ─────────────
interface ListenerCB { (payload: unknown): void; }
interface MockReport { path: string; report: string; createdAt: string }

const MOCK_LAST_CONFIG_KEY = "inferscope_mock_last_config";
const MOCK_APP_SETTINGS_KEY = "inferscope_mock_app_settings";
const MOCK_APP_VERSION = "0.1.0";

class InMemoryBridge {
  private _listeners = new Map<string, Set<ListenerCB>>();
  private _benchState = { running: false, canceled: false };
  private _reports: MockReport[] = [];
  private _importedFiles = new Map<string, string>();
  private _presets = new Map<string, Record<string, unknown>>();

  async invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    const cfg = (args.config as Record<string, unknown>) ?? {};

    switch (cmd) {
      case "start_bench": return this._mockBench(cfg);
      case "cancel_bench":
        this._benchState.canceled = true;
        console.log("[Mock] Benchmark canceled");
        return undefined;
      case "save_last_config":
        // 用 localStorage 而不是内存字段，这样模拟模式下刷新页面也能体现
        // "记住上一次配置"的效果，跟真实 Tauri 版本行为一致。
        try {
          localStorage.setItem(MOCK_LAST_CONFIG_KEY, JSON.stringify(cfg));
        } catch (_) {
          /* ignore (e.g. storage disabled) */
        }
        return undefined;
      case "load_last_config": {
        try {
          const raw = localStorage.getItem(MOCK_LAST_CONFIG_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch (_) {
          return null;
        }
      }
      case "save_preset": {
        const name = String((args as any).name ?? "").trim();
        if (!name) throw new Error("Preset name cannot be empty");
        this._presets.set(name, cfg);
        return undefined;
      }
      case "list_presets":
        return Array.from(this._presets.keys()).sort();
      case "load_preset": {
        const name = String((args as any).name ?? "");
        const found = this._presets.get(name);
        if (!found) throw new Error(`Preset "${name}" not found`);
        return found;
      }
      case "delete_preset": {
        const name = String((args as any).name ?? "");
        this._presets.delete(name);
        return undefined;
      }
      case "save_app_settings": {
        try {
          localStorage.setItem(MOCK_APP_SETTINGS_KEY, JSON.stringify((args as any).settings ?? {}));
        } catch (_) {
          /* ignore */
        }
        return undefined;
      }
      case "load_app_settings": {
        const defaults = { language: "en", theme: "system", log_level: "info" };
        try {
          const raw = localStorage.getItem(MOCK_APP_SETTINGS_KEY);
          return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
        } catch (_) {
          return defaults;
        }
      }
      case "get_app_version":
        return MOCK_APP_VERSION;
      case "check_for_updates":
        // 模拟模式下没有真实仓库可查，直接模拟一个"检查失败"结果，
        // 跟真实后端在占位仓库还没建好时的行为一致。
        throw new Error("Mock mode: GitHub repository is not configured yet");
      case "list_reports":
        return this._reports.map((r) => ({
          path: r.path,
          created_at: r.createdAt,
          model: JSON.parse(r.report).config?.model ?? "unknown",
          num_requests: JSON.parse(r.report).config?.num_requests ?? 0,
        }));
      case "load_report": {
        const report = this._reports.find((r) => r.path === (args as any).path);
        return report ? report.report : "{}";
      }
      case "delete_report":
        this._reports = this._reports.filter((r) => r.path !== (args as any).path);
        return undefined;
      case "export_report":
        console.log("[Mock] Exporting report:", args.format, "→", args.path);
        alert(`Mock mode: report exported to ${String(args.path)}`);
        return undefined;
      case "read_file_text": {
        const path = (args as any).path as string;
        return this._importedFiles.get(path) ?? "// Mock mode: use the import feature to pick a .txt or .jsonl file";
      }
      case "list_remote_models":
        console.log("[Mock] Simulating model list fetch for", args.baseUrl);
        return ["mock-model-a", "mock-model-b", "mock-model-c"];
      case "get_logs":
      case "get_logs_with_filter":
        // Real backend always returns Vec<LogEntry> (possibly empty), never
        // null/undefined — match that contract so callers can safely .map().
        return [];
      case "clear_logs":
        return undefined;
      default:
        console.warn("[Mock] Unimplemented command:", cmd);
        return undefined;
    }
  }

  private _mockBench(config: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve) => {
      this._benchState.running = true;
      console.log("[Mock] Starting simulated benchmark:", config);

      const numReq = (config.num_requests as number) || 5;
      const concurrency = Math.min((config.concurrency as number) || 2, numReq);
      let done = 0;

      const emit = (event: string, payload: unknown) => {
        if (this._listeners.has(event)) this._listeners.get(event)!.forEach(cb => cb(payload));
      };

      for (let i = 0; i < numReq; i += concurrency) {
        const batchSize = Math.min(concurrency, numReq - i);
        for (let j = 0; j < batchSize; j++) {
          const reqId = i + j + 1;
          if (this._benchState.canceled) {
            this._benchState.running = false;
            this._benchState.canceled = false;
            emit("bench:canceled", { completed: done, total: numReq, message: "Benchmark canceled (mock)" });
            return resolve(undefined);
          }

          const ttftBase = Math.floor(Math.random() * 700 + 100);
          const tokenCount = Math.floor(Math.random() * 30 + 10);
          const tpots: number[] = [];
          for (let t = 0; t < tokenCount; t++) tpots.push(Math.floor(Math.random() * 50 + 20));

          setTimeout(() => {
            if (this._benchState.canceled) return;
            emit("bench:progress", { completed: done + 1, total: numReq, current_ttft_us: ttftBase * 1000, current_tpots: tpots.map(t => t * 1000) });
            for (let t = 0; t < tokenCount; t++) {
              emit("bench:sse_chunk", { request_id: reqId, index: t, token: "token" + Math.random().toString(36).slice(2, 7) + " ", is_finish: t === tokenCount - 1 });
            }

            done++;
            if (done >= numReq) {
              const report = {
                config,
                metrics: Array.from({ length: numReq }, (_, k) => ({
                  request_id: k + 1, ttft_us: Math.floor(Math.random() * 500000 + 100000),
                  tpots: Array.from({ length: 20 }, () => Math.floor(Math.random() * 50000 + 20000)),
                  e2e_latency_us: Math.floor(Math.random() * 1000000 + 200000),
                  token_count: Math.floor(Math.random() * 30 + 10), success: true, error: null,
                })),
                ttft_p50_ms: +(Math.random() * 0.5 + 0.1).toFixed(2), ttft_p90_ms: +(Math.random() * 0.8 + 0.3).toFixed(2),
                ttft_p95_ms: +(Math.random() * 0.9 + 0.4).toFixed(2), ttft_p99_ms: +(Math.random() * 1.0 + 0.5).toFixed(2),
                tpot_p50_ms: Math.random() * 0.03 + 0.01, tpot_p90_ms: Math.random() * 0.06 + 0.03,
                tpot_p95_ms: Math.random() * 0.07 + 0.04, tpot_p99_ms: Math.random() * 0.08 + 0.05,
                e2e_p50_ms: Math.random() * 1.5 + 0.3, e2e_p90_ms: Math.random() * 2.0 + 0.5,
                e2e_p95_ms: Math.random() * 2.2 + 0.6, e2e_p99_ms: Math.random() * 2.5 + 0.8,
                avg_throughput_tok_s: +(Math.random() * 40 + 10).toFixed(1), success_rate_pct: 100,
              };
              const now = new Date();
              // Date.now() (ms-resolution) keeps paths unique even for
              // reports saved within the same second.
              const path = `.inferscope_reports/report_${Date.now()}.json`;
              this._reports = [...this._reports, { path, report: JSON.stringify(report), createdAt: now.toISOString() }];
              this._benchState.running = false;
              emit("bench:done", report);
              console.log("[Mock] Simulated benchmark complete");
              resolve(undefined);
            }
          }, reqId * 200 + Math.random() * 500);
        }
      }
      // Do NOT resolve here: the scheduled setTimeouts above haven't fired
      // yet, so the simulated bench hasn't actually finished. Resolving
      // early made the mock's start_bench return immediately, racing ahead
      // of the real completion (bench:done/bench:canceled), which resolve
      // this promise themselves once the last request lands or a
      // cancellation is observed.
    });
  }

  async listen(event: string, handler: ListenerCB): Promise<() => void> {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event)!.add(handler);
    return () => { this._listeners.get(event)?.delete(handler); };
  }

  async save(): Promise<string | null> {
    const name = prompt("Export filename (mock):", "inferscope-benchmark.json");
    return name ? `mock://${name}` : null;
  }

  async open(_opts?: Record<string, unknown>): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".txt,.jsonl,.json";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) { resolve(null); return; }
        const r = new FileReader();
        r.onload = () => {
          // 模拟模式下浏览器不暴露真实文件路径，用文件名当作 "path"，
          // 内容暂存起来供后续 read_file_text 取回
          const mockPath = `mock://${file.name}`;
          this._importedFiles.set(mockPath, r.result as string);
          resolve(mockPath);
        };
        r.readAsText(file);
      };
      input.click();
    });
  }
}

// ─── Shared mock bridge instance ───────────────────────────────
// invoke/listen/open/save are all called independently by callers, so a
// shared singleton (rather than `new InMemoryBridge()` per call) is needed
// for state (imported files, listeners, reports, presets) to persist
// across calls while running in mock (non-Tauri) mode.
let _mockBridge: InMemoryBridge | null = null;
function getMockBridge(): InMemoryBridge {
  if (!_mockBridge) _mockBridge = new InMemoryBridge();
  return _mockBridge;
}

// ─── Tauri globals access ─────────────────────────────────────
let _internals: any = null;
function getTauriGlobal(): any {
  if (_internals !== null) return _internals;
  if (typeof window === "undefined") return null;
  _internals = (window as any).__TAURI_INTERNALS__;
  return _internals || null;
}

// ─── Bridge layer functions ───────────────────────────────────
export async function tauriInvoke<R = unknown>(cmd: string, args?: Record<string, unknown>): Promise<R> {
  const g = getTauriGlobal();
  if (!g) {
    console.log("[Bridge] Mock invoke:", cmd, JSON.stringify(args));
    return (getMockBridge().invoke(cmd, args ?? {}) as any);
  }
  try {
    const result = await (g.invoke as Function)(cmd, args ?? {});
    console.log("[Bridge] Tauri invoke success:", cmd, result);
    return result as R;
  } catch (err: any) {
    console.error("[Bridge] Tauri invoke ERROR", cmd, "→", err?.message || String(err));
    throw err;
  }
}

export async function tauriListen<T = unknown>(event: string, handler: (ev: { payload: T }) => void): Promise<() => void> {
  const g = getTauriGlobal();
  if (!g) {
    const wrapper = (payload: unknown) => handler({ payload } as { payload: T });
    return getMockBridge().listen(event, wrapper);
  }
  // __TAURI_INTERNALS__ has no bare `listen` method — the real event API
  // (registering a callback via transformCallback, then
  // invoke('plugin:event|listen', ...)) lives in @tauri-apps/api/event.
  // Dynamically imported so this module still loads fine in pure-browser
  // (non-Tauri) dev mode, where this branch never runs.
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, handler);
}

export async function tauriSave(opts?: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> {
  const g = getTauriGlobal();
  if (!g) return getMockBridge().save();
  const { save } = await import("@tauri-apps/plugin-dialog");
  const result = await save(opts);
  return result ?? null;
}

export async function tauriOpen(opts?: Record<string, unknown>): Promise<string | null> {
  const g = getTauriGlobal();
  if (!g) return getMockBridge().open();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open(opts as Parameters<typeof open>[0]);
  return typeof result === "string" ? result : null;
}

// window.confirm()/alert() are plain web APIs that Tauri's webview does not
// implement — calling them inside the real app either no-ops or returns a
// falsy value immediately without ever showing anything, so any code
// gating on `if (!confirm(...))` silently skips its action. Route through
// the real dialog plugin instead (same one used for save/open above);
// fall back to the browser-native versions in mock/pure-browser dev mode,
// where they do work.
export async function tauriConfirm(msg: string, opts?: { title?: string; kind?: "info" | "warning" | "error" }): Promise<boolean> {
  const g = getTauriGlobal();
  if (!g) return window.confirm(msg);
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  return confirm(msg, opts);
}

export async function tauriAlert(msg: string, opts?: { title?: string; kind?: "info" | "warning" | "error" }): Promise<void> {
  const g = getTauriGlobal();
  if (!g) {
    window.alert(msg);
    return;
  }
  const { message } = await import("@tauri-apps/plugin-dialog");
  await message(msg, opts);
}

/// 在系统默认浏览器里打开一个外部链接（更新日志/GitHub 之类）。
export async function tauriOpenUrl(url: string): Promise<void> {
  const g = getTauriGlobal();
  if (!g) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
