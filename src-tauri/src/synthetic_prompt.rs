use tiktoken_rs::cl100k_base;

/// 生成合成 prompt 用的填充素材——自己写的、没有版权问题的通用段落，词汇
/// 尽量多样（避免分词后出现大量重复 token，导致真实压测意义变差）。真正
/// 生成时会反复拼接这段文字直到够长，再在 token 层面精确截断。
const FILLER_TEXT: &str = "The history of computing spans several centuries, from early \
mechanical calculators to modern electronic processors capable of billions of operations per \
second. Engineers and mathematicians gradually refined the theory of computation, discovering \
new algorithms for sorting data, searching large collections of information, and modeling \
physical systems such as weather patterns, fluid dynamics, and planetary motion. Meanwhile, \
researchers in linguistics and cognitive science explored how humans acquire language, \
recognize patterns, and reason about abstract concepts. Libraries around the world preserved \
handwritten manuscripts, printed books, and eventually digital archives, allowing knowledge to \
be shared across generations and continents. Farmers adapted irrigation techniques to grow \
crops in arid regions, while sailors navigated using stars, compasses, and later satellite \
positioning systems. Musicians experimented with new instruments and recording technologies, \
blending traditional melodies with electronic sounds. Architects designed buildings that \
balanced aesthetic beauty with structural safety, considering wind loads, seismic activity, \
and material fatigue over long periods of time. ";

/// 按目标 token 数生成一段合成 prompt 文本，用 OpenAI 的 cl100k_base 编码
/// （GPT-3.5/4 用的那套 BPE）来数 token。因为压测工具通常拿不到目标服务
/// 自己的分词器，cl100k_base 只能是个近似值——目标模型如果用的是别的分词
/// 器（llama/qwen 等），实际数出来的 token 数会有误差，这也是 genai-perf
/// 之类同类工具的通用做法。
///
/// 算法：反复拼接填充文本、编码，直到 token 数够了；然后直接在 token ID
/// 这一层截到刚好 target_tokens 个，再解码回文字——这样保证生成出来的文字
/// 用同一个分词器重新编码时，数量精确等于 target_tokens（不是在字符串层
/// 面截断，那样很容易切在一个 token 中间，数量就对不上了）。
pub fn generate_synthetic_prompt(target_tokens: u32) -> Result<String, String> {
    if target_tokens == 0 {
        return Err("Target token count must be greater than 0".to_string());
    }

    let bpe = cl100k_base().map_err(|e| format!("Failed to load tokenizer: {e}"))?;

    let mut text = String::new();
    let mut tokens = bpe.encode_with_special_tokens(&text);
    while (tokens.len() as u32) < target_tokens {
        text.push_str(FILLER_TEXT);
        tokens = bpe.encode_with_special_tokens(&text);
    }

    tokens.truncate(target_tokens as usize);
    bpe.decode(&tokens)
        .map_err(|e| format!("Failed to decode synthetic prompt: {e}"))
}

#[tauri::command]
pub fn generate_synthetic_prompt_cmd(target_tokens: u32) -> Result<String, String> {
    generate_synthetic_prompt(target_tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_synthetic_prompt_zero_is_error() {
        assert!(generate_synthetic_prompt(0).is_err());
    }

    #[test]
    fn test_generate_synthetic_prompt_matches_target_token_count() {
        let bpe = cl100k_base().unwrap();
        for target in [1u32, 10, 50, 500] {
            let prompt = generate_synthetic_prompt(target).unwrap();
            let actual = bpe.encode_with_special_tokens(&prompt).len() as u32;
            assert_eq!(actual, target, "target={target} produced {actual} tokens");
        }
    }

    #[test]
    fn test_generate_synthetic_prompt_is_valid_utf8_text() {
        let prompt = generate_synthetic_prompt(200).unwrap();
        assert!(!prompt.is_empty());
        // 纯 ASCII 填充素材，任意 token 边界截断后解码出来的都应该是合法字符串
        // （这里主要是确认没有 panic / 解码报错，内容本身不需要"有意义"）。
        assert!(prompt.is_ascii() || prompt.chars().count() > 0);
    }

    #[test]
    fn test_generate_synthetic_prompt_grows_with_more_filler() {
        let short = generate_synthetic_prompt(5).unwrap();
        let long = generate_synthetic_prompt(300).unwrap();
        assert!(long.len() > short.len());
    }
}
