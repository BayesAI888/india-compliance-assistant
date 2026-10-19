/**
 * 追问扣费覆盖规则。纯函数，不碰会话存储、不碰网络——方便单测，
 * 也让"要不要扣费"这条业务规则集中在一处，不用在 route.ts 里散着写 if。
 *
 * 规则（用户已确认）：
 *   - 判定为"延续上一问题"（CONTINUATION）的追问，本身如果会被扣费，改成不扣费，
 *     直到用完本对话的免费额度
 *   - 判定为"新话题"（NEW_TOPIC）或首问（FIRST）一律按原有规则扣费，不享受追问优惠
 *   - 本身就不会被扣费的回答（NEED_INFORMATION / UNABLE_TO_CONFIRM 等）不消耗免费额度——
 *     省下的是"本来要扣的那一次"，不是"本来就不扣的那一次"
 */
import type { TopicRelation } from "./conversation-store";

/** 每个对话的免费追问上限。 */
export const FREE_FOLLOWUP_LIMIT = 3;

export interface FollowUpChargingInput {
  topicRelation: TopicRelation;
  originalChargeEligible: boolean;
  freeFollowUpsUsed: number;
  limit?: number;
}

export interface FollowUpChargingResult {
  chargeEligible: boolean;
  /** true表示这一轮真的花掉了一次免费额度（用于appendTurn更新计数）。 */
  usedFreeCredit: boolean;
  /** 需要展示给用户的说明，加进risks_and_exceptions；不需要说明时为undefined。 */
  note?: string;
}

export function applyFollowUpCharging(input: FollowUpChargingInput): FollowUpChargingResult {
  const limit = input.limit ?? FREE_FOLLOWUP_LIMIT;

  // 新话题、首问，或者这条回答本来就不会被扣费——不需要覆盖，也不消耗额度。
  if (input.topicRelation !== "CONTINUATION" || !input.originalChargeEligible) {
    return { chargeEligible: input.originalChargeEligible, usedFreeCredit: false };
  }

  if (input.freeFollowUpsUsed >= limit) {
    return {
      chargeEligible: true,
      usedFreeCredit: false,
      note: `本次追问已用完本对话 ${limit} 次免费追问额度，按正常问答扣费。`,
    };
  }

  const remaining = limit - input.freeFollowUpsUsed - 1;
  return {
    chargeEligible: false,
    usedFreeCredit: true,
    note: remaining > 0
      ? `本次追问延续上一问题，不扣费。本对话还剩 ${remaining} 次免费追问额度。`
      : "本次追问延续上一问题，不扣费。本对话的免费追问额度已用完，下次追问将正常扣费。",
  };
}

/**
 * 额度耗尽时，这一轮能不能作为**追问**放行。
 *
 * ## 起因（2026-09-18 用户实测）
 *
 * 用户剩最后 1 次额度，问了一个问题（额度归零），紧接着在**同一个对话里追问**
 * 「技术许可费怎样判断与进口货物的相关性和销售条件，帮我找相关案例」——
 * 被拦下来，提示"本月 3 次提问额度已经用完"。
 *
 * 可是追问本来就有每对话 3 次免费额度（见上面的 `applyFollowUpCharging`）。
 * 问题出在 `route.ts` 里那道闸的位置：
 *
 * ```ts
 * const identity = await identifyRequest(request);
 * if (identity.quota.remaining <= 0) return quotaExhaustedResponse(identity);
 * ```
 *
 * 它跑在**知道这是不是追问之前**，所以免费追问永远走不到计费逻辑。
 * 一个人一旦额度归零，就被冻在半句话上——连"那第3条具体怎么做"都问不了。
 *
 * ## 为什么改闸门而不是改额度
 *
 * **额度的单位是「话题」，不是「请求」。** 用户为一个话题付一次费，
 * 追问是同一个话题的一部分。所以这道闸该问的是"这是不是一个新话题"，
 * 而不是"还有没有余额"。
 *
 * ## 判据全是确定性的，闸门这一步不调模型
 *
 * 模型判 CONTINUATION/NEW_TOPIC 要花一次调用，而这道闸的意义正是"别开始"。
 * 所以这里只用纯函数 `shouldForceNewTopic`（问题够长、不含指代词、
 * 和上一问几乎没有词汇重合 → 判定为新话题）。
 *
 * 四个条件缺一不可：
 * 1. 确实在一个已有对话里，且上一轮有问题可比；
 * 2. 这一轮没有新上传的 Notice——换了份文件就是换了个话题；
 * 3. 本对话的免费追问额度还没用完（上限 3 次，和 `applyFollowUpCharging` 同一个数）；
 * 4. 确定性判据认为它是追问，不是自成一体的新问题。
 *
 * ## 放行之后如果发现是新话题怎么办
 *
 * `route.ts` 在结尾会再检查一次：额度本来是 0、最终却判定要扣费，
 * 就把答案换成额度耗尽提示。白白花掉一次模型调用，但付费墙不能破。
 * 前置判据已经把这种情况压得很少了。
 *
 * ## 被滥用的上限是多少
 *
 * 最多每个对话多给 3 次——就是 `FREE_FOLLOWUP_LIMIT` 本身，不是新开的口子。
 * 而且要骗过 `shouldForceNewTopic`，问题必须和上一问高度重合或带指代词，
 * 那本来就是真追问的样子。
 *
 * 成本不对称也支持这么改：**误拦一次合法追问，用户被冻在半句话上；
 * 误放一次，损失一次检索开销。** 后者便宜太多。
 */
/**
 * 额度闸门自己的重合度门槛，**刻意比 `question-context.ts` 里判计费那条松得多**
 * （那条是 0.2）。
 *
 * 为什么不共用一个数：两个判断的代价结构完全不同。
 *
 * - **计费判定**问的是"这算不算新话题、该不该收钱"。判松了 → 真的新话题被当成追问，
 *   白给一次；判紧了 → 追问被收费，用户会抱怨但答案照给。两边代价接近。
 * - **额度闸门**问的是"要不要直接把人挡在门外"。判紧了 → 用户被**冻在半句话上**，
 *   连"那第3条怎么做"都问不了；判松了 → 多跑一次检索，而且 `route.ts` 结尾还有
 *   一道复查（最终判定要扣费就换回额度耗尽提示），付费墙并不会破。
 *   代价严重不对称，所以这道闸该宽。
 *
 * 0.08 这个数来自真实事故：用户的追问
 * 「技术许可费怎样判断与进口货物的相关性和销售条件，帮我找相关案例」
 * 和上一问的重合度是 **0.185**——差一点点没过 0.2，就被当成新话题拦掉了。
 * 它显然是同一个话题的追问。和 0.2 一样，这个数也是估的，
 * 真正该做的是拿线上对话回归校准，这里如实记下来。
 */
export const QUOTA_BYPASS_OVERLAP_THRESHOLD = 0.08;

export interface FollowUpBypassInput {
  /** 这一轮之前，这个对话里上一问的自足版问题。没有上一轮就传 undefined。 */
  previousSelfContainedQuestion?: string;
  /** 这一轮用户打的问题原文。 */
  question: string;
  /** 本对话已用掉的免费追问次数。 */
  freeFollowUpsUsed: number;
  /** 这一轮有没有新上传并成功解析的 Notice。 */
  hasNewNoticeUpload: boolean;
  /** 词面重合度计算函数，注入进来方便单测。 */
  overlapRatio: (question: string, previousQuestion: string) => number;
  /** 问题里有没有"那个/上面说的"这类指代词——有就一定是追问。 */
  hasReferringExpression: (question: string) => boolean;
  limit?: number;
  overlapThreshold?: number;
}

export function canBypassQuotaAsFollowUp(input: FollowUpBypassInput): boolean {
  const previous = input.previousSelfContainedQuestion?.trim();
  if (!previous) return false;
  if (input.hasNewNoticeUpload) return false;
  if (input.freeFollowUpsUsed >= (input.limit ?? FREE_FOLLOWUP_LIMIT)) return false;
  // 带指代词的一定是追问，不用再看重合度（"那第3条具体怎么做"和上一问几乎没有共同词）。
  if (input.hasReferringExpression(input.question)) return true;
  const threshold = input.overlapThreshold ?? QUOTA_BYPASS_OVERLAP_THRESHOLD;
  return input.overlapRatio(input.question, previous) >= threshold;
}
