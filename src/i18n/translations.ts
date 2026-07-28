export type Language = "en" | "zh-CN" | "zh-TW";

export interface Translations {
  topbar: {
    tagline: string;
    tabConfig: string;
    tabResults: string;
    tabHistory: string;
    running: (completed: number, total: number) => string;
    cancel: string;
    settings: string;
  };
  config: {
    sectionPresets: string;
    selectPresetPlaceholder: string;
    noPresetsYet: string;
    presetNotSelected: string;
    presetNamePlaceholder: string;
    savePreset: string;
    deletePreset: string;
    presetOverwriteConfirm: (name: string) => string;
    presetDeleteConfirm: (name: string) => string;
    presetSaveFailed: (msg: string) => string;
    presetLoadFailed: (msg: string) => string;
    presetDeleteFailed: (msg: string) => string;
    sectionConnection: string;
    baseUrlLabel: string;
    modelLabel: string;
    modelPlaceholder: string;
    fetchModels: string;
    fetchingModels: string;
    selectFetchedModel: string;
    benchmarkModeLabel: string;
    singleModelTab: string;
    compareModelsTab: string;
    addModel: string;
    compareTargetsLabel: string;
    modelComparisonTitle: string;
    sweepConcurrencyToggle: string;
    sweepResultsTitle: string;
    sweepChartTitle: string;
    sweepThroughputLegend: string;
    sweepProgressLabel: (i: number, n: number, concurrency: string) => string;
    authHeaderLabel: string;
    authHeaderPlaceholder: string;
    customHeadersLabel: string;
    sectionLoad: string;
    concurrency: string;
    numRequests: string;
    batchIntervalMs: string;
    perRequestIntervalMs: string;
    maxRetries: string;
    requestTimeoutMs: string;
    maxTokens: string;
    temperature: string;
    sectionPrompt: string;
    singleTurn: string;
    multiTurn: string;
    promptLabel: string;
    importPrompts: string;
    importedCount: (n: number) => string;
    cyclePrompts: string;
    roleSystem: string;
    roleUser: string;
    roleAssistant: string;
    messageContentPlaceholder: string;
    addMessage: string;
    startBench: string;
    restartBench: string;
    cancelBench: string;
    requestsSuffix: string;
    batchModelLabel: (i: number, n: number, model: string) => string;
    statusLabel: string;
    statusIdle: string;
    statusRunning: string;
    statusDone: string;
    recentTtft: string;
    recentTpot: string;
    avgThroughput: string;
    liveMetrics: string;
    requestIndexAxis: string;
    tokenStream: string;
    waitingForBench: string;
    viewLogs: string;
    hideLogs: string;
    benchFailedTitle: string;
    benchFailedBody: (msg: string) => string;
    fetchModelsFailed: (msg: string) => string;
    importPromptsFailed: (msg: string) => string;
  };
  logs: {
    allLevels: string;
    levelDebug: string;
    levelInfo: string;
    levelWarn: string;
    levelError: string;
    searchPlaceholder: string;
    refresh: string;
    export: string;
    waiting: string;
    clear: string;
  };
  results: {
    title: string;
    emptyHint: string;
    avgThroughput: string;
    successRate: string;
    ttftP50: string;
    tpotP90: string;
    percentileChartTitle: string;
    detailTableTitle: string;
    colIndex: string;
    colTtft: string;
    colTpotAvg: string;
    colE2e: string;
    colTokens: string;
    colStatus: string;
    statusSuccess: string;
    statusFailure: string;
    exportJson: string;
    exportCsv: string;
    exportLogs: string;
    exportedAlert: (format: string) => string;
    runLogTitle: (n: number) => string;
    backToConfig: string;
    loadReportFailed: (msg: string) => string;
  };
  history: {
    title: string;
    subtitle: string;
    refreshList: string;
    clearComparison: string;
    savedReportsTitle: string;
    emptyHint: string;
    requestsAndTime: (n: number, time: string) => string;
    viewDetail: string;
    delete: string;
    deleteConfirm: (name: string) => string;
    deleteFailed: (msg: string) => string;
    compareResultTitle: string;
    metricCol: string;
    metricThroughput: string;
    metricSuccessRate: string;
    metricTtftP50: string;
    metricTtftP99: string;
    metricTpotP50: string;
    metricTpotP99: string;
    metricE2eP50: string;
    metricE2eP99: string;
  };
  settings: {
    title: string;
    tabGeneral: string;
    tabAbout: string;
    languageLabel: string;
    languageEn: string;
    languageZhCN: string;
    languageZhTW: string;
    themeLabel: string;
    themeLight: string;
    themeDark: string;
    themeSystem: string;
    close: string;
  };
  about: {
    versionLabel: string;
    checkUpdate: string;
    checkingUpdate: string;
    upToDate: string;
    updateAvailable: (v: string) => string;
    updateCheckFailed: (msg: string) => string;
    changelog: string;
    github: string;
    logLevelLabel: string;
    logLevelHint: string;
  };
}

// ─── English (default) ──────────────────────────────────────────
const en: Translations = {
  topbar: {
    tagline: "LLM Inference Benchmark",
    tabConfig: "Config",
    tabResults: "Results",
    tabHistory: "History",
    running: (completed, total) => `Running ${completed}/${total}`,
    cancel: "Cancel",
    settings: "Settings",
  },
  config: {
    sectionPresets: "Presets",
    selectPresetPlaceholder: "Load a preset…",
    noPresetsYet: "No presets saved yet",
    presetNotSelected: "Not selected",
    presetNamePlaceholder: "Preset name",
    savePreset: "Save Preset",
    deletePreset: "Delete Preset",
    presetOverwriteConfirm: (name) => `A preset named "${name}" already exists. Overwrite it?`,
    presetDeleteConfirm: (name) => `Delete preset "${name}"?`,
    presetSaveFailed: (msg) => `Failed to save preset: ${msg}`,
    presetLoadFailed: (msg) => `Failed to load preset: ${msg}`,
    presetDeleteFailed: (msg) => `Failed to delete preset: ${msg}`,
    sectionConnection: "Connection",
    baseUrlLabel: "API Base URL",
    modelLabel: "Model Name",
    modelPlaceholder: "e.g. llama3.2 (you can also type it manually)",
    fetchModels: "Fetch Models",
    fetchingModels: "Fetching…",
    selectFetchedModel: "Select a fetched model…",
    benchmarkModeLabel: "Benchmark Mode",
    singleModelTab: "Single Model",
    compareModelsTab: "Compare Models",
    addModel: "+ Add model",
    compareTargetsLabel: "Models to Compare",
    modelComparisonTitle: "Model Comparison",
    sweepConcurrencyToggle: "Sweep concurrency levels",
    sweepResultsTitle: "Concurrency Sweep",
    sweepChartTitle: "Throughput vs. Latency",
    sweepThroughputLegend: "Throughput",
    sweepProgressLabel: (i, n, concurrency) => `Concurrency ${i}/${n}: ${concurrency}`,
    authHeaderLabel: "API Key (optional)",
    authHeaderPlaceholder: "Bearer sk-xxx, or leave blank for no auth",
    customHeadersLabel: "Custom HTTP Headers (JSON, optional)",
    sectionLoad: "Load Parameters",
    concurrency: "Concurrency",
    numRequests: "Total Requests",
    batchIntervalMs: "Batch Interval (ms)",
    perRequestIntervalMs: "Per-Request Interval (ms)",
    maxRetries: "Max Retries",
    requestTimeoutMs: "Request Timeout (ms)",
    maxTokens: "Max Tokens",
    temperature: "Temperature",
    sectionPrompt: "Prompt",
    singleTurn: "Single-turn",
    multiTurn: "Multi-turn",
    promptLabel: "Prompt",
    importPrompts: "Import Prompts",
    importedCount: (n) => `Imported ${n} prompts, will cycle through them automatically`,
    cyclePrompts: "Cycle through imported prompts (one per request)",
    roleSystem: "system",
    roleUser: "user",
    roleAssistant: "assistant",
    messageContentPlaceholder: "Message content",
    addMessage: "+ Add message",
    startBench: "Start Benchmark",
    restartBench: "Restart Benchmark",
    cancelBench: "Cancel Benchmark",
    requestsSuffix: "requests",
    batchModelLabel: (i, n, model) => `Model ${i}/${n}: ${model}`,
    statusLabel: "Status",
    statusIdle: "Idle",
    statusRunning: "Running",
    statusDone: "Done",
    recentTtft: "Recent TTFT",
    recentTpot: "Recent TPOT",
    avgThroughput: "Avg Throughput",
    liveMetrics: "Live Metrics",
    requestIndexAxis: "Request #",
    tokenStream: "Token Stream",
    waitingForBench: "Waiting for benchmark to start…",
    viewLogs: "View Logs",
    hideLogs: "Hide Logs",
    benchFailedTitle: "Benchmark failed!",
    benchFailedBody: (msg) => `Benchmark failed!\n\nError:\n${msg}\n\nOpen the console (F12) for details`,
    fetchModelsFailed: (msg) => `Failed to fetch model list: ${msg}`,
    importPromptsFailed: (msg) => `Import failed: ${msg}`,
  },
  logs: {
    allLevels: "All levels",
    levelDebug: "Debug",
    levelInfo: "Info",
    levelWarn: "Warn",
    levelError: "Error",
    searchPlaceholder: "Search logs...",
    refresh: "Refresh",
    export: "Export",
    waiting: "Waiting for logs...",
    clear: "Clear",
  },
  results: {
    title: "Benchmark Results",
    emptyHint: "No results yet — run a benchmark from the Config page first.",
    avgThroughput: "Avg Throughput",
    successRate: "Success Rate",
    ttftP50: "TTFT P50",
    tpotP90: "TPOT P90",
    percentileChartTitle: "Percentile Comparison (ms)",
    detailTableTitle: "Detailed Metrics",
    colIndex: "#",
    colTtft: "TTFT (ms)",
    colTpotAvg: "TPOT avg (ms)",
    colE2e: "E2E Latency (ms)",
    colTokens: "Tokens",
    colStatus: "Status",
    statusSuccess: "Success",
    statusFailure: "Failed",
    exportJson: "Export JSON",
    exportCsv: "Export CSV",
    exportLogs: "Export Logs",
    exportedAlert: (format) => `${format} report exported`,
    runLogTitle: (n) => `Run Log (${n})`,
    backToConfig: "Back to Config",
    loadReportFailed: (msg) => `Failed to load report: ${msg}`,
  },
  history: {
    title: "History Comparison",
    subtitle: "Select reports below to compare",
    refreshList: "Refresh List",
    clearComparison: "Clear Comparison",
    savedReportsTitle: "Saved Reports",
    emptyHint: "No reports yet — run a benchmark first.",
    requestsAndTime: (n, time) => `${n} requests · ${time}`,
    viewDetail: "View Detail",
    delete: "Delete",
    deleteConfirm: (name) => `Delete report ${name}?`,
    deleteFailed: (msg) => `Failed to delete report: ${msg}`,
    compareResultTitle: "Comparison",
    metricCol: "Metric",
    metricThroughput: "Avg Throughput",
    metricSuccessRate: "Success Rate",
    metricTtftP50: "TTFT P50",
    metricTtftP99: "TTFT P99",
    metricTpotP50: "TPOT P50",
    metricTpotP99: "TPOT P99",
    metricE2eP50: "E2E P50",
    metricE2eP99: "E2E P99",
  },
  settings: {
    title: "Settings",
    tabGeneral: "General",
    tabAbout: "About",
    languageLabel: "Language",
    languageEn: "English",
    languageZhCN: "简体中文",
    languageZhTW: "繁體中文",
    themeLabel: "Appearance",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "Follow System",
    close: "Close",
  },
  about: {
    versionLabel: "Version",
    checkUpdate: "Check for Updates",
    checkingUpdate: "Checking…",
    upToDate: "You're on the latest version",
    updateAvailable: (v) => `A new version (${v}) is available`,
    updateCheckFailed: (msg) => `Update check failed: ${msg}`,
    changelog: "Changelog",
    github: "GitHub",
    logLevelLabel: "System Log Level",
    logLevelHint: "Messages below this level won't be recorded",
  },
};

// ─── 简体中文 ────────────────────────────────────────────────────
const zhCN: Translations = {
  topbar: {
    tagline: "LLM 推理基准测试",
    tabConfig: "配置",
    tabResults: "结果",
    tabHistory: "历史",
    running: (completed, total) => `压测中 ${completed}/${total}`,
    cancel: "取消",
    settings: "设置",
  },
  config: {
    sectionPresets: "预设",
    selectPresetPlaceholder: "加载预设…",
    noPresetsYet: "还没有保存的预设",
    presetNotSelected: "未选择",
    presetNamePlaceholder: "预设名称",
    savePreset: "保存预设",
    deletePreset: "删除预设",
    presetOverwriteConfirm: (name) => `已存在名为"${name}"的预设，要覆盖吗？`,
    presetDeleteConfirm: (name) => `确定删除预设"${name}"？`,
    presetSaveFailed: (msg) => `保存预设失败：${msg}`,
    presetLoadFailed: (msg) => `加载预设失败：${msg}`,
    presetDeleteFailed: (msg) => `删除预设失败：${msg}`,
    sectionConnection: "连接",
    baseUrlLabel: "API Base URL",
    modelLabel: "模型名称",
    modelPlaceholder: "e.g. llama3.2（也可以手动输入）",
    fetchModels: "获取模型",
    fetchingModels: "获取中…",
    selectFetchedModel: "选择已获取的模型…",
    benchmarkModeLabel: "压测模式",
    singleModelTab: "单个模型",
    compareModelsTab: "对比多个模型",
    addModel: "+ 添加模型",
    compareTargetsLabel: "对比模型",
    modelComparisonTitle: "模型对比结果",
    sweepConcurrencyToggle: "扫描多个并发数",
    sweepResultsTitle: "并发扫描结果",
    sweepChartTitle: "吞吐量 vs 延迟",
    sweepThroughputLegend: "吞吐量",
    sweepProgressLabel: (i, n, concurrency) => `并发数 ${i}/${n}：${concurrency}`,
    authHeaderLabel: "API 密钥（可选）",
    authHeaderPlaceholder: "Bearer sk-xxx 或留空不使用认证",
    customHeadersLabel: "自定义 HTTP 头（JSON，可选）",
    sectionLoad: "负载参数",
    concurrency: "并发数",
    numRequests: "总请求数",
    batchIntervalMs: "批次间延迟 (ms)",
    perRequestIntervalMs: "请求间延迟 (ms)",
    maxRetries: "最大重试次数",
    requestTimeoutMs: "单请求超时 (ms)",
    maxTokens: "Max Tokens",
    temperature: "Temperature",
    sectionPrompt: "Prompt",
    singleTurn: "单轮对话",
    multiTurn: "多轮对话",
    promptLabel: "Prompt",
    importPrompts: "导入提示词",
    importedCount: (n) => `已导入 ${n} 条，将自动循环使用`,
    cyclePrompts: "循环使用导入的 Prompt（每个请求使用下一条）",
    roleSystem: "system",
    roleUser: "user",
    roleAssistant: "assistant",
    messageContentPlaceholder: "消息内容",
    addMessage: "+ 添加消息",
    startBench: "开始压测",
    restartBench: "重新开始压测",
    cancelBench: "取消压测",
    requestsSuffix: "请求",
    batchModelLabel: (i, n, model) => `模型 ${i}/${n}：${model}`,
    statusLabel: "状态",
    statusIdle: "待开始",
    statusRunning: "运行中",
    statusDone: "已完成",
    recentTtft: "最近 TTFT",
    recentTpot: "最近 TPOT",
    avgThroughput: "平均吞吐",
    liveMetrics: "实时指标",
    requestIndexAxis: "请求序号",
    tokenStream: "Token 流",
    waitingForBench: "等待压测开始…",
    viewLogs: "查看日志",
    hideLogs: "隐藏日志",
    benchFailedTitle: "压测失败！",
    benchFailedBody: (msg) => `压测失败！\n\n错误信息:\n${msg}\n\n请在浏览器控制台(F12)查看详细日志`,
    fetchModelsFailed: (msg) => `获取模型列表失败: ${msg}`,
    importPromptsFailed: (msg) => `导入失败: ${msg}`,
  },
  logs: {
    allLevels: "全部级别",
    levelDebug: "Debug",
    levelInfo: "Info",
    levelWarn: "Warn",
    levelError: "Error",
    searchPlaceholder: "搜索日志...",
    refresh: "刷新",
    export: "导出",
    waiting: "等待日志...",
    clear: "清空",
  },
  results: {
    title: "基准测试结果",
    emptyHint: "还没有可显示的结果，先在「配置」页运行一次压测。",
    avgThroughput: "平均吞吐",
    successRate: "成功率",
    ttftP50: "TTFT P50",
    tpotP90: "TPOT P90",
    percentileChartTitle: "百分位对比（毫秒）",
    detailTableTitle: "详细指标",
    colIndex: "#",
    colTtft: "TTFT (ms)",
    colTpotAvg: "TPOT avg (ms)",
    colE2e: "E2E Latency (ms)",
    colTokens: "Tokens",
    colStatus: "状态",
    statusSuccess: "成功",
    statusFailure: "失败",
    exportJson: "导出 JSON",
    exportCsv: "导出 CSV",
    exportLogs: "导出日志",
    exportedAlert: (format) => `${format} 报告已导出`,
    runLogTitle: (n) => `运行日志 (${n})`,
    backToConfig: "返回配置",
    loadReportFailed: (msg) => `加载报告失败: ${msg}`,
  },
  history: {
    title: "历史报告对比",
    subtitle: "在下方勾选要对比的报告",
    refreshList: "刷新列表",
    clearComparison: "清空对比",
    savedReportsTitle: "已保存报告",
    emptyHint: "暂无报告，先运行一次压测后查看。",
    requestsAndTime: (n, time) => `${n} 请求 · ${time}`,
    viewDetail: "查看详情",
    delete: "删除",
    deleteConfirm: (name) => `确定删除报告 ${name}？`,
    deleteFailed: (msg) => `删除报告失败: ${msg}`,
    compareResultTitle: "对比结果",
    metricCol: "指标",
    metricThroughput: "平均吞吐",
    metricSuccessRate: "成功率",
    metricTtftP50: "TTFT P50",
    metricTtftP99: "TTFT P99",
    metricTpotP50: "TPOT P50",
    metricTpotP99: "TPOT P99",
    metricE2eP50: "E2E P50",
    metricE2eP99: "E2E P99",
  },
  settings: {
    title: "设置",
    tabGeneral: "通用",
    tabAbout: "关于",
    languageLabel: "界面语言",
    languageEn: "English",
    languageZhCN: "简体中文",
    languageZhTW: "繁體中文",
    themeLabel: "外观主题",
    themeLight: "浅色",
    themeDark: "深灰色",
    themeSystem: "跟随系统",
    close: "关闭",
  },
  about: {
    versionLabel: "版本",
    checkUpdate: "检查更新",
    checkingUpdate: "检查中…",
    upToDate: "已是最新版本",
    updateAvailable: (v) => `发现新版本 ${v}`,
    updateCheckFailed: (msg) => `检查更新失败: ${msg}`,
    changelog: "更新日志",
    github: "GitHub",
    logLevelLabel: "系统日志级别",
    logLevelHint: "低于该级别的日志不会被记录",
  },
};

// ─── 繁體中文 ────────────────────────────────────────────────────
const zhTW: Translations = {
  topbar: {
    tagline: "LLM 推理基準測試",
    tabConfig: "配置",
    tabResults: "結果",
    tabHistory: "歷史",
    running: (completed, total) => `壓測中 ${completed}/${total}`,
    cancel: "取消",
    settings: "設定",
  },
  config: {
    sectionPresets: "預設",
    selectPresetPlaceholder: "載入預設…",
    noPresetsYet: "還沒有儲存的預設",
    presetNotSelected: "未選擇",
    presetNamePlaceholder: "預設名稱",
    savePreset: "儲存預設",
    deletePreset: "刪除預設",
    presetOverwriteConfirm: (name) => `已存在名為「${name}」的預設，要覆蓋嗎？`,
    presetDeleteConfirm: (name) => `確定刪除預設「${name}」？`,
    presetSaveFailed: (msg) => `儲存預設失敗：${msg}`,
    presetLoadFailed: (msg) => `載入預設失敗：${msg}`,
    presetDeleteFailed: (msg) => `刪除預設失敗：${msg}`,
    sectionConnection: "連線",
    baseUrlLabel: "API Base URL",
    modelLabel: "模型名稱",
    modelPlaceholder: "e.g. llama3.2（也可以手動輸入）",
    fetchModels: "取得模型",
    fetchingModels: "取得中…",
    selectFetchedModel: "選擇已取得的模型…",
    benchmarkModeLabel: "壓測模式",
    singleModelTab: "單一模型",
    compareModelsTab: "比較多個模型",
    addModel: "+ 新增模型",
    compareTargetsLabel: "對比模型",
    modelComparisonTitle: "模型比較結果",
    sweepConcurrencyToggle: "掃描多個並發數",
    sweepResultsTitle: "並發掃描結果",
    sweepChartTitle: "吞吐量 vs 延遲",
    sweepThroughputLegend: "吞吐量",
    sweepProgressLabel: (i, n, concurrency) => `並發數 ${i}/${n}：${concurrency}`,
    authHeaderLabel: "API 金鑰（可選）",
    authHeaderPlaceholder: "Bearer sk-xxx 或留空不使用驗證",
    customHeadersLabel: "自訂 HTTP 標頭（JSON，可選）",
    sectionLoad: "負載參數",
    concurrency: "並發數",
    numRequests: "總請求數",
    batchIntervalMs: "批次間延遲 (ms)",
    perRequestIntervalMs: "請求間延遲 (ms)",
    maxRetries: "最大重試次數",
    requestTimeoutMs: "單請求逾時 (ms)",
    maxTokens: "Max Tokens",
    temperature: "Temperature",
    sectionPrompt: "Prompt",
    singleTurn: "單輪對話",
    multiTurn: "多輪對話",
    promptLabel: "Prompt",
    importPrompts: "匯入提示詞",
    importedCount: (n) => `已匯入 ${n} 條，將自動循環使用`,
    cyclePrompts: "循環使用匯入的 Prompt（每個請求使用下一條）",
    roleSystem: "system",
    roleUser: "user",
    roleAssistant: "assistant",
    messageContentPlaceholder: "訊息內容",
    addMessage: "+ 新增訊息",
    startBench: "開始壓測",
    restartBench: "重新開始壓測",
    cancelBench: "取消壓測",
    requestsSuffix: "請求",
    batchModelLabel: (i, n, model) => `模型 ${i}/${n}：${model}`,
    statusLabel: "狀態",
    statusIdle: "待開始",
    statusRunning: "執行中",
    statusDone: "已完成",
    recentTtft: "最近 TTFT",
    recentTpot: "最近 TPOT",
    avgThroughput: "平均吞吐",
    liveMetrics: "即時指標",
    requestIndexAxis: "請求序號",
    tokenStream: "Token 串流",
    waitingForBench: "等待壓測開始…",
    viewLogs: "查看日誌",
    hideLogs: "隱藏日誌",
    benchFailedTitle: "壓測失敗！",
    benchFailedBody: (msg) => `壓測失敗！\n\n錯誤訊息:\n${msg}\n\n請在瀏覽器主控台(F12)查看詳細日誌`,
    fetchModelsFailed: (msg) => `取得模型清單失敗: ${msg}`,
    importPromptsFailed: (msg) => `匯入失敗: ${msg}`,
  },
  logs: {
    allLevels: "全部級別",
    levelDebug: "Debug",
    levelInfo: "Info",
    levelWarn: "Warn",
    levelError: "Error",
    searchPlaceholder: "搜尋日誌...",
    refresh: "重新整理",
    export: "匯出",
    waiting: "等待日誌...",
    clear: "清空",
  },
  results: {
    title: "基準測試結果",
    emptyHint: "還沒有可顯示的結果，先在「配置」頁執行一次壓測。",
    avgThroughput: "平均吞吐",
    successRate: "成功率",
    ttftP50: "TTFT P50",
    tpotP90: "TPOT P90",
    percentileChartTitle: "百分位對比（毫秒）",
    detailTableTitle: "詳細指標",
    colIndex: "#",
    colTtft: "TTFT (ms)",
    colTpotAvg: "TPOT avg (ms)",
    colE2e: "E2E Latency (ms)",
    colTokens: "Tokens",
    colStatus: "狀態",
    statusSuccess: "成功",
    statusFailure: "失敗",
    exportJson: "匯出 JSON",
    exportCsv: "匯出 CSV",
    exportLogs: "匯出日誌",
    exportedAlert: (format) => `${format} 報告已匯出`,
    runLogTitle: (n) => `執行日誌 (${n})`,
    backToConfig: "返回配置",
    loadReportFailed: (msg) => `載入報告失敗: ${msg}`,
  },
  history: {
    title: "歷史報告對比",
    subtitle: "在下方勾選要對比的報告",
    refreshList: "重新整理清單",
    clearComparison: "清空對比",
    savedReportsTitle: "已儲存報告",
    emptyHint: "暫無報告，先執行一次壓測後查看。",
    requestsAndTime: (n, time) => `${n} 請求 · ${time}`,
    viewDetail: "查看詳情",
    delete: "刪除",
    deleteConfirm: (name) => `確定刪除報告 ${name}？`,
    deleteFailed: (msg) => `刪除報告失敗: ${msg}`,
    compareResultTitle: "對比結果",
    metricCol: "指標",
    metricThroughput: "平均吞吐",
    metricSuccessRate: "成功率",
    metricTtftP50: "TTFT P50",
    metricTtftP99: "TTFT P99",
    metricTpotP50: "TPOT P50",
    metricTpotP99: "TPOT P99",
    metricE2eP50: "E2E P50",
    metricE2eP99: "E2E P99",
  },
  settings: {
    title: "設定",
    tabGeneral: "通用",
    tabAbout: "關於",
    languageLabel: "介面語言",
    languageEn: "English",
    languageZhCN: "简体中文",
    languageZhTW: "繁體中文",
    themeLabel: "外觀主題",
    themeLight: "淺色",
    themeDark: "深灰色",
    themeSystem: "跟隨系統",
    close: "關閉",
  },
  about: {
    versionLabel: "版本",
    checkUpdate: "檢查更新",
    checkingUpdate: "檢查中…",
    upToDate: "已是最新版本",
    updateAvailable: (v) => `發現新版本 ${v}`,
    updateCheckFailed: (msg) => `檢查更新失敗: ${msg}`,
    changelog: "更新日誌",
    github: "GitHub",
    logLevelLabel: "系統日誌級別",
    logLevelHint: "低於該級別的日誌不會被記錄",
  },
};

export const translations: Record<Language, Translations> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

export const LANGUAGES: Language[] = ["en", "zh-CN", "zh-TW"];
