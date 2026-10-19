import { LAW_CATEGORIES, lawCategoryLabel, type LawCategory } from "../law-categories";

/**
 * 给知识库总览用的"资料分类"——纯展示层面的归类，不参与检索或回答生成。
 *
 * 起因：用户自己整理资料时按法律类别分组看（公司法一堆、FEMA一堆、GST一堆……），
 * 觉得比现在总览那张平铺的文档列表清楚。但系统里现在没有存"这份资料属于哪个类别"，
 * 检索用的 `contracts.ts` 里那个 `Domain` 类型是给"问题分类路由"用的（9种、按问题场景分），
 * 跟"这份资料整体属于哪个法律板块"不是一回事——公司法一部法律本身就横跨
 * company_incorporation 和 mca_roc 两个问题域，按那个分反而会把同一部法律拆散。
 *
 * 所以这里单独做一套更粗、只服务于总览分组的分类，按资料的 fileName / source
 * 关键词匹配，五类 + 兜底"其他"。纯字符串匹配，不调用模型、不改动据检索路径，
 * 分类分错了也只影响总览好不好看，不影响问答准确性。
 */

/**
 * 类别的 id 与中文名**不在这里定义**，统一在 `lib/law-categories.ts`。
 *
 * 原因：同一套类别名后台和答案两边都要用，各写一份已经漂移过
 * （"进出口与海关" vs "海关与进出口"）。名字共用一份、判据各管各的。
 * 下面那组正则是**后台专用**的判据，输入是 fileName + chunk 的 source。
 */
export type DocumentCategory = LawCategory;
export const DOCUMENT_CATEGORIES = LAW_CATEGORIES;

/** 按顺序匹配，命中第一条就算数——不用互斥穷举，写规则的人不用担心遗漏组合。 */
const RULES: Array<{ id: string; pattern: RegExp }> = [
  // GST 放在公司类前面：GST相关法规不会误撞"companies"这类词，顺序本身不敏感，
  // 但先判定语义最窄的几类，能减少"其他"兜底类无谓吞掉本该分类清楚的资料。
  {
    id: "gst",
    // `gstat` 2026-09-22 补：GST 上诉法庭的程序规则，缩写里虽然带 gst，
    // 但 \b(c?gst)\b 的词边界要求整词，"GSTAT" 匹配不上。
    pattern: /\b(c?gst|igst|utgst|gstat|goods\s+and\s+services\s+tax)\b|compensation\s+to\s+states|hundred\s+and\s+first\s+amendment/i,
  },
  {
    id: "fema_fdi_rbi",
    // `foreign\s+exchange`（不要求跟着 management）2026-09-22 补：
    // 《Foreign Exchange (Compounding Proceedings) Rules, 2024》标题里没有
    // "Management" 也没有 "FEMA"，原来的规则一个都不命中，落进了「其他」。
    // 放宽到"外汇"二字的风险很小——这四个字出现在标题里，基本只可能是外汇法规。
    pattern: /\bfema\b|foreign\s+exchange|\brbi\b|reserve\s+bank|\bfdi\b|\bodi\b|dpiit|press\s+note|外汇/i,
  },
  {
    id: "income_tax",
    // 中文文件名兜底：知识库里目前唯一一份中文命名的资料是中印税收协定。
    // `finance\s+act` 2026-09-22 补：每年的财政法案定当年税率表、TDS 税率、附加税，
    // 是所得税问题里最常要引的一份，而原来它一个规则都不命中、落进了「其他」。
    pattern: /income-?tax|double\s+tax|dtaa|avoidance\s+of\s+double\s+taxation|双重征税|避免.{0,4}征税协定|finance\s+act|\bitat\b|\bcbdt\b/i,
  },
  {
    id: "trade_customs",
    // 2026-09-22 补的几个：
    //   sez           —— 经济特区进出货物、DTA 内销补税，是进出口场景
    //   carotar       —— FTA 原产地申报规则，全称里没有 customs 二字
    //   bureau of indian standards / qco —— 清关环节的强制认证，卡在口岸
    //   anti-dumping / safeguard / dgtr / cestat —— 贸易救济与海关争议
    //   tariff        —— Customs Tariff Act 靠 customs 能命中，但税则相关的别名一并收
    pattern: /foreign\s+trade|\bcustoms\b|itc\s*\(?\s*hs\s*\)?|handbook\s+of\s+procedures|special\s+economic\s+zone|\bsez\b|carotar|bureau\s+of\s+indian\s+standards|\bbis\s+act\b|\bqco\b|anti-?dumping|safeguard\s+duty|\bdgtr\b|\bcestat\b|经济特区|原产地/i,
  },
  {
    id: "company_governance",
    // 2026-09-22 补：这一类的边界是「公司在印度做生意要守的通用商事法」，
    // 不只是 Companies Act 那一家。下面几部原来全落进了「其他」——
    //   MSMED      —— s.15 的 45 天付款期，逾期触发所得税 43B(h) 进项调增
    //   Stamp Act  —— 增资、股权转让、协议的印花税，设子公司必经
    //   Contract / Negotiable Instruments —— 应收账款催收、合同效力
    //   Arbitration —— 与印度客户供应商的争议解决
    // 「其他」这一类在检索上是**永远剔不掉**的（没有任何法域 profile 覆盖它），
    // 所以落错类不是小事：等于往每道题的候选池里塞一份挡不住的资料。
    pattern: /companies\s+act|companies\s*\(|limited\s+liability\s+partnership|\bllp\b|partnership\s+act|nclt|nclat|iepf|insolvency|competition\s+act|money-?laundering|secretarial\s+standard|micro,?\s*small\s+and\s+medium|\bmsmed?\b|stamp\s+act|contract\s+act|negotiable\s+instruments|arbitration|印花税|仲裁/i,
  },
];

/**
 * 给一份资料判类别。输入是这份资料的 fileName 和（可能有多个的）source 列表，
 * 两个都拿来试，命中任意一个就算数——source 通常就是法律全称，比文件名更干净，
 * 但文件名有时带着 fileName 里才有的线索（比如 "_for_kb" 前缀被 knowledge-base-maintenance
 * 剥掉之后剩下的部分）。
 */
export function classifyDocumentCategory(fileName: string, sources: string[] = []): string {
  // 下划线当空格处理：不少文件名用下划线连词（"FEMA_NDI_Rules"），
  // 但正则的 \b 词边界把下划线算作单词字符，"\bfema\b" 在这种写法里反而匹配不上。
  const haystack = [fileName, ...sources].join(" ").replace(/_/g, " ");
  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) return rule.id;
  }
  return "other";
}

export const categoryLabel = lawCategoryLabel;
