/**
 * 回答语言的**确定性判定**与服务端文案的双语目录。
 *
 * ## 为什么不让模型自己决定
 *
 * "用户用什么语言问就用什么语言答"听起来是模型能做的事，但它会：
 * ① 不稳定——同一个问题两次调用可能给出不同语言；
 * ② 管不住服务端注入的文案——风险提示、核验警告、检索口径说明这些
 *    **绕过模型直接拼进答案**，模型怎么想都影响不到它们。
 *
 * 第 ② 条是关键。英文答案正文里混着一句
 * "⚠ 本条标注的条文原句未能在所引用的条文中找到"，比全中文还糟。
 * 所以语言必须是一个**在进入生成之前就确定、并贯穿整条链路的参数**。
 *
 * ## 一个反直觉的事实：英文回答比中文回答更忠实
 *
 * 知识库里的法条正文本来就是英文。中文模式下链路是
 * 「英文原文 → 模型翻译 → 用户读中文」，翻译那一步会丢东西、会译错术语
 * （线上出过 `Authorised Dealer` 被译成"授权经销商银行"，dealer 在外汇语境是交易商）。
 * 英文模式下这一环整个不存在，而且 `quote-check` 的原句核验不用跨语言比对。
 *
 * 所以英文输出不是"降级适配"，在准确性上它是更强的那条路。
 */

export type AnswerLanguage = "zh" | "en";

/**
 * 显式指令：用户明说要哪种语言。**优先级最高**，压过问题本身的语言。
 *
 * 覆盖两个方向——不能只做"中文问题要英文答"，
 * 印度用户用英文问、但希望给中国同事看中文答案的情况同样存在。
 */
const WANT_ENGLISH = /(?:请|麻烦|帮我)?\s*(?:用|以)?\s*英文(?:回答|作答|答复|回复)|(?:answer|reply|respond|write)\s+(?:me\s+)?in\s+english|in\s+english\s*[,，]?\s*please|english\s+(?:answer|reply|please)/i;
const WANT_CHINESE = /(?:请|麻烦|帮我)?\s*(?:用|以)?\s*中文(?:回答|作答|答复|回复)|(?:answer|reply|respond|write)\s+(?:me\s+)?in\s+chinese|in\s+chinese\s*[,，]?\s*please/i;

/**
 * 问题本身的语言：按汉字占比判。
 *
 * 阈值取 10% 而不是 0，是因为**误判方向的代价不对称**：
 * 中国用户问问题时经常夹英文术语（"GST 的 ITC 怎么抵扣"、"PE 认定标准"），
 * 汉字占比可能不高；而印度用户的问题里几乎不会出现汉字。
 * 把中国人的问题判成英文，比把印度人的问题判成中文严重得多——
 * 前者是"看不懂"，后者只是"不够本地化"。所以门槛要**偏向中文**。
 *
 * 分母只数「汉字 + 拉丁字母」，不数数字、标点、空格——
 * 一个全是条号和金额的问题不该因为数字多就被判成英文。
 */
const CJK_RATIO_THRESHOLD = 0.10;

export function detectQuestionLanguage(question: string): AnswerLanguage {
  const cjk = (question.match(/[一-鿿]/g) ?? []).length;
  const latin = (question.match(/[A-Za-z]/g) ?? []).length;
  const meaningful = cjk + latin;
  if (meaningful === 0) return "zh";          // 纯数字/符号，按默认语言走
  return cjk / meaningful >= CJK_RATIO_THRESHOLD ? "zh" : "en";
}

/**
 * 最终判定。
 *
 * `sticky` 是这一轮对话此前已经确定的语言——**追问时不能中途换语言**。
 * 用户第一句用英文问、第二句只打了 "and the deadline?"，那句话汉字占比是 0，
 * 判英文没问题；但反过来第一句中文、第二句 "GST ITC deadline?" 会被判成英文，
 * 答案突然变英文就很怪。所以有 sticky 时，只有**显式指令**能改变它。
 */
export function resolveAnswerLanguage(options: {
  question: string;
  sticky?: AnswerLanguage;
}): AnswerLanguage {
  const { question, sticky } = options;
  if (WANT_ENGLISH.test(question)) return "en";
  if (WANT_CHINESE.test(question)) return "zh";
  if (sticky) return sticky;
  return detectQuestionLanguage(question);
}

/* ------------------------------------------------------------------ *
 * 服务端文案目录
 * ------------------------------------------------------------------ */

/**
 * 会**写进答案正文**的服务端固定文案。
 *
 * 只收录用户可见的那些——管理后台的提示、诊断日志、校验错误不在此列
 * （那些只有你会看到，双语化没有收益，反而增加维护面）。
 *
 * 维护规矩：
 * - 两种语言的**语义必须严格对齐**，尤其是限定语。中文写"本次没有检索到"、
 *   英文不能写成 "there are no such cases"——那是把"检索结果的边界"
 *   偷换成"事实的边界"，是这个项目反复强调的红线。
 * - 新增文案时两种都要写。只写一种会让另一种语言的用户看到 undefined 或中文串。
 *   `answer-language.check` 里有一条测试钉住"两边键完全一致"。
 */
type Msg = { zh: string; en: string };

export const MESSAGES = {
  /** 明确在找判例、却一条都没检索到。措辞必须是"本次没有检索到"，不是"不存在"。 */
  caseSeekingEmpty: {
    zh: "本次没有检索到符合条件的判例。案例库覆盖的是有限样本，实时检索也只取前几条，"
      + "这不代表印度没有这类判例——建议直接在 Indian Kanoon 上按关键词自行检索一次。",
    en: "No matching case law was retrieved this time. Our case library covers a limited sample and "
      + "the live search only takes the top results, so this does not mean no such judgments exist — "
      + "consider searching Indian Kanoon directly by keyword.",
  },
  /** 原句核验没通过（引用可能指错条款）。 */
  quoteNotFound: {
    zh: "有 {n} 条法规要求，其标注的条文原句未能在所引用的证据原文中找到——"
      + "结论本身可能仍然正确，但引用可能指错了条款，请点开角标核对原文后再依赖。",
    en: "{n} statutory requirement(s) cite a source sentence that could not be found in the referenced "
      + "provision. The conclusion may still be correct, but the citation may point to the wrong "
      + "provision — please open the footnote and verify against the original text before relying on it.",
  },
  /** 没附原句，无法核验。 */
  quoteMissing: {
    zh: "有 {n} 条法规要求未附条文原句，无法自动核验其出处是否对应。",
    en: "{n} statutory requirement(s) carry no source sentence, so their provenance could not be verified automatically.",
  },
  /** 表格型条文无法核验（见 quote-check.ts 的 TABLE_MARKER）。 */
  quoteTableUnverifiable: {
    zh: "有 {n} 条法规要求引的是表格型条文（税率表、期限表这类）。这类正文从PDF抽取后列与列交错，"
      + "无法自动核验原句——不代表引用有误，但如果要据此决策，请点开角标看一眼原文表格。",
    en: "{n} statutory requirement(s) cite provisions laid out as tables (rate schedules, time-limit tables). "
      + "Such text comes out of the PDF with its columns interleaved, so the source sentence cannot be "
      + "verified automatically — this does not mean the citation is wrong, but please open the footnote "
      + "and check the original table before relying on it.",
  },
  /** 判例检索：本地空白、已按印度法术语实时检索。 */
  topicSearchedLive: {
    zh: "本地案例库暂无此类判例，已按印度法上的对应术语「{terms}」实时检索 Indian Kanoon。"
      + "以下判例未经人工复核，请点开原文核对。",
    en: "Our case library has no judgments on this topic. We searched Indian Kanoon live using the "
      + "corresponding Indian legal term(s) \"{terms}\". The results below have not been reviewed by a "
      + "human — please open the originals to verify.",
  },
  topicSearchedLivePlain: {
    zh: "本地案例库暂无此类判例，已实时检索 Indian Kanoon。以下判例未经人工复核，请点开原文核对。",
    en: "Our case library has no judgments on this topic; we searched Indian Kanoon live. The results "
      + "below have not been reviewed by a human — please open the originals to verify.",
  },
  /** 公司判例：找到 N 件。 */
  companyFound: {
    zh: "共找到 {n} 件以{company}为当事人的判例",
    en: "Found {n} judgment(s) with {company} as a party",
  },
  companyExcluded: {
    zh: "（另有 {n} 件只是在论证中引用了{company}的案例，已排除）",
    en: " ({n} further judgment(s) merely cited {company} in their reasoning and were excluded)",
  },
  companyTopicApplied: {
    zh: "，已按主题「{terms}」筛选",
    en: ", filtered by topic \"{terms}\"",
  },
  companyTopicUnverified: {
    zh: "，按主题「{terms}」检索所得；但系统未能自动确认主题筛选是否完全生效，请以判例原文为准。",
    en: ", retrieved under topic \"{terms}\"; however the system could not automatically confirm that the "
      + "topic filter took full effect — please rely on the judgments themselves.",
  },
  companyTopicEmpty: {
    zh: "未检索到{company}在「{terms}」这一主题上的判例。",
    en: "No judgment was found with {company} as a party on the topic \"{terms}\".",
  },
  /**
   * 引用的法律有更晚的修订通知。
   *
   * **措辞只能停在"有修订、去核对"**——索引里只有标题，我们没读过正文，
   * 写"税率已改为 X%"就是编造。见 notification-index.ts 开头那条线。
   */
  notificationUpdates: {
    zh: "本回答引用的法律中，有 {n} 部检测到更晚的修订通知：{items}。"
      + "本系统只记录了这些通知的编号与日期、未读取其正文，因此无法判断它们是否影响上述结论——"
      + "落地前请到官方网站核对现行文本。",
    en: "For {n} of the laws cited above, a later amending notification was detected: {items}. "
      + "This system records only the number and date of such notifications and has not read their text, "
      + "so it cannot tell whether they affect the conclusions above — please check the current "
      + "official text before acting.",
  },
  /**
   * 有法规要求只靠 notification / circular 撑着，追不到 Act/Rules。
   *
   * **为什么单独提示 circular**：它是税务机关的行政解释，约束税务官、**不约束法院**。
   * 照着 circular 做，日常查账没问题，但真进入争议程序时它不是依据——
   * 法院推翻 CBIC circular 的案例很多。这个区别用户多半不知道，不说是不负责的。
   */
  unanchoredSteps: {
    zh: "有 {n} 条法规要求，其依据只来自通知（Notification）或通函（Circular），"
      + "没有对应到法律（Act）或规则（Rules）层级：{items}。"
      + "通函属于税务机关的行政解释，约束征管一线、但不当然约束法院——"
      + "作为日常操作口径可用，作为争议中的法律依据需另行确认上位法条文。",
    en: "{n} statutory requirement(s) rest only on a Notification or Circular, with no "
      + "corresponding Act or Rules provision: {items}. Circulars are the tax administration's "
      + "own interpretation — they bind assessing officers but do not bind the courts. "
      + "They are usable as day-to-day practice guidance, but if the point becomes contested "
      + "you will need to identify the underlying Act or Rules provision separately.",
  },
  /** 公司落空后退到主题：必须明说这些不是这家公司的案例。 */
  fellBackToTopic: {
    zh: "以下是其他企业在同一主题上的判例，供参考——它们不是{company}的案例。",
    en: "The judgments below involve other companies on the same topic, provided for reference — "
      + "they are not {company}'s cases.",
  },
} as const satisfies Record<string, Msg>;

export type MessageKey = keyof typeof MESSAGES;

/**
 * 取文案并填占位符。
 *
 * 占位符写成 `{name}`，缺失的占位符**原样保留**而不是替换成空——
 * 界面上出现一个字面的 `{company}` 会被立刻发现并修掉；
 * 悄悄变成空字符串则会生成"共找到 3 件以为当事人的判例"这种读得通但错了的句子。
 * 和整个项目一贯的取舍一致：**宁可显眼地坏，不要安静地错。**
 */
export function t(
  key: MessageKey,
  language: AnswerLanguage,
  vars: Record<string, string | number> = {},
): string {
  const template = MESSAGES[key][language];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole);
}
