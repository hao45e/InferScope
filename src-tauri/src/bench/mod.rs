use crate::{log_msg, LogLevel};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Runtime};

/// 压测配置
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BenchConfig {
    /// API Base URL (如 http://localhost:11434/v1)
    pub base_url: String,
    /// 模型名称
    pub model: String,
    /// 测试 prompt（多轮对话模式下为空时用作单轮用户消息）
    pub prompt: String,
    /// 并发数
    pub concurrency: u32,
    /// 总请求数
    pub num_requests: u32,
    /// 最大输出 token 数
    pub max_tokens: u32,
    /// Temperature
    pub temperature: f64,
    /// API 认证头（如 "Bearer xxx" 或 "Basic xxx"）
    #[serde(default)]
    pub auth_header: Option<String>,
    /// 自定义 HTTP 头
    #[serde(default)]
    pub custom_headers: Option<HashMap<String, String>>,
    /// 批次间延迟（毫秒），默认 0 表示无延迟
    #[serde(default)]
    pub batch_interval_ms: u64,
    /// 请求间延迟（毫秒），默认 0 表示无延迟
    #[serde(default)]
    pub per_request_interval_ms: u64,
    /// 最大重试次数，默认 0 不重试
    #[serde(default)]
    pub max_retries: u32,
    /// 单请求超时时间（毫秒），默认 60000
    #[serde(default = "default_timeout")]
    pub request_timeout_ms: u64,
    /// 对话消息列表（多轮对话），若为空则使用 prompt 字段作为单轮用户消息
    #[serde(default)]
    pub messages: Vec<Message>,
    /// 导入的 prompt 池（循环使用），若非空则每个请求依次从中取一条覆盖 prompt
    #[serde(default)]
    pub prompt_pool: Vec<String>,
}

fn default_timeout() -> u64 {
    60000
}

/// 对话消息
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

/// 单次请求的指标
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestMetrics {
    /// 请求序号 (从 1 开始)
    pub request_id: u32,
    /// TTFT (微秒)
    pub ttft_us: u64,
    /// TPOT 列表（每个 token 间隔，微秒）
    pub tpots: Vec<u64>,
    /// E2E 延迟（微秒）
    pub e2e_latency_us: u64,
    /// 生成的 token 数
    pub token_count: u32,
    /// 是否成功
    pub success: bool,
    /// 错误信息（如果失败）
    pub error: Option<String>,
}

/// 完整基准报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchReport {
    pub config: BenchConfig,
    pub metrics: Vec<RequestMetrics>,
    /// TTFT 百分位（微秒转毫秒）
    #[serde(rename = "ttft_p50_ms")]
    pub ttft_p50_ms: f64,
    #[serde(rename = "ttft_p90_ms")]
    pub ttft_p90_ms: f64,
    #[serde(rename = "ttft_p95_ms")]
    pub ttft_p95_ms: f64,
    #[serde(rename = "ttft_p99_ms")]
    pub ttft_p99_ms: f64,
    /// TPOT 百分位（毫秒）
    #[serde(rename = "tpot_p50_ms")]
    pub tpot_p50_ms: f64,
    #[serde(rename = "tpot_p90_ms")]
    pub tpot_p90_ms: f64,
    #[serde(rename = "tpot_p95_ms")]
    pub tpot_p95_ms: f64,
    #[serde(rename = "tpot_p99_ms")]
    pub tpot_p99_ms: f64,
    /// E2E Latency 百分位（毫秒）
    #[serde(rename = "e2e_p50_ms")]
    pub e2e_p50_ms: f64,
    #[serde(rename = "e2e_p90_ms")]
    pub e2e_p90_ms: f64,
    #[serde(rename = "e2e_p95_ms")]
    pub e2e_p95_ms: f64,
    #[serde(rename = "e2e_p99_ms")]
    pub e2e_p99_ms: f64,
    /// 平均吞吐（tokens/s）
    pub avg_throughput_tok_s: f64,
    /// 成功率
    pub success_rate_pct: f64,
}

/// SSE chunk 事件（向前端 emit）
#[derive(Debug, Clone, Serialize)]
pub struct SseChunkEvent {
    pub request_id: u32,
    pub index: u32,
    pub token: String,
    pub is_finish: bool,
}

/// 进度事件（向前端 emit）
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub completed: u32,
    pub total: u32,
    pub current_ttft_us: Option<u64>,
    pub current_tpots: Vec<u64>,
}

/// 取消事件（向前端 emit）
#[derive(Debug, Clone, Serialize)]
pub struct CancelEvent {
    pub completed: u32,
    pub total: u32,
    pub message: String,
}

// ─── Cancellation ─────────────────────────────────────────────
static CANCEL_FLAG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn check_cancel() -> bool {
    CANCEL_FLAG.load(std::sync::atomic::Ordering::SeqCst)
}

/// 取消压测：置位取消标志，运行中的请求会在下一次检查点自行终止
#[tauri::command]
pub async fn cancel_bench(app: AppHandle) -> Result<(), String> {
    if check_cancel() {
        return Ok(()); // already cancelled
    }
    CANCEL_FLAG.store(true, std::sync::atomic::Ordering::SeqCst);
    log_msg(LogLevel::Info, "BENCH", "User canceled the benchmark".to_string());

    let _ = app.emit(
        "bench:canceled",
        serde_json::json!({
            "completed": 0,
            "total": 0,
            "message": "Benchmark canceled"
        }),
    );

    Ok(())
}

/// 每次请求都拼一段唯一标记塞进第一条消息开头，专门用来"打破"推理引擎
/// 的前缀/KV cache 复用——不管是单轮固定 prompt、循环导入的 prompt 池，
/// 还是多轮对话的固定对话历史，只要请求间发的内容从第一个 token 起就不
/// 完全一样，引擎就没法把这次请求的 prefill 计算偷懒复用成之前请求的
/// 缓存结果，压测出来的 TTFT/TPOT 才是真实（未命中缓存）的推理耗时，
/// 而不是被前缀缓存加速后的假象。用纳秒时间戳 + request_id 拼出来，不
/// 需要额外引入随机数依赖，同一进程内不会跟之前的请求重复。
fn cache_defeat_marker(request_id: u32) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("[bench-{nanos:x}-{request_id}]")
}

/// 根据配置构造本次请求的消息数组：优先使用多轮对话消息列表，
/// 其次按 request_id 从循环 prompt 池中取一条，都没有则退回单个 prompt 字段。
/// 第一条消息的开头会被塞进一段唯一标记，用来打破前缀/KV cache 复用
/// （见 cache_defeat_marker 的说明）。
fn build_messages(config: &BenchConfig, request_id: u32) -> Vec<serde_json::Value> {
    let mut messages: Vec<serde_json::Value> = if !config.messages.is_empty() {
        config
            .messages
            .iter()
            .map(|m| serde_json::json!({"role": m.role, "content": m.content}))
            .collect()
    } else if !config.prompt_pool.is_empty() {
        let idx = (request_id as usize - 1) % config.prompt_pool.len();
        vec![serde_json::json!({"role": "user", "content": config.prompt_pool[idx]})]
    } else {
        vec![serde_json::json!({"role": "user", "content": config.prompt})]
    };

    if let Some(first) = messages.first_mut() {
        if let Some(content) = first["content"].as_str() {
            first["content"] = serde_json::Value::String(format!(
                "{} {}",
                cache_defeat_marker(request_id),
                content
            ));
        }
    }

    messages
}

/// reqwest::Error 的 Display 只给顶层信息（如 "error sending request for
/// url (...)"），真正有用的原因（connection refused / timeout / dns 失败等）
/// 藏在 source chain 里，不手动遍历就看不到。
fn describe_error(e: &(dyn std::error::Error + 'static)) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        msg.push_str(" — caused by: ");
        msg.push_str(&s.to_string());
        source = s.source();
    }
    msg
}

/// 从一个 SSE chunk 的 choice 里取出本次要计入 token 的文本。
/// 优先用标准的 `delta.content`；但"思考"模型（如 Qwen3 的 thinking
/// 模式、DeepSeek-R1 等）在正式回答之前会把思维链文本放进
/// `delta.reasoning` / `delta.reasoning_content`，此时 content 会一直是
/// 空字符串。这些 reasoning token 同样是模型真实生成、真实耗时的
/// token，压测应该计入 TTFT/TPOT，否则这类模型的指标会全部记成 0。
fn extract_delta_text(choice: &serde_json::Value) -> Option<&str> {
    let delta = &choice["delta"];
    ["content", "reasoning", "reasoning_content"]
        .into_iter()
        .find_map(|field| delta[field].as_str().filter(|s| !s.is_empty()))
}

/// 把 [1, num_requests] 按 concurrency 分成若干批，每批返回
/// (batch_start, batch_end)—— 闭区间，两端都包含在批次里。
fn compute_batches(num_requests: u32, concurrency: u32) -> Vec<(u32, u32)> {
    let concurrency = concurrency.max(1).min(num_requests.max(1));
    (1..=num_requests)
        .step_by(concurrency as usize)
        .map(|batch_start| (batch_start, (batch_start + concurrency - 1).min(num_requests)))
        .collect()
}

/// 请求在并发批次里的"槽位"编号（1..=concurrency），用来在日志里区分
/// 到底是哪一路并发请求打出来的行——同一槽位号会在不同批次间复用
/// （比如并发数=2时，#1 和 #3 都是槽位1，#2 和 #4 都是槽位2），这样能
/// 顺着某一路并发的日志连续看下去。
fn concurrency_slot(request_id: u32, config: &BenchConfig) -> u32 {
    let concurrency = config.concurrency.max(1).min(config.num_requests.max(1));
    ((request_id - 1) % concurrency) + 1
}

/// 用户可能填 "http://host:port"，也可能按 Ollama/OpenAI 文档习惯直接填
/// "http://host:port/v1"——后一种情况后面拼接子路径时不能再无脑追加
/// "/v1"，否则会拼成 ".../v1/v1/xxx"。
fn build_endpoint_url(base_url: &str, sub_path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/{sub_path}")
    } else {
        format!("{base}/v1/{sub_path}")
    }
}

/// 拼出 chat completions 端点 URL。
fn build_chat_completions_url(base_url: &str) -> String {
    build_endpoint_url(base_url, "chat/completions")
}

/// 拼出模型列表端点 URL。
fn build_models_url(base_url: &str) -> String {
    build_endpoint_url(base_url, "models")
}

/// 向 OpenAI 兼容端点发送单个流式请求并返回指标
async fn run_request_inner<R: Runtime>(
    app: &AppHandle<R>,
    config: &BenchConfig,
    request_id: u32,
) -> Result<RequestMetrics, String> {
    let timeout = std::time::Duration::from_millis(config.request_timeout_ms.max(1));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", describe_error(&e)))?;

    let url = build_chat_completions_url(&config.base_url);

    let messages_val = build_messages(config, request_id);

    let body = serde_json::json!({
        "model": config.model,
        "messages": messages_val,
        "stream": true,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
    });

    // Build request with optional headers
    let mut builder = client
        .post(&url)
        .json(&body)
        .header("Content-Type", "application/json");

    if let Some(ref auth) = config.auth_header {
        builder = builder.header("Authorization", auth);
    }

    if let Some(ref headers) = config.custom_headers {
        for (k, v) in headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
    }

    let response = builder.send().await.map_err(|e| format!("HTTP request failed: {}", describe_error(&e)))?;

    log_msg(
        LogLevel::Debug,
        "BENCH",
        format!(
            "[worker{}] #{request_id} HTTP POST succeeded, status={}",
            concurrency_slot(request_id, config),
            response.status()
        ),
    );

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();

        let hint = match status.as_u16() {
            401 => format!("Authentication failed (401): {}", body_text),
            403 => format!("Permission denied (403): {}", body_text),
            429 => format!("Rate limited (429): {}", body_text),
            500 => format!("Internal server error (500): {}", body_text),
            502 => format!("Bad gateway (502): {}", body_text),
            503 => format!("Service unavailable (503): {}", body_text),
            _ => format!("Server returned an error [{status}]: {body_text}"),
        };

        return Err(hint);
    }

    use futures::StreamExt;
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut token_index: u32 = 0;
    let mut first_token_time: Option<std::time::Instant> = None;
    let mut last_token_time: Option<std::time::Instant> = None;
    let mut tpots: Vec<u64> = Vec::new();
    let start = std::time::Instant::now();

    while let Some(chunk_result) = stream.next().await {
        if check_cancel() {
            return Err("Benchmark was canceled".to_string());
        }

        let chunk_bytes = chunk_result.map_err(|e| format!("Failed to read stream: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk_bytes));

        while let Some(pos) = buffer.find('\n') {
            if check_cancel() {
                return Err("Benchmark was canceled".to_string());
            }

            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();

            if !line.starts_with("data: ") {
                continue;
            }

            let data_str = &line["data: ".len()..];
            if data_str.trim() == "[DONE]" {
                break;
            }

            let chunk_data: serde_json::Value = match serde_json::from_str(data_str) {
                Ok(v) => v,
                Err(e) => {
                    log_msg(
                        LogLevel::Warn,
                        "BENCH",
                        format!(
                            "[worker{}] #{request_id} failed to parse SSE chunk: {e}, content: {data_str}",
                            concurrency_slot(request_id, config)
                        ),
                    );
                    continue;
                }
            };

            let choices: &[serde_json::Value] =
                chunk_data["choices"].as_array().map(|a| a.as_ref()).unwrap_or(&[]);
            if choices.is_empty() {
                continue;
            }

            let choice = &choices[0];
            let is_finish = choice["finish_reason"]
                .as_str()
                .map(|s| s == "stop" || s == "end_turn")
                .unwrap_or(false);

            let delta_content = match extract_delta_text(choice) {
                Some(s) => s,
                None => continue,
            };

            let now = std::time::Instant::now();

            if first_token_time.is_none() {
                first_token_time = Some(now);
            } else {
                if let Some(prev) = last_token_time {
                    tpots.push(prev.elapsed().as_micros() as u64);
                }
            }
            last_token_time = Some(now);

            // 向前端推送 token 事件
            let event = SseChunkEvent {
                request_id,
                index: token_index,
                token: delta_content.to_string(),
                is_finish,
            };
            // 直接传结构体，让 Tauri 自己序列化成 JSON object payload；
            // 之前这里先手动 to_string() 再传，等于把 JSON 又编码成了一层
            // 字符串——前端 listen() 收到的 payload 就是个原始字符串而不是
            // 对象，访问 payload.token 之类字段全是 undefined，进而在
            // .slice()/.length 上抛异常，把整个应用崩掉。
            let _ = app.emit("bench:sse_chunk", &event);

            token_index += 1;
        }
    }

    let ttft_us = first_token_time
        .map(|t| t.elapsed().as_micros() as u64)
        .unwrap_or(0);
    let e2e_us = start.elapsed().as_micros() as u64;

    Ok(RequestMetrics {
        request_id,
        ttft_us,
        tpots,
        e2e_latency_us: e2e_us,
        token_count: if first_token_time.is_some() { token_index } else { 0 },
        success: true,
        error: None,
    })
}

/// 带重试的请求执行
async fn run_request<R: Runtime>(
    app: &AppHandle<R>,
    config: &BenchConfig,
    request_id: u32,
) -> Result<RequestMetrics, String> {
    let max_retries = config.max_retries;
    let mut last_error = None;

    for attempt in 0..=max_retries {
        if check_cancel() {
            return Err("Benchmark was canceled".to_string());
        }

        match run_request_inner(app, config, request_id).await {
            Ok(metrics) => return Ok(metrics),
            Err(e) => {
                last_error = Some(e.clone());
                if attempt < max_retries && !check_cancel() {
                    let delay_ms = 100 * (attempt as u64 + 1);
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    log_msg(
                        LogLevel::Warn,
                        "BENCH",
                        format!(
                            "[worker{}] #{request_id} retry {}/{}: {e}",
                            concurrency_slot(request_id, config),
                            attempt + 1,
                            max_retries
                        ),
                    );
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Unknown error".to_string()))
}

/// 启动压测引擎（N 路并发）
#[tauri::command]
pub async fn start_bench(app: AppHandle, config: BenchConfig) -> Result<(), String> {
    // Reset cancel flag at start
    CANCEL_FLAG.store(false, std::sync::atomic::Ordering::SeqCst);

    log_msg(
        LogLevel::Info,
        "BENCH",
        format!(
            "Benchmark started: concurrency={} num_requests={}",
            config.concurrency, config.num_requests
        ),
    );

    let concurrency = config.concurrency.max(1).min(config.num_requests);
    let completed = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let all_metrics = std::sync::Arc::new(std::sync::Mutex::new(vec![]));

    for (batch_start, end) in compute_batches(config.num_requests, concurrency) {
        if check_cancel() {
            break;
        }

        let mut handles: Vec<(u32, tokio::task::JoinHandle<()>)> = vec![];

        for request_id in batch_start..=end {
            if check_cancel() {
                break;
            }

            let app_clone = app.clone();
            let config_clone = config.clone();
            let completed_clone = completed.clone();
            let metrics_clone = all_metrics.clone();

            let h = tokio::spawn(async move {
                let metrics = run_request(&app_clone, &config_clone, request_id).await;
                let done = completed_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;

                // 推送进度事件
                let progress = ProgressEvent {
                    completed: done,
                    total: config_clone.num_requests,
                    current_ttft_us: metrics.as_ref().ok().map(|m| m.ttft_us),
                    current_tpots: metrics
                        .as_ref()
                        .ok()
                        .map(|m| m.tpots.clone())
                        .unwrap_or_default(),
                };
                let _ = app_clone.emit("bench:progress", &progress);

                match metrics {
                    Ok(m) => {
                        log_msg(
                            LogLevel::Info,
                            "BENCH",
                            format!(
                                "[worker{}] #{request_id} done: TTFT={:.2}ms tokens={} e2e={:.2}ms",
                                concurrency_slot(request_id, &config_clone),
                                m.ttft_us as f64 / 1000.0,
                                m.token_count,
                                m.e2e_latency_us as f64 / 1000.0
                            ),
                        );
                        metrics_clone.lock().unwrap().push(m.clone());
                    }
                    Err(e) => {
                        log_msg(
                            LogLevel::Error,
                            "BENCH",
                            format!("[worker{}] #{request_id} failed: {e}", concurrency_slot(request_id, &config_clone)),
                        );
                        let m = RequestMetrics {
                            request_id,
                            ttft_us: 0,
                            tpots: vec![],
                            e2e_latency_us: 0,
                            token_count: 0,
                            success: false,
                            error: Some(e),
                        };
                        metrics_clone.lock().unwrap().push(m);
                    }
                }
            });

            handles.push((request_id, h));

            // Per-request interval (delay after spawning each request)
            if config.per_request_interval_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(config.per_request_interval_ms))
                    .await;
            }
        }

        // 等待本批次所有任务结束。每个任务内部已经会在取消标志位设置后
        // 尽快自行终止（发起请求前 / 读取每个 SSE chunk 时都会检查），
        // 所以这里始终等待它们结束，而不是提前 return —— 避免已经 spawn
        // 出去的任务在函数返回后仍然在后台继续跑、继续占用目标服务资源。
        for (req_id, h) in handles.drain(..) {
            match h.await {
                Ok(_) => {}
                Err(e) => {
                    log_msg(LogLevel::Error, "BENCH", format!("Request #{req_id} task failed: {e}"));
                    let m = RequestMetrics {
                        request_id: req_id,
                        ttft_us: 0,
                        tpots: vec![],
                        e2e_latency_us: 0,
                        token_count: 0,
                        success: false,
                        error: Some(format!("Task execution failed: {e}")),
                    };
                    let mut m_ref = all_metrics.lock().unwrap();
                    m_ref.push(m);
                    drop(m_ref);

                    let done = completed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    let _ = app.emit(
                        "bench:progress",
                        &ProgressEvent {
                            completed: done,
                            total: config.num_requests,
                            current_ttft_us: None,
                            current_tpots: vec![],
                        },
                    );
                }
            }
        }

        if check_cancel() {
            break;
        }

        // Batch interval (delay between batches)
        if config.batch_interval_ms > 0 && batch_start + concurrency <= config.num_requests {
            tokio::time::sleep(std::time::Duration::from_millis(config.batch_interval_ms)).await;
        }
    }

    if check_cancel() {
        let done = completed.load(std::sync::atomic::Ordering::SeqCst);
        let _ = app.emit(
            "bench:canceled",
            CancelEvent {
                completed: done,
                total: config.num_requests,
                message: "Benchmark canceled".to_string(),
            },
        );
        CANCEL_FLAG.store(false, std::sync::atomic::Ordering::SeqCst);
        return Ok(());
    }

    let metrics = all_metrics.lock().unwrap();
    if metrics.is_empty() {
        return Err("No valid responses received".to_string());
    }

    // Reset cancel flag after completion (for next run)
    CANCEL_FLAG.store(false, std::sync::atomic::Ordering::SeqCst);

    let report = compute_report(&config, &metrics);

    let _ = app.emit("bench:done", &report);

    // Auto-save report to disk
    if let Ok(path) = save_report_to_disk(&report) {
        log_msg(LogLevel::Info, "BENCH", format!("Report auto-saved: {}", path));
    }

    Ok(())
}

/// 计算基准报告
fn compute_report(config: &BenchConfig, metrics: &[RequestMetrics]) -> BenchReport {
    let success_count = metrics.iter().filter(|m| m.success).count();
    let total = metrics.len() as f64;

    // TTFT（微秒转毫秒）
    let mut ttfts_us: Vec<u64> = metrics.iter().map(|m| m.ttft_us).collect();
    ttfts_us.sort_unstable();
    let ttfts_ms: Vec<f64> = ttfts_us.iter().map(|v| *v as f64 / 1000.0).collect();

    // TPOT（微秒转毫秒）
    let all_tpots_us: Vec<u64> = metrics.iter().flat_map(|m| m.tpots.clone()).collect();
    let all_tpots_ms: Vec<f64> = all_tpots_us.iter().map(|v| *v as f64 / 1000.0).collect();

    // E2E Latency（微秒转毫秒）
    let mut e2es_us: Vec<u64> = metrics.iter().map(|m| m.e2e_latency_us).collect();
    e2es_us.sort_unstable();
    let e2es_ms: Vec<f64> = e2es_us.iter().map(|v| *v as f64 / 1000.0).collect();

    // 平均吞吐（tokens/s）
    let success_metrics: Vec<&RequestMetrics> = metrics.iter().filter(|m| m.success).collect();
    let total_tokens: f64 = success_metrics.iter().map(|m| m.token_count as f64).sum();
    let avg_e2e_s: f64 = success_metrics
        .iter()
        .map(|m| m.e2e_latency_us as f64 / 1_000_000.0)
        .sum::<f64>()
        .max(1e-9)
        / total;

    let avg_throughput = total_tokens / avg_e2e_s;

    BenchReport {
        config: config.clone(),
        metrics: metrics.to_vec(),
        ttft_p50_ms: percentile_f64(&ttfts_ms, 50.0),
        ttft_p90_ms: percentile_f64(&ttfts_ms, 90.0),
        ttft_p95_ms: percentile_f64(&ttfts_ms, 95.0),
        ttft_p99_ms: percentile_f64(&ttfts_ms, 99.0),
        tpot_p50_ms: percentile_f64(&all_tpots_ms, 50.0),
        tpot_p90_ms: percentile_f64(&all_tpots_ms, 90.0),
        tpot_p95_ms: percentile_f64(&all_tpots_ms, 95.0),
        tpot_p99_ms: percentile_f64(&all_tpots_ms, 99.0),
        e2e_p50_ms: percentile_f64(&e2es_ms, 50.0),
        e2e_p90_ms: percentile_f64(&e2es_ms, 90.0),
        e2e_p95_ms: percentile_f64(&e2es_ms, 95.0),
        e2e_p99_ms: percentile_f64(&e2es_ms, 99.0),
        avg_throughput_tok_s: avg_throughput,
        success_rate_pct: (success_count as f64 / total) * 100.0,
    }
}

fn percentile_f64(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (p / 100.0 * sorted.len() as f64).ceil() as usize - 1;
    sorted[idx.min(sorted.len() - 1)]
}

// ─── Report Persistence ───────────────────────────────────────
const REPORTS_DIR: &str = ".inferscope_reports";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSummary {
    pub path: String,
    pub created_at: String,
    pub model: String,
    pub num_requests: u32,
}

fn get_reports_dir() -> std::path::PathBuf {
    let reports_dir = get_app_data_dir().join(REPORTS_DIR);
    let _ = std::fs::create_dir_all(&reports_dir);
    reports_dir
}

fn save_report_to_disk(report: &BenchReport) -> Result<String, String> {
    let dir = get_reports_dir();
    let _ = std::fs::create_dir_all(&dir);

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("report_{}.json", timestamp);
    let filepath = dir.join(&filename);

    let json_str = serde_json::to_string_pretty(report).map_err(|e| format!("Serialization failed: {e}"))?;
    std::fs::write(&filepath, json_str).map_err(|e| format!("Failed to write file: {e}"))?;

    Ok(filepath.to_string_lossy().to_string())
}

/// 读取文件的真实修改时间（作为报告的创建时间展示）
fn file_modified_time_string(path: &std::path::Path) -> String {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            let datetime: chrono::DateTime<chrono::Local> = t.into();
            datetime.format("%Y-%m-%d %H:%M:%S").to_string()
        })
        .unwrap_or_else(|_| "unknown".to_string())
}

/// 列出已保存的压测报告
#[tauri::command]
pub fn list_reports() -> Result<Vec<ReportSummary>, String> {
    let dir = get_reports_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut summaries = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                let created_at = file_modified_time_string(&path);
                // Try to extract model and num_requests from the report JSON
                if let Ok(report) = serde_json::from_str::<BenchReport>(&content) {
                    summaries.push(ReportSummary {
                        path: path.to_string_lossy().to_string(),
                        created_at,
                        model: report.config.model.clone(),
                        num_requests: report.config.num_requests,
                    });
                } else {
                    summaries.push(ReportSummary {
                        path: path.to_string_lossy().to_string(),
                        created_at,
                        model: "unknown".to_string(),
                        num_requests: 0,
                    });
                }
            }
        }
    }
    summaries.sort_by(|a, b| b.path.cmp(&a.path));
    Ok(summaries)
}

/// 加载指定报告
#[tauri::command]
pub fn load_report(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))
}

/// 删除指定的报告文件
#[tauri::command]
pub fn delete_report(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {e}"))
}

// ─── Last-used config (no named presets — just remember the last run) ──
const LAST_CONFIG_FILE: &str = "last_config.json";

pub(crate) fn get_app_data_dir() -> std::path::PathBuf {
    if let Some(data_dir) = dirs::config_dir().map(|d| d.join("inferscope")) {
        let _ = std::fs::create_dir_all(&data_dir);
        return data_dir;
    }

    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap())
}

#[tauri::command]
pub fn save_last_config(config: BenchConfig) -> Result<(), String> {
    let path = get_app_data_dir().join(LAST_CONFIG_FILE);
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("Serialization failed: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write file: {e}"))
}

/// 读取上次用过的配置。文件不存在，或者是旧格式解析不出来，都直接返回
/// None（前端会退回默认配置），不算错误。
#[tauri::command]
pub fn load_last_config() -> Result<Option<BenchConfig>, String> {
    let path = get_app_data_dir().join(LAST_CONFIG_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))?;
    Ok(serde_json::from_str::<BenchConfig>(&content).ok())
}

// ─── Remote model listing ──────────────────────────────────────
#[derive(Debug, Deserialize)]
struct ModelsListResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

/// 从目标 Base URL 的 `/v1/models` 端点拉取可用模型列表。
/// 用 Rust 端的 reqwest 直接发请求（而不是让前端 fetch），既能复用鉴权
/// 头，也不会撞上浏览器的跨域限制。
#[tauri::command]
pub async fn list_remote_models(
    base_url: String,
    auth_header: Option<String>,
    custom_headers: Option<HashMap<String, String>>,
) -> Result<Vec<String>, String> {
    let url = build_models_url(&base_url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(10_000))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", describe_error(&e)))?;

    let mut builder = client.get(&url);
    if let Some(ref auth) = auth_header {
        builder = builder.header("Authorization", auth);
    }
    if let Some(ref headers) = custom_headers {
        for (k, v) in headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("Failed to request model list: {}", describe_error(&e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Server returned an error [{status}]: {body}"));
    }

    let parsed: ModelsListResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse model list response: {e}"))?;

    if parsed.data.is_empty() {
        return Err("This service did not return any models".to_string());
    }

    Ok(parsed.data.into_iter().map(|m| m.id).collect())
}

// ─── File Utilities ───────────────────────────────────────────
/// 读取文本文件内容（用于导入提示词）
#[tauri::command]
pub fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))
}

/// 导出报告为 JSON/CSV（保留原功能）
#[tauri::command]
pub fn export_report(report_json: &str, format: String, path: String) -> Result<(), String> {
    let bench_report: BenchReport = serde_json::from_str(report_json).map_err(|e| format!("Failed to parse report: {e}"))?;

    if format == "csv" || path.ends_with(".csv") {
        let mut lines: Vec<String> = vec![
            "request_id,ttft_ms,tpot_avg_ms,e2e_ms,tokens,success,error".to_string(),
        ];
        for m in &bench_report.metrics {
            let avg_tpot = if !m.tpots.is_empty() {
                m.tpots.iter().sum::<u64>() as f64 / m.tpots.len() as f64 / 1000.0
            } else {
                0.0
            };
            lines.push(format!(
                "{},{:.2},{:.4},{:.2},{},{},{}",
                m.request_id,
                m.ttft_us as f64 / 1000.0,
                avg_tpot,
                m.e2e_latency_us as f64 / 1000.0,
                m.token_count,
                if m.success { "true" } else { "false" },
                m.error.as_deref().unwrap_or("")
            ));
        }
        std::fs::write(&path, lines.join("\n")).map_err(|e| format!("Failed to write file: {e}"))?;
    } else {
        let json_str = serde_json::to_string_pretty(&bench_report).map_err(|e| format!("Serialization failed: {e}"))?;
        std::fs::write(&path, json_str).map_err(|e| format!("Failed to write file: {e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // CANCEL_FLAG is a single process-wide static, so tests that set/read it
    // must not run concurrently with each other or they'll interfere.
    static CANCEL_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn make_config() -> BenchConfig {
        BenchConfig {
            base_url: "http://localhost:8000/v1".to_string(),
            model: "test-model".to_string(),
            prompt: "test prompt".to_string(),
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
        }
    }

    /// 锁定 BenchReport 序列化后的 JSON key 名——必须和
    /// src/types/bench.ts 里的 BenchReport 字段名完全一致，否则前端拿到
    /// 的对应字段就是 undefined（这正是之前 avg_throughput/success_rate
    /// 被误重命名导致结果页/历史对比页崩溃的根因）。
    #[test]
    fn test_bench_report_json_keys_match_frontend_type() {
        let config = make_config();
        let metrics = vec![RequestMetrics {
            request_id: 1,
            ttft_us: 100_000,
            tpots: vec![5_000],
            e2e_latency_us: 200_000,
            token_count: 3,
            success: true,
            error: None,
        }];
        let report = compute_report(&config, &metrics);
        let json = serde_json::to_value(&report).unwrap();

        for key in [
            "avg_throughput_tok_s",
            "success_rate_pct",
            "ttft_p50_ms",
            "tpot_p50_ms",
            "e2e_p50_ms",
        ] {
            assert!(
                json.get(key).is_some(),
                "BenchReport JSON is missing expected key `{key}` (frontend BenchReport type in src/types/bench.ts expects it) — got keys: {:?}",
                json.as_object().map(|o| o.keys().collect::<Vec<_>>())
            );
        }
    }

    #[test]
    fn test_compute_report_success_only() {
        let config = make_config();
        let metrics = vec![
            RequestMetrics {
                request_id: 1,
                ttft_us: 100_000,
                tpots: vec![5_000, 6_000],
                e2e_latency_us: 200_000,
                token_count: 3,
                success: true,
                error: None,
            },
            RequestMetrics {
                request_id: 2,
                ttft_us: 120_000,
                tpots: vec![4_000, 7_000],
                e2e_latency_us: 250_000,
                token_count: 3,
                success: true,
                error: None,
            },
        ];

        let report = compute_report(&config, &metrics);
        assert_eq!(report.metrics.len(), 2);
        assert!(report.success_rate_pct == 100.0);
        assert!(report.ttft_p50_ms > 0.0);
        assert!(report.avg_throughput_tok_s > 0.0);
    }

    #[test]
    fn test_compute_report_with_failures() {
        let config = make_config();
        let metrics = vec![
            RequestMetrics {
                request_id: 1,
                ttft_us: 100_000,
                tpots: vec![5_000],
                e2e_latency_us: 200_000,
                token_count: 2,
                success: true,
                error: None,
            },
            RequestMetrics {
                request_id: 2,
                ttft_us: 0,
                tpots: vec![],
                e2e_latency_us: 0,
                token_count: 0,
                success: false,
                error: Some("timeout".to_string()),
            },
        ];

        let report = compute_report(&config, &metrics);
        assert!(report.success_rate_pct == 50.0);
    }

    #[test]
    fn test_percentile_empty() {
        assert_eq!(percentile_f64(&[], 50.0), 0.0);
    }

    #[test]
    fn test_percentile_single_value() {
        let v = vec![42.0];
        assert_eq!(percentile_f64(&v, 50.0), 42.0);
        assert_eq!(percentile_f64(&v, 99.0), 42.0);
    }

    #[test]
    fn test_percentile_multiple_values() {
        let v = vec![10.0, 20.0, 30.0, 40.0, 50.0];
        assert!(percentile_f64(&v, 50.0) >= 20.0 && percentile_f64(&v, 50.0) <= 30.0);
        assert_eq!(percentile_f64(&v, 99.0), 50.0);
    }

    #[test]
    fn test_default_timeout() {
        let default = default_timeout();
        assert_eq!(default, 60000);
    }

    /// save_last_config/load_last_config round-trip a BenchConfig through
    /// serde_json to a file — this locks in that the serialization is
    /// actually symmetric (a stray #[serde(rename)] or similar would
    /// silently lose a field, same class of bug as the earlier
    /// avg_throughput/success_rate mismatch on BenchReport).
    #[test]
    fn test_bench_config_json_round_trips() {
        let mut config = make_config();
        config.messages = vec![Message { role: "system".to_string(), content: "sys prompt".to_string() }];
        config.prompt_pool = vec!["a".to_string(), "b".to_string()];
        config.auth_header = Some("Bearer xyz".to_string());

        let json = serde_json::to_string(&config).unwrap();
        let restored: BenchConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, config);
    }

    #[test]
    fn test_file_modified_time_string_reflects_real_mtime() {
        let dir = std::env::temp_dir().join(format!("inferscope_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("report.json");
        std::fs::write(&file_path, "{}").unwrap();

        let before = chrono::Local::now() - chrono::Duration::seconds(5);
        let created_at = file_modified_time_string(&file_path);

        // Parseable, and not just "now the function ran" — should reflect the
        // file's actual mtime, which is between `before` and now.
        let parsed = chrono::NaiveDateTime::parse_from_str(&created_at, "%Y-%m-%d %H:%M:%S")
            .expect("created_at should be a valid timestamp string");
        assert!(parsed >= before.naive_local());
        assert!(parsed <= chrono::Local::now().naive_local());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_file_modified_time_string_missing_file() {
        let missing = std::path::Path::new("/nonexistent/path/does_not_exist.json");
        assert_eq!(file_modified_time_string(missing), "unknown");
    }

    #[test]
    fn test_build_messages_uses_multiturn_when_present() {
        let mut config = make_config();
        config.messages = vec![
            Message { role: "system".to_string(), content: "sys".to_string() },
            Message { role: "user".to_string(), content: "hi".to_string() },
        ];
        config.prompt_pool = vec!["should not be used".to_string()];

        let msgs = build_messages(&config, 1);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        // First message gets the cache-defeat marker prepended; later
        // messages in the conversation are untouched.
        assert!(msgs[0]["content"].as_str().unwrap().ends_with("sys"));
        assert_eq!(msgs[1]["content"], "hi");
    }

    #[test]
    fn test_build_messages_cycles_prompt_pool() {
        let mut config = make_config();
        config.prompt_pool = vec!["a".to_string(), "b".to_string(), "c".to_string()];

        assert!(build_messages(&config, 1)[0]["content"].as_str().unwrap().ends_with("a"));
        assert!(build_messages(&config, 2)[0]["content"].as_str().unwrap().ends_with("b"));
        assert!(build_messages(&config, 3)[0]["content"].as_str().unwrap().ends_with("c"));
        assert!(build_messages(&config, 4)[0]["content"].as_str().unwrap().ends_with("a")); // wraps around
    }

    #[test]
    fn test_build_messages_falls_back_to_prompt() {
        let config = make_config();
        let msgs = build_messages(&config, 1);
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0]["content"].as_str().unwrap().ends_with(&config.prompt));
    }

    #[test]
    fn test_cache_defeat_marker_prepended_to_first_message_only() {
        let config = make_config();
        let msgs = build_messages(&config, 1);
        let content = msgs[0]["content"].as_str().unwrap();
        assert!(
            content.starts_with("[bench-"),
            "expected a cache-defeat marker prefix, got: {content}"
        );
        assert!(content.ends_with(&config.prompt));
    }

    #[test]
    fn test_cache_defeat_marker_differs_across_requests() {
        let config = make_config();
        let content1 = build_messages(&config, 1)[0]["content"].as_str().unwrap().to_string();
        let content2 = build_messages(&config, 2)[0]["content"].as_str().unwrap().to_string();
        assert_ne!(
            content1, content2,
            "two different requests must not send byte-identical content, or the server can prefix-cache one against the other"
        );
    }

    /// 覆盖之前那个 off-by-one bug：并发数为 1 时批次区间是空的，一个
    /// 请求都不会真正发出去；并发数 >1 时也会漏掉每批最后一个
    /// request_id。这里对 num_requests/concurrency 的每种组合都验证一遍
    /// ——分批后拼起来必须正好是 [1, num_requests]，不重不漏。
    #[test]
    fn test_compute_batches_covers_every_request_id_exactly_once() {
        for num_requests in 1..=10u32 {
            for concurrency in 1..=10u32 {
                let batches = compute_batches(num_requests, concurrency);
                let mut ids: Vec<u32> = batches.iter().flat_map(|&(s, e)| s..=e).collect();
                ids.sort_unstable();
                let expected: Vec<u32> = (1..=num_requests).collect();
                assert_eq!(
                    ids, expected,
                    "num_requests={num_requests} concurrency={concurrency} batches={batches:?}"
                );
            }
        }
    }

    #[test]
    fn test_compute_batches_concurrency_one_is_not_empty() {
        // The exact case from the bug report: concurrency=1 must still
        // produce one request per batch, not an empty range.
        let batches = compute_batches(5, 1);
        assert_eq!(batches, vec![(1, 1), (2, 2), (3, 3), (4, 4), (5, 5)]);
    }

    #[test]
    fn test_concurrency_slot_repeats_across_batches() {
        let mut config = make_config();
        config.concurrency = 2;
        config.num_requests = 5;
        // requests 1,3,5 -> slot 1; requests 2,4 -> slot 2
        assert_eq!(concurrency_slot(1, &config), 1);
        assert_eq!(concurrency_slot(2, &config), 2);
        assert_eq!(concurrency_slot(3, &config), 1);
        assert_eq!(concurrency_slot(4, &config), 2);
        assert_eq!(concurrency_slot(5, &config), 1);
    }

    #[test]
    fn test_concurrency_slot_never_exceeds_effective_concurrency() {
        for num_requests in 1..=10u32 {
            for raw_concurrency in 1..=10u32 {
                let mut config = make_config();
                config.concurrency = raw_concurrency;
                config.num_requests = num_requests;
                let effective = raw_concurrency.max(1).min(num_requests.max(1));
                for request_id in 1..=num_requests {
                    let slot = concurrency_slot(request_id, &config);
                    assert!(
                        slot >= 1 && slot <= effective,
                        "slot {slot} out of range 1..={effective} for request_id={request_id} concurrency={raw_concurrency} num_requests={num_requests}"
                    );
                }
            }
        }
    }

    #[test]
    fn test_build_chat_completions_url_appends_v1_when_missing() {
        assert_eq!(
            build_chat_completions_url("http://localhost:11434"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            build_chat_completions_url("http://localhost:11434/"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn test_build_chat_completions_url_does_not_double_v1() {
        assert_eq!(
            build_chat_completions_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            build_chat_completions_url("http://localhost:11434/v1/"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            build_chat_completions_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_build_models_url() {
        assert_eq!(
            build_models_url("http://localhost:11434"),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            build_models_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            build_models_url("http://localhost:11434/v1/"),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn test_extract_delta_text_prefers_content() {
        let choice = serde_json::json!({"delta": {"role": "assistant", "content": "hello", "reasoning": "ignored"}});
        assert_eq!(extract_delta_text(&choice), Some("hello"));
    }

    #[test]
    fn test_extract_delta_text_falls_back_to_reasoning() {
        // Matches Ollama's actual streaming shape for thinking models (e.g.
        // qwen3.6:35b): content stays "" for the whole reasoning phase.
        let choice = serde_json::json!({"delta": {"role": "assistant", "content": "", "reasoning": "Here"}});
        assert_eq!(extract_delta_text(&choice), Some("Here"));
    }

    #[test]
    fn test_extract_delta_text_falls_back_to_reasoning_content() {
        let choice = serde_json::json!({"delta": {"role": "assistant", "content": "", "reasoning_content": "thinking..."}});
        assert_eq!(extract_delta_text(&choice), Some("thinking..."));
    }

    #[test]
    fn test_extract_delta_text_none_when_all_empty() {
        let choice = serde_json::json!({"delta": {"role": "assistant", "content": ""}});
        assert_eq!(extract_delta_text(&choice), None);
    }

    // ─── Real network integration tests ────────────────────────
    // Spins up a raw TCP server that speaks just enough HTTP to act as an
    // OpenAI-compatible SSE streaming endpoint, so run_request_inner's actual
    // network + SSE-parsing code (not just synthetic RequestMetrics) gets
    // exercised end-to-end.

    async fn spawn_mock_sse_server(
        sse_payloads: Vec<String>,
        delay_between_ms: u64,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let handle = tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = socket.read(&mut buf).await; // drain request, best-effort

                let body_len: usize = sse_payloads.iter().map(|p| format!("data: {p}\n\n").len()).sum();
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {body_len}\r\nConnection: close\r\n\r\n"
                );
                if socket.write_all(header.as_bytes()).await.is_err() {
                    return;
                }

                for payload in sse_payloads {
                    let chunk = format!("data: {payload}\n\n");
                    if socket.write_all(chunk.as_bytes()).await.is_err() {
                        break; // client disconnected (e.g. request cancelled)
                    }
                    let _ = socket.flush().await;
                    if delay_between_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(delay_between_ms)).await;
                    }
                }
            }
        });

        (port, handle)
    }

    /// Like spawn_mock_sse_server, but hands the raw captured request text
    /// back over a oneshot channel so a test can inspect exactly what body
    /// run_request_inner actually put on the wire.
    async fn spawn_mock_sse_server_capturing_request(
        sse_payloads: Vec<String>,
    ) -> (u16, tokio::sync::oneshot::Receiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());

                let body_len: usize = sse_payloads.iter().map(|p| format!("data: {p}\n\n").len()).sum();
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {body_len}\r\nConnection: close\r\n\r\n"
                );
                if socket.write_all(header.as_bytes()).await.is_err() {
                    return;
                }
                for payload in sse_payloads {
                    let chunk = format!("data: {payload}\n\n");
                    if socket.write_all(chunk.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = socket.flush().await;
                }
            }
        });

        (port, rx)
    }

    #[tokio::test]
    async fn test_cache_defeat_marker_reaches_real_request_body() {
        let sse_payloads = vec![
            r#"{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}"#.to_string(),
            "[DONE]".to_string(),
        ];
        let (port, rx) = spawn_mock_sse_server_capturing_request(sse_payloads).await;

        let mut config = make_config();
        config.base_url = format!("http://127.0.0.1:{port}");

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let _ = run_request_inner(&handle, &config, 1).await;

        let request_text = rx.await.expect("mock server should have captured a request");
        let body = request_text
            .split("\r\n\r\n")
            .nth(1)
            .expect("request should have a body after the header blank line");
        assert!(
            body.contains("[bench-"),
            "the actual HTTP request body must carry the cache-defeat marker, got: {body}"
        );
    }

    /// A plain (non-SSE) mock HTTP JSON server — one request in, one fixed
    /// response body out. Used to exercise list_remote_models end-to-end.
    async fn spawn_mock_json_server(status_line: &'static str, body: String) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let handle = tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = socket.read(&mut buf).await;

                let header = format!(
                    "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(header.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
            }
        });

        (port, handle)
    }

    #[tokio::test]
    async fn test_list_remote_models_parses_real_response() {
        let body = r#"{"object":"list","data":[{"id":"qwen3.6:35b","object":"model"},{"id":"qwen3.5:9b","object":"model"}]}"#.to_string();
        let (port, _server) = spawn_mock_json_server("HTTP/1.1 200 OK", body).await;

        let models = list_remote_models(format!("http://127.0.0.1:{port}/v1"), None, None)
            .await
            .expect("should parse the mock models response");

        assert_eq!(models, vec!["qwen3.6:35b".to_string(), "qwen3.5:9b".to_string()]);
    }

    #[tokio::test]
    async fn test_list_remote_models_errors_on_empty_data() {
        let body = r#"{"object":"list","data":[]}"#.to_string();
        let (port, _server) = spawn_mock_json_server("HTTP/1.1 200 OK", body).await;

        let err = list_remote_models(format!("http://127.0.0.1:{port}/v1"), None, None)
            .await
            .expect_err("empty model list should be an error, not an empty success");
        assert!(err.contains("did not return any models"));
    }

    #[tokio::test]
    async fn test_list_remote_models_reports_http_error_status() {
        let (port, _server) = spawn_mock_json_server("HTTP/1.1 404 Not Found", "{}".to_string()).await;

        let err = list_remote_models(format!("http://127.0.0.1:{port}/v1"), None, None)
            .await
            .expect_err("404 should surface as an error");
        assert!(err.contains("404"));
    }

    #[tokio::test]
    async fn test_run_request_inner_reports_connection_refused_detail() {
        // Bind then immediately drop to get a port nothing is listening on.
        let port = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };

        let mut config = make_config();
        config.base_url = format!("http://127.0.0.1:{port}/v1");
        config.request_timeout_ms = 2000;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let err = run_request_inner(&handle, &config, 1)
            .await
            .expect_err("nothing is listening on this port, request should fail");

        assert!(err.contains("HTTP request failed"));
        assert!(
            err.contains("— caused by:"),
            "error should surface the underlying cause via the source chain, got: {err}"
        );
    }

    // Held intentionally across .await: it only serializes these two tests
    // against each other's use of the process-wide CANCEL_FLAG, and each
    // #[tokio::test] runs on its own single-threaded runtime, so there's no
    // executor to block.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn test_run_request_parses_real_sse_stream() {
        let _guard = CANCEL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        CANCEL_FLAG.store(false, std::sync::atomic::Ordering::SeqCst);

        let sse_payloads = vec![
            r#"{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#.to_string(),
            r#"{"choices":[{"delta":{"content":" world"},"finish_reason":null}]}"#.to_string(),
            r#"{"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}"#.to_string(),
            "[DONE]".to_string(),
        ];
        let (port, _server) = spawn_mock_sse_server(sse_payloads, 10).await;

        let mut config = make_config();
        config.base_url = format!("http://127.0.0.1:{port}");

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let metrics = run_request_inner(&handle, &config, 1)
            .await
            .expect("mock SSE request should succeed");

        assert!(metrics.success);
        assert_eq!(metrics.token_count, 3, "expected 3 streamed tokens (Hello/ world/!)");
        assert_eq!(metrics.tpots.len(), 2, "expected 2 inter-token gaps for 3 tokens");
        assert!(metrics.ttft_us > 0);
        assert!(metrics.e2e_latency_us > 0);
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn test_run_request_stops_quickly_when_cancelled() {
        let _guard = CANCEL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        CANCEL_FLAG.store(false, std::sync::atomic::Ordering::SeqCst);

        // Server sends many chunks slowly; without cancellation this would take ~10s.
        let sse_payloads: Vec<String> = (0..50)
            .map(|i| format!(r#"{{"choices":[{{"delta":{{"content":"tok{i} "}},"finish_reason":null}}]}}"#))
            .collect();
        let (port, _server) = spawn_mock_sse_server(sse_payloads, 200).await;

        let mut config = make_config();
        config.base_url = format!("http://127.0.0.1:{port}");

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();

        let task = tokio::spawn(async move { run_request_inner(&handle, &config, 1).await });

        // Let a couple of chunks arrive, then flip the cancel flag mid-stream.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        CANCEL_FLAG.store(true, std::sync::atomic::Ordering::SeqCst);

        let result = tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("run_request_inner did not react to cancellation in time")
            .unwrap();

        assert_eq!(result.unwrap_err(), "Benchmark was canceled");

        CANCEL_FLAG.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
