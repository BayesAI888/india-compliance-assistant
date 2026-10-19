import type { AnswerResponse } from "../contracts";

/**
 * 让"没挂法条依据"的实务建议，尽量在已经确认过的法规要求里找依据。
 *
 * 起因：用户实测发现"召开股东大会，通过特别决议批准发行新股"这条实务建议没有引用角标，
 * 追问"这条建议是从哪来的"。查证据发现：法规要求里第1条（引《Companies Act, 2013》第62条）
 * 原文就写着"须经公司特别决议授权"——这条实务建议根本不是凭空写的，是把"特别决议"这个法律
 * 术语翻译成了"开股东大会"这个具体动作，只是模型忘了在 citation_ids 里挂上对应的 E 编号。
 *
 * 实务建议允许不挂引用是故意的（提示词里明确说了，为的是"找律师""留存文件备查"这类
 * 法条本身不会写、但确实有用的操作经验）。但"忘挂"和"真的没依据"是两回事——
 * 前者应该尽量补上，后者才应该保持空白。
 *
 * 做法：如果一条实务建议的文字里，包含了某条已引用的法规要求文字里出现过的一段连续中文
 * 短语（≥4字），就认为这两条在说同一件事，把那条法规要求的引用"借"给这条实务建议。
 * 找不到重合短语的，保持空引用——这类才是真正的"经验补充"，不该被强行安一个不相关的
 * 引用上去（例如"提前预约估值机构的时间"这种，法条里确实没有对应表述）。
 *
 * 只在服务端确定性地做这一步匹配，不额外调用模型——和这个项目里其它校验的思路一致：
 * 提示词说了"要挂引用"不代表模型每次都记得，能用字符串匹配兜底的就不指望提示词。
 */

type Step = AnswerResponse["action_steps"][number];

const MIN_PHRASE_LENGTH = 4;

/**
 * 光"字符串重合"还不够：同一个问题里几乎每一步都会重复"中资股东""发行新股"这类
 * 案情描述性短语，如果不加约束，"召开董事会会议…向中资股东发行新股的决议"会因为
 * "向中资股东发行新股"这九个字和法规要求里的同一句案情描述重合，被误判成"有依据"——
 * 但董事会先决议这一步，证据原文其实完全没有提到。
 *
 * 真正该被借用引用的重合，应该是"程序性动作"本身（决议、申报、登记、授权……），
 * 不是案情描述。所以重合的那个短语必须包含下面这类词根之一才算数——
 * 这份清单是"合规动作"的通用词汇，不针对某一类具体案情，换个问题（GST申报、TDS扣缴）
 * 一样适用，不需要为每种案情单独维护。
 */
const PROCEDURAL_MARKERS = /决议|批准|授权|备案|登记|申报|提交|出具|注册|章程|通知|表决|审议|核准|核验|留存|存档|签署|变更|扣缴|抵扣|估值|许可|公告|备查|申请|缴纳|退税|减免|豁免|限额|门槛|期限/;

/** 从一段中文文本里取出所有连续中文字符片段内部的 4 字滑窗短语。 */
function chineseFourGrams(text: string): Set<string> {
  const grams = new Set<string>();
  const runs = text.match(/[一-龥]+/g) ?? [];
  for (const run of runs) {
    for (let i = 0; i + MIN_PHRASE_LENGTH <= run.length; i += 1) {
      grams.add(run.slice(i, i + MIN_PHRASE_LENGTH));
    }
  }
  return grams;
}

/**
 * 未挂引用的 PRACTICAL 步骤，尝试从已引用的 MANDATORY 步骤里找重合短语，找到就借用引用。
 * 已经挂了引用的步骤、以及 MANDATORY 步骤本身都不受影响。
 */
export function groundPracticalSteps(steps: Step[]): { steps: Step[]; grounded: string[] } {
  const citedMandatory = steps
    .filter((step) => step.kind === "MANDATORY" && step.citation_refs.length > 0)
    .map((step) => ({ step, grams: chineseFourGrams(step.text) }));

  if (citedMandatory.length === 0) return { steps, grounded: [] };

  const grounded: string[] = [];
  const next = steps.map((step) => {
    if (step.kind !== "PRACTICAL" || step.citation_refs.length > 0) return step;
    const ownGrams = chineseFourGrams(step.text);
    if (ownGrams.size === 0) return step;
    for (const candidate of citedMandatory) {
      const overlaps = [...ownGrams].some((gram) =>
        candidate.grams.has(gram) && PROCEDURAL_MARKERS.test(gram));
      if (overlaps) {
        grounded.push(step.text);
        return { ...step, citation_refs: [...candidate.step.citation_refs] };
      }
    }
    return step;
  });

  return { steps: next, grounded };
}
