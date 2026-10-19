type DeepSeekRole = "query" | "answer";

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

interface DeepSeekResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
  model?: string;
  usage?: DeepSeekUsage;
}

export function isDeepSeekConfigured() {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export async function requestStructuredJson<T>(options: {
  role: DeepSeekRole;
  messages: DeepSeekMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<{ data: T; model: string; usage?: DeepSeekUsage }> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured.");

  const baseUrl = (process.env.DEEPSEEK_API_BASE?.trim() || "https://api.deepseek.com").replace(/\/$/, "");
  const primaryModel = options.role === "query"
    ? process.env.DEEPSEEK_QUERY_MODEL?.trim() || "deepseek-v4-flash"
    : process.env.DEEPSEEK_ANSWER_MODEL?.trim() || "deepseek-v4-pro";
  const fallbackModel = process.env.DEEPSEEK_QUERY_MODEL?.trim() || "deepseek-v4-flash";
  // 三次尝试（2026-10-15 事故前是两次）：DeepSeek 过载（503）时两连击经常全部阵亡，
  // 用户看到的是"全站所有问题都回答不了"。加到三次 + 退避（见下面 continue 处），
  // 瞬时抖动几十秒的场景可以无感扛过去。跨度仍在 nginx 60 秒网关窗口内——
  // 503 是快失败（每次约 1 秒），两次退避共 6 秒，留足正常生成的余量。
  const attempts = options.role === "answer"
    ? [primaryModel, fallbackModel, primaryModel]
    : [primaryModel, primaryModel, primaryModel];

  let lastFailure = "DeepSeek returned an empty structured response.";
  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    try {
      const model = attempts[attempt];
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: attempt === 0
            ? options.messages
            : [...options.messages, {
                role: "user",
                content: "上一次请求未完成。请只输出完整、有效的JSON对象。",
              } as DeepSeekMessage],
          response_format: { type: "json_object" },
          max_tokens: options.maxTokens,
          // 检索词/要件拆解这一步用 0：它决定了整条检索链路的输入，
          // 一点随机性就会让同一个问题每次命中不同法条，是"回答不稳定"的主要来源。
          // 回答生成保留极低的 0.1，避免完全贪心解码带来的重复啰嗦。
          temperature: options.role === "query" ? 0 : 0.1,
          thinking: { type: "disabled" },
        }),
        signal: options.signal ?? AbortSignal.timeout(options.role === "answer" ? 60_000 : 35_000),
      });

      if (!response.ok) {
        lastFailure = `DeepSeek request failed with status ${response.status}.`;
        if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(lastFailure);
        // 退避后再重试（2026-10-15 线上事故补）：503 是过载的典型表现，
        // 立即重打几乎必然再吃一个 503——旧代码两次尝试之间零等待，全灭。
        // 递增退避 2s/4s，给对方喘口气；总跨度 ~6s，不超 nginx 60s 窗口。
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2_000));
        continue;
      }

      const payload = (await response.json()) as DeepSeekResponse;
      const choice = payload.choices?.[0];
      const content = choice?.message?.content;
      if (choice?.finish_reason === "length") {
        lastFailure = "DeepSeek structured response was truncated.";
        continue;
      }
      if (!content) continue;

      try {
        return { data: JSON.parse(content) as T, model: payload.model ?? model, usage: payload.usage };
      } catch {
        lastFailure = "DeepSeek returned invalid JSON.";
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : "DeepSeek request failed.";
      if (attempt === attempts.length - 1) break;
    }
  }

  throw new Error(lastFailure);
}
