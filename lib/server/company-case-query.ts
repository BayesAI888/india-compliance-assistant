/**
 * 「用户是不是在点名某家公司要案例」的识别与公司名归一化。
 *
 * 为什么要单独一道判断：`company-case-search.ts` 是多路召回的重操作，
 * 一次约 ₹13，还要几秒。它**只能在用户明确点名公司时触发**，
 * 绝不能像 `case-search.ts` 那样挂在普通问答的兜底链路上。
 *
 * 判断分两步，顺序不能反：
 *   1. 句式上是不是"求取某主体的案例"（正则，不花钱）
 *   2. 主体名能不能映射到印度法律实体的英文名（词典优先，词典没有才问模型）
 *
 * 第 2 步词典优先是有意的：中资企业在印度的主体名**不是中文名直译**，
 * "小米" 的印度实体是 Xiaomi Technology India Private Limited，
 * "三星" 在印度至少有三个完全不同的法律主体。让模型每次现编英文名，
 * 等于把整条检索链路的准确性押在一次自由生成上——而检索词错了，
 * 后面所有闸门都没有意义。
 */

import { matchCaseTerms } from "./case-query-language";

/**
 * 句式：求取 + 某主体 + 案例类词。
 *
 * 和 `case-relevance.ts` 的 `isCaseSeekingQuestion` 是两个不同的判断：
 * 那个问的是"要不要给判例"，这个问的是"要不要按公司去查"。
 * 后者是前者的子集，而且必须更严——它花钱。
 */
const SEEK = "有哪些|哪些|有没有|有无|找|查|搜|列举|列出|给.{0,4}几个|收录";
// ⚠「案件」是 2026-10-13 补的：这个词表和 case-relevance.ts 的 CASE_WORD 是**两份独立清单**，
// 上午修判例触发词时只补了那份，这里漏了——实测「帮我找一些三星公司的广告费案件」
// 在判例链路能触发、公司链路却识别不出意图，整条公司检索静默不进入。
// 以后两份清单改一份必须检查另一份（还有 BACK_REFERENCE 和 CN_COMPANY_HINT 的前瞻清单）。
const CASE_WORD = "判例|案例|案子|案件|官司|诉讼|涉税争议|税务争议|case";
/**
 * 两种词序都要认——中文里"…案例有哪些"比"有哪些…案例"还常见：
 *   「三星的AMP案例有哪些？」  ← 案例词在前
 *   「有哪些三星的AMP案例？」  ← 求取词在前
 * 只写一种的后果不是报错，是**静默不触发**，用户以为功能不存在。
 */
const COMPANY_CASE_PATTERN = new RegExp(
  `(?:${SEEK})[^。？?]{0,16}(?:${CASE_WORD})|(?:${CASE_WORD})[^。？?]{0,8}(?:${SEEK})`, "i");

/**
 * 公司名在中文问句里的常见写法：
 *   "三星的案例" / "三星公司有哪些官司" / "查一下 Samsung 的税务争议"
 * 抓的是"的/公司/在印度"之前那一段，以及句子里的连续英文词组。
 */
const CN_COMPANY_HINT = /([一-龥A-Za-z0-9·-]{2,20}?)(?:公司)?(?:在印度)?(?:的)?(?:印度)?(?=[^。？?]{0,10}(?:判例|案例|案子|案件|官司|诉讼|涉税争议|税务争议))/;
const EN_COMPANY_HINT = /\b([A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,}){0,3})\b/;

/** 不是公司名的高频误抓词——这些词能通过上面的正则，但显然不是主体。 */
const NOT_A_COMPANY = new Set([
  "印度", "税务", "海关", "增值税", "所得税", "转让定价", "常设机构", "合规",
  "相关", "类似", "这类", "那类", "什么", "怎样", "如何", "最新", "近期", "典型",
  "中资", "中国", "外资", "企业", "公司", "我们", "我司", "本司",
]);

/**
 * 抽出用户问的是哪家公司。
 *
 * **先扫词典，再按位置猜**——顺序很重要。
 *
 * 位置启发式（"的/公司/在印度" 之前那一段）在只有公司名时够用，但一旦问题里
 * 同时有公司和主题就会抓错：「三星的**AMP**案例」里，离"案例"最近的是 AMP，
 * 按位置抓抓到的是主题词，公司名反而被跳过。这不是调正则能修好的——
 * "哪个词是公司"这件事，位置本来就给不出答案。
 *
 * 词典扫描是确定性的：`COMPANY_ALIASES` 里的键和别名在问题里出现即命中，
 * 没有歧义。词典没有的公司才退回位置猜，而那种情况下
 * `detectCompanyCaseIntent` 本来就要求调用方提供别名，猜错了也不会真去花钱。
 */
/**
 * 「<公司>的<主题>判例」这种**没有求取词的名词短语**，单独作为一条消息时就是请求：
 *   「Samsung 的转让定价判例」「三星的AMP案例」
 * 只认"有哪些/找/查"会让这种最自然的问法静默不触发。
 *
 * 但不能放太宽——它触发的是 ≈₹13 的重操作。所以要求：
 *   ① 公司名在词典里（强信号，排除了"某某的案例"这种泛指）
 *   ② 公司名和案例词之间不超过 12 字
 *   ③ 排除回指语气（"那个判例我看过了""你说的那个案子"）——那是在谈已知的案子，不是在求新的
 */
const BACK_REFERENCE = /(?:那个|这个|上面|刚才|你说的|前面)[^。？?]{0,8}(?:判例|案例|案子|案件)|(?:判例|案例|案子|案件)[^。？?]{0,6}(?:我看过|我知道|我读过|已经看)/;

function looksLikeNounPhraseRequest(question: string, companyKey: string): boolean {
  if (BACK_REFERENCE.test(question)) return false;
  return new RegExp(
    `${companyKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^。？?]{0,12}?(?:${CASE_WORD})`, "i",
  ).test(question);
}

export function extractCompanyMention(question: string): string | undefined {
  const hasSeekPattern = COMPANY_CASE_PATTERN.test(question);

  // 词典优先。长名在前匹配，避免"三星"抢在"三星电子"前面命中。
  const wordMatch = (needle: string) => new RegExp(
    `(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(question);

  const keys = Object.keys(COMPANY_ALIASES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    // 候选写法：中文键、法定全名、品牌首词。按长度降序，命中时取最长的那个，
    // 这样 looksLikeNounPhraseRequest 里量"公司名到案例词的距离"才准。
    const names = [key, ...COMPANY_ALIASES[key], ...brandTokens(COMPANY_ALIASES[key])]
      .sort((a, b) => b.length - a.length);
    const matchedName = names.find((n) => (n === key ? question.includes(n) : wordMatch(n)));
    if (!matchedName) continue;
    // 词典命中 + （有求取词 或 是"<公司>的…判例"这种名词短语请求）
    if (hasSeekPattern) return key;
    if (looksLikeNounPhraseRequest(question, matchedName)) return key;
    return undefined;
  }

  if (!hasSeekPattern) return undefined;

  const cn = question.match(CN_COMPANY_HINT)?.[1]?.trim();
  if (cn && !NOT_A_COMPANY.has(cn) && cn.length >= 2) return cn;
  const en = question.match(EN_COMPANY_HINT)?.[1]?.trim();
  if (en && !NOT_A_COMPANY.has(en)) return en;
  return undefined;
}

/**
 * 中文/通用名 → 印度法律实体英文名。
 *
 * 这份表是**手工维护**的，不是模型生成的——理由见文件头。
 * 一家公司列出全部已知的印度主体：它们是不同的法律实体，
 * 行业和争议类型都不同，混在一起归纳等于把两家公司的风险画像揉成一张。
 *
 * 表里没有的公司走模型兜底（`suggestAliasesWithModel`），但**结果要当候选看**，
 * 并在展示时告诉用户"公司名是推测的"——这是精度和覆盖之间的取舍，
 * 不能假装两者都有。
 *
 * 新增条目的规矩：英文名要能在 Indian Kanoon 的判决书标题里逐字找到，
 * 不是公司官网上的商号。这两者经常不一样。
 */
export const COMPANY_ALIASES: Record<string, string[]> = {
  "三星": ["Samsung India Electronics", "Samsung Heavy Industries", "Samsung India Software Operations", "Samsung Electronics"],
  "小米": ["Xiaomi Technology India", "Xiaomi India"],
  "华为": ["Huawei Telecommunications India", "Huawei Technologies India"],
  "OPPO": ["Oppo Mobiles India", "Guangdong Oppo Mobile"],
  "vivo": ["Vivo Mobile India", "Vivo Communication Technology"],
  "联想": ["Lenovo India", "Lenovo Information Technology"],
  "中兴": ["ZTE Corporation", "ZTE Telecom India"],
  "比亚迪": ["BYD India"],
  "海尔": ["Haier Appliances India"],
  "上汽": ["MG Motor India", "SAIC Motor"],
  "阿里巴巴": ["Alibaba", "UC Web", "Alibaba Cloud"],
  "字节跳动": ["Bytedance India", "TikTok"],
};

/**
 * 每个词条的**品牌首词**——"Samsung India Electronics" → "Samsung"。
 *
 * 为什么需要：别名表里存的是印度判决书标题里的**法定全名**，而用户打字时
 * 几乎只写品牌名（"Samsung 的转让定价判例"）。不认首词的话，
 * 英文问法会全部静默不触发，而中文问法（"三星"）却能触发——同一个意思两种结果。
 *
 * 只取长度 ≥3 的首词：过短的（MG Motor 的 "MG"、UC Web 的 "UC"）在普通句子里
 * 撞车概率太高，而这里撞一次就是 ₹13。宁可让这两家漏掉，靠中文名触发。
 */
function brandTokens(aliases: string[]): string[] {
  return [...new Set(aliases
    .map((a) => a.split(/\s+/)[0])
    .filter((t) => /^[A-Za-z][A-Za-z0-9]{2,}$/.test(t)))];
}

/** 别名查表。大小写和常见写法差异做归一。 */
export function lookupAliases(mention: string): string[] | undefined {
  const direct = COMPANY_ALIASES[mention];
  if (direct) return direct;
  const lower = mention.toLowerCase();
  for (const [key, aliases] of Object.entries(COMPANY_ALIASES)) {
    if (key.toLowerCase() === lower) return aliases;
    if (aliases.some((a) => a.toLowerCase() === lower)) return aliases;
    // "三星电子" / "Samsung Electronics" 这类带后缀的写法
    if (mention.startsWith(key) || lower.startsWith(key.toLowerCase())) return aliases;
  }
  return undefined;
}

export interface CompanyCaseIntent {
  mention: string;
  aliases: string[];
  /** 别名来自手工词典还是模型推测——推测的要在界面上说明。 */
  aliasSource: "dictionary" | "guess";
  /**
   * 问题里同时点到的主题，映射成印度法上的术语（"AMP 案例" → AMP expenses）。
   * 有值时走**公司 + 主题**组合检索——公司限定在标题、主题限定在正文，两个维度正交。
   * 空数组表示只按公司查。
   */
  topicTerms: string[];
}

/**
 * 识别意图。**只在词典命中或调用方提供了别名时才返回**——
 * 识别不出主体时返回 undefined，让调用方走普通问答链路，
 * 而不是拿一个猜的公司名去花 ₹13。
 */
export function detectCompanyCaseIntent(
  question: string,
  guessAliases?: (mention: string) => string[] | undefined,
): CompanyCaseIntent | undefined {
  const mention = extractCompanyMention(question);
  if (!mention) return undefined;

  // 主题用**判例术语表**而不是直译：问"三星的代持案例"，要搜的是 benami，
  // 不是 nominee shareholding。见 case-query-language.ts。
  // 公司名本身可能误命中术语（比如某公司名里带"广告"），所以先把公司名从
  // 问题里挖掉再做主题匹配。
  const withoutCompany = question.split(mention).join(" ");
  const topicTerms = matchCaseTerms(withoutCompany);

  const fromDictionary = lookupAliases(mention);
  if (fromDictionary) {
    return { mention, aliases: fromDictionary, aliasSource: "dictionary", topicTerms };
  }

  const guessed = guessAliases?.(mention)?.filter(Boolean) ?? [];
  if (guessed.length > 0) {
    return { mention, aliases: guessed, aliasSource: "guess", topicTerms };
  }

  return undefined;
}

export function isCompanyCaseSearchEnabled(): boolean {
  const flag = process.env.COMPANY_CASE_SEARCH?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return Boolean(process.env.INDIANKANOON_API_TOKEN?.trim());
}
