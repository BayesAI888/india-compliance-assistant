/**
 * 首页标准问题的人工审核答案缓存。
 *
 * 这不是 RAG 的通用缓存：只有题目逐字相同、没有附件/期间/上下文时才会命中。
 * 内容由管理员维护，所有法规要求均保留原有的逐条引用；知识库版本变化后自动失效，
 * 避免旧的人工答案在资料更新后继续静默使用。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnswerResponse, Citation } from "../contracts";

export type FeaturedAnswer = Omit<AnswerResponse,
  "request_id" | "conversation_id" | "quota" | "conversation_title" | "reply_deadline"
>;

export interface FeaturedAnswerRecord {
  id: string;
  label: string;
  question: string;
  enabled: boolean;
  answer?: FeaturedAnswer;
  knowledgeVersion: string;
  updatedAt: string;
  updatedBy: "初始审核" | "管理员";
  /** 初始标准答案的版本；管理员保存过的内容不参与自动升级。 */
  seedRevision?: number;
}

interface FeaturedAnswerStoreFile {
  schemaVersion: "1.0";
  records: FeaturedAnswerRecord[];
}

export interface FeaturedAnswerSummary extends FeaturedAnswerRecord {
  fresh: boolean;
}

export interface FeaturedAnswerTextUpdate {
  shortConclusion: string;
  assumptions: string[];
  mandatoryTexts: string[];
  practicalTexts: string[];
  risks: string[];
  caseSearchNote?: string;
  caseClusters?: Array<{ challenge: string; evidence: string[]; takeaway: string }>;
  caseActionPoints?: string[];
}

const dataDirectory = process.env.LOCAL_FEATURED_ANSWER_DIR?.trim()
  || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "featured-answer-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();
const FEATURED_ANSWER_SEED_REVISION = 4;
/**
 * 2026-10-16：用户明确要求用重新审核过的 AMP 判例答案替换首页「判例」缓存。
 *
 * 这是一次**仅限该题、仅限本次种子版本**的内容更正：旧答案把预提税、免税收入
 * 等旁支问题放进了 AMP 判例卡，且只列两案。不能因为它曾经由管理员界面保存过，
 * 就继续让用户命中旧的错误口径。其他标准题仍严格保留管理员编辑内容。
 */
const FORCED_SEED_UPGRADE_IDS = new Set(["cross-border-advertising-cases"]);

const incomeTaxProceeding: Citation = {
  display_title: "Income Tax Department · e-Proceeding",
  authority: "Income Tax Department, Government of India",
  locator: "e-Proceedings FAQ 1–3",
  official_url: "https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/e-proceeding-0",
  snippet: "Using this service, any registered user (or his Authorized Representative) can view and submit responses to any notice / intimation / letter issued by the Income Tax Department.",
};

const gstRule142: Citation = {
  display_title: "Central Goods and Services Tax Rules, 2017",
  authority: "Central Board of Indirect Taxes and Customs",
  locator: "Rule 142(4), FORM GST DRC-06",
  official_url: "https://cbic-gst.gov.in/pdf/01062021-CGST-Rules-2017-Part-A-Rules.pdf",
  snippet: "the reply to any notice, issued under the Act or the rules made thereunder ... shall be furnished in FORM GST DRC-06.",
};

const cgstAppeal: Citation = {
  display_title: "Central Goods and Services Tax Act, 2017",
  authority: "Central Board of Indirect Taxes and Customs",
  locator: "Section 107(1)",
  official_url: "https://cbic-gst.gov.in/pdf/CGST-Act-2017-amended-01012022.pdf",
  snippet: "Any person aggrieved by any decision or order ... may appeal ... within three months from the date on which the said decision or order is communicated to such person.",
};

const incomeTaxAct2025Section280: Citation = {
  display_title: "Income-tax Act, 2025",
  authority: "Income Tax Department, Government of India",
  locator: "Section 280",
  official_url: "https://incometaxindia.gov.in/Documents/Act/Income-tax-Act-2025.pdf",
  snippet: "the period specified in the notice ... shall not be less than thirty days from the date of such notice but shall not exceed three months from the end of the month in which such notice is issued.",
};

const incomeTaxAct2025Section281: Citation = {
  display_title: "Income-tax Act, 2025",
  authority: "Income Tax Department, Government of India",
  locator: "Section 281",
  official_url: "https://incometaxindia.gov.in/Documents/Act/Income-tax-Act-2025.pdf",
  snippet: "on receipt of such notice, the assessee may furnish his reply within such period, as specified therein.",
};

const companiesAct149: Citation = {
  display_title: "The Companies Act, 2013",
  authority: "India Code, Government of India",
  locator: "Section 149(3)",
  official_url: "https://indiacode.gov.in/server/api/core/bitstreams/df47fd71-4078-42b6-8836-c058e60fee27/content#page=106",
  snippet: "Every company shall have at least one director who stays in India for a total period of not less than one hundred and eighty-two days during the financial year.",
};

const fdiSectoralCap: Citation = {
  display_title: "Master Direction – Foreign Investment in India",
  authority: "Reserve Bank of India",
  locator: "Paragraph 5.2.1",
  official_url: "https://rbi.org.in/Scripts/BS_ViewMasterDirections.aspx?id=10190",
  snippet: "Foreign investment in the sectors/ activities given in Schedule I of the NDI Rules is permitted up to the limit indicated against each sector/ activity, subject to applicable laws/ rules/ regulations, security and other conditionalities.",
};

const pressNote3: Citation = {
  display_title: "DPIIT Press Note No. 3 (2020 Series)",
  authority: "Department for Promotion of Industry and Internal Trade",
  locator: "Paragraph 3.1.1(a)",
  official_url: "https://www.dpiit.gov.in/static/uploads/2025/07/c7586a2dee61bf88f73512a46d8a9ab1.pdf",
  snippet: "An entity of a country, which shares land border with India or where the beneficial owner of an investment into India is situated in or is a citizen of any such country, can invest only under the Government route.",
};

const companiesAct62: Citation = {
  display_title: "The Companies Act, 2013",
  authority: "India Code, Government of India",
  locator: "Section 62(1)(a), (c)",
  official_url: "https://www.indiacode.nic.in/bitstream/123456789/2114/5/A2013-18.pdf?v=20260605114304",
  snippet: "such shares shall be offered ... to persons who, at the date of the offer, are holders of equity shares ... or to any persons ... if it is authorised by a special resolution.",
};

const femaReporting: Citation = {
  display_title: "FEMA (Mode of Payment and Reporting of Non-Debt Instruments) Regulations, 2019",
  authority: "Reserve Bank of India",
  locator: "Regulation 4(1), 4(2)",
  official_url: "https://rbi.org.in/SCRIPTS/BS_FemaNotifications.aspx?Id=11723",
  snippet: "The Indian company issuing equity instruments to a person resident outside India shall file Form FC-GPR ... not later than thirty days from the date of issue of the equity instruments.",
};

const femaPricing: Citation = {
  display_title: "FEMA (Non-debt Instruments) Rules, 2019",
  authority: "Reserve Bank of India",
  locator: "Rule 21 – Pricing guidelines",
  official_url: "https://rbi.org.in/Scripts/BS_ViewMasterDirections.aspx?id=10190",
  snippet: "the valuation of equity instruments done as per any internationally accepted pricing methodology for valuation on an arm's length basis duly certified by a Chartered Accountant or a Merchant Banker ... or a practising Cost Accountant, in case of an unlisted Indian Company.",
};

const ewayRule138: Citation = {
  display_title: "Central Goods and Services Tax Rules, 2017",
  authority: "Central Board of Indirect Taxes and Customs",
  locator: "Rule 138(1), (5)",
  official_url: "https://cbic-gst.gov.in/pdf/10112020_CGST-Rules-2017_Part-A_Rules.pdf",
  snippet: "Every registered person who causes movement of goods of consignment value exceeding fifty thousand rupees ... shall, before commencement of such movement, furnish information ... in Part A of FORM GST EWB-01.",
};

const ewayRule138A: Citation = {
  display_title: "Central Goods and Services Tax Rules, 2017",
  authority: "Central Board of Indirect Taxes and Customs",
  locator: "Rule 138A(1)",
  official_url: "https://cbic-gst.gov.in/pdf/10112020_CGST-Rules-2017_Part-A_Rules.pdf",
  snippet: "The person in charge of a conveyance shall carry ... the invoice or bill of supply or delivery challan ... and a copy of the e-way bill in physical form or the e-way bill number ...",
};

const ewayRule138B: Citation = {
  display_title: "Central Goods and Services Tax Rules, 2017",
  authority: "Central Board of Indirect Taxes and Customs",
  locator: "Rule 138B(1)–(3)",
  official_url: "https://cbic-gst.gov.in/pdf/10112020_CGST-Rules-2017_Part-A_Rules.pdf",
  snippet: "The Commissioner ... may authorize the proper officer to intercept any conveyance to verify the e-way bill ... The Commissioner shall get Radio Frequency Identification Device readers installed ... The physical verification of conveyances shall be carried out by the proper officer as authorised.",
};

const incomeTaxAct92B: Citation = {
  display_title: "Income-tax Act, 1961",
  authority: "Income Tax Department, Government of India",
  locator: "Section 92B(1)",
  official_url: "https://incometaxindia.gov.in/Documents/income-tax-act-1961-as-amended-by-finance-act-2025.pdf",
  snippet: "international transaction means a transaction between two or more associated enterprises, either or both of whom are non-residents ...",
};

const incomeTaxAct92F: Citation = {
  display_title: "Income-tax Act, 1961",
  authority: "Income Tax Department, Government of India",
  locator: "Section 92F(v)",
  official_url: "https://incometaxindia.gov.in/Documents/income-tax-act-1961-as-amended-by-finance-act-2025.pdf",
  snippet: "transaction includes an arrangement, understanding or action in concert, whether or not such arrangement, understanding or action is formal or in writing.",
};

const incomeTaxAct92C: Citation = {
  display_title: "Income-tax Act, 1961",
  authority: "Income Tax Department, Government of India",
  locator: "Section 92C(1)",
  official_url: "https://incometaxindia.gov.in/Documents/income-tax-act-1961-as-amended-by-finance-act-2025.pdf",
  snippet: "The arm's length price in relation to an international transaction shall be determined by any of the following methods, being the most appropriate method ...",
};

function reviewedAnswer(answer: Omit<FeaturedAnswer, "policy_version">): FeaturedAnswer {
  return { ...answer, policy_version: "1.4" };
}

function seedRecords(knowledgeVersion: string): FeaturedAnswerRecord[] {
  const now = new Date().toISOString();
  const records: FeaturedAnswerRecord[] = [
    {
      id: "tax-notice",
      label: "税务 Notice",
      question: "收到印度税局Notice应该怎么办？",
      enabled: true,
      knowledgeVersion,
      updatedAt: now,
      updatedBy: "初始审核",
      answer: reviewedAnswer({
        answer_status: "SUFFICIENT",
        evidence_sufficiency: "FULL",
        question_type: "DISPUTE_RESPONSE",
        question_categories: ["income_tax", "gst"],
        short_conclusion: "收到印度税局通知后，应先识别通知类型（所得税或 GST），在法定期限内通过指定门户提交回复；若对通知本身有异议，可先在说明理由程序中申辩，必要时再评估上诉或司法救济。",
        key_figures: [
          { value: "30天–3个月", label: "第280条通知的回复期限", note: "以通知载明的期限为准" },
          { value: "30天", label: "GST Notice 付款或回复的常见窗口", note: "适用 Rule 142 及通知所涉条款时" },
          { value: "3个月", label: "GST 最终决定或命令的通常上诉期限", note: "自决定或命令送达之日起" },
        ],
        assumptions: ["用户为在印度有业务的中资企业，收到的是印度中央税务机关发出的通知。", "通知属于所得税评估、所得税说明理由或 GST 税务程序；具体期限仍以 Notice 原文为准。", "适用通知所载期间内有效的法律。"],
        action_steps: [
          { kind: "MANDATORY", text: "所得税第280条 Notice：在通知指定的期限内提交申报表或回复；期限不得少于通知日起30天，且不得超过通知发出月份结束后的3个月。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "在发出第280条 Notice 前，税务机关应先发出说明理由通知；纳税人可在通知指定期限内提交回复。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "所得税无面评估中，通过注册账户查看电子通信并提交回复；提交后应保存系统确认或回执。", citation_refs: [3], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "GST Notice：适用《CGST Rules》第142条时，可按通知所涉条款在30天内付款并使用 FORM GST DRC-03 告知，或通过 FORM GST DRC-06 提交回复。", citation_refs: [4], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "如已收到 GST 的最终决定或命令，通常可在送达后3个月内向 Appellate Authority 提起上诉；不要把 Notice 回复期与上诉期混为一谈。", citation_refs: [5], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "收到通知后，立即核对通知类型和发出机关，确认是所得税还是 GST，并记录收到日期、编号、税期、金额、指控事项和截止日。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "对于所得税无面评估，登录注册账户查看电子通信并提交回复；对于 GST，按 Notice 指示整理账簿、合同、发票和其他支持文件。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "若对通知的合法性有异议，先在说明理由程序中提交回复，保留所有通信记录和提交凭证；如机关坚持原决定，再由税务律师评估法定上诉或令状救济。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
        ],
        practical_is_sequential: true,
        risks_and_exceptions: ["不同 Notice 的回复机制和期限不同，不能把所有所得税或 GST 通知都按同一个“30天回复期”处理。", "令状救济通常需先评估法定上诉是否可用，以及是否存在管辖、自然正义或其他例外。", "存在即将届满期限、搜查、扣押、冻结或刑事风险时，应立即由印度执业顾问核对 Notice 原件并处理。"],
        citations: [incomeTaxAct2025Section280, incomeTaxAct2025Section281, incomeTaxProceeding, gstRule142, cgstAppeal],
        missing_information: [],
        charge_eligible: true,
      }),
    },
    {
      id: "company-incorporation",
      label: "公司设立",
      question: "在印度设立企业必须有印度人参股吗？",
      enabled: true,
      knowledgeVersion,
      updatedAt: now,
      updatedBy: "初始审核",
      answer: reviewedAnswer({
        answer_status: "SUFFICIENT",
        evidence_sufficiency: "FULL",
        question_categories: ["company_governance", "fema_fdi_rbi"],
        short_conclusion: "在印度设立公司不强制要求有印度人参股，但董事中须至少有一名印度居民；外资持股比例和准入路径受行业限制。",
        key_figures: [{ value: "182天", label: "居民董事在印度的居住要求", note: "一个财政年度内" }],
        assumptions: ["用户拟设立的是私人有限公司或公众公司，而非一人公司（OPC）。", "用户为非印度居民或外国实体。", "适用当前有效的公司法及 FDI 政策。"],
        action_steps: [
          { kind: "MANDATORY", text: "董事居住要求：公司须至少有一名董事在一个财政年度内在印度居住总计不少于182天。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "除 OPC 等特殊公司类型外，公司法并未规定股东必须是印度居民或印度公民；外国自然人和外国法人可作为公司股东，但须满足适用的注册与投资规则。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "确认拟设立公司的行业是否属于 FDI 禁止或限制行业，并核实外资持股上限及准入路径（自动路径或政府审批路径）。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "若投资者或最终受益所有人与中国等印度陆地接壤国家有关，投资通常须走政府审批路径。", citation_refs: [3], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "至少任命一名符合居民董事要求的董事，并准备 DIN（Director Identification Number，董事识别号）和 DSC 等注册材料。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "准备股东身份证明文件：外国自然人提供护照，外国法人提供注册证书及董事会决议，并按规定办理公证认证。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "通过 SPICe+ 表格提交公司注册申请，同时申请董事识别号、公司名称核准及公司注册。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "如涉及政府审批路径，提前向相关行业监管机构或 RBI 申请批准，并将批准文件纳入注册和投资文件包。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
        ],
        practical_is_sequential: true,
        risks_and_exceptions: ["受限制或禁止行业、特定受监管业务及后续股权变动，可能适用额外许可或条件。", "居民董事的居住天数、国籍、税务居民身份是不同概念，不能互相替代。", "股东资格规则不等于 FDI 准入规则；即使可以持股，也须另行核对行业上限、路径和投资人背景。"],
        citations: [companiesAct149, fdiSectoralCap, pressNote3],
        missing_information: [],
        charge_eligible: true,
      }),
    },
    {
      id: "cross-border-advertising-cases",
      label: "判例",
      question: "帮我找一下2026年以前关于跨国公司广告费案例",
      enabled: true,
      knowledgeVersion,
      updatedAt: now,
      updatedBy: "初始审核",
      answer: reviewedAnswer({
        answer_status: "SUFFICIENT",
        evidence_sufficiency: "FULL",
        question_categories: ["income_tax", "transfer_pricing"],
        case_led: true,
        short_conclusion: "AMP（广告、营销和推广）争议的关键，不是广告费金额本身，而是印度子公司是否按与境外关联方的安排承担了品牌建设功能；如构成国际交易，才进入独立交易价格分析。BMW India、A. O. Smith India 和 Samsung India 的裁判分别展示了协议证据、定价方法、Bright Line Test 和费用边界这四个焦点。",
        key_figures: [],
        assumptions: [
          "用户关注的是印度子公司为境外关联方品牌推广发生的 AMP 支出，而非一般广告费扣除或预提税问题。",
          "用户需要的是转让定价争议的判例和实操判断框架，不是针对某一份已收到的调整通知的诉讼意见。",
          "问题中的“2026 年以前”按争议所涉交易年度理解；裁判日期较晚、但审理早年交易的案件可作为参考。",
        ],
        action_steps: [
          { kind: "MANDATORY", text: "先判断是否存在国际交易：只有关联企业之间的交易才进入转让定价规则；单有较高 AMP 支出，不当然证明存在一项需补偿的国际交易。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "核对安排证据：法定“交易”可以来自书面或非书面的安排、谅解或共同行动；品牌使用、营销职责、费用补偿和定价条款必须一起看。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "如已确认存在国际交易，再以最适当方法确定独立交易价格；不能先用广告费占销售额高低，替代交易识别和功能分析。", citation_refs: [3], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "收集与境外关联方的分销、品牌、营销服务、报销和定价协议；逐项标出印度公司是否负有为关联方建设品牌的义务。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "把广告、售后服务、销售奖励和纯运营支出分开建账；不要让不属于品牌建设的项目被整体装进 AMP 成本池。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "按实际商业模式准备功能、资产和风险分析，并说明为何 RPM、TNMM 或其他方法最适当；同时保留可比公司筛选和利润率计算底稿。", citation_refs: [3], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "如收到 TPO 或 DRP 的 AMP 调整，先把本案事实与下方案例逐项对照：是否有安排、费用池是否准确、可比对象是否可比、既有利润是否已经补偿相应功能。", citation_refs: [], unverified_claims: [], quote_status: "SKIPPED" },
        ],
        practical_is_sequential: true,
        risks_and_exceptions: [
          "这些案件不是“所有 AMP 支出都不构成国际交易”的通则；是否存在安排、谁控制营销决策、谁承担风险及印度公司实际利润，都可能改变结论。",
          "Bright Line Test 在案件中常被争论，但不能脱离交易识别、可比性和商业模式单独决定调整金额。",
          "本答案用于案例检索和内部风险排查。已有调整通知、跨境服务费或双边预约定价安排时，应按文件和适用年度单独复核。",
        ],
        citations: [incomeTaxAct92B, incomeTaxAct92F, incomeTaxAct92C],
        related_cases: [
          {
            caseName: "BMW India Pvt. Ltd. v. Addl. CIT",
            docid: "92149929",
            official_url: "https://indiankanoon.org/doc/92149929/",
            court_and_year: "ITAT Delhi · 16 August 2013 · AY 2008-09",
            tax_type_and_authority: "转让定价 · AMP / 营销无形资产争议",
            revenue_position: ["TPO 以超常 AMP 支出为境外关联方建立营销无形资产为由，主张应获得补偿并加成。"],
            final_ruling: ["案件围绕品牌推广安排、AMP 成本池、RPM/TNMM 与既有利润能否补偿功能展开，是 AMP 争议的基础参考。"],
          },
          {
            caseName: "M/s A. O. Smith India Water Products Pvt. Ltd. v. Deputy Commissioner of Income Tax",
            docid: "60361950",
            official_url: "https://indiankanoon.org/doc/60361950/",
            court_and_year: "ITAT Bangalore · 25 July 2024 · AY 2018-19",
            tax_type_and_authority: "转让定价 · AMP 是否构成国际交易及方法选择",
            revenue_position: ["税务机关将 AMP 支出认定为国际交易，并拟作转让定价调整。"],
            final_ruling: ["ITAT 认为在未证明纳税人与关联方存在品牌建设安排时，不能仅凭 AMP 支出认定存在国际交易；对纯分销事实亦讨论了 RPM 的适当性。"],
          },
          {
            caseName: "Samsung India Electronics Pvt. Ltd. v. Addl. CIT, National E-Assessment Centre",
            docid: "46539518",
            official_url: "https://indiankanoon.org/doc/46539518/",
            court_and_year: "ITAT Delhi · 12 August 2026 · AY 2016-17 / 2017-18",
            tax_type_and_authority: "转让定价 · AMP、Bright Line / Intensity 方式及可比性争议",
            revenue_position: ["TPO/DRP 将 AMP 支出作为关联方品牌推广服务处理，并以 Bright Line 或 Intensity 方式作调整。"],
            final_ruling: ["案件审理的是 2016-17、2017-18 年度交易；ITAT 结合本公司既有年度裁判和可比性分析处理 AMP 调整。"],
          },
        ],
        case_search_note: "检索口径：围绕印度子公司为境外关联方品牌推广发生的 AMP 支出；2026 年作出的裁判如审理的是此前年度交易，也一并列入参考。",
        case_digest: {
          clusters: [
            {
              title: "AMP 是否构成国际交易",
              challenge: "税务机关可能将印度子公司的广告、营销和推广支出视为替境外关联方建立品牌，从而要求关联方补偿。",
              evidence: [
                { docid: "92149929", text: "BMW India 案中，TPO 将超常 AMP 支出视为境外关联方品牌推广服务，并主张补偿及加成。" },
                { docid: "60361950", text: "A. O. Smith India 案中，ITAT 着重审查是否存在要求纳税人为关联方进行品牌建设的安排。" },
              ],
              takeaway: "先找协议、安排和实际功能。只有高 AMP/销售额，不能替代对国际交易本身的证明。",
            },
            {
              title: "RPM、TNMM 与利润补偿",
              challenge: "税务机关和纳税人可能对最适当方法、可比对象及既有利润是否已补偿 AMP 功能有不同判断。",
              evidence: [
                { docid: "60361950", text: "A. O. Smith India 案讨论纯分销商事实下 RPM 与 TNMM 的方法选择。" },
                { docid: "92149929", text: "BMW India 案围绕 RPM/TNMM、可比对象及印度实体利润是否已覆盖 AMP 功能展开。" },
              ],
              takeaway: "方法不是标签。先把分销、制造和服务功能拆开，再用同一套事实解释可比性和利润水平。",
            },
            {
              title: "Bright Line 与调整金额",
              challenge: "税务机关可能以可比公司的 AMP/销售额作为基准，测算所谓超常 AMP 支出并加成。",
              evidence: [
                { docid: "92149929", text: "BMW India 案中，Bright Line 的基准、成本池和加成均成为争议焦点。" },
                { docid: "46539518", text: "Samsung India 案中，TPO/DRP 对 AMP 使用 Bright Line 和 Intensity 方式作调整。" },
              ],
              takeaway: "应先检验交易和可比性，不能把一个比例阈值当作独立的结论。",
            },
            {
              title: "AMP 成本池的边界",
              challenge: "售后服务、销售奖励或其他运营成本若被并入 AMP，调整基数会被放大。",
              evidence: [{ docid: "92149929", text: "BMW India 案对售后支持成本、销售人员或经销商奖励等项目是否应进入 AMP 成本池进行了争论。" }],
              takeaway: "费用分类要落到总账、合同和业务目的。成本池错了，后续比例和加成都会失真。",
            },
          ],
          action_points: [
            "核对是否有品牌建设、市场推广或费用补偿安排；没有安排时，保存能够证明独立经营目的的文件。",
            "把 AMP、售后服务、销售奖励和其他运营项目分别建账，并保留项目级证据。",
            "以实际商业模式选择 RPM、TNMM 或其他方法，保留可比公司和利润率计算过程。",
            "收到调整草案时，逐项核验交易识别、成本池、可比性、期间和加成，而不是只争论 AMP 比例。",
            "涉及持续的大额 AMP 或集团统一品牌策略时，及早让印度转让定价顾问复核合同和年度文档。",
          ],
          index: [
            { docid: "92149929", case_name: "BMW India Pvt. Ltd. v. Addl. CIT", official_url: "https://indiankanoon.org/doc/92149929/", angle: "AMP 国际交易、成本池、Bright Line 与 RPM/TNMM" },
            { docid: "60361950", case_name: "M/s A. O. Smith India Water Products Pvt. Ltd. v. Deputy Commissioner of Income Tax", official_url: "https://indiankanoon.org/doc/60361950/", angle: "无品牌建设安排时的 AMP 国际交易认定及 RPM" },
            { docid: "46539518", case_name: "Samsung India Electronics Pvt. Ltd. v. Addl. CIT, National E-Assessment Centre", official_url: "https://indiankanoon.org/doc/46539518/", angle: "早年交易的 AMP、Bright Line / Intensity 和可比性争议" },
          ],
        },
        missing_information: [],
        charge_eligible: true,
      }),
    },
    {
      id: "china-shareholder-capital-increase",
      label: "FEMA / FDI / RBI",
      question: "中资股东向印度公司增资前要做什么准备工作？",
      enabled: true,
      knowledgeVersion,
      updatedAt: now,
      updatedBy: "初始审核",
      answer: reviewedAnswer({
        answer_status: "SUFFICIENT",
        evidence_sufficiency: "FULL",
        question_categories: ["company_governance", "fema_fdi_rbi"],
        short_conclusion: "中资股东向印度公司增资前，需完成公司内部决议、FDI（Foreign Direct Investment，外商直接投资）准入与定价合规，以及向 RBI（Reserve Bank of India，印度储备银行）的申报准备。",
        key_figures: [{ value: "30天", label: "FC-GPR 申报期限", note: "自发行股权工具之日起" }, { value: "7月15日", label: "FLA 年度申报期限", note: "已收到 FDI 的印度公司通常适用" }],
        assumptions: ["本次增资通过配股（rights issue）方式进行。", "印度公司为非上市私人有限公司。", "中资股东为已持有印度公司股份的境外居民。"],
        action_steps: [
          { kind: "MANDATORY", text: "遵守公司法：印度公司向境外居民发行股份（包括配股）必须符合《2013年公司法》的规定。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "遵守行业上限：配股不得导致公司突破适用的行业外资持股上限；同时核对自动路径或政府审批路径。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "定价规则：非上市印度公司向境外居民发行配股的价格不得低于向境内居民提供的价格。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "向境外居民发行股份的价格不得低于按国际公认定价方法进行的公平估值；估值须由特许会计师、SEBI 注册商人银行家或执业成本会计师认证。", citation_refs: [3], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "FDI 申报：印度公司向境外居民发行股权工具且该发行被视为 FDI 的，须在发行之日起30天内提交 FC-GPR 表格。", citation_refs: [4], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "年度申报：已收到 FDI 的印度公司须在每年7月15日前向 RBI 提交 FLA（Foreign Liabilities and Assets Return）年度申报。", citation_refs: [4], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "确认公司所处行业的外资准入路径和行业上限，确保增资后外资持股比例不超限。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "聘请特许会计师或 SEBI 注册商人银行家对拟发行股份进行估值，取得书面估值报告。", citation_refs: [3], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "召开董事会和股东大会，通过配股决议，并确保决议符合《2013年公司法》要求。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "在股份发行后30天内，通过授权银行向 RBI 提交 FC-GPR 表格，完成 FDI 申报。", citation_refs: [4], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "在每年7月15日前提交 FLA 年度申报，报告公司的境外负债和资产情况。", citation_refs: [4], unverified_claims: [], quote_status: "SKIPPED" },
        ],
        practical_is_sequential: true,
        risks_and_exceptions: ["“现有股东配股”与“优先配售”不是同一程序，不能一概要求特别决议。", "中资股东及其最终受益所有人还须核对接壤国家投资规则；如触发，须在发行前走政府审批路径。", "如涉及受监管行业、股权转让、换股或非现金对价，应另行核对适用的 FEMA 和行业规则。"],
        citations: [companiesAct62, fdiSectoralCap, femaPricing, femaReporting],
        missing_information: [],
        charge_eligible: true,
      }),
    },
    {
      id: "gst-e-way-bill",
      label: "GST",
      question: "货票同行在印度具体需要做到哪些要求？",
      enabled: true,
      knowledgeVersion,
      updatedAt: now,
      updatedBy: "初始审核",
      answer: reviewedAnswer({
        answer_status: "SUFFICIENT",
        evidence_sufficiency: "FULL",
        question_categories: ["gst"],
        short_conclusion: "货票同行在印度 GST（Goods and Services Tax，商品与服务税）下，核心是运输工具负责人须随车携带税务发票、供应票据或送货单，以及电子运单（或电子运单号），并接受税务官员的拦截核查。",
        key_figures: [{ value: "₹50,000", label: "通常触发电子运单信息申报的货值门槛", note: "适用 Rule 138 的运输" }],
        assumptions: ["适用中央 GST 规则，州级规则为镜像规定。", "货物运输属于 GST 应税供应或非供应移动，且不属于电子运单豁免情形。"],
        action_steps: [
          { kind: "MANDATORY", text: "随车携带基础单据：运输工具负责人须携带税务发票、供应票据或送货单（视情况而定）。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "随车携带电子运单：运输工具负责人须携带电子运单纸质副本，或电子形式的电子运单号，或映射到嵌入运输工具的 RFID 上。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "进口货物额外单据：进口货物运输时，运输工具负责人还须携带进口商提交的报关单副本，并在电子运单 Part A 中注明报关单号码和日期。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "接受拦截核查：主管官员可在授权下拦截任何运输工具，核查电子运单或电子运单号，适用于邦际和邦内货物移动。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "接受 RFID 核查：税务专员可在需要核查货物移动的地点安装 RFID 读取器；已映射 RFID 的电子运单须通过该读取器核查。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "接受实物核查：主管官员经授权可对运输工具进行实物核查；收到逃税具体信息时，其他官员经批准也可进行实物核查。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "在不需要电子运单的情形，运输工具负责人仍须随车携带依规则开具的税务发票或供应票据副本。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "MANDATORY", text: "发货前确认本次运输是否达到电子运单生成门槛（货物价值超过 ₹50,000，或属于强制生成情形），并提前在公共门户生成电子运单。", citation_refs: [3], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "将电子运单打印纸质副本，或确保司机手机可展示电子运单号，或按税务专员通知要求将电子运单映射到车辆 RFID 设备。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "将税务发票、供应票据或送货单原件或副本交给司机随车携带，确保单据信息与电子运单一致。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "如运输进口货物，将报关单副本交给司机，并在电子运单 Part A 中填写报关单号码和日期。", citation_refs: [1], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "告知司机在途中如遇税务官员拦截，须配合出示电子运单和随车单据，接受核查。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
          { kind: "PRACTICAL", text: "如运输工具需通过设有 RFID 读取器的检查点，确保电子运单已正确映射 RFID，以便自动核查。", citation_refs: [2], unverified_claims: [], quote_status: "SKIPPED" },
        ],
        practical_is_sequential: true,
        risks_and_exceptions: ["电子运单豁免、货值计算、州内运输、有效期及取消条件存在具体规则，不能仅凭本页直接判断所有例外。", "货票与实物、电子运单信息不一致时，可能引发拦截、核查或后续处罚程序。"],
        citations: [ewayRule138A, ewayRule138B, ewayRule138],
        missing_information: [],
        charge_eligible: true,
      }),
    },
  ];
  return records.map((record) => ({ ...record, seedRevision: FEATURED_ANSWER_SEED_REVISION }));
}

function emptyStore(): FeaturedAnswerStoreFile {
  return { schemaVersion: "1.0", records: [] };
}

async function readStore(): Promise<FeaturedAnswerStoreFile> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as FeaturedAnswerStoreFile;
    return Array.isArray(parsed.records) ? parsed : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeStore(store: FeaturedAnswerStoreFile) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, storePath);
}

function serializedMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function ensureSeededStore(knowledgeVersion: string): Promise<FeaturedAnswerStoreFile> {
  return serializedMutation(async () => {
    const store = await readStore();
    const seeds = seedRecords(knowledgeVersion);
    let changed = false;
    for (const seed of seeds) {
      const existingIndex = store.records.findIndex((record) => record.id === seed.id);
      if (existingIndex === -1) {
        store.records.push(seed);
        changed = true;
        continue;
      }

      // 初始版标准答案可随源码安全升级；管理员保存过的版本永远不被种子覆盖。
      // 唯一例外是上面的、用户本轮明确要求替换的 AMP 判例卡。
      const existing = store.records[existingIndex];
      const shouldUpgradeInitialSeed = existing.updatedBy === "初始审核"
        && existing.seedRevision !== FEATURED_ANSWER_SEED_REVISION;
      const shouldApplyExplicitReplacement = FORCED_SEED_UPGRADE_IDS.has(existing.id)
        && existing.seedRevision !== FEATURED_ANSWER_SEED_REVISION;
      if (shouldUpgradeInitialSeed || shouldApplyExplicitReplacement) {
        store.records[existingIndex] = seed;
        changed = true;
      }
    }
    if (changed) await writeStore(store);
    return store;
  });
}

function checkedLines(lines: string[], label: string, maxLines: number): string[] {
  if (!Array.isArray(lines) || lines.length > maxLines) throw new Error(`${label}数量不正确。`);
  return lines.map((line) => {
    const text = typeof line === "string" ? line.trim() : "";
    if (!text || text.length > 1_000) throw new Error(`${label}中有空白或过长内容。`);
    return text;
  });
}

export function featuredKnowledgeVersion(documentIds: string[]): string {
  return [...new Set(documentIds)].sort().join(",");
}

export async function listFeaturedAnswers(knowledgeVersion: string): Promise<FeaturedAnswerSummary[]> {
  const store = await ensureSeededStore(knowledgeVersion);
  return store.records.map((record) => ({ ...copy(record), fresh: record.knowledgeVersion === knowledgeVersion }));
}

export async function findFeaturedAnswer(question: string, knowledgeVersion: string): Promise<FeaturedAnswer | undefined> {
  const store = await ensureSeededStore(knowledgeVersion);
  const record = store.records.find((item) => item.enabled
    && item.answer
    && item.question === question
    && item.knowledgeVersion === knowledgeVersion);
  return record?.answer ? copy(record.answer) : undefined;
}

export async function updateFeaturedAnswer(input: {
  id: string;
  enabled: boolean;
  reviewed: boolean;
  text: FeaturedAnswerTextUpdate;
  knowledgeVersion: string;
}): Promise<FeaturedAnswerRecord> {
  return serializedMutation(async () => {
    const store = await readStore();
    const record = store.records.find((item) => item.id === input.id);
    if (!record || !record.answer) throw new Error("未找到可编辑的标准答案。");
    if (input.enabled && !input.reviewed) {
      throw new Error("启用前请确认已逐条核对编辑文字与锁定法源。");
    }

    const shortConclusion = typeof input.text.shortConclusion === "string" ? input.text.shortConclusion.trim() : "";
    if (!shortConclusion || shortConclusion.length > 2_000) throw new Error("结论不能为空，且不能超过2000字。");
    const assumptions = checkedLines(input.text.assumptions, "适用前提", 5);
    const mandatoryTexts = checkedLines(input.text.mandatoryTexts, "法规要求", 8);
    const practicalTexts = checkedLines(input.text.practicalTexts, "实务建议", 8);
    const risks = checkedLines(input.text.risks, "风险与例外", 8);
    const mandatory = record.answer.action_steps.filter((step) => step.kind === "MANDATORY");
    const practical = record.answer.action_steps.filter((step) => step.kind === "PRACTICAL");
    if (mandatory.length !== mandatoryTexts.length || practical.length !== practicalTexts.length) {
      throw new Error("法规要求或实务建议的条目数量不能改变；如需增删法条，请走资料审核流程。");
    }

    const currentDigest = record.answer.case_digest;
    const caseClusters = input.text.caseClusters;
    if (caseClusters && (!currentDigest || caseClusters.length !== currentDigest.clusters.length)) {
      throw new Error("判例主题数量不能改变；如需增删判例，请走案例库审核流程。");
    }
    const caseActionPoints = input.text.caseActionPoints;
    if (caseActionPoints && (!currentDigest || caseActionPoints.length !== currentDigest.action_points.length)) {
      throw new Error("判例应对要点数量不能改变；如需增删判例，请走案例库审核流程。");
    }
    const checkedCaseClusters = caseClusters?.map((cluster, index) => {
      const existingCluster = currentDigest!.clusters[index];
      const challenge = typeof cluster?.challenge === "string" ? cluster.challenge.trim() : "";
      const takeaway = typeof cluster?.takeaway === "string" ? cluster.takeaway.trim() : "";
      const evidence = checkedLines(cluster?.evidence, `判例主题${index + 1}事实`, existingCluster.evidence.length);
      if (!challenge || challenge.length > 2_000 || !takeaway || takeaway.length > 2_000) {
        throw new Error("判例主题说明不能为空，且不能超过2000字。");
      }
      if (evidence.length !== existingCluster.evidence.length) throw new Error("判例事实条目数量不能改变。");
      return { challenge, takeaway, evidence };
    });
    const checkedCaseActionPoints = caseActionPoints
      ? checkedLines(caseActionPoints, "判例应对要点", 8)
      : undefined;
    const caseSearchNote = input.text.caseSearchNote == null
      ? undefined
      : input.text.caseSearchNote.trim();
    if (caseSearchNote != null && caseSearchNote.length > 2_000) {
      throw new Error("判例检索口径不能超过2000字。");
    }

    let mandatoryIndex = 0;
    let practicalIndex = 0;
    record.answer = {
      ...record.answer,
      answer_status: "SUFFICIENT",
      evidence_sufficiency: "FULL",
      evidence_gap: undefined,
      short_conclusion: shortConclusion,
      assumptions,
      risks_and_exceptions: risks,
      missing_information: [],
      action_steps: record.answer.action_steps.map((step) => step.kind === "MANDATORY"
        ? { ...step, text: mandatoryTexts[mandatoryIndex++] }
        : { ...step, text: practicalTexts[practicalIndex++] }),
      case_search_note: caseSearchNote ?? record.answer.case_search_note,
      case_digest: currentDigest && checkedCaseClusters && checkedCaseActionPoints
        ? {
          ...currentDigest,
          clusters: currentDigest.clusters.map((cluster, index) => ({
            ...cluster,
            challenge: checkedCaseClusters[index].challenge,
            takeaway: checkedCaseClusters[index].takeaway,
            evidence: cluster.evidence.map((entry, evidenceIndex) => ({
              ...entry,
              text: checkedCaseClusters[index].evidence[evidenceIndex],
            })),
          })),
          action_points: checkedCaseActionPoints,
        }
        : record.answer.case_digest,
    };
    record.enabled = Boolean(input.enabled);
    record.knowledgeVersion = input.knowledgeVersion;
    record.updatedAt = new Date().toISOString();
    record.updatedBy = "管理员";
    await writeStore(store);
    return copy(record);
  });
}
