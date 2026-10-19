import type { AnswerResponse } from "../contracts";

/**
 * 相对时限的"锚点"校验。
 *
 * 起因：用户问"公司年度ROC合规要核对哪些事项"，回答里每条时限都是**相对某个事件**的——
 * "AGM后60天内报送年度申报"、"AGM后30天内报送财务报表"、"AGM前至少21天送达报表"。
 * 但通篇没有说 **AGM 本身什么时候必须开**（公司法 s96：财政年度结束后6个月内，
 * 首次AGM为9个月内）。用户拿到"AGM后60天"却不知道AGM的截止日，等于没拿到任何截止日。
 *
 * 这不是某一条法规的问题，是**一整类**问题：合规义务的时限有两种写法，
 * 绝对时限（"财政年度结束后6个月内"）和相对时限（"AGM后60天内"）。
 * 相对时限只有在锚点事件自身的时限也已知时才可用。
 * 换成 GST、所得税、外汇一样成立："收到Notice后30天内答复"、"开票后X天内报送"——
 * 只要锚点事件自身没有时间坐标，用户就排不出日程。
 *
 * 这里只做检测：抽出所有相对时限的锚点，看回答里有没有任何一处给出了这个锚点自身的时间坐标；
 * 没有就在风险提示里点名说明。真正的补救在检索侧（`second-pass.ts` 的缺口提问里
 * 明确要求检查锚点事件的时限条款），这一层是兜底——提示词失效时至少让用户知道缺了什么。
 */

type Step = AnswerResponse["action_steps"][number];

/** "在XX后30日内" / "XX前至少21天" / "自XX之日起60天内"。 */
const RELATIVE_DEADLINE =
  /(?:在|自)?\s*([一-龥A-Za-z][一-龥A-Za-z（）()]{1,15}?)\s*(?:之日起|之后|后|前)\s*(?:至少)?\s*\d+\s*(?:个)?\s*[日天月]/g;

/**
 * 本身就自带时间坐标的锚点，不需要再去找"它什么时候发生"。
 * 分两类：①以历法/存续起点为准的（财政年度结束、公司成立）
 *        ②由外部事件触发、法律不可能规定其发生时间的（收到通知、开具发票、交易发生）
 */
const SELF_ANCHORED = /年度结束|财年|财政年度|历年|成立|设立|注册之日|收到|送达|开具|开票|交易|付款|汇出|签署|配发|发行|批准|核准|生效/;

/** 说明"某事件自身何时必须发生"的绝对时间表达。 */
const ABSOLUTE_TIMING =
  /(?:财政年度|财年|会计年度|历年)结束后\s*\d+\s*(?:个)?\s*[月日天]|每年\s*\d{1,2}\s*月|首个财政年度|自成立之日起\s*\d+/;

function coreTokens(anchor: string): string[] {
  // "股东周年大会（AGM）" → ["股东周年大会", "AGM"]，两种写法都要能对上。
  const parenthetical = [...anchor.matchAll(/[（(]([^）)]+)[）)]/g)].map((match) => match[1].trim());
  const core = anchor.replace(/[（(][^）)]*[）)]/g, "").trim();
  return [core, ...parenthetical].filter((token) => token.length >= 2);
}

/**
 * 返回"被当作时限起点、但回答里没有说明它自身何时发生"的锚点事件名。
 * 没有这类问题时返回空数组。
 */
export function findUnanchoredDeadlines(steps: Step[]): string[] {
  const allText = steps.map((step) => step.text).join("\n");
  const anchors = new Map<string, string[]>();

  for (const step of steps) {
    for (const match of step.text.matchAll(RELATIVE_DEADLINE)) {
      const anchor = match[1]?.trim();
      if (!anchor || SELF_ANCHORED.test(anchor)) continue;
      const tokens = coreTokens(anchor);
      if (tokens.length === 0) continue;
      // 同一个事件常有几种写法："股东周年大会""股东周年大会（AGM）""AGM"。
      // 只要和已记录的锚点有任何一个写法能对上（相等或互为子串），就并进同一条，不重复报。
      const existing = [...anchors.entries()].find(([, known]) =>
        known.some((left) => tokens.some((right) =>
          left === right || left.includes(right) || right.includes(left))));
      if (existing) {
        anchors.set(existing[0], [...new Set([...existing[1], ...tokens])]);
        continue;
      }
      const key = tokens.reduce((a, b) => (a.length <= b.length ? a : b));
      anchors.set(key, tokens);
    }
  }

  const missing: string[] = [];
  for (const [key, tokens] of anchors) {
    // 回答里任何一句同时提到这个事件、并给出了绝对时间坐标，就算锚定住了。
    const anchored = allText.split(/[。\n]/).some((sentence) =>
      tokens.some((token) => sentence.includes(token)) && ABSOLUTE_TIMING.test(sentence));
    if (!anchored) missing.push(key);
  }
  return missing;
}

/** 把检测结果转成写给用户的提示。 */
export function deadlineAnchorNotes(anchors: string[]): string[] {
  if (anchors.length === 0) return [];
  return [
    `本回答中的时限以「${anchors.join("」「")}」为起点计算，`
    + `但未检索到规定该事件本身应在何时完成的条文——只知道相对天数、不知道起点日期，`
    + `仍然排不出具体截止日，请补充核对该事件自身的法定时限。`,
  ];
}
