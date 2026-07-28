//! 无头模式（CLI）：`inferscope bench --config <path> | --preset <name>`。
//! 加载配置、跑一次完整压测、把报告以 JSON 打印到 stdout（可选再写一份
//! 到 `--output` 指定的文件），供 CI 做性能回归检测用。退出码非 0 只表示
//! 压测本身没跑成功（比如连不上目标服务），不表示"指标变差了"——
//! 指标阈值比较留给外部脚本基于 JSON 输出自己判断。

use crate::bench::{self, BenchConfig};

const USAGE: &str = "Usage: inferscope bench (--config <path.json> | --preset <name>) [--output <path.json>]";

#[derive(Debug, PartialEq)]
pub struct CliArgs {
    pub config_path: Option<String>,
    pub preset_name: Option<String>,
    pub output_path: Option<String>,
}

/// 解析 `bench` 子命令后面的参数（不含 "bench" 本身）。
pub fn parse_cli_args(args: &[String]) -> Result<CliArgs, String> {
    let mut config_path = None;
    let mut preset_name = None;
    let mut output_path = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--config" => {
                i += 1;
                config_path = Some(
                    args.get(i)
                        .cloned()
                        .ok_or("--config requires a path argument")?,
                );
            }
            "--preset" => {
                i += 1;
                preset_name = Some(
                    args.get(i)
                        .cloned()
                        .ok_or("--preset requires a name argument")?,
                );
            }
            "--output" => {
                i += 1;
                output_path = Some(
                    args.get(i)
                        .cloned()
                        .ok_or("--output requires a path argument")?,
                );
            }
            other => return Err(format!("Unknown argument: {other}")),
        }
        i += 1;
    }

    if config_path.is_some() == preset_name.is_some() {
        return Err("Specify exactly one of --config <path> or --preset <name>".to_string());
    }

    Ok(CliArgs {
        config_path,
        preset_name,
        output_path,
    })
}

fn load_config(args: &CliArgs) -> Result<BenchConfig, String> {
    if let Some(path) = &args.config_path {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read config file '{path}': {e}"))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse config file '{path}': {e}"))
    } else if let Some(name) = &args.preset_name {
        bench::load_preset(name.clone())
    } else {
        unreachable!("parse_cli_args guarantees exactly one of config_path/preset_name is set")
    }
}

/// 跑一次无头压测，返回进程退出码（0 = 成功，非 0 = 失败）。
pub fn run(args: &[String]) -> i32 {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        return 0;
    }

    let parsed = match parse_cli_args(args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Error: {e}");
            eprintln!("{USAGE}");
            return 2;
        }
    };

    let config = match load_config(&parsed) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: {e}");
            return 2;
        }
    };

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("Error: failed to start async runtime: {e}");
            return 1;
        }
    };

    match runtime.block_on(bench::run_headless(config)) {
        Ok(report) => {
            let json = match serde_json::to_string_pretty(&report) {
                Ok(j) => j,
                Err(e) => {
                    eprintln!("Error: failed to serialize report: {e}");
                    return 1;
                }
            };
            println!("{json}");
            if let Some(output_path) = &parsed.output_path {
                if let Err(e) = std::fs::write(output_path, &json) {
                    eprintln!("Error: failed to write output file '{output_path}': {e}");
                    return 1;
                }
            }
            0
        }
        Err(e) => {
            eprintln!("Error: benchmark failed: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_cli_args_with_config_path() {
        let args = vec!["--config".to_string(), "bench.json".to_string()];
        let parsed = parse_cli_args(&args).expect("should parse");
        assert_eq!(
            parsed,
            CliArgs {
                config_path: Some("bench.json".to_string()),
                preset_name: None,
                output_path: None,
            }
        );
    }

    #[test]
    fn test_parse_cli_args_with_preset_name() {
        let args = vec!["--preset".to_string(), "my-preset".to_string()];
        let parsed = parse_cli_args(&args).expect("should parse");
        assert_eq!(
            parsed,
            CliArgs {
                config_path: None,
                preset_name: Some("my-preset".to_string()),
                output_path: None,
            }
        );
    }

    #[test]
    fn test_parse_cli_args_with_output_path() {
        let args = vec![
            "--config".to_string(),
            "bench.json".to_string(),
            "--output".to_string(),
            "report.json".to_string(),
        ];
        let parsed = parse_cli_args(&args).expect("should parse");
        assert_eq!(parsed.output_path, Some("report.json".to_string()));
    }

    #[test]
    fn test_parse_cli_args_rejects_both_config_and_preset() {
        let args = vec![
            "--config".to_string(),
            "bench.json".to_string(),
            "--preset".to_string(),
            "my-preset".to_string(),
        ];
        let err = parse_cli_args(&args).expect_err("should reject both being set");
        assert!(err.contains("exactly one"));
    }

    #[test]
    fn test_parse_cli_args_rejects_neither_config_nor_preset() {
        let args: Vec<String> = vec![];
        let err = parse_cli_args(&args).expect_err("should reject neither being set");
        assert!(err.contains("exactly one"));
    }

    #[test]
    fn test_parse_cli_args_rejects_missing_flag_value() {
        let args = vec!["--config".to_string()];
        let err = parse_cli_args(&args).expect_err("should reject missing value");
        assert!(err.contains("--config requires"));
    }

    #[test]
    fn test_parse_cli_args_rejects_unknown_flag() {
        let args = vec!["--bogus".to_string()];
        let err = parse_cli_args(&args).expect_err("should reject unknown flag");
        assert!(err.contains("Unknown argument"));
    }
}
