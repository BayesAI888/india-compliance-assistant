import type { PublishedKnowledgeChunk } from "./knowledge-store";

/**
 * 按问题所属法域裁剪候选池。
 *
 * 起因：问"公司年度ROC合规要核对哪些事项"，回答里混进了 CGST Act 第44条（GST年度申报）
 * 和第35条（账簿记录），法规要求里还写了 GSTR-9 和 GST 审计。
 * 原因是 "annual return" 是**同形异义词**——公司法的年度申报（MGT-7）和 GST 的年度申报
 * （GSTR-9）英文都叫 annual return，关键词检索分不开，向量检索也分不开（语义确实相近）。
 *
 * 为什么 `layer-relevance.ts` 那道闸没拦住：它过滤的是**层名**（模型声明的"GST层"），
 * 而这次污染是从两条它看不到的路进来的——二次检索自己构造查询包（层名叫"二次检索缺口"）、
 * 以及关键词同形词直接命中。**闸门装错了层级**：污染发生在"哪些chunk被选中"，
 * 就该在候选池这一层拦，而不是在模型声明的层名上拦。
 *
 * 装在 `scopeCandidates` 里的好处是：第一轮检索、二次检索、交叉引用跟进
 * **全都共用同一个候选池**，一处生效，三条路都覆盖，不会再出现"绕过闸门"的第四条路。
 *
 * 规则（刻意保守，宁可少拦不可错杀）：
 * 1. 先看问题里出现了哪些法域的信号词；
 * 2. **一个信号词都没有时，不做任何过滤**——宁可放宽，也不要在看不懂问题时乱删证据；
 * 3. 有信号时，把"自己有信号词定义、但这个问题里一个都没出现"的法域从候选池里剔除；
 * 4. 没有被任何 profile 覆盖的资料（判例、通函等）永远不剔除；
 * 5. 万一剔到一条不剩，整体回退到不过滤——空结果比跑题更糟。
 *
 * 信号词是**法域级**的通用词汇（大约6个法域），不是针对某一条法规的补丁：
 * 换个问题、换部法律都不用改。
 *
 * ## 信号分三档（2026-09-22 加的第三档）
 *
 * 起因是实测这道题：「印度income tax（ITD）案件中，保证金计算的基数包括哪些？」
 * ——开头八个字就写着 income tax，结果**一个法域都没排除**，整个知识库进了候选池，
 * 答案里混进 CGST Rules 的上诉预缴 10%，还被放到全页最大的字号上。
 *
 * 复盘出两个独立的毛病：
 *
 * **① 通用税务词让 GST 永远剔不掉。** 「税率／税务／纳税／税负／报税／应税」
 * 原本同时躺在 GST 和所得税的信号表里，本意是"笼统税务问题两个域都保留"。
 * 但副作用是：**任何一道带「税率」二字的题，GST 都算命中**，于是问所得税税率时
 * GST 照样留在池子里。这些词根本不指向任何一个具体税种。
 *
 * **② 把法域名写出来，居然凑不够门槛。** 排除别的法域需要命中 2 个不同信号词，
 * 而「income tax」只算 1 个。`保证金`、`基数`、`案件`、`ITD` 一个都不在表里，
 * 于是一道法域再明确不过的题，强度判定为"太弱，谁也别排除谁"。
 *
 * 所以信号分成三档：
 *
 *   `name`    **法域名本身**（income tax / GST / 海关 / FEMA / 公司法…）。
 *             用户把法域名直接说出来不可能是偶然，所以**单独一个就够格排除别的法域**，
 *             不受下面那道 2 个词的门槛约束。
 *   `signals` 该法域的**专属**业务词（进项税、TDS、完税价格、ROC…）。
 *             数够 2 个不同的，才够格排除别的法域。
 *   `weak`    **跨税种通用词**（税率、税务、纳税、税负、报税、应税）。
 *             命中它**只能让这个法域活下来，不能让它去排除别人**。
 *             「印度子公司每年要做哪些税务合规」因此仍然 GST 和所得税都保留——
 *             这正是当初把通用词放进两个表的目的，现在用弱信号更准确地表达出来。
 *
 * 一句话：**弱信号管"留谁"，强信号和法域名管"剔谁"。**
 *
 * ## 为什么没做"同义词归一"
 *
 * 复盘时本来还打算把 income tax／所得税／ITD／ITAT 归并成同一个信号，免得同义词
 * 互相凑数把门槛顶上去。加了 `name` 这一档之后这件事就没必要了——法域名单独够格，
 * 不再依赖计数。而归并只会让计数变小、更难触发排除，反而加重污染。
 * 少做一层，就少一处以后会漏的地方。
 */

interface DomainProfile {
  name: string;
  /**
   * 对应 `law-categories.ts` 里的类别 id。
   *
   * 这里的"法域"和那边的"法律类别"本来就是同一套划分的两个说法，
   * 只是一个长在检索侧、一个长在展示侧。挂上 id 是为了让**问题的法域**
   * 能和**一条法规要求的类别**直接比对——`key-figures.ts` 的法域闸门要用。
   * 不挂 id 的话就得在两边各维护一张名字对照表，那是下一个会走偏的地方。
   */
  categoryId: string;
  /** 这部资料属于哪个法域，按 chunk.source 标题判断。 */
  source: RegExp;
  /**
   * **法域名本身**。命中一个就够格排除别的法域，不受 2 个词的门槛约束。
   * 只放那些说出来就等于点名这个法域的词，不要放业务词——
   * 这一档绕过了门槛，放宽它就等于把门槛拆了。
   */
  nameSignal: RegExp;
  /** 该法域的专属业务词。命中 2 个不同的才够格排除别的法域。 */
  signals: RegExp;
  /** 跨税种通用词。只能让本法域活下来，不能用来排除别人。 */
  weak?: RegExp;
}

/**
 * 跨税种通用词：说了等于没说是哪个税。
 *
 * 它们**不指向任何一个具体税种**，所以不能用来判断"这是一道 GST 题还是所得税题"。
 * 放在共享常量里而不是各自写一遍，是为了让"它们是同一批词"这件事在代码上看得见——
 * 分开写迟早会有一边多加一个词、另一边忘了加。
 */
const WEAK_TAX_SIGNALS = /税率|税务|纳税|税负|报税|应税/i;

/**
 * 只拿"法律名称"去判定法域，把标题里的出处信息切掉。
 *
 * 线上事故：公司法那份资料的标题是
 * "Companies Act, 2013 (as reproduced on incometaxindia.gov.in; downloaded 19-06-2026)"，
 * 括号里的来源网址含 `incometax`，被所得税的 source 规则匹配上，
 * 于是**公司法被判成了所得税资料**——凡是问题里没有所得税信号词，公司法就整个被剔掉。
 * 问 ROC 年度合规时，答案里只剩下 RBI Act 的非银行金融机构报表义务，公司法一条没有。
 *
 * 括号里装的是版本、下载日期、来源网址这类**出处元信息**，不是法律名的一部分，
 * 判定法域时必须排除掉。
 */
function sourceName(source: string): string {
  return source.split(/[（(]/)[0].trim() || source;
}

const DOMAIN_PROFILES: DomainProfile[] = [
  {
    name: "GST",
    categoryId: "gst",
    source: /\b(?:C|S|I|UT)?GST\b|goods and services tax/i,
    nameSignal: /\b(?:C|S|I|UT)?GST\b|GSTR|goods and services tax|货物与服务税|\bCBIC\b/i,
    signals: /GST|GSTR|货物与服务税|增值税|发票|invoice|进项税|销项税|抵扣|e-?way|供应链?|销售|采购|开票/i,
    weak: WEAK_TAX_SIGNALS,
  },
  {
    name: "所得税",
    categoryId: "income_tax",
    source: /income[-\s]?tax|所得税/i,
    // 「转移定价」和「转让定价」是同一个概念（transfer pricing）的两种常见中文译法，
    // 两个都要收。真实事故（2026-09-17）：用户问"印度转移定价方面的合规要求"，
    // 信号词表里只有"转让定价"，于是所得税法域一个信号都没命中、整个所得税知识库
    // 被剔出候选池；剩下命中的是"定价"（外汇，因为FEMA股权转让定价）和"合规"（公司法），
    // 回答出来全是FEMA股权定价和公司注册处义务，和转让定价毫无关系。
    // 关联交易/独立交易原则这几个词也一并补上——它们是同一个话题的常用说法。
    // ITD / ITAT / CIT(A) / CBDT 是 2026-09-22 补的：用户写「income tax（ITD）案件」，
    // ITD（Income Tax Department）和 ITAT（所得税上诉法庭）都是这个法域的标准简称，
    // 表里一个都没有。同类的 CIT(A)、AO、PCIT 也是所得税程序里天天出现的词。
    nameSignal: /所得税|income[-\s]?tax\b|\bITD\b|\bITAT\b|\bCBDT\b|\bCIT\s*\(A\)|\bPCIT\b/i,
    // 「特许权使用费／royalty」2026-09-22 补进所得税：它原本只在海关域里（估价加计项），
    // 但它同时是所得税的核心概念（对非居民支付特许权使用费要代扣代缴）。
    // 一个横跨两个法域的词只挂在一边，等于让另一边在这类题上零命中被剔光——
    // 和「税率」只挂在 GST 是同一种错，方向相反。
    //
    // 「广告费／AMP」2026-10-13 补：用户问"帮我找一些三星公司的广告费案件，并且分析"，
    // 判例区一条不出。根因：广告费是所得税 s.37(1) 税前扣除、转让定价 AMP 的核心话题，
    // 但 GST/所得税/海关几张表里一个都没有；而"三星**公司**"的公司命中公司法域，
    // detectQuestionCategories（只吃中文原问题，不传词典展开）于是返回
    // [company_governance] → 判例法域闸门把本地命中的 3 条全杀（含三星 AMP 案
    // 向量相似度 0.679 的 top1），界面表现为"案例库里有案却检索为空"。
    // 补词后这道题认出 [income_tax, company_governance]，闸门是"任一类命中即放行"，
    // 所得税判例就能出来。英文侧（advertis*/promotion/AMP）一并补：
    // 用户直接用英文问、或将来调用点改传词典展开时都用得上。
    signals: /所得税|income\s*tax|\bTDS\b|\bTCS\b|预提|扣缴|源泉|转[让移]定价|关联交易|独立交易原则|arm'?s\s*length|transfer\s*pricing|\bTPO?\b|\bALP\b|\bDTAA\b|双重征税|税收协定|汇算|应纳税所得|税前扣除|广告费|推广费|营销费|宣传费|促销费|\bAMP\b|advertis|promotion|withholding|特许权使用费|许可费|royalt/i,
    weak: WEAK_TAX_SIGNALS,
  },
  {
    name: "外汇与外资",
    categoryId: "fema_fdi_rbi",
    source: /FEMA|foreign exchange|\bFDI\b|consolidated fdi|\bRBI\b|reserve bank of india|master direction|non-debt instruments/i,
    nameSignal: /\bFEMA\b|\bRBI\b|foreign exchange management|外汇管理法|\bFDI\b|\bODI\b/i,
    signals: /外资|中资|外汇|\bFDI\b|FEMA|\bRBI\b|汇出|汇入|汇款|非居民|境外|外国投资者|增资|减资|股权转让|持股|投资|定价|估值|Press\s*Note|准入|行业上限/i,
  },
  {
    name: "海关与进出口",
    categoryId: "trade_customs",
    source: /customs|foreign trade policy|进出口/i,
    nameSignal: /\bcustoms\b|海关|\bDGFT\b|foreign trade policy|对外贸易政策/i,
    // 2026-09-18 真实事故：用户问"从中国母公司**进口**注塑件……免费提供模具、
    // 另付技术许可费、海运费保险另付，**完税价格**只看发票金额吗"——
    // 这是一道标准的海关估价题（Customs Act s14 + 估价规则 Rule 10 的价格调整项），
    // 结果海关法域**一个信号都没命中、被整个剔出候选池**，
    // GST 靠单独一个"发票"活下来，答案全部引了 CGST Act。
    //
    // 漏的原因有两类，都值得记下来：
    // 1. **整词写法挡住了单字**：词表里是"进出口"三个字连写，
    //    用户说的"进口"匹配不上。同理"出口"。
    // 2. **核心术语根本没进表**："完税价格"是海关估价的**核心词**，
    //    "海关估价""到岸价""特许权使用费""模具"（估价规则里的 assists）
    //    这些一个都没有。写这张表时想的是"海关＝报关清关"，
    //    没想到估价、运保费这一整块。
    //
    // 放宽的代价很小：这道闸只负责**排除**，给一个法域多加信号只会让它
    // **更不容易被误剔**，多留几条候选证据由后面的打分去排。
    // 而误剔的代价是整部法律消失、答案引错法域——两边成本完全不对称。
    signals: /海关|进出?口|关税|清关|保税|报关|\bIEC\b|import|export|customs|完税价格|计税价格|海关估价|成交价格|到岸价|离岸价|\bCIF\b|\bFOB\b|运保费|海运费|运费|特许权使用费|许可费|royalt|模具|工装|暂定评估|\bSVB\b|\bHS\s*code\b|HSN|归类|原产地/i,
  },
  {
    name: "公司法与ROC",
    categoryId: "company_governance",
    source: /companies act|公司法|\bMCA\b|registrar of companies/i,
    nameSignal: /companies\s*act|公司法|\bMCA\b|\bROC\b|registrar of companies|\bNCLT\b/i,
    // 公司法是公司事务的通用底盘，信号词刻意放宽——它几乎总该保留，
    // 真正需要被拦住的是税务、海关这些强领域性的资料。
    signals: /公司|企业|\bROC\b|注册处|董事|股东|章程|年报|年度申报|配股|股本|决议|\bMCA\b|设立|注销|合规|审计|财务报表|会议/i,
  },
];

/**
 * 这个法域在问题里命中了**几个不同的**信号词。
 *
 * 数"不同的词"而不是"匹配了几次"：同一个词在一道题里重复出现三遍
 * （"发票……这张发票……发票金额"）不代表信号更强，只代表用户在说同一件事。
 */
export function countSignalHits(profile: DomainProfile, text: string): number {
  const global = new RegExp(profile.signals.source, `${profile.signals.flags.replace("g", "")}g`);
  const hits = new Set<string>();
  for (const match of text.matchAll(global)) hits.add(match[0].toLowerCase());
  return hits.size;
}

export interface DomainScopeResult {
  chunks: PublishedKnowledgeChunk[];
  /** 被整体排除的法域名，供日志与文档说明用。 */
  excluded: string[];
}

export function scopeByQuestionDomain(
  question: string,
  chunks: PublishedKnowledgeChunk[],
  /**
   * 术语词典命中后展开出来的英文检索词。
   *
   * 为什么需要它（2026-09-17 的教训）：这道闸门原本只拿**问题原文**去匹配
   * 一张写死在代码里的信号词表，**完全不知道管理员维护的术语词典存在**。
   * 于是用户在词典里把"转移定价""转让定价"都对到 transfer pricing，
   * 对这道闸门毫无影响——它只认代码里写了的那几个字。
   *
   * 把词典展开出来的英文词一起送进来匹配之后，关系就正过来了：
   * **管理员在词典里加一个说法，这道闸门立刻就认得**，不用再改代码。
   * 词典没配置或没命中时传空数组，行为和以前完全一样。
   */
  glossaryTerms: string[] = [],
): DomainScopeResult {
  if (!question.trim() || chunks.length === 0) return { chunks, excluded: [] };

  // 信号匹配的对象＝问题原文 + 词典展开出来的英文词。
  const signalText = glossaryTerms.length ? `${question} ${glossaryTerms.join(" ")}` : question;
  // 有没有哪个法域被**点名**了。这决定通用税务词还救不救得了别的法域：
  //
  //   没人被点名 →「印度子公司每年要做哪些税务合规」这类笼统问题，
  //               「税务」两个字把 GST 和所得税都保下来，正是通用词该起的作用。
  //   有人被点名 →「印度公司**所得税**税率是多少」，
  //               「税率」就不该再把 GST 保下来了。用户已经说了问的是哪个税，
  //               一个连税种都指不出来的词没有资格推翻它。
  //
  // 少了这一句，通用词降级只做了一半：GST 不再能靠「税率」去**排除**别人，
  // 却仍然能靠「税率」**赖着不走**，所得税题里照样混进 CGST 条文。
  const anyDomainNamed = DOMAIN_PROFILES.some((profile) => profile.nameSignal.test(signalText));

  // 「活下来」的条件：法域名、专属词，命中任一即可；
  // 只靠通用税务词撑着的，仅在没有任何法域被点名时才算数。
  const matched = DOMAIN_PROFILES.filter((profile) =>
    profile.nameSignal.test(signalText)
    || profile.signals.test(signalText)
    || (!anyDomainNamed && (profile.weak?.test(signalText) ?? false)));
  // 一个法域都没识别出来：说明这个问题超出了信号词覆盖范围，此时不过滤。
  if (matched.length === 0) return { chunks, excluded: [] };

  // ---- 强度门槛：信号太弱时，谁也别排除谁 ----
  //
  // 到 2026-09-18 为止，同一类事故已经发生五次：手写的信号词表漏掉了用户的实际说法，
  // 于是**整个法域被静默剔出候选池**，答案引了另一个法域的法律。
  // 最后一次是海关估价题——问"从中国母公司进口、完税价格只看发票金额吗"，
  // 海关法域零命中被剔光，GST 靠单独一个"发票"活下来，答案全是 CGST Act。
  //
  // 五次都靠"再往词表里补几个词"来修。补词能解决当次，解决不了下一次——
  // **只要这张表是人手写的，它就永远会漏**。所以这次改的是规则本身。
  //
  // 新规则：要排除别的法域，至少得有一个法域**命中两个以上不同的信号词**。
  // 理由是成本不对称：
  // - 误剔一个法域 → 整部法律从答案里消失，用户拿到的是别的法域的条文（重）
  // - 多留一个法域 → 候选池大几条，交给后面的打分去排（轻）
  // 一个孤零零的"发票"不足以证明"这是一道 GST 题"，只能证明"提到了发票"。
  // 真正是 GST 题的问法（"进项税怎么抵扣、GSTR-3B 怎么报"）自然会命中好几个词。
  //
  // 历史事故回归验证（见测试）：最早那次"公司年度ROC合规要核对哪些事项"，
  // 公司法命中 公司/ROC/合规 三个词，照样能把 GST 的 annual return 挡在外面。
  // 够格排除别人的两条路，满足其一即可：
  //
  //   ① 问题里**点出了这个法域的名字**（income tax / GST / 海关 / FEMA / 公司法…）。
  //      把法域名直接说出来不可能是偶然，一个就够。
  //      2026-09-22 加的，起因见文件头：一道开头写着 "income tax（ITD）" 的题
  //      因为凑不够 2 个词，整个知识库原封不动进了候选池。
  //   ② 命中 2 个以上该法域的**专属**业务词。通用税务词（weak）不算数——
  //      「税率」既不能证明这是 GST 题，也不能证明这是所得税题。
  //
  // 两条路都不满足就谁也别排除谁：宁可候选池大几条，也不要整部法律从答案里消失。
  const MIN_DOMINANT_MATCHES = 2;
  const canExclude = matched.some((profile) =>
    profile.nameSignal.test(signalText)
    || countSignalHits(profile, signalText) >= MIN_DOMINANT_MATCHES);
  if (!canExclude) return { chunks, excluded: [] };

  const excludedProfiles = DOMAIN_PROFILES.filter((profile) => !matched.includes(profile));
  if (excludedProfiles.length === 0) return { chunks, excluded: [] };

  // 一份资料可能同时匹配上多个域（标题里带别的领域词、或本身跨领域）。
  // **只要命中了任何一个"保留域"，就一定留下**；只有当它仅仅命中被排除的域时才剔除。
  // 这条优先级规则是上面那次事故的第二道保险：即使将来又有哪份资料的标题里
  // 混进了别的领域词，只要它同时匹配得上自己真正所属的域，就不会被误杀。
  const kept = chunks.filter((chunk) => {
    const name = sourceName(chunk.source);
    if (matched.some((profile) => profile.source.test(name))) return true;
    return !excludedProfiles.some((profile) => profile.source.test(name));
  });

  // 全被剔光时回退：宁可放进跑题的资料，也不能让本来有答案的问题变成"查不到"。
  if (kept.length === 0) return { chunks, excluded: [] };

  const actuallyExcluded = excludedProfiles
    .filter((profile) => chunks.some((chunk) => profile.source.test(sourceName(chunk.source))))
    .map((profile) => profile.name);

  return { chunks: kept, excluded: actuallyExcluded };
}

/**
 * 这道问题指向哪些**法律类别**（`law-categories.ts` 的 id）。
 *
 * 和 `scopeByQuestionDomain` 用的是同一套信号判定，但回答的是另一个问题：
 * 那边问"候选池里该留哪些资料"，这里问"用户问的是哪个税/哪个法域"。
 *
 * 口径故意和 `scopeByQuestionDomain` 的 `matched` 保持一致（含弱信号那条规则），
 * 这样"检索时留下了哪些法域"和"展示时认哪些法域"不会打架。
 *
 * 返回空数组 = **认不出来**，调用方必须把它当作"不要据此做任何排除"，
 * 而不是"没有任何法域"。这条和整个文件的兜底原则一致：看不懂时放宽，不乱删。
 */
export function detectQuestionCategories(
  question: string,
  glossaryTerms: string[] = [],
): string[] {
  if (!question.trim()) return [];
  const signalText = glossaryTerms.length ? `${question} ${glossaryTerms.join(" ")}` : question;
  const anyDomainNamed = DOMAIN_PROFILES.some((profile) => profile.nameSignal.test(signalText));
  return DOMAIN_PROFILES
    .filter((profile) =>
      profile.nameSignal.test(signalText)
      || profile.signals.test(signalText)
      || (!anyDomainNamed && (profile.weak?.test(signalText) ?? false)))
    .map((profile) => profile.categoryId);
}
