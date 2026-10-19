/**
 * 判例检索的**语言闸门**与**法律术语对应表**。
 *
 * ## 为什么必须有这道闸门
 *
 * Indian Kanoon 的库里**只有英文**。往它的 `formInput` 里塞中文，不会报错，
 * 只会返回空——然后用户看到的是"没有找到相关判例"，而真相是我们压根没查。
 * 静默失败最难发现，所以这里要挡在边界上，而不是指望上游每次都传对。
 *
 * 现实的漏洞（2026-09-20 查出来的）：`retrieval.ts` 里
 *
 *     english_query: englishQuery || glossary.searchTerms.join(" ") || question
 *                                                                     ^^^^^^^^
 *
 * 最后一档兜底是**中文原问题**。这个兜底对本地知识库检索是对的（中文原文确实
 * 还能匹配上中文chunk），但顺着同一个字段流到 Indian Kanoon 就成了灾难。
 * 所以不改 `retrieval.ts`（改了会削弱本地召回），改成**在调 Indian Kanoon 之前拦一道**。
 *
 * ## 为什么要术语表，不能只靠翻译
 *
 * 用户问"代持"，直译是 "nominee shareholding" / "holding on behalf"。
 * 但印度法上这件事的**专有名词是 benami**（Benami Transactions (Prohibition) Act, 1988），
 * 判决书里写的是 benami / benamidar。拿直译去搜，一条正经案子都搜不到。
 *
 * 这类"不是翻译、是术语对应"的词在印度税务合规里非常密集：
 * 广告费争议 → AMP expenses、技术服务费 → FTS、虚开发票 → bogus purchases……
 * **模型直译一次就废一次检索**，所以这份表是手工维护的确定性映射，优先级高于模型。
 *
 * ## 和 V1.5 检索词典（xlsx）的分工
 *
 * 那份词典是给**法条检索**用的（中文问题 → 英文法条关键词），167 条，
 * 里面没有 benami、没有代持——因为法条检索不需要判例的术语。
 * 这份表是**判例检索专用**，两者会有重叠但目的不同，不合并：
 * 合并会让运营改一处影响两条链路，出问题时分不清是谁的锅。
 */

/** 含中日韩字符＝不能直接拿去搜 Indian Kanoon。 */
export function containsCJK(value: string): boolean {
  return /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(value);
}

/**
 * 判例检索的中英术语对应表。
 *
 * 左边是**用户可能怎么说**（中文说法、常见别名、以及英文俗称），
 * 右边是**印度判决书里真正用的词**，按检索价值排序，第一个是最特异的那个。
 *
 * 维护规矩：右边的词必须能在 Indian Kanoon 的判决书正文里逐字找到。
 * 不确定的不要往里加——加错了比没有更糟，因为它会盖过模型给的（本来可能是对的）译法。
 */
export const CASE_TERM_GLOSSARY: Array<{ zh: string[]; en: string[] }> = [
  // —— 股权与持股 ——
  { zh: ["代持", "名义持股", "挂名股东", "隐名股东", "benami", "nominee持股"],
    en: ["benami", "benamidar", "Benami Transactions Prohibition"] },
  { zh: ["受益所有人", "实际受益人", "beneficial owner"],
    en: ["beneficial ownership", "beneficial owner"] },
  { zh: ["股权转让", "转让股份", "股份转让"],
    en: ["transfer of shares", "capital gains on transfer of shares"] },
  { zh: ["间接转让", "离岸间接转让"],
    en: ["indirect transfer", "substantially derives its value"] },

  // —— 转让定价 ——
  { zh: ["转让定价", "TP调整", "独立交易原则"],
    en: ["transfer pricing", "arm's length price", "arms length price"] },
  { zh: ["广告费", "市场推广费", "AMP", "广宣费"],
    en: ["AMP expenses", "advertisement marketing and promotion", "bright line test"] },
  { zh: ["可比性分析", "可比公司"],
    en: ["comparability analysis", "comparable uncontrolled price"] },
  { zh: ["成本分摊", "集团服务费", "管理服务费"],
    en: ["cost contribution", "intra group services", "management fee"] },

  // —— 跨境所得 ——
  { zh: ["常设机构", "PE认定", "固定营业场所"],
    en: ["permanent establishment", "fixed place of business", "dependent agent"] },
  { zh: ["特许权使用费", "权利金"],
    en: ["royalty", "royalty income"] },
  { zh: ["技术服务费", "FTS", "技术服务报酬"],
    en: ["fees for technical services", "fees for included services"] },
  { zh: ["预提税", "扣缴", "TDS", "源泉扣缴"],
    en: ["tax deducted at source", "withholding tax"] },
  { zh: ["税收协定", "DTAA", "协定待遇"],
    en: ["Double Taxation Avoidance Agreement", "treaty benefit"] },
  { zh: ["税收居民身份", "居民证明", "TRC"],
    en: ["Tax Residency Certificate", "residential status"] },

  // —— 反避税 ——
  { zh: ["反避税", "一般反避税", "GAAR"],
    en: ["General Anti-Avoidance Rule", "impermissible avoidance arrangement"] },
  { zh: ["资本弱化", "利息扣除限制"],
    en: ["thin capitalisation", "limitation on interest deduction"] },
  { zh: ["导管公司", "壳公司", "空壳"],
    en: ["conduit company", "shell company", "substance over form"] },

  // —— GST ——
  { zh: ["进项抵扣", "进项税额", "ITC", "抵扣链条"],
    en: ["input tax credit", "availment of input tax credit"] },
  { zh: ["虚开发票", "虚假发票", "无货虚开"],
    en: ["bogus purchases", "fake invoices", "fraudulent availment"] },
  { zh: ["扣押货物", "货物被扣", "查扣"],
    en: ["detention of goods", "seizure of goods", "confiscation"] },
  { zh: ["电子运单", "e-way bill", "运单"],
    en: ["e-way bill", "expiry of e-way bill"] },
  { zh: ["供应地", "供应地点", "place of supply"],
    en: ["place of supply", "intra-State supply"] },
  { zh: ["退税", "出口退税", "退还"],
    en: ["refund of unutilised input tax credit", "inverted duty structure"] },

  // —— 海关 ——
  { zh: ["完税价格", "海关估价", "成交价格"],
    en: ["transaction value", "customs valuation", "valuation of imported goods"] },
  { zh: ["归类", "税则归类", "HS归类"],
    en: ["classification of goods", "tariff classification"] },
  { zh: ["原产地", "原产地证"],
    en: ["rules of origin", "certificate of origin"] },
  { zh: ["反倾销", "反倾销税"],
    en: ["anti-dumping duty"] },
  { zh: ["关联方交易价格", "SVB", "特别估价"],
    en: ["Special Valuation Branch", "related party import"] },

  // —— 程序与处罚 ——
  { zh: ["稽查", "税务稽查", "评税", "重新评税"],
    en: ["reassessment", "scrutiny assessment", "best judgment assessment"] },
  { zh: ["处罚", "罚款", "罚则"],
    en: ["penalty", "levy of penalty"] },
  { zh: ["上诉", "申诉", "复议"],
    en: ["appeal", "appellate tribunal"] },
  { zh: ["预先裁定", "事先裁定"],
    en: ["advance ruling"] },
  { zh: ["冻结账户", "银行账户冻结"],
    en: ["provisional attachment", "attachment of bank account"] },

  // —— FEMA / 外汇 ——
  { zh: ["外汇违规", "FEMA违规", "外汇管制"],
    en: ["contravention of FEMA", "Foreign Exchange Management Act"] },
  { zh: ["定价指引", "估值证书"],
    en: ["pricing guidelines", "valuation certificate"] },
  { zh: ["下游投资", "间接外资"],
    en: ["downstream investment", "indirect foreign investment"] },
];

/** 把术语表拍平成「触发词 → 英文检索词」的查找结构，只建一次。 */
const TRIGGER_INDEX: Array<{ trigger: string; en: string[] }> = CASE_TERM_GLOSSARY
  .flatMap((entry) => entry.zh.map((zh) => ({ trigger: zh.toLowerCase(), en: entry.en })));

/**
 * 命中术语表的全部英文检索词（按表内顺序，最特异的在前）。
 *
 * 中文触发词用 `includes` 匹配——中文没有词边界，`includes` 就是正确做法。
 * 英文触发词要按词边界匹配，否则 "PE" 会在一大堆单词里乱命中。
 */
export function matchCaseTerms(question: string): string[] {
  const lower = question.toLowerCase();
  const hits: string[] = [];
  for (const { trigger, en } of TRIGGER_INDEX) {
    const isAscii = !containsCJK(trigger);
    const matched = isAscii
      ? new RegExp(`(^|[^a-z0-9])${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(lower)
      : lower.includes(trigger);
    if (matched) hits.push(...en);
  }
  return [...new Set(hits)];
}

export interface EnglishCaseQuery {
  /** 直接可以发给 Indian Kanoon 的检索式。 */
  formInput: string;
  /** 来源：术语表命中 / 模型给的英文 / 问题本身就是英文。 */
  source: "glossary" | "model" | "already-english";
  /** 术语表命中的词，用于向用户说明"我们是按哪个印度法律术语去查的"。 */
  matchedTerms: string[];
}

/**
 * 把用户问题转成能发给 Indian Kanoon 的英文检索式。
 *
 * 优先级（顺序有意义）：
 *   1. **术语表命中** —— 最高优先级。代持→benami 这类对应关系，模型给的直译比不上。
 *   2. **模型给的 english_query** —— 但必须通过纯 ASCII 检查，中文一律不要。
 *   3. **问题本身就是英文** —— 用户直接用英文问的情况。
 *
 * 三条都不成立时返回 **undefined，表示"不要去搜"**。
 * 这一点是刻意的：拿中文去搜只会静默拿到空结果，还白花 ₹0.50；
 * 明确返回"查不了"，调用方才能如实告诉用户"这个主题我们没能去判例库查"。
 */
export function toEnglishCaseQuery(
  question: string,
  modelEnglishQuery?: string,
): EnglishCaseQuery | undefined {
  const matchedTerms = matchCaseTerms(question);
  if (matchedTerms.length > 0) {
    // 多个术语用 ORR 连接（Indian Kanoon 的或操作符，前后必须留空格）。
    // 短语加引号，否则 "input tax credit" 会被拆成三个词的 AND。
    const formInput = matchedTerms.slice(0, 4).map((t) => `"${t}"`).join(" ORR ");
    return { formInput, source: "glossary", matchedTerms };
  }

  const fromModel = modelEnglishQuery?.trim();
  if (fromModel && !containsCJK(fromModel)) {
    return { formInput: fromModel, source: "model", matchedTerms: [] };
  }

  const cleaned = question.trim();
  if (cleaned && !containsCJK(cleaned) && /[a-z]{3,}/i.test(cleaned)) {
    return { formInput: cleaned, source: "already-english", matchedTerms: [] };
  }

  return undefined;
}

/**
 * 发给 Indian Kanoon 之前的最后一道确定性检查。
 *
 * 就算上面的逻辑都对，这里也要再挡一次——`searchLiveCases` 是个导出函数，
 * 将来可能有新的调用方直接传进来。**边界上的检查不能省**，
 * 这和 `quote-check` / `claim-check` 那几道是同一个道理：
 * 不指望每个调用方都记得规矩。
 */
export function isSearchableByIndianKanoon(formInput: string): boolean {
  const value = formInput.trim();
  if (!value) return false;
  if (containsCJK(value)) return false;
  // 纯符号、纯数字的检索式没有意义，也挡掉。
  return /[a-z]{2,}/i.test(value);
}
