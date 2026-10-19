/**
 * 「这份答案的证据够不够」——由模型**申报**，服务端据此决定降级与扣次。
 *
 * ## 背景：这个模块解决的是什么问题
 *
 * 验收里有一批题（#34 ECB 新规条文缺失、#58 CGST s74A 条文缺失、#79、#94、#95），
 * 症状完全一样：**结论里模型自己承认了证据不足，状态仍然是 SUFFICIENT、仍然扣次**。
 * 用户看到的是一份带绿色"依据充分"标签、带引用角标的答案，看起来是有依据的。
 * 这比答错更伤信任。
 *
 * ## 改法变过一次：从"猜措辞"改成"读字段"（2026-09-22）
 *
 * 第一版是拿正则去匹配模型写的中文，比如
 * `本次检索到的(证据|资料) … (未|没有)(包含|涵盖|找到)`。
 *
 * 它在 2026-09-22 的实测里整道失效了。模型写的是：
 *
 *   > 本次检索到的证据**未直接规定**所得税上诉保证金的计算基数……
 *
 * `规定` 不在动词表里（表里是 包含|涵盖|找到|提供|列出），于是没认出来，
 * 状态留在 SUFFICIENT、扣了 1 次。第二句"在所得税语境下**无直接条文**"也没认出来
 * ——那是名词句式，正则只认动词。
 *
 * **差一个词，整道闸失效，而且失效是静默的。**
 * 到那次为止，这张措辞表已经因为漏词补过五轮。措辞表是人手写的，
 * 模型的中文写法是无穷的，它永远会漏下一种。
 *
 * 所以改成让模型**直接申报一个枚举字段**，代码读字段，不再猜措辞。
 *
 * ## 这么做的代价，以及为什么还是这么做
 *
 * 读字段等于**信任模型对自己的评价**——模型完全可能一边写着"未直接规定"，
 * 一边给自己打 FULL。这和本项目"提示词不可靠，能确定性兜底就不指望提示词"
 * 的一贯做法是相反的，属于**明知代价的取舍**（2026-09-22 产品方拍板）。
 *
 * 权衡在于两种错的性质不同：
 *   - 正则漏词 → 闸门**整个失效**，而且没人知道它失效了。
 *   - 模型误报 → 单次判断错，且模型没有把"我没找到"说成"我找到了"的动机
 *     （它在结论正文里照样会写出来，用户看得见）。
 *
 * 一句话：宁可要一个偶尔判错、但一直在工作的闸，不要一个看起来在工作、
 * 实际上因为差一个词已经停摆的闸。
 *
 * ## 这不是根治
 *
 * 上面那几道题缺的东西——ECB Master Direction、CGST s74A、Customs Valuation Rules、
 * 所得税上诉预缴的 CBDT 备忘录——**在知识库里本来就不存在**。
 * 这个模块只保证"缺了的时候系统不装作没缺"，真正的修复是把资料补进去。
 */

/**
 * 模型对本次证据覆盖程度的申报。
 *
 * - `FULL`    —— 问题的各个要件都有证据支撑，可以正常出结论。
 * - `PARTIAL` —— **主干答得出来，但某个子问题缺证据。**
 *                答案仍然有用，所以状态不降级；**扣次与 FULL 相同**
 *                （2026-10-13 用户决策：主干结论有依据、缺口已如实挂在
 *                evidence_gap 里说明并展示给用户，这仍是一份完整交付、
 *                可以据此行动的答案，此前"不扣次"的规则废除）；
 *                同时把这条限制提到风险提示第一条（别让它埋在长结论里）。
 * - `NONE`    —— **问题的核心要件全都没有证据**，给不出任何有依据的结论。
 *                降级 UNABLE_TO_CONFIRM，不扣次——那是"没给出答案"，不是"答案不完整"。
 *
 * PARTIAL 和 NONE 分开是必要的：验收 #58 在说完"没有 s74A 条文"之后，
 * **实打实地答对了问题的主干**（FY2022-23 适用 s74，并给出了条件和罚则）。
 * 把它一律降级成"暂时无法确认"，等于把一份有用的答案作废，用户什么也拿不到。
 */
export type EvidenceSufficiency = "FULL" | "PARTIAL" | "NONE";

const VALID: readonly string[] = ["FULL", "PARTIAL", "NONE"];

/**
 * 把模型给的原始值收成枚举。认不出来时返回 `undefined`（**不是 FULL**）。
 *
 * 区分"没报"和"报了 FULL"很重要，见 `adjustForSelfDoubt` 里对 undefined 的处理。
 */
export function parseEvidenceSufficiency(raw: unknown): EvidenceSufficiency | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toUpperCase();
  return VALID.includes(value) ? (value as EvidenceSufficiency) : undefined;
}

/** 提到风险提示第一条的那句话。放在最前面，是因为长结论里这句最容易被跳过。 */
export const SELF_DOUBT_RISK_NOTE =
  "本次检索到的资料没有完整覆盖这个问题，下面的结论只在已引用条文的范围内成立，落地前请另行核实。";

export interface SelfDoubtAdjustment {
  /** 需要把状态降级成 UNABLE_TO_CONFIRM 吗。 */
  downgrade: boolean;
  /**
   * 这次还能不能扣次。PARTIAL 与 FULL 同待遇（2026-10-13 起）；
   * NONE（降级作废）和「模型没报」（覆盖无从判断）不扣。
   */
  chargeEligible: boolean;
  /** 要不要在风险提示最前面插一条说明。 */
  prependRiskNote: boolean;
}

/**
 * 按申报值决定怎么处理这份答案。
 *
 * ## 模型没报字段时为什么不扣次
 *
 * 字段缺失意味着**这一轮的证据覆盖程度无从判断**——可能是 JSON 截断，
 * 可能是模型忽略了这条规则。此时：
 *   - 不降级：没有证据说明这份答案不好，作废它是过度反应。
 *   - **但也不扣次**：两种错的代价不对称——
 *     "该扣没扣"用户不会有感觉，"不该扣却扣了"是直接拿走用户的额度。
 *     一个连自己够不够格都说不清的回合，不该收费。
 *   - 不加风险提示：我们没有具体的话可说，硬加一句只会变成每次都出现的噪音。
 */
export function adjustForSelfDoubt(
  sufficiency: EvidenceSufficiency | undefined,
  currentChargeEligible: boolean,
): SelfDoubtAdjustment {
  if (sufficiency === "FULL") {
    return { downgrade: false, chargeEligible: currentChargeEligible, prependRiskNote: false };
  }
  if (sufficiency === "PARTIAL") {
    // 2026-10-13 用户决策：部分覆盖照常扣次。主干有依据、缺口已如实说明并展示，
    // 用户拿到的是一份完整交付的答案——"不完整"不等于"没交付"。
    // 不降级、风险提示照加（这条限制必须让用户看见），只有计费改成与 FULL 一致。
    return { downgrade: false, chargeEligible: currentChargeEligible, prependRiskNote: true };
  }
  if (sufficiency === undefined) {
    return { downgrade: false, chargeEligible: false, prependRiskNote: false };
  }
  // NONE：核心要件全无证据，答案降级作废，不扣次。
  return { downgrade: true, chargeEligible: false, prependRiskNote: true };
}

/**
 * 判例优先类问题的申报修正：**用户明确在找判例、判例区又确实有货时**，
 * 把模型申报的 NONE 提为 PARTIAL。
 *
 * 2026-10-13 实测事故：问"帮我找三星公司的广告费案件"，判例区列出了三星 AMP 案
 * （digest 正常归纳出两个风险主题），状态却是「暂时无法确认」+「本次不扣次数」——
 * 因为模型写答案时**看不到判例**（判例检索与主答案并发），它申报 NONE 的依据是
 * 知识库法规证据（库里确实没有三星案的法规条文），那句话对它自己的输入是实话。
 * 但降级把判例这一路已经交付的实质内容也一起否定了——用户视角就是"判例白找了"。
 *
 * 边界（三条都满足才提，缺一条都不动）：
 *   ① 问题本身在找判例（isCaseSeekingQuestion）——判例是答案的主干，不是附录；
 *   ② 判例区非空——主干真的交付了；
 *   ③ 模型报的是 NONE——FULL/PARTIAL 不动。
 * 普通业务问题（"GST进项抵扣怎么算"）即使顺带触发了判例检索也**不提**：
 * 那种题的证据主体是法规，法规全无证据时给"依据充分"章是把用户往坑里带。
 *
 * 这里先提成 PARTIAL 而不是直接 FULL：本函数运行时只有候选案例名称，尚未完成
 * `case-digest` 的相关性复核；先避免 NONE 导致整份回答被丢弃。之后在
 * `legal-answer.ts` 确认案例仍保留在 `related_cases` 时，才会按“找判例”的实际
 * 交付目标升为 FULL 并清除伪缺口。这样既不让无关案例抬高状态，也不把已交付的
 * 相关判例错误标成“部分覆盖”。
 */
export function liftSufficiencyWhenCasesFound(
  sufficiency: EvidenceSufficiency | undefined,
  isCaseSeeking: boolean,
  hasCases: boolean,
): EvidenceSufficiency | undefined {
  if (isCaseSeeking && hasCases && sufficiency === "NONE") return "PARTIAL";
  return sufficiency;
}

/**
 * 给提示词用的说明。和上面的枚举放在同一个文件里，
 * 是为了让"要求模型怎么报"和"服务端怎么处理"必须一起改。
 */
export const EVIDENCE_SUFFICIENCY_PROMPT_RULE =
  `"evidence_sufficiency"申报本次证据对这个问题的覆盖程度，三选一，**不得省略**：
    - "FULL"：问题的各个要件都有证据支撑。
    - "PARTIAL"：主干答得出来，但某个子问题在证据里找不到依据。
      ⚠除“用户明确在找判例且下方已给出直接相关案件”的场景外，只要你在结论或风险里写了
      "证据未涵盖／未直接规定／无直接条文／本库未收录"这一类话，哪怕只是一句附带说明，
      这里就**必须**报 PARTIAL，不能报 FULL。
    - "NONE"：问题的核心要件全都没有证据，给不出任何有依据的结论。
      此时 answer_status 也应为 UNABLE_TO_CONFIRM。
      ⚠如果用户明确在找判例，且下方"已确认相关的判例"清单列出了直接相关的案件，
      判例就是已经交付的实质内容。不要因为法规原文没有逐条写出某项判例规则而报 PARTIAL：
      这类问题应报 FULL，且不得把“相关判例见下方”写进 evidence_gap。只有问题中另有一项
      明确限定（例如指定公司、指定期间或指定争点）确实没有案件覆盖时，才报 PARTIAL，
      并准确写明缺的那一项。
    报 PARTIAL 或 NONE 不会被当成你答得不好——如实申报不受任何惩罚；
    而把缺证据的答案报成 FULL，用户会拿到一份盖着"依据充分"章的残缺答案。
    "evidence_gap"报 PARTIAL 或 NONE 时**必填**，一句话说清**缺的是哪一块**，
    不超过 40 字。要具体到子问题，写成"本次证据里没有 XX"的形式，
    例如"本次证据未涵盖电子运单轻微笔误的免罚情形"。
    ⚠不要写"证据不足""部分内容缺失"这种同义反复——那等于没说。
    报 FULL 时留空。`;
