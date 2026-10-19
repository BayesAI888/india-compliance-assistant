/**
 * 知识库覆盖缺口自检：**问题打到了一个我们没有底层法律的领域时，明说出来。**
 *
 * ## 起因：2026-09-17 验收测试的头号根因
 *
 * 100 题里 77 道不通过。我一开始判断是"检索召回不全"——打分排后了、配额挤掉了。
 * 查下来不是：引用条数中位只有 6 条，上限是 12，**配额根本没打满**。
 *
 * 真正的原因是**要引的法，库里没有**。验收表「官方来源索引」列的 30 个官方来源，
 * 约 13 个不在知识库里，77 道不通过的题里有 47 道栽在这上面。最典型的两个：
 *
 * - **Customs Act, 1962 一部都没有**。进出口 10 题只能拿 FTP（对外贸易政策）硬答，
 *   通过率 10%。s46 报关单、s47(1) 放行条件、s17 自评税、s128 上诉期全部引不出来。
 * - **FEMA 395/2019-RB（Mode of Payment and Reporting Regulations）没有**。
 *   FC-TRS 60 日、Form DI 30 日、Form CN 30 日这些申报时限就规定在这部法里，
 *   于是 7 道 FEMA 题清一色被判"缺申报时限"。
 *
 * ## 为什么光补资料不够，还要写这个模块
 *
 * 补资料能解决今天这 47 道题。但这次事故真正吓人的地方不是"缺资料"，
 * 而是**缺了资料系统一声不吭**：它拿相邻的法（FTP 代替海关法、NDI Rules 代替
 * Mode of Payment 条例）生成了一份**带引用角标、状态标着"依据充分"**的答案。
 * 用户看不出这份答案的法律底座根本不在。
 *
 * 一个合规工具最不能做的就是这件事。所以这道闸的职责不是"补上缺口"，
 * 是保证**缺口永远可见**——今天缺海关法，明天换一批资料缺别的，它一样会吭声。
 *
 * ## 设计
 *
 * 一张「题域 → 这个领域的地基法律」注册表，写死在代码里，和 `law-supersession.ts`
 * 同一个思路：**不依赖任何人记得去填某个字段**。回答生成前拿已发布资料的标题比对，
 * 缺了就把缺口写进风险提示，并且**不扣次**。
 *
 * 刻意只登记"地基法律"——没有它这个领域就答不了的那种，不登记补充材料。
 * 登记得太细会天天报警，报警天天有就等于没有。
 */
import type { PublishedKnowledgeChunk } from "./knowledge-store";

export interface CoverageRequirement {
  /** 触发这条检查的问题信号。 */
  questionSignals: RegExp;
  /** 这个领域的地基法律，按已发布资料标题匹配。 */
  law: RegExp;
  /** 缺失时写给用户看的名字。 */
  displayName: string;
  /** 缺了会答不出什么——写具体，别写"可能不全"这种等于没说的话。 */
  consequence: string;
}

export const COVERAGE_REQUIREMENTS: CoverageRequirement[] = [
  {
    questionSignals: /报关|清关|海关|关税|完税价格|进口|出口|customs|bill\s*of\s*entry|shipping\s*bill|保税|暂定评估|SVB/i,
    law: /customs act/i,
    displayName: "Customs Act, 1962（印度海关法）",
    consequence: "报关单、货物放行、自评税、暂定评估、没收与罚款、海关上诉期限这些法定程序，本次无法给出条文依据",
  },
  {
    questionSignals: /完税价格|海关估价|关联方.{0,6}(?:进口|定价|估价)|特许权使用费|customs\s*valuation|\bSVB\b/i,
    law: /customs valuation/i,
    displayName: "Customs Valuation Rules, 2007（海关估价规则）",
    consequence: "关联方交易的完税价格认定、特许权使用费是否计入完税价格，本次无法给出条文依据",
  },
  {
    questionSignals: /FC-?GPR|FC-?TRS|Form\s*DI\b|Form\s*CN\b|\bSMF\b|FIRMS|外资.{0,8}申报|股权转让.{0,8}(?:申报|备案)|下游投资/i,
    law: /mode of payment|395\/2019/i,
    displayName: "FEMA 395/2019-RB（Mode of Payment and Reporting Regulations, 2019）",
    consequence: "FC-GPR、FC-TRS、Form DI、Form CN 的申报时限与表格要求，本次无法给出条文依据",
  },
  {
    questionSignals: /Form\s*(?:48|145|146|41|56|57|58|59)\b|3CEB|转[让移]定价.{0,8}(?:申报|表格|报告)/i,
    law: /income[-\s]?tax rules,?\s*2026/i,
    displayName: "Income-tax Rules, 2026（Notification No. 22/2026）",
    consequence: "Form 48（原 3CEB）等所得税表格的填报要求与时限，本次无法给出条文依据",
  },
  {
    questionSignals: /\bECB\b|外债|境外借款|external\s*commercial\s*borrowing/i,
    law: /external commercial borrowing/i,
    displayName: "RBI Master Direction – External Commercial Borrowings",
    consequence: "ECB 的贷款人资格、利率上限、最低平均期限与 Form ECB 申报要求，本次无法给出条文依据",
  },
];

export interface CoverageGap {
  displayName: string;
  consequence: string;
}

/**
 * 检查本次问题所属领域的地基法律在不在已发布资料里。
 *
 * 只看**问题里出现了信号**的那几条：没问海关的问题，不该因为库里没海关法就报警。
 */
export function findKnowledgeCoverageGaps(
  question: string,
  publishedChunks: Pick<PublishedKnowledgeChunk, "source">[],
  requirements: CoverageRequirement[] = COVERAGE_REQUIREMENTS,
): CoverageGap[] {
  if (!question.trim()) return [];
  const sources = [...new Set(publishedChunks.map((chunk) => chunk.source))];
  const gaps: CoverageGap[] = [];
  for (const requirement of requirements) {
    if (!requirement.questionSignals.test(question)) continue;
    if (sources.some((source) => requirement.law.test(source))) continue;
    gaps.push({ displayName: requirement.displayName, consequence: requirement.consequence });
  }
  return gaps;
}

/**
 * 缺口写成给用户看的一句话。
 *
 * 措辞刻意说"本知识库暂未收录"，不说"印度没有这样的规定"——
 * 这两件事差得远，混为一谈正是这次事故里最危险的那部分。
 * 和 `step-text.ts` 把"证据里没有此类判例"改写成"本次提供的案例并不是所有判例"
 * 是同一个道理：**检索结果的边界不等于事实的边界。**
 */
export function coverageGapNotes(gaps: CoverageGap[]): string[] {
  return gaps.map((gap) =>
    `本知识库暂未收录《${gap.displayName}》，${gap.consequence}。`
    + `下面的内容来自其他已收录法律，不能替代该法的规定，落地前请以官方原文为准。`);
}
