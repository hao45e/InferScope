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
    /// 当前平台对应的安装包下载直链；没有匹配到（比如 Linux/ARM 没出包）
    /// 就是 None，前端这时候只显示"打开发布页"链接，不显示"直接更新"按钮。
    pub download_url: Option<String>,
    /// 下载后落盘用的文件名——必须保留原始扩展名（.dmg/.exe/.AppImage 等），
    /// 系统才知道用什么程序打开它。
    pub download_filename: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

/// 根据当前运行平台，从 release 的附件列表里挑出"下载了直接双击就能装"
/// 的那一个：macOS 按 CPU 架构分 dmg，Windows 用 NSIS 的 -setup.exe（比
/// .msi 更常见），Linux 用 AppImage（免安装、不用发行版包管理器）。
/// release.yml 目前只给 Windows/Linux 各出一份 x86_64 的包，所以这两个
/// 分支特意精确匹配 x86_64，不用通配符——不然一台真的 Windows/Linux ARM
/// 机器会被错配到跑不了的 x86_64 安装包上。挑不出来（这次发布没出对应
/// 平台的包）就返回 None，前端那时候不显示"直接更新"按钮。
fn pick_update_asset<'a>(assets: &'a [GithubAsset], os: &str, arch: &str) -> Option<&'a GithubAsset> {
    let wanted_suffix = match (os, arch) {
        ("macos", "aarch64") => "_aarch64.dmg",
        ("macos", _) => "_x64.dmg",
        ("windows", "x86_64") => "-setup.exe",
        ("linux", "x86_64") => ".AppImage",
        _ => return None,
    };
    assets.iter().find(|a| a.name.ends_with(wanted_suffix))
}

/// 去 GitHub Releases API 查最新版本，跟当前版本比一下，顺便挑出当前平台
/// 能直接下载安装的那个附件（见 pick_update_asset）。
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

    let asset = pick_update_asset(&release.assets, std::env::consts::OS, std::env::consts::ARCH);

    Ok(UpdateInfo {
        current_version,
        latest_version,
        update_available,
        release_url: release.html_url,
        release_notes: release.body,
        download_url: asset.map(|a| a.browser_download_url.clone()),
        download_filename: asset.map(|a| a.name.clone()),
    })
}

/// 下载指定 URL 的安装包到系统临时目录，然后用系统默认程序打开它——
/// macOS 会挂载 dmg、Windows 会跑 exe 安装向导，Linux 的 AppImage 需要先
/// 加可执行权限（下载下来默认没有）才能打开。剩下的安装步骤交给用户在
/// 系统自己的安装界面里完成，这个命令只负责"下载 + 打开"这一步。
#[tauri::command]
pub async fn download_and_open_update(url: String, filename: String) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(120_000))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .header("User-Agent", "InferScope-UpdateChecker")
        .send()
        .await
        .map_err(|e| format!("Failed to download update: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Failed to download update: HTTP {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read downloaded update: {e}"))?;

    let path = std::env::temp_dir().join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| format!("Failed to save downloaded update: {e}"))?;

    #[cfg(unix)]
    if filename.ends_with(".AppImage") {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to read downloaded file permissions: {e}"))?
            .permissions();
        perms.set_mode(perms.mode() | 0o111);
        std::fs::set_permissions(&path, perms)
            .map_err(|e| format!("Failed to make downloaded AppImage executable: {e}"))?;
    }

    open::that(&path).map_err(|e| format!("Failed to open downloaded update: {e}"))
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

    fn make_assets() -> Vec<GithubAsset> {
        [
            "inferscope-1.0.0-1.x86_64.rpm",
            "inferscope_1.0.0_aarch64.dmg",
            "inferscope_1.0.0_amd64.AppImage",
            "inferscope_1.0.0_amd64.deb",
            "inferscope_1.0.0_x64-setup.exe",
            "inferscope_1.0.0_x64.dmg",
            "inferscope_1.0.0_x64_en-US.msi",
            "inferscope_aarch64.app.tar.gz",
            "inferscope_x64.app.tar.gz",
        ]
        .iter()
        .map(|name| GithubAsset {
            name: name.to_string(),
            browser_download_url: format!("https://example.com/{name}"),
        })
        .collect()
    }

    #[test]
    fn test_pick_update_asset_macos_apple_silicon() {
        let assets = make_assets();
        let picked = pick_update_asset(&assets, "macos", "aarch64").expect("should find a match");
        assert_eq!(picked.name, "inferscope_1.0.0_aarch64.dmg");
    }

    #[test]
    fn test_pick_update_asset_macos_intel() {
        let assets = make_assets();
        let picked = pick_update_asset(&assets, "macos", "x86_64").expect("should find a match");
        assert_eq!(picked.name, "inferscope_1.0.0_x64.dmg");
    }

    #[test]
    fn test_pick_update_asset_windows_prefers_exe_over_msi() {
        let assets = make_assets();
        let picked = pick_update_asset(&assets, "windows", "x86_64").expect("should find a match");
        assert_eq!(picked.name, "inferscope_1.0.0_x64-setup.exe");
    }

    #[test]
    fn test_pick_update_asset_linux_prefers_appimage_over_deb_rpm() {
        let assets = make_assets();
        let picked = pick_update_asset(&assets, "linux", "x86_64").expect("should find a match");
        assert_eq!(picked.name, "inferscope_1.0.0_amd64.AppImage");
    }

    #[test]
    fn test_pick_update_asset_no_match_for_unsupported_platform() {
        let assets = make_assets();
        assert!(pick_update_asset(&assets, "freebsd", "x86_64").is_none());
    }

    #[test]
    fn test_pick_update_asset_no_match_when_release_has_no_assets_for_platform() {
        // Linux/arm64 isn't built by release.yml — should degrade to None,
        // not panic or fall back to some other platform's asset.
        let assets = make_assets();
        assert!(pick_update_asset(&assets, "linux", "aarch64").is_none());
    }
}
