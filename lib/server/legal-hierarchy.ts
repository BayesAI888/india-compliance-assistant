/**
 * 法律**位阶**判定与证据配额。
 *
 * ## 和 `document-category.ts` 的区别
 *
 * 那个分的是**法域**（GST / FEMA / 公司法），只用于后台总览的分组展示。
 * 这里分的是**位阶**（Act / Rules / Notification / Circular），参与检索配额和结论校验。
 * 两者正交：一部 CGST Rules 既属于 GST 法域，也属于 Rules 位阶。
 *
 * ## 为什么需要位阶
 *
 * 用户的原话是"怎么保证先搜 Act、再搜 Notification 和 Rule、最后 Circular"。
 * 但**严格按位阶排序会答非所问**：具体数值几乎都在下位法里——税率在 notification、
 * 表格和期限在 rules、实操口径在 circular，Act 只给框架和授权条款。
 * 问"这批货关税税率多少"却先给《海关法》s12（授权中央政府征税），形式最高、实际无用。
 *
 * 所以位阶不用来排序，用来做三件事：
 *
 * 1. **配额保底**：每一层都留名额。知识库里 notification 越堆越多时，
 *    不能让它们把 Act 的召回挤光；反过来，Act 条文长、关键词密，
 *    也不能让它把具体数值所在的 notification 挤光。
 * 2. **结论锚定**：结论必须追得到 Act/Rules 级依据。
 *    notification / circular 只能补具体数值，不能单独支撑一个法律结论。
 * 3. **冲突提示**：下位法与上位法冲突时上位法优先；**circular 尤其特殊**——
 *    它是税务机关的行政解释，约束税务官、**不约束法院**。
 *    拿 circular 当唯一依据是实务上的真坑，法院推翻 CBIC circular 的案例很多。
 */

/** 位阶，数字越小越高。排序和比较都用这个数。 */
export const HIERARCHY_RANK = {
  ACT: 1,
  RULES: 2,
  NOTIFICATION: 3,
  CIRCULAR: 4,
  /** 推断不出来的。**按最低位阶处理**——保守方向，不让来历不明的资料充当结论依据。 */
  UNKNOWN: 5,
} as const;

export type HierarchyLevel = keyof typeof HIERARCHY_RANK;

/**
 * 答案卡片里挂在法条名后面的**短**位阶标签。
 *
 * 和 `HIERARCHY_LABEL` 分开是因为用途不同：那个是后台总览里的完整说明（"规则（Rules /
 * Regulations）"），这个是正文里 11px 的小角标，只能放两个字，多一个字就换行。
 * 两份标签同源于同一个 `HierarchyLevel`，所以不会出现"后台叫规则、前台叫细则"的分裂。
 *
 * UNKNOWN 留空字符串而不是"未知"：推断不出位阶时，与其在每条法条后面挂一个
 * 没有信息量的"未知"，不如什么都不显示。
 */
export const HIERARCHY_SHORT_LABEL: Record<HierarchyLevel, string> = {
  ACT: "法律",
  RULES: "规则",
  NOTIFICATION: "通知",
  CIRCULAR: "通函",
  UNKNOWN: "",
};

export const HIERARCHY_LABEL: Record<HierarchyLevel, string> = {
  ACT: "法律（Act）",
  RULES: "规则（Rules / Regulations）",
  NOTIFICATION: "通知（Notification）",
  CIRCULAR: "通函（Circular / Instruction）",
  UNKNOWN: "未标注位阶",
};

/**
 * 从资料名推断位阶。
 *
 * 印度法律命名极规整，这让推断可行：
 *   The Central Goods and Services Tax **Act**, 2017        → ACT
 *   CGST **Rules**, 2017                                     → RULES
 *   FEMA (Non-debt Instruments) **Rules**, 2019              → RULES
 *   **Notification No.** 09/2026-Central Tax                 → NOTIFICATION
 *   **Circular** No. 41/15/2018-GST                          → CIRCULAR
 *
 * ## 判定的对象是**知识库资料名**，不是通知索引条目
 *
 * 索引里的通知（`notification-index.ts`）建索引时就已经标好了，不走这里。
 * 这个函数只用于知识库里那些**合并版的常设规范**。这个区别决定了下面的顺序。
 *
 * ## 顺序：有名有姓的规范 > 发布它的载体
 *
 * 第一版我把 Notification/Circular 的标记排在最前，理由是"带这些词说明是增量件"。
 * 拿真实资料名一测就错了：
 *
 *     FEMA 395/2019-RB — ...(Mode of Payment...) Regulations, 2019
 *     Income-tax Rules, 2026 (Notification No. 22/2026, G.S.R. 198(E))
 *
 * 这两份都是**一整部常设条例/规则**，`395/2019-RB`、`Notification No. 22/2026`
 * 只是发布它们的通知编号。按第一版的顺序会被判成 NOTIFICATION，
 * 于是失去"可以锚定结论"的资格——而它们恰恰是 FEMA 申报义务和所得税程序的主要依据。
 *
 * 所以改成：**Rules/Regulations 优先于 Notification**。
 * 一份资料的标题里出现了具名的规范（`… Rules, 2017` / `… Regulations, 2019`），
 * 说明它是那部规范本身；只有标题里**只有编号没有规范名**的，才是单纯的通知。
 *
 * Circular 仍排最前：circular 不会有"具名规范"的形态，出现即是 circular。
 */
const PATTERNS: Array<{ level: HierarchyLevel; pattern: RegExp }> = [
  { level: "CIRCULAR", pattern: /\bcirculars?\b|\binstructions?\s+no\b|\btrade\s+notice\b|通函|指示/i },
  // 具名规范优先于发布载体——见上面那段说明
  { level: "RULES", pattern: /\brules?\b|\bregulations?\b|\bscheme\b|\border,?\s*\d{4}\b|规则|条例/i },
  { level: "NOTIFICATION", pattern: /\bnotification\b|\bnotifn?\.?\s*no\b|\bG\.?S\.?R\.?\s*\d|\bS\.?O\.?\s*\d|\bpress\s+note\b|通知/i },
  { level: "ACT", pattern: /\bact\b|\bcode\b|\bconstitution\b|法案?$|法典/i },
];

export function classifyHierarchy(source: string): HierarchyLevel {
  const text = (source ?? "").trim();
  if (!text) return "UNKNOWN";
  for (const { level, pattern } of PATTERNS) {
    if (pattern.test(text)) return level;
  }
  return "UNKNOWN";
}

/** 能不能单独支撑一个法律结论。 */
export function canAnchorConclusion(level: HierarchyLevel): boolean {
  return HIERARCHY_RANK[level] <= HIERARCHY_RANK.RULES;
}

/* ------------------------------------------------------------------ *
 * 配额
 * ------------------------------------------------------------------ */

/**
 * 每一层的**保底**名额（不是上限）。
 *
 * 为什么是保底而不是上限：知识库里各层的资料量差异极大，硬性上限会在
 * "这一层本来就没那么多相关条文"时白白浪费名额。保底只保证
 * **只要这一层有相关证据，就至少留几条给它**，剩下的名额仍然按相关度分。
 *
 * 数字的依据：
 * - ACT 3：结论要锚定在 Act/Rules 上，给少了会出现"结论无法锚定"
 * - RULES 3：程序细节（表格、期限）几乎全在 rules
 * - NOTIFICATION 2：通常只需要一两条（税率、门槛这种点状信息）
 * - CIRCULAR 1：只作补充口径，给多了会挤占真正的依据
 *
 * 这几个数**没有实测调过，是按上面这个逻辑估的初始值**——
 * 上线后要看真实问题的分布重新调，尤其是 notification 在知识库里堆多之后。
 */
export const HIERARCHY_FLOOR: Record<HierarchyLevel, number> = {
  ACT: 3,
  RULES: 3,
  NOTIFICATION: 2,
  CIRCULAR: 1,
  UNKNOWN: 0,
};

export interface RankedChunk {
  source: string;
  score: number;
}

/**
 * 按位阶保底重排候选证据。
 *
 * 做法**不是**"先取 Act 再取 Rules"那种排队——那会把一堆不相关的 Act 条文
 * 塞在前面。而是：
 *   ① 先按相关度全局排序，取前 `limit` 条（正常情况下这就够了）
 *   ② 检查每一层的保底名额有没有被满足
 *   ③ 没满足的层，从该层剩余候选里按相关度补进来，
 *      挤掉**当前入选集合里位阶最低、分数也最低**的那条
 *
 * 也就是说：**相关度仍然是第一位的，位阶只负责不让某一层被完全饿死。**
 * 这和整个项目的取向一致——先保证答得对，再保证答得全。
 */
export function applyHierarchyFloor<T extends RankedChunk>(
  candidates: T[],
  limit: number,
  floor: Record<HierarchyLevel, number> = HIERARCHY_FLOOR,
): T[] {
  if (candidates.length <= limit) return [...candidates];

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selected = sorted.slice(0, limit);
  const rest = sorted.slice(limit);

  const levelOf = (chunk: T) => classifyHierarchy(chunk.source);
  const countIn = (list: T[], level: HierarchyLevel) =>
    list.filter((c) => levelOf(c) === level).length;

  // 位阶从高到低补，高位阶的保底更重要（结论要锚定在它们上面）。
  const levels = (Object.keys(floor) as HierarchyLevel[])
    .filter((l) => floor[l] > 0)
    .sort((a, b) => HIERARCHY_RANK[a] - HIERARCHY_RANK[b]);

  for (const level of levels) {
    let missing = floor[level] - countIn(selected, level);
    if (missing <= 0) continue;
    const pool = rest.filter((c) => levelOf(c) === level);
    for (const candidate of pool) {
      if (missing <= 0) break;
      // 找一条可以被挤掉的：位阶比它低、且不会让那一层跌破保底。
      let victimIndex = -1;
      for (let i = selected.length - 1; i >= 0; i -= 1) {
        const victimLevel = levelOf(selected[i]);
        if (HIERARCHY_RANK[victimLevel] <= HIERARCHY_RANK[level]) continue;
        if (countIn(selected, victimLevel) <= floor[victimLevel]) continue;
        victimIndex = i;
        break;
      }
      if (victimIndex < 0) break;   // 没有能挤的，说明名额已经紧到极限，就此打住
      selected.splice(victimIndex, 1);
      selected.push(candidate);
      rest.splice(rest.indexOf(candidate), 1);
      missing -= 1;
    }
  }

  return selected.sort((a, b) => b.score - a.score);
}

/**
 * 保证**每个位阶至少被检索到一条**（只要候选里确实有）。
 *
 * ## 为什么不用上面那个 `applyHierarchyFloor`
 *
 * 那个是"从一个大候选池里按保底选 N 条"的通用做法。但 `retrieval.ts` 的挑选
 * 不是那个形状：它**按法律要件逐个取前 3 条**，要件之间各有各的额度。
 * 把 picked 和落选的合在一起重排，会打破"每个要件至少 1 条"的保证——
 * 某个要件的唯一证据可能因为分数低被挤掉，那个要件就变成"未覆盖"了。
 * 用错工具的代价是**换来一个位阶、赔掉一个要件**，不划算。
 *
 * 所以这里只做最小干预：**只在某一层一条都没有时才动**，
 * 而且挤掉的对象必须满足两个条件——
 *   ① 它所在的位阶有富余（不会把另一层也清空）
 *   ② 它不是所在要件的最后一条证据（不制造新的未覆盖要件）
 * 两个条件都满足不了就放弃这次补位。**宁可少一层，不可坏掉已有的保证。**
 */
export interface CoverageEntry<T> {
  item: T;
  score: number;
  /** 判位阶用的来源名或已确认的位阶值。 */
  level: HierarchyLevel;
  /** 所属法律要件，用来避免挤掉某个要件的最后一条证据。 */
  element: string;
}

export function ensureHierarchyCoverage<T>(
  picked: Array<CoverageEntry<T>>,
  spare: Array<CoverageEntry<T>>,
): { picked: Array<CoverageEntry<T>>; added: HierarchyLevel[] } {
  const result = [...picked];
  const added: HierarchyLevel[] = [];
  const countLevel = (level: HierarchyLevel) => result.filter((e) => e.level === level).length;
  const countElement = (element: string) => result.filter((e) => e.element === element).length;

  // 只补真正的"实体位阶"，UNKNOWN 不值得为它挤掉一条有位阶的证据。
  const wanted: HierarchyLevel[] = ["ACT", "RULES", "NOTIFICATION", "CIRCULAR"];
  for (const level of wanted) {
    if (countLevel(level) > 0) continue;
    const candidate = spare
      .filter((e) => e.level === level)
      .sort((a, b) => b.score - a.score)[0];
    if (!candidate) continue;   // 候选池里本来就没有这一层，不是被挤掉的

    let victimIndex = -1;
    let victimScore = Infinity;
    for (let i = 0; i < result.length; i += 1) {
      const entry = result[i];
      if (countLevel(entry.level) <= 1) continue;          // 挤了会把那一层清空
      if (countElement(entry.element) <= 1) continue;      // 挤了会让那个要件没证据
      if (entry.score < victimScore) { victimScore = entry.score; victimIndex = i; }
    }
    if (victimIndex < 0) continue;

    result.splice(victimIndex, 1);
    result.push(candidate);
    added.push(level);
  }
  return { picked: result, added };
}

/* ------------------------------------------------------------------ *
 * 结论锚定与冲突提示
 * ------------------------------------------------------------------ */

/**
 * 这次回答有没有"只靠 notification/circular 撑着"的法规要求。
 *
 * 检查的是**每一条 MANDATORY 步骤自己引用的证据**，不是整份回答的证据池——
 * 整体有 Act 不等于这一条有。真实风险是"某一条具体要求全靠一份 circular"，
 * 而整份回答里恰好另有几条引了 Act，看总量完全发现不了。
 */
export function findUnanchoredSteps(options: {
  steps: Array<{ kind: string; text: string; citation_refs: number[] }>;
  /**
   * 第 n 条证据的位阶，下标和 `citation_refs` 的序号对齐（refs 从 1 开始）。
   *
   * 这里收的是**已经解析好的位阶**，不是来源名——调用方那边
   * `resolveHierarchy` 已经把"人工确认值优先、否则推断"这件事做完了，
   * 这个函数再按名字推断一次，会把人工确认过的值丢掉。
   * （第一版就是收来源名，调用方传了位阶值进来，`classifyHierarchy("ACT")`
   * 恰好又能识别回 ACT，**碰巧跑通**——这种代码不能留。）
   */
  citationLevels: HierarchyLevel[];
}): Array<{ text: string; levels: HierarchyLevel[] }> {
  const { steps, citationLevels } = options;
  const out: Array<{ text: string; levels: HierarchyLevel[] }> = [];
  for (const step of steps) {
    if (step.kind !== "MANDATORY" || step.citation_refs.length === 0) continue;
    const levels = step.citation_refs
      .map((ref) => citationLevels[ref - 1])
      .filter((level): level is HierarchyLevel => Boolean(level));
    if (levels.length === 0) continue;
    if (!levels.some(canAnchorConclusion)) {
      out.push({ text: step.text, levels: [...new Set(levels)] });
    }
  }
  return out;
}
