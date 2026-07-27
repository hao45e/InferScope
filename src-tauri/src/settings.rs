use serde::{Deserialize, Serialize};

const SETTINGS_FILE: &str = "settings.json";

pub const GITHUB_OWNER: &str = "hao45e";
pub const GITHUB_REPO: &str = "InferScope";

fn default_language() -> String {
    "en".to_string()
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_log_level() -> String {
    "info".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// "en" | "zh-CN" | "zh-TW"
    #[serde(default = "default_language")]
    pub language: String,
    /// "light" | "dark" | "system"
    #[serde(default = "default_theme")]
    pub theme: String,
    /// "debug" | "info" | "warn" | "error"
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: default_language(),
            theme: default_theme(),
            log_level: default_log_level(),
        }
    }
}

#[tauri::command]
pub fn save_app_settings(settings: AppSettings) -> Result<(), String> {
    crate::apply_log_level(&settings.log_level);
    let path = crate::bench::get_app_data_dir().join(SETTINGS_FILE);
    let json = serde_json::to_string_pretty(&settings).map_err(|e| format!("Serialization failed: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write file: {e}"))
}

/// 读取已保存的设置。文件不存在，或者是旧格式解析不出来，都直接返回
/// 默认设置，不算错误。
#[tauri::command]
pub fn load_app_settings() -> Result<AppSettings, String> {
    let path = crate::bench::get_app_data_dir().join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))?;
    Ok(serde_json::from_str::<AppSettings>(&content).unwrap_or_default())
}

/// 当前应用版本号（跟 Cargo.toml 的 [package] version 保持一致）。
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_url: String,
    pub release_notes: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: String,
}

/// 去 GitHub Releases API 查最新版本，跟当前版本比一下。GITHUB_OWNER/
/// GITHUB_REPO 是占位符，仓库建好之前这个命令会稳定地返回 404 错误
/// （这是预期行为，不是 bug）。
#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current_version = get_app_version();
    let url = format!("https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(10_000))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    // GitHub API 要求匿名请求也必须带 User-Agent，否则直接 403。
    let response = client
        .get(&url)
        .header("User-Agent", "InferScope-UpdateChecker")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to request GitHub Releases: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "GitHub returned an error [{status}] — the repo {GITHUB_OWNER}/{GITHUB_REPO} may not exist yet or has no releases"
        ));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub Releases response: {e}"))?;

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let update_available = is_newer_version(&latest_version, &current_version);

    Ok(UpdateInfo {
        current_version,
        latest_version,
        update_available,
        release_url: release.html_url,
        release_notes: release.body,
    })
}

/// 简单的语义化版本比较：把 "1.2.3" 拆成 [1,2,3] 逐段比较数值大小。
/// 拆不出数字的部分按 0 处理，够用了，不需要引入完整 semver 依赖。
fn is_newer_version(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|part| part.chars().take_while(|c| c.is_ascii_digit()).collect::<String>())
            .map(|digits| digits.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let candidate_parts = parse(candidate);
    let current_parts = parse(current);
    let len = candidate_parts.len().max(current_parts.len());
    for i in 0..len {
        let c = candidate_parts.get(i).copied().unwrap_or(0);
        let cur = current_parts.get(i).copied().unwrap_or(0);
        if c != cur {
            return c > cur;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_settings_defaults() {
        let s = AppSettings::default();
        assert_eq!(s.language, "en");
        assert_eq!(s.theme, "system");
        assert_eq!(s.log_level, "info");
    }

    #[test]
    fn test_app_settings_json_round_trips() {
        let s = AppSettings { language: "zh-TW".to_string(), theme: "light".to_string(), log_level: "debug".to_string() };
        let json = serde_json::to_string(&s).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.language, "zh-TW");
        assert_eq!(restored.theme, "light");
        assert_eq!(restored.log_level, "debug");
    }

    #[test]
    fn test_app_settings_missing_fields_fall_back_to_defaults() {
        // Simulates an old/partial settings.json — should not fail to parse.
        let partial: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(partial.language, "en");
        assert_eq!(partial.theme, "system");
        assert_eq!(partial.log_level, "info");
    }

    #[test]
    fn test_is_newer_version() {
        assert!(is_newer_version("1.2.0", "1.1.9"));
        assert!(is_newer_version("2.0.0", "1.9.9"));
        assert!(!is_newer_version("1.1.9", "1.2.0"));
        assert!(!is_newer_version("1.2.0", "1.2.0"));
        assert!(is_newer_version("1.2.3", "1.2.2"));
    }

    #[test]
    fn test_is_newer_version_handles_v_prefix_stripped_already() {
        // tag_name often looks like "v1.2.0"; check_for_updates strips the
        // leading v before calling this, so this exercises the plain form.
        assert!(is_newer_version("0.2.0", "0.1.0"));
    }

    #[test]
    fn test_get_app_version_matches_cargo_toml() {
        assert_eq!(get_app_version(), env!("CARGO_PKG_VERSION"));
    }
}
