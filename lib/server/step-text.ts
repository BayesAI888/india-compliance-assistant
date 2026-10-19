import type { AnswerResponse } from "../contracts";
import { COMPANY_ALIASES } from "./company-case-query";

/**
 * 去掉法规要求正文开头的「根据《某某法》第X条，」。
 *
 * 这段前缀在界面上是重复信息：法规要求已经**按法律分组**展示（组标题就是法律名），
 * 每条后面还有角标，点开就是条文定位、适用期间和官方原文链接。
 * 正文里再写一遍法律名和条号，一屏里同一个出处出现三次，读起来很乱。
 *
 * 两个刻意的约束：
 *
 * 1. **只在这条步骤确实挂了引用时才删**。没有角标的条目，正文里那句"根据《X》第Y条"
 *    可能是唯一的出处线索，删掉就等于把依据抹掉了——只有在信息确实重复时才算重复。
 * 2. **必须带书名号才算前缀**。"根据上述规定，……"这种没有具体出处的开头不动它，
 *    否则会把句子的主语切掉。
 *
 * 做成确定性后处理而不是只改提示词：这个项目上反复验证过，
 * 「不要写X」这类格式要求靠模型自觉会时有时无，能用字符串处理兜住的就不指望提示词。
 */

type Step = AnswerResponse["action_steps"][number];

/**
 * 匹配「根据/依据/按照《法律名》+ 定位 + 逗号」。
 *
 * 定位部分（第62条 / 第5.2条 / 附件2第6.1段 / 第62条第(1)款 / 第62条和第64条的规定）
 * 用「不含逗号句号的一小段」来兜，并限制长度——放开了写会把整句话吃掉。
 */
const CITATION_PREFIX = /^(?:根据|依据|按照)《[^》]{1,120}》[^，,。；;]{0,40}[，,]\s*/;

export function stripCitationPrefix(text: string): string {
  const stripped = text.replace(CITATION_PREFIX, "");
  // 全被吃掉说明这句话除了出处没有别的内容，那就保持原样，宁可重复也不能删空。
  return stripped.trim().length > 0 ? stripped.trim() : text;
}

/** 对整份步骤列表生效；没挂引用的条目原样保留。 */
export function stripCitationPrefixes(steps: Step[]): Step[] {
  return steps.map((step) => {
    if (step.citation_refs.length === 0) return step;
    const text = stripCitationPrefix(step.text);
    return text === step.text ? step : { ...step, text };
  });
}

/**
 * 去掉步骤正文开头的「第X步：」「Step N:」这类步骤序号前缀。
 *
 * 起因是真实用户反馈：界面本身就会给步骤编号——MANDATORY 按法律分组各自独立编号，
 * PRACTICAL 按数组顺序整体编号、渲染成流程图。模型有时会在正文里另外写一套跨
 * MANDATORY/PRACTICAL 的"全局步骤序号"（例如把"第一步""第四步"分别塞进两组不同
 * 法律的 MANDATORY 里，"第二步""第三步""第五步""第六步"塞进 PRACTICAL 里）——
 * 这套编号和界面自己的编号完全对不上，两节内容看起来像是缺号断层的，
 * 读者分不清哪条是法规要求、哪条是实务建议，法规要求也不该带"第几步"这种
 * 执行语气，它只是在陈述法律规定了什么。
 *
 * 提示词（legal-answer.ts 规则15c）已经明确要求不要这样写，但这个项目反复验证过
 * 「不要写X」这类格式要求靠模型自觉会时有时无，能用字符串处理兜住的就不指望
 * 提示词——这里跟 stripCitationPrefix 同一个原则，再加一道确定性兜底。
 *
 * 和 stripCitationPrefix 不同：这个前缀不管有没有挂引用都要删，因为它不是在
 * 传递出处信息，纯粹是格式噪音。
 */
const STEP_NUMBER_PREFIX = /^(?:第[一二三四五六七八九十百0-9]+步|step\s*\d+)[：:，,、\s]*/i;

export function stripStepNumberPrefix(text: string): string {
  const stripped = text.replace(STEP_NUMBER_PREFIX, "");
  return stripped.trim().length > 0 ? stripped.trim() : text;
}

/** 对整份步骤列表生效，MANDATORY 和 PRACTICAL 都要处理。 */
export function stripStepNumberPrefixes(steps: Step[]): Step[] {
  return steps.map((step) => {
    const text = stripStepNumberPrefix(step.text);
    return text === step.text ? step : { ...step, text };
  });
}

/**
 * 「这次没有判例」这类说法的改写。
 *
 * ## 两次事故，两个不同的根因
 *
 * **第一次（2026-09-17）**：结论里写「本次提供的证据中未包含此类判例」。
 * 问题是措辞——它读起来像**在下结论说印度没有这类判例**，而事实只是"这次检索到的
 * 这几份里没有"。案例库覆盖的是有限样本，把"我没检索到"说成"不存在"，
 * 对合规工具是实质性误导。
 *
 * **第二次（2026-09-18）**：更严重——结论说「本次检索到的证据中未包含具体判例」，
 * 而同一份回答的「相关判例」区块里**明明白白列着三份 CESTAT 判例**。
 *
 * ## 第二次的根因不是词表，是架构
 *
 * 一开始我以为又是漏词（"具体判例"确实不在当时那张词表里）。但真正的原因是：
 * **判例检索和主答案生成是并发跑的**（见 `legal-answer.ts` 的 `relatedCasesPromise`）——
 * 模型在写这份回答时**根本没拿到判例**，它说"我的证据里没有判例"对它自己的输入
 * 而言是**实话**。矛盾是后面把判例区块合并进来时造出来的。
 *
 * 并发是为了不让判例检索拖慢主答案，这个取舍本身是对的。
 * 但它意味着：**模型对"有没有判例"的判断天然不可信，因为它看不到**。
 *
 * ## 所以这道闸改成拿数据说话，不再靠词表穷举
 *
 * `hasCases` 直接来自 `related_cases.length > 0`——这份回答里到底有没有判例，
 * 是个**事实**，不需要猜：
 *
 * - **有判例**：任何"没有判例"的说法都被自己的载荷证伪，改成指向判例区块。
 * - **没有判例**：说法本身没错，只是口径要收住——改成"本次提供的案例并不是所有判例"。
 *
 * 正则仍然要写，但它的职责降级了：只负责**找出这句话在哪**，不负责判断真假。
 * 真假由数据决定。这是这次和前几次"再补几个词"的本质区别。
 *
 * ## 一条刻意留下的边界——以及它 2026-10-13 的升级
 *
 * 否定词和"判例"之间只允许隔 8 个字，为的是**只抓笼统的"没有判例"，
 * 不碰点名某个案子的说法**。比如
 * 「本次检索到的证据中没有找到任何名为 FILCO 的判例」——
 * 这句话是**准确且有用的**（用户问的就是 FILCO 那个案子），
 * 把它改成"相关判例见下方"反而把信息弄丢了。
 *
 * 但 2026-10-13 三星事故说明这条边界用**形式判据**（隔几个字）是错的：
 * 模型写的是「未包含任何名为"三星"的广告费税务诉讼**案件**」——
 * "案件"不在锚定词表里、中间插入语 14 个字也超了 8 字上限，整句漏网。
 * 而这句话和 FILCO 句的本质区别**不是有没有点名，是点名的公司在不在判例区**：
 * 判例区真有两份 Samsung 案时，这句"没有"就是假话；FILCO 场景判例区没有，
 * 那句话就是真的。所以边界从"隔 8 个字"升级为**点名核对**：
 * 句子点名的公司在判例区有案 → 假话，改；不在（或公司不在别名词典、核对不了）→ 保留。
 * 判据说不说谎由判例区数据决定，不再靠措辞形式去猜。
 */
// 「本次…证据中」前缀整体可选：2026-10-13 三星事故的第二分句"**也未**包含法院对
// 广告费扣除的裁判规则"没有"本次"前缀，整句漏网一半。否定句本身就是这道闸的目标，
// 放宽前缀只扩大"未包含…判例/案件/裁判"这类自述的覆盖面，不碰其他句式。
//
// 动词表/尾随组当天两次扩充：模型先写"未**发现**…判例""未**涵盖**…判例"（动词表缺词），
// 又写"**无法提供**…裁决**结果**"（否定词后的"法"字、锚点后的"结果"连写都没罩住）。
// 词表永远追不完模型的写法——所以真正的判据是下面的点名核对：正则只负责把句子
// **找出来**，真假由判例区数据决定。补词只是提高"找得全"的概率。
//
// ⚠"案件"**不在**锚点表里（2026-10-13 晚间撤）：非贪婪 middle 会在引号内的短语上
// 抢匹配——"名为“三星公司广告费**案件**”的具体判例"会被截成前半句，留下
// "”的具体判例"的残尾。不带引号的"广告费案件"句式由下面第二条正则专门接。
const NO_CASE_CLAIM =
  /(?:本次(?:提供|检索到|查到|找到)?的?(?:证据|资料|材料|判例|案例)(?:库)?中?)?(?:未|没有|不|无)(?:法)?(?:能?包含|涵盖|覆盖|涉及|收录|找到|发现|见|提供|列出|提及|论及|包括)([^。；！？，]{0,30}?)(?:判例|案例|先例|判决|诉讼|官司|裁判|裁决|裁定)(?:案件|判例|案例|先例|判决|诉讼|官司|裁判|裁决|裁定|规则|结果|要点|信息|内容|争议焦点|或争议焦点)*/g;

/**
 * "未包含三星的广告费**案件**"这类句式：锚点是"案件"，且插入语里**没有引号点名**。
 *
 * 和上一条的分工：带引号点名的长句（"名为“…”的具体判例"）归上一条——它的锚点是
 * 句尾的"判例"，middle 穿过引号；不带引号的短句归这一条。middle 的字符类显式排除
 * 各类引号，就是为了不和上一条抢同一处匹配（抢了的后果见上一条注释的残尾事故）。
 */
const NO_CASE_CLAIM_PLAIN_CASE =
  /(?:本次(?:提供|检索到|查到|找到)?的?(?:证据|资料|材料|判例|案例)(?:库)?中?)?(?:未|没有|不|无)(?:法)?(?:能?包含|涵盖|覆盖|涉及|收录|找到|发现|见|提供|列出|提及|论及|包括)([^。；！？，""''「」《》]{0,30}?)案件/g;

/** 有判例时的替换：把话引到判例区块去，而不是留一句自相矛盾的否定。 */
const CASE_CLAIM_WITH_CASES = "相关判例见下方「相关判例」";
/** 没判例时的替换：说法没错，但边界要说清——检索结果的边界不等于事实的边界。 */
const CASE_CLAIM_WITHOUT_CASES = "本次提供的案例并不是所有判例";

/**
 * 句子点了某家公司/某个案子的写法（"名为X"、"叫做X"、引号包裹的专名）。
 * 命中它而判例区又没有那家 → 这句话**可能是真的**，不能改。
 */
const NAMED_MENTION = /名为|叫做|称作|“[^”]{2,20}”|《[^》]{2,20}》|「[^」]{2,20}」/;

/** 判例区涉及哪些公司（别名词典的中文键）——从案例名反查，不靠猜。 */
function companiesInCases(cases: Array<{ caseName?: string }>): Set<string> {
  const found = new Set<string>();
  for (const [key, aliases] of Object.entries(COMPANY_ALIASES)) {
    const hit = cases.some((item) => {
      const name = (item.caseName ?? "").toLowerCase();
      return aliases.some((alias) => name.includes(alias.toLowerCase()));
    });
    if (hit) found.add(key);
  }
  return found;
}

function dedupeAdjacentReplacement(text: string, phrase: string): string {
  // 同一句里两处否定都命中时（"未包含…案件，也未包含…裁判规则"），
  // 替换后会得到两句一模一样的指路，合并成一句。中间的"也/并/且"是原文的
  // 连接词，不属于替换文案，一并吃掉。
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`${escaped}[，,。；;、\\s]*(?:也|并|且)?${escaped}`, "g"),
    phrase,
  );
}

export function rewriteCaseEvidenceCaveat(
  text: string,
  hasCases = false,
  cases: Array<{ caseName?: string }> = [],
): string {
  const inCases = companiesInCases(cases);
  // 两条正则共用一个判定器——匹配方式不同（长句锚"判例"、短句锚"案件"），
  // "这句话是真是假"的判据完全一样。
  const decide = (match: string, middle: string): string => {
    if (!hasCases) return CASE_CLAIM_WITHOUT_CASES;
    // 点名核对（2026-10-13）：句子里点了某家公司，而这家公司在判例区**确有案子**
    // → 这句"没有"被自己的载荷证伪，改写成指向判例区块。
    const falsified = [...inCases].some((key) =>
      middle.includes(key)
      || (COMPANY_ALIASES[key] ?? []).some((alias) => middle.toLowerCase().includes(alias.toLowerCase())));
    if (falsified) return CASE_CLAIM_WITH_CASES;
    // 点了名、但判例区没有那家的案子（FILCO 场景）→ 这话可能是真的，原样保留。
    // 公司不在别名词典、没有"名为/引号"结构的笼统否定（"未包含具体判例"）不在此列。
    if (NAMED_MENTION.test(middle)) return match;
    return CASE_CLAIM_WITH_CASES;
  };
  const rewritten = text
    .replace(NO_CASE_CLAIM, decide)
    .replace(NO_CASE_CLAIM_PLAIN_CASE, decide);
  return dedupeAdjacentReplacement(rewritten, CASE_CLAIM_WITH_CASES);
}

/** 对整份步骤列表生效。法规要求和实务建议里都可能出现这句话。 */
export function rewriteCaseEvidenceCaveats(
  steps: Step[],
  hasCases = false,
  cases: Array<{ caseName?: string }> = [],
): Step[] {
  return steps.map((step) => {
    const text = rewriteCaseEvidenceCaveat(step.text, hasCases, cases);
    return text === step.text ? step : { ...step, text };
  });
}

/**
 * 判例区块合并进来之后，把整份回答里所有"没有判例"的说法和事实对齐。
 *
 * **必须在合并判例之后跑**——跑在之前的话 `hasCases` 永远是 false，
 * 等于回到出事前的状态。这也是为什么它单独一个函数、而不是塞进生成链路里。
 *
 * `evidence_gap`（顶部"部分覆盖"横幅里那句话）一并处理——2026-10-13 三星事故里
 * 它同样写着"未包含三星广告费的具体判例"，而判例区列着两条三星案，矛盾一模一样，
 * 只是以前没人管这个字段。
 *
 * 刻意**不动 `charge_eligible`**：这次回答因为那句假话被 `answer-self-doubt.ts`
 * 判成"自陈证据不足"而没扣次。话虽然是假的，但少收用户一次的代价远小于
 * 为了追回一次额度而引入一套"判断当初为什么打折"的状态跟踪。
 * 错在我们这边，就让错误落在对用户有利的一侧。
 */
export function reconcileCaseClaims<T extends {
  short_conclusion: string;
  action_steps: Step[];
  risks_and_exceptions: string[];
  related_cases?: unknown[];
  evidence_gap?: string;
}>(answer: T): T {
  const cases = (answer.related_cases ?? []) as Array<{ caseName?: string }>;
  const hasCases = cases.length > 0;
  const result: T = {
    ...answer,
    short_conclusion: rewriteCaseEvidenceCaveat(answer.short_conclusion, hasCases, cases),
    action_steps: rewriteCaseEvidenceCaveats(answer.action_steps, hasCases, cases),
    risks_and_exceptions: answer.risks_and_exceptions
      .map((item) => rewriteCaseEvidenceCaveat(item, hasCases, cases)),
  };
  if (answer.evidence_gap) {
    (result as { evidence_gap?: string }).evidence_gap =
      rewriteCaseEvidenceCaveat(answer.evidence_gap, hasCases, cases);
  }
  return result;
}
