import { classifyDocumentCategory } from "./document-category";

/**
 * 结论下方「关键数值」横排的校验。
 *
 * ## 这块东西为什么需要一个独立模块
 *
 * 2026-09-21 改版把关键数值做成了**全页最大的字**（22px，比结论还大）。
 * 用户问"付特许权使用费要办什么手续"，真正想带走的就是 20%、10%、18%、7个工作日
 * 这几个数——它们本来散落在「法规要求」里，要读完三段才凑得齐。
 *
 * 但把数字放大到这个程度，等于给它最高的可信度背书。`contracts.ts` 里
 * `unverified_claims` 那段注释描述过系统最危险的失败方式：
 * **"有依据的外观 + 无依据的内容"**——模型凭记忆写出一个错误的税率，再挂个最像的角标。
 * 一个凭记忆编出来的数字被放到 22px，正是这种失败的极端形态。
 *
 * 所以这里的立场是：**标签可以信模型，数值一个字都不信。**
 *
 *   label / note  "法定预提税率""未取得 TRC 时适用"——只能由模型写，
 *                 从英文条文里机械截取的短语读不通，这是提示词唯一擅长的部分。
 *   value         必须逐字出现在某条 MANDATORY 步骤的正文里，
 *                 **且不在那条步骤的 unverified_claims 里**。对不上就整条丢弃。
 *
 * 这条链路的关键在于：`unverified_claims` 是 `claim-check.ts` 拿条文原文逐个比对出来的，
 * 不依赖模型自觉。所以"数值出现在某条步骤里、且那条步骤没被判为未核验"
 * 等价于"这个数字在官方条文原文里能找到出处"。
 *
 * ## 为什么不干脆全部确定性提取（不要模型这一层）
 *
 * 试过这条路：`claim-check.ts` 的 `extractCheckableClaims()` 本来就在抓百分比、
 * 天数、表格编号，直接拿来用就行。问题出在标签——机械提取只能给出
 * 「20% · 所得税」这种标签，说不出「法定预提税率」，更说不出「未取得 TRC 时适用」
 * 这个决定性的适用条件。少了适用条件的 20%，用户很容易当成"就是要交 20%"，
 * 而实际上拿到 TRC 就是 10%。**一个没有条件的税率比没有税率更糟。**
 *
 * 所以分工是：提示词负责说人话，确定性逻辑负责兜底。
 *
 * ## 第二道闸：出处对了，还得对题（2026-09-22 补）
 *
 * 上面那道闸只问了一个问题：**这个数字有出处吗？** 实测暴露出它漏了另一半。
 *
 * 用户问「印度 income tax（ITD）案件中，保证金计算的基数包括哪些？」，
 * 答案的结论自己都写着"所得税语境下无直接条文"，
 * 而全页最大的那行字是 **「10% · GST上诉预缴比例」**。
 *
 * 它合法地通过了出处校验——10% 确实逐字出现在一条已核验的 MANDATORY 步骤里，
 * 那条步骤引的是 CGST Rules。**出处是真的，只是答的不是用户问的那个税。**
 *
 * 一个用户没问的法域的数字，被放到全页最高的可信度位置上，
 * 危害不比编造的数字小：用户会以为"所得税上诉要预缴 10%"。
 *
 * 所以加第二道闸：**这个数值所在条目的法律类别，必须落在问题指向的法域里。**
 * 判定两边都来自确定性逻辑——
 *   问题侧：`domain-scope.ts` 的 `detectQuestionCategories()`
 *   条目侧：`document-category.ts` 的 `classifyDocumentCategory()`（拿条目引的法规名）
 *
 * 两头任何一边认不出来（问题看不懂、或法规名归不了类）就**放行**，
 * 和这个项目里其他所有兜底一样：看不懂时放宽，不在没把握的时候乱删。
 */

/** 模型原样输出的一条，还没校验。 */
export interface RawKeyFigure {
  value?: unknown;
  label?: unknown;
  note?: unknown;
}

export interface KeyFigure {
  value: string;
  label: string;
  note?: string;
}

/** 校验时用到的步骤信息。只取需要的字段，避免和 AnswerResponse 强耦合。 */
export interface StepForVerification {
  kind: "MANDATORY" | "PRACTICAL";
  text: string;
  unverified_claims: string[];
  /**
   * 这条要求引到的法规名（可能多部）。用来判它属于哪个法律类别。
   *
   * 为什么传法规名而不是已经算好的类别 id：分类规则只该有一份
   * （`document-category.ts`），调用方各自算一遍迟早会算出不一样的结果。
   */
  sources?: string[];
}

/** 最多展示几个。四个是版面定的：一行四格，再多一格就挤到换行。 */
export const MAX_KEY_FIGURES = 4;

/**
 * 数值的字面归一化。
 *
 * 模型写 "20%"、步骤正文里是 "按20%的税率"——中间没有空格，直接 includes 能命中。
 * 但模型也可能写成 "20 %" 或 "７天"（全角），所以比对前把空白和全角数字抹平。
 *
 * 刻意**不做**单位换算（"7个工作日" vs "7 天" 不算同一个）：
 * 工作日和自然日在报税期限里差好几天，认成同一个会把用户送去迟报。
 * 宁可丢弃这一条，也不猜。
 */
function normalizeForMatch(value: string): string {
  return value
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[％]/g, "%")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * 一个数值是否"有出处"。
 *
 * 条件是两个，缺一不可：
 *   ① 逐字出现在某条 MANDATORY 步骤的正文里
 *   ② 那条步骤的 unverified_claims 里**不包含**这个数值
 *
 * 只要有任意一条步骤同时满足这两条就算通过。为什么是"任意一条"而不是"所有条"：
 * 同一个 20% 可能同时出现在已核验的 A 条和未核验的 B 条里，
 * 这说明它在官方条文里确实找得到出处（A 条证明了），B 条只是引错了角标。
 * 拿 B 条去否决它会把一个正确的数字误杀。
 *
 * 实务建议（PRACTICAL）不算数：它们不要求附条文原句，`quote_status` 是 SKIPPED，
 * 本来就没经过核验，拿它当出处等于没校验。
 */
function findVerifiedSourceStep(
  value: string,
  steps: StepForVerification[],
): StepForVerification | undefined {
  const needle = normalizeForMatch(value);
  if (!needle) return undefined;
  return steps.find((step) => {
    if (step.kind !== "MANDATORY") return false;
    if (!normalizeForMatch(step.text).includes(needle)) return false;
    return !step.unverified_claims.some((claim) => normalizeForMatch(claim) === needle);
  });
}

/**
 * 这条要求的法律类别，落在用户问的法域里吗。
 *
 * 三种情况一律**放行**，因为它们都意味着"没把握"，而这道闸的误杀代价
 * （该露脸的数值消失）不该由没把握的判断来承担：
 *   - 问题的法域认不出来（`questionCategories` 空）
 *   - 这条要求没引任何法规（`sources` 空）
 *   - 法规名归类成了 "other"（分类规则不认识它）
 *
 * 只有当两边都判得明明白白、而且确实不是一个法域时，才丢弃。
 */
function isOnTopic(
  step: StepForVerification,
  options: { questionCategories?: string[]; classify?: (source: string) => string },
): boolean {
  const wanted = options.questionCategories ?? [];
  if (wanted.length === 0) return true;
  const sources = step.sources ?? [];
  if (sources.length === 0) return true;
  const classify = options.classify ?? ((source: string) => classifyDocumentCategory(source, [source]));
  const categories = sources.map(classify).filter((id) => id && id !== "other");
  if (categories.length === 0) return true;
  // 一条要求可能同时引到跨法域的几部法规（例如 DTAA + 所得税法）。
  // **只要有一部落在问题的法域里就算对题**——和 `domain-scope` 里
  // "只要命中任何一个保留域就一定留下"是同一条优先级规则。
  return categories.some((id) => wanted.includes(id));
}

/**
 * 校验并清洗模型给的关键数值。
 *
 * 丢弃的四种情况：字段缺失／数值太长（不像个数值，像抄了半句话）／
 * 在已核验步骤里找不到出处／和前面某条数值重复。
 *
 * 返回空数组时展示层整块不渲染——不留空格子，也不用占位符补齐四格。
 * 只拿到两个有出处的数值就显示两个，比凑四个诚实。
 */
export function verifyKeyFigures(
  raw: unknown,
  steps: StepForVerification[],
  options: {
    /**
     * 问题指向的法律类别（`detectQuestionCategories()` 的结果）。
     * **空数组 = 认不出问题属于哪个法域 → 这道闸整个不生效**，不是"一个都不匹配"。
     */
    questionCategories?: string[];
    /** 注入的分类函数。默认用 `document-category.ts` 那套，测试里可以替换。 */
    classify?: (source: string) => string;
  } = {},
): KeyFigure[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyFigure[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_KEY_FIGURES) break;
    if (!item || typeof item !== "object") continue;
    const { value, label, note } = item as RawKeyFigure;
    if (typeof value !== "string" || typeof label !== "string") continue;
    const v = value.trim();
    const l = label.trim();
    // value 的两道形状闸门：
    //   ① 必须含数字——"关键数值"里没有数字就不是数值，是结论的复述。
    //   ② 不超过 18 字符。最长的合法形态是 "Form 145 Part A"（15）和
    //      "7 个工作日"（6），18 留了余量；而模型失手时塞进来的是
    //      "按20%的税率扣除所得税并于次月7日前缴库"（21）这种半句话，
    //      放到 22px 会把那一行整个撑烂。
    // 先写 24 结果漏过了上面那句 21 字的，是测试把它逼出来的。
    if (!v || !l || v.length > 18 || l.length > 20) continue;
    const key = normalizeForMatch(v);
    // 含数字这一条必须查**归一化后**的字符串：JS 的 \d 只认 ASCII 数字，
    // 拿原串去查会把模型写的全角"２０%"当成"没有数字"直接毙掉。
    // 先写成查原串，被全角那条测试当场抓出来。
    if (!/\d/.test(key)) continue;
    if (seen.has(key)) continue;
    const sourceStep = findVerifiedSourceStep(v, steps);
    if (!sourceStep) continue;
    if (!isOnTopic(sourceStep, options)) continue;
    seen.add(key);
    const n = typeof note === "string" ? note.trim() : "";
    out.push(n && n.length <= 28 ? { value: v, label: l, note: n } : { value: v, label: l });
  }
  return out;
}

/**
 * 给提示词用的说明。放在这里而不是直接写死在 legal-answer.ts 的长字符串里，
 * 是为了让"要求模型怎么做"和"服务端怎么校验"两段文字挨在一起——
 * 它们必须同时改，分在两个文件里迟早会走偏。
 */
export const KEY_FIGURES_PROMPT_RULE = `"key_figures"是结论下方横排展示的关键数值，最多${MAX_KEY_FIGURES}个，用户一眼要带走的就是这几个数。
    - value必须是**逐字出现在你自己写的某条MANDATORY步骤正文里**的数值，例如"20%""10%""18%""7个工作日""Form 145"。
      服务端会逐条比对，对不上的直接丢弃，所以不要写你没在步骤里写过的数。
    - label是这个数字是什么（不超过20字），例如"法定预提税率""IGST反向征税税率"。
    - note是适用条件（不超过28字，可省），例如"未取得TRC时适用""接受方自行申报"。
      ⚠**有适用条件的税率必须写note**：一个不说条件的20%会被用户当成"就是要交20%"，
      而实际上拿到TRC就是10%。没有条件的税率比没有税率更糟。
    - 没有值得单列的数值时给[]，不要为了凑数把无关的数字放进来。`;
