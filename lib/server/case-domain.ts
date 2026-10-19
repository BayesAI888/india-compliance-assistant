/**
 * 判例的**法域**判定：这件判例讲的是哪个税／哪部法。
 *
 * ## 为什么需要它
 *
 * 2026-09-22 实测：用户问「印度 income tax（ITD）案件中，保证金计算的基数」，
 * 判例区列出来的三件是——
 *
 *   · Fcc Co. Ltd, Japan vs Dcit —— 讲常设机构（Fixed Place PE）
 *   · Vodafone vs Dcit         —— 讲 80-IA 扣除、license fee 性质、TP 调整
 *   · Ravina vs CBI            —— 一件刑事案件，冻结资产
 *
 * 和"上诉保证金的计算基数"没有任何关系。`法规要求`那一侧已经有法域闸门了
 * （`domain-scope.ts`），判例这条路上**一层都没有**。
 *
 * ## 判定顺序：先读字段，再读案件名
 *
 * **① 「争议税种以及主管税局」字段**是首选。案例库整理时本来就写明了税种，
 * 这是最直接的信息，不用猜。
 *
 * **② 案件名里的税务机关**是补充。印度判例的命名是 `甲 vs 乙`，其中一方通常
 * 就是税务机关，而机关名里带着税种：
 *
 *     Apple India Pvt. Ltd.      vs Commissioner Of **Delhi Vat**
 *     Toyota Kirloskar Motors    vs Commissioner Of **Customs**
 *     Fcc Co. Ltd, Japan         vs **Dcit** (International Taxation)
 *
 * ⚠**必须扫 `vs` 的两边，不能只看被告。** 税局既可能是被告、也可能是原告
 * （税局败诉后上诉，案名就反过来了）。在真实的 119 件案例库里实测：
 *
 *     税局只在原告位（左）：23 件
 *     税局只在被告位（右）：61 件
 *     两边都认不出        ：35 件   ← 只能靠字段①
 *
 * 只看被告会漏掉那 23 件，把它们全判成"认不出"。
 *
 * **③ 企业名（原告）判不了法域**，刻意不用：同一家三星既有转让定价案、
 * 也有海关估价案，公司名说明不了这件案子讲什么。
 *
 * ## 认不出来就放行
 *
 * 返回 `undefined` 表示"判不出"，调用方必须当作**不要据此排除**。
 * 和这个项目里其他所有闸门一样：看不懂时放宽，不在没把握的时候乱删。
 * 那 35 件两边都认不出的案子，全靠字段①兜底；字段①也空的话就一律放行。
 */

/**
 * 机关名／税种关键词 → `law-categories.ts` 的类别 id。
 *
 * 顺序有意义：**从最具体的往最笼统的排**，命中第一条就算数。
 * 比如 "Commissioner of Customs" 里也有 "Commissioner"，
 * 如果所得税的规则排在前面就会把海关案子judge成所得税案。
 */
const DOMAIN_RULES: Array<{ id: string; pattern: RegExp }> = [
  {
    // 海关放最前：CESTAT / Commissioner of Customs 这些里面都带通用的 "Commissioner"。
    id: "trade_customs",
    pattern: /\bcustoms?\b|\bcestat\b|\bdgft\b|海关|关税|完税价格|foreign\s*trade|安全\s*bill\s*of\s*entry|bill\s*of\s*entry/i,
  },
  {
    id: "gst",
    pattern: /\b(?:c|s|i|ut)?gst\b|goods\s*and\s*services\s*tax|货物与服务税|\bgstr\b|service\s*tax|\bcenvat\b|excise/i,
  },
  {
    id: "fema_fdi_rbi",
    pattern: /\bfema\b|foreign\s*exchange\s*management|\brbi\b|reserve\s*bank|enforcement\s*directorate|\bpmla\b|money[-\s]*laundering|外汇/i,
  },
  {
    id: "company_governance",
    pattern: /\bnclt\b|\bnclat\b|\broc\b|registrar\s*of\s*companies|companies\s*act|\bsfio\b|serious\s*fraud|insolvency|\bibc\b|公司法/i,
  },
  {
    // 所得税放最后：它的机关名（Commissioner / Deputy Commissioner）最通用，
    // 前面几类的机关名也长这样，让它们先认领。
    id: "income_tax",
    pattern: /income[-\s]?tax|\bitat\b|\bitd\b|\bcbdt\b|\bdcit\b|\bacit\b|\bpcit\b|\bjcit\b|\baddl\.?\s*cit\b|\bcit\b|\bito\b|\btpo\b|\bdrp\b|\bdtaa\b|所得税|转让定价|transfer\s*pricing/i,
  },
];

export interface CaseDomainInput {
  /** 案件名，形如 `甲 vs 乙`。两边都会扫。 */
  caseName?: string;
  /** 案例库的「争议税种以及主管税局」字段。判定时**优先**用它。 */
  taxTypeAndAuthority?: string;
  /**
   * 实时检索结果没有结构化字段，只有搜索摘录。
   * 当①②都判不出时拿它兜一把——摘录里通常也会出现机关名或法条名。
   */
  snippet?: string;
}

/**
 * 判这件判例属于哪个法域。判不出来返回 `undefined`（调用方应放行）。
 */
export function classifyCaseDomain(input: CaseDomainInput): string | undefined {
  // ① 结构化字段最可信：整理案例时就写明了税种。
  const byField = matchDomain(input.taxTypeAndAuthority);
  if (byField) return byField;

  // ② 案件名。整串一起扫，`vs` 两边都覆盖到——税局可能在任意一边。
  const byName = matchDomain(input.caseName);
  if (byName) return byName;

  // ③ 实时结果的摘录，最后兜一把。
  return matchDomain(input.snippet);
}

function matchDomain(text: string | undefined): string | undefined {
  if (!text || !text.trim()) return undefined;
  for (const rule of DOMAIN_RULES) {
    if (rule.pattern.test(text)) return rule.id;
  }
  return undefined;
}

/**
 * 这件判例该不该出现在这道问题的答案里。
 *
 * 两边任何一边判不出来就放行——误杀一件相关判例的代价，不该由没把握的判断来承担。
 */
export function isCaseOnTopic(
  input: CaseDomainInput,
  questionCategories: string[],
): boolean {
  if (questionCategories.length === 0) return true;
  const domain = classifyCaseDomain(input);
  if (!domain) return true;
  return questionCategories.includes(domain);
}
