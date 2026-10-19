/**
 * 问题类型：**合规义务型** 还是 **争议应对型**。
 *
 * ## 为什么要分（2026-09-29 定）
 *
 * 在这之前所有问题共用一套模板：
 *
 *     结论 → 前提假设 → 法规要求 → 实务建议 → 相关判例 → 引用清单
 *
 * 这套模板对「我该做什么才合规」是对的。但实测一道真实问题暴露了它的边界：
 *
 *   > 收到印度 income tax 税局发出的 notice，现在我们在计算应诉成本。
 *   > 请你帮我计算应诉成本包括哪些内容
 *
 * 答案给出的是一串法定收费（1%/月利息、50% 罚款、上诉费、20% 预缴……），
 * 每条都真、都有引用、法条也没引错。但它**答不到点上**，原因有四：
 *
 *   ① 把「或有损失」和「确定支出」混在一个列表里——50% 罚款是败诉才发生的，
 *      上诉费是一定发生的，20% 预缴是现在掏、以后可能退的。用户拿去做预算会算错。
 *   ② 混进了**不是应诉成本**的项——预缴不足的利息是评估阶段就产生的，
 *      应不应诉都要付。用户要算的是**因为选择应诉而额外发生的增量**。
 *   ③ 把成本项写成了权利——「纳税人**可**聘请特许会计师」。顾问费是最大单项，
 *      而法条只规定"可以委托"、不规定收费，所以它答不出来。
 *   ④ 没有时间维度——ITAT 排期两三年，1%/月 累计就是 24–36%，
 *      这个数在"打不打"的决策里常常比罚款还大。列了单价，没列数量。
 *
 * **不是检索质量问题，是模板问题。** 成本模型不是法定要求的列表，
 * 硬套进「法规要求」这个框，必然变成一串法条编号。
 *
 * ## 争议应对型的用户处境不一样
 *
 * 他**有时限、有对手、有胜负、要做决策**。需要的不只是"法律规定是什么"，
 * 还有"我现在该干什么、还有多少时间、几条路各是什么代价"。
 * 所以争议应对型走流程图：审级骨架来自 `config/dispute-tracks.json`，
 * 每个节点挂期限 / 进场现金 / 平均耗时 / 累计利息。
 *
 * ## 判定口径：宁可漏判
 *
 * 判成争议型的代价是换一套模板；判错了（本该合规型却走了流程图）
 * 会给用户一张和他处境无关的审级图，**比没有更糟**。
 * 而漏判只是退回现在这套模板——那套模板本来也在用。
 * 所以词表只收**明确处在争议程序里**的词，不收"争议""纠纷"这种泛指。
 *
 * 这和 `case-relevance.ts` 的 `CASE_TRIGGER_PATTERN` 刻意不同：
 * 那个是"要不要**顺带**查判例"，宽一点没关系（判例放在后面当补充）；
 * 这个是"**换不换整套模板**"，必须窄。
 */

export type QuestionType = "COMPLIANCE_DUTY" | "DISPUTE_RESPONSE";

/**
 * 明确处在争议程序里的信号。
 *
 * 三类，都要求是**具体的程序事物**，不是情绪词：
 *   ① 收到了什么     notice / SCN / 评估令 / 稽查 / 罚单
 *   ② 在哪一级       CIT(A) / ITAT / CESTAT / GSTAT / 上诉法庭 / 高等法院
 *   ③ 在做什么动作   上诉 / 申诉 / 应诉 / 抗辩 / 暂缓征收 / 预缴
 *
 * 刻意**不收**：争议、纠纷、dispute、问题、风险。
 * 「转让定价争议怎么防范」是合规义务型——他还没被查，要的是怎么做合规。
 */
const DISPUTE_SIGNAL = new RegExp(
  [
    // ① 收到了什么
    "show\\s*cause\\s*notice", "\\bSCN\\b", "评估令", "assessment\\s*order",
    "缴款通知", "demand\\s*notice", "稽查", "查账", "税务检查", "罚单", "处罚决定",
    "\\border[-\\s]?in[-\\s]?(original|appeal)\\b", "税局.{0,6}(通知|来函|发函|质疑|挑战|主张)",
    // 「XX令」这一族（2026-09-29 补）。实测漏判：
    // 「收到 GST 税局关于电子运单与实际货物不符的**处罚令**，应该怎么办」
    // 判成了合规义务型，流程图整个没出——用户手里拿着一份处罚令，
    // 这是争议程序里最明确的起点之一。
    // ⚠只收**带限定词的**「令」，不收裸的「令」：那个字在中文里太泛
    // （命令、指令、法令、口令），裸收必然误判。
    "(?:处罚|罚款|裁定|裁决|征收|追缴|扣押|没收|查封|冻结|补税|评估)令",
    "税(?:务)?(?:局|务局|官)?.{0,8}(?:命令|决定书|裁决书|裁定书)",
    // 英文的 order 同理：**只收带限定词的搭配**。
    // 裸的 \border\b 在这个产品里几乎一定是 purchase order / work order，
    // 收了它等于把所有采购、物流问题都判成争议型。
    "\\b(?:penalty|adjudication|assessment|demand|seizure|confiscation|detention|garnishee|stay|appellate|revision)\\s*order\\b",
    "\\border\\s*(?:passed|issued)\\s*(?:by|under)\\b",
    // ② 在哪一级
    "\\bCIT\\s*\\(A\\)", "\\bJCIT\\s*\\(A\\)", "\\bITAT\\b", "\\bCESTAT\\b", "\\bGSTAT\\b",
    "\\bDRP\\b", "争议解决小组", "上诉法庭", "上诉机关", "专员.{0,4}上诉",
    "commissioner\\s*\\(appeals\\)", "appellate\\s*(authority|tribunal)",
    // ③ 在做什么动作
    "上诉", "申诉", "应诉", "抗辩", "答辩", "复议", "暂缓征税", "暂缓征收",
    "stay\\s*of\\s*demand", "pre-?deposit", "预缴", "打官司", "败诉", "胜诉",
    "追征", "补税通知",
  ].join("|"),
  "i",
);

/**
 * 「收到了 XX」这个句式本身。
 *
 * 单独列出来是因为它极强：说"收到"就意味着**已经发生了**，不是假设性提问。
 * 「收到 notice 怎么办」和「什么情况下会收到 notice」是完全不同的两个问题，
 * 后者是合规义务型。
 */
/*
 * ⚠间隔从 14 放宽到 40（2026-09-29）。
 *
 * 实测漏判：「收到 GST（Goods and Services Tax，商品与服务税）税局关于
 * 电子运单与实际货物不符的处罚令」——「收到」和「令」之间隔了四十多个字，
 * 14 字的窗口根本够不着，整句判成了合规义务型。
 * 中文商务问句里"收到"和它的宾语之间塞一长串定语是常态，窗口开小了等于没开。
 *
 * 放宽不会把假设性问法放进来：`HYPOTHETICAL` 在所有信号之前一票否决，
 * 「什么情况下会收到税务通知」仍然是合规义务型。
 * `[^。？?]` 也还在，不会跨句拼接。
 */
/**
 * 「令 / 通知」这一类**官方文书**的名字，RECEIVED 和 ISSUED 共用一份。
 *
 * `order` 是 2026-09-29 补的（用户问「gst税局发的关于ewb与实际货物不符的 order，
 * 应该怎么应对」，因为宾语是英文 order 而漏判）。
 *
 * 它必须带**否定前瞻的商业前缀**：`purchase order`、`sales order`、`work order`
 * 在这个产品里出现的频率远高于税务裁定令，
 * 「收到客户的 purchase order 要开什么发票」是彻头彻尾的合规问题，
 * 判成争议型就会给他一张审级流程图。
 *
 * 用固定宽度的负向后顾，逐个排掉这些搭配；
 * 前面还有机关词/「收到」把关，两层一起才放行。
 */
const OFFICIAL_DOC = "(?:notice|通知|令|函|决定|SCN|单"
  + "|(?<!purchase\\s)(?<!sales\\s)(?<!sale\\s)(?<!work\\s)(?<!job\\s)(?<!delivery\\s)(?<!repair\\s)\\border\\b"
  + ")";

const RECEIVED = new RegExp(
  `(?:收到|接到|拿到|received)[^。？?]{0,40}${OFFICIAL_DOC}`,
  "i",
);

/**
 * 「**税局发来的** XX」——和 RECEIVED 是同一件事的另一种说法。
 *
 * 实测漏判（2026-09-29）：
 *
 *   > gst 税局发的关于 ewb 与实际货物不符的 notice，应该怎么应对
 *
 * 用户手里拿着一份税局的 notice，处境和"收到 notice"一模一样，
 * 只是句子的主语从自己换成了税局。RECEIVED 只认"我收到"这个方向，
 * 整句判成了合规义务型，流程图没出。
 *
 * 必须**同时**有「发文机关」和「发文动作」才算，两者缺一不可：
 * 光有 notice 不够（"e-way bill 的 notice 要求是什么"是合规问题），
 * 光有税局也不够（"税局怎么认定关联方"同样是合规问题）。
 */
const ISSUED = new RegExp(
  "(?:税局|税务局|税务机关|税务当局|海关|当局|ITD|DGGI|CBIC|GST[^。？?]{0,4}局)"
  + "[^。？?]{0,20}"
  + "(?:发来|发的|发出|发过|下发|出具|签发|开出|寄来|送达|送来)"
  + "[^。？?]{0,20}"
  + OFFICIAL_DOC,
  "i",
);

/**
 * **假设性问法**，必须一票否决。
 *
 * 实测误判：「什么情况下**会**收到税务通知」被 RECEIVED 命中，判成了争议型。
 * 但问这句话的人**还没收到任何东西**——他在做合规准备，要的是"怎么避免"，
 * 给他一张审级流程图完全答非所问。
 *
 * 这正是文件开头说的那个更糟的方向：漏判只是退回旧模板，
 * 误判是给用户一张和他处境无关的图。所以假设性标记优先级最高，先于一切信号。
 *
 * ⚠"预防/避免/防范"也算：「转让定价争议怎么**防范**」是合规义务型。
 */
const HYPOTHETICAL = new RegExp(
  [
    "什么(?:情况|情形|条件)下", "哪些(?:情况|情形)", "在何种", "如果.{0,10}(?:收到|被)",
    "会不会", "是否会", "可能(?:会)?(?:收到|被)", "万一",
    "如何(?:预防|避免|防范)", "怎么(?:预防|避免|防范)", "怎样(?:预防|避免|防范)",
    "(?:预防|避免|防范|减少).{0,8}(?:风险|争议|稽查|检查)",
    "what\\s+(?:circumstances|situations)", "how\\s+to\\s+(?:avoid|prevent)",
  ].join("|"),
  "i",
);

export function detectQuestionType(question: string): QuestionType {
  if (!question?.trim()) return "COMPLIANCE_DUTY";
  // 假设性问法一票否决，先于所有信号判断。
  if (HYPOTHETICAL.test(question)) return "COMPLIANCE_DUTY";
  if (RECEIVED.test(question) || ISSUED.test(question)) return "DISPUTE_RESPONSE";
  return DISPUTE_SIGNAL.test(question) ? "DISPUTE_RESPONSE" : "COMPLIANCE_DUTY";
}

/**
 * 会话级的问题类型。
 *
 * 和 `resolveConversationCategories` 同一个道理，而且是同一次事故教会的：
 * 多义词闸门追问之后，用户只答了「pre-deposit」两个词，
 * 单看那一句什么都判不出来——法域丢了、类型也会丢。
 *
 * 三层，当前问题永远优先（用户可以中途从争议转回合规，"那以后怎么避免再被查"）。
 */
export function resolveConversationQuestionType(
  question: string,
  priorSelfContainedQuestion?: string,
): QuestionType {
  if (detectQuestionType(question) === "DISPUTE_RESPONSE") return "DISPUTE_RESPONSE";
  // 当前句判成合规型时，要区分"真的转话题了"还是"这句太短看不出来"。
  // 判据：当前句里有没有任何实质内容。只有一两个词的追问（"pre-deposit"、"那20%呢"）
  // 不足以推翻上文，继承；有实质内容的完整问句则以当前句为准。
  const looksLikeShortFollowUp = question.trim().length <= 12;
  if (looksLikeShortFollowUp && priorSelfContainedQuestion) {
    return detectQuestionType(priorSelfContainedQuestion);
  }
  return "COMPLIANCE_DUTY";
}
