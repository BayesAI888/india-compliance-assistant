import { englishCardinalVariants } from "./english-number";

/**
 * 具体数值的证据校验。
 *
 * 起因是一次真实的错误回答：模型在**没有任何申报条文被检索到**的情况下，
 * 写出"增资后需在60天内通过授权银行提交FC-TRS表格"——表格错了（新发股份是FC-GPR）、
 * 期限也错了（是30天），而且还挂上了角标，角标指向的其实是行业条件那一章。
 *
 * 这类失败最危险：它不是拒答，而是**用有依据的外观包装无依据的内容**。
 * 提示词里虽然写了"每个结论都必须由证据支持"，但没有任何机制去检查模型有没有照做。
 * 这个模块就是那道检查——纯函数，不依赖模型自觉。
 *
 * 只校验"抄错就会出事"的三类硬信息：申报表格编号、天数期限、百分比。
 * 法律判断本身不在这里校验，那不是正则能做的事。
 */

/** 印度合规里常见的申报表格编号。 */
const FORM_PATTERN = new RegExp(
  "\\b("
  + "FC-?GPR|FC-?TRS|FC-?GPR/TRS|LLP-?[IVX]+|"
  + "PAS-?\\d+|MGT-?\\d+|SH-?\\d+|INC-?\\d+|AOC-?\\d+|ADT-?\\d+|DIR-?\\d+|CHG-?\\d+|"
  + "GSTR-?\\d+[A-Z]?|ITR-?\\d+|"
  + "FLA|APR|ODI|ECB-?\\d*|DPT-?\\d+|MSME-?\\d*"
  + ")\\b",
  "gi",
);

/**
 * "30天""15日""7个工作日"这类**期限**。
 *
 * 2026-09-20 实测误报：答案里写"2024年**3月31日**或之前开始生产"，
 * 界面弹出红字「⚠ 31天 未在引用条文中找到出处」。
 * `31日` 是**日历日期的一部分**，不是"31 天之内"这种期限，根本不该进校验。
 *
 * 为什么这种误报特别有害：这条红字的意思是"这个数字可能是模型编的"。
 * 把一个明明正确的日期标成可疑，用户会开始怀疑所有红字；
 * 等真有一条期限抄错了，警示已经没人看了——和 claim-repair.ts 开头记的
 * "警示喊多了就没用了"是同一件事。
 *
 * 判别办法：日历日期的"日"前面一定跟着月份（`3月31日`）；
 * 期限的"日"前面不会有 `月`。所以用逆序环视挡掉 `…月` 开头的那种。
 * 同理挡掉 `年` 直接接数字加日（`2024年31日` 这种写法虽少见，也不是期限）。
 *
 * **逆序环视里必须连数字一起挡**：只写 `(?<![年月])` 时，`3月31日` 的 `3` 被挡住，
 * 引擎会退一位从 `1` 重试——`1` 前面是 `3` 不是月份，于是匹配出 `1日`，
 * 界面就会变成「⚠ 1天 未找到出处」，比原来的 31 更离谱。
 * 写测试跑之前没看出来，是跑出来才发现的。
 *
 * 不用"看后面有没有跟`内`"来判断：期限写成"30日内"最常见，
 * 但"须于 30 日提交"这种不带"内"的写法也有，靠这个判会漏掉真期限——
 * 而漏掉真期限正是这道校验存在的理由。挡掉日期、放过其余，代价更小。
 */
const DEADLINE_PATTERN = /(?<![年月\d])(\d{1,4})\s*个?\s*(?:工作)?\s*[天日]/g;

/** 百分比门槛，例如"外资上限74%"。 */
const PERCENT_PATTERN = /(\d{1,3}(?:\.\d+)?)\s*%/g;

/**
 * 具体的注册身份识别码类主张（目前只有PAN/TAN）——不是编号/期限/百分比那种能直接
 * 比对数值的硬信息，而是"证据里到底提没提过这个东西"这道最基本的关卡。
 *
 * 实测踩过的坑：一条"须申请PAN和TAN"的结论，挂的引用是《生产者公司组建》条款——
 * 字符串核验（quote-check.ts）显示VERIFIED，因为模型抄的那句话确实一字不差地在
 * 证据里，但内容跟PAN、TAN毫无关系。quote-check只管"这句话是否逐字出现"，
 * 不管"是否真的支持这条结论"，这道检查补的就是这个缺口。
 *
 * 按范围先只加这次遇到的PAN/TAN，不做成通用的语义相关性校验；
 * 只在"申请/办理/取得/提交/登记/注册"这类动作词紧挨着PAN/TAN时才算一条主张，
 * 避免PAN只是顺带提到一句（比如"这份证书是申请PAN的材料之一"这种真正有依据的陈述
 * 里恰好出现PAN两个字）就被无差别误伤——这种情况下反而应该照样拦，因为
 * "拿这份证书当PAN申请材料"这个具体说法本身也没有证据支持。
 */
const TOPIC_ACTION_BEFORE = /(?:申请|办理|取得|提交|登记|注册)[^。；;，,]{0,6}(PAN|TAN)\b/g;
const TOPIC_ACTION_AFTER = /\b(PAN|TAN)\b[^。；;]{0,10}(?:申请|办理|取得|提交|登记|注册)/g;
/**
 * 缩写加注的固定写法「中文名称（PAN）」——回答里给缩写补全称就是这么写的
 * （见 abbreviations.ts / 系统提示词规则16），不需要额外找动作词，这个格式本身
 * 就是在断言"这是你需要的这个具体号码/表格"。覆盖"申请PAN和TAN"这种一个动词
 * 管两个宾语、TAN前面挨不到动词的并列句式（PAN先被TOPIC_ACTION_BEFORE命中，
 * TAN靠这条兜底）。
 */
const TOPIC_GLOSS_PAREN = /[一-龥][（(](PAN|TAN)[）)]/g;
const NAMED_TOPIC_EVIDENCE_TERMS: Record<string, RegExp> = {
  PAN: /\bPAN\b|Permanent Account Number/i,
  TAN: /\bTAN\b|Tax Deduction and Collection Account Number/i,
};

function extractTopics(text: string): string[] {
  const found = [
    ...[...text.matchAll(TOPIC_ACTION_BEFORE)].map((match) => match[1]),
    ...[...text.matchAll(TOPIC_ACTION_AFTER)].map((match) => match[1]),
    ...[...text.matchAll(TOPIC_GLOSS_PAREN)].map((match) => match[1]),
  ];
  return [...new Set(found)];
}

export interface CheckableClaims {
  forms: string[];
  deadlines: string[];
  percents: string[];
  topics: string[];
}

function normalizeForm(value: string) {
  return value.replace(/[-\s]/g, "").toUpperCase();
}

/**
 * 印度法条里的期限几乎都写成英文数词——"within thirty days"、"fifteen days"，
 * 而不是阿拉伯数字。只按数字比对会把本来正确的期限误判成"没有出处"，
 * 这种误报比漏报更有害：警示喊多了，真出错时用户也不会信了。
 */

/** 从一条中文步骤里抽出需要核对的硬信息。 */
export function extractCheckableClaims(text: string): CheckableClaims {
  const forms = [...new Set([...text.matchAll(FORM_PATTERN)].map((match) => match[0]))];
  const deadlines = [...new Set([...text.matchAll(DEADLINE_PATTERN)].map((match) => match[1]))];
  const percents = [...new Set([...text.matchAll(PERCENT_PATTERN)].map((match) => match[1]))];
  const topics = extractTopics(text);
  return { forms, deadlines, percents, topics };
}

/**
 * 判断某个数值是否在证据原文里出现过。
 *
 * 天数要求「数字」和「day」同时出现，避免把条号、金额里的数字误判成期限；
 * 百分比要求数字后面跟着 % 或 per cent；
 * 表格编号去掉连字符后比对，容忍 FC-GPR / FCGPR / FC GPR 这类写法差异。
 */
function evidenceSupports(claim: string, kind: keyof CheckableClaims, evidenceText: string, normalizedEvidence: string) {
  if (kind === "forms") {
    return normalizedEvidence.includes(normalizeForm(claim));
  }
  if (kind === "deadlines") {
    if (!/\bdays?\b/i.test(evidenceText)) return false;
    if (new RegExp(`\\b${claim}\\b`).test(evidenceText)) return true;
    // 数字找不到时再按英文数词找一遍（"within thirty days"）。
    return englishCardinalVariants(Number(claim)).some((word) =>
      new RegExp(`\\b${word.replace(/[-\s]/g, "[-\\s]?")}\\b`, "i").test(evidenceText));
  }
  if (kind === "topics") {
    const pattern = NAMED_TOPIC_EVIDENCE_TERMS[claim];
    return pattern ? pattern.test(evidenceText) : true;
  }
  const escaped = claim.replace(".", "\\.");
  return new RegExp(`${escaped}\\s*(?:%|per\\s?cent)`, "i").test(evidenceText);
}

export interface StepLike {
  text: string;
  citation_refs: number[];
}

export interface EvidenceLike {
  body: string;
  majorTitle?: string;
  minorTitle?: string;
}

/**
 * 校验一条步骤里的硬信息是否都能在它引用的证据里找到。
 * 返回找不到出处的那些值；空数组表示全部有据可查。
 *
 * 没标引用的步骤，退回到"全部证据"里找——宁可放宽，也不要因为模型漏标引用
 * 就把一条本来正确的要求标成可疑。
 */
export function findUnverifiedClaims(
  step: StepLike,
  allEvidence: EvidenceLike[],
): string[] {
  const scoped = step.citation_refs.length
    ? step.citation_refs.map((ref) => allEvidence[ref - 1]).filter(Boolean)
    : allEvidence;
  if (scoped.length === 0) return [];

  const evidenceText = scoped
    .map((chunk) => `${chunk.majorTitle ?? ""} ${chunk.minorTitle ?? ""} ${chunk.body}`)
    .join("\n");
  const normalizedEvidence = normalizeForm(evidenceText);

  const claims = extractCheckableClaims(step.text);
  const unverified: string[] = [];
  for (const form of claims.forms) {
    if (!evidenceSupports(form, "forms", evidenceText, normalizedEvidence)) unverified.push(form);
  }
  for (const deadline of claims.deadlines) {
    if (!evidenceSupports(deadline, "deadlines", evidenceText, normalizedEvidence)) {
      unverified.push(`${deadline}天`);
    }
  }
  for (const percent of claims.percents) {
    if (!evidenceSupports(percent, "percents", evidenceText, normalizedEvidence)) {
      unverified.push(`${percent}%`);
    }
  }
  for (const topic of claims.topics) {
    if (!evidenceSupports(topic, "topics", evidenceText, normalizedEvidence)) unverified.push(topic);
  }
  return unverified;
}
