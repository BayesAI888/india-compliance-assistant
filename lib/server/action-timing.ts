import type { AnswerResponse } from "../contracts";

/**
 * 「要做的事」必须带时间。
 *
 * 用户的要求：实务建议要让非合规专业的人能照着做，凡是涉及申报、报送、开会、缴款这类
 * 动作，都必须写清楚**什么时候之前做完**。只写"向ROC报送年度申报"而不写期限，
 * 读的人不知道现在该不该动手，这条建议的可操作性就是零。
 *
 * 时间信息本身的**准确性**已经由 `claim-check.ts` 保证（天数要逐字出现在引用的条文里，
 * 对不上会被标出来），`deadline-anchor.ts` 又保证了相对时限有起点。
 * 这一层补的是最后一个缺口：**有没有写**。
 *
 * 只检测明确的"办事"动词（提交、报送、召开、缴纳……），不检测"编制""留存""确认"
 * 这类没有法定时点的准备性动作——那些强行要求写时间反而会逼模型编造期限。
 */

type Step = AnswerResponse["action_steps"][number];

/**
 * 明确指向某个"要在某时点前完成"的动作。
 * 刻意只收动词性很强的词：「申报」「登记」「备案」这些经常作名词用
 * （"年度申报的内容包括…"），收进来会大量误报。
 */
const ACTION_VERBS = /提交|报送|递交|呈报|缴纳|召开|送达|申请办理|办理登记|报备/;

/** 具体的时间表达：必须带数字或明确的日历坐标，"尽快""及时"不算。 */
const TIME_EXPRESSION =
  /\d+\s*(?:个)?\s*[日天月年](?:内|以内|之内|前|以内完成)?|前至少\s*\d+|每年\s*\d{1,2}\s*月|财政年度结束[后前]|之日起\s*\d+|同一日|当日|同时(?:完成|提交|报送)/;

export interface TimingGap {
  /** 步骤在 action_steps 里的序号（从 1 开始），供提示定位。 */
  index: number;
  /** 截断后的步骤文字，方便用户对上号。 */
  excerpt: string;
}

/** 找出"有动作、但没写时间"的步骤。 */
export function findMissingActionTiming(steps: Step[]): TimingGap[] {
  const gaps: TimingGap[] = [];
  steps.forEach((step, index) => {
    if (!ACTION_VERBS.test(step.text)) return;
    if (TIME_EXPRESSION.test(step.text)) return;
    gaps.push({
      index: index + 1,
      excerpt: step.text.length > 24 ? `${step.text.slice(0, 24)}…` : step.text,
    });
  });
  return gaps;
}

/** 汇总成一条给用户看的提示。全部带了时间就返回空数组。 */
export function actionTimingNotes(gaps: TimingGap[]): string[] {
  if (gaps.length === 0) return [];
  return [
    `以下步骤涉及申报或会议，但本次检索到的条文中没有对应的时限规定，未标注截止时间，`
    + `执行前请另行确认：${gaps.map((gap) => `第${gap.index}条「${gap.excerpt}」`).join("；")}。`,
  ];
}
