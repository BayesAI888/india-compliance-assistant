/**
 * 把争议骨架里的条号（`"Income-tax Act, 2025 s.362"`）定位到知识库里的具体 chunk，
 * 变成可点开的引用角标。
 *
 * ## 这和检索不是一回事
 *
 * 正文那些角标来自**检索**——模型问了个问题，检索按相关度捞回一堆 chunk。
 * 而骨架的条号是**确定性查找**：我们明确知道要 s.362 这一条，不是"最相关的那条"。
 *
 * 所以这里不打分、不排序、不走向量。找得到就挂，找不到就如实说没有。
 * 这也是为什么它单独一个模块，而不是塞进 `retrieval.ts`。
 *
 * ## 法规名必须容错匹配
 *
 * 骨架里写的是规范名（`CGST Act, 2017`），而知识库里的 `source` 是管理员
 * 上传时填的（`CGST Act 2017 (as on 11 June 2026)`、
 * `ICAI IDTC – GST Law (Central Goods and Services Tax)`）。
 * 严格相等一个都匹配不上。
 *
 * 所以按**实词重合**判：去掉括号里的版本信息、去掉标点，看骨架名里的实词
 * 是不是都出现在库里那个名字里。这比模糊相似度可控——
 * 它只会因为"库里的名字更详细"而匹配上，不会因为"两个名字长得像"而匹配错。
 *
 * ## 查不到时怎么办
 *
 * **如实标成"库里没有这一条"，不降级成无角标。**
 *
 * 一个没有角标的格子和一个"查不到"的格子，对用户是两件事：前者看起来
 * 像是这个数不需要依据，后者明说了依据应该有、但库里缺。
 * 后者还能指导补库——这正是《知识库补料清单》那套东西的输入。
 */

import type { PublishedKnowledgeChunk } from "./knowledge-store";
import { ABBREVIATIONS } from "./abbreviations";

export interface ParsedCitationKey {
  /** 法规名部分，例如 "Income-tax Act, 2025"。 */
  sourceHint: string;
  /** 条号，例如 "362"、"129E"、"411(3)(a)"。没有条号时为 undefined。 */
  section?: string;
}

/**
 * 拆 `"Income-tax Act, 2025 s.411(3)(a)"` → `{ sourceHint, section }`。
 *
 * 支持的写法：`s.362` / `s 362` / `Section 362` / `s.129E 但书`（尾巴上的中文注释忽略）。
 * 没有条号的（`"CBDT Office Memorandum F.No.404/72/93-ITCC"`）只返回 sourceHint，
 * 按整份资料匹配。
 */
export function parseCitationKey(key: string): ParsedCitationKey {
  const text = (key ?? "").trim();
  if (!text) return { sourceHint: "" };
  // 条号：s./sec./section + 数字 + 可选的字母后缀和括号层级
  const match = text.match(/\b(?:s|sec|section)\.?\s*(\d+[A-Za-z]*(?:\s*\([0-9A-Za-z]+\))*)/i);
  if (!match) return { sourceHint: text };
  return {
    sourceHint: text.slice(0, match.index).trim().replace(/[,，]\s*$/, ""),
    section: match[1].replace(/\s+/g, ""),
  };
}

/**
 * 法规名归一：小写、**去掉括号里的内容**、去掉标点、压缩空白。
 *
 * 括号里装的是版本和出处（`(as on 11 June 2026)`、`(Central Goods and Services Tax)`），
 * 不是法律名的一部分——这和 `domain-scope.ts` 的 `sourceName()` 是同一个判断，
 * 那边也栽过一次：括号里的来源网址让公司法被判成了所得税资料。
 */
function normalizeSource(name: string): string {
  return (name ?? "")
    .replace(/[（(][^）)]*[）)]/g, " ")
    .toLowerCase()
    .replace(/[.,，、·–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NAME_NOISE = new Set([
  "the", "act", "rules", "of", "and", "law", "india", "indian",
  // 文号前缀。它们不区分任何东西。
  "f", "no", "dated", "dt",
]);

/**
 * **文号类 token**：文件编号、日期这种。
 *
 * 它们不参与"必须匹配"，只参与**排名**。
 *
 * 起因（2026-09-29）：骨架里写的是 `"CBDT Office Memorandum F.No.404/72/93-ITCC"`，
 * 而库里那份资料叫 `"CBDT Office Memorandum – Stay of Demand"`。
 * 原来的规则是"骨架名里每个实词都得出现"，于是 `404/72/93`、`itcc` 匹配不上，
 * 一份**明明在库里**的资料被标成了「库里没有这一条」。
 *
 * 但也不能干脆忽略文号——她库里有**两份**配套的 CBDT 备忘录
 * （原始的 15% 和修订后的 20%）。挑错一份就是 15%/20% 那个错误重演。
 * 所以文号降级为**排名依据**：核心词都对得上的候选里，文号也对得上的排前面。
 */
function contentWords(name: string): string[] {
  return normalizeSource(name)
    .split(" ")
    .filter((w) => w.length > 0 && !NAME_NOISE.has(w));
}

/**
 * 库里那个名字的归一形式（**比对时的被查方**）。
 *
 * 和 `normalizeSource` 只差一点，但这一点是关键：**括号里的内容要留下。**
 *
 * `normalizeSource` 剥括号是为了处理 hint 那一侧的版本尾巴
 * （`(as on 11 June 2026)`、`(Act No. 52 of 1962)`），那些确实是噪音。
 * 但同一个规则套在库里的名字上就会出事：
 *
 *   `ICAI IDTC – GST Law (Central Goods and Services Tax)`
 *        剥括号后 → `icai idtc gst law`
 *
 * **整部法的身份就写在那对括号里**，剥掉之后这份资料等于没了名字，
 * 于是用户库里明明躺着的 CGST 法，页面上挂满了「库里没有这一条」。
 * （2026-09-29 用户反馈："我的知识库中明明有 cgst 2017 act"。）
 *
 * 被查方留得越全越好：判据是"hint 的每个词都要在被查方里出现"，
 * 被查方多几个词只会让该匹配的匹配上，不会凭空匹配上不相干的法
 * ——真正的区分力来自 hint 那一侧要求了哪些词。
 */
function normalizeHaystack(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[（()）]/g, " ")
    .replace(/[.,，、·–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 必须匹配的核心词。
 *
 * 判据是**按空白分组**：原串里一个空白分隔的整块，只要含数字，
 * **整块都算文号**，里面的字母片段一并排除。
 *
 * 不能只看单个 token 含不含数字——`F.No.404/72/93-ITCC` 归一后拆成
 * `f no 404/72/93 itcc`，其中 `itcc` 不含数字，会被当成核心词，
 * 于是库里那份叫「CBDT Office Memorandum – Stay of Demand」的资料匹配不上。
 * 2026-09-29 实测就是这么把一份**明明在库里**的备忘录标成「库里没有」的。
 *
 * 按整块判就对了，而且这个规则对别的文号写法一样管用：
 * `G.S.R. 198(E)`、`22/2026-CT`、`No. 17/2024 – CT`。
 */
function coreWords(name: string): string[] {
  const stripped = (name ?? "")
    .replace(/[（(][^）)]*[）)]/g, " ")
    .split(/\s+/)
    // 含数字的整块丢弃，**但四位年份要留下**——年份是法律名的一部分，不是文号。
    // ⚠第一版把年份也剥了，于是 "Income-tax Act, 2025" 和
    // "Income-tax Act, 1961" 的核心词都只剩 [income-tax]，两部法互相匹配上了
    // ——而 1961/2025 的区分正是这整个功能依赖的东西。
    .filter((group) => {
      if (!group) return false;
      const bare = group.replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, "");
      if (/^(19|20)\d{2}$/.test(bare)) return true;   // 四位年份：留
      return !/\d/.test(group);                        // 其余含数字的：文号，丢
    })
    .join(" ");
  return contentWords(stripped);
}

/**
 * 库里这份资料的名字，能不能对上骨架里写的法规名。
 *
 * 判据：骨架名里的**每一个实词**都出现在库里那个名字里。
 * 方向是单向的——库里的名字可以更详细（带版本、带出处），但不能缺内容。
 *
 * 例：
 *   骨架 "CGST Act, 2017"           实词 [cgst, 2017]
 *   库里 "CGST Act 2017 (as on ...)" 归一后含 cgst、2017 → ✅
 *   库里 "IGST Act, 2017"            不含 cgst           → ❌
 *
 * ## 缩写要展开（2026-09-29 修）
 *
 * 用户反馈：「你怎么确认"库里没有这一条"，我的知识库中明明有 CGST 2017 Act」。
 * 他是对的——库里有两份，而两份的名字都不含 "CGST" 这四个字母：
 *
 *   ① `The Central Goods and Services Tax Act, 2017 (as on 11 June 2026)`
 *   ② `ICAI IDTC – GST Law (Central Goods and Services Tax)`
 *
 * 骨架里写的是法定简称 `CGST Act, 2017`，字面比对必然落空。
 * 所得税和海关没出事只是因为巧合：`Income-tax Act, 2025` 和
 * `Customs Act, 1962` 的简称本身就是全称的子串。
 *
 * **误报"库里没有"和误挂一个错角标一样糟**，方向还相反得更讨厌：
 * 它会让用户去补一份他已经有的资料，而且是在他明确知道自己有的时候——
 * 这比缺个角标更伤对系统的信任。
 *
 * 所以核心词里的缩写要展开后再比：`cgst` 命中不了，就试
 * `central goods and services tax` 的每一个词。词表直接用
 * `abbreviations.ts` 里那一份，**不另起一份**——两份缩写表迟早会分叉。
 */

/**
 * 一个核心词能不能在库里那个名字中找到：字面找不到时，试它的英文全称。
 *
 * 只做**单向**展开（缩写 → 全称），不做反向：
 * 反向会把"库里叫 CGST、骨架写全称"也放过去，看似对称，
 * 实则把 `GST` 这种短缩写变成了通配符（`Goods and Services Tax` 里每个词
 * 都极常见），误挂的风险比它能救回来的那点场景大得多。
 */
function wordFound(word: string, haystack: string): boolean {
  if (haystack.includes(word)) return true;
  const full = ABBREVIATIONS[word.toUpperCase()]?.en;
  if (!full) return false;
  // 全称的每个实词都要在——`central goods and services tax` 不能靠
  // 命中一个 `tax` 就算数。
  return contentWords(full).every((part) => haystack.includes(part));
}

export function sourceMatches(hint: string, chunkSource: string): boolean {
  const core = coreWords(hint);
  if (core.length === 0) return false;
  const haystack = normalizeHaystack(chunkSource);
  return core.every((w) => wordFound(w, haystack));
}

/**
 * 候选之间比高低：核心词都对得上之后，**文号也对得上的排前面**。
 *
 * 只在 `sourceMatches` 为真的候选里用。返回的是"命中了多少个 hint 词"，
 * 越大越像。同分时取先出现的（chunk 顺序稳定）。
 */
export function sourceScore(hint: string, chunkSource: string): number {
  const haystack = normalizeHaystack(chunkSource);
  // 和 sourceMatches 用同一个判据：否则"能匹配上但得 0 分"的候选会排在最后，
  // 挑出来的反而是次优的那一份。
  return contentWords(hint).filter((w) => wordFound(w, haystack)).length;
}

/**
 * 这个 chunk 是不是骨架要的那一条。
 *
 * 条号匹配用**词边界**，不能用 includes：`Section 36` 会命中 `Section 362`，
 * 挂错条文比挂不上更糟——用户点开看到的是另一条，而角标看起来是对的。
 */
export function sectionMatches(section: string, chunk: PublishedKnowledgeChunk): boolean {
  const target = section.replace(/\s+/g, "").toLowerCase();
  const title = `${chunk.minorTitle ?? ""} ${chunk.majorTitle ?? ""}`.toLowerCase();
  // 先试完整条号（含括号层级）：`411(3)(a)`
  const full = target.replace(/[()]/g, "\\$&");
  if (new RegExp(`\\bsection\\s*${full}(?![0-9a-z])`, "i").test(title)) return true;
  // 退一步只比主条号：库里的小标题通常只到 `Section 411`，不含 (3)(a)
  const main = target.match(/^\d+[a-z]*/)?.[0];
  if (!main) return false;
  return new RegExp(`\\bsection\\s*${main}(?![0-9a-z])`, "i").test(title);
}

export interface ResolvedCitation {
  /** 在 answer.citations 里的序号（1 开始）。找不到时为 undefined。 */
  ref?: number;
  /** 骨架里原本写的那串，无论找没找到都保留——它本身就是给用户看的信息。 */
  label: string;
  /** 没找到时为 true，展示层要如实标「库里没有这一条」。 */
  missing: boolean;
}

/**
 * 逐条解析骨架里的条号，命中的 chunk 追加进 citations 并回填序号。
 *
 * `citations` 会被**原地追加**（调用方传进来的数组会变长），返回的 map 是
 * `citationKey → ResolvedCitation`。同一条号被多个格子引用时复用同一个序号。
 */
/**
 * 找出库里名字对得上的 chunk。**先严后宽，宽的那一步只在不产生歧义时才算数。**
 *
 * ## 为什么要有"宽"的那一步（2026-09-29）
 *
 * 用户的 CGST 法在库里叫 `ICAI IDTC – GST Law (Central Goods and Services Tax)`
 * ——ICAI（印度特许会计师协会）的汇编本，**标题里没有年份**。
 * 骨架写的是 `CGST Act, 2017`，严格比对要求年份在场，于是整部法都匹配不上，
 * 页面上挂满了「库里没有这一条」，而 Section 107 和 Section 74A 的 chunk
 * 其实都好端端躺在库里。
 *
 * ## 为什么不能干脆把年份规则去掉
 *
 * 年份规则不是洁癖，它在挡一个具体的事故：库里同时有
 * `The Income-tax Act, 1961` 和 `The Income-tax Act, 2025`，
 * 去掉年份两者的核心词就都只剩 `income-tax`，互相匹配，
 * 而 1961/2025 的区分正是整个双条号设计依赖的东西。
 *
 * ## 所以：年份只在**它真的起区分作用**的时候才是必需的
 *
 *   ① 先按完整核心词（含年份）匹配。匹配到了就用，行为和以前完全一样。
 *   ② 一条都没匹配到时，去掉年份再试一次——
 *      但**只有当结果指向唯一一个来源名时才采纳**。
 *      落到两个及以上不同来源（所得税那种情形）就维持"库里没有这一条"：
 *      宁可说没有，也不猜一个年份。
 *
 * 这条规则是自限的：库里只有一部 CGST 法时它生效，
 * 哪天用户又传了一份别的年份的 CGST 汇编，它会自动退回严格模式。
 */
function matchSources(
  sourceHint: string,
  chunks: PublishedKnowledgeChunk[],
): PublishedKnowledgeChunk[] {
  const strict = chunks.filter((c) => sourceMatches(sourceHint, c.source));
  if (strict.length > 0) return strict;

  const withoutYear = sourceHint.replace(/\b(19|20)\d{2}\b/g, " ").trim();
  // 去掉年份之后没剩下东西（hint 本身就只是个年份）→ 不试，那没有任何区分力。
  if (!withoutYear || coreWords(withoutYear).length === 0) return [];

  const loose = chunks.filter((c) => sourceMatches(withoutYear, c.source));
  const distinctSources = new Set(loose.map((c) => c.source));
  // 指向不止一个来源 = 年份在这里是有区分作用的 = 不许猜。
  return distinctSources.size === 1 ? loose : [];
}

export function resolveDisputeCitations(
  keys: string[],
  chunks: PublishedKnowledgeChunk[],
  citations: Array<{ display_title: string; authority: string; locator: string; official_url: string; snippet?: string }>,
): Map<string, ResolvedCitation> {
  const out = new Map<string, ResolvedCitation>();
  for (const key of keys) {
    if (!key || out.has(key)) continue;
    const { sourceHint, section } = parseCitationKey(key);
    const candidates = matchSources(sourceHint, chunks);
    const narrowed = section
      ? candidates.filter((c) => sectionMatches(section, c))
      : candidates;
    // ⚠取**最像的那一个**，不是第一个。
    // 库里可能同时有原始版和修订版（CBDT 那两份备忘录：15% 和 20%），
    // 取第一个就是在赌顺序——赌输了就是 15%/20% 那个错误重演。
    const hit = narrowed.length <= 1
      ? narrowed[0]
      : narrowed.reduce((best, c) =>
        sourceScore(sourceHint, c.source) > sourceScore(sourceHint, best.source) ? c : best);

    if (!hit) {
      out.set(key, { label: key, missing: true });
      continue;
    }

    // 同一份 chunk 可能已经因为检索进过 citations 了，复用它的序号，不重复追加。
    const existing = citations.findIndex(
      (c) => c.display_title === hit.source && c.official_url === hit.officialUrl
        && c.locator === [hit.majorTitle, hit.minorTitle].filter(Boolean).join(" · "),
    );
    if (existing >= 0) {
      out.set(key, { ref: existing + 1, label: key, missing: false });
      continue;
    }

    citations.push({
      display_title: hit.source,
      authority: hit.source,
      locator: [hit.majorTitle, hit.minorTitle].filter(Boolean).join(" · "),
      official_url: hit.officialUrl,
      // snippetDisplay=DENY 的来源不下发原文，和 toCitation 的口径保持一致。
      snippet: hit.snippetDisplay === "DENY" ? undefined : (hit.body ?? "").slice(0, 1_200),
    });
    out.set(key, { ref: citations.length, label: key, missing: false });
  }
  return out;
}

/**
 * 一个 citation 字符串可能写了**好几条**：`"Income-tax Act, 2025 s.356 / s.357 / s.358"`
 * （2025 法把一审拆成 JCIT(A) 和 CIT(A) 两个机关，加上上诉形式那条，一共三条）。
 *
 * 拆成三个独立的 key，每条各挂各的角标。
 * ⚠直接按 `/` 切会把法规名丢掉——切出来的第二段只剩 `" s.357"`。
 * 所以第一段的法规名要**带到后面每一段**上。
 */
export function expandCitationKey(key: string): string[] {
  const text = (key ?? "").trim();
  if (!text) return [];
  const parts = text.split(/\s*\/\s*/).filter(Boolean);
  if (parts.length <= 1) return [text];
  // ⚠只有**后面每一段都长得像条号**时才拆。
  // 否则文号里的斜杠会被当成分隔符：
  //   "CBDT Office Memorandum F.No.404/72/93-ITCC"
  //     → ["F.No.404", "72", "93-ITCC"]   ← 三个都查不到，三个"库里没有"
  // 这种误拆比不拆糟得多——不拆只是少挂一个角标，误拆是凭空造出三条假引用。
  const restAreSections = parts.slice(1).every((p) => /^\s*(?:s|sec|section)\.?\s*\d/i.test(p));
  if (!restAreSections) return [text];
  const { sourceHint } = parseCitationKey(parts[0]);
  return parts.map((part, index) => {
    if (index === 0) return part.trim();
    // 后面几段通常只有 `s.357`，没有法规名，补上第一段的。
    const parsed = parseCitationKey(part);
    return parsed.sourceHint ? part.trim() : `${sourceHint} ${part.trim()}`;
  });
}

/** 从一条骨架里把所有需要解析的条号收集出来（含 stage 级和 cell 级的 override）。 */
export function collectCitationKeys(track: {
  stages?: Array<{ citation?: unknown; cells?: Array<{ citation_override?: string }> }>;
  branches?: Array<{ stages?: Array<{ citation?: unknown; cells?: Array<{ citation_override?: string }> }> }>;
}): string[] {
  const keys: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string") keys.push(...expandCitationKey(value));
    else if (value && typeof value === "object") {
      // 所得税是双条号。**两套都要解析**——旧法条号也可能有人要点开核对，
      // 而且库里两部法都收了。
      for (const v of Object.values(value as Record<string, unknown>)) {
        if (typeof v === "string") keys.push(...expandCitationKey(v));
      }
    }
  };
  const walk = (stages?: Array<{ citation?: unknown; cells?: Array<{ citation_override?: string }> }>) => {
    for (const stage of stages ?? []) {
      push(stage.citation);
      for (const cell of stage.cells ?? []) push(cell.citation_override);
    }
  };
  walk(track.stages);
  for (const branch of track.branches ?? []) walk(branch.stages);
  return [...new Set(keys.filter(Boolean))];
}
