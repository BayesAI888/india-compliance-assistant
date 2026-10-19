/**
 * 新法取代旧法的候选池闸门。
 *
 * 起因（2026-09-17 用户实测）：问一个所得税问题，回答里给出的合规要求**全部出自
 * 1961 年所得税法**——那部法从 2026-04-01 起已被 Income-tax Act, 2025 取代。
 *
 * 为什么原有的两道机制都没拦住：
 *
 * 1. `coversDate()` 是对的，但它依赖 chunk 上的【法律生效日】【法律失效日】字段，
 *    而已上传的两部所得税法**都没填这两个字段**。字段留空＝不设限＝现行有效，
 *    于是废止的 1961 法和新法在检索里权重完全平等，谁的关键词命中多谁就赢。
 * 2. `domain-scope.ts` 拦的是**法域**，两部所得税法属于同一个法域，它天然分不开。
 *
 * 为什么不是"叫用户去把日期字段补上就好"：那能解决这一次，但下一部法改版时
 * 同样的坑会再踩一遍——**正确性挂在"管理员记得填某个字段"上，就是没有保障**。
 * 这份注册表把"哪部法取代了哪部法、什么时候生效"写死在代码里，
 * 数据层填不填日期都拦得住；数据层填了日期，两道闸叠加只会更严，不会冲突。
 *
 * ## 判断规则
 *
 * 设目标日期为 D（用户问题里的税期；没说就是今天）：
 * - **D ≥ 新法生效日**：候选池里同时有新旧两法时，剔掉旧法。只有旧法时**不剔**——
 *   宁可引一部过时的法并在答案里说清楚，也不能把用户的问题变成"查不到"。
 * - **D < 新法生效日**：剔掉新法。用户问 2024 年度的所得税，就该看 1961 法。
 *   这条同样只在两法俱全时生效。
 *
 * 剔到一条不剩时整体回退——和 `domain-scope.ts` 同一条兜底原则：空结果比不精确更糟。
 */
import type { PublishedKnowledgeChunk } from "./knowledge-store";

export interface SupersessionRule {
  /** 说明用，出现在诊断日志里。 */
  name: string;
  /** 被取代的旧法，按资料标题匹配。 */
  repealed: RegExp;
  /** 取代它的新法。 */
  successor: RegExp;
  /** 新法生效日（含当天），ISO 日期。 */
  successorEffectiveFrom: string;
}

/**
 * 印度所得税法的新旧交替：Income-tax Act, 2025 自 2026-04-01 起施行，
 * 同日起 Income-tax Act, 1961 废止。
 *
 * 生效日可以用环境变量覆盖，是为了印度政府万一推迟施行时**不用改代码重新部署**——
 * 这类"外部日期变了"的风险，留个旋钮比事到临头改代码可靠。
 *
 * 匹配写法说明：`\b1961\b` / `\b2025\b` 要求年份是独立数字，
 * 避免标题里的下载日期、版本号被误当成法律年份。
 */
export const SUPERSESSION_RULES: SupersessionRule[] = [
  {
    name: "所得税法 1961 → 2025",
    // 年份写在法律名前后都要认（"1961年所得税法" / "所得税法（1961）"），
    // 因为管理员上传时【来源】怎么写是自由文本，只认一种写法等于赌运气。
    repealed: /income[-\s]?tax act[,\s]*\b1961\b|1961\s*年?所得税法|所得税法[^\d]{0,4}\b1961\b/i,
    successor: /income[-\s]?tax act[,\s]*\b2025\b|2025\s*年?所得税法|所得税法[^\d]{0,4}\b2025\b/i,
    successorEffectiveFrom:
      process.env.INCOME_TAX_ACT_2025_EFFECTIVE_FROM?.trim() || "2026-04-01",
  },
];

/**
 * 只拿"法律名称"去匹配，把标题括号里的**出处元信息**切掉。
 *
 * 和 `domain-scope.ts` 里的 `sourceName` 是同一个理由，而且这里更要紧：
 * 已上传资料的标题形如
 * "The Income-tax Act, 1961 (as amended; downloaded 2025-06-19)"，
 * 括号里的下载年份 2025 会把这份 1961 法误判成新法——那就正好反了。
 *
 * 但这里**不能像 domain-scope 那样见括号就切**：写测试时发现
 * "所得税法（1961）" 这种标题一切括号就只剩"所得税法"，年份丢了，新旧两法从此分不开。
 * 判定法域时丢个年份无所谓，判定"哪一版"时年份就是全部信息。
 *
 * 所以规则改成：**只有内容不是纯年份的括号才当出处元信息切掉**。
 * "（1961）"留下，"（as amended; downloaded 2025-06-19）"切掉。
 */
const YEAR_ONLY = /^\s*(?:19|20)\d{2}\s*年?\s*$/;

function sourceName(source: string): string {
  const cleaned = source
    .replace(/[（(]([^）)]*)[）)]/g, (whole, inner: string) => (YEAR_ONLY.test(inner) ? whole : " "))
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || source;
}

export interface SupersessionScopeResult {
  chunks: PublishedKnowledgeChunk[];
  /** 因为被新法取代而剔除的法律名，供诊断日志与文档说明用。 */
  excluded: string[];
}

export function scopeBySupersession(
  chunks: PublishedKnowledgeChunk[],
  targetDate?: string,
  rules: SupersessionRule[] = SUPERSESSION_RULES,
): SupersessionScopeResult {
  if (chunks.length === 0) return { chunks, excluded: [] };
  const effectiveTarget = targetDate ?? new Date().toISOString().slice(0, 10);

  const excluded: string[] = [];
  let kept = chunks;

  for (const rule of rules) {
    const hasRepealed = kept.some((chunk) => rule.repealed.test(sourceName(chunk.source)));
    const hasSuccessor = kept.some((chunk) => rule.successor.test(sourceName(chunk.source)));
    // 只有一部在库里时不做任何事：手上只有这一部，剔掉就等于回答不了。
    if (!hasRepealed || !hasSuccessor) continue;

    const newLawInForce = effectiveTarget >= rule.successorEffectiveFrom;
    const dropPattern = newLawInForce ? rule.repealed : rule.successor;
    const filtered = kept.filter((chunk) => !dropPattern.test(sourceName(chunk.source)));
    // 兜底：剔光了就当这条规则没跑过。
    if (filtered.length === 0) continue;

    kept = filtered;
    excluded.push(newLawInForce
      ? `${rule.name}（问的是 ${effectiveTarget}，旧法已废止）`
      : `${rule.name}（问的是 ${effectiveTarget}，新法尚未施行）`);
  }

  return { chunks: kept, excluded };
}
