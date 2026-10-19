/**
 * 《产品规则表 V1.4》§1：不在首页或输入区主动公示范围，
 * 但用户问到范围外问题时，回答中必须说明该领域不在本版回答范围，
 * 不得只给笼统的"暂时无法确认"。本次不扣次。
 *
 * 单独拆成一个文件（而不是留在 route.ts 里），是因为 `detectOutOfScope` 需要在
 * 两个地方各查一次：一次查用户自己打的问题，一次查拼接了Notice事实之后的问题
 * （见下面 DGCA 那条真实事故记录）——拆成纯函数才能在 tests/v14-rules.check.cjs
 * 里直接测，不用把整个 Next.js route.ts（依赖 next/server）拉进测试。
 */
import type { AnswerResponse } from "../contracts";

const POLICY_VERSION = "1.4" as const;

/**
 * 每条规则的**信号强度**，决定它能不能单独把一个问题判出范围外。
 *
 * - `STRONG`：专有名词，几乎不可能是别的意思（DGCA、FSSAI、SEBI、strike off）。
 *   命中即拦。
 * - `WEAK`：**同形异义词**——在范围内的领域里也是常用词（"注销"在 GST 里是注销
 *   登记，在公司法里才是注销公司；"IP" 可以是知识产权，也可以是 IP 地址）。
 *   只有在问题里找不到任何范围内信号时才拦。
 *
 * 为什么要分这两档（2026-09-17 验收测试 #44）：用户问"营业额 800 万、客户要 GSTIN、
 * 我们可以自愿注册吗、**能不能随时注销**"，被裸关键词 `注销` 判成「公司注销与破产」
 * 范围外，直接短路返回，一条 GST 条文都没查。这是一道标准的 GST 自愿注册题（s25(3)）。
 *
 * 根因和 `domain-scope.ts` 里 "annual return" 那次一模一样：**同形词靠单个关键词分不开**。
 * 那边的解法是按法域裁剪候选池，这边的解法是给关键词分档 + 看范围内信号——
 * 都是"不要让一个孤立的词决定整件事"。
 */
type SignalStrength = "STRONG" | "WEAK";

const OUT_OF_SCOPE_RULES: Array<{ label: string; pattern: RegExp; strength: SignalStrength }> = [
  // 英文写法同步补齐（2026-09-20）：原来只有中文词，英文提问时这几条**一条都不命中**，
  // 超范围的问题会被当成范围内一路答下去——生成一份带引用、看起来完整的错答案，
  // 比直接说"不在范围内"危险得多（DGCA 那次事故就是这个形状）。
  { label: "数据保护（DPDP）", pattern: /数据保护|个人信息|隐私|DPDP|数据本地化|data\s*protection|personal\s*data|privacy\s*(?:law|policy|compliance)|data\s*localis/i, strength: "WEAK" },
  { label: "劳动用工与社保", pattern: /劳动|用工|社保|公积金|加班|解雇|裁员|工资法|PF\b|ESI\b|labour\s*law|employment\s*law|provident\s*fund|gratuity|retrenchment|termination\s*of\s*employment|minimum\s*wages|payment\s*of\s*wages/i, strength: "WEAK" },
  { label: "经营许可证", pattern: /营业许可|经营许可证|牌照申请|店铺注册|Shops\s*&?\s*Establishment/i, strength: "STRONG" },
  // 拆成两条：`strike off`/`winding up`/`IBC`/`破产`/`清算` 是明确的公司终止语境；
  // 裸"注销"不是——GST 注销登记（s29）、DIN 注销、IEC 注销都用这个词。
  { label: "公司注销与破产", pattern: /破产|清算|IBC\b|strike\s*off|winding\s*up|公司注销|注销公司/i, strength: "STRONG" },
  { label: "公司注销与破产", pattern: /注销/i, strength: "WEAK" },
  { label: "知识产权", pattern: /商标|专利|版权|知识产权|trademark|trade\s*mark|\bpatent\b|copyright|intellectual\s*property/i, strength: "STRONG" },
  { label: "知识产权", pattern: /\bIP\b/i, strength: "WEAK" },
  { label: "专业税", pattern: /专业税|profession\s*tax/i, strength: "STRONG" },
  // 真实事故（2026-09-15）：用户上传了DGCA（印度民航总局）针对IndiGo航班延误/FDTL排班
  // 合规的Show Cause Notice，提问本身只是"收到这个notice应该怎么办"，不含任何超范围
  // 信号词——超范围信号全部只出现在Notice原文里（DGCA、Aircraft Rules、Flight Duty
  // Period这些词）。当时的检查只跑在拼接Notice事实之前的原始问题上，
  // 没拦住，结果整份Notice被当成税务/GST问题一路跑完检索，生成了一份和民航监管
  // 毫无关系的GST电子运单答案，模型自己虽然在法规要求里加了一句"DGCA指控与GST无关"
  // 的零散提示，但没有真正拦住这次生成——这比直接说"不在范围内"更危险，因为答案
  // 看起来完整、带引用，容易让人误以为真的适用。修复见 app/api/chat/route.ts：
  // Notice事实拼接完成后再查一次 detectOutOfScope，不只是在拼接之前查一次。
  { label: "民航监管（DGCA）", pattern: /\bDGCA\b|民航|航空公司|Aircraft\s*Rules|Flight\s*Duty|适航|civil\s*aviation/i, strength: "STRONG" },
  { label: "环保与污染防治", pattern: /污染|环保|环境许可|Pollution\s*Control|环境影响评价|environmental\s*clearance|environment\s*(?:law|permit)/i, strength: "STRONG" },
  { label: "食品安全（FSSAI）", pattern: /食品安全|FSSAI|food\s*safety/i, strength: "STRONG" },
  { label: "证券市场监管（SEBI）", pattern: /\bSEBI\b|证券交易委员会|上市规则|信息披露违规/i, strength: "STRONG" },
  { label: "电信监管（TRAI）", pattern: /\bTRAI\b|电信监管/i, strength: "STRONG" },
];

/**
 * "这个问题确实是在问我们覆盖的五个领域"的信号。
 *
 * 刻意**比 `domain-scope.ts` 的信号表窄得多**：那边要判"该保留哪些法域的资料"，
 * 宽一点无非多留几条证据；这边要判"要不要整个拒答"，宽了就等于这道闸形同虚设。
 *
 * 所以这里只收**领域专属**的词：`公司`、`合规`、`企业` 这种哪儿都有的词一个不要——
 * 收了的话"我们公司要注销，流程是什么"也会被认成范围内，那道闸就白装了。
 */
/**
 * 2026-09-20 补英文：原来这张表几乎全是中文词，英文提问时基本命中不了。
 * 后果是这道"范围内信号"的**豁免**失效——英文问题一旦碰上弱超范围信号
 * （privacy / labour / IP 这类），就没有东西能把它救回来，会被误拦成超范围。
 *
 * 补的仍然只收**领域专属**词，和中文那半边同一口径：
 * company / business / India 这种哪儿都有的词一个不加，
 * 加了的话 "how do I wind up my company" 也会被认成范围内，这道闸就白装了。
 */
const IN_SCOPE_SIGNALS =
  /GSTIN?|GSTR|进项|销项|抵扣|ITC\b|发票|e-?way|报税|应税|所得税|income\s*tax|\bTDS\b|\bTCS\b|预提|扣缴|转[让移]定价|transfer\s*pricing|\bDTAA\b|税收协定|\bFDI\b|FEMA|\bRBI\b|外资|外汇|汇出|汇入|非居民|FC-?GPR|FC-?TRS|Press\s*Note|海关|报关|清关|关税|进出口|\bIEC\b|保税|公司设立|注册公司|SPICe|\bROC\b|\bMCA\b|董事|股东|章程|年度申报/i;

const IN_SCOPE_SIGNALS_EN =
  /\bGST\b|input\s*tax\s*credit|output\s*tax|tax\s*invoice|e-?invoic|place\s*of\s*supply|reverse\s*charge|composition\s*levy|withholding|advance\s*ruling|permanent\s*establishment|arm'?s\s*length|customs|import\s*duty|export\s*duty|bill\s*of\s*entry|shipping\s*bill|customs\s*valuation|incorporat|private\s*limited|wholly\s*owned\s*subsidiary|articles\s*of\s*association|memorandum\s*of\s*association|annual\s*(?:return|filing)|resident\s*director|board\s*resolution|share\s*(?:capital|transfer|allotment)|foreign\s*(?:investment|exchange|direct)|repatriat|non-?resident|liaison\s*office|branch\s*office|project\s*office/i;

export function hasInScopeSignal(question: string): boolean {
  return IN_SCOPE_SIGNALS.test(question) || IN_SCOPE_SIGNALS_EN.test(question);
}

/**
 * 判断问题是否落在本版回答范围之外。
 *
 * 顺序刻意是"先看强信号、再看弱信号"，不是按数组顺序取第一个命中——
 * 一个问题可能同时命中一条弱规则和一条强规则（"注销一家有商标的公司"），
 * 这时该由强信号说了算。
 */
export function detectOutOfScope(question: string): string | undefined {
  const strong = OUT_OF_SCOPE_RULES
    .find((rule) => rule.strength === "STRONG" && rule.pattern.test(question));
  if (strong) return strong.label;

  // 弱信号：问题里有范围内的专属信号时不拦——那个词多半是顺带提到的，不是问题的主题。
  if (hasInScopeSignal(question)) return undefined;

  return OUT_OF_SCOPE_RULES
    .find((rule) => rule.strength === "WEAK" && rule.pattern.test(question))?.label;
}

export function buildOutOfScopeResponse(id: string, conversationId: string, label: string): AnswerResponse {
  return {
    request_id: id,
    conversation_id: conversationId,
    answer_status: "UNABLE_TO_CONFIRM",
    failure_code: "OUT_OF_SCOPE",
    short_conclusion:
      `${label}不在本版回答范围内，本次不生成印度法律结论，也不扣次数。`
      + `当前覆盖的是公司设立与MCA/ROC、FEMA/FDI/RBI、GST、所得税与转让定价、进出口与海关，`
      + `以及上述领域的行业准入与相关判例。`,
    key_figures: [],
    assumptions: [],
    action_steps: [],
    risks_and_exceptions: [],
    citations: [],
    missing_information: [],
    charge_eligible: false,
    policy_version: POLICY_VERSION,
  };
}
