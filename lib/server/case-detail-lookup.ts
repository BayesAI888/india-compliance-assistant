/**
 * 追问案例模板外细节的"现查现答"（用户明确要求要这个模式，2026-09-11）。
 *
 * 场景：用户对已展示的某个案例继续追问九字段模板里没有的细节（"涉案金额是多少"
 * 这类）。本地案例库和实时兜底命中的都是结构化摘要，没存判决书全文，答不出这类问题。
 * 这里现查：拿案例的docid实时下载判决书全文（Indian Kanoon Document API，约₹0.20/次），
 * 让模型只依据这段原文回答，然后核验模型给的支持原句是不是真的出现在原文里——
 * 核验不过就不展示具体内容，逻辑和 quote-check.ts 给法规要求做原句核验同一个原则：
 * "现查现答"不能变成绕开这条纪律的后门。
 *
 * 真实的风险来自本项目自己巡检时搜到的案例：小米一案同时存在至少三个不同金额
 * （海关通知里的 ₹653 crore、CESTAT裁定里约 $72 million/₹600 crore、
 * FEMA相关的 ₹5,551 crore 资产冻结）——模型现查原文时完全可能挑错场次、
 * 张冠李戴地把一个数字安在另一件事上，看起来有依据、实际是错的。
 * 原句核验能抓住这种错误：如果模型编的原句在原文里根本找不到（或者找到的
 * 是原文里讲另一件事的句子而不是它声称支持的那句话），核验就会失败。
 * 但核验只能保证"这句话确实来自这份判决书原文"，不能保证模型对原文的
 * 阅读理解本身完全正确——这是现查现答相对于知识库主流程（有quote-check
 * 加上题目相关性校验双重把关）仍然更弱的一环，请用户注意“已核验”不等于
 * “绝对正确”，只是比完全不核验安全得多。
 *
 * 开关：CASE_DETAIL_LOOKUP=off 关闭；未配置服务器自己的 INDIANKANOON_API_TOKEN
 * 时自动视为关闭（和 case-search.ts 的 isCaseLiveFallbackEnabled 同一个token，
 * 同一份"服务器自己花钱调用"的说明，见 .env.example）。
 */
import type { AnswerResponse, CaseDetailAnswer } from "../contracts";
import { requestStructuredJson } from "./deepseek";
import { longestMatchLength, normalizeForQuoteMatch } from "./quote-check";
import type { PriorCaseRef } from "./case-relevance";

const IK_BASE = (process.env.INDIANKANOON_API_BASE?.trim() || "https://api.indiankanoon.org").replace(/\/$/, "");
/** 判决书全文可能很长，截断喂给模型，避免把整份问答的上下文额度全占掉。 */
const MAX_DOC_CHARS = Number(process.env.CASE_DETAIL_MAX_CHARS?.trim()) || 40000;

/** 和 quote-check.ts 用同一套门槛，不为这条新链路另起一套标准。 */
const MIN_QUOTE_LENGTH = 25;
const MIN_ANCHOR_CHARS = 40;
const MIN_MATCH_RATIO = 0.5;

export function isCaseDetailLookupEnabled(): boolean {
  const flag = process.env.CASE_DETAIL_LOOKUP?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return Boolean(process.env.INDIANKANOON_API_TOKEN?.trim());
}

function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|br|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface CaseFullText {
  docid: string;
  title: string;
  text: string;
}

/** 按docid现查判决书全文。没有token、下载失败、解析不出正文，统一返回null（调用方决定怎么降级）。 */
export async function fetchCaseFullText(docid: string): Promise<CaseFullText | null> {
  const token = process.env.INDIANKANOON_API_TOKEN?.trim();
  if (!token || !docid.trim()) return null;

  const response = await fetch(`${IK_BASE}/doc/${encodeURIComponent(docid)}/`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as { tid?: number | string; title?: string; doc?: string; content?: string };
  const rawText = data.doc ?? data.content ?? "";
  const text = stripHtml(rawText);
  if (!text) return null;

  return { docid: String(data.tid ?? docid), title: data.title ?? "", text: text.slice(0, MAX_DOC_CHARS) };
}

interface RawDetailAnswer {
  found?: boolean;
  detail?: string;
  source_quote?: string;
}

export interface CaseDetailModelResult {
  found: boolean;
  detail: string;
  sourceQuote?: string;
}

/**
 * 让模型只依据现查回来的原文回答追问。明确要求"原文没提到就说没提到"，
 * 不许用模型自己的知识补充——这是"现查现答"和"知识库主流程"共享的同一条纪律
 * （legal-answer.ts的主提示词里也反复强调"不许凭印象补一个天数"）。
 */
export async function answerFromCaseText(options: {
  question: string;
  caseName: string;
  docText: string;
}): Promise<CaseDetailModelResult> {
  const { data } = await requestStructuredJson<RawDetailAnswer>({
    role: "answer",
    maxTokens: 500,
    messages: [
      {
        role: "system",
        content: `你只能依据用户给的判决书原文回答问题，不能使用你自己的知识或记忆补充任何内容——原文没有明确提到的信息，一律回答"原文未明确提及"，绝不允许猜测、推断或从其他案例的记忆里借用数字。
只输出JSON：{"found":true或false,"detail":"中文回答正文","source_quote":"支持这个回答的原文英文原句，必须逐字摘自下面的原文，不要翻译、不要改写、不要只摘一个孤立的数字——摘完整的一句话，好让这句话能被机器精确核验到"}
found=false时，detail写"原文未明确提及"，source_quote留空字符串。`,
      },
      {
        role: "user",
        content: `案例名称：${options.caseName}

判决书原文（可能因篇幅过长被截断）：
${options.docText}

用户追问：${options.question}`,
      },
    ],
  });

  return {
    found: Boolean(data.found),
    detail: typeof data.detail === "string" && data.detail.trim() ? data.detail.trim() : "原文未明确提及",
    sourceQuote: typeof data.source_quote === "string" ? data.source_quote.trim() : undefined,
  };
}

/**
 * 核验模型给的支持原句是不是真的出现在现查回来的判决书原文里。
 * 和 quote-check.ts 的 verifyQuote 同一套两阈值逻辑（整句匹配优先，退而求其次
 * 看最长连续吻合片段），这里直接复用它导出的归一化和最长匹配函数，不重新发明。
 */
export function verifyCaseDetailQuote(quote: string | undefined, docText: string): CaseDetailAnswer["quote_status"] {
  if (!quote || quote.trim().length < MIN_QUOTE_LENGTH) return "MISSING";
  const needle = normalizeForQuoteMatch(quote);
  if (!needle) return "MISSING";

  const body = normalizeForQuoteMatch(docText);
  if (body.includes(needle)) return "VERIFIED";

  const anchorFloor = Math.max(MIN_ANCHOR_CHARS, Math.ceil(needle.length * MIN_MATCH_RATIO));
  return longestMatchLength(needle, body) >= anchorFloor ? "VERIFIED" : "NOT_FOUND";
}

/**
 * 整条现查现答链路的入口：下载原文 → 让模型只依据原文作答 → 核验原句。
 * 任何一步失败（下载失败、模型调用失败）都往外抛异常，由 route.ts 兜底
 * 落回正常的知识库问答流程——这个函数本身不做静默降级，因为它一旦被调用，
 * 就是route.ts已经确定"这轮不走知识库主流程"了，失败了要让调用方知道、
 * 而不是自己吞掉返回一个看似正常的空结果。
 */
export async function buildCaseDetailResponse(options: {
  requestId: string;
  conversationId: string;
  question: string;
  targetCase: PriorCaseRef;
}): Promise<AnswerResponse> {
  const doc = await fetchCaseFullText(options.targetCase.docid);
  if (!doc) {
    throw new Error(`案例原文现查失败：docid=${options.targetCase.docid}（未配置token、下载失败，或解析不出正文）`);
  }

  const result = await answerFromCaseText({
    question: options.question,
    caseName: options.targetCase.caseName,
    docText: doc.text,
  });

  const quoteStatus: CaseDetailAnswer["quote_status"] = result.found
    ? verifyCaseDetailQuote(result.sourceQuote, doc.text)
    : "MISSING";
  const verified = quoteStatus === "VERIFIED";

  const detail = !result.found
    ? "已现查判决书原文，但原文中未明确提及这项细节。"
    : verified
      ? result.detail
      : "AI从判决书原文里找到了看似相关的内容，但没能精确核验这句话是否真的出自原文，为避免误导本次不展示具体细节——建议点击下方链接直接查看原文核对。";

  const chargeEligible = result.found && verified;

  const caseDetailAnswer: CaseDetailAnswer = {
    docid: doc.docid,
    caseName: options.targetCase.caseName,
    official_url: options.targetCase.officialUrl,
    found: result.found,
    detail,
    source_quote: verified ? result.sourceQuote : undefined,
    quote_status: quoteStatus,
  };

  return {
    request_id: options.requestId,
    conversation_id: options.conversationId,
    answer_status: chargeEligible ? "SUFFICIENT" : "UNABLE_TO_CONFIRM",
    failure_code: chargeEligible ? undefined : "INSUFFICIENT_EVIDENCE",
    short_conclusion: `已现查《${options.targetCase.caseName}》判决书原文回答你的追问。`,
    key_figures: [],
    assumptions: [],
    action_steps: [],
    risks_and_exceptions: chargeEligible
      ? []
      : ["这是针对已展示案例的现查现答，和主回答对法规证据的核验方式不同，建议点击案例原文链接自行核对。"],
    citations: [],
    missing_information: [],
    charge_eligible: chargeEligible,
    case_detail_answer: caseDetailAnswer,
    policy_version: "1.4",
  };
}
