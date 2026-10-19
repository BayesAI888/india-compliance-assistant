/**
 * 判例检索的"要不要触发"判断（阶段三第一步）。
 *
 * 起因：不是每个问题都该去查判例库——大多数问题问的是"该做什么/该交什么材料"，
 * 案例库里的"税局主张/企业抗辩/裁定结果"跟这类问题基本无关，硬塞进去只会让回答
 * 变得又长又跑题。只有问题本身带有"判例/争议/胜负/复议"这类信号词时，才值得
 * 多跑一次案例检索（本地库优先，本地没有再花钱实时查Indian Kanoon）。
 *
 * 和 layer-relevance.ts 的 DOMAIN_GATES 是同一个风格：纯正则、不调模型、
 * 宁可少触发也不要每个问题都去查判例库（案例检索命中本地库没有额外成本，
 * 但命中不了要实时调用付费API，误触发的代价比"漏判"更值得避免）。
 */

/**
 * 2026-09-18 实测漏判：用户问「目前有哪些海关方面的**官司**」，整条判例检索
 * 一次都没跑——因为词表里只有"判例/案例/案子"这些书面语，**没有"官司"**。
 * 结果答案拿海关法的上诉程序条文顶上，方向完全反了。案例库里其实有 46 条海关类案例。
 *
 * 教训和 `domain-scope.ts` 漏掉"转移定价"是同一个：**词表是人写的，人会按自己的
 * 说话习惯写**。用户说的是"打官司""被起诉""有纠纷"，不是"相关判例"。
 * 所以这次把口语说法一并补齐，而不是只补"官司"这一个词。
 */
const CASE_TRIGGER_PATTERN =
  /判例|案例|案子|案件|官司|诉讼|起诉|应诉|纠纷|争议|仲裁|判过|判决|裁定|裁决|败诉|胜诉|复议|上诉|评估令|先例|税局.{0,4}(主张|挑战|质疑)|法院.{0,4}(判决|判例)|tribunal|ITAT|CESTAT|court\s*ruling|precedent|judg(?:e)?ments?|litigation|case\s*law|\bcases?\b|ruling|appeal|dispute|assessment\s*order|revenue.{0,4}position/i;

/**
 * 判断问题是否值得触发一次判例检索。纯正则匹配。
 */
export function shouldSearchCases(question: string): boolean {
  return CASE_TRIGGER_PATTERN.test(question);
}

/**
 * 问题**本身要的就是判例**，而不是"顺带给几个判例参考"。
 *
 * 和 `shouldSearchCases` 的区别很关键：
 * - "收到评估令怎么办" → 该查判例（有先例可参考），但用户要的是**该怎么做**，
 *   法规要求当主角是对的；
 * - "目前有哪些海关方面的官司" → 用户要的**就是一份判例清单**。
 *   这时候把海关法的上诉程序条文摆在最前面，等于答非所问。
 *
 * 判据是句式而不是关键词：必须是"**求取**判例"的问法——
 * 有哪些 / 有没有 / 找几个 / 列举 / 查一下 + 判例类词。
 * 只是句子里出现"判例"两个字不算（"这条判例我看过了，那报关单怎么填"）。
 *
 * **两种词序都要认**（2026-09-20 补）。原来只写了"求取词在前"那一种：
 *
 *     有哪些代持判例                    ✓ 命中
 *     代持案例有哪些                    ✗ 漏掉
 *     帮我找2026年以前子公司 AMP 费用相关案例  ✗ 曾漏掉
 *
 * 而中文里"…判例有哪些"比"有哪些…判例"还常见；“帮我找 + 长主题 + 案例”
 * 也很常见。漏掉的后果不是报错，
 * 是**静默不触发**——判例不置顶、也不触发按主题现查，用户以为功能不存在。
 * 这个漏洞在线上一直带着，是做公司检索时顺带发现的。
 */
const SEEK = "有哪些|哪些|有没有|有无|找.{0,4}些?|查.{0,4}些?|列举|列出|给.{0,4}几个|搜.{0,4}些?|收录了?哪些";
const CASE_WORD = "判例|案例|案子|案件|官司|诉讼|先例|判决|cases?|judg(?:e)?ments?|rulings?|precedents?|case\\s*law";
const CASE_SEEKING_PATTERN = new RegExp(
  // “找”后常带一整段事实限定（主体、期间、费用类型）；12 个字符会把这类
  // 明确求取判例的问题误判成普通业务提问。60 足以容纳常见限定，又仍以句末和
  // 判例词作边界，不会把下一句话里的“案例”误吸进来。
  `(?:${SEEK})[^。？?]{0,60}(?:${CASE_WORD})|(?:${CASE_WORD})[^。？?]{0,20}(?:${SEEK})`, "i");

/**
 * 英文提问的求取句式。**必须单独一条**，不能硬塞进上面那个中文模板——
 * 英文的语序是 "any X cases" / "are there any judgments on X"，
 * 求取词和案例词之间隔着主题，中间可能是十几个词，套中文那个 0~12 字的窗口对不上。
 *
 * 2026-09-20 实测：英文提问时 `isCaseSeekingQuestion` 全线返回 false，
 * 于是判例不置顶、也不触发按主题现查——**英文用户拿到的是一个功能缺失的版本**，
 * 而且不报错。这比文案没翻译严重得多。
 */
const CASE_SEEKING_EN =
  /\b(?:any|list|find|show|search|are\s+there|is\s+there|which|what(?:'s|\s+are)?|give\s+me)\b[^.?!]{0,60}?\b(?:cases?|judg(?:e)?ments?|rulings?|precedents?|case\s*law|litigation)\b/i;

export function isCaseSeekingQuestion(question: string): boolean {
  return CASE_SEEKING_PATTERN.test(question) || CASE_SEEKING_EN.test(question);
}

/**
 * 追问案例细节现查现答——触发词判断（正则，不调模型）。
 *
 * 这个判断只在 route.ts 已经确认"这是延续上一话题的追问、且上一轮展示过案例"之后
 * 才会用到，所以不需要单独判断"是不是在问案例"（外层已经把范围收窄到"和上一个已
 * 展示的案例有关的追问"），只需要再确认"问的是模板九字段之外的具体细节"——
 * 词汇覆盖得宽一点也没关系，触发后有 case-detail-lookup.ts 的原句核验兜底，
 * 核验不过就不展示具体内容，不会真的把编造的细节递给用户。
 */
const CASE_DETAIL_PATTERN =
  /涉案金额|罚款金额|金额是多少|多少钱|税额|滞纳金|利息是多少|哪一年|什么时候|判决理由|裁定理由|裁判理由|证据是什么|后来怎样|上诉了吗|最终结果|具体情节|详细案情|怎么判的|细节|详情|案情/i;

export function detectCaseDetailFollowUp(question: string): boolean {
  return CASE_DETAIL_PATTERN.test(question);
}

export interface PriorCaseRef {
  docid: string;
  caseName: string;
  officialUrl: string;
}

/**
 * 案例的当事人名称里常见、辨识度低的词——用户口语提到公司时通常不会带上这些后缀
 * （"Xiaomi那个案子"而不是"Xiaomi Technology India Pvt. Ltd.那个案子"），
 * 匹配时要把这些词过滤掉，只留下真正有辨识度的部分（比如"Xiaomi""Vivo"）。
 */
const GENERIC_PARTY_WORDS = new Set([
  "india", "ltd", "limited", "pvt", "private", "technology", "technologies",
  "company", "co", "corporation", "corp", "inc", "international", "mobile",
  "motors", "motor", "electronics", "industries", "group", "communication",
  "communications", "holdings", "systems", "commissioner", "union", "state",
  "income", "customs", "director", "deputy", "assistant", "principal",
]);

/** 取案名"v."/"vs."前面那部分（通常是纳税人/公司名），再挑出有辨识度的词。 */
function distinctivePartyTokens(caseName: string): string[] {
  const party = caseName.split(/\s+v\.?s?\.?\s+/i)[0] ?? caseName;
  return (party.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])
    .filter((token) => !GENERIC_PARTY_WORDS.has(token));
}

/**
 * 追问该现查哪个案例的docid：上一轮只展示了一个案例时直接用它；
 * 展示了多个案例时，必须能在追问文本里匹配到某一个案例当事人名称里有辨识度的词
 * （"Xiaomi""Vivo"这类，过滤掉"India""Pvt""Ltd"这些不同公司名里都会出现的通用词）
 * 才选定，匹配不到、或者同时匹配上多个案例，一律返回undefined——宁可不触发现查现答，
 * 也不要在多个案例里现查错一个、给出一个看似有依据实则张冠李戴的答案。
 */
export function pickCaseForFollowUp(
  priorCases: PriorCaseRef[],
  question: string,
): PriorCaseRef | undefined {
  if (priorCases.length === 0) return undefined;
  if (priorCases.length === 1) return priorCases[0];

  const lowerQuestion = question.toLowerCase();
  const matches = priorCases.filter((item) =>
    distinctivePartyTokens(item.caseName).some((token) => lowerQuestion.includes(token)));
  return matches.length === 1 ? matches[0] : undefined;
}
