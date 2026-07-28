// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::sync::{Arc, OnceLock};
use serde::{Deserialize, Serialize};

pub mod bench;
pub mod settings;
pub mod synthetic_prompt;

static LOG_STORE: OnceLogStore = OnceLogStore::new();

/// 日志级别：数值越大越严重，用来做"最低记录级别"的开关——低于这个
/// 阈值的日志在写入时就直接丢弃，而不是存下来再在查询时过滤掉。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "debug" => Some(LogLevel::Debug),
            "info" => Some(LogLevel::Info),
            "warn" | "warning" => Some(LogLevel::Warn),
            "error" => Some(LogLevel::Error),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Info => "info",
            LogLevel::Warn => "warn",
            LogLevel::Error => "error",
        }
    }
}

/// 当前生效的最低记录级别，默认 Info。设置页里选的"系统日志"级别就是改
/// 这个。用 u8 存 LogLevel 的序号（Debug=0..Error=3），方便原子操作。
static MIN_LOG_LEVEL: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(LogLevel::Info as u8);

/// 设置页保存/加载配置时调用，把字符串形式的级别设置应用到全局阈值上。
/// 传入无法识别的字符串就保持原样不变（不报错，容错处理）。
pub fn apply_log_level(level_str: &str) {
    if let Some(level) = LogLevel::parse(level_str) {
        MIN_LOG_LEVEL.store(level as u8, std::sync::atomic::Ordering::SeqCst);
    }
}

fn min_log_level() -> LogLevel {
    match MIN_LOG_LEVEL.load(std::sync::atomic::Ordering::SeqCst) {
        0 => LogLevel::Debug,
        1 => LogLevel::Info,
        2 => LogLevel::Warn,
        _ => LogLevel::Error,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: LogLevel,
    pub tag: String,
    pub message: String,
}

struct OnceLogStore {
    inner: OnceLock<Arc<std::sync::Mutex<Vec<LogEntry>>>>,
}

impl OnceLogStore {
    const fn new() -> Self {
        Self { inner: OnceLock::new() }
    }

    fn get(&self) -> Arc<std::sync::Mutex<Vec<LogEntry>>> {
        self.inner
            .get_or_init(|| Arc::new(std::sync::Mutex::new(Vec::new())))
            .clone()
    }

    fn reset(&self) {
        if let Some(store) = self.inner.get() {
            store.lock().unwrap().clear();
        }
    }
}

/// 追加一条日志。低于当前配置的最低级别（默认 Info）的日志直接丢弃，
/// 不会占用内存，也不会出现在日志面板里。
pub fn log_msg(level: LogLevel, tag: &str, msg: String) {
    if level < min_log_level() {
        return;
    }
    let ts = chrono::Local::now().format("%H:%M:%S%.3f");
    let entry = LogEntry {
        timestamp: ts.to_string(),
        level,
        tag: tag.to_string(),
        message: msg,
    };
    LOG_STORE.get().lock().unwrap().push(entry);
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 获取日志缓冲区中的日志条目
#[tauri::command]
fn get_logs() -> Vec<String> {
    let binding = LOG_STORE.get();
    let entries = binding.lock().unwrap();
    let result: Vec<String> = entries
        .iter()
        .map(|e| format!("[{}] [{}] [{}] {}", e.timestamp, e.level.as_str(), e.tag, e.message))
        .collect();
    result
}

/// 获取过滤后的日志条目。level 传具体级别（"debug"/"info"/"warn"/"error"）
/// 表示精确匹配这一级别，不传则不按级别过滤。
#[tauri::command]
fn get_logs_with_filter(level: Option<String>, search: Option<String>) -> Vec<LogEntry> {
    let wanted_level = level.as_deref().and_then(LogLevel::parse);
    let binding = LOG_STORE.get();
    let entries = binding.lock().unwrap();
    let filtered: Vec<LogEntry> = entries
        .iter()
        .filter(|e| {
            if let Some(lvl) = wanted_level {
                if e.level != lvl {
                    return false;
                }
            }
            if let Some(ref s) = search {
                let haystack = format!("{} {}", e.tag, e.message).to_lowercase();
                if !haystack.contains(&s.to_lowercase()) {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect();
    filtered
}

/// 清空日志缓冲区
#[tauri::command]
fn clear_logs() {
    LOG_STORE.reset();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = LOG_STORE.get();
    // 启动时把已保存的日志级别设置应用到全局阈值上（没保存过就用默认 Info）。
    apply_log_level(&settings::load_app_settings().unwrap_or_default().log_level);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            bench::start_bench,
            bench::cancel_bench,
            bench::export_report,
            bench::save_last_config,
            bench::load_last_config,
            bench::save_preset,
            bench::list_presets,
            bench::load_preset,
            bench::delete_preset,
            bench::list_reports,
            bench::load_report,
            bench::delete_report,
            bench::read_file_text,
            bench::list_remote_models,
            synthetic_prompt::generate_synthetic_prompt_cmd,
            settings::save_app_settings,
            settings::load_app_settings,
            settings::check_for_updates,
            settings::get_app_version,
            get_logs,
            get_logs_with_filter,
            clear_logs,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // LOG_STORE / MIN_LOG_LEVEL are process-wide statics; cargo test runs
    // tests in the same binary in parallel, so tests touching either must
    // be serialized against each other (same pattern as CANCEL_TEST_LOCK
    // in bench::tests).
    static LOG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn test_log_level_ordering() {
        assert!(LogLevel::Debug < LogLevel::Info);
        assert!(LogLevel::Info < LogLevel::Warn);
        assert!(LogLevel::Warn < LogLevel::Error);
    }

    #[test]
    fn test_log_level_parse() {
        assert_eq!(LogLevel::parse("debug"), Some(LogLevel::Debug));
        assert_eq!(LogLevel::parse("INFO"), Some(LogLevel::Info));
        assert_eq!(LogLevel::parse("Warn"), Some(LogLevel::Warn));
        assert_eq!(LogLevel::parse("warning"), Some(LogLevel::Warn));
        assert_eq!(LogLevel::parse("error"), Some(LogLevel::Error));
        assert_eq!(LogLevel::parse("nonsense"), None);
    }

    #[test]
    fn test_log_msg_filters_below_min_level() {
        let _guard = LOG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        apply_log_level("warn");
        LOG_STORE.reset();

        log_msg(LogLevel::Debug, "TEST", "should be dropped".to_string());
        log_msg(LogLevel::Info, "TEST", "should also be dropped".to_string());
        log_msg(LogLevel::Warn, "TEST", "should be kept".to_string());
        log_msg(LogLevel::Error, "TEST", "should also be kept".to_string());

        let entries = LOG_STORE.get().lock().unwrap().clone();
        assert_eq!(entries.len(), 2, "only warn/error should have been recorded, got: {entries:?}");
        assert!(entries.iter().all(|e| e.level >= LogLevel::Warn));

        apply_log_level("info"); // reset for other tests
        LOG_STORE.reset();
    }

    #[test]
    fn test_get_logs_with_filter_exact_level_match() {
        let _guard = LOG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        apply_log_level("debug"); // don't let the threshold hide anything here
        LOG_STORE.reset();

        log_msg(LogLevel::Info, "TEST", "info line".to_string());
        log_msg(LogLevel::Error, "TEST", "error line".to_string());

        let only_errors = get_logs_with_filter(Some("error".to_string()), None);
        assert_eq!(only_errors.len(), 1);
        assert_eq!(only_errors[0].message, "error line");

        let all = get_logs_with_filter(None, None);
        assert_eq!(all.len(), 2);

        apply_log_level("info"); // reset for other tests
        LOG_STORE.reset();
    }
}
