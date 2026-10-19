export type AnswerStatus =
  | "SUFFICIENT"
  | "NEED_INFORMATION"
  | "UNABLE_TO_CONFIRM";

export type FailureCode =
  | "NEED_INFO"
  | "OUT_OF_SCOPE"
  | "INSUFFICIENT_EVIDENCE"
  | "SOURCE_CONFLICT"
  | "CURRENCY_EXPIRED"
  | "PERIOD_NOT_COVERED"
  | "JURISDICTION_NOT_LOADED"
  | "FILE_PARSE_FAILED"
  | "SYSTEM_ERROR";

/** 《产品规则表 V1.4》§1 第一版覆盖范围 */
export type Domain =
  | "company_incorporation"
  | "mca_roc"
  | "fema_fdi_rbi"
  | "gst"
  | "income_tax_tds_tp"
  | "import_export_customs"
  | "industry_regulation"
  | "litigation_cases"
  | "tax_notice";

/**
 * 州级辖区。28 个邦 + 德里、本地治里、查谟-克什米尔各自有 GST Act；
 * 其余无立法机关的中央直辖区适用 UTGST Act, 2017。
 * 见《知识库数据规范 V1.4》§11.4。
 */
export type JurisdictionCode =
  | "CENTRE"
  | "AP" | "AR" | "AS" | "BR" | "CG" | "GA" | "GJ" | "HR" | "HP" | "JH"
  | "KA" | "KL" | "MP" | "MH" | "MN" | "ML" | "MZ" | "NL" | "OD" | "PB"
  | "RJ" | "SK" | "TN" | "TG" | "TR" | "UP" | "UK" | "WB"
  | "DL" | "PY" | "JK"
  | "UT";

export interface Citation {
  display_title: string;
  authority: string;
  document_number?: string;
  date?: string;
  locator: string;
  official_url: string;
  historical_label?: string;
  /**
   * 被引用段落的官方英文原文（只读）。
   * 《AI检索与回答规范 V1.4》§7：普通用户可见，但仅限本次引用到的段落。
   * snippet_display=DENY 的来源不下发本字段。
   */
  snippet?: string;
  /** 该条文的适用期间起点。留空表示与整部资料一致。 */
  effective_from?: string;
  /** 该条文的适用期间终点。留空表示仍然有效。 */
  effective_to?: string;
  /** 例如“适用于 FY 2024-25 及以后税期”。 */
  applicability_note?: string;
  /** 判例或州级来源的辖区。 */
  jurisdiction?: string;
  /** 判例：非管辖法院时为 true，展示层必须标注“仅供参考”。 */
  non_binding_jurisdiction?: boolean;
}

/**
 * 阶段三：问答里附带的相关税务判例（和 `lib/case-validator.ts` 的 `ParsedCase`
 * 字段基本对齐，但除了 `caseName`/`docid`/`officialUrl` 之外全部可选——
 * 本地案例库命中的案例字段齐全，实时兜底查 Indian Kanoon 命中的案例
 * 只有搜索结果自带的标题/来源/片段，没有做结构化提炼（省一次模型调用的
 * 时间和token），字段缺省时展示层要能优雅降级，不需要也不应该让用户
 * 看出两者的区别（产品决定：不加"本地/实时"或"未经人工整理"这类标注）。
 */
export interface RelatedCase {
  caseName: string;
  docid: string;
  official_url: string;
  court_and_year?: string;
  tax_type_and_authority?: string;
  revenue_position?: string[];
  assessee_argument?: string[];
  final_ruling?: string[];
  evidence_support?: string[];
  reference_value_note?: string;
  /** 只有实时兜底命中、没有结构化字段时才会有——Indian Kanoon 搜索结果自带的摘录片段。 */
  snippet?: string;
}

/**
 * 判例综述：把检索到的几份判例横向归纳成风险主题后的结果（见 `case-digest.ts`）。
 *
 * 和 `RelatedCase[]` 的关系：`related_cases` 是"检索到了哪几份"，这个是"归纳成了什么"。
 * 两者同时下发——前端优先渲染综述，`related_cases` 仍然保留，用于底部的原文链接，
 * 以及综述生成失败时退回简短列表。
 *
 * 注意：这里的内容**不是法律依据**，不参与 `citation_ids`。法规要求的引用只能来自
 * 已发布知识库的法条原文，判例区块不能成为绕过这条纪律的后门。
 */
export interface CaseDigestCluster {
  /** 风险主题名，例如"AMP支出被认定为转让定价国际交易"。 */
  title: string;
  /** 这一类挑战是什么。 */
  challenge: string;
  /** 实证：每条标明出自哪个 docid。docid 与其中的金额都经过服务端确定性核验。 */
  evidence: Array<{ docid: string; text: string }>;
  /** 法院倾向 / 可作抗辩的依据。 */
  takeaway?: string;
}

export interface CaseDigest {
  clusters: CaseDigestCluster[];
  /** 应对要点。 */
  action_points: string[];
  /** 案例索引：docid、案件名、从哪个角度相关。案件名以服务端记录为准，不用模型写的。 */
  index: Array<{ docid: string; case_name: string; official_url: string; angle: string }>;
}

/**
 * 追问已展示案例的模板外细节时的"现查现答"结果（例如"这个案子涉案金额是多少"——
 * 九字段模板没有这一项，靠本地库答不出来）。和 `RelatedCase` 是两条不同的链路：
 * `RelatedCase` 是问答主流程里查到的案例列表，这个字段是**追问触发**的、
 * 针对某一个已展示案例、现查判决书原文之后给出的单条回答。
 *
 * `found`/`quote_status` 由服务端 `case-detail-lookup.ts` 核验决定，不依赖模型自觉：
 * 模型给的 `source_quote` 必须真的能在现查下载回来的判决书原文里找到，
 * 找不到就不下发这个字段的具体内容（`detail` 会换成"未能核验"的提示语），
 * 逻辑和 `quote-check.ts` 给法规要求做原句核验是同一个原则——
 * 现查现答不能变成绕过这条纪律的后门。
 */
export interface CaseDetailAnswer {
  docid: string;
  caseName: string;
  official_url: string;
  /** 判决书原文里是否找到了这项细节。 */
  found: boolean;
  /** 中文回答正文；找不到或核验不过时会是提示语，不是编造的内容。 */
  detail: string;
  /** 支持 detail 的英文原句，逐字摘自现查下载的判决书原文，仅在 VERIFIED 时下发。 */
  source_quote?: string;
  quote_status: "VERIFIED" | "NOT_FOUND" | "MISSING";
}

/**
 * 用户上传Notice文件后，服务端从原文里提取出的事实（不做法律判断）。
 * 按《AI检索与回答规范 V1.4》§5.1：机关、编号、期间、金额（仅作事实）、
 * 送达日期、回复截止日、指控——字段全部可选，原文没写的就留空，
 * 不代表提取失败，只代表这份Notice里没有这项信息。
 */
export interface NoticeFacts {
  authority?: string;
  notice_or_form_number?: string;
  period?: string;
  amount?: string;
  served_date?: string;
  reply_deadline?: string;
  allegations: string[];
  /** 文件事由/主题——通报类文件没有"指控"，事由是唯一能说明它讲什么的字段。 */
  subject_matter?: string;
}

/** `/api/attachments` 上传接口，每个文件对应一条结果。 */
export interface AttachmentUploadResult {
  attachment_id: string;
  file_name: string;
  status: "EXTRACTED" | "UNSUPPORTED" | "FAILED";
  /** status不是EXTRACTED时的原因，直接展示给用户（格式不支持/解析失败等）。 */
  error_message?: string;
  /** 只有status==="EXTRACTED"才会有，供用户在提问前先确认提取得对不对。 */
  notice_facts?: NoticeFacts;
}

export interface AttachmentUploadResponse {
  conversation_id: string;
  results: AttachmentUploadResult[];
}

export interface QueryRequest {
  question: string;
  /**
   * 只供会话历史展示的用户原话。专用追问框需要把上一问和本次补充合成 `question`
   * 才能让服务端独立判断，但历史里应只显示用户刚刚补充的那一句。
   */
  display_question?: string;
  conversation_id?: string;
  selected_profile_id?: string;
  attachment_ids?: string[];
  /** 用户问题涉及的法律适用日期。缺失时按当前日期处理。 */
  target_date?: string;
  /** 州级问题的辖区。缺失时由企业档案的注册州推导。 */
  jurisdiction?: JurisdictionCode;
}

export interface AnswerResponse {
  request_id: string;
  /**
   * 多轮对话的会话标识。route.ts 在返回前统一附加——legal-answer.ts本身不感知会话，
   * 就像它不感知鉴权一样，保持单一职责。首问没带 conversation_id 时服务端会新建一个，
   * 前端存下来，追问时带上就能享受上下文延续和免费追问额度。
   */
  conversation_id: string;
  answer_status: AnswerStatus;
  /**
   * 模型申报的证据覆盖程度（见 `answer-self-doubt.ts`）。
   *
   * **必须下发到前端。** `answer_status` 只有三个值，PARTIAL 映射到 SUFFICIENT，
   * 于是界面给一份自陈"证据未直接规定"的答案盖了绿色的「依据充分」章
   * ——2026-09-28 实测两次都是这样。
   *
   * PARTIAL 不降级是刻意的（验收 #58：主干答对了的答案不该作废），
   * 但"不降级"不等于"装作完全覆盖"。状态语义留三个值，**徽标文案按这个字段走**。
   *
   * 缺省 = 模型没报。界面按 FULL 之外处理，理由同 `adjustForSelfDoubt`：
   * 说不清就不该显得很确定。
   */
  evidence_sufficiency?: "FULL" | "PARTIAL" | "NONE";
  /**
   * 「部分覆盖」**具体缺的是哪一块**。
   *
   * 2026-09-29 用户问：「部分覆盖是为什么」。问出这句话本身就说明徽标失败了——
   * 它诚实地降了级，却没说降级的理由，用户看到的只是一个黄标。
   *
   * 后果不是"少了点信息"，而是**这个降级无法被使用**：
   * 用户既不知道该不该信这份答案的主干，也不知道该往库里补什么。
   * 一个说不出理由的警告，用户第二次就会忽略它。
   *
   * 「有出处的和没出处的不能长得一样」这条纪律，推到这里就是：
   * **哪一块没出处，也得说出来。**
   *
   * 只在 PARTIAL / NONE 时下发。模型报了 PARTIAL 却没填这个字段时，
   * 展示层给一句中性的兜底文案——不编造缺口，也不假装没降级。
   */
  evidence_gap?: string;
  /**
   * 问题类型。决定答案走哪套模板。
   *
   * `DISPUTE_RESPONSE`（争议应对型）会额外下发 `dispute_track`，展示层渲染成流程图。
   * 判定见 `question-type.ts`——那里写了为什么"成本模型不是法定要求的列表"。
   */
  question_type?: "COMPLIANCE_DUTY" | "DISPUTE_RESPONSE";
  /**
   * 这个问题落在哪几个法域（会话级，`resolveConversationCategories` 的结果）。
   *
   * 下发给展示层是为了**给「法规要求」的分组把关**，判定本身早就在服务端做完了。
   *
   * 实测事故（2026-09-29）：用户问 GST，一条要求同时引了
   * 角标 5（ICAI IDTC – GST Law）和角标 11（Income-tax Act, 2025）。
   * 分组按位阶取最高的那条引用 → 选中了 Income-tax Act，
   * 于是这条纯 GST 的内容（进项税、10% 或 1 万卢比的罚款）
   * 被挂在了「所得税 / DTAA」标题下面，而它真正的出处降级成了「另据」。
   *
   * 位阶规则本身没错（它修的是 CBDT 备忘录被盖「法律」章那个事故），
   * 错在**它是在跨法域的候选里排序的**。位阶只在同一法域内部可比：
   * 所得税法的位阶再高，也不是 GST 问题的法源。
   * 所以顺序必须是**先法域、后位阶**。
   *
   * 认不出法域时是空数组，展示层退回纯位阶排序——不猜。
   */
  question_categories?: string[];
  /**
   * 争议应对型的**审级骨架**：从 `config/dispute-tracks.json` 按法域取的那一条。
   *
   * ⚠**这个字段不经过模型。** 审级顺序、期限、规费、预缴比例都是配置里的定值，
   * 模型在争议型答案里的活只剩三件：判断走哪条分支、把用户的具体金额代进去、写结论。
   * 法定数字不经过它的手，就不会编、不会用被取代的旧值。
   *
   * 每个 cell 带 `basis`：`STATUTE`（有条文）或 `PRACTICE_ESTIMATE`（无条文的实务估计，
   * 主要是平均耗时）。**展示层必须把两者在视觉上分开**——这是这个产品最要紧的一条纪律。
   *
   * 法域认不出来时不下发。三个税种的预缴比例和审级完全不同，给错一张图比不给更糟。
   */
  dispute_track?: unknown;
  /**
   * 争议流程图**这一轮不画了，因为本次对话上文已经画过同一条**。
   *
   * 实测事故（2026-09-29）：用户问「收到 DGGI 的 show cause notice 该怎么办」，
   * 拿到了完整的 GST 三级流程图；接着追问「有什么相关案例吗」，
   * **整张图一模一样地又出现了一遍**——三个审级、四格成本、连注释都是同一份。
   * 用户第二问想要的只有判例，却要先滚过两页已经读完的东西才看得到答案。
   *
   * 骨架是配置里的定值，同一条对话里它**不会变**，所以重画没有任何信息增量。
   * 一条对话里同一条 track 只画一次，后续轮次只留一行指路。
   *
   * 值是被略过的那条 track 的中文名，展示层用它写"见上文的 XX 争议流程"。
   * **换了法域（所得税 → GST）时不触发**：那是另一条图，用户没见过。
   */
  dispute_track_omitted?: string;
  /**
   * 判例检索**跑了但一条都没有**。
   *
   * 不下发这个字段 = 没检索（这个问题压根没触发判例检索），两者不能混。
   *
   * 实测（2026-09-29）：用户直接问「有什么相关案例吗」，判例区整块不渲染，
   * 页面上只剩法条和流程图。用户问的那件事在界面上**没有任何回应**——
   * 他没法判断是"系统没找"还是"库里没有"，只能再问一遍。
   *
   * 「有出处的和没出处的不能长得一样」这条纪律在这里的推论是：
   * **查过没有，和没查过，也不能长得一样。**
   *
   * 两个值的区别要保留，它们是两件事：
   *   · `NO_MATCH`         检索跑完，库里没有沾边的。
   *   · `JUDGED_IRRELEVANT` 检索到了，但逐份读过之后判定与问题无实质关联
   *                         （见 `CASE_DIGEST_IRRELEVANT`）。这时候说"没有"
   *                         是准确的——列一堆不相干的判例比不列更伤信任。
   */
  case_search_empty?: "NO_MATCH" | "JUDGED_IRRELEVANT";
  /**
   * 用户上传的 Notice/Order 里写明的**回复截止日**（2026-10-13 加）。
   *
   * 只在这轮附件提取到了 reply_deadline、**且能解析成具体日期**时下发；
   * 原文写的是"30天内"这类相对期限时解析不出、不下发——宁缺勿错。
   *
   * - `date`：归一化后的 YYYY-MM-DD（印度 DD/MM/YYYY 等写法已折算，见
   *   notice-extract.ts 的 normalizeReplyDeadline）。
   * - `text`：原文里的写法，展示层随行附上，让用户能对回原文核对——
   *   "有出处的和没出处的不能长得一样"：这个日期来自 OCR/解析，认错数字
   *   是可能的，必须让用户看得见原始依据。
   * - `authority`：发出机关，给提醒起默认标题用。
   *
   * 展示层渲染成红色提示行，点击跳到合规提醒页预填该日期。
   * **不自动创建提醒**——"AI 建议的日期必须经用户确认"是产品规则表的硬约束。
   */
  reply_deadline?: {
    date: string;
    text: string;
    authority?: string;
  };
  failure_code?: FailureCode;
  short_conclusion: string;
  /**
   * 结论下方横排的**关键数值**（最多 4 个），展示层用全页最大的字号渲染。
   *
   * ## 为什么值得单独开一个字段
   *
   * 用户问"付特许权使用费要办什么手续"，真正想带走的是 20%、10%、18%、7个工作日
   * 这几个数。它们现在散落在「法规要求」的条目里，要读完三段才凑得齐。
   *
   * ## 标签靠模型，数值靠确定性校验
   *
   * `label`/`note` 这类人话（"法定预提税率""未取得TRC时适用"）只能由模型写——
   * 从条文原文里机械截取出来的短语读不通。
   * 但 `value` 绝不信模型：服务端 `verifyKeyFigures()` 会检查每个数值
   * **是否逐字出现在某条 MANDATORY 步骤的正文里，且不在那条步骤的 unverified_claims 里**，
   * 对不上的整条丢弃。
   *
   * 这道校验不是可选的。把一个没有出处的数字放大到全页最大字号，
   * 正是 action_steps.unverified_claims 注释里说的那种最危险的失败方式
   * ——"有依据的外观 + 无依据的内容"——的极端形态。
   *
   * 校验后一条都不剩时为空数组，展示层整块不渲染（不留空格子）。
   */
  key_figures: Array<{
    /** 逐字来自某条已核验 MANDATORY 步骤，例如 "20%"、"7 个工作日"、"Form 145"。 */
    value: string;
    /** 这个数字是什么，例如 "法定预提税率"。 */
    label: string;
    /** 适用条件，例如 "未取得 TRC 时适用"。可省。 */
    note?: string;
  }>;
  assumptions: string[];
  action_steps: Array<{
    kind: "MANDATORY" | "PRACTICAL";
    text: string;
    /**
     * 这一条要求／建议所依据的引用序号（1 开始，对应 citations 数组的位置）。
     * 模型没有老实标注、或标注的证据被适用期间校验剔除时为空数组——
     * 展示层必须照常显示这一条，只是归到「未标注具体依据」，不能因此吞掉内容。
     */
    citation_refs: number[];
    /**
     * 这条步骤里"在引用证据中找不到出处"的硬信息（申报表格编号、天数期限、百分比）。
     * 由服务端 `claim-check.ts` 逐条比对得出，不依赖模型自觉。
     * 非空时展示层必须给出显著提示——模型确实出现过"凭记忆写出错误表格和期限、
     * 却挂着角标"的情况，那种"有依据的外观 + 无依据的内容"是最危险的失败方式。
     */
    unverified_claims: string[];
    /**
     * 这一条用到的、**被引用条文自己标注为已被取代**的数值。
     *
     * 和 `unverified_claims` 的区别：那个问"这个数在条文里找不找得到"，
     * 这个问"这个数在条文里找得到，但条文同时说了它已经被改掉了"。
     * 后者更隐蔽——数字确实逐字出现在原文里，所有既有校验都会放行。
     *
     * 真实事故（2026-09-28）：CBDT 备忘录条目写着
     * `deposit rate 15% [NOTE: this 15% was revised to 20% by the O.M. ...]`，
     * 答案写「需支付争议税款的 15% 作为预缴」。资料对、标注也到位，
     * 是模型读了 15% 就用了，没读后面那句 NOTE。差五个百分点。
     *
     * **只标记，不改写**——悄悄改法律数字是系统没资格做的判断，
     * 万一那一条讲的确实是历史年度就把对的改错了。判定见
     * `intra-document-supersession.ts`。
     */
    superseded_values?: Array<{
      used: string;
      replacement: string;
      /**
       * OLD_ONLY 只写了旧值；REVERSED **把旧值写成了现行的**（最危险）；
       * UNCLEAR 新值出现了但没说清它才是现行的。
       * 三种的文案必须分开——对用户的含义不一样。
       */
      kind: "OLD_ONLY" | "REVERSED" | "UNCLEAR";
    }>;
    /**
     * 模型声明的、支持这条要求的英文原句（逐字取自证据原文）。
     *
     * 为什么要这个字段：`claim-check` 只能校验表格编号、天数、百分比这类**数字**，
     * 因为数字能做字符串比对。但"中资股东须经政府审批"这类**命题**过去完全没有校验——
     * 模型可以凭自己的记忆写出一句正确的法律结论，再挂一个最像的角标上去，系统看不出来。
     * 线上实测到的就是这种：第5.2条被引来支持 Press Note 3 限制，
     * 但那一段原文只讲行业上限，一个字都没提接壤国家。
     *
     * 要求模型附上原句，等于把"这个结论语义上对不对"（没法机械验证）
     * 转成"这句话在不在被引用的原文里"（可以精确匹配验证）。
     */
    source_quote?: string;
    /**
     * 上述原句的核验结果，由服务端 `quote-check.ts` 判定，不依赖模型自觉：
     * - VERIFIED：原句确实出现在该条引用的证据原文里
     * - NOT_FOUND：模型给了原句，但证据原文里找不到——这条大概率是凭记忆写的
     * - TABLE_UNVERIFIABLE：引用的是**表格型条文**，PDF 抽出来的正文列与列交错，
     *   线性顺序上根本读不通，任何字符串匹配都必然判负。
     *   这种情况下系统**分不清**"引用指错了"和"表格错栏"，所以不下这个判断。
     *   详见 quote-check.ts 里 TABLE_MARKER 的说明。
     * - MISSING：模型没给原句
     * - SKIPPED：实务建议等不要求原句的条目
     */
    quote_status?: "VERIFIED" | "NOT_FOUND" | "TABLE_UNVERIFIABLE" | "MISSING" | "SKIPPED";
  }>;
  /**
   * 实务建议是否具有明显的先后流程关系（由模型判断）。
   * true 时展示层用流程图渲染，false 时用普通列表。
   */
  practical_is_sequential?: boolean;
  risks_and_exceptions: string[];
  citations: Citation[];
  /** 《AI检索与回答规范 V1.4》§6：非 Notice 类最多 5 项；Notice 类按 §5.1 最多 3 组。 */
  missing_information: string[];
  /**
   * 可由页面承接的特定追问类型。
   *
   * 所得税适用期间是唯一可以用一行日期 / FY / AY 直接补齐的追问；明确标记后，
   * 展示层才能把它做成输入对话框，而不会误把一般事实补充也当作期间输入。
   */
  clarification_kind?: "INCOME_TAX_TIME";
  charge_eligible: boolean;
  /**
   * 本回答依据的法律经核验为现行有效的截止日期。
   * 取本次全部被引用版本中最早的 legal_currency_checked_at。
   * 不是失效日，也不是知识库更新时间。
   */
  legal_as_of?: string;
  /**
   * 阶段三：本次问答触发了判例检索时附带的相关案例（本地案例库优先，
   * 本地没有相关案例才实时查 Indian Kanoon 兜底）。大多数问题不涉及判例，
   * 这个字段大多数情况下会是空数组或缺省——`case-relevance.ts` 的
   * `shouldSearchCases()` 判断问题里有没有判例相关信号词，没有信号词
   * 就不触发这次检索，不是每次问答都会尝试。
   */
  related_cases?: RelatedCase[];
  /**
   * 判例综述。只有 `related_cases` 非空、且综述生成并通过核验时才有；
   * 生成失败或核验后什么都不剩时缺省，前端据此退回简短的案例列表。
   */
  case_digest?: CaseDigest;
  /**
   * 判例的**检索口径说明**，展示在判例区块顶部。只有走了专用检索路由
   * （`case-route.ts`：按公司查 / 按主题查）时才有。
   *
   * 为什么必须有：这两条链路查到的东西，**和用户字面问的可能不是一回事**——
   * - 用户问"代持"，我们实际搜的是印度法上的 `benami`（不是直译）
   * - 用户问"三星的代持案例"而三星没有，给的是**其他企业**的代持案例
   * - 主题过滤没能自检通过时，不能宣称"已按主题筛选"
   *
   * 列表本身看不出这些。不下发这句说明，用户会把别家的案子当成三星的、
   * 把没筛过的当成筛过的。这和判例区块"说清信息从哪来"是同一条要求。
   */
  case_search_note?: string;
  /**
   * 本次回答使用的语言，由服务端 `answer-language.ts` 确定性判定。
   * 下发给前端有两个用途：① 追问时保持同一语言（存进对话记录）；
   * ② 将来做前端标签 i18n 时直接用这个值，不用前端自己再判一次——
   * 两处各判一次迟早会不一致。
   */
  answer_language?: "zh" | "en";
  /**
   * 这次提问**本身要的就是判例**（"有哪些海关方面的官司""找几个转让定价的案子"），
   * 而不是"顺带给几个判例参考"。见 `case-relevance.ts` 的 `isCaseSeekingQuestion`。
   *
   * 为 true 时前端把「相关判例」提到最前面、把「法规要求」的标题改成
   * 「相关法律依据」并排到判例之后——信息一条不少，只换主次。
   *
   * 起因（2026-09-18 实测）：用户问"目前有哪些海关方面的官司"，
   * 拿到的是海关法上诉程序条文摆在最上面、判例埋在最底下。方向反了。
   */
  case_led?: boolean;
  /**
   * 这个对话的标题（20字以内），**只在对话的第一轮下发**，之后的追问不再带。
   * 前端拿它写进「最近对话」列表——列表按对话列，不按问题列，所以标题是
   * 话题的名字，不是最后一问的名字。见 `conversation-title.ts`。
   */
  conversation_title?: string;
  /**
   * 这次提问之后的额度情况（2026-09-17加）。每次回答都带，
   * 让界面显示的剩余次数和服务端的实际计数来自同一处，不会各说各话。
   */
  quota?: {
    plan: "free" | "professional" | "anonymous";
    limit: number;
    used: number;
    remaining: number;
  };
  /**
   * 追问细节现查现答：只有这一轮命中了"追问已展示案例的模板外细节"这个专门流程
   * 才会有（见 `case-detail-lookup.ts`）。和 `related_cases` 互斥——这一轮要么是
   * 正常问答顺带带出相关判例，要么是专门追问某个案例细节，不会同时出现。
   */
  case_detail_answer?: CaseDetailAnswer;
  policy_version: "1.4";
}

/** 非 Notice 类问题的追问上限。 */
export const MAX_CLARIFICATION_ITEMS = 5;
/** Notice 类问题的追问上限（《AI检索与回答规范》§5.1）。 */
export const MAX_NOTICE_CLARIFICATION_ITEMS = 3;

/** 《AI检索与回答规范 V1.4》§3.2 证据配额。 */
/**
 * 证据配额。
 *
 * 关键点：`maxElements` 和 `maxTotal` 是**按"法律层"计的**，不是整个问题的总额。
 * 一个问题跨几个法律层（例如"中资股东增资"同时涉及①公司法的增发程序与ROC申报
 * ②FEMA/FDI的路径、定价与外汇申报），每一层各自享有 4 个要件名额、12 条证据额度，
 * 避免语义上更贴近的那一层把另一层整个挤掉——这正是公司法曾被 FDI 文件挤出结果的原因。
 *
 * 只有一个法律层时，行为与按整题计额完全一致。
 */
export const EVIDENCE_QUOTA = {
  minPerElement: 1,
  maxPerElement: 3,
  /** 每个法律层的证据条数上限。 */
  maxTotal: 12,
  /**
   * 每个法律层的**默认**要件数。模型可以按问题实际复杂度多列，上限见 maxElementsHardCap。
   *
   * 为什么不再固定 4：实测发现"向外资发行新股"在公司法上的真实义务至少七条
   * （s42私募配售、s62优先配股、s39配发申报PAS-3、s64股本变更通知、s61授权股本、
   * s13章程修改、s48类别权利）。固定 4 个名额时，**数学上就注定要漏三条**，
   * 而漏掉哪几条取决于模型当时怎么想——这不是提示词能救的，是配额本身设错了。
   */
  maxElements: 4,
  /** 要件数的硬上限。放宽是为了覆盖义务本来就多的问题，同时防止提示词无限膨胀。 */
  maxElementsHardCap: 8,
  /** 最多处理几个法律层，防止提示词无限膨胀。 */
  maxLayers: 3,
  /** 跨所有层的全局证据硬上限，控制提示词长度与成本。 */
  maxTotalAllLayers: 30,
} as const;

export interface KnowledgeChunkPreview {
  source: string;
  majorTitle: string;
  minorTitle: string;
  officialUrl: string;
  bodyLength: number;
}

export interface KnowledgeChunkReview extends KnowledgeChunkPreview {
  number: number;
  body: string;
  wordCount: number;
  warning?: string;
  /**
   * 正文出现 with effect from、shall come into force、inserted by ... Act, 20XX
   * 等措辞时置为 true。《知识库数据规范 V1.4》§3 要求管理员强制确认条文级生效日，
   * 可以确认“与整部法一致”，但不得跳过。
   */
  needsEffectiveDateConfirmation?: boolean;
  /** 触发上述提醒的原文片段，便于管理员直接判断。 */
  effectiveDateHints?: string[];
  /** 条文级生效日。留空表示与所属版本一致。 */
  provisionEffectiveFrom?: string;
  provisionEffectiveTo?: string;
  applicabilityNote?: string;
  /** 州级 chunk 专用：中央对应条文的生效日。 */
  centreEffectiveFrom?: string;
  /** 所属辖区。留空按 CENTRE 处理。 */
  jurisdiction?: JurisdictionCode;
  /** 是否允许向普通用户展示被引用段落原文。 */
  snippetDisplay?: "ALLOW" | "DENY";
  /** 法律现行性核验时间，用于推导 legal_as_of。 */
  legalCurrencyCheckedAt?: string;
  /**
   * 法律**位阶**：Act > Rules > Notification > Circular。
   *
   * 参与三件事（见 `legal-hierarchy.ts`）：检索配额保底、结论锚定校验、冲突提示。
   * 和 `document-category.ts` 的"法域"是正交的两个维度——
   * 一部 CGST Rules 既属于 GST 法域，也属于 RULES 位阶。
   *
   * **由管理员在后台确认**，上传时按资料名推断出默认值、但必须人工过一眼。
   * 为什么不纯靠推断：推断在现有 58 份资料上 14/14 正确，但资料名是自由文本，
   * 下一份就可能写成"所得税法实施细则汇编"这种推不出来的；
   * 而位阶判错的后果是**一份 circular 被当成 Act 去锚定结论**——
   * 那正是这套机制要防的事，不能让它自己出错。
   */
  hierarchyLevel?: "ACT" | "RULES" | "NOTIFICATION" | "CIRCULAR" | "UNKNOWN";
}

/**
 * 合规提醒的状态（2026-09-30 加）。
 *
 * 类型放在 contracts 而不是 lib/server/reminder-store：提醒页要用它渲染列表，
 * 而 reminder-store 依赖 node:fs、不能进客户端 bundle。
 * 状态怎么流转见 reminder-store.ts 里的注释。
 */
export type ReminderStatus = "ACTIVE" | "PAUSED" | "SENT" | "CANCELLED";

/** 提醒从哪来：MANUAL 用户手填，NOTICE 由 Notice 提取的日期转来。 */
export type ReminderSource = "MANUAL" | "NOTICE";

/** 返回给前端的提醒。不带锁、重试次数这些内部字段。 */
export interface ReminderView {
  id: string;
  title: string;
  /** 邮件正文里的说明：这条提醒讲的是什么、依据哪份文件。 */
  detail: string;
  /** 截止时刻（UTC ISO）。 */
  deadlineAt: string;
  /** 截止时刻的时区，展示用。 */
  deadlineTimezone: string;
  /** 计划发信时刻（UTC ISO）。 */
  notifyAt: string;
  status: ReminderStatus;
  source: ReminderSource;
  createdAt: string;
}

export interface KnowledgeValidationResult {
  fileName: string;
  chunkCount: number;
  separatorCount: number;
  status: "READY_TO_REVIEW" | "VALIDATION_FAILED";
  errors: string[];
  warnings: string[];
  /** 需管理员逐条确认的事项，未确认不得发布。 */
  confirmations: string[];
  preview: KnowledgeChunkPreview[];
  chunks: KnowledgeChunkReview[];
  /**
   * 文件头部声明的整份资料适用期间（2026-09-16 加，见 knowledge-validator.ts 文件头说明）。
   * 每个chunk上已经各自带了合并后的值，这三个字段只是给后台审核界面做汇总展示用，
   * 免得管理员要逐条展开才能看出"这份传的是已废止的旧法"。
   */
  documentEffectiveFrom?: string;
  documentEffectiveTo?: string;
  documentApplicabilityNote?: string;
}
