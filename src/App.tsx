import { tauriInvoke as invoke } from "./bridge";
import { tauriListen as listen } from "./bridge";
import { tauriSave as save, tauriOpen as open } from "./bridge";
import { tauriConfirm as confirm, tauriAlert as alert } from "./bridge";
import { tauriOpenUrl as openUrl } from "./bridge";
import { useState, useRef, useCallback, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
  ResponsiveContainer,
} from "recharts";
import type {
  BenchConfig,
  BenchReport,
  SseChunkEvent,
  ProgressEvent,
  CancelEvent,
  Message as BenchMessage,
  ReportSummary,
  EndpointType,
} from "./types/bench";
import { translations, LANGUAGES, type Language, type Translations } from "./i18n/translations";
import brandIcon from "./assets/brand-icon.png";
import "./App.css";

const DEFAULT_PROMPT =
  "Explain the concept of emergent properties in large language models, discussing how increased model scale and training data lead to capabilities not present in smaller models. Include examples of at least three different types of emergent abilities such as chain-of-thought reasoning, instruction following, and in-context learning. Discuss the implications of these emergent properties for AI safety and alignment research.";

// ─── GitHub links ────────────────────────────────────────────
// Must match GITHUB_OWNER/GITHUB_REPO in src-tauri/src/settings.rs.
const GITHUB_URL = "https://github.com/hao45e/InferScope";

// ─── Chart palette ──────────────────────────────────────────────
// Validated against both the dark surface (#181825) and the light surface
// (#e6e9ef) with scripts/validate_palette.js from the dataviz skill: passes
// lightness band, chroma floor, CVD separation and normal-vision floor in
// both modes (light mode has a WARN on contrast for the orange, mitigated
// by the existing direct legend labels + data table view).
const CHART_TTFT = "#3b82f6"; // categorical slot 1 (identity: TTFT series)
const CHART_TPOT = "#ea580c"; // categorical slot 2 (identity: TPOT series)
const CHART_THROUGHPUT = "#22c55e"; // categorical slot 3 (identity: throughput series, sweep chart)

// Chart chrome (grid/axis/tooltip) needs separate light/dark values since
// these are plain hex strings passed straight to recharts props, not CSS
// custom properties — SVG presentation attributes don't reliably resolve
// var() the same way across webviews, so we compute the pair to use here.
const CHART_CHROME = {
  dark: {
    grid: "#313244",
    axis: "#7f849c",
    tooltipBg: "#20202f",
    tooltipBorder: "#313244",
    tooltipText: "#a6adc8",
  },
  light: {
    grid: "#ccd0da",
    axis: "#8c8fa1",
    tooltipBg: "#ffffff",
    tooltipBorder: "#ccd0da",
    tooltipText: "#6c6f85",
  },
} as const;

// Sequential ramp on a single hue (TTFT blue) for the ordinal P50→P99
// percentile bars — opacity increases with tail severity. Same values work
// for both themes (bar fills, not text; lightness band passes both modes).
const PCT_COLORS = {
  p50: "rgba(59,130,246,0.35)",
  p90: "rgba(59,130,246,0.55)",
  p95: "rgba(59,130,246,0.78)",
  p99: "rgba(59,130,246,1)",
};

function fmtMs(us: number): string {
  return (us / 1000).toFixed(2);
}

// ─── Log helpers ──────────────────────────────────────────────
function tsNow(): string {
  return new Date().toLocaleTimeString(undefined, { hour12: false });
}

function logLine(label: string, msg: string): string {
  return `[${tsNow()}] [${label}] ${msg}`;
}

// 运行日志（Run Log 面板里的内容）始终用英文，跟 UI 语言设置解耦——这些
// 是给排查问题用的技术性输出，不是界面文案，换成中文/繁中不利于日志的
// 检索、比对和分享排障信息，所以这里不走 i18n 的 translations，是一套
// 独立的、固定英文的 log 消息构造函数。
const logMsg = {
  benchStarted: () => "Benchmark started",
  benchFinished: () => "Benchmark finished",
  benchCompleted: (n: number) => `Benchmark completed, ${n} requests total`,
  benchTimedOut: (ms: number) => `Benchmark timed out (${ms}ms) — the backend may be unreachable`,
  listenerInitFailed: (msg: string) => `Failed to set up event listeners: ${msg}`,
  invokeFailed: (msg: string) => `Invoke failed! See the console for details\n\n${msg}`,
  batchModelStarted: (i: number, n: number, model: string) => `Batch ${i}/${n}: running "${model}"`,
  batchModelDone: (i: number, n: number, model: string) => `Batch ${i}/${n}: "${model}" finished`,
  sweepStepStarted: (i: number, n: number, c: number) => `Sweep ${i}/${n}: running concurrency=${c}`,
  sweepStepDone: (i: number, n: number, c: number) => `Sweep ${i}/${n}: concurrency=${c} finished`,
};

// 跟后端 concurrency_slot() 用的是同一个公式：同一并发槽位号会在不同批次
// 间复用（并发数=2 时，请求1/3/5 都是槽位1，请求2/4 都是槽位2），方便
// 顺着某一路并发的日志连续看下去。
function concurrencySlot(requestId: number, concurrency: number, numRequests: number): number {
  const effective = Math.max(1, Math.min(concurrency, Math.max(1, numRequests)));
  return ((requestId - 1) % effective) + 1;
}

const REPORT_NUMERIC_FIELDS = [
  "ttft_p50_ms", "ttft_p90_ms", "ttft_p95_ms", "ttft_p99_ms",
  "tpot_p50_ms", "tpot_p90_ms", "tpot_p95_ms", "tpot_p99_ms",
  "e2e_p50_ms", "e2e_p90_ms", "e2e_p95_ms", "e2e_p99_ms",
  "avg_throughput_tok_s", "avg_throughput_items_s", "success_rate_pct",
] as const;

// 兜底：报告可能来自磁盘上的旧格式文件（字段名对不上，比如改名前保存的
// 报告）或其它损坏数据。缺失/非数字的字段一律按 0 处理，而不是让
// undefined 一路传导到 `.toFixed()` 上把整个页面崩掉。
function sanitizeReport(raw: BenchReport): BenchReport {
  const safe = { ...raw } as BenchReport & Record<string, unknown>;
  for (const field of REPORT_NUMERIC_FIELDS) {
    const v = safe[field];
    if (typeof v !== "number" || Number.isNaN(v)) {
      safe[field] = 0;
    }
  }
  if (!Array.isArray(safe.metrics)) {
    safe.metrics = [];
  }
  return safe as BenchReport;
}

// ─── System color-scheme tracking (for theme="system") ────────
function useSystemPrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return prefersDark;
}

type ThemeSetting = "light" | "dark" | "system";
type LogLevelSetting = "debug" | "info" | "warn" | "error";

const THEME_VALUES: ThemeSetting[] = ["light", "dark", "system"];
const LOG_LEVEL_VALUES: LogLevelSetting[] = ["debug", "info", "warn", "error"];

// ─── Comparison helpers (history view + multi-model batch results) ─────
type Translations_HistoryMetricLabels = {
  metricThroughput: string;
  metricItemThroughput: string;
  metricSuccessRate: string;
  metricTtftP50: string;
  metricTtftP99: string;
  metricTpotP50: string;
  metricTpotP99: string;
  metricE2eP50: string;
  metricE2eP99: string;
};

interface MultiCompareRow {
  labelKey: keyof Translations_HistoryMetricLabels;
  unit: string;
  // null = 这一列的报告不适用这项指标（比如 chat 报告没有 items/s 吞吐，
  // embeddings/rerank 报告没有 TTFT/TPOT）——渲染成 "–"，不参与最优值/差值
  // 计算，而不是伪造一个 0 掺进比较。
  values: (number | null)[];
  higherIsBetter: boolean;
  digits: number;
}

// 跟 buildCompareRows 结构一样，只是把 a/b 两栏换成任意多个模型的一列数组。
// 对比目标（批量对比 / 并发扫描）通常都是同一个 endpoint_type，但 History
// 页的多选对比允许用户任意勾选历史报告，可能勾出一个 chat 报告和一个
// embeddings 报告放在一起对比——这种情况下不能只看 reports[0] 决定整张表
// 用哪套指标（那样会把另一份报告的真实数字换成假的 0），而是每一行按"这份
// 报告的 endpoint_type 是否适用这项指标"逐个报告判断，不适用就填 null。
// 纯 chat 或纯非 chat 的对比里，不适用的那些行会被整行跳过，跟原来的表现
// 完全一样。
function buildMultiCompareRows(reports: BenchReport[]): MultiCompareRow[] {
  const isChatReport = (r: BenchReport) => (r.config.endpoint_type ?? "chat") === "chat";
  const anyChat = reports.some(isChatReport);
  const anyNonChat = reports.some((r) => !isChatReport(r));

  const rows: MultiCompareRow[] = [];
  if (anyChat) {
    rows.push({ labelKey: "metricThroughput", unit: "tokens/s", values: reports.map((r) => (isChatReport(r) ? r.avg_throughput_tok_s : null)), higherIsBetter: true, digits: 1 });
  }
  if (anyNonChat) {
    rows.push({ labelKey: "metricItemThroughput", unit: "items/s", values: reports.map((r) => (isChatReport(r) ? null : (r.avg_throughput_items_s ?? 0))), higherIsBetter: true, digits: 1 });
  }
  rows.push({ labelKey: "metricSuccessRate", unit: "%", values: reports.map((r) => r.success_rate_pct), higherIsBetter: true, digits: 1 });
  if (anyChat) {
    rows.push({ labelKey: "metricTtftP50", unit: "ms", values: reports.map((r) => (isChatReport(r) ? r.ttft_p50_ms : null)), higherIsBetter: false, digits: 2 });
    rows.push({ labelKey: "metricTtftP99", unit: "ms", values: reports.map((r) => (isChatReport(r) ? r.ttft_p99_ms : null)), higherIsBetter: false, digits: 2 });
    rows.push({ labelKey: "metricTpotP50", unit: "ms", values: reports.map((r) => (isChatReport(r) ? r.tpot_p50_ms : null)), higherIsBetter: false, digits: 3 });
    rows.push({ labelKey: "metricTpotP99", unit: "ms", values: reports.map((r) => (isChatReport(r) ? r.tpot_p99_ms : null)), higherIsBetter: false, digits: 3 });
  }
  rows.push({ labelKey: "metricE2eP50", unit: "ms", values: reports.map((r) => r.e2e_p50_ms), higherIsBetter: false, digits: 2 });
  rows.push({ labelKey: "metricE2eP99", unit: "ms", values: reports.map((r) => r.e2e_p99_ms), higherIsBetter: false, digits: 2 });
  return rows;
}

// 给一个字段做 CSV 转义——含逗号/引号/换行就用双引号包起来，内部的引号
// 转成两个引号。对比表的列标签来自模型名/base URL，可能带逗号，不能
// 直接拼进去。
function csvEscape(field: string): string {
  if (/[",\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

// 并发扫描输入框里逗号分隔的字符串是否至少解析出一个合法并发数
// （正整数）——用来判断 Start Benchmark 按钮该不该置灰。
function parseSweepLevels(input: string): number[] {
  return Array.from(new Set(
    input
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0),
  )).sort((a, b) => a - b);
}

// 自由输入的多行文本框（embeddings 的输入文本、rerank 的候选文档）统一
// 用这份"每行一条、去空白、丢空行"的规则切成数组。
function parseLines(input: string): string[] {
  return input.split("\n").map((s) => s.trim()).filter(Boolean);
}

// N 列对比表——多模型批量对比结果页、History 多选对比复用同一份渲染逻辑。
// "最优值"只在成功率 > 0 的报告间比较（全部请求失败时 percentile 退化成 0，
// 不能算数），非最优的格子额外标一个"跟最优差多少"的小字。
function renderMultiMetricTable(entries: { label: string; report: BenchReport }[], t: Translations): React.ReactNode {
  const rows = buildMultiCompareRows(entries.map((e) => e.report));
  const validIndices = entries
    .map((e, i) => (e.report.success_rate_pct > 0 ? i : -1))
    .filter((i) => i >= 0);

  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>{t.history.metricCol}</th>
            {entries.map((e, i) => <th key={e.label + i}>{e.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rounded = row.values.map((v) => (v === null ? null : Number(v.toFixed(row.digits))));
            const numericValidIndices = validIndices.filter((i) => rounded[i] !== null);
            const best = numericValidIndices.length > 0
              ? (row.higherIsBetter
                ? Math.max(...numericValidIndices.map((i) => rounded[i] as number))
                : Math.min(...numericValidIndices.map((i) => rounded[i] as number)))
              : undefined;
            return (
              <tr key={row.labelKey}>
                <td>{t.history[row.labelKey]} <span className="unit-hint">({row.unit})</span></td>
                {row.values.map((v, i) => {
                  if (v === null) {
                    return <td key={i} className="hint">–</td>;
                  }
                  const r = rounded[i] as number;
                  const isBest = best !== undefined && r === best && numericValidIndices.includes(i);
                  const showDelta = best !== undefined && numericValidIndices.includes(i) && !isBest;
                  const diff = r - (best ?? 0);
                  const sign = diff > 0 ? "+" : "";
                  return (
                    <td key={i} className={isBest ? "best-value" : undefined}>
                      {v.toFixed(row.digits)}
                      {showDelta && <span className="delta delta-bad"> ({sign}{diff.toFixed(row.digits)})</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────
type ViewMode = "config" | "results" | "history";

// 单次跑/多模型对比批量跑/并发扫描批量跑——三种结果互斥，同一时刻只有
// 一种在展示。用可辨识联合类型表示，而不是三个各自可空的 state，这样
// "当前到底是哪种结果"由类型系统保证只有一个成立，不用在每处 setter
// 手动记得把另外两个清空。
type ResultState =
  | { kind: "single"; report: BenchReport }
  | { kind: "batch"; results: { label: string; report: BenchReport }[] }
  | { kind: "sweep"; results: { concurrency: number; report: BenchReport }[] };

function App() {
  // config
  const [config, setConfig] = useState<BenchConfig>({
    base_url: "http://localhost:11434/v1",
    model: "qwen3.6:35b",
    prompt: DEFAULT_PROMPT,
    concurrency: 2,
    num_requests: 5,
    max_tokens: 64,
    temperature: 0.7,
    auth_header: undefined,
    custom_headers: undefined,
    batch_interval_ms: 0,
    per_request_interval_ms: 0,
    max_retries: 0,
    request_timeout_ms: 60000,
    messages: [],
    warmup_requests: 0,
  });

  // dashboard state
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const statusRef = useRef<"idle" | "running" | "done">("idle");
  useEffect(() => { statusRef.current = status; }, [status]);
  // setupListeners' handlers are memoized once (deps=[removeListeners]) and
  // outlive whichever `config` was in scope when they were created, so they
  // read concurrency/num_requests through this ref instead of the state
  // variable directly to avoid a stale closure.
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);
  const [currentToken, setCurrentToken] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [metricsData, setMetricsData] = useState<{ x: number; ttft: number; tpot: number }[]>([]);
  const [result, setResult] = useState<ResultState | null>(null);
  const unlistenRef = useRef<(() => void)[]>([]);

  // log state
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [logFilterLevel, setLogFilterLevel] = useState<string | undefined>(undefined);
  const [logSearch, setLogSearch] = useState("");

  // remote model listing
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  // report history state
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selectedHistoryReports, setSelectedHistoryReports] = useState<{ path: string; label: string; report: BenchReport }[]>([]);

  // multi-turn mode
  const [multiTurnMode, setMultiTurnMode] = useState(false);
  const [messagePairs, setMessagePairs] = useState<BenchMessage[]>([{ role: "user", content: DEFAULT_PROMPT }]);

  // prompt cycling
  const [importedPrompts, setImportedPrompts] = useState<string[]>([]);
  const [usePromptCycling, setUsePromptCycling] = useState(false);

  // 合成 prompt——按目标 token 数生成填充文本，方便测不同输入长度下的性能
  const [syntheticTokenTarget, setSyntheticTokenTarget] = useState("200");
  const [generatingSyntheticPrompt, setGeneratingSyntheticPrompt] = useState(false);

  // 附加图片——仅单轮模式生效，测视觉模型
  const [attachingImage, setAttachingImage] = useState(false);

  // 多模型对比——每个对比目标都有自己独立的 base_url/model/auth_header，
  // 所以能跨厂商对比，不只是同一个端点下比较不同模型。其余参数（并发数、
  // prompt、自定义 headers 等）还是从主表单共用。
  const [multiModelMode, setMultiModelMode] = useState(false);
  // 第一行先留空——上次用过的 base_url/auth_header 是异步读盘加载的
  // （load_last_config 那个 effect），组件挂载这一刻它们大概率还没读回来，
  // 这里要是直接拿 config.base_url 当初始值会永远只读到硬编码的默认值。
  // 真正的回填放在下面切到对比模式的 handleEnableCompareMode 里，那时候
  // config 早就已经加载完了。
  const [compareTargets, setCompareTargets] = useState(() => [
    { base_url: "", model: "", auth_header: "" },
  ]);
  const [compareFetchState, setCompareFetchState] = useState<{ index: number; loading: boolean; options: string[] } | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ index: number; total: number; model: string } | null>(null);

  // 并发扫描——同一个模型/端点依次跑一串并发数，画吞吐-延迟曲线找饱和点。
  // 跟多模型对比是两个互斥的轴（对比模式关掉这个，反之亦然），v0.3.0 先不
  // 支持两个同时开（那是个二维扫描，复杂度不是一个量级）。
  const [concurrencySweepMode, setConcurrencySweepMode] = useState(false);
  const [sweepConcurrencyInput, setSweepConcurrencyInput] = useState("1,2,4,8");

  // 限速（开环）模式——不再按 concurrency 分批，改成按固定的每秒请求数
  // 依次发出，更接近线上真实流量的到达模式。跟并发扫描是同一个轴上互斥
  // 的另一种"并发数"输入方式，所以跟扫描模式互斥；跟对比模式不冲突。
  const [rateMode, setRateMode] = useState(false);
  const [requestRateInput, setRequestRateInput] = useState("10");

  // 端点类型——直接存在 config.endpoint_type 上（跟 base_url 一样，不用
  // 单独的派生 UI 状态），因为它本来就是个简单的三选一字符串字段，不像
  // request_rate_per_sec 那样需要"开关 + 数值"两个状态合成一个 Option。
  // embedding_inputs/rerank_documents 是自由输入的多行文本，用独立的
  // "原始文本"状态装着，只在 buildEffectiveConfig 里才切分成数组——跟
  // importedPrompts 不一样，这里不能每次按键都重新切分再拼回 textarea，
  // 否则打字打到一半（比如刚按完回车还没输入下一行）就会被过滤掉空行，
  // 光标体验会很怪。
  const [embeddingInputsText, setEmbeddingInputsText] = useState("");
  const [rerankDocumentsText, setRerankDocumentsText] = useState("");

  const setEndpointType = (endpointType: EndpointType) =>
    setConfig((c) => ({ ...c, endpoint_type: endpointType }));

  // config presets
  const [presets, setPresets] = useState<string[]>([]);
  const [selectedPresetName, setSelectedPresetName] = useState("");
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState("");
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const presetPickerRef = useRef<HTMLDivElement>(null);
  const presetPickerMenuRef = useRef<HTMLDivElement>(null);
  const presetPickerTriggerRef = useRef<HTMLButtonElement>(null);

  // view mode
  const [viewMode, setViewMode] = useState<ViewMode>("config");

  // ─── App settings: language / theme / log level ──────────────
  const [language, setLanguage] = useState<Language>("en");
  const [theme, setTheme] = useState<ThemeSetting>("system");
  const [logLevel, setLogLevel] = useState<LogLevelSetting>("info");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "about">("general");
  const settingsLoadedRef = useRef(false);

  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "upToDate" | "available" | "error">("idle");
  const [updateLatestVersion, setUpdateLatestVersion] = useState("");
  const [updateReleaseUrl, setUpdateReleaseUrl] = useState("");
  const [updateError, setUpdateError] = useState("");
  // 直接下载安装包并打开——只有服务端给这个平台挑出了对应的包才有值
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState("");
  const [updateDownloadFilename, setUpdateDownloadFilename] = useState("");
  const [updateInstallStatus, setUpdateInstallStatus] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [updateInstallError, setUpdateInstallError] = useState("");

  const t = translations[language];
  const systemPrefersDark = useSystemPrefersDark();
  const effectiveTheme: "light" | "dark" = theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;
  const chartChrome = CHART_CHROME[effectiveTheme];

  // Apply the explicit theme choice to <html data-theme="...">; "system"
  // removes the attribute entirely so the CSS media query takes over.
  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  // Load saved settings once on mount; only start persisting afterwards so
  // we don't clobber a saved setting with the hardcoded defaults while the
  // load is still in flight.
  useEffect(() => {
    (async () => {
      try {
        const s = await invoke<{ language: string; theme: string; log_level: string } | null>("load_app_settings");
        if (s) {
          if ((LANGUAGES as string[]).includes(s.language)) setLanguage(s.language as Language);
          if ((THEME_VALUES as string[]).includes(s.theme)) setTheme(s.theme as ThemeSetting);
          if ((LOG_LEVEL_VALUES as string[]).includes(s.log_level)) setLogLevel(s.log_level as LogLevelSetting);
        }
      } catch (_) {
        /* ignore — keep defaults */
      } finally {
        settingsLoadedRef.current = true;
      }
    })();
  }, []);

  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    invoke("save_app_settings", { settings: { language, theme, log_level: logLevel } }).catch(() => {
      /* not fatal — just won't be remembered next launch */
    });
  }, [language, theme, logLevel]);

  useEffect(() => {
    invoke<string>("get_app_version").then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

  // auto-scroll log panel
  const logPanelRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logPanelRef.current) logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
  }, [logs]);

  // 把一份加载进来的配置（上次运行 / 某个命名预设）应用到表单状态上，
  // 两个入口共用同一份"拆开 messages/prompt_pool 回填到各个 state"的逻辑。
  const applyLoadedConfig = useCallback((loaded: BenchConfig) => {
    setConfig(loaded);
    setMessagePairs(
      loaded.messages && loaded.messages.length > 0
        ? loaded.messages
        : [{ role: "user", content: DEFAULT_PROMPT }],
    );
    setMultiTurnMode((loaded.messages?.length ?? 0) > 0);
    const pool = loaded.prompt_pool || [];
    setImportedPrompts(pool);
    setUsePromptCycling(pool.length > 0);
    // buildEffectiveConfig 不会直接透传 config.request_rate_per_sec——它是
    // 从 rateMode/requestRateInput 这两个 UI 状态现算的，所以加载一份带限速
    // 设置的配置/预设时，必须把这两个 UI 状态也一起回填，不然设置会静默丢失。
    const rate = loaded.request_rate_per_sec;
    const hasRate = typeof rate === "number" && Number.isFinite(rate) && rate > 0;
    setRateMode(hasRate);
    if (hasRate) setRequestRateInput(String(rate));
    // embedding_inputs/rerank_documents 在 config 里是数组，但 Config 页面
    // 是用自由输入的文本框编辑它们——把数组重新拼回原始文本，这样加载
    // 一份预设/上次配置时这两个文本框才能看到回填的内容。
    setEmbeddingInputsText((loaded.embedding_inputs ?? []).join("\n"));
    setRerankDocumentsText((loaded.rerank_documents ?? []).join("\n"));
  }, []);

  // 启动时自动读回上一次实际用过的配置（跟下面命名预设列表是两回事）
  useEffect(() => {
    (async () => {
      try {
        const last = await invoke<BenchConfig | null>("load_last_config");
        if (last) applyLoadedConfig(last);
      } catch (_) {
        /* ignore — fall back to the hardcoded defaults */
      }
    })();
  }, [applyLoadedConfig]);

  const refreshPresets = useCallback(async () => {
    try {
      const names = await invoke<string[]>("list_presets");
      setPresets(Array.isArray(names) ? names : []);
    } catch (_) {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshPresets();
  }, [refreshPresets]);

  // 弹出面板打开后，把焦点移到菜单里的第一项，方便键盘用户
  useEffect(() => {
    if (!presetPickerOpen) return;
    const firstItem = presetPickerMenuRef.current?.querySelector<HTMLButtonElement>(".preset-picker-item");
    firstItem?.focus();
  }, [presetPickerOpen]);

  // 预设选择器弹出面板打开时，点外面或按 Escape 都要能关掉
  useEffect(() => {
    if (!presetPickerOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (presetPickerRef.current && !presetPickerRef.current.contains(e.target as Node)) {
        setPresetPickerOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPresetPickerOpen(false);
        presetPickerTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [presetPickerOpen]);

  const removeListeners = useCallback(() => {
    unlistenRef.current.forEach((fn) => fn());
    unlistenRef.current = [];
  }, []);

  // onDone/onCanceled 可选——单次压测走默认行为（切到 results 页），批量
  // 多模型对比每跑完一个模型都会触发一次 bench:done，不能每次都跳转/收尾，
  // 所以那条路径会传入自己的回调，只记录这一个模型的结果，由外层循环控制
  // 什么时候真正显示"完成"。
  const setupListeners = useCallback(async (
    onDone?: (report: BenchReport) => void,
    onCanceled?: (message: string) => void,
  ) => {
    await removeListeners();

    const un1 = await listen<SseChunkEvent>("bench:sse_chunk", (ev) => {
      const token = typeof ev.payload?.token === "string" ? ev.payload.token : "";
      if (!token) return;
      setCurrentToken((prev) => prev + token);
      const requestId = ev.payload.request_id;
      const slot = concurrencySlot(requestId, configRef.current.concurrency, configRef.current.num_requests);
      setLogs((l) => [...l, logLine("DEBUG", `[worker${slot}] #${requestId} ${token.slice(0, 80)}`)]);
    });
    unlistenRef.current.push(un1);

    const un2 = await listen<ProgressEvent>("bench:progress", (ev) => {
      const p = ev.payload;
      if (!p || typeof p !== "object") return;
      setProgress({ completed: p.completed ?? 0, total: p.total ?? 0 });
      const tpots = Array.isArray(p.current_tpots) ? p.current_tpots : [];
      if (p.current_ttft_us != null && tpots.length > 0) {
        const ttft = p.current_ttft_us;
        setMetricsData((prev) => [
          ...prev,
          { x: p.completed, ttft: ttft / 1000, tpot: tpots[tpots.length - 1] / 1000 },
        ]);
      }
    });
    unlistenRef.current.push(un2);

    const un3 = await listen<BenchReport>("bench:done", (ev) => {
      const safeReport = sanitizeReport(ev.payload);
      setLogs((l) => [
        ...l,
        logLine("INFO", logMsg.benchCompleted(safeReport.metrics.length)),
      ]);
      if (onDone) {
        onDone(safeReport);
      } else {
        setResult({ kind: "single", report: safeReport });
        setStatus("done");
        setViewMode("results");
      }
    });
    unlistenRef.current.push(un3);

    // Listen for cancellation events
    const un4 = await listen<CancelEvent>("bench:canceled", (ev) => {
      setLogs((l) => [...l, logLine("INFO", ev.payload.message)]);
      if (onCanceled) {
        onCanceled(ev.payload.message);
      } else {
        setStatus("done");
        setViewMode("results");
      }
    });
    unlistenRef.current.push(un4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeListeners]);

  const refreshLogs = useCallback(async () => {
    try {
      const result = await invoke<Array<{timestamp: string; level: string; tag: string; message: string}>>("get_logs_with_filter", {
        level: logFilterLevel || undefined,
        search: logSearch || undefined,
      });
      const entries = Array.isArray(result) ? result : [];
      const formatted = entries.map(function(e){return "[" + e.timestamp + "] [" + e.tag + " " + e.level + "] " + e.message;});
      // 这里只把新行（不在 prev 里的）追加到 prev 后面，不动 prev 已有的内容
      // ——之前直接对拼接后的整个数组按"是否在 prev 里"过滤，会把 prev 自
      // 己的元素也过滤掉，导致日志在刷新时来回跳变。
      setLogs((prev) => prev.concat(formatted.filter((l) => !prev.includes(l))));
    } catch (_) {
      /* ignore */
    }
  }, [logFilterLevel, logSearch]);

  // periodic log refresh while running — fetch immediately (don't wait for
  // the first 1.5s tick, otherwise a run that finishes faster than that
  // never pulls the backend's detailed per-request BENCH logs at all), and
  // once more right as it stops running to catch the final entries (e.g.
  // the failure reason on a request that errored out).
  useEffect(() => {
    if (status !== "running") return;
    refreshLogs();
    const iv = setInterval(refreshLogs, 1500);
    return () => {
      clearInterval(iv);
      refreshLogs();
    };
  }, [status, refreshLogs]);

  // Custom headers parser helper
  const handleCustomHeadersChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      setConfig(function(c) {
        try {
          return { ...c, custom_headers: v ? JSON.parse(v) : undefined };
        } catch (_ignored) {
          return c;
        }
      });
    },
    [],
  );

  // 把多轮对话消息 / 循环 prompt 池 / 限速模式的速率同步进最终发给后端的配置
  const buildEffectiveConfig = useCallback((): BenchConfig => {
    const parsedRate = Number(requestRateInput);
    const endpointType = config.endpoint_type ?? "chat";
    const isEmbeddings = endpointType === "embeddings";
    const isRerank = endpointType === "rerank";
    return {
      ...config,
      messages: multiTurnMode ? messagePairs : [],
      prompt_pool:
        !multiTurnMode && usePromptCycling && importedPrompts.length > 0
          ? importedPrompts
          : [],
      request_rate_per_sec: rateMode && Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : null,
      // 只在对应模式下才把这些字段填进去，切走之后清空——不然切换模式后
      // 之前打的文本会作为"死数据"悄悄留在保存的配置/预设里。
      embedding_inputs: isEmbeddings ? parseLines(embeddingInputsText) : [],
      rerank_query: isRerank ? (config.rerank_query || "") : "",
      rerank_documents: isRerank ? parseLines(rerankDocumentsText) : [],
    };
  }, [
    config,
    multiTurnMode,
    messagePairs,
    usePromptCycling,
    importedPrompts,
    rateMode,
    requestRateInput,
    embeddingInputsText,
    rerankDocumentsText,
  ]);

  const updateConfig = <K extends keyof BenchConfig>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setConfig((prev) => ({
        ...prev,
        [key]:
          key === "max_tokens" ||
          key === "concurrency" ||
          key === "num_requests" ||
          key === "batch_interval_ms" ||
          key === "per_request_interval_ms" ||
          key === "max_retries" ||
          key === "request_timeout_ms" ||
          key === "warmup_requests"
            ? Number(value)
            : value,
      }));
    };

  const startBench = async () => {
    setStatus("running");
    setCurrentToken("");
    setProgress({ completed: 0, total: config.num_requests });
    setMetricsData([]);
    setResult(null);
    setBatchProgress(null);
    setLogs([logLine("INFO", logMsg.benchStarted())]);
    setShowLogs(true);

    try {
      await setupListeners();
    } catch (setupErr) {
      setLogs((l) => [...l, logLine("ERROR", logMsg.listenerInitFailed(String(setupErr)))]);
      setStatus("done");
      return;
    }

    let canceled = false;
    const unlistenCancel = await listen<CancelEvent>("bench:canceled", (ev) => {
      canceled = true;
      setStatus("done");
      setViewMode("results");
      setLogs((l) => [...l, logLine("INFO", ev.payload.message)]);
    });

    // Timeout guard — if invoke hangs (e.g. connection refused), show error instead of forever
    const BENCH_TIMEOUT_MS = 30_000;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      unlistenCancel();
      setStatus("done");
      setViewMode("results");
      setLogs((l) => [
        ...l,
        logLine("INFO", logMsg.benchTimedOut(BENCH_TIMEOUT_MS)),
      ]);
    }, BENCH_TIMEOUT_MS);

    const effectiveConfig = buildEffectiveConfig();
    try {
      await invoke("save_last_config", { config: effectiveConfig });
    } catch (_) {
      /* ignore — not remembering the config for next time isn't fatal */
    }

    try {
      await invoke("start_bench", { config: effectiveConfig });
      if (!timedOut) {
        setLogs((l) => [...l, logLine("INFO", logMsg.benchFinished())]);
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setLogs((l) => [
        ...l,
        logLine("ERROR", logMsg.invokeFailed(errMsg)),
      ]);
      if (!timedOut) {
        setTimeout(() => { void alert(t.config.benchFailedBody(errMsg)); }, 50);
      }
    } finally {
      clearTimeout(timeoutId);
      unlistenCancel();
      if (!timedOut && !canceled && statusRef.current !== "done") {
        setStatus("done");
        setViewMode("results");
      }
    }
  };

  const handleCancel = async () => {
    try {
      await invoke("cancel_bench");
    } catch (e: unknown) {
      // ignore if already cancelled
    }
  };

  // 同一套 prompt/参数依次跑一组模型（后端只有一个进程级 CANCEL_FLAG，
  // 没法并行跑多个 start_bench，所以这里严格顺序 await，一个跑完再跑下一个）。
  // 批量/扫描类场景（多模型对比、并发扫描）共用的"跑一份 config、等它有
  // 结果"逻辑，从 startMultiModelBench 里提出来，避免每加一种新的批量模式
  // 就再复制一份几乎一样的 setupListeners/超时保护/错误处理代码。
  //
  // 超时保护会真的把 UI 状态拉回 "done"（而不是只打个日志）——不然某一步
  // 卡住的话，整个批次会一直卡在 "running"，Cancel 键之外没有任何办法脱
  // 困。invoke 本身没法真的中途掐断，等它最终 resolve/reject 时用返回值里
  // 的 timedOut 标记短路掉，调用方不应该把这份迟到的结果计入批次。
  const runOneBenchStep = async (
    effectiveConfig: BenchConfig,
  ): Promise<{ report: BenchReport | null; canceled: boolean; timedOut: boolean }> => {
    let stepReport: BenchReport | null = null;
    let stepCanceled = false;

    try {
      await setupListeners(
        (rep) => { stepReport = rep; },
        () => { stepCanceled = true; },
      );
    } catch (setupErr) {
      setLogs((l) => [...l, logLine("ERROR", logMsg.listenerInitFailed(String(setupErr)))]);
      return { report: null, canceled: false, timedOut: false };
    }

    let timedOut = false;
    const BENCH_TIMEOUT_MS = 30_000;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      setLogs((l) => [...l, logLine("INFO", logMsg.benchTimedOut(BENCH_TIMEOUT_MS))]);
      setStatus("done");
      setViewMode("results");
    }, BENCH_TIMEOUT_MS);

    try {
      await invoke("start_bench", { config: effectiveConfig });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setLogs((l) => [...l, logLine("ERROR", logMsg.invokeFailed(errMsg))]);
      clearTimeout(timeoutId);
      if (!timedOut) await alert(t.config.benchFailedBody(errMsg));
      return { report: null, canceled: false, timedOut };
    }
    clearTimeout(timeoutId);

    return { report: stepReport, canceled: stepCanceled, timedOut };
  };

  const startMultiModelBench = async () => {
    const targets = compareTargets
      .map((tg) => ({ base_url: tg.base_url.trim(), model: tg.model.trim(), auth_header: tg.auth_header.trim() }))
      .filter((tg) => tg.base_url && tg.model);
    if (targets.length === 0) return;

    setStatus("running");
    setResult(null);
    setLogs([logLine("INFO", logMsg.benchStarted())]);
    setShowLogs(true);

    const collected: { label: string; report: BenchReport }[] = [];
    let stoppedEarly = false;
    const baseConfig = buildEffectiveConfig();

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const label = `${target.model} (${target.base_url})`;
      setBatchProgress({ index: i + 1, total: targets.length, model: target.model });
      setCurrentToken("");
      // 用 baseConfig（跑批次前冻结的那份配置）而不是 config 活态值——用户在
      // 批次跑到一半时改了 Num Requests 也不会让这里显示的分母跟这一次
      // 实际发给后端的请求数对不上（很快也会被真实的 bench:progress 事件覆盖，
      // 这里只是让初始占位值本身保持自洽）。
      setProgress({ completed: 0, total: baseConfig.num_requests });
      setMetricsData([]);
      setLogs((l) => [...l, logLine("INFO", logMsg.batchModelStarted(i + 1, targets.length, label))]);

      const outcome = await runOneBenchStep({
        ...baseConfig,
        base_url: target.base_url,
        model: target.model,
        auth_header: target.auth_header || undefined,
      });

      if (outcome.report && !outcome.timedOut) {
        collected.push({ label, report: outcome.report });
        setResult({ kind: "batch", results: [...collected] });
        setLogs((l) => [...l, logLine("INFO", logMsg.batchModelDone(i + 1, targets.length, label))]);
      }
      if (outcome.canceled || outcome.timedOut) {
        stoppedEarly = true;
        break;
      }
    }

    setBatchProgress(null);
    if (!stoppedEarly) {
      setLogs((l) => [...l, logLine("INFO", logMsg.benchFinished())]);
    }
    setStatus("done");
    setViewMode("results");
  };

  // 同一个模型/端点依次跑一串并发数（同样严格顺序 await，原因跟多模型批量
  // 一样：后端只有一个进程级 CANCEL_FLAG）。用来画吞吐-延迟曲线找饱和点。
  const startConcurrencySweep = async () => {
    const levels = parseSweepLevels(sweepConcurrencyInput);
    if (levels.length === 0) return;

    setStatus("running");
    setResult(null);
    setLogs([logLine("INFO", logMsg.benchStarted())]);
    setShowLogs(true);

    const collected: { concurrency: number; report: BenchReport }[] = [];
    let stoppedEarly = false;
    const baseConfig = buildEffectiveConfig();

    for (let i = 0; i < levels.length; i++) {
      const c = levels[i];
      setBatchProgress({ index: i + 1, total: levels.length, model: String(c) });
      setCurrentToken("");
      setProgress({ completed: 0, total: baseConfig.num_requests });
      setMetricsData([]);
      setLogs((l) => [...l, logLine("INFO", logMsg.sweepStepStarted(i + 1, levels.length, c))]);

      const outcome = await runOneBenchStep({ ...baseConfig, concurrency: c });

      if (outcome.report && !outcome.timedOut) {
        collected.push({ concurrency: c, report: outcome.report });
        setResult({ kind: "sweep", results: [...collected] });
        setLogs((l) => [...l, logLine("INFO", logMsg.sweepStepDone(i + 1, levels.length, c))]);
      }
      if (outcome.canceled || outcome.timedOut) {
        stoppedEarly = true;
        break;
      }
    }

    setBatchProgress(null);
    if (!stoppedEarly) {
      setLogs((l) => [...l, logLine("INFO", logMsg.benchFinished())]);
    }
    setStatus("done");
    setViewMode("results");
  };

  const handleStartClick = () => {
    if (concurrencySweepMode) {
      void startConcurrencySweep();
    } else if (multiModelMode) {
      void startMultiModelBench();
    } else {
      void startBench();
    }
  };

  const handleExport = async (format: "json" | "csv") => {
    if (result?.kind !== "single") return;
    const report = result.report;
    try {
      const path = await save({
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
        defaultPath: `inferscope-benchmark.${format}`,
      });
      if (path) {
        await invoke("export_report", { reportJson: JSON.stringify(report), format, path });
        await alert(t.results.exportedAlert(format.toUpperCase()));
      }
    } catch (e) {
      // User cancelled dialog — ignore
    }
  };

  // 多模型对比 / 并发扫描的导出——这两种结果不是单个 BenchReport，是"多份
  // 报告并排对比"的表格，跟单次结果的导出逻辑对不上。JSON 直接把整个
  // entries 数组落盘；CSV 复用 buildMultiCompareRows 算出的同一份聚合数据
  // （跟屏幕上看到的对比表一模一样），保证导出内容和显示内容不会对不上。
  const handleExportComparison = async (entries: { label: string; report: BenchReport }[], format: "json" | "csv") => {
    try {
      const path = await save({
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
        defaultPath: `inferscope-comparison.${format}`,
      });
      if (!path) return;

      let content: string;
      if (format === "json") {
        content = JSON.stringify(entries, null, 2);
      } else {
        const rows = buildMultiCompareRows(entries.map((e) => e.report));
        const header = ["Metric", ...entries.map((e) => e.label)].map(csvEscape).join(",");
        const lines = rows.map((row) => {
          const label = `${t.history[row.labelKey]} (${row.unit})`;
          const values = row.values.map((v) => (v === null ? "" : v.toFixed(row.digits)));
          return [label, ...values].map(csvEscape).join(",");
        });
        content = [header, ...lines].join("\n");
      }

      await invoke("export_text", { content, path });
      await alert(t.results.exportedAlert(format.toUpperCase()));
    } catch (e) {
      // User cancelled dialog — ignore
    }
  };

  const exportLogs = () => {
    const content = logs.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inferscope-logs.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleFetchModels = async () => {
    setLoadingModels(true);
    try {
      const models = await invoke<string[]>("list_remote_models", {
        baseUrl: config.base_url,
        authHeader: config.auth_header,
        customHeaders: config.custom_headers,
      });
      setModelOptions(models);
    } catch (e) {
      setModelOptions([]);
      await alert(t.config.fetchModelsFailed(String(e)));
    } finally {
      setLoadingModels(false);
    }
  };

  // 对比模式下每一行的 base_url 都可能不一样，所以拉模型列表必须按行来，
  // 不能像单模型模式那样用共用的 config.base_url——那个字段在对比模式下
  // 本来就是隐藏的，用它去拉会拉错服务。
  const handleFetchModelsForTarget = async (idx: number) => {
    const tg = compareTargets[idx];
    if (!tg) return;
    setCompareFetchState({ index: idx, loading: true, options: [] });
    try {
      const models = await invoke<string[]>("list_remote_models", {
        baseUrl: tg.base_url,
        authHeader: tg.auth_header || undefined,
        customHeaders: config.custom_headers,
      });
      setCompareFetchState({ index: idx, loading: false, options: models });
    } catch (e) {
      setCompareFetchState(null);
      await alert(t.config.fetchModelsFailed(String(e)));
    }
  };

  // 切到"对比模型"模式时，如果第一行还没被用户动过（还是空的），就用这时候
  // 已经真正加载好的 config.base_url/auth_header 回填——不能在 compareTargets
  // 的 useState 初始值里直接读 config，因为那时候上次用过的配置可能还没异步
  // 读盘加载完。
  const handleEnableCompareMode = () => {
    setMultiModelMode(true);
    // 对比模式和并发扫描是互斥的两个轴，切过去的时候把扫描关掉——不然
    // handleStartClick 里 concurrencySweepMode 优先判断，扫描开关的勾选框
    // 在对比模式下又是隐藏的，用户看不见也关不掉，点开始会莫名其妙跑成
    // 并发扫描而不是多模型对比。
    setConcurrencySweepMode(false);
    setCompareTargets((prev) => {
      const isPristine = prev.length === 1 && !prev[0].base_url && !prev[0].model && !prev[0].auth_header;
      return isPristine ? [{ base_url: config.base_url, model: "", auth_header: config.auth_header || "" }] : prev;
    });
  };

  const handleImportPrompts = async () => {
    try {
      const result = await open({ multiple: false });
      if (!result) return;
      const content = await invoke<string>("read_file_text", { path: String(result) });
      if (content.trim()) {
        // .jsonl 和 .txt 目前都是按"每行一条、去空白、丢空行"处理，跟
        // embeddings/rerank 文本框用的是同一份规则，统一用 parseLines。
        setImportedPrompts(parseLines(content));
        setUsePromptCycling(true);
      }
    } catch (e) {
      await alert(t.config.importPromptsFailed(String(e)));
    }
  };

  const handleGenerateSyntheticPrompt = async () => {
    const target = parseInt(syntheticTokenTarget, 10);
    if (!Number.isFinite(target) || target <= 0) return;
    setGeneratingSyntheticPrompt(true);
    try {
      const generated = await invoke<string>("generate_synthetic_prompt_cmd", { targetTokens: target });
      setConfig((c) => ({ ...c, prompt: generated }));
    } catch (e) {
      await alert(t.config.syntheticPromptFailed(String(e)));
    } finally {
      setGeneratingSyntheticPrompt(false);
    }
  };

  const handleAttachImage = async () => {
    try {
      const result = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!result) return;
      setAttachingImage(true);
      const dataUrl = await invoke<string>("read_image_as_data_url", { path: String(result) });
      setConfig((c) => ({ ...c, image_data_url: dataUrl }));
    } catch (e) {
      await alert(t.config.attachImageFailed(String(e)));
    } finally {
      setAttachingImage(false);
    }
  };

  const handleRemoveImage = () => {
    setConfig((c) => ({ ...c, image_data_url: null }));
  };

  const handleOpenSavePresetModal = () => {
    setPresetPickerOpen(false);
    setPresetNameInput(selectedPresetName || "");
    setShowSavePresetModal(true);
  };

  const handleSavePreset = async () => {
    const name = presetNameInput.trim();
    if (!name) return;
    if (presets.includes(name) && !(await confirm(t.config.presetOverwriteConfirm(name)))) {
      return;
    }
    try {
      await invoke("save_preset", { name, config: buildEffectiveConfig() });
      setShowSavePresetModal(false);
      setPresetNameInput("");
      setSelectedPresetName(name);
      await refreshPresets();
    } catch (e) {
      await alert(t.config.presetSaveFailed(String(e)));
    }
  };

  const handleLoadPreset = async (name: string) => {
    if (!name) return;
    try {
      const loaded = await invoke<BenchConfig>("load_preset", { name });
      applyLoadedConfig(loaded);
      setSelectedPresetName(name);
      setPresetPickerOpen(false);
      presetPickerTriggerRef.current?.focus();
    } catch (e) {
      await alert(t.config.presetLoadFailed(String(e)));
    }
  };

  const handleDeletePreset = async (name: string) => {
    if (!name) return;
    if (!(await confirm(t.config.presetDeleteConfirm(name)))) return;
    try {
      await invoke("delete_preset", { name });
      if (selectedPresetName === name) setSelectedPresetName("");
      await refreshPresets();
    } catch (e) {
      await alert(t.config.presetDeleteFailed(String(e)));
    }
  };

  const handleLoadReports = async () => {
    try {
      const r = await invoke<ReportSummary[]>("list_reports");
      setReports(r);
    } catch (_) {
      /* ignore */
    }
  };

  const openHistory = () => {
    setViewMode("history");
    handleLoadReports();
  };

  const loadReportFromDisk = async (path: string): Promise<BenchReport> => {
    const jsonStr = await invoke<string>("load_report", { path });
    return sanitizeReport(JSON.parse(jsonStr) as BenchReport);
  };

  // 勾选/取消勾选一份历史报告加入对比——不限 2 份，选几份就对比几份。
  const handleToggleHistorySelection = async (rep: ReportSummary) => {
    if (selectedHistoryReports.some((r) => r.path === rep.path)) {
      setSelectedHistoryReports((prev) => prev.filter((r) => r.path !== rep.path));
      return;
    }
    try {
      const loaded = await loadReportFromDisk(rep.path);
      // label 里带上时间戳，避免同一个模型跑了好几次、勾选多份时表头重名分不清。
      const label = `${rep.model} · ${rep.created_at}`;
      setSelectedHistoryReports((prev) => [...prev, { path: rep.path, label, report: loaded }]);
    } catch (e) {
      await alert(t.results.loadReportFailed(String(e)));
    }
  };

  // 在完整的"结果"页里查看某一份历史报告（图表、逐请求明细表、导出都有），
  // 而不只是历史对比页里那个精简的指标对比表。
  const handleViewReportDetail = async (path: string) => {
    try {
      const loaded = await loadReportFromDisk(path);
      setResult({ kind: "single", report: loaded });
      setViewMode("results");
    } catch (e) {
      await alert(t.results.loadReportFailed(String(e)));
    }
  };

  const handleDeleteSavedReport = async (path: string) => {
    if (!(await confirm(t.history.deleteConfirm(path.split("/").pop() || path)))) return;
    try {
      await invoke("delete_report", { path });
      setSelectedHistoryReports((prev) => prev.filter((r) => r.path !== path));
      await handleLoadReports();
    } catch (e) {
      await alert(t.history.deleteFailed(String(e)));
    }
  };

  const clearHistorySelection = () => {
    setSelectedHistoryReports([]);
  };

  const handleCheckForUpdates = async () => {
    setUpdateStatus("checking");
    setUpdateError("");
    setUpdateInstallStatus("idle");
    setUpdateInstallError("");
    try {
      const info = await invoke<{
        current_version: string;
        latest_version: string;
        update_available: boolean;
        release_url: string;
        release_notes: string;
        download_url: string | null;
        download_filename: string | null;
      }>("check_for_updates");
      if (info.update_available) {
        setUpdateLatestVersion(info.latest_version);
        setUpdateReleaseUrl(info.release_url);
        setUpdateDownloadUrl(info.download_url ?? "");
        setUpdateDownloadFilename(info.download_filename ?? "");
        setUpdateStatus("available");
      } else {
        setUpdateStatus("upToDate");
      }
    } catch (e) {
      setUpdateError(String(e));
      setUpdateStatus("error");
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateDownloadUrl || !updateDownloadFilename) return;
    setUpdateInstallStatus("downloading");
    setUpdateInstallError("");
    try {
      await invoke("download_and_open_update", { url: updateDownloadUrl, filename: updateDownloadFilename });
      setUpdateInstallStatus("done");
    } catch (e) {
      setUpdateInstallError(String(e));
      setUpdateInstallStatus("error");
    }
  };

  const handleOpenGithub = () => { void openUrl(GITHUB_URL); };
  const handleOpenChangelog = () => { void openUrl(GITHUB_URL + "/releases"); };
  const handleOpenUpdateRelease = () => { if (updateReleaseUrl) void openUrl(updateReleaseUrl); };

  const currentPct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const lastMetric = metricsData.length > 0 ? metricsData[metricsData.length - 1] : null;

  // ─── Shared logs panel body ────────────────────────────────
  const renderLogsBody = () => (
    <>
      <div className="log-toolbar">
        <select
          value={logFilterLevel || ""}
          onChange={(e) => setLogFilterLevel(e.target.value || undefined)}
          className="select-sm"
        >
          <option value="">{t.logs.allLevels}</option>
          <option value="debug">{t.logs.levelDebug}</option>
          <option value="info">{t.logs.levelInfo}</option>
          <option value="warn">{t.logs.levelWarn}</option>
          <option value="error">{t.logs.levelError}</option>
        </select>
        <input
          value={logSearch}
          onChange={(e) => setLogSearch(e.target.value)}
          placeholder={t.logs.searchPlaceholder}
          className="input-sm log-search"
        />
        <button className="btn btn-ghost btn-sm" onClick={refreshLogs}>{t.logs.refresh}</button>
        <button className="btn btn-ghost btn-sm" onClick={exportLogs}>{t.logs.export}</button>
      </div>
      <pre ref={logPanelRef} className="log-content">{logs.join("\n") || t.logs.waiting}</pre>
    </>
  );

  // ─── CONFIG view ────────────────────────────────────────────
  const renderConfigView = () => (
    <div className="workspace">
      <aside className="config-panel">
        <div className="panel-block">
          <h3 className="panel-block-title">{t.config.benchmarkModeLabel}</h3>
          <div className="segmented">
            <button className={"segmented-btn" + (!multiModelMode ? " active" : "")} onClick={() => setMultiModelMode(false)}>{t.config.singleModelTab}</button>
            <button className={"segmented-btn" + (multiModelMode ? " active" : "")} onClick={handleEnableCompareMode}>{t.config.compareModelsTab}</button>
          </div>
        </div>

        <div className="panel-block">
          <h3 className="panel-block-title">{t.config.sectionEndpointType}</h3>
          <div className="segmented">
            <button className={"segmented-btn" + ((config.endpoint_type ?? "chat") === "chat" ? " active" : "")} onClick={() => setEndpointType("chat")}>{t.config.endpointTypeChat}</button>
            <button className={"segmented-btn" + (config.endpoint_type === "embeddings" ? " active" : "")} onClick={() => setEndpointType("embeddings")}>{t.config.endpointTypeEmbeddings}</button>
            <button className={"segmented-btn" + (config.endpoint_type === "rerank" ? " active" : "")} onClick={() => setEndpointType("rerank")}>{t.config.endpointTypeRerank}</button>
          </div>
        </div>

        <div className="panel-block">
          <h3 className="panel-block-title">{t.config.sectionPresets}</h3>
          <div className="preset-picker" ref={presetPickerRef}>
            {selectedPresetName ? (
              <div className="preset-chip">
                <button
                  type="button"
                  ref={presetPickerTriggerRef}
                  className="preset-chip-name"
                  onClick={() => setPresetPickerOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={presetPickerOpen}
                  aria-controls="preset-picker-menu"
                >
                  <span className="preset-chip-check">✓</span>
                  <span className="preset-chip-label">{selectedPresetName}</span>
                </button>
                <button
                  type="button"
                  className="preset-chip-delete"
                  onClick={() => handleDeletePreset(selectedPresetName)}
                  aria-label={t.config.deletePreset}
                  title={t.config.deletePreset}
                >
                  ×
                </button>
              </div>
            ) : (
              <button
                type="button"
                ref={presetPickerTriggerRef}
                className="preset-picker-trigger"
                onClick={() => setPresetPickerOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={presetPickerOpen}
                aria-controls="preset-picker-menu"
              >
                + {t.config.selectPresetPlaceholder}
              </button>
            )}
            {presetPickerOpen && (
              <div
                id="preset-picker-menu"
                className="preset-picker-menu"
                ref={presetPickerMenuRef}
                role="menu"
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>(".preset-picker-item"));
                  if (items.length === 0) return;
                  e.preventDefault();
                  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
                  const nextIndex = e.key === "ArrowDown"
                    ? (currentIndex + 1) % items.length
                    : (currentIndex - 1 + items.length) % items.length;
                  items[nextIndex].focus();
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={"preset-picker-item" + (!selectedPresetName ? " active" : "")}
                  onClick={() => {
                    setSelectedPresetName("");
                    setPresetPickerOpen(false);
                    presetPickerTriggerRef.current?.focus();
                  }}
                >
                  {t.config.presetNotSelected}
                </button>
                <div className="preset-picker-divider" />
                {presets.length === 0 ? (
                  <div className="preset-picker-empty hint">{t.config.noPresetsYet}</div>
                ) : (
                  presets.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="menuitem"
                      className={"preset-picker-item" + (name === selectedPresetName ? " active" : "")}
                      onClick={() => handleLoadPreset(name)}
                    >
                      {name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <div className="panel-block panel-actions">
          {status !== "running" && (
            <div className="panel-actions-row">
              <button
                className="btn btn-primary btn-lg"
                onClick={handleStartClick}
                disabled={
                  (multiModelMode && compareTargets.every((tg) => !tg.model.trim() || !tg.base_url.trim())) ||
                  (concurrencySweepMode && parseSweepLevels(sweepConcurrencyInput).length === 0) ||
                  (rateMode && !(Number.isFinite(Number(requestRateInput)) && Number(requestRateInput) > 0)) ||
                  ((config.endpoint_type ?? "chat") === "embeddings" && !embeddingInputsText.trim()) ||
                  ((config.endpoint_type ?? "chat") === "rerank" && (!config.rerank_query?.trim() || !rerankDocumentsText.trim()))
                }
              >
                {status === "done" ? t.config.restartBench : t.config.startBench}
              </button>
              <button type="button" className="btn btn-secondary btn-lg" onClick={handleOpenSavePresetModal}>{t.config.savePreset}</button>
            </div>
          )}
          {status === "running" && <button className="btn btn-danger btn-lg btn-block" onClick={handleCancel}>{t.config.cancelBench}</button>}
        </div>

        <div className="panel-block">
          <h3 className="panel-block-title">{t.config.sectionConnection}</h3>
          {!multiModelMode && (
            <label className="field">
              <span className="field-label">{t.config.baseUrlLabel}</span>
              <input value={config.base_url} onChange={updateConfig("base_url")} placeholder="http://localhost:11434/v1" />
            </label>
          )}
          <div className="field">
            <span className="field-label">{multiModelMode ? t.config.compareTargetsLabel : t.config.modelLabel}</span>
            {!multiModelMode ? (
              <div className="input-with-actions">
                <input value={config.model} onChange={updateConfig("model")} placeholder={t.config.modelPlaceholder} />
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleFetchModels} disabled={loadingModels}>
                  {loadingModels ? t.config.fetchingModels : t.config.fetchModels}
                </button>
                {modelOptions.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) setConfig((c) => ({ ...c, model: e.target.value })); }}
                    className="select-sm"
                  >
                    <option value="">{t.config.selectFetchedModel}</option>
                    {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                )}
              </div>
            ) : (
              <div className="message-list">
                {compareTargets.map((tg, idx) => (
                  <div key={idx} className="compare-target-block">
                    <div className="message-row">
                      <input
                        value={tg.base_url}
                        onChange={(e) => { const next = compareTargets.slice(); next[idx] = { ...next[idx], base_url: e.target.value }; setCompareTargets(next); }}
                        placeholder="http://localhost:11434/v1"
                        className="input-sm message-content-input"
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        onClick={() => setCompareTargets((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        ×
                      </button>
                    </div>
                    <div className="message-row compare-target-row">
                      <input
                        value={tg.model}
                        onChange={(e) => { const next = compareTargets.slice(); next[idx] = { ...next[idx], model: e.target.value }; setCompareTargets(next); }}
                        placeholder={t.config.modelPlaceholder}
                        className="input-sm"
                      />
                      <input
                        value={tg.auth_header}
                        onChange={(e) => { const next = compareTargets.slice(); next[idx] = { ...next[idx], auth_header: e.target.value }; setCompareTargets(next); }}
                        placeholder={t.config.authHeaderPlaceholder}
                        className="input-sm"
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleFetchModelsForTarget(idx)}
                        disabled={!!compareFetchState && compareFetchState.index === idx && compareFetchState.loading}
                      >
                        {compareFetchState && compareFetchState.index === idx && compareFetchState.loading
                          ? t.config.fetchingModels
                          : t.config.fetchModels}
                      </button>
                    </div>
                    {compareFetchState && compareFetchState.index === idx && !compareFetchState.loading && compareFetchState.options.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          const picked = e.target.value;
                          if (!picked) return;
                          const next = compareTargets.slice();
                          next[idx] = { ...next[idx], model: picked };
                          setCompareTargets(next);
                          setCompareFetchState(null);
                        }}
                        className="select-sm"
                      >
                        <option value="">{t.config.selectFetchedModel}</option>
                        {compareFetchState.options.map((mo) => <option key={mo} value={mo}>{mo}</option>)}
                      </select>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setCompareTargets((prev) => [...prev, { base_url: config.base_url, model: "", auth_header: config.auth_header || "" }])}
                >
                  {t.config.addModel}
                </button>
              </div>
            )}
          </div>
          {!multiModelMode && (
            <>
              <label className="field">
                <span className="field-label">{t.config.authHeaderLabel}</span>
                <input value={config.auth_header || ""} onChange={updateConfig("auth_header")} placeholder={t.config.authHeaderPlaceholder} />
              </label>
              <label className="field">
                <span className="field-label">{t.config.customHeadersLabel}</span>
                <textarea
                  rows={3}
                  value={config.custom_headers ? JSON.stringify(config.custom_headers, null, 2) : ""}
                  onChange={handleCustomHeadersChange}
                  placeholder='{ "X-Custom-Header": "value" }'
                />
              </label>
            </>
          )}
        </div>

        <div className="panel-block">
          <h3 className="panel-block-title">{t.config.sectionLoad}</h3>
          {!multiModelMode && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={concurrencySweepMode}
                onChange={(e) => {
                  setConcurrencySweepMode(e.target.checked);
                  if (e.target.checked) setRateMode(false);
                }}
              />
              {t.config.sweepConcurrencyToggle}
            </label>
          )}
          {!multiModelMode && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={rateMode}
                onChange={(e) => {
                  setRateMode(e.target.checked);
                  if (e.target.checked) setConcurrencySweepMode(false);
                }}
              />
              {t.config.rateModeToggle}
            </label>
          )}
          <div className="field-grid">
            <label className="field">
              <span className="field-label">{rateMode ? t.config.requestRatePerSec : t.config.concurrency}</span>
              {concurrencySweepMode ? (
                <input
                  value={sweepConcurrencyInput}
                  onChange={(e) => setSweepConcurrencyInput(e.target.value)}
                  placeholder="1,2,4,8,16"
                />
              ) : rateMode ? (
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={requestRateInput}
                  onChange={(e) => setRequestRateInput(e.target.value)}
                  placeholder="10"
                />
              ) : (
                <input type="number" min="1" max="50" value={config.concurrency} onChange={updateConfig("concurrency")} />
              )}
            </label>
            <label className="field">
              <span className="field-label">{t.config.numRequests}</span>
              <input type="number" min="1" max="1000" value={config.num_requests} onChange={updateConfig("num_requests")} />
            </label>
            <label className="field">
              <span className="field-label">{t.config.batchIntervalMs}</span>
              <input type="number" min="0" value={config.batch_interval_ms} onChange={updateConfig("batch_interval_ms")} />
            </label>
            <label className="field">
              <span className="field-label">{t.config.perRequestIntervalMs}</span>
              <input type="number" min="0" value={config.per_request_interval_ms} onChange={updateConfig("per_request_interval_ms")} />
            </label>
            <label className="field">
              <span className="field-label">{t.config.maxRetries}</span>
              <input type="number" min="0" max="10" value={config.max_retries} onChange={updateConfig("max_retries")} />
            </label>
            <label className="field">
              <span className="field-label">{t.config.requestTimeoutMs}</span>
              <input type="number" min="1000" step="1000" value={config.request_timeout_ms} onChange={updateConfig("request_timeout_ms")} />
            </label>
            <label className="field">
              <span className="field-label">{t.config.maxTokens}</span>
              <input type="number" min="1" max="4096" value={config.max_tokens} onChange={updateConfig("max_tokens")} />
            </label>
            <label className="field">
              <span className="field-label">{t.config.temperature}</span>
              <input type="number" min="0" max="2" step="0.1" value={config.temperature} onChange={updateConfig("temperature")} />
            </label>
            <label className="field">
              <span className="field-label">{t.config.warmupRequests}</span>
              <input type="number" min="0" value={config.warmup_requests ?? 0} onChange={updateConfig("warmup_requests")} />
            </label>
          </div>
        </div>

        <div className="panel-block">
          <h3 className="panel-block-title">
            {(config.endpoint_type ?? "chat") === "chat"
              ? t.config.sectionPrompt
              : config.endpoint_type === "embeddings"
                ? t.config.sectionEmbeddingsInput
                : t.config.sectionRerankInput}
          </h3>

          {(config.endpoint_type ?? "chat") === "chat" && (
            <>
              <div className="segmented">
                <button className={"segmented-btn" + (!multiTurnMode ? " active" : "")} onClick={() => setMultiTurnMode(false)}>{t.config.singleTurn}</button>
                <button className={"segmented-btn" + (multiTurnMode ? " active" : "")} onClick={() => setMultiTurnMode(true)}>{t.config.multiTurn}</button>
              </div>

              {!multiTurnMode ? (
                <div className="field">
                  <span className="field-label">{t.config.promptLabel}</span>
                  <textarea rows={5} value={config.prompt} onChange={updateConfig("prompt")} />
                  <div className="field-row-actions">
                    <button className="btn btn-secondary btn-sm" onClick={handleImportPrompts}>{t.config.importPrompts}</button>
                    {importedPrompts.length > 0 && (
                      <span className="hint hint-success">{t.config.importedCount(importedPrompts.length)}</span>
                    )}
                  </div>
                  <div className="field-row-actions">
                    <input
                      type="number"
                      min="1"
                      value={syntheticTokenTarget}
                      onChange={(e) => setSyntheticTokenTarget(e.target.value)}
                      className="input-sm synthetic-token-input"
                      placeholder={t.config.syntheticTokensPlaceholder}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleGenerateSyntheticPrompt}
                      disabled={generatingSyntheticPrompt}
                    >
                      {generatingSyntheticPrompt ? t.config.generatingSyntheticPrompt : t.config.generateSyntheticPrompt}
                    </button>
                  </div>
                  <div className="field-divider" />
                  <span className="field-label">{t.config.imageInputLabel}</span>
                  <div className="field-row-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleAttachImage}
                      disabled={attachingImage}
                    >
                      {attachingImage ? t.config.attachingImage : t.config.attachImage}
                    </button>
                    {config.image_data_url && (
                      <span className="image-attachment-preview">
                        <img src={config.image_data_url} alt="" className="image-attachment-thumb" />
                        <button type="button" className="btn btn-ghost btn-xs" onClick={handleRemoveImage}>
                          {t.config.removeImage}
                        </button>
                      </span>
                    )}
                  </div>
                  {importedPrompts.length > 0 && (
                    <label className="checkbox-field">
                      <input type="checkbox" checked={usePromptCycling} onChange={(e) => setUsePromptCycling(e.target.checked)} />
                      {t.config.cyclePrompts}
                    </label>
                  )}
                </div>
              ) : (
                <div className="message-list">
                  {messagePairs.map((pair, idx) => (
                    <div key={idx} className="message-row">
                      <select
                        value={pair.role}
                        onChange={(e) => { const next = messagePairs.slice(); next[idx] = { ...next[idx], role: e.target.value }; setMessagePairs(next); }}
                        className="select-sm"
                      >
                        <option value="system">{t.config.roleSystem}</option>
                        <option value="user">{t.config.roleUser}</option>
                        <option value="assistant">{t.config.roleAssistant}</option>
                      </select>
                      <input
                        value={pair.content}
                        onChange={(e) => { const next = messagePairs.slice(); next[idx] = { ...next[idx], content: e.target.value }; setMessagePairs(next); }}
                        placeholder={t.config.messageContentPlaceholder}
                        className="input-sm message-content-input"
                      />
                      <button className="btn btn-ghost btn-icon" onClick={() => { const next = messagePairs.slice(); next.splice(idx, 1); setMessagePairs(next); }}>×</button>
                    </div>
                  ))}
                  <button className="btn btn-secondary btn-sm" onClick={() => setMessagePairs((p) => [...p, { role: "user", content: "" }])}>{t.config.addMessage}</button>
                </div>
              )}
            </>
          )}

          {config.endpoint_type === "embeddings" && (
            <div className="field">
              <span className="field-label">{t.config.embeddingInputsLabel}</span>
              <textarea
                rows={6}
                value={embeddingInputsText}
                onChange={(e) => setEmbeddingInputsText(e.target.value)}
                placeholder={t.config.embeddingInputsPlaceholder}
              />
            </div>
          )}

          {config.endpoint_type === "rerank" && (
            <>
              <div className="field">
                <span className="field-label">{t.config.rerankQueryLabel}</span>
                <input value={config.rerank_query || ""} onChange={updateConfig("rerank_query")} placeholder={t.config.rerankQueryPlaceholder} />
              </div>
              <div className="field">
                <span className="field-label">{t.config.rerankDocumentsLabel}</span>
                <textarea
                  rows={6}
                  value={rerankDocumentsText}
                  onChange={(e) => setRerankDocumentsText(e.target.value)}
                  placeholder={t.config.rerankDocumentsPlaceholder}
                />
              </div>
            </>
          )}
        </div>
      </aside>

      <section className="dashboard-panel">
        <div className="progress-card">
          {batchProgress && (
            <div className="hint batch-progress-label">
              {concurrencySweepMode
                ? t.config.sweepProgressLabel(batchProgress.index, batchProgress.total, batchProgress.model)
                : t.config.batchModelLabel(batchProgress.index, batchProgress.total, batchProgress.model)}
            </div>
          )}
          <div className="progress-bar-wrap">
            <div className="progress-bar-fill" style={{ width: currentPct + "%" }} />
          </div>
          <div className="progress-meta">
            <span>{progress.completed} / {progress.total} {t.config.requestsSuffix}</span>
            <span>{currentPct}%</span>
          </div>
        </div>

        {/* recentTtft/recentTpot 和 avgThroughput 这三张卡片必须用同一份
            "现在到底是不是 chat 模式"的判断依据，不能各看各的：avgThroughput
            天然只在跑完一次单次压测后才出现，这时哪怕用户已经把 Endpoint Type
            切到了别的模式（还没开始新的一轮），三张卡片也应该继续按"刚跑完的
            这份报告"来判断，而不是让 recentTtft/recentTpot 看当前选择的模式、
            avgThroughput 看报告自己的模式，两边各自为政导致同一行卡片互相矛盾。
            没有已完成的单次结果时，才退回看当前表单选择的模式。 */}
        {(() => {
          const dashboardIsChat = result?.kind === "single"
            ? (result.report.config.endpoint_type ?? "chat") === "chat"
            : (config.endpoint_type ?? "chat") === "chat";
          return (
        <div className="metric-cards">
          <div className={"stat-tile status-" + status}>
            <span className="stat-label">{t.config.statusLabel}</span>
            <span className="stat-value stat-value-text">{status === "idle" ? t.config.statusIdle : status === "running" ? t.config.statusRunning : t.config.statusDone}</span>
          </div>
          {dashboardIsChat && (
            <>
              <div className="stat-tile">
                <span className="stat-label">{t.config.recentTtft}</span>
                <span className="stat-value">{lastMetric ? lastMetric.ttft.toFixed(1) : "–"}</span>
                <span className="stat-unit">ms</span>
              </div>
              <div className="stat-tile">
                <span className="stat-label">{t.config.recentTpot}</span>
                <span className="stat-value">{lastMetric ? lastMetric.tpot.toFixed(2) : "–"}</span>
                <span className="stat-unit">ms</span>
              </div>
            </>
          )}
          {result?.kind === "single" && (() => {
            const isChat = dashboardIsChat;
            return (
              <div className="stat-tile accent">
                <span className="stat-label">{t.config.avgThroughput}</span>
                <span className="stat-value">{(isChat ? result.report.avg_throughput_tok_s : (result.report.avg_throughput_items_s ?? 0)).toFixed(1)}</span>
                <span className="stat-unit">{isChat ? "tokens/s" : "items/s"}</span>
              </div>
            );
          })()}
        </div>
          );
        })()}

        <div className="chart-card">
          <div className="chart-card-header">
            <h3>{t.config.liveMetrics}</h3>
            <div className="legend">
              <span className="legend-item"><i className="legend-dot" style={{ background: CHART_TTFT }} />TTFT</span>
              <span className="legend-item"><i className="legend-dot" style={{ background: CHART_TPOT }} />TPOT</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={metricsData}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartChrome.grid} vertical={false} />
              <XAxis dataKey="x" stroke={chartChrome.axis} tick={{ fontSize: 11 }} label={{ value: t.config.requestIndexAxis, position: "insideBottom", offset: -4, fill: chartChrome.axis, fontSize: 11 }} />
              <YAxis stroke={chartChrome.axis} tick={{ fontSize: 11 }} label={{ value: "ms", angle: -90, position: "insideLeft", fill: chartChrome.axis, fontSize: 11 }} />
              <Tooltip contentStyle={{ background: chartChrome.tooltipBg, border: "1px solid " + chartChrome.tooltipBorder, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: chartChrome.tooltipText }} />
              <Line type="monotone" dataKey="ttft" stroke={CHART_TTFT} strokeWidth={2} dot={false} name="TTFT" />
              <Line type="monotone" dataKey="tpot" stroke={CHART_TPOT} strokeWidth={2} dot={false} name="TPOT" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="stream-card">
          <h3>{t.config.tokenStream}</h3>
          <pre className="token-stream">{currentToken || t.config.waitingForBench}</pre>
        </div>

        <div className="log-card">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? t.config.hideLogs : t.config.viewLogs} ({logs.length})
          </button>
          {showLogs && renderLogsBody()}
        </div>
      </section>
    </div>
  );

  // ─── RESULTS view ───────────────────────────────────────────
  const renderBatchComparisonView = (batchResults: { label: string; report: BenchReport }[]) => (
    <div className="view">
      <div className="view-header">
        <div>
          <h2>{t.config.modelComparisonTitle}</h2>
          <p className="view-subtitle">
            {batchResults.map((b) => b.label).join(" · ")}
            {batchResults[0] && ` · ${t.results.runMeta(batchResults[0].report.config.concurrency, batchResults[0].report.config.num_requests)}`}
          </p>
        </div>
        <div className="view-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs((v) => !v)}>{showLogs ? t.config.hideLogs : t.config.viewLogs}</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setViewMode("config")}>{t.results.backToConfig}</button>
        </div>
      </div>

      <section className="table-card">
        <h3>{t.config.modelComparisonTitle}</h3>
        {renderMultiMetricTable(batchResults, t)}
      </section>

      <section className="export-row">
        <button className="btn btn-primary btn-sm" onClick={() => handleExportComparison(batchResults, "json")}>{t.results.exportJson}</button>
        <button className="btn btn-primary btn-sm" onClick={() => handleExportComparison(batchResults, "csv")}>{t.results.exportCsv}</button>
      </section>
    </div>
  );

  const renderSweepView = (sweepResults: { concurrency: number; report: BenchReport }[]) => {
    const isChat = (sweepResults[0]?.report.config.endpoint_type ?? "chat") === "chat";
    const chartData = sweepResults.map((s) => ({
      concurrency: s.concurrency,
      throughput: isChat ? s.report.avg_throughput_tok_s : (s.report.avg_throughput_items_s ?? 0),
      latency: isChat ? s.report.ttft_p50_ms : s.report.e2e_p50_ms,
    }));
    const throughputUnit = isChat ? "tokens/s" : "items/s";
    const latencyLegendLabel = isChat ? "TTFT P50" : "E2E P50";
    const sweepEntries = sweepResults.map((s) => ({ label: `c=${s.concurrency}`, report: s.report }));
    return (
      <div className="view">
        <div className="view-header">
          <div>
            <h2>{t.config.sweepResultsTitle}</h2>
            <p className="view-subtitle">
              {sweepResults[0] && `${sweepResults[0].report.config.model} · ${sweepResults[0].report.config.base_url} · ${sweepResults[0].report.config.num_requests} ${t.config.requestsSuffix} · `}
              {sweepResults.map((s) => `c=${s.concurrency}`).join(" · ")}
            </p>
          </div>
          <div className="view-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs((v) => !v)}>{showLogs ? t.config.hideLogs : t.config.viewLogs}</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setViewMode("config")}>{t.results.backToConfig}</button>
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-card-header">
            <h3>{t.config.sweepChartTitle}</h3>
            <div className="legend">
              <span className="legend-item"><i className="legend-dot" style={{ background: CHART_THROUGHPUT }} />{t.config.sweepThroughputLegend}</span>
              <span className="legend-item"><i className="legend-dot" style={{ background: CHART_TTFT }} />{latencyLegendLabel}</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartChrome.grid} vertical={false} />
              <XAxis
                dataKey="concurrency"
                stroke={chartChrome.axis}
                tick={{ fontSize: 12 }}
                label={{ value: t.config.concurrency, position: "insideBottom", offset: -4, fill: chartChrome.axis, fontSize: 11 }}
              />
              <YAxis
                yAxisId="throughput"
                stroke={chartChrome.axis}
                tick={{ fontSize: 11 }}
                label={{ value: throughputUnit, angle: -90, position: "insideLeft", fill: chartChrome.axis, fontSize: 11 }}
              />
              <YAxis
                yAxisId="latency"
                orientation="right"
                stroke={chartChrome.axis}
                tick={{ fontSize: 11 }}
                label={{ value: "ms", angle: 90, position: "insideRight", fill: chartChrome.axis, fontSize: 11 }}
              />
              <Tooltip
                contentStyle={{ background: chartChrome.tooltipBg, border: "1px solid " + chartChrome.tooltipBorder, borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: chartChrome.tooltipText }}
              />
              <Line yAxisId="throughput" type="monotone" dataKey="throughput" stroke={CHART_THROUGHPUT} strokeWidth={2} dot name="Throughput" />
              <Line yAxisId="latency" type="monotone" dataKey="latency" stroke={CHART_TTFT} strokeWidth={2} dot name={latencyLegendLabel} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <section className="table-card">
          <h3>{t.config.sweepResultsTitle}</h3>
          {renderMultiMetricTable(sweepEntries, t)}
        </section>

        <section className="export-row">
          <button className="btn btn-primary btn-sm" onClick={() => handleExportComparison(sweepEntries, "json")}>{t.results.exportJson}</button>
          <button className="btn btn-primary btn-sm" onClick={() => handleExportComparison(sweepEntries, "csv")}>{t.results.exportCsv}</button>
        </section>
      </div>
    );
  };

  const renderResultsView = () => {
    if (!result) {
      return (
        <div className="view">
          <p className="empty-hint">{t.results.emptyHint}</p>
        </div>
      );
    }
    if (result.kind === "sweep") {
      return renderSweepView(result.results);
    }
    if (result.kind === "batch") {
      return renderBatchComparisonView(result.results);
    }
    const r = result.report;
    const isChat = (r.config.endpoint_type ?? "chat") === "chat";
    const pctData = isChat
      ? [
          { name: "TTFT", p50: r.ttft_p50_ms, p90: r.ttft_p90_ms, p95: r.ttft_p95_ms, p99: r.ttft_p99_ms },
          { name: "TPOT", p50: r.tpot_p50_ms, p90: r.tpot_p90_ms, p95: r.tpot_p95_ms, p99: r.tpot_p99_ms },
          { name: "E2E", p50: r.e2e_p50_ms, p90: r.e2e_p90_ms, p95: r.e2e_p95_ms, p99: r.e2e_p99_ms },
        ]
      : [{ name: "E2E", p50: r.e2e_p50_ms, p90: r.e2e_p90_ms, p95: r.e2e_p95_ms, p99: r.e2e_p99_ms }];

    return (
      <div className="view">
        <div className="view-header">
          <div>
            <h2>{t.results.title}</h2>
            <p className="view-subtitle">{r.config.model} · {r.config.base_url} · {t.results.runMeta(r.config.concurrency, r.config.num_requests)}</p>
          </div>
          <div className="view-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs((v) => !v)}>{showLogs ? t.config.hideLogs : t.config.viewLogs}</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setViewMode("config")}>{t.results.backToConfig}</button>
          </div>
        </div>

        <section className="metric-cards">
          <div className="stat-tile accent">
            <span className="stat-label">{t.results.avgThroughput}</span>
            <span className="stat-value">{(isChat ? r.avg_throughput_tok_s : (r.avg_throughput_items_s ?? 0)).toFixed(1)}</span>
            <span className="stat-unit">{isChat ? "tokens/s" : "items/s"}</span>
          </div>
          <div className={"stat-tile" + (r.success_rate_pct >= 99.5 ? " good" : r.success_rate_pct < 90 ? " critical" : "")}>
            <span className="stat-label">{t.results.successRate}</span>
            <span className="stat-value">{r.success_rate_pct.toFixed(1)}</span>
            <span className="stat-unit">%</span>
          </div>
          {isChat ? (
            <>
              <div className="stat-tile">
                <span className="stat-label">{t.results.ttftP50}</span>
                <span className="stat-value">{r.ttft_p50_ms.toFixed(2)}</span>
                <span className="stat-unit">ms</span>
              </div>
              <div className="stat-tile">
                <span className="stat-label">{t.results.tpotP90}</span>
                <span className="stat-value">{r.tpot_p90_ms.toFixed(3)}</span>
                <span className="stat-unit">ms</span>
              </div>
            </>
          ) : (
            <>
              <div className="stat-tile">
                <span className="stat-label">{t.results.e2eP50Label}</span>
                <span className="stat-value">{r.e2e_p50_ms.toFixed(2)}</span>
                <span className="stat-unit">ms</span>
              </div>
              <div className="stat-tile">
                <span className="stat-label">{t.results.e2eP99Label}</span>
                <span className="stat-value">{r.e2e_p99_ms.toFixed(2)}</span>
                <span className="stat-unit">ms</span>
              </div>
            </>
          )}
        </section>

        <section className="chart-card">
          <div className="chart-card-header">
            <h3>{t.results.percentileChartTitle}</h3>
            <div className="legend">
              <span className="legend-item"><i className="legend-swatch" style={{ background: PCT_COLORS.p50 }} />P50</span>
              <span className="legend-item"><i className="legend-swatch" style={{ background: PCT_COLORS.p90 }} />P90</span>
              <span className="legend-item"><i className="legend-swatch" style={{ background: PCT_COLORS.p95 }} />P95</span>
              <span className="legend-item"><i className="legend-swatch" style={{ background: PCT_COLORS.p99 }} />P99</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={pctData}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartChrome.grid} vertical={false} />
              <XAxis dataKey="name" stroke={chartChrome.axis} tick={{ fontSize: 12 }} />
              <YAxis stroke={chartChrome.axis} tick={{ fontSize: 11 }} label={{ value: "ms", angle: -90, position: "insideLeft", fill: chartChrome.axis, fontSize: 11 }} />
              <Tooltip contentStyle={{ background: chartChrome.tooltipBg, border: "1px solid " + chartChrome.tooltipBorder, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: chartChrome.tooltipText }} />
              <Bar dataKey="p50" fill={PCT_COLORS.p50} name="P50" radius={[4, 4, 0, 0]} />
              <Bar dataKey="p90" fill={PCT_COLORS.p90} name="P90" radius={[4, 4, 0, 0]} />
              <Bar dataKey="p95" fill={PCT_COLORS.p95} name="P95" radius={[4, 4, 0, 0]} />
              <Bar dataKey="p99" fill={PCT_COLORS.p99} name="P99" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </section>

        <section className="table-card">
          <h3>{t.results.detailTableTitle}</h3>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.results.colIndex}</th>
                  {isChat && <th>{t.results.colTtft}</th>}
                  {isChat && <th>{t.results.colTpotAvg}</th>}
                  <th>{t.results.colE2e}</th>
                  <th>{isChat ? t.results.colTokens : t.results.colItems}</th>
                  <th>{t.results.colStatus}</th>
                </tr>
              </thead>
              <tbody>
                {r.metrics.map((m) => (
                  <tr key={m.request_id}>
                    <td>{m.request_id}</td>
                    {isChat && <td>{fmtMs(m.ttft_us)}</td>}
                    {isChat && <td>{m.tpots.length > 0 ? (m.tpots.reduce((a, b) => a + b, 0) / m.tpots.length / 1000).toFixed(4) : "-"}</td>}
                    <td>{fmtMs(m.e2e_latency_us)}</td>
                    <td>{isChat ? m.token_count : (m.item_count ?? 0)}</td>
                    <td><span className={"badge " + (m.success ? "badge-good" : "badge-critical")}>{m.success ? t.results.statusSuccess : t.results.statusFailure}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="export-row">
          <button className="btn btn-primary btn-sm" onClick={() => handleExport("json")}>{t.results.exportJson}</button>
          <button className="btn btn-primary btn-sm" onClick={() => handleExport("csv")}>{t.results.exportCsv}</button>
          <button className="btn btn-secondary btn-sm" onClick={exportLogs}>{t.results.exportLogs}</button>
        </section>

        {showLogs && (
          <section className="table-card">
            <div className="view-header-sm">
              <h3>{t.results.runLogTitle(logs.length)}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setLogs([])}>{t.logs.clear}</button>
            </div>
            {renderLogsBody()}
          </section>
        )}
      </div>
    );
  };

  // ─── HISTORY view ───────────────────────────────────────────
  const renderHistoryView = () => (
    <div className="view">
      <div className="view-header">
        <div>
          <h2>{t.history.title}</h2>
          <p className="view-subtitle">{t.history.subtitle}</p>
        </div>
        <div className="view-actions">
          <button className="btn btn-ghost btn-sm" onClick={handleLoadReports}>{t.history.refreshList}</button>
          {selectedHistoryReports.length > 0 && <button className="btn btn-secondary btn-sm" onClick={clearHistorySelection}>{t.history.clearComparison}</button>}
        </div>
      </div>

      <section className="table-card">
        <h3>{t.history.savedReportsTitle}</h3>
        {reports.length === 0 ? (
          <p className="empty-hint">{t.history.emptyHint}</p>
        ) : (
          <div className="report-list">
            {reports.map((rep) => {
              const isSelected = selectedHistoryReports.some((r) => r.path === rep.path);
              return (
                <div
                  className={"report-row" + (isSelected ? " report-row-selected" : "")}
                  key={rep.path}
                  role="checkbox"
                  aria-checked={isSelected}
                  tabIndex={0}
                  onClick={() => handleToggleHistorySelection(rep)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleToggleHistorySelection(rep); } }}
                >
                  <div className="report-row-main">
                    <span className="report-model">{rep.model}</span>
                    <span className="report-meta">{t.history.requestsAndTime(rep.num_requests, rep.created_at)}</span>
                  </div>
                  <div className="report-row-actions">
                    <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); handleViewReportDetail(rep.path); }}>{t.history.viewDetail}</button>
                    <button className="btn btn-ghost btn-sm btn-danger-text" onClick={(e) => { e.stopPropagation(); handleDeleteSavedReport(rep.path); }}>{t.history.delete}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {selectedHistoryReports.length > 0 && (
        <section className="table-card">
          <h3>{t.history.compareResultTitle}</h3>
          <div className="compare-hint">
            {selectedHistoryReports.map((r) => <span key={r.path} className="chip chip-static">{r.label}</span>)}
          </div>
          {renderMultiMetricTable(selectedHistoryReports.map((r) => ({ label: r.label, report: r.report })), t)}
        </section>
      )}
    </div>
  );

  const renderSavePresetModal = () => (
    <div className="modal-backdrop" onClick={() => setShowSavePresetModal(false)}>
      <div className="modal-panel modal-panel-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t.config.savePreset}</h2>
          <button className="btn btn-ghost btn-icon" onClick={() => setShowSavePresetModal(false)} aria-label={t.settings.close}>×</button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">{t.config.presetNamePlaceholder}</span>
            <input
              autoFocus
              value={presetNameInput}
              onChange={(e) => setPresetNameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSavePreset(); if (e.key === "Escape") setShowSavePresetModal(false); }}
              placeholder={t.config.presetNamePlaceholder}
            />
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary btn-sm" onClick={() => setShowSavePresetModal(false)}>{t.topbar.cancel}</button>
          <button className="btn btn-primary btn-sm" onClick={handleSavePreset} disabled={!presetNameInput.trim()}>{t.config.savePreset}</button>
        </div>
      </div>
    </div>
  );

  // ─── SETTINGS panel ─────────────────────────────────────────
  const renderSettingsPanel = () => (
    <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t.settings.title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={() => setShowSettings(false)} aria-label={t.settings.close}>×</button>
        </div>
        <div className="modal-tabs">
          <button className={"modal-tab" + (settingsTab === "general" ? " active" : "")} onClick={() => setSettingsTab("general")}>{t.settings.tabGeneral}</button>
          <button className={"modal-tab" + (settingsTab === "about" ? " active" : "")} onClick={() => setSettingsTab("about")}>{t.settings.tabAbout}</button>
        </div>

        {settingsTab === "general" ? (
          <div className="modal-body">
            <div className="settings-row">
              <span className="settings-row-label">{t.settings.languageLabel}</span>
              <select className="select-sm" value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
                <option value="en">{t.settings.languageEn}</option>
                <option value="zh-CN">{t.settings.languageZhCN}</option>
                <option value="zh-TW">{t.settings.languageZhTW}</option>
              </select>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">{t.settings.themeLabel}</span>
              <div className="segmented">
                <button className={"segmented-btn" + (theme === "light" ? " active" : "")} onClick={() => setTheme("light")}>{t.settings.themeLight}</button>
                <button className={"segmented-btn" + (theme === "dark" ? " active" : "")} onClick={() => setTheme("dark")}>{t.settings.themeDark}</button>
                <button className={"segmented-btn" + (theme === "system" ? " active" : "")} onClick={() => setTheme("system")}>{t.settings.themeSystem}</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="modal-body">
            <div className="settings-row">
              <span className="settings-row-label">{t.about.versionLabel}</span>
              <span className="settings-row-value">{appVersion || "…"}</span>
            </div>
            <div className="settings-row">
              <span className="settings-row-label" />
              <div className="settings-row-actions">
                <button className="btn btn-secondary btn-sm" onClick={handleCheckForUpdates} disabled={updateStatus === "checking"}>
                  {updateStatus === "checking" ? t.about.checkingUpdate : t.about.checkUpdate}
                </button>
                {updateStatus === "upToDate" && <span className="hint hint-success">{t.about.upToDate}</span>}
                {updateStatus === "available" && (
                  <span className="hint hint-success">
                    {t.about.updateAvailable(updateLatestVersion)}
                    {updateReleaseUrl && (
                      <button className="btn btn-ghost btn-xs" onClick={handleOpenUpdateRelease} style={{ marginLeft: "0.4rem" }}>↗</button>
                    )}
                  </span>
                )}
                {updateStatus === "error" && <span className="hint hint-error">{t.about.updateCheckFailed(updateError)}</span>}
              </div>
            </div>
            {updateStatus === "available" && updateDownloadUrl && (
              <div className="settings-row">
                <span className="settings-row-label" />
                <div className="settings-row-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleInstallUpdate}
                    disabled={updateInstallStatus === "downloading"}
                  >
                    {updateInstallStatus === "downloading" ? t.about.installingUpdate : t.about.installUpdate}
                  </button>
                  {updateInstallStatus === "done" && <span className="hint hint-success">{t.about.installUpdateDone}</span>}
                  {updateInstallStatus === "error" && <span className="hint hint-error">{t.about.installUpdateFailed(updateInstallError)}</span>}
                </div>
              </div>
            )}
            <div className="settings-row">
              <span className="settings-row-label" />
              <div className="settings-row-actions">
                <button className="btn btn-ghost btn-sm" onClick={handleOpenChangelog}>{t.about.changelog}</button>
                <button className="btn btn-ghost btn-sm" onClick={handleOpenGithub}>{t.about.github}</button>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">{t.about.logLevelLabel}</span>
              <select className="select-sm" value={logLevel} onChange={(e) => setLogLevel(e.target.value as LogLevelSetting)}>
                <option value="debug">{t.logs.levelDebug}</option>
                <option value="info">{t.logs.levelInfo}</option>
                <option value="warn">{t.logs.levelWarn}</option>
                <option value="error">{t.logs.levelError}</option>
              </select>
            </div>
            <p className="hint">{t.about.logLevelHint}</p>
          </div>
        )}
      </div>
    </div>
  );

  // ─── Shell ───────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <img src={brandIcon} className="brand-mark" alt="" />
          <div className="brand-text">
            <h1>InferScope</h1>
            <p>{t.topbar.tagline}</p>
          </div>
        </div>

        <nav className="topbar-nav">
          <button className={"nav-tab" + (viewMode === "config" ? " active" : "")} onClick={() => setViewMode("config")}>{t.topbar.tabConfig}</button>
          <button className={"nav-tab" + (viewMode === "results" ? " active" : "")} disabled={!result} onClick={() => result && setViewMode("results")}>{t.topbar.tabResults}</button>
          <button className={"nav-tab" + (viewMode === "history" ? " active" : "")} onClick={openHistory}>{t.topbar.tabHistory}</button>
        </nav>

        <div className="topbar-status">
          {status === "running" && (
            <span className="status-pill">
              <span className="status-dot" />
              {t.topbar.running(progress.completed, progress.total)}
              <button className="btn btn-ghost btn-xs" onClick={handleCancel}>{t.topbar.cancel}</button>
            </span>
          )}
          <button
            className="btn btn-ghost btn-icon settings-trigger"
            onClick={() => setShowSettings(true)}
            aria-label={t.topbar.settings}
            title={t.topbar.settings}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <main className="app-content">
        {viewMode === "config" && renderConfigView()}
        {viewMode === "results" && renderResultsView()}
        {viewMode === "history" && renderHistoryView()}
      </main>

      {showSavePresetModal && renderSavePresetModal()}
      {showSettings && renderSettingsPanel()}
    </div>
  );
}

export default App;
