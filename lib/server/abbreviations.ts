/**
 * 缩写首次出现时补全称。
 *
 * 印度合规里缩写极其密集（ROC / SEBI / FC-GPR / DPIIT…），中文读者未必知道对应什么机构或表格，
 * 而同一个缩写在不同语境下含义可能完全不同（例如 AD 既可能是 Authorised Dealer，
 * 也可能是别的东西）。首次出现时补上英文全称，读者可以自己核。
 *
 * 刻意做成**确定性的后处理**而不是提示词要求：缩写是一个封闭集合，
 * 靠模型每次记得写会时有时无——这条经验在这个项目上已经反复验证过了。
 */

export interface Abbreviation {
  /** 英文全称。 */
  en: string;
  /** 中文释义，缩写本身不足以说明用途时补上。 */
  zh?: string;
}

/** 分组只用于管理端展示，不影响展开逻辑。 */
export type AbbreviationGroup = "监管机构" | "法律与制度" | "表格与证件";

const GROUP_OF: Record<string, AbbreviationGroup> = {
  ROC: "监管机构", MCA: "监管机构", SEBI: "监管机构", RBI: "监管机构", DPIIT: "监管机构",
  NCLT: "监管机构", CBDT: "监管机构", CBIC: "监管机构", ITAT: "监管机构", AAR: "监管机构",
  FEMA: "法律与制度", FDI: "法律与制度", ODI: "法律与制度", GST: "法律与制度",
  CGST: "法律与制度", SGST: "法律与制度", IGST: "法律与制度", UTGST: "法律与制度",
  TDS: "法律与制度", TCS: "法律与制度", DTAA: "法律与制度", ITC: "法律与制度",
  SEZ: "法律与制度", MSME: "法律与制度", LLP: "法律与制度",
  AGM: "法律与制度", EGM: "法律与制度", KMP: "法律与制度",
  CSR: "法律与制度", NBFC: "法律与制度",
};

export const ABBREVIATIONS: Record<string, Abbreviation> = {
  // 监管机构
  ROC: { en: "Registrar of Companies", zh: "公司注册处" },
  MCA: { en: "Ministry of Corporate Affairs", zh: "公司事务部" },
  SEBI: { en: "Securities and Exchange Board of India", zh: "印度证券交易委员会" },
  RBI: { en: "Reserve Bank of India", zh: "印度储备银行" },
  DPIIT: { en: "Department for Promotion of Industry and Internal Trade", zh: "工业和内贸促进部" },
  NCLT: { en: "National Company Law Tribunal", zh: "国家公司法法庭" },
  CBDT: { en: "Central Board of Direct Taxes" },
  CBIC: { en: "Central Board of Indirect Taxes and Customs" },
  ITAT: { en: "Income Tax Appellate Tribunal" },
  AAR: { en: "Authority for Advance Rulings" },

  // 法律与制度
  FEMA: { en: "Foreign Exchange Management Act, 1999" },
  FDI: { en: "Foreign Direct Investment", zh: "外商直接投资" },
  ODI: { en: "Overseas Direct Investment" },
  GST: { en: "Goods and Services Tax", zh: "商品与服务税" },
  CGST: { en: "Central Goods and Services Tax" },
  SGST: { en: "State Goods and Services Tax" },
  IGST: { en: "Integrated Goods and Services Tax" },
  UTGST: { en: "Union Territory Goods and Services Tax" },
  TDS: { en: "Tax Deducted at Source", zh: "源泉扣缴" },
  TCS: { en: "Tax Collected at Source" },
  DTAA: { en: "Double Taxation Avoidance Agreement", zh: "避免双重征税协定" },
  ITC: { en: "Input Tax Credit", zh: "进项税抵扣" },
  SEZ: { en: "Special Economic Zone", zh: "经济特区" },
  MSME: { en: "Micro, Small and Medium Enterprises" },
  LLP: { en: "Limited Liability Partnership", zh: "有限责任合伙" },

  // 会议与角色（非专业读者最容易卡住的几个）
  AGM: { en: "Annual General Meeting", zh: "股东周年大会" },
  EGM: { en: "Extraordinary General Meeting", zh: "临时股东大会" },
  KMP: { en: "Key Managerial Personnel", zh: "关键管理人员" },
  CSR: { en: "Corporate Social Responsibility", zh: "企业社会责任" },
  NBFC: { en: "Non-Banking Financial Company", zh: "非银行金融机构" },

  // 表格与证件
  "AOC-4": { en: "Form for filing financial statement", zh: "财务报表申报表" },
  "MGT-7": { en: "Annual Return", zh: "年度申报表" },
  "MGT-7A": { en: "Abridged Annual Return", zh: "小型公司简化年度申报表" },
  "ADT-1": { en: "Notice of appointment of auditor", zh: "审计师委任申报表" },
  "DPT-3": { en: "Return of deposits", zh: "存款及借款年度申报表" },
  "MSME-1": { en: "Half-yearly return for outstanding dues to MSME", zh: "对中小微企业欠款半年报" },
  "DIR-3": { en: "Application for Director Identification Number", zh: "董事识别号申请表" },
  "DIR-12": { en: "Particulars of appointment of directors and KMP", zh: "董事及高管变更申报表" },
  "GSTR-1": { en: "Details of outward supplies", zh: "销项明细申报表" },
  "GSTR-3B": { en: "Summary return of GST", zh: "GST月度汇总申报表" },
  "GSTR-9": { en: "GST Annual Return", zh: "GST年度申报表" },
  "GSTR-9C": { en: "GST Reconciliation Statement", zh: "GST年度对账表" },
  "15CA": { en: "Information to be furnished for payments to a non-resident", zh: "对外付汇申报表" },
  "15CB": { en: "Certificate of an accountant for foreign remittance", zh: "对外付汇的会计师证明" },
  "3CEB": { en: "Report from an accountant on international transactions", zh: "关联交易转让定价报告" },
  "FC-GPR": { en: "Foreign Currency-Gross Provisional Return", zh: "新发股份的外资申报表" },
  "FC-TRS": { en: "Foreign Currency-Transfer of Shares", zh: "存量股份转让申报表" },
  "PAS-3": { en: "Return of Allotment", zh: "配股申报表" },
  "MGT-14": { en: "Filing of Resolutions and Agreements to the Registrar" },
  "SH-7": { en: "Notice to Registrar of any alteration of share capital" },
  APR: { en: "Annual Performance Report" },
  FLA: { en: "Foreign Liabilities and Assets Return" },
  PAN: { en: "Permanent Account Number", zh: "税号" },
  TAN: { en: "Tax Deduction and Collection Account Number" },
  DIN: { en: "Director Identification Number", zh: "董事识别号" },
  CIN: { en: "Corporate Identity Number", zh: "公司识别号" },
  IEC: { en: "Importer-Exporter Code", zh: "进出口代码" },
  MOA: { en: "Memorandum of Association", zh: "章程大纲" },
  AOA: { en: "Articles of Association", zh: "章程细则" },
};

/** 先长后短排序，避免 "FC-GPR" 被 "FC" 之类的短词先匹配掉。 */
const SORTED_KEYS = Object.keys(ABBREVIATIONS).sort((a, b) => b.length - a.length);

/**
 * 供管理端「总览」展示：让管理员知道系统会自动补全哪些缩写，
 * 发现缺漏或译法有异议时可以提出来。当前这份表在代码里维护，改动需要重新部署。
 */
export function listAbbreviations(): Array<{
  key: string; en: string; zh?: string; group: AbbreviationGroup;
}> {
  return Object.entries(ABBREVIATIONS)
    .map(([key, value]) => ({
      key,
      en: value.en,
      zh: value.zh,
      group: GROUP_OF[key] ?? ("表格与证件" as AbbreviationGroup),
    }))
    .sort((left, right) => left.group.localeCompare(right.group, "zh")
      || left.key.localeCompare(right.key));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * 在一段文本里把尚未展开过的缩写补上全称。
 * `seen` 跨整个回答共享，所以每个缩写在一次回答里只展开一次（在最先出现的位置）。
 */
/** 判断某个位置是否落在《…》书名号里——法律/文件名内部不该被拆开插注释。 */
function insideTitleMarks(text: string, index: number) {
  const open = text.lastIndexOf("《", index);
  if (open < 0) return false;
  const close = text.indexOf("》", open);
  return close > index;
}

export function expandAbbreviations(text: string, seen: Set<string>): string {
  let result = text;
  /**
   * 已经插入的注释范围。后续缩写**不在这些范围里展开**——否则会出现注释套注释：
   * "GSTR-9（GST Annual Return，GST（Goods and Services Tax，商品与服务税）年度申报表）"
   * 本意是让非专业读者看懂，套两层反而更难读。
   */
  const glossRanges: Array<[number, number]> = [];
  const insideGloss = (index: number) =>
    glossRanges.some(([start, end]) => index >= start && index < end);

  for (const key of SORTED_KEYS) {
    if (seen.has(key)) continue;
    const entry = ABBREVIATIONS[key];
    // 前后不能紧邻字母/数字/连字符，避免 "ROCK"、"GSTR-1" 里的片段被误伤。
    const pattern = new RegExp(`(^|[^A-Za-z0-9-])(${escapeRegExp(key)})(?![A-Za-z0-9-])`, "g");

    let handled = false;
    for (const match of [...result.matchAll(pattern)]) {
      const start = (match.index ?? 0) + match[1].length;
      const tail = result.slice(start + key.length);

      // 1) 在《法律名》里面：整个标题是一个专名，插进去会把它拆散
      //    （"《RBI（Reserve Bank of India，印度储备银行） Master Direction…》" 就是这么来的）
      if (insideTitleMarks(result, start)) continue;
      // 0) 落在别的缩写的注释里：不再套一层
      if (insideGloss(start)) continue;
      // 2) 后面紧跟着大写英文单词：属于机构或文件全名的一部分，例如 "RBI Master Direction"
      if (/^\s+[A-Z][A-Za-z-]/.test(tail)) continue;
      // 3) 后面已经自带括号说明：不再叠加一层
      if (/^\s*[（(]/.test(tail)) { handled = true; break; }

      const gloss = entry.zh ? `${entry.en}，${entry.zh}` : entry.en;
      const insertion = `（${gloss}）`;
      const insertAt = start + key.length;
      result = `${result.slice(0, insertAt)}${insertion}${tail}`;
      // 插入点之后的旧范围整体后移，保证 glossRanges 始终对应当前的 result。
      for (const range of glossRanges) {
        if (range[0] >= insertAt) {
          range[0] += insertion.length;
          range[1] += insertion.length;
        }
      }
      glossRanges.push([insertAt, insertAt + insertion.length]);
      handled = true;
      break;
    }
    if (handled) seen.add(key);
  }
  return result;
}

/** 按阅读顺序给整份回答补全称：结论 → 法规要求 → 实务建议 → 风险提示。 */
export function expandAnswerAbbreviations<T extends {
  short_conclusion: string;
  action_steps: Array<{ text: string }>;
  risks_and_exceptions: string[];
  assumptions: string[];
}>(answer: T): T {
  const seen = new Set<string>();
  return {
    ...answer,
    short_conclusion: expandAbbreviations(answer.short_conclusion, seen),
    action_steps: answer.action_steps.map((step) => ({
      ...step,
      text: expandAbbreviations(step.text, seen),
    })),
    assumptions: answer.assumptions.map((item) => expandAbbreviations(item, seen)),
    risks_and_exceptions: answer.risks_and_exceptions.map((item) => expandAbbreviations(item, seen)),
  };
}
