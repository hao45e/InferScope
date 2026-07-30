// 压测配置（对应 Rust BenchConfig）
export interface BenchConfig {
  base_url: string;
  model: string;
  prompt: string;
  concurrency: number;
  num_requests: number;
  max_tokens: number;
  temperature: number;
  auth_header?: string;
  custom_headers?: Record<string, string>;
  batch_interval_ms: number;
  per_request_interval_ms: number;
  max_retries: number;
  request_timeout_ms: number;
  messages?: Message[];
  prompt_pool?: string[];
  image_data_url?: string | null;
  warmup_requests?: number;
  request_rate_per_sec?: number | null;
  endpoint_type?: EndpointType;
  embedding_inputs?: string[];
  rerank_query?: string;
  rerank_documents?: string[];
}

// 压测的目标端点类型，默认 "chat"
export type EndpointType = "chat" | "embeddings" | "rerank";

// 对话消息
export interface Message {
  role: string;
  content: string;
}

// 单次请求指标（对应 Rust RequestMetrics）
export interface RequestMetrics {
  request_id: number;
  ttft_us: number;
  tpots: number[];
  e2e_latency_us: number;
  token_count: number;
  item_count?: number;
  success: boolean;
  error?: string;
}

// 基准报告（对应 Rust BenchReport）— 字段名与 JSON 序列化后一致
export interface BenchReport {
  config: BenchConfig;
  metrics: RequestMetrics[];
  ttft_p50_ms: number;
  ttft_p90_ms: number;
  ttft_p95_ms: number;
  ttft_p99_ms: number;
  tpot_p50_ms: number;
  tpot_p90_ms: number;
  tpot_p95_ms: number;
  tpot_p99_ms: number;
  e2e_p50_ms: number;
  e2e_p90_ms: number;
  e2e_p95_ms: number;
  e2e_p99_ms: number;
  avg_throughput_tok_s: number;
  avg_throughput_items_s?: number;
  success_rate_pct: number;
}

// SSE chunk 事件（向前端 emit）
export interface SseChunkEvent {
  request_id: number;
  index: number;
  token: string;
  is_finish: boolean;
}

// 进度事件（向前端 emit）
export interface ProgressEvent {
  completed: number;
  total: number;
  current_ttft_us?: number;
  current_tpots: number[];
}

// 取消事件
export interface CancelEvent {
  completed: number;
  total: number;
  message: string;
}


// 报告摘要
export interface ReportSummary {
  path: string;
  created_at: string;
  model: string;
  num_requests: number;
}
