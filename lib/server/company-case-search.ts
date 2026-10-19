/**
 * 按公司名检索判例：用户明确点名"查三星的案例""小米在印度有哪些税务官司"时走这条路。
 *
 * ## 这条链路和 `case-search.ts` 的区别
 *
 * `case-search.ts` 是**问业务问题时的补充**——问"广告费怎么合规"，顺带给几份相关判例，
 * 本地不够才兜底现查一次，成本压得很低。
 *
 * 这里是**用户主动要一家公司的案例全集**，诉求完全不同：要全、要新、要能看出审级链条。
 * 所以它是一次多路召回的重操作（约 ₹13/家），只在用户明确点名公司时触发，
 * 绝不能挂在普通问答的兜底链路上。
 *
 * ## 核心问题：搜 Samsung，会搜出一堆"引用过三星案例"的判决
 *
 * Indian Kanoon 的 `formInput` 是**全文检索**。一份和三星毫无关系的判决，只要在论证里
 * 写了一句"依 Samsung India Electronics 案的原则"，就会被搜出来。用户要的是
 * **三星当事人的案子**，不是**提过三星的案子**。
 *
 * 解法的支点是一个观察：印度判决书标题是固定格式
 *
 *     Samsung India Electronics Pvt. ... vs Deputy Commissioner Of Income ... on 21 July, 2017
 *     └────────── 当事人 A ──────────┘     └────────── 当事人 B ──────────┘
 *
 * **当事人一定在标题里；被引用的先例一定不在标题里**（它在正文的论证段落）。
 * 所以 `title:` 这个检索参数一个就把整类噪音排除了——不用取全文、不用调模型、
 * 比事后过滤便宜得多。
 *
 * ## 三条假设，都做成了可降级
 *
 * 写这个文件时手上没有 API token，以下三条是照官方文档推的，没实测过。
 * 每一条都配了降级路径，推错了功能照常工作，只是精度下降：
 *
 * | 假设 | 推错了会怎样 | 降级到 |
 * |---|---|---|
 * | `formInput=title:Samsung` 是合法语法 | 返回 0 条或和全文检索一样多 | 普通全文检索 + 本地按标题过滤 |
 * | 标题稳定含 `" vs "` | 切不出当事人 | 退到"公司名出现在标题前半段"的宽松判据 |
 * | `docfragment` 片段够判断上下文 | 分类不出引用型 | 只信标题，存疑件一律不入池 |
 *
 * **2026-10-13 修订（两次，最终结论：title: 路径整体废除）**：
 * ① 探针旧版对比"每页返回条数"对高频被告永远误判"不支持" → 改成行为判定；
 * ② 行为判定又被 IK 返回标题里的 `<b>` 高亮标签打崩（matchRate=0，见
 *    `normalizeEntityName` 的注释）——剥掉标签后探针终于判对"可用"，
 *    但组合查询 `title:"X" "AMP expenses"` **实测返回 0 条**，而同样的词换成
 *    全文 `"X" "AMP expenses"` 第 1 条就是三星 AMP 案。即：**IK 不支持 title:
 *    与短语 AND 组合**，title: 单独查也捞不到新案（AMP 案不在其前 20 条）。
 *    所以组合查询和公司全集查询**全部改回全文短语**，当事人识别交给
 *    `verdictFromTitle`（`<b>` 剥离子修复后已能正确判定 PARTY），
 *    `detectTitleSearchSupport` 探针及 title: 分支整体删除（少一次 ₹1 调用，
 *    少一个故障点）。引用型候选由 `verdictFromTitle` 判 CITATION_ONLY 排除。
 *
 * 降级的方向统一是**宁可少收、不可错收**：错收一份"只是提过三星"的判决，
 * 用户会以为那是三星的案子；漏收一份，用户最多觉得不够全。前者的代价高得多。
 */

import type { RelatedCase } from "../contracts";

const IK_BASE = (process.env.INDIANKANOON_API_BASE?.trim() || "https://api.indiankanoon.org")
  .replace(/\/$/, "");

/* ------------------------------------------------------------------ *
 * 一、当事人判定（纯函数，全部可单测）
 * ------------------------------------------------------------------ */

/**
 * 判决书标题切成当事人两侧。
 *
 * 真实标题的分隔符不止一种写法：`vs` / `vs.` / `v.` / `Vs` / `versus`，
 * 前后空格数量也不稳定。尾部的 `on 21 July, 2017` 是 Indian Kanoon 加的日期后缀，
 * 要先剥掉，否则会混进当事人 B。
 *
 * 切不出来时返回 undefined——**不猜**。调用方据此走降级路径，
 * 而不是拿一个瞎切的结果继续判。
 */
export function splitPartiesFromTitle(title: string): { a: string; b: string } | undefined {
  const withoutDate = title.replace(/\s+on\s+\d{1,2}\s+\w+,?\s*\d{4}\s*$/i, "").trim();
  const match = withoutDate.split(/\s+(?:vs?\.?|versus)\s+/i);
  if (match.length < 2) return undefined;
  // 标题里可能出现多个 vs（"A vs B vs C"），取第一个作为分界，其余归入 B 侧。
  const [a, ...rest] = match;
  const b = rest.join(" vs ");
  if (!a.trim() || !b.trim()) return undefined;
  return { a: a.trim(), b: b.trim() };
}

/**
 * 比对用的归一化：小写、去掉标点和公司后缀噪音，只留字母数字和单空格。
 *
 * **先剥 HTML 标签再归一化**（2026-10-13 补，线上事故的直接根因）：
 * Indian Kanoon 的搜索 API 返回的 title 带 `<b>…</b>` 高亮标签，
 * `<b>Samsung</b> <b>India</b> <b>Electronics</b>` 直接归一化会变成
 * "b samsung b b india b b electronics b"——别名的连续匹配**永远失败**。
 * 这个疏漏让两层同时静默失效：
 *   ① `detectTitleSearchSupport` 的行为判定 matchRate=0 → 判"title: 不可用"→ 全局降级；
 *   ② `isPartyMatch` 把真当事人全判 CITATION_ONLY——29 条"仅被引用 0 当事人"的真相。
 * `classifyFragment` 和 L331 此前都手动先剥标签再用本函数，说明剥标签本就是这条
 * 链路的既定动作，只是漏了这两个调用点——现在收进函数根上，一处修全局受益。
 * 顺手解码常见实体（&amp; 等），否则 "&amp;" 会残留成 "amp" 这个假词。
 * （探针连同 title: 分支已整体废除，见文件头 2026-10-13 修订②。）
 */
export function normalizeEntityName(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .toLowerCase()
    .replace(/\b(?:pvt|private|ltd|limited|co|company|corp|corporation|inc|llp|plc)\b\.?/g, " ")
    .replace(/\bm\/s\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * 公司别名是否命中当事人某一侧。
 *
 * 要求**落在 vs 的某一侧**，而不是"标题里出现过"。防的是
 * `X vs Y (following Samsung India)` 这种把先例写进标题的少数写法。
 *
 * 匹配用词边界而不是 `includes`：`includes` 会让 "Sam" 命中 "Samsung"，
 * 也会让 "Tata" 命中 "Tatarpur"——公司名检索里这种误伤很容易发生。
 */
export function isPartyMatch(party: string, aliases: string[]): boolean {
  const normalizedParty = ` ${normalizeEntityName(party)} `;
  return aliases.some((alias) => {
    const normalizedAlias = normalizeEntityName(alias);
    if (!normalizedAlias) return false;
    return normalizedParty.includes(` ${normalizedAlias} `)
      || normalizedParty.startsWith(`${normalizedAlias} `)
      || normalizedParty.endsWith(` ${normalizedAlias}`)
      || normalizedParty.trim() === normalizedAlias;
  });
}

export type PartyVerdict =
  /** 标题的 vs 某一侧命中公司名——当事人案件，入池。 */
  | "PARTY"
  /** 公司名只出现在正文，是被引用的先例——出局。 */
  | "CITATION_ONLY"
  /** 标题切不出当事人、或片段不足以判断——按"宁可少收"处理，不入池但单独列出。 */
  | "UNCERTAIN";

/**
 * 只看标题能得出什么结论。
 *
 * 切得出当事人 → 命中即 PARTY，不命中即 CITATION_ONLY（标题里没有＝不是当事人）。
 * 切不出当事人 → UNCERTAIN，交给下一道 docfragment 验证。
 */
export function verdictFromTitle(title: string, aliases: string[]): PartyVerdict {
  const parties = splitPartiesFromTitle(title);
  if (!parties) return "UNCERTAIN";
  return isPartyMatch(parties.a, aliases) || isPartyMatch(parties.b, aliases)
    ? "PARTY"
    : "CITATION_ONLY";
}

/**
 * 判决书正文里，公司名出现的位置是"当事人"还是"引用先例"。
 *
 * 用 `docfragment` 接口拿到的片段（₹0.05/次，比取全文的 ₹0.20 便宜四倍，这道验证开得起）。
 *
 * 判据是**紧挨着公司名的措辞**——印度判决书引用先例的写法高度套路化：
 *   relied on / reliance on / in the case of / followed / (supra) / distinguished
 * 而当事人的写法是：the assessee / the appellant / the respondent / the petitioner
 *
 * 两类信号同时出现时判 PARTY：一份三星自己的案子里，当然也会引用别的先例，
 * 片段里混进 "relied on" 很正常；反过来，一份纯粹引用三星的判决里
 * 不会出现"Samsung ... the assessee"。**当事人信号更特异，优先级更高。**
 */
const CITATION_CUES = /\b(?:relied|reliance|followed|following|supra|distinguished|cited|referred)\b/i;
const PARTY_CUES = /\b(?:assessee|appellant|respondent|petitioner|applicant)\b/i;

export function classifyFragment(fragment: string, aliases: string[]): PartyVerdict {
  const text = fragment.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const normalized = normalizeEntityName(text);
  const mentioned = aliases.some((alias) => {
    const a = normalizeEntityName(alias);
    return a && normalized.includes(a);
  });
  if (!mentioned) return "UNCERTAIN";
  if (PARTY_CUES.test(text)) return "PARTY";
  if (CITATION_CUES.test(text)) return "CITATION_ONLY";
  return "UNCERTAIN";
}

/* ------------------------------------------------------------------ *
 * 二、排序：相关度 + 审级 + 时效
 * ------------------------------------------------------------------ */

/**
 * 审级权重。同一个争议，最高法院的判例和一个 ITAT 判决不是一个量级——
 * `case-search.ts` 的 `rankLiveDocs` 没有这一项，查公司案例时必须有，
 * 否则一堆 ITAT 判决会把真正定调的高院/最高院判决淹掉。
 *
 * doctypes 取值来自官方文档的清单。CESTAT 在 API 里的代号仍是历史名 `cegat`。
 */
const COURT_TIER: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /supreme\s*court/i, weight: 1.0, label: "最高法院" },
  { pattern: /high\s*court/i, weight: 0.7, label: "高等法院" },
  { pattern: /\b(?:itat|income\s*tax\s*appellate)\b/i, weight: 0.45, label: "ITAT" },
  { pattern: /\b(?:cestat|cegat|customs.*excise.*service\s*tax)\b/i, weight: 0.45, label: "CESTAT" },
  { pattern: /\b(?:aar|authority\s+for\s+advance\s+rulings?)\b/i, weight: 0.35, label: "预先裁定局" },
  { pattern: /tribunal/i, weight: 0.3, label: "其他法庭" },
];

export function courtTier(docsource: string | undefined): { weight: number; label?: string } {
  if (!docsource) return { weight: 0.2 };
  for (const tier of COURT_TIER) {
    if (tier.pattern.test(docsource)) return { weight: tier.weight, label: tier.label };
  }
  return { weight: 0.2 };
}

/** 时效：20 年线性衰减，和 `case-search.ts` 保持同一口径，免得两处标准打架。 */
const RECENCY_WINDOW_YEARS = 20;

export interface CompanyCaseCandidate {
  docid: string;
  title: string;
  docsource?: string;
  year?: number;
  headline?: string;
  verdict: PartyVerdict;
  /** 命中的是哪个法律主体（用于同名消歧分组）。 */
  entity?: string;
}

/**
 * 排序分。权重写死在这里而不是配成环境变量——这几个数是产品判断，
 * 不是运维参数，改它应该走代码评审。
 *
 * ## 当事人确信度用**分层**，不用乘性系数
 *
 * 第一版写的是 `confidence × 质量分`，confidence 取 1 / 0.4 / 0。自测当场抓出问题：
 *
 *     确认当事人的 2012 年 ITAT 判决   → 1   × (0.55×0.45 + 0.45×0.30) = 0.383
 *     存疑的      2025 年 最高院判决   → 0.4 × (0.55×1.00 + 0.45×0.95) = 0.391
 *
 * **存疑件靠审级和时效的加分翻了盘**，排到了确认件前面。0.4 这个系数是拍的，
 * 而"拍一个系数让它大概率压得住"本身就不可靠——换一组数据就又翻过来了。
 *
 * 改成分层：PARTY 起步分 1.0，UNCERTAIN 起步分 0，质量分只在层内比。
 * 这样**一条存疑件永远排在所有确认件之后**，不是"大概率排在后面"。
 * 这和整个项目一贯的做法一致：能确定性保证的，就不要靠调参去逼近。
 */
export function scoreCandidate(
  candidate: CompanyCaseCandidate,
  now = new Date(),
): number {
  if (candidate.verdict === "CITATION_ONLY") return 0;
  const tier = courtTier(candidate.docsource).weight;
  const age = candidate.year === undefined
    ? RECENCY_WINDOW_YEARS
    : Math.max(0, now.getFullYear() - candidate.year);
  const recency = Math.max(0, 1 - age / RECENCY_WINDOW_YEARS);
  const quality = 0.55 * tier + 0.45 * recency;   // 0 ~ 1
  // 层内质量分压到 0~0.99，保证不会因为进位越层。
  return (candidate.verdict === "PARTY" ? 1 : 0) + quality * 0.99;
}

/* ------------------------------------------------------------------ *
 * 三、多路召回的查询构造
 * ------------------------------------------------------------------ */

/**
 * 税务/合规判例的主战场。分开跑而不是一次查全部——
 * 混在一起时某一类会被另一类挤掉（Indian Kanoon 每次只返回有限页数）。
 */
export const CASE_DOCTYPES = ["itat", "cegat", "highcourts", "supremecourt"] as const;

export interface RecallQuery {
  formInput: string;
  fromdate?: string;
  todate?: string;
  /** 这一路是干什么的，出现在诊断日志里。 */
  label: string;
}

/**
 * 构造多路召回的查询集合。
 *
 * 三个维度相乘：别名 × 法院 × 时间段。时间分段是为了"找全"——
 * 不分段时 API 只返回前若干页，老案子会被直接截断，用户看到的"全集"其实是残缺的。
 *
 * 全程全文短语检索（2026-10-13 起，title: 路径已废除，见文件头修订②），
 * 召回的噪音由 `verdictFromTitle` 在本地过滤掉。
 */
/**
 * 公司 + 主题的组合检索，例如「三星的 AMP 案例」。
 *
 * 公司限定用**全文短语**（`"Samsung India Electronics"`），不是 title: 字段限定——
 * 2026-10-13 服务器实测：`title:"X" "AMP expenses"` 返回 0 条（IK 的 title: 不
 * 与短语组合），而 `"X" "AMP expenses"` 的第 1 条就是三星 AMP 案。
 * "公司只在标题"这件事由 `verdictFromTitle` 按标题判当事人完成，
 * 不需要（也不能）在查询层做。
 *
 * ## 为什么一个主题词一条查询，不把它们并成一条
 *
 * 官方文档只说了三件事：ANDD/ORR/NOTT 三个操作符、ANDD 在词串之间是隐含的、
 * 操作符前后必须留空格。**没有说支持括号，也没有说 ANDD 和 ORR 的优先级。**
 * 于是 `title:"Samsung" ANDD ("AMP" ORR "bright line")` 这种写法是在赌：
 * 括号不支持时它会被当成普通字符，整条检索式的含义完全失控，
 * 而且**不会报错**——又是一个静默失败。
 *
 * 所以拆成多条：每条只用一个主题词，靠隐含 ANDD（这条文档明确写了），
 * 结果在本地合并去重。多花几次检索（₹0.50/次）换掉一个赌，划算。
 *
 * ## 不再叠加 doctypes 和时间分段
 *
 * 公司 × 主题已经足够窄了，再乘法院和时间段会让查询数爆炸
 * （4 别名 × 3 主题词 × 4 法院 × 5 时段 = 240 条 ≈ ₹120）。
 * 组合检索的定位是"精确找一类"，不是"穷举一家公司的全部案子"——
 * 后者是 `buildRecallQueries` 的事。
 */
export function buildCombinedQueries(options: {
  aliases: string[];
  topicTerms: string[];
  maxTopicTerms?: number;
}): RecallQuery[] {
  const { aliases, topicTerms } = options;
  const terms = topicTerms.slice(0, options.maxTopicTerms ?? 3);
  if (terms.length === 0) return [];

  const queries: RecallQuery[] = [];
  for (const alias of aliases) {
    // 2026-10-13 实测：`title:"X" "主题词"` 组合在 IK 上返回 0 条（title: 与短语
    // AND 不组合），同样的词用全文 `"X" "主题词"` 则有效（三星 AMP 案就是第 1 条）。
    // 所以这里**始终用全文短语**——标题限定本是为了排除引用型，那件事由
    // verdictFromTitle 按标题判当事人完成，不需要在查询层做。
    const company = `"${alias}"`;
    for (const term of terms) {
      queries.push({
        // 词串之间的 ANDD 是隐含的（文档明确），不写出来，少一个出错面。
        formInput: `${company} "${term}"`,
        label: `${alias} + ${term}`,
      });
    }
  }
  return queries;
}

/**
 * 组合检索的**自检**：主题过滤到底生效了没有。
 *
 * 风险在于"隐含 ANDD"这条假设——万一 Indian Kanoon 把
 * `title:"Samsung" "AMP expenses"` 理解成 OR，或者干脆忽略了后半段，
 * 我们会拿到一堆三星的**不相干**案子，还以为已经按主题筛过了。
 *
 * 自检办法：Indian Kanoon 返回的 `headline` 是**命中查询词的片段**。
 * 主题词真的参与了匹配，就应该有相当比例的结果片段里出现它。
 * 一条都没出现 → 这个假设不成立，调用方据此降级。
 *
 * 阈值取"至少一条命中"而不是"多数命中"：headline 长度有限，
 * 长判决书里主题词可能落在片段之外，要求过半会造成误判。
 * 这里只要能否定"完全没生效"这个最坏情况就够了。
 */
export function topicFilterLooksEffective(
  headlines: string[],
  topicTerms: string[],
): boolean {
  if (headlines.length === 0 || topicTerms.length === 0) return false;
  const haystacks = headlines.map((h) => normalizeEntityName(h.replace(/<[^>]+>/g, " ")));
  return topicTerms.some((term) => {
    const needle = normalizeEntityName(term);
    return needle.length > 0 && haystacks.some((h) => h.includes(needle));
  });
}

export function buildRecallQueries(options: {
  aliases: string[];
  fromYear?: number;
  toYear?: number;
  segmentYears?: number;
  now?: Date;
}): RecallQuery[] {
  const { aliases } = options;
  const now = options.now ?? new Date();
  const toYear = options.toYear ?? now.getFullYear();
  const fromYear = options.fromYear ?? toYear - 25;
  const segment = options.segmentYears ?? 5;

  const queries: RecallQuery[] = [];
  for (const alias of aliases) {
    // 公司全集查询同样不用 title: 前缀——2026-10-13 实测它与 doctypes:/日期
    // 组合的行为也不可靠（title: 与任何额外检索词组合都返回 0 条）。
    const phrase = `"${alias}"`;
    for (const doctype of CASE_DOCTYPES) {
      for (let start = fromYear; start <= toYear; start += segment) {
        const end = Math.min(start + segment - 1, toYear);
        queries.push({
          formInput: `${phrase} doctypes:${doctype}`,
          fromdate: `1-1-${start}`,
          todate: `31-12-${end}`,
          label: `${alias} · ${doctype} · ${start}-${end}`,
        });
      }
    }
  }
  return queries;
}

/* ------------------------------------------------------------------ *
 * 四、判例是否仍然有效
 * ------------------------------------------------------------------ */

/**
 * 后续审级提示。
 *
 * **这是这套东西里最容易出事的一点**：一个 ITAT 判决被高院推翻了，还拿来给用户
 * 当依据，等于给错建议——比"检索不全"严重得多。
 *
 * 用 `citedbyList`（`/doc/<id>/?maxcitedby=50`）能部分发现：如果有**更高审级、
 * 更晚年份**的案件引用了它，就必须让用户知道要去核对后续。
 *
 * 口径上刻意只说"未发现后续推翻"，不说"现行有效"——
 * 引用关系查不出推翻，不等于没被推翻（可能压根没进 Indian Kanoon 的引用图）。
 * 和知识库那边「没填生效日就不算现行有效」是同一条原则：**查不出来不等于没有**。
 */
export interface SupersessionHint {
  /** 更高审级、更晚年份的后续案件。 */
  higherCourtFollowUps: Array<{ docid: string; title: string; docsource?: string; year?: number }>;
  /** 给用户看的一句话。 */
  note: string;
}

export function buildSupersessionHint(
  self: { docsource?: string; year?: number },
  citedBy: Array<{ tid: number | string; title?: string; docsource?: string; year?: number }>,
): SupersessionHint {
  const selfTier = courtTier(self.docsource).weight;
  const followUps = citedBy
    .filter((item) => {
      const tier = courtTier(item.docsource).weight;
      if (tier <= selfTier) return false;
      if (self.year !== undefined && item.year !== undefined && item.year < self.year) return false;
      return true;
    })
    .map((item) => ({
      docid: String(item.tid),
      title: item.title ?? `文档 ${item.tid}`,
      docsource: item.docsource,
      year: item.year,
    }));

  return {
    higherCourtFollowUps: followUps,
    note: followUps.length > 0
      ? `本案之后有 ${followUps.length} 份更高审级的判决引用过它，援引前请先核对后续是否被改判。`
      : "未发现更高审级的后续判决引用本案（注意：这不等于本案必然仍属有效，引用图未必完整）。",
  };
}

/* ------------------------------------------------------------------ *
 * 五、同名消歧
 * ------------------------------------------------------------------ */

/**
 * "三星的案例"可能对应多个印度法律实体——Samsung India Electronics（消费电子销售）、
 * Samsung Heavy Industries（海工，常设机构争议）、Samsung India Software Operations……
 * 行业不同、争议类型不同，混在一起归纳等于把两家公司的风险画像揉成一张。
 *
 * **不猜用户指的是哪个**，按主体分组呈现，让用户自己看见有几个。
 * 分组键取"命中侧当事人名"的归一化前三个词——完整名太长且写法不统一
 * （Pvt. / Private / P. Ltd.），前三个词足以区分上面那三个主体。
 */
export function entityGroupKey(partyName: string): string {
  return normalizeEntityName(partyName).split(" ").filter(Boolean).slice(0, 3).join(" ");
}

export function groupByEntity(
  candidates: CompanyCaseCandidate[],
): Array<{ entity: string; cases: CompanyCaseCandidate[] }> {
  const groups = new Map<string, CompanyCaseCandidate[]>();
  for (const item of candidates) {
    const key = item.entity ?? "未识别主体";
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()]
    .map(([entity, cases]) => ({ entity, cases }))
    .sort((a, b) => b.cases.length - a.cases.length);
}

/**
 * 命中了哪一侧当事人——分组用。两侧都命中时取 A 侧（判决书标题里
 * 上诉人通常在前，而公司作为上诉人的情形占多数）。
 */
export function matchedEntity(title: string, aliases: string[]): string | undefined {
  const parties = splitPartiesFromTitle(title);
  if (!parties) return undefined;
  if (isPartyMatch(parties.a, aliases)) return entityGroupKey(parties.a);
  if (isPartyMatch(parties.b, aliases)) return entityGroupKey(parties.b);
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 六、IO 层（会花钱的部分）
 * ------------------------------------------------------------------ */

interface IkSearchDoc {
  tid: number | string;
  title?: string;
  docsource?: string;
  headline?: string;
  publishdate?: string;
  docsize?: number;
}

function extractYear(doc: { publishdate?: string; title?: string; docsource?: string }): number | undefined {
  for (const field of [doc.publishdate, doc.title, doc.docsource]) {
    const found = field?.match(/\b(19|20)\d{2}\b/)?.[0];
    if (found) return Number(found);
  }
  return undefined;
}

async function ikSearch(token: string, query: RecallQuery, maxpages = 2): Promise<IkSearchDoc[]> {
  const params = new URLSearchParams({
    formInput: query.formInput,
    pagenum: "0",
    maxpages: String(maxpages),
  });
  if (query.fromdate) params.set("fromdate", query.fromdate);
  if (query.todate) params.set("todate", query.todate);

  const response = await fetch(`${IK_BASE}/search/?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Indian Kanoon 搜索失败：HTTP ${response.status}`);
  const data = await response.json() as { docs?: IkSearchDoc[] };
  return data.docs ?? [];
}

/**
 * 探测 `title:` 语法到底支不支持——**已废除（2026-10-13）**。
 *
 * 这个探针活了不到一天，前后被两张不同的真实数据打崩，记录在此免得第三次把它
 * 写回来：
 *
 * 1. **旧版比页数**（`titled.length < plain.length*0.9`）：`ikSearch` 只取 docs
 *    一页，高频被告两边都装满，不等式永不成立 → 一律误判"不支持" → 全局降级。
 * 2. **改行为判定后**（标题含别名比例 ≥0.6）：又被 IK 返回标题里的 `<b>` 高亮
 *    标签打崩（matchRate=0，见 `normalizeEntityName` 注释）。剥标签修好后探针
 *    终于判对"可用"——然后暴露出最终事实：**`title:` 与短语 AND 组合在 IK 上
 *    返回 0 条**（`title:"X" "AMP expenses"` → 0，而 `"X" "AMP expenses"` 的
 *    第 1 条就是三星 AMP 案），title: 单独查也捞不到新案。
 *
 * 结论：title: 这条路对"公司+主题"检索没有增量价值，查询全部改回全文短语，
 * 当事人识别交给 verdictFromTitle。探针删除——它 ₹1/次，还曾是两个故障点的根。
 */

/**
 * 存疑候选的第二道验证：调 docfragment 看上下文。
 *
 * 失败（接口挂了 / 没配 token / 片段为空）一律返回 UNCERTAIN，由入池规则
 * 按"宁可少收"处理——**不能因为验证失败就放行**，那等于把闸门拆了。
 */
export async function verifyPartyByFragment(
  token: string,
  docid: string,
  alias: string,
  aliases: string[],
): Promise<PartyVerdict> {
  try {
    const params = new URLSearchParams({ formInput: `"${alias}"` });
    const response = await fetch(`${IK_BASE}/docfragment/${docid}/?${params.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return "UNCERTAIN";
    const data = await response.json() as { headline?: string | string[] };
    const fragment = Array.isArray(data.headline) ? data.headline.join(" … ") : (data.headline ?? "");
    if (!fragment.trim()) return "UNCERTAIN";
    return classifyFragment(fragment, aliases);
  } catch {
    return "UNCERTAIN";
  }
}

export interface CompanyCaseResult {
  /** 确认是当事人的案例，已排序。 */
  cases: RelatedCase[];
  /** 按法律主体分组，用于同名消歧展示。 */
  groups: Array<{ entity: string; count: number }>;
  /** 被规则挡掉的数量，用于向用户交代"为什么没有更多"。 */
  excluded: { citationOnly: number; uncertain: number };
  /**
   * 主题过滤的实际状态。**必须如实下发给界面**——
   * "三星的 AMP 案例"和"三星的案例（没按 AMP 筛成）"是两个不同的答案，
   * 后者当成前者给用户，就是在悄悄换掉他的问题。
   */
  topicFilter?: {
    terms: string[];
    /**
     * - `applied`：按主题筛过，且自检确认筛选生效了
     * - `unverified`：筛了，但片段里找不到主题词，无法确认是否完全生效
     * - `empty`：**这家公司在这个主题上一条判例都没有**
     *
     * `empty` 时 `cases` 是空数组——这里刻意**不**自作主张退回"这家公司的其他案例"。
     * 用户问的是"三星的代持案例"，给他三星的 GST 案例是答非所问的噪音；
     * 真正该退的是"其他企业的代持案例"（主题这条轴才是他在研究的东西）。
     * 但那属于另一条链路，由 `case-route.ts` 统一决定，不在这个模块里偷偷做。
     */
    status: "applied" | "unverified" | "empty";
  };
  /** 诊断信息，不展示给用户。 */
  diagnostics: string[];
}

/**
 * 整条链路。任何一步失败都降级而不是抛错——和 `case-search.ts` 同一原则。
 *
 * 成本上限由 `maxFragmentChecks` 兜住：存疑件太多时只验前 N 条，其余按 UNCERTAIN
 * 处理（不入池，但会出现在"待人工确认"里）。不设这个上限的话，一个大公司
 * 可能触发上百次 docfragment 调用。
 */
export async function searchCompanyCases(options: {
  aliases: string[];
  /** 给了就走「公司 + 主题」组合检索，例如 Samsung + AMP expenses。 */
  topicTerms?: string[];
  fromYear?: number;
  toYear?: number;
  maxResults?: number;
  maxFragmentChecks?: number;
  now?: Date;
}): Promise<CompanyCaseResult> {
  const token = process.env.INDIANKANOON_API_TOKEN?.trim();
  const diagnostics: string[] = [];
  const empty: CompanyCaseResult = {
    cases: [], groups: [], excluded: { citationOnly: 0, uncertain: 0 }, diagnostics,
  };
  if (!token || options.aliases.length === 0) {
    diagnostics.push("未配置 INDIANKANOON_API_TOKEN 或未给出公司别名");
    return empty;
  }

  const maxResults = options.maxResults ?? 12;
  const maxFragmentChecks = options.maxFragmentChecks ?? 15;
  const now = options.now ?? new Date();
  const topicTerms = options.topicTerms?.filter(Boolean) ?? [];

  const runRecall = async (queries: RecallQuery[]) => {
    const found = new Map<string, IkSearchDoc>();
    const settled = await Promise.allSettled(queries.map((q) => ikSearch(token, q)));
    settled.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        diagnostics.push(`召回失败：${queries[index].label}`);
        return;
      }
      for (const doc of outcome.value) {
        const key = String(doc.tid);
        if (!found.has(key)) found.set(key, doc);
      }
    });
    return found;
  };

  let seen: Map<string, IkSearchDoc>;
  let topicFilter: CompanyCaseResult["topicFilter"];

  if (topicTerms.length > 0) {
    // 组合检索：公司在标题、主题在正文。
    seen = await runRecall(buildCombinedQueries({ aliases: options.aliases, topicTerms }));
    const headlines = [...seen.values()].map((d) => d.headline ?? "");
    if (seen.size === 0) {
      // 一条都没有。**这本身是有效信息**——"三星没有 AMP 相关的案子"是个答案，
      // 不是失败。如实返回空，让 `case-route.ts` 去决定退到哪条链路
      // （产品决定：退主题，给"其他企业的同类案例"，而不是"三星的其他案例"）。
      diagnostics.push("组合检索 0 条：这家公司在这个主题上没有判例");
      return {
        cases: [], groups: [], excluded: { citationOnly: 0, uncertain: 0 },
        topicFilter: { terms: topicTerms, status: "empty" },
        diagnostics,
      };
    } else if (topicFilterLooksEffective(headlines, topicTerms)) {
      diagnostics.push(`组合检索 ${seen.size} 条，主题过滤自检通过`);
      topicFilter = { terms: topicTerms, status: "applied" };
    } else {
      // 隐含 ANDD 这条假设可能没成立：拿到了结果，但没有一条的片段里出现主题词。
      // 不当作失败（片段有长度限制，主题词可能落在片段外），但要**降格标注**，
      // 不能对用户宣称"这些就是 AMP 案例"。
      diagnostics.push(`组合检索 ${seen.size} 条，但片段里找不到主题词——主题过滤未能自检`);
      topicFilter = { terms: topicTerms, status: "unverified" };
    }
  } else {
    seen = await runRecall(buildRecallQueries({
      aliases: options.aliases,
      fromYear: options.fromYear, toYear: options.toYear, now,
    }));
  }
  diagnostics.push(`多路召回去重后 ${seen.size} 条候选`);

  // 第一道：只看标题。
  const candidates: CompanyCaseCandidate[] = [...seen.values()].map((doc) => ({
    docid: String(doc.tid),
    title: doc.title ?? `文档 ${doc.tid}`,
    docsource: doc.docsource,
    year: extractYear(doc),
    headline: doc.headline,
    verdict: verdictFromTitle(doc.title ?? "", options.aliases),
    entity: matchedEntity(doc.title ?? "", options.aliases),
  }));

  // 第二道：存疑件用 docfragment 验证（₹0.05/次，有条数上限兜底）。
  const uncertain = candidates.filter((c) => c.verdict === "UNCERTAIN").slice(0, maxFragmentChecks);
  const verified = await Promise.allSettled(
    uncertain.map((c) => verifyPartyByFragment(token, c.docid, options.aliases[0], options.aliases)),
  );
  verified.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") uncertain[index].verdict = outcome.value;
  });

  const parties = candidates.filter((c) => c.verdict === "PARTY");
  const excluded = {
    citationOnly: candidates.filter((c) => c.verdict === "CITATION_ONLY").length,
    uncertain: candidates.filter((c) => c.verdict === "UNCERTAIN").length,
  };
  diagnostics.push(`当事人 ${parties.length}｜仅被引用 ${excluded.citationOnly}｜存疑 ${excluded.uncertain}`);

  const ranked = parties
    .map((item) => ({ item, score: scoreCandidate(item, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((entry) => entry.item);

  return {
    cases: ranked.map((item) => ({
      // cleanCaseTitle：IK 的 title 带 `<b>` 高亮标签，直接展示会渲染出标签
      // （2026-10-13 线上实测：「案例索引」里出现 "<b>Samsung</b> <b>India</b>…"）。
      caseName: cleanCaseTitle(item.title),
      docid: item.docid,
      official_url: `https://indiankanoon.org/doc/${item.docid}/`,
      court_and_year: [item.docsource, item.year].filter(Boolean).join(" · ") || undefined,
      snippet: (item.headline ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240),
    })),
    groups: groupByEntity(ranked).map((g) => ({ entity: g.entity, count: g.cases.length })),
    excluded,
    ...(topicFilter ? { topicFilter } : {}),
    diagnostics,
  };
}

/**
 * 清洗 IK 返回的标题，用于展示。
 *
 * IK 搜索 API 的 title 字段把**命中的查询词**用 `<b>…</b>` 加粗
 * （`<b>Samsung</b> <b>India</b> <b>Electronics</b> Pvt. Ltd vs ...`），
 * 直接透出会把标签原样渲染到「案例索引」里（2026-10-13 线上实测）。
 * 实体解码一并做，否则标题里会出现 "&amp;" 字样。
 *
 * 和 `normalizeEntityName` 的分工：那个是给**匹配**用的（标点全去、只留字母数字），
 * 这个给**展示**用（保留原文措辞，只去噪音）。
 */
export function cleanCaseTitle(title: string): string {
  return title
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 给用户看的一句话。组合检索时**必须说清主题筛没筛上**——
 * 用户问的是"三星的 AMP 案例"，如果我们给的其实是"三星的全部案例"，
 * 不说一句就是在悄悄换掉他的问题。
 */
export function describeCompanySearch(result: CompanyCaseResult, mention: string): string {
  const base = `共找到 ${result.cases.length} 件以${mention}为当事人的判例`;
  const excludedNote = result.excluded.citationOnly > 0
    ? `（另有 ${result.excluded.citationOnly} 件只是在论证中引用了${mention}的案例，已排除）`
    : "";
  if (!result.topicFilter) return `${base}${excludedNote}。`;

  const terms = result.topicFilter.terms.slice(0, 2).join(" / ");
  switch (result.topicFilter.status) {
    case "applied":
      return `${base}，已按主题「${terms}」筛选${excludedNote}。`;
    case "unverified":
      return `${base}，按主题「${terms}」检索所得${excludedNote}；`
        + `但系统未能自动确认主题筛选是否完全生效，请以判例原文为准。`;
    case "empty":
      return `未检索到${mention}在「${terms}」这一主题上的判例。`;
  }
}
