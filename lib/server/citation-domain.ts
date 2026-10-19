/**
 * 引用的**法域闸门**：不让一条要求挂上别的税种的法条角标。
 *
 * ## 事故（2026-09-29）
 *
 * 用户问：「收到 GST 税局关于电子运单与实际货物不符的处罚令，应该怎么办」。
 * 答案里第一条要求是：
 *
 *   > 核对罚款金额：货物所有人主动缴纳罚款的，罚款为应纳税额的 200%；
 *   > 未主动缴纳的，罚款为货物价值的 50% 或应纳税额的 200% 中较高者。
 *
 * 这是 **CGST Act s.129** 的内容，一个字都不涉及所得税。
 * 但它挂的角标里有 **Income-tax Act, 2025**，而且因为「法律」位阶最高，
 * 整条被归到了「所得税 / DTAA」标题底下。
 *
 * 分组那一层已经单独修过（`primaryCitation` 先法域后位阶），但那只治了标题。
 * **角标还在**——一条 GST 规则盖着所得税法的章。
 * 这比"没有出处"更糟：这个产品的核心纪律是「有出处的和没出处的不能长得一样」，
 * 而**错的出处比没有出处更危险**，它看起来完全合格。
 *
 * ## 根因不在这一层
 *
 * 真正的根因是检索：所得税法 s.439 那段「罚款为**应纳税额**的 50%/200%」
 * 和 GST 的罚则措辞高度雷同，被召回进了证据池，模型就拿它当依据了。
 * 这个模块不修检索，它是**出口处的兜底**——和这个项目里其他几道闸一样，
 * 装在单一出口上，而不是指望提示词让模型别引错。
 *
 * ## 规则（2026-09-29 用户拍板）
 *
 * **同一条要求里，只要还有属于本法域的引用，就把法域外的引用剔掉。**
 *
 * 三条边界，方向都是"宁可不剔，也不制造新的空白"：
 *
 *   ① **问题法域认不出来（空数组）→ 一条都不剔。**
 *      认不出法域时收窄，等于拿一个没根据的判断去删有根据的东西。
 *
 *   ② **整条要求的引用全在法域外 → 一条都不剔。**
 *      剔空了这条要求就变成"无依据"，在界面上和模型瞎编的东西长得一样。
 *      而且"一条 GST 问题的要求，依据全是所得税法"本身是个强信号，
 *      留着它比抹掉它更有助于发现问题。
 *
 *   ③ **法律正式名认不出类别（`other`）→ 当作本法域，不剔。**
 *      通函、备忘录、行业指南的名字五花八门，判不出来是常态。
 *      判不出来就删，会把大量合法引用误伤掉——这正是
 *      `domain-scope.ts` 里记的那五次误剔事故的教训。
 *
 * ## 代价
 *
 * 跨法域的**次要参照**会被一并剔掉（GST 问题里引海关法解释估价）。
 * 接受这个代价，因为：那部法仍然出现在页面底部的引用清单里，没有消失；
 * 而"给 GST 规则盖所得税法的章"是实打实的错误陈述，两者不在一个量级。
 */

import { lawCategoryOfTitle } from "../law-categories";

interface StepLike {
  citation_refs: number[];
}

interface EvidenceLike {
  source?: string;
}

/**
 * 剔掉法域外的角标。返回新数组，不改原对象。
 *
 * @param steps               已经定稿的要求/建议
 * @param evidence            下标对应角标序号 - 1（和 `citations` 同一套编号）
 * @param questionCategories  会话级法域。空数组 = 认不出来 = 不收窄。
 */
export function pruneCrossDomainRefs<T extends StepLike>(
  steps: T[],
  evidence: EvidenceLike[],
  questionCategories: string[],
): T[] {
  if (questionCategories.length === 0) return steps;

  return steps.map((step) => {
    const kept = step.citation_refs.filter((ref) => {
      const source = evidence[ref - 1]?.source;
      // 角标指向不存在的证据：交给别处处理，这里不碰。
      if (!source) return true;
      const category = lawCategoryOfTitle(source);
      // 判不出类别的一律留下。见上面边界 ③。
      if (category === "other") return true;
      return questionCategories.includes(category);
    });
    // 边界 ②：全在法域外时原样返回，不剔。
    if (kept.length === 0 || kept.length === step.citation_refs.length) return step;
    return { ...step, citation_refs: kept };
  });
}
