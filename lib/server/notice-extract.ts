/**
 * Notice上传解析：把用户上传的Notice文件变成"机关/编号/期间/金额/送达日期/
 * 回复截止日/指控"这几项事实，供问答链路使用。
 *
 * 按《AI检索与回答规范 V1.4》§5.1：用户上传Notice后，先提取机关、编号、期间、
 * 金额（仅作事实）、截止日和指控；金额不作为需要确认条件的固定阈值。
 *
 * 支持的格式：PDF（pdf-parse）、DOCX（mammoth）、旧版.doc（word-extractor）、
 * 纯文本、图片（jpg/png等，走腾讯云OCR「通用印刷体识别」——仅当配置了
 * TENCENTCLOUD_SECRET_ID/TENCENTCLOUD_SECRET_KEY 时才启用，没配置时明确告知
 * "暂不支持"而不是装作处理了，见 isImageOcrConfigured()）。
 *
 * 诚实说明——这份文件是2026-09-15应用户要求现开发的，2026-09-15追加了.doc和
 * 图片OCR支持，有以下几点尚未验证：
 * 1. pdf-parse/mammoth/word-extractor这三个依赖，我在自己的沙盒环境里没能跑
 *    `pnpm install`实测（环境的目录权限限制导致pnpm没法完成依赖树的重新链接，
 *    属于这台机器的限制，不是代码问题）——接口是按官方文档/类型定义写的，类型
 *    检查过了，但真实的PDF/DOCX/.doc解析行为你需要在自己电脑上`pnpm install`
 *    之后实测一次。跑不通就把报错发我。
 * 2. 腾讯云OCR这条链路我完全没有真实账号可以测——接口调用方式是照着腾讯云官方
 *    SDK的类型定义（GeneralBasicOCR，ImageBase64入参，TextDetections/DetectedText
 *    出参）写的，没有真实密钥、没有真实图片跑过一次。而且OCR本身的识别准确率
 *    是"尽力而为"，不是100%——图片越模糊、倾斜、反光，识别出的文字（尤其是数字）
 *    越可能出错。amount/servedDate/replyDeadline这三个字段仍然会过
 *    verifyDigitsAgainstSource() 的数字核验，但核验只能挡"模型编造的数字"，
 *    挡不住"OCR本身就认错的数字"——如果OCR把"50000"识别成"5000"，这两个数字
 *    都在合理范围内，核验会放行。图片这条路径建议只在文字版文档确实拿不到时
 *    才用，能传PDF/Word就优先传PDF/Word。
 */
import type { NoticeFacts } from "../contracts";
import { requestStructuredJson } from "./deepseek";

/** 内部表示，camelCase；对外走 API 时转成 contracts.ts 里 snake_case 的 NoticeFacts。 */
export interface ExtractedNoticeFacts {
  authority?: string;
  noticeOrFormNumber?: string;
  period?: string;
  amount?: string;
  servedDate?: string;
  replyDeadline?: string;
  allegations: string[];
  /**
   * 这份文件的事由/主题，一句话说明它在讲什么。
   *
   * 真实事故（2026-09-15）：用户上传一份安得拉邦商业税务局关于"全国打击虚假GST
   * 登记专项行动"的通报，追问"税局主要质疑什么"，拿到的是一套泛泛的"收到说明
   * 理由通知怎么办"，跟文件内容完全对不上。原因是七个字段里唯一能承载"这份文件
   * 讲什么"的只有 allegations（指控事项），而这份文件是通报、**根本没有指控**，
   * 于是送进检索和生成的实际只剩"某机关+文号+日期"——两份完全不同的Notice
   * 被压成了几乎一样的输入，答案自然也几乎一样。
   * 主题字段不挑文件类型：通报、核查通知、说明理由通知、催缴单都有"事由"，
   * 它才是驱动检索找对法条的那根线。
   */
  subjectMatter?: string;
}

/** 原文喂给模型前的截断长度，避免特别长的Notice把上下文占满。没有实测调过，是估的初始值。 */
const MAX_NOTICE_CHARS = Number(process.env.NOTICE_MAX_CHARS?.trim()) || 20_000;

export type ExtractTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** 图片OCR上传前的大小上限（字节）。腾讯云通用印刷体识别官方文档写的图片大小限制
 *  是"经Base64编码后不超过7MB"，这里按编码前的原始文件大小留了一点余量估算，
 *  没有拿真实图片实测过，是估的初始值。 */
const MAX_OCR_IMAGE_BYTES = Number(process.env.OCR_MAX_IMAGE_BYTES?.trim()) || 5 * 1024 * 1024;

/** 图片OCR是否已经配置好密钥——没配置时直接告知"暂不支持"，不装作能处理。 */
export function isImageOcrConfigured(): boolean {
  return Boolean(process.env.TENCENTCLOUD_SECRET_ID?.trim() && process.env.TENCENTCLOUD_SECRET_KEY?.trim());
}

/**
 * 调腾讯云OCR「通用印刷体识别」把图片变成文字。这条链路完全没有在我这边用真实
 * 密钥/真实图片测过，见文件头的诚实说明；调用方式按官方SDK类型定义写的。
 * 失败（密钥错、图片太大、腾讯云那边报错）都归到 {ok:false}，不让异常往上抛。
 */
async function recognizeImageText(buffer: Buffer): Promise<ExtractTextResult> {
  if (buffer.byteLength > MAX_OCR_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `图片文件过大（超过${Math.floor(MAX_OCR_IMAGE_BYTES / 1024 / 1024)}MB），`
        + `请压缩后重新上传，或直接把Notice内容粘贴到问题框里。`,
    };
  }
  try {
    const { ocr } = await import("tencentcloud-sdk-nodejs-ocr");
    const client = new ocr.v20181119.Client({
      credential: {
        secretId: process.env.TENCENTCLOUD_SECRET_ID,
        secretKey: process.env.TENCENTCLOUD_SECRET_KEY,
      },
      region: process.env.TENCENTCLOUD_OCR_REGION?.trim() || "ap-guangzhou",
      profile: { httpProfile: { endpoint: "ocr.tencentcloudapi.com" } },
    });
    const result = await client.GeneralBasicOCR({ ImageBase64: buffer.toString("base64") });
    const text = (result.TextDetections ?? [])
      .map((item) => item.DetectedText ?? "")
      .filter((line) => line.trim().length > 0)
      .join("\n")
      .trim();
    return text
      ? { ok: true, text }
      : {
        ok: false,
        reason: "OCR识别成功但没有认出文字——图片可能太模糊、太暗或没有印刷体文字，"
          + "请换一张更清晰的图片，或直接把Notice内容粘贴到问题框里。",
      };
  } catch (error) {
    return { ok: false, reason: `图片文字识别失败：${error instanceof Error ? error.message : "未知错误"}。` };
  }
}

/**
 * 按 mimeType/文件名判断怎么提取文本；不支持的格式给出明确、诚实的提示，
 * 不装作能处理。PDF/DOCX 解析出错（加密文件、文件损坏）也归到这一类失败，
 * 不让异常直接抛出去。
 */
export async function extractTextFromFile(options: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<ExtractTextResult> {
  const { buffer, mimeType, fileName } = options;
  const lowerName = fileName.toLowerCase();

  if (mimeType === "text/plain" || lowerName.endsWith(".txt")) {
    const text = buffer.toString("utf8").trim();
    return text ? { ok: true, text } : { ok: false, reason: "文件内容是空的。" };
  }

  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        const text = (result.text ?? "").trim();
        return text
          ? { ok: true, text }
          : {
            ok: false,
            reason: "PDF解析成功但没有提取到文字——可能是扫描件（图片版PDF），暂不支持自动识别，"
              + "请上传文字版PDF或Word文档，或者把Notice内容直接粘贴到问题框里。",
          };
      } finally {
        await parser.destroy();
      }
    } catch (error) {
      return {
        ok: false,
        reason: `PDF解析失败：${error instanceof Error ? error.message : "未知错误"}，可能是文件损坏或加了密码。`,
      };
    }
  }

  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || lowerName.endsWith(".docx")
  ) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      const text = (result.value ?? "").trim();
      return text ? { ok: true, text } : { ok: false, reason: "文档解析成功但没有提取到文字。" };
    } catch (error) {
      return { ok: false, reason: `Word文档解析失败：${error instanceof Error ? error.message : "未知错误"}。` };
    }
  }

  if (mimeType === "application/msword" || lowerName.endsWith(".doc")) {
    try {
      // word-extractor 是 CJS 包（module.exports = 类本身），动态 import 在不同
      // 打包/解释环境下 default 的挂载方式可能不一致，这里两种形式都兜底，
      // 避免因为 interop 差异直接报错——没能在沙盒里实测，见文件头的诚实说明。
      type ExtractedWordDocument = { getBody?: () => string };
      type WordExtractorConstructor = new () => { extract: (source: Buffer) => Promise<ExtractedWordDocument> };
      const mod = await import("word-extractor");
      const WordExtractorCtor = (mod.default ?? mod) as unknown as WordExtractorConstructor;
      const extractor = new WordExtractorCtor();
      const doc = await extractor.extract(buffer);
      const text = (doc.getBody?.() ?? "").trim();
      return text ? { ok: true, text } : { ok: false, reason: "文档解析成功但没有提取到文字。" };
    } catch (error) {
      return {
        ok: false,
        reason: `.doc文档解析失败：${error instanceof Error ? error.message : "未知错误"}，可能是文件损坏，`
          + `或转存为.docx/PDF后重新上传。`,
      };
    }
  }

  if (mimeType.startsWith("image/")) {
    if (!isImageOcrConfigured()) {
      return {
        ok: false,
        reason: "图片格式暂不支持自动识别（还没配置OCR服务的密钥），请上传文字版PDF/Word文档，或者把Notice内容直接粘贴到问题框里。",
      };
    }
    return recognizeImageText(buffer);
  }

  return { ok: false, reason: `不支持的文件格式：${mimeType || fileName}。目前支持PDF、DOCX、.doc、纯文本，以及图片（需已配置OCR）。` };
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 数字类字段（日期、金额）的核验：不要求整句逐字匹配（模型可能把原文的
 * "15-03-2026"规范化成"2026年3月15日"），只要求数字部分能在原文的数字序列里
 * 连续找到——防止模型直接编造一个原文完全没出现过的日期或金额。
 *
 * 送达日期和回复截止日之所以要比机关名称、指控内容这类描述性字段多这一道核验：
 * 这两个字段后续会被当成"必须遵守的法定期限"使用，写错一个日期，用户可能真的
 * 错过期限——这个风险等级和 quote-check.ts 要核验的"条文原句"是同一类，
 * 描述性字段（机关、指控）读错了顶多要用户自己核对一遍，没有这么直接的后果。
 */
function verifyDigitsAgainstSource(value: string | undefined, sourceText: string): string | undefined {
  const trimmed = nonEmpty(value);
  if (!trimmed) return undefined;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 4) return undefined; // 数字太短，不足以证明"确实来自原文"而不是巧合
  const sourceDigits = sourceText.replace(/\D/g, "");
  return sourceDigits.includes(digits) ? trimmed : undefined;
}

interface RawNoticeFacts {
  authority?: string;
  notice_or_form_number?: string;
  period?: string;
  amount?: string;
  served_date?: string;
  reply_deadline?: string;
  allegations?: string[];
  subject_matter?: string;
}

/** 原文节选送进回答生成时的截断长度。比 MAX_NOTICE_CHARS 小一截：
 *  提取事实可以多喂一点，但节选是要跟证据一起进生成提示词的，占太多会挤掉证据。 */
const MAX_NOTICE_EXCERPT_CHARS = Number(process.env.NOTICE_EXCERPT_CHARS?.trim()) || 3_000;

/**
 * 把OCR/解析出的原文裁成一段可以放进回答生成提示词的节选。
 * 纯函数，方便单测；截断时明确标注被截断了，不让模型以为看到的是全文。
 */
export function buildNoticeExcerpt(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= MAX_NOTICE_EXCERPT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_NOTICE_EXCERPT_CHARS)}\n……（原文过长，此处截断，后面还有内容）`;
}

/**
 * 让模型从Notice原文里提取事实，不做法律判断、不做建议——这一步纯粹是信息抽取。
 * 原文没写的字段留空，核验不过的数字类字段（送达日期/回复截止日/金额）会被丢弃，
 * 让用户自己从原文确认，而不是展示一个没核实过的数字。
 */
export async function extractNoticeFacts(text: string): Promise<ExtractedNoticeFacts> {
  const truncated = text.slice(0, MAX_NOTICE_CHARS);
  const { data } = await requestStructuredJson<RawNoticeFacts>({
    role: "answer",
    maxTokens: 600,
    messages: [
      {
        role: "system",
        content: `你在从一份印度税务/监管文件原文里提取事实，不做任何法律判断或建议。
只输出JSON：{"authority":"发出机关","notice_or_form_number":"Notice/Form/Section编号","period":"涉及的税期/交易期间","amount":"涉及金额（原样保留币种和数字写法，不做换算）","served_date":"送达日期","reply_deadline":"要求回复的截止日期","allegations":["指控或要求事项，一条一个"],"subject_matter":"这份文件的事由/主题，一到两句话说明它在讲什么"}
规则：
1. 只提取原文里明确写出来的内容，原文没写的字段留空字符串（allegations留空数组）。
2. 不要推断、不要猜测、不要用你自己的知识补充——这是纯粹的信息抽取，不是法律分析。
3. served_date和reply_deadline必须是原文里出现的具体日期，不要自己换算或推算相对日期。
4. amount保留原文的币种符号和数字写法，不做单位换算。
5. ⚠subject_matter **一定要填**，它是这几个字段里唯一说明"这份文件到底在讲什么"的。
   有Sub:/Subject:/事由栏就照抄并补充一句正文主旨；没有就用自己的话概括正文主旨。
   文件不是指控类（比如只是通报某项专项行动、告知核查安排、转发上级指示）时，
   allegations 可以为空，但 subject_matter 不能空——照实写它在通报什么、要求什么。
6. allegations 只填真正针对收件人的指控或要求事项；纯通报性内容不要硬塞进 allegations，
   放在 subject_matter 里即可。`,
      },
      { role: "user", content: `Notice原文（可能因篇幅过长被截断）：\n${truncated}` },
    ],
  });

  return {
    authority: nonEmpty(data.authority),
    noticeOrFormNumber: nonEmpty(data.notice_or_form_number),
    period: nonEmpty(data.period),
    amount: verifyDigitsAgainstSource(data.amount, truncated),
    servedDate: verifyDigitsAgainstSource(data.served_date, truncated),
    replyDeadline: verifyDigitsAgainstSource(data.reply_deadline, truncated),
    allegations: Array.isArray(data.allegations)
      ? data.allegations.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 10)
      : [],
    subjectMatter: nonEmpty(data.subject_matter),
  };
}

/**
 * 这份提取结果里到底有没有可用的信息。
 *
 * 真实事故（2026-09-15）：用户在**全新窗口**里上传了一份新Notice提问，拿到的
 * 回答和十分钟前另一份完全不相关的Notice一模一样。排查下来，"提取成功"这件事
 * 之前判的是"有没有 noticeFacts 这个对象"，而不是"这个对象里有没有内容"——
 * 模型没能从原文里读出任何字段时，照样会返回一个所有字段都为空的对象，附件
 * 状态也照样记成 EXTRACTED。于是：
 *   1. /api/chat 认为"Notice已经读懂了"，跳过了"请补充Notice基本信息"的分支；
 *   2. appendNoticeContext 因为没有字段可拼，原样返回了用户打的那句话；
 *   3. 于是这次提问对系统来说，和"没有上传任何文件、只打了一句泛泛的问题"
 *      完全等价——答案里没有任何来自这份Notice的信息，用户却以为读过了。
 * 判空这件事必须显式做，不能靠"对象存在"来暗示"内容有效"。
 */
export function hasUsableNoticeFacts(facts: ExtractedNoticeFacts): boolean {
  return Boolean(
    facts.authority
    || facts.noticeOrFormNumber
    || facts.period
    || facts.amount
    || facts.servedDate
    || facts.replyDeadline
    || facts.subjectMatter
    || facts.allegations.length > 0,
  );
}

/**
 * 把提取到的 reply_deadline 文本归一化成 YYYY-MM-DD。
 *
 * 印度税务文件的日期写法五花八门：`30/09/2026`（DD/MM/YYYY，最常见）、
 * `2026-09-30`、`30.09.2026`、`30th September, 2026`、`September 30, 2026`。
 * 解析**只认这几种有明确结构的写法**，"within 30 days of service" 这类相对期限
 * 一律返回 null——归一化出一个自己推算的日期比不给出危险得多。
 *
 * 数值日期中 4 位年份在前的按 ISO 解析；4 位年份在后的按**印度惯例 DD/MM**
 * 解析（两位都 ≤12 有歧义时也按 DD/MM——这是印度文件的默认写法）。
 * 纯函数，导出供单测。
 */
export function normalizeReplyDeadline(text: string | undefined): string | null {
  if (!text) return null;
  const raw = text.trim().replace(/\s+/g, " ");
  if (!raw) return null;

  const pad = (value: number) => String(value).padStart(2, "0");
  const build = (year: number, month: number, day: number): string | null => {
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
  };

  // 形态一：纯数字分隔——2026-09-30 / 30/09/2026 / 30.09.2026 / 30-09-2026
  const numeric = raw.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (numeric) {
    const [, a, b, c] = numeric;
    if (a.length === 4) return build(Number(a), Number(b), Number(c)); // ISO：年-月-日
    if (c.length === 4) return build(Number(c), Number(b), Number(a)); // 印度：日/月/年
    return null;
  }

  // 形态二：英文月份名——30th September, 2026 / September 30, 2026 / 30 Sep 2026
  const MONTHS: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  const lower = raw.toLowerCase();
  // 月份按前三个字母匹配（january/jan/sept/september 都能对上）。
  const monthOf = (word: string) => MONTHS[word.slice(0, 3)];
  const dayFirst = lower.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/);
  if (dayFirst) {
    const month = monthOf(dayFirst[2]);
    return month ? build(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
  }
  const monthFirst = lower.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})$/);
  if (monthFirst) {
    const month = monthOf(monthFirst[1]);
    return month ? build(Number(monthFirst[3]), month, Number(monthFirst[2])) : null;
  }

  return null;
}

/**
 * 把内部表示拼成一段中文文字，追加到用户问题后面，给主问答链路当上下文用。
 * 没有任何字段时原样返回问题，不追加空的括号。
 */
export function appendNoticeContext(question: string, facts: ExtractedNoticeFacts): string {
  const lines: string[] = [];
  // 事由放第一行：它是最能决定"该去检索哪些法条"的一项，排在前面也更符合阅读顺序。
  if (facts.subjectMatter) lines.push(`文件事由：${facts.subjectMatter}`);
  if (facts.authority) lines.push(`发出机关：${facts.authority}`);
  if (facts.noticeOrFormNumber) lines.push(`Notice/表格编号：${facts.noticeOrFormNumber}`);
  if (facts.period) lines.push(`涉及期间：${facts.period}`);
  if (facts.amount) lines.push(`涉及金额：${facts.amount}`);
  if (facts.servedDate) lines.push(`送达日期：${facts.servedDate}`);
  if (facts.replyDeadline) lines.push(`要求回复截止日：${facts.replyDeadline}`);
  if (facts.allegations.length > 0) lines.push(`指控/要求事项：${facts.allegations.join("；")}`);
  if (lines.length === 0) return question;
  return `${question}\n\n（用户上传的Notice中已提取到以下事实，供参考：\n${lines.join("\n")}）`;
}

/** camelCase 内部表示 → snake_case 的对外契约（lib/contracts.ts 的 NoticeFacts）。 */
export function toNoticeFactsPayload(facts: ExtractedNoticeFacts): NoticeFacts {
  return {
    authority: facts.authority,
    notice_or_form_number: facts.noticeOrFormNumber,
    period: facts.period,
    amount: facts.amount,
    served_date: facts.servedDate,
    reply_deadline: facts.replyDeadline,
    allegations: facts.allegations,
    subject_matter: facts.subjectMatter,
  };
}
