/**
 * 对话标题：把一个话题概括成 20 字以内，用于「最近对话」列表。
 *
 * 为什么需要它（2026-09-17 产品决定）：对话的边界改成完全由用户的动作决定——
 * 进入网页、点「新建对话」各开一个新对话，点「最近对话」里的某条则回到那条继续问。
 * 既然列表按**对话**列而不是按问题列，就需要给每个对话一个能一眼认出来的名字；
 * 直接拿第一个问题截断会截出"关于印度公司的广告费，有什么判例吗？怎样才"这种断句。
 *
 * 只在**首问**时生成一次，之后这个对话里再怎么追问都不重新生成——
 * 标题是话题的名字，不是最后一问的名字。
 *
 * 走便宜的那个小模型（role: "query"，和问题改写同一档），失败一律退回确定性截断：
 * 标题生成不了顶多名字难看一点，绝不能让它影响问答本身。
 */
import { isDeepSeekConfigured, requestStructuredJson } from "./deepseek";

export const MAX_TITLE_LENGTH = 20;

/**
 * 确定性兜底：在标点处截断，尽量不把一句话拦腰截断。
 * 导出供单测——模型那条路没法在测试里跑，这条必须能单独验证。
 */
export function truncateTitle(question: string): string {
  const cleaned = question.replace(/\s+/g, " ").trim();
  if (!cleaned) return "新对话";
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned;

  // 在上限之内找最后一个标点，从那里断开，避免"怎样才"这种半截词。
  const head = cleaned.slice(0, MAX_TITLE_LENGTH);
  const lastBreak = Math.max(
    head.lastIndexOf("，"), head.lastIndexOf("。"), head.lastIndexOf("？"),
    head.lastIndexOf("、"), head.lastIndexOf("；"), head.lastIndexOf(","),
  );
  // 太靠前的标点不用（比如第2个字就是逗号），否则标题会短得没有信息量。
  if (lastBreak >= 6) return head.slice(0, lastBreak);
  return head;
}

/** 模型给的标题也要过一遍确定性清洗：去引号、去换行、砍到上限。 */
export function sanitizeTitle(raw: string, fallbackQuestion: string): string {
  const cleaned = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/^["'“”「『]+|["'“”」』]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2) return truncateTitle(fallbackQuestion);
  return cleaned.length > MAX_TITLE_LENGTH ? cleaned.slice(0, MAX_TITLE_LENGTH) : cleaned;
}

interface RawTitle {
  title?: string;
}

/**
 * 生成对话标题。任何一步失败都退回截断，不抛异常。
 */
export async function buildConversationTitle(question: string): Promise<string> {
  if (!isDeepSeekConfigured()) return truncateTitle(question);

  try {
    const { data } = await requestStructuredJson<RawTitle>({
      role: "query",
      maxTokens: 120,
      messages: [
        {
          role: "system",
          content: [
            "把用户的问题概括成一个短标题，用于对话列表。",
            `要求：中文，${MAX_TITLE_LENGTH}字以内，只概括主题不回答问题，`,
            "不要加书名号引号，不要以「关于」开头，不要写成完整句子。",
            '例："在印度设立公司必须有印度人参股吗" → "印度设立公司的外资持股"',
            '只返回JSON：{"title":"标题"}',
          ].join("\n"),
        },
        { role: "user", content: question },
      ],
    });
    return sanitizeTitle(typeof data.title === "string" ? data.title : "", question);
  } catch {
    return truncateTitle(question);
  }
}
