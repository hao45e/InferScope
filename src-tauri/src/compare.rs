//! `inferscope compare <baseline.json> <new.json> [--max-regression <percent>] [--json]`
//! 拿两次压测的 BenchReport 逐项指标对比，只要有一项相对基准的变化幅度
//! 超过设定的回归阈值，就退出非 0——接进 CI 当性能门禁用，不用每个仓库
//! 各自写一份 jq/python 对比脚本。

use crate::bench::BenchReport;

const USAGE: &str = "Usage: inferscope compare <baseline.json> <new.json> [--max-regression <percent>] [--json]";
const DEFAULT_MAX_REGRESSION_PCT: f64 = 10.0;

#[derive(Debug, PartialEq)]
pub struct CompareArgs {
    pub baseline_path: String,
    pub new_path: String,
    pub max_regression_pct: f64,
    pub json_output: bool,
}

/// 解析 `compare` 子命令后面的参数（不含 "compare" 本身）。
pub fn parse_compare_args(args: &[String]) -> Result<CompareArgs, String> {
    let mut positional = Vec::new();
    let mut max_regression_pct = DEFAULT_MAX_REGRESSION_PCT;
    let mut json_output = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--max-regression" => {
                i += 1;
                let raw = args
                    .get(i)
                    .ok_or("--max-regression requires a percentage argument")?;
                let trimmed = raw.trim_end_matches('%');
                max_regression_pct = trimmed
                    .parse::<f64>()
                    .map_err(|_| format!("Invalid --max-regression value: {raw}"))?;
            }
            "--json" => json_output = true,
            other if other.starts_with("--") => return Err(format!("Unknown argument: {other}")),
            other => positional.push(other.to_string()),
        }
        i += 1;
    }

    if positional.len() != 2 {
        return Err(format!(
            "Expected exactly 2 positional arguments (baseline, new), got {}",
            positional.len()
        ));
    }

    Ok(CompareArgs {
        baseline_path: positional[0].clone(),
        new_path: positional[1].clone(),
        max_regression_pct,
        json_output,
    })
}

/// 一项指标该往哪个方向变化才算"变好"——延迟类指标越低越好，吞吐量/
/// 成功率越高越好。方向不同，"回归"对应的变化符号也相反。
#[derive(Clone, Copy, Debug, PartialEq)]
enum Direction {
    LowerIsBetter,
    HigherIsBetter,
}

struct MetricCheck {
    name: &'static str,
    baseline: f64,
    new: f64,
    direction: Direction,
}

fn metrics_to_check(baseline: &BenchReport, new: &BenchReport) -> Vec<MetricCheck> {
    use Direction::{HigherIsBetter, LowerIsBetter};
    vec![
        MetricCheck { name: "ttft_p50_ms", baseline: baseline.ttft_p50_ms, new: new.ttft_p50_ms, direction: LowerIsBetter },
        MetricCheck { name: "ttft_p90_ms", baseline: baseline.ttft_p90_ms, new: new.ttft_p90_ms, direction: LowerIsBetter },
        MetricCheck { name: "ttft_p95_ms", baseline: baseline.ttft_p95_ms, new: new.ttft_p95_ms, direction: LowerIsBetter },
        MetricCheck { name: "ttft_p99_ms", baseline: baseline.ttft_p99_ms, new: new.ttft_p99_ms, direction: LowerIsBetter },
        MetricCheck { name: "tpot_p50_ms", baseline: baseline.tpot_p50_ms, new: new.tpot_p50_ms, direction: LowerIsBetter },
        MetricCheck { name: "tpot_p90_ms", baseline: baseline.tpot_p90_ms, new: new.tpot_p90_ms, direction: LowerIsBetter },
        MetricCheck { name: "tpot_p95_ms", baseline: baseline.tpot_p95_ms, new: new.tpot_p95_ms, direction: LowerIsBetter },
        MetricCheck { name: "tpot_p99_ms", baseline: baseline.tpot_p99_ms, new: new.tpot_p99_ms, direction: LowerIsBetter },
        MetricCheck { name: "e2e_p50_ms", baseline: baseline.e2e_p50_ms, new: new.e2e_p50_ms, direction: LowerIsBetter },
        MetricCheck { name: "e2e_p90_ms", baseline: baseline.e2e_p90_ms, new: new.e2e_p90_ms, direction: LowerIsBetter },
        MetricCheck { name: "e2e_p95_ms", baseline: baseline.e2e_p95_ms, new: new.e2e_p95_ms, direction: LowerIsBetter },
        MetricCheck { name: "e2e_p99_ms", baseline: baseline.e2e_p99_ms, new: new.e2e_p99_ms, direction: LowerIsBetter },
        MetricCheck { name: "avg_throughput_tok_s", baseline: baseline.avg_throughput_tok_s, new: new.avg_throughput_tok_s, direction: HigherIsBetter },
        MetricCheck { name: "success_rate_pct", baseline: baseline.success_rate_pct, new: new.success_rate_pct, direction: HigherIsBetter },
    ]
}

#[derive(Debug, PartialEq)]
struct MetricResult {
    name: &'static str,
    baseline: f64,
    new: f64,
    delta_pct: f64,
    regressed: bool,
}

/// baseline 为 0（或极接近 0）时按 0% 处理，而不是除零得到 NaN/Infinity——
/// 现实中的延迟/吞吐指标不会真的是 0，这只是防御性兜底。
fn evaluate(check: &MetricCheck, max_regression_pct: f64) -> MetricResult {
    let delta_pct = if check.baseline.abs() > f64::EPSILON {
        (check.new - check.baseline) / check.baseline * 100.0
    } else {
        0.0
    };
    let regressed = match check.direction {
        Direction::LowerIsBetter => delta_pct > max_regression_pct,
        Direction::HigherIsBetter => delta_pct < -max_regression_pct,
    };
    MetricResult { name: check.name, baseline: check.baseline, new: check.new, delta_pct, regressed }
}

fn load_report(path: &str) -> Result<BenchReport, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("Failed to read '{path}': {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse '{path}' as a benchmark report: {e}"))
}

fn print_human(results: &[MetricResult], max_regression_pct: f64, baseline_path: &str, new_path: &str) {
    println!("Comparing {baseline_path} -> {new_path} (max regression: {max_regression_pct:.1}%)\n");
    println!("{:<22} {:>12} {:>12} {:>10}  STATUS", "METRIC", "BASELINE", "NEW", "DELTA");
    for r in results {
        let status = if r.regressed { "REGRESSED" } else { "ok" };
        println!(
            "{:<22} {:>12.3} {:>12.3} {:>+9.1}%  {status}",
            r.name, r.baseline, r.new, r.delta_pct
        );
    }

    let regressed_names: Vec<&str> = results.iter().filter(|r| r.regressed).map(|r| r.name).collect();
    println!();
    if regressed_names.is_empty() {
        println!("No metric regressed beyond {max_regression_pct:.1}%.");
    } else {
        println!(
            "{} metric(s) regressed beyond {max_regression_pct:.1}%: {}",
            regressed_names.len(),
            regressed_names.join(", ")
        );
    }
}

fn print_json(results: &[MetricResult], max_regression_pct: f64) {
    let regressed_count = results.iter().filter(|r| r.regressed).count();
    let metrics: Vec<serde_json::Value> = results
        .iter()
        .map(|r| {
            serde_json::json!({
                "name": r.name,
                "baseline": r.baseline,
                "new": r.new,
                "delta_pct": r.delta_pct,
                "regressed": r.regressed,
            })
        })
        .collect();
    let output = serde_json::json!({
        "max_regression_pct": max_regression_pct,
        "metrics": metrics,
        "regressed_count": regressed_count,
        "passed": regressed_count == 0,
    });
    match serde_json::to_string_pretty(&output) {
        Ok(s) => println!("{s}"),
        Err(e) => eprintln!("Error: failed to serialize comparison result: {e}"),
    }
}

/// 跑一次报告对比，返回进程退出码（0 = 没有回归，1 = 有指标回归超阈值，
/// 2 = 参数或文件有问题）。
pub fn run(args: &[String]) -> i32 {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        return 0;
    }

    let parsed = match parse_compare_args(args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Error: {e}");
            eprintln!("{USAGE}");
            return 2;
        }
    };

    let baseline = match load_report(&parsed.baseline_path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Error: {e}");
            return 2;
        }
    };
    let new = match load_report(&parsed.new_path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Error: {e}");
            return 2;
        }
    };

    let checks = metrics_to_check(&baseline, &new);
    let results: Vec<MetricResult> = checks.iter().map(|c| evaluate(c, parsed.max_regression_pct)).collect();
    let any_regressed = results.iter().any(|r| r.regressed);

    if parsed.json_output {
        print_json(&results, parsed.max_regression_pct);
    } else {
        print_human(&results, parsed.max_regression_pct, &parsed.baseline_path, &parsed.new_path);
    }

    if any_regressed { 1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_compare_args_defaults() {
        let args = vec!["baseline.json".to_string(), "new.json".to_string()];
        let parsed = parse_compare_args(&args).expect("should parse");
        assert_eq!(parsed.baseline_path, "baseline.json");
        assert_eq!(parsed.new_path, "new.json");
        assert_eq!(parsed.max_regression_pct, DEFAULT_MAX_REGRESSION_PCT);
        assert!(!parsed.json_output);
    }

    #[test]
    fn test_parse_compare_args_with_max_regression_and_percent_sign() {
        let args = vec!["a.json".to_string(), "b.json".to_string(), "--max-regression".to_string(), "5%".to_string()];
        let parsed = parse_compare_args(&args).expect("should parse");
        assert_eq!(parsed.max_regression_pct, 5.0);
    }

    #[test]
    fn test_parse_compare_args_with_json_flag() {
        let args = vec!["a.json".to_string(), "b.json".to_string(), "--json".to_string()];
        let parsed = parse_compare_args(&args).expect("should parse");
        assert!(parsed.json_output);
    }

    #[test]
    fn test_parse_compare_args_rejects_wrong_positional_count() {
        let args = vec!["only-one.json".to_string()];
        let err = parse_compare_args(&args).expect_err("should reject");
        assert!(err.contains("Expected exactly 2"));
    }

    #[test]
    fn test_parse_compare_args_rejects_invalid_max_regression_value() {
        let args = vec!["a.json".to_string(), "b.json".to_string(), "--max-regression".to_string(), "not-a-number".to_string()];
        let err = parse_compare_args(&args).expect_err("should reject");
        assert!(err.contains("Invalid --max-regression value"));
    }

    #[test]
    fn test_parse_compare_args_rejects_missing_max_regression_value() {
        let args = vec!["a.json".to_string(), "b.json".to_string(), "--max-regression".to_string()];
        let err = parse_compare_args(&args).expect_err("should reject");
        assert!(err.contains("--max-regression requires"));
    }

    #[test]
    fn test_parse_compare_args_rejects_unknown_flag() {
        let args = vec!["a.json".to_string(), "b.json".to_string(), "--bogus".to_string()];
        let err = parse_compare_args(&args).expect_err("should reject");
        assert!(err.contains("Unknown argument"));
    }

    #[test]
    fn test_evaluate_detects_latency_regression() {
        let check = MetricCheck { name: "ttft_p95_ms", baseline: 100.0, new: 120.0, direction: Direction::LowerIsBetter };
        let result = evaluate(&check, 10.0);
        assert!(result.regressed, "20% slower should regress past a 10% threshold");
        assert!((result.delta_pct - 20.0).abs() < 1e-9);
    }

    #[test]
    fn test_evaluate_latency_within_threshold_is_not_a_regression() {
        let check = MetricCheck { name: "ttft_p95_ms", baseline: 100.0, new: 105.0, direction: Direction::LowerIsBetter };
        let result = evaluate(&check, 10.0);
        assert!(!result.regressed, "5% slower should not regress past a 10% threshold");
    }

    #[test]
    fn test_evaluate_latency_improvement_is_not_a_regression() {
        let check = MetricCheck { name: "ttft_p95_ms", baseline: 100.0, new: 50.0, direction: Direction::LowerIsBetter };
        let result = evaluate(&check, 10.0);
        assert!(!result.regressed, "getting faster is never a regression");
    }

    #[test]
    fn test_evaluate_detects_throughput_regression() {
        let check = MetricCheck { name: "avg_throughput_tok_s", baseline: 100.0, new: 80.0, direction: Direction::HigherIsBetter };
        let result = evaluate(&check, 10.0);
        assert!(result.regressed, "20% less throughput should regress past a 10% threshold");
    }

    #[test]
    fn test_evaluate_throughput_improvement_is_not_a_regression() {
        let check = MetricCheck { name: "avg_throughput_tok_s", baseline: 100.0, new: 150.0, direction: Direction::HigherIsBetter };
        let result = evaluate(&check, 10.0);
        assert!(!result.regressed, "more throughput is never a regression");
    }

    #[test]
    fn test_evaluate_zero_baseline_does_not_panic_or_produce_nan() {
        let check = MetricCheck { name: "tpot_p50_ms", baseline: 0.0, new: 5.0, direction: Direction::LowerIsBetter };
        let result = evaluate(&check, 10.0);
        assert_eq!(result.delta_pct, 0.0);
        assert!(!result.regressed);
    }

    fn make_report(ttft_p50: f64, throughput: f64, success_rate: f64) -> BenchReport {
        BenchReport {
            config: crate::bench::BenchConfig {
                base_url: "http://localhost:8000/v1".to_string(),
                model: "test-model".to_string(),
                prompt: "test".to_string(),
                concurrency: 1,
                num_requests: 1,
                max_tokens: 10,
                temperature: 0.7,
                auth_header: None,
                custom_headers: None,
                batch_interval_ms: 0,
                per_request_interval_ms: 0,
                max_retries: 0,
                request_timeout_ms: 60000,
                messages: vec![],
                prompt_pool: vec![],
                image_data_url: None,
            },
            metrics: vec![],
            ttft_p50_ms: ttft_p50,
            ttft_p90_ms: ttft_p50,
            ttft_p95_ms: ttft_p50,
            ttft_p99_ms: ttft_p50,
            tpot_p50_ms: 10.0,
            tpot_p90_ms: 10.0,
            tpot_p95_ms: 10.0,
            tpot_p99_ms: 10.0,
            e2e_p50_ms: 200.0,
            e2e_p90_ms: 200.0,
            e2e_p95_ms: 200.0,
            e2e_p99_ms: 200.0,
            avg_throughput_tok_s: throughput,
            success_rate_pct: success_rate,
        }
    }

    #[test]
    fn test_run_end_to_end_detects_regression_and_exits_nonzero() {
        let dir = std::env::temp_dir().join(format!("inferscope_test_compare_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let baseline_path = dir.join("baseline.json");
        let new_path = dir.join("new.json");

        let baseline = make_report(50.0, 100.0, 100.0);
        let regressed_new = make_report(80.0, 100.0, 100.0); // ttft up 60% > 10% threshold

        std::fs::write(&baseline_path, serde_json::to_string(&baseline).unwrap()).unwrap();
        std::fs::write(&new_path, serde_json::to_string(&regressed_new).unwrap()).unwrap();

        let exit_code = run(&[
            baseline_path.to_string_lossy().to_string(),
            new_path.to_string_lossy().to_string(),
        ]);
        assert_eq!(exit_code, 1, "a 60% TTFT regression should exit 1");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_run_end_to_end_passes_when_within_threshold() {
        let dir = std::env::temp_dir().join(format!("inferscope_test_compare_ok_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let baseline_path = dir.join("baseline.json");
        let new_path = dir.join("new.json");

        let baseline = make_report(50.0, 100.0, 100.0);
        let similar_new = make_report(52.0, 98.0, 100.0); // well within default 10%

        std::fs::write(&baseline_path, serde_json::to_string(&baseline).unwrap()).unwrap();
        std::fs::write(&new_path, serde_json::to_string(&similar_new).unwrap()).unwrap();

        let exit_code = run(&[
            baseline_path.to_string_lossy().to_string(),
            new_path.to_string_lossy().to_string(),
        ]);
        assert_eq!(exit_code, 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_run_reports_error_for_missing_file() {
        let exit_code = run(&["/nonexistent/baseline.json".to_string(), "/nonexistent/new.json".to_string()]);
        assert_eq!(exit_code, 2);
    }
}
