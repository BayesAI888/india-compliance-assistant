import { NextResponse } from "next/server";
import { buildConversationTitle, truncateTitle } from "../../../lib/server/conversation-title";
import {
  MAX_NOTICE_CLARIFICATION_ITEMS,
  type AnswerResponse,
  type QueryRequest,
} from "../../../lib/contracts";
import { isDeepSeekConfigured } from "../../../lib/server/deepseek";
import { getPublishedKnowledgeChunks } from "../../../lib/server/knowledge-store";
import { featuredKnowledgeVersion, findFeaturedAnswer } from "../../../lib/server/featured-answer-store";
import { answerFromPublishedKnowledge, isAnswerTraceEnabled, type PriorTurnContext } from "../../../lib/server/legal-answer";
import {
  appendTurn,
  canReadConversation,
  getConversation,
  getLastTurn,
  getOrCreateConversation,
  trimAnswerForStorage,
  type ConversationTurn,
  type StoredRelatedCaseRef,
} from "../../../lib/server/conversation-store";
import { hasReferringExpression, previousTurnComparableText, questionOverlapRatio, rewriteFollowUp, type TopicRelation } from "../../../lib/server/question-context";
import { applyFollowUpCharging, canBypassQuotaAsFollowUp } from "../../../lib/server/followup-charging";
import { extractCitedLaws, extractMandatoryFirstSentences } from "../../../lib/server/turn-summary";
import { detectCaseDetailFollowUp, pickCaseForFollowUp } from "../../../lib/server/case-relevance";
import { buildCaseDetailResponse, isCaseDetailLookupEnabled } from "../../../lib/server/case-detail-lookup";
import { getAttachmentsForConversation, type StoredAttachment } from "../../../lib/server/attachment-store";
import { appendNoticeContext, buildNoticeExcerpt, hasUsableNoticeFacts, normalizeReplyDeadline } from "../../../lib/server/notice-extract";
import { detectOutOfScope, buildOutOfScopeResponse } from "../../../lib/server/out-of-scope";
import {
  currentYearMonth,
  identifyRequest,
  quotaExhaustedResponse,
  trialCookie,
} from "../../../lib/server/request-identity";
import { anonymousQuotaView, quotaViewOf } from "../../../lib/server/plan-quota";
import { ANONYMOUS_IP_DAILY_LIMIT, recordIpTrial } from "../../../lib/server/anonymous-trial-store";
import { consumeQuota } from "../../../lib/server/user-store";
import { detectQuestionCategories } from "../../../lib/server/domain-scope";
import { hasHistoricalCaseCutoff, resolveIncomeTaxTime, type IncomeTaxTimeResolution } from "../../../lib/server/income-tax-time";
import {
  beginQuestionAudit,
  completeQuestionAudit,
  markQuestionAuditQuotaExhausted,
} from "../../../lib/server/question-audit-store";

const POLICY_VERSION = "1.4" as const;
const MAX_CHAT_REQUEST_BYTES = 16 * 1024;
const MAX_QUESTION_CHARS = 2_000;

const answerCache = new Map<string, {
  expiresAt: number;
  answer: Omit<AnswerResponse, "request_id" | "conversation_id">;
}>();

/*
 * 浏览器遇到 502/504 后会带着同一个随机请求标识自动重连（见 page.tsx）。
 *
 * 反向代理先超时、Node 里的检索仍在跑完是现实场景：若把重连当作新请求，不但会
 * 重打一整条 RAG/判例链路，还可能重复写入同一轮对话、重复扣额度。这里保留正在
 * 处理的完整 HTTP 响应 Promise，让同一请求的重连只等待第一次的真实结果。
 *
 * 这个标识仅接受 UUID，来自浏览器 crypto.randomUUID()；Map 在请求结束时立即删掉，
 * 不作为长期缓存，也不替代下面按用户和上下文隔离的 answerCache。
 */
const inFlightChatRequests = new Map<string, Promise<Response>>();
const CLIENT_REQUEST_ID_HEADER = "x-chat-request-id";

function clientRequestIdOf(request: Request): string | undefined {
  const value = request.headers.get(CLIENT_REQUEST_ID_HEADER)?.trim().toLowerCase();
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value
    : undefined;
}

function requestId() {
  return `req_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function jsonResponse(body: AnswerResponse, extraHeaders: Record<string, string> = {}) {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store",
      "X-Policy-Version": POLICY_VERSION,
      ...extraHeaders,
    },
  });
}

function priorContextFrom(turn: ConversationTurn): PriorTurnContext {
  return {
    selfContainedQuestion: turn.selfContainedQuestion,
    shortConclusion: turn.shortConclusion,
    mandatoryFirstSentences: turn.mandatoryFirstSentences,
    citedLaws: turn.citedLaws,
    relatedCases: turn.relatedCases.length
      ? turn.relatedCases.map((item) => ({ caseName: item.caseName, docid: item.docid }))
      : undefined,
    /**
     * 上一轮用的什么语言，这一轮就接着用——追问不能中途换语言。
     *
     * 直接从存下来的完整回答里读，**不新增存储字段**：`answer` 从 2026-09-17
     * 起就整份存着了，`answer_language` 是它的一个字段，天然跟着一起持久化。
     * 老数据没有这个字段时是 undefined，`resolveAnswerLanguage` 会退回按问题本身判，
     * 行为和改动之前一致。
     */
    answerLanguage: turn.answer?.answer_language,
  };
}

/**
 * GET /api/chat?conversation_id=...
 * 读回一个已有对话的轮次，供「最近对话」点进去时把之前聊过什么重新显示出来。
 *
 * 2026-09-17 产品决定：对话的边界完全由用户的动作决定（进入网页/点新建对话＝新对话，
 * 点最近对话＝回到那条继续问）。要能"回到那条"，就必须有一条**不依赖页面内存**的
 * 读取路径——这和复盘第38条（待审核资料卡死）是同一个教训。
 *
 * 返回每一轮的问题和**完整回答**，前端原样重现回答卡片。
 * 老数据里没有存完整回答（这个字段2026-09-17才加），那些轮次只有一句话结论，
 * 前端拿不到 answer 时退回只显示结论，不报错。
 */
export async function GET(request: Request) {
  const conversationId = new URL(request.url).searchParams.get("conversation_id")?.trim() ?? "";
  if (!conversationId) {
    return NextResponse.json({ error: "CONVERSATION_ID_REQUIRED", message: "缺少对话标识。" }, { status: 400 });
  }

  const identity = await identifyRequest(request);
  // 游客试用只返回本次回答，不提供可由 URL 访问的服务端历史记录。
  // 上传资料和跨设备历史均要求登录，避免对话 ID 变成敏感内容的通行证。
  if (!identity.user) {
    return NextResponse.json(
      { error: "CONVERSATION_NOT_FOUND", message: "这条对话已经过期或不存在（对话保留30天）。" },
      { status: 404 },
    );
  }
  const conversation = await getConversation(conversationId);
  /*
   * 归属校验（2026-09-18）：对话记上 userId 之后，别人就读不到了。
   * 在这之前这个接口**完全不校验身份**——谁拿到 conversation_id 谁就能读全文。
   * ID 是 UUID 猜不到，所以不算高危，但既然有了账号，就该关上。
   *
   * 找不到和无权读**返回同一个 404**：区分开就等于告诉对方"这个ID是存在的"，
   * 成了一个探测他人对话是否存在的接口。和登录不区分"邮箱不存在/密码错"同一个道理。
   */
  if (conversation && !canReadConversation(conversation, identity.user?.id)) {
    return NextResponse.json(
      { error: "CONVERSATION_NOT_FOUND", message: "这条对话已经过期或不存在（对话保留30天）。" },
      { status: 404 },
    );
  }
  if (!conversation) {
    // 会话保留30天，过期后就真的没有了——如实告诉前端，让它把这条从列表里清掉，
    // 而不是留一个点进去永远是空的入口。
    return NextResponse.json(
      { error: "CONVERSATION_NOT_FOUND", message: "这条对话已经过期或不存在（对话保留30天）。" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    conversation_id: conversation.id,
    turns: conversation.turns.map((turn) => ({
      turn_id: turn.turnId,
      asked_at: turn.askedAt,
      question: turn.rawQuestion,
      short_conclusion: turn.shortConclusion,
      answer_status: turn.answerStatus,
      answer: turn.answer,
    })),
  }, { headers: { "Cache-Control": "no-store" } });
}

async function handleChatPost(request: Request) {
  let payload: QueryRequest;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_CHAT_REQUEST_BYTES) {
    return NextResponse.json(
      { error: "REQUEST_TOO_LARGE", message: "问题内容过长，请压缩到更短的描述后再试。" },
      { status: 413 },
    );
  }

  try {
    payload = (await request.json()) as QueryRequest;
  } catch (error) {
    console.error("[chat] knowledge answer pipeline failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json(
      { error: "INVALID_JSON", message: "请求格式无效。" },
      { status: 400 },
    );
  }

  const question = payload.question?.trim();
  if (!question) {
    return NextResponse.json(
      { error: "QUESTION_REQUIRED", message: "请输入要核对的问题。" },
      { status: 400 },
    );
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: "QUESTION_TOO_LONG", message: "问题最多可输入 2000 个字符，请精简后再提交。" },
      { status: 400 },
    );
  }
  // 专用追问会把「原问题 + 本次补充」一并送进 `question`，确保本轮可独立判断；
  // 保存历史时则只展示用户新输入的补充，避免把原问题重复一遍。展示文字不参与法律判断。
  const displayQuestion = typeof payload.display_question === "string" && payload.display_question.trim().length > 0
    && payload.display_question.trim().length <= MAX_QUESTION_CHARS
    ? payload.display_question.trim()
    : question;

  /*
   * 额度校验（2026-09-17加，2026-09-18 改判据）。在这之前界面上的"免费额度1/1次"
   * "升级专业版"全是前端写死的摆设，后端一次都没检查过。
   *
   * 真正的扣减在最后（见 consumeQuota 那段）——**只有真的产生了要扣费的回答才扣**，
   * 追问免费、拒答不扣次这些既有规则原样生效。
   *
   * 这里只取身份和当前额度，**先不拦**：拦不拦要看这一轮是不是追问，
   * 而那要先把会话读出来才知道。见下面 canBypassQuotaAsFollowUp 那段。
   */
  const identity = await identifyRequest(request);

  const id = requestId();

  // 多轮对话：有ID且存在就复用，否则新建——前端拿到conversation_id后自己存着，
  // 下次带上就能享受上下文延续和免费追问额度。没有会话历史的首问不受影响，
  // 走原来的路径（selfContainedQuestion===question，不调用改写模型）。
  // 建对话时记下归属：这样「最近对话」就能跟着账号走，而不是跟着浏览器走
  // （2026-09-18 用户实测：同一账号换浏览器登录，历史全没了）。
  // 游客每次只获得一次试用回答，不复用客户端传来的对话 ID；登录用户才可继续
  // 自己的历史对话。这样同一 ID 不会在不同身份之间串用。
  const conversation = await getOrCreateConversation(
    identity.user ? payload.conversation_id : undefined,
    identity.user?.id,
  );
  if (!conversation) {
    return NextResponse.json(
      { error: "CONVERSATION_NOT_FOUND", message: "这条对话已经过期或不存在（对话保留30天）。" },
      { status: 404 },
    );
  }
  // 后台审计从请求开始就建档。即使用户额度不足、范围外或模型暂不可用，也能留下
  // 状态；它与用户会话历史分开，避免把失败提示污染下一轮的法律上下文。
  try {
    await beginQuestionAudit({
      requestId: id,
      conversationId: conversation.id,
      userId: identity.user?.id,
      displayQuestion,
      selfContainedQuestion: question,
    });
  } catch (error) {
    console.error("[chat] failed to begin question audit", error instanceof Error ? error.message : "unknown error");
  }
  const previousTurn = getLastTurn(conversation);
  // 用户把上一句“未能确认 / 仍需补充”的问题原样再发一次，是在重试，不是在
  // 顺着那份未完成答案追问。若仍把它当作 CONTINUATION，就会把失败结论塞进
  // 下一轮改写和检索上下文，表现成“第一次报错、第二次才像是读到了缓存”。
  // 失败轮次仍保留在历史记录中，但不应污染一次原样重试。
  const isExactRetryAfterIncompleteAnswer = Boolean(
    previousTurn
    && previousTurn.answerStatus !== "SUFFICIENT"
    && previousTurn.rawQuestion.trim() === question.trim(),
  );

  // Notice类问题：有没有可用的附件决定走哪条路。attachment_ids只是"用户上传过
  // 文件"，不代表提取成功——附件可能是不支持的格式（图片/旧版.doc）或解析失败，
  // 这些都要当成"没有可用的Notice信息"处理，而不是假装有信息往下走。
  // 挪到这么早（原本这段在下面的else分支里），是因为下面判断要不要走"追问改写"
  // 需要提前知道这一轮有没有真的拿到新的Notice事实——见下面的详细说明。
  const ownAttachmentIds = payload.attachment_ids ?? [];
  const previousAttachmentIds = previousTurn?.attachmentIds ?? [];
  let uploadedAttachments: StoredAttachment[] = ownAttachmentIds.length
    ? await getAttachmentsForConversation(conversation.id, ownAttachmentIds)
    : [];
  // ⚠只留"真的提取到了内容"的那几份：模型没能从原文读出任何字段时，照样会返回
  // 一个所有字段都为空的对象、附件状态也照样是 EXTRACTED。只判对象存不存在的话，
  // 这种"读了等于没读"的情况会被当成读懂了，后面既跳过"请补充Notice信息"的分支、
  // 又拼不进任何背景，等于用户上传的文件对这次回答毫无影响——见 notice-extract.ts
  // 里 hasUsableNoticeFacts() 的事故记录。
  const usableFactsOf = (items: StoredAttachment[]) => items
    .map((item) => item.noticeFacts)
    .filter((facts): facts is NonNullable<typeof facts> => Boolean(facts) && hasUsableNoticeFacts(facts!));
  let extractedNoticeFacts = usableFactsOf(uploadedAttachments);

  // "这一轮上传了一份新Notice"要看的是**附件有没有变**，不是"有没有附件"——
  // 追问继承下来的老附件不能算新上传，否则每一轮都会被判成新话题，追问就断了。
  const hasNewNoticeUpload = extractedNoticeFacts.length > 0
    && uploadedAttachments.some((item) => !previousAttachmentIds.includes(item.id));

  /*
   * 额度闸门真正落下的地方。
   *
   * 2026-09-18 真实事故：用户剩最后 1 次额度，问完一题额度归零，紧接着在同一个
   * 对话里追问，被"本月额度已用完"拦住——可追问本来就有每对话 3 次免费额度。
   * 原来那道闸跑在读会话之前，**根本不知道这是追问**，于是免费额度永远用不上，
   * 人一旦归零就被冻在半句话上。
   *
   * 额度的单位是「话题」不是「请求」：用户为一个话题付一次费，追问是同一个话题的
   * 一部分。所以这道闸问的是"这是不是一个新话题"。判据全是纯函数，不调模型——
   * 这道闸的意义正是"别开始"，为了判断而先花一次调用就本末倒置了。
   */
  /*
   * ⚠️ 追问放行**必须同时受 IP 锁约束**（2026-09-18 二次加固）。
   *
   * 上一版这道放行只看"是不是追问"，不看 IP 计数——于是留下一个**烧钱的洞**：
   * 游客用掉 1 次试用、拿到一个 conversation_id 之后，脚本可以不断发"看起来像追问"
   * 的请求。每一条都会跑完整条检索+模型调用；最终判定是新话题的那些虽然会被结尾的
   * 复查换成 402，但**钱已经花掉了**。用户拿不到答案，我们照付 DeepSeek 的账单。
   *
   * 把 IP 锁加进来之后，这类请求的总量就被"每个 IP 每天 N 次"兜住了：
   * 放行的前提变成"这个出口今天还有预算"。
   *
   * 登录用户的 ipTrialUsed 恒为 0（identifyRequest 提前返回），这一条对他们永远成立，
   * 所以付费用户的免费追问不受任何影响。
   */
  const ipBudgetLeft = identity.ipTrialUsed < ANONYMOUS_IP_DAILY_LIMIT;
  const quotaBypass = identity.quota.remaining <= 0 && ipBudgetLeft && canBypassQuotaAsFollowUp({
    // 和计费判定用同一份可比对文本（上一问 + 上一个答案要点）。
    // 两处如果口径不同，会出现"闸门放行了、结尾复查又判成新话题"的来回打架。
    previousSelfContainedQuestion: previousTurn
      ? previousTurnComparableText({
        selfContainedQuestion: previousTurn.selfContainedQuestion,
        shortConclusion: previousTurn.shortConclusion,
        mandatoryFirstSentences: previousTurn.mandatoryFirstSentences,
        citedLaws: previousTurn.citedLaws,
      })
      : undefined,
    question,
    freeFollowUpsUsed: conversation.freeFollowUpsUsed,
    hasNewNoticeUpload,
    overlapRatio: questionOverlapRatio,
    hasReferringExpression,
  });
  if (identity.quota.remaining <= 0 && !quotaBypass) {
    try {
      await markQuestionAuditQuotaExhausted({ requestId: id, selfContainedQuestion: question });
    } catch (error) {
      console.error("[chat] failed to complete quota audit", error instanceof Error ? error.message : "unknown error");
    }
    return quotaExhaustedResponse(identity);
  }

  let effectiveQuestion = question;
  let topicRelation: TopicRelation | "FIRST" = "FIRST";
  let rewriteLog: ConversationTurn["rewriteLog"];
  let priorTurnContext: PriorTurnContext | undefined;
  let incomeTaxTime: IncomeTaxTimeResolution | undefined;

  async function completeAudit(
    responseToRecord: AnswerResponse,
    usedFollowUpCredit = false,
    deliveryStatus: "DELIVERED" | "BLOCKED_BY_QUOTA" = "DELIVERED",
  ) {
    try {
      await completeQuestionAudit({
        requestId: id,
        response: responseToRecord,
        selfContainedQuestion: effectiveQuestion,
        topicRelation,
        rewriteLog,
        incomeTaxTime,
        usedFollowUpCredit,
        deliveryStatus,
      });
    } catch (error) {
      console.error("[chat] failed to complete question audit", error instanceof Error ? error.message : "unknown error");
    }
  }

  if (hasNewNoticeUpload) {
    // 真实事故（2026-09-15）：用户连续上传了两份完全不相关的Notice（第一份民航
    // DGCA的、第二份是印度税局的GST登记真实性核查通知），但两次都问了类似的话
    // （"收到这个notice应该怎么办"），结果第二次的回答内容跟第一次几乎一样——
    // 根因是rewriteFollowUp完全不知道"这一轮用户上传了一份新Notice"这件事，
    // 它只看这一轮打的字和上一轮聊了什么，判断"收到这个notice应该怎么办"这种
    // 泛泛的话缺了上文背景没法单独理解，于是判成CONTINUATION，还把上一份Notice
    // 的背景事实（老的发出机关、老的法条引用）当成"必要背景"揉进了改写后的问题里，
    // 连带priorTurnContext也把上一份Notice的结论和引用当成"上文"喂给了模型——
    // 新上传的Notice事实虽然后面也会拼进去，但已经跟一堆不相关的旧背景混在一起，
    // 模型很容易就顺着旧背景继续答，跟新Notice的真实内容对不上。
    // 一份刚刚成功提取出事实的新Notice，是"这是新的一件事"最强、最确定的信号，
    // 比让模型去猜文字像不像上一轮的话可靠得多——所以这里直接跳过改写模型调用，
    // 强制当成NEW_TOPIC，不带上一轮的priorTurnContext，杜绝旧Notice的内容
    // 污染新Notice的回答。这个判断只在真的提取到了新事实时生效；附件上传了但
    // 没解析成功（下面的NEED_INFO分支）或者压根没上传附件，行为都不受影响。
    topicRelation = "NEW_TOPIC";
  } else if (previousTurn && !isExactRetryAfterIncompleteAnswer) {
    const rewritten = await rewriteFollowUp({
      question,
      previousSelfContainedQuestion: previousTurn.selfContainedQuestion,
      previousShortConclusion: previousTurn.shortConclusion,
      // 判"是不是追问"要比对上一个**答案**的要点，不只是上一个问题——
      // 用户顺着答案往下问，用的是答案里的词。见 previousTurnComparableText。
      previousMandatoryFirstSentences: previousTurn.mandatoryFirstSentences,
      previousCitedLaws: previousTurn.citedLaws,
    });
    effectiveQuestion = rewritten.selfContainedQuestion;
    topicRelation = rewritten.topicRelation;
    rewriteLog = rewritten.log;
    if (topicRelation === "CONTINUATION") {
      priorTurnContext = priorContextFrom(previousTurn);

      // 追问继承上一轮用过的Notice附件。真实事故（2026-09-15）：上传Notice问完
      // 第一个问题后再追问"这份notice里税局主要质疑什么"，系统回了"请上传完整
      // 清晰的Notice文件"——前端在回答成功后会清空附件列表，追问这一轮不再带
      // attachment_ids，服务端就认为"没有可用的Notice信息"，直接走了"请补充"分支。
      // Notice事实其实一直都在（存在附件库里、上一轮刚用过），缺的只是把它接续
      // 到下一轮。和 relatedCases 的继承逻辑同一个路子：话题延续就继承，
      // 换了新话题（NEW_TOPIC）不继承，避免把上一件事的Notice带到不相关的问题上。
      if (extractedNoticeFacts.length === 0 && previousAttachmentIds.length > 0) {
        uploadedAttachments = await getAttachmentsForConversation(conversation.id, previousAttachmentIds);
        extractedNoticeFacts = usableFactsOf(uploadedAttachments);
      }
    }
  }

  // 追问案例细节现查现答：只在"延续上一话题的追问"+"上一轮确实展示过案例"+
  // "这次问的像是模板外的具体细节"+"功能开着（配了token、没被env关掉）"全部成立时才尝试。
  // 命中了具体是哪个案例（pickCaseForFollowUp返回undefined就放弃——多个候选案例
  // 匹配不到就不猜）才会真的现查；现查本身失败（下载失败/模型调用失败）也不抛给用户，
  // 打日志后静默放弃，落回下面正常的知识库问答流程——这是补充能力，不能变成新的失败点。
  let caseDetailResponse: AnswerResponse | undefined;
  if (
    topicRelation === "CONTINUATION"
    && previousTurn
    && previousTurn.relatedCases.length > 0
    && detectCaseDetailFollowUp(question)
    && isCaseDetailLookupEnabled()
  ) {
    const targetCase = pickCaseForFollowUp(previousTurn.relatedCases, `${question} ${effectiveQuestion}`);
    if (targetCase) {
      try {
        caseDetailResponse = await buildCaseDetailResponse({
          requestId: id,
          conversationId: conversation.id,
          question,
          targetCase,
        });
      } catch (error) {
        console.error(
          `[chat] case detail live-lookup failed for request ${id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  let response: AnswerResponse;
  let usedFeaturedAnswer = false;

  if (caseDetailResponse) {
    response = caseDetailResponse;
  } else {
    const outOfScopeLabel = detectOutOfScope(effectiveQuestion);
    if (outOfScopeLabel) {
      const outOfScopeResponse = buildOutOfScopeResponse(id, conversation.id, outOfScopeLabel);
      await completeAudit(outOfScopeResponse);
      return jsonResponse(outOfScopeResponse);
    }

    // uploadedAttachments/extractedNoticeFacts 已经在函数最上面算好了
    // （挪上去是为了在决定要不要走"追问改写"之前就知道这一轮有没有新Notice事实）。
    const looksLikeNotice = /notice|通知书|税局|罚款|处罚|show\s*cause/i.test(effectiveQuestion);
    // 必须"确实传了文件、但一个事实都没提取出来"才走这条追问分支。
    //
    // 2026-09-17 验收测试暴露的真实事故：这里原本只判 `looksLikeNotice &&
    // extractedNoticeFacts.length === 0`，**没有要求用户真的上传过东西**。
    // 于是任何一句提到"税局/罚款/处罚/notice"的问题——那几乎是所有税务合规问题——
    // 都会被劫持到这套 Notice 追问模板上，拿到一模一样的三条追问
    // （发出机构 / 送达日期 / 完整Notice文件），检索一次都没跑。
    //
    // 100 题里 8 道栽在这上面，而且全是本来该直接作答的题：#40 发票核对清单
    // （"经常被税局质疑"）、#46 进项税抵扣（"税局发来 ASMT-10"）、#57 自愿补缴
    // （"罚款多少"）、#61 新旧法适用（"回复一份所得税 notice"）。
    // 更糟的是 #59：用户补全了全部信息，还是死循环反复索要 Notice 文件——
    // 因为它根本没传过文件，这个条件永远为真。
    //
    // 让用户"补充一份他从没上传过的文件"是一句自相矛盾的话。没传文件的问题
    // 应该走正常链路：模型自己判断事实够不够，不够时给出**针对这道题**的追问项。
    const uploadedButUnreadable = uploadedAttachments.length > 0 && extractedNoticeFacts.length === 0;
    if (looksLikeNotice && uploadedButUnreadable) {
      // 上传过文件但没能提取出事实，把具体原因告诉用户，而不是只给一句笼统的
      // "请补充"——用户会困惑"我明明上传了文件"。两种失败要分开说清楚：
      //   1. 格式不支持/解析失败：文件根本没读成文字；
      //   2. 文字读出来了、但一个字段都没提取到（图片太糊、版式特殊、不是Notice
      //      类文件都可能）——界面上这种会显示成"已识别"，用户更容易困惑，
      //      必须明确告诉他"读到文字了但没认出关键字段"。
      const failureNotes = uploadedAttachments.map((item) => {
        if (item.status !== "EXTRACTED") return `${item.fileName}：${item.errorMessage ?? "未能识别"}`;
        return `${item.fileName}：已读出文字，但没能识别出机关、编号、期限这些关键字段，`
          + `请在问题里直接补充，或换一份更清晰的文件重新上传。`;
      });
      const clarificationResponse: AnswerResponse = {
        request_id: id,
        conversation_id: conversation.id,
        answer_status: "NEED_INFORMATION",
        failure_code: "NEED_INFO",
        short_conclusion:
          "还需要确认Notice的基本信息，才能检索适用规则。补充前不会扣除提问次数。",
        key_figures: [],
        assumptions: [],
        action_steps: [],
        risks_and_exceptions: failureNotes,
        citations: [],
        // Notice 类按《AI检索与回答规范》§5.1 最多 3 组，不适用一般的 5 项上限。
        missing_information: [
          "发出机构、Notice编号或Form编号",
          "送达日期以及文件写明的回复期限",
          "完整清晰的Notice文件，尤其是指控事项和要求行动页",
        ].slice(0, MAX_NOTICE_CLARIFICATION_ITEMS),
        charge_eligible: false,
        policy_version: POLICY_VERSION,
      };
      await completeAudit(clarificationResponse);
      return jsonResponse(clarificationResponse);
    }

    // 提取到了Notice事实：拼进问题文本里，让检索和回答生成都能看到——
    // 和question-context.ts的buildFallbackQuestion同一个"背景事实拼进问题字符串"
    // 的做法，不用为此改legal-answer.ts的函数签名。拼接后的版本会继续往下走，
    // 也会被存进会话历史（下一轮追问"回复截止日是哪天"还能看到）。
    if (extractedNoticeFacts.length > 0) {
      effectiveQuestion = extractedNoticeFacts.reduce(
        (currentQuestion, facts) => appendNoticeContext(currentQuestion, facts),
        effectiveQuestion,
      );

      // 再判一次超范围：上面那道检查跑在拼接Notice事实之前，用户自己打的问题
      // （比如"收到这个notice应该怎么办"）本身往往看不出超范围信号，超范围的
      // 线索只会出现在Notice原文提取出的发出机关/指控里（真实事故：DGCA民航总局
      // 的Show Cause Notice，见上面OUT_OF_SCOPE_RULES里的详细记录）。
      // 拼接完成后立刻再查一遍，不然一份完全不该由本工具处理的Notice会被当成
      // 税务/公司类问题一路跑完整个知识库检索，生成一份文不对题但看起来完整、
      // 带引用的答案——比直接说"不在范围内"更容易误导人。
      const noticeOutOfScopeLabel = detectOutOfScope(effectiveQuestion);
      if (noticeOutOfScopeLabel) {
        const outOfScopeResponse = buildOutOfScopeResponse(id, conversation.id, noticeOutOfScopeLabel);
        await completeAudit(outOfScopeResponse);
        return jsonResponse(outOfScopeResponse);
      }
    }

    // 所得税的历史规则不能默认按今天处理。具体交易日期优先，FY / AY 次之；
    // 都没有时先追问，不让 1961 法与 2025 法的分界被当前日期悄悄覆盖。
    const isIncomeTaxQuestion = detectQuestionCategories(question).includes("income_tax")
      || detectQuestionCategories(effectiveQuestion).includes("income_tax");
    // 案例检索的“2026年以前”是在筛裁判日期，不是在说交易发生在哪个 FY。
    // 仅对这个窄场景跳过所得税年度追问，其他所得税结论仍必须先确定适用期间。
    const hasCaseDateCutoff = hasHistoricalCaseCutoff(question)
      || hasHistoricalCaseCutoff(effectiveQuestion);
    // 先看用户本轮实际提交的完整事实，再看多轮改写结果。专用追问补的日期在原文里，
    // 不能因为改写模型省略了日期而再次弹出同一张补充卡。
    incomeTaxTime = isIncomeTaxQuestion && !hasCaseDateCutoff
      ? (resolveIncomeTaxTime(question).targetDate
        ? resolveIncomeTaxTime(question)
        : resolveIncomeTaxTime(effectiveQuestion))
      : undefined;
    if (isIncomeTaxQuestion && !hasCaseDateCutoff && !incomeTaxTime?.targetDate) {
      const clarificationResponse: AnswerResponse = {
        request_id: id,
        conversation_id: conversation.id,
        answer_status: "NEED_INFORMATION",
        failure_code: "NEED_INFO",
        short_conclusion: "本题涉及所得税，需先确定适用期间，才能判断应适用哪一版本的法律。补充前不会扣除提问次数。",
        key_figures: [],
        assumptions: [],
        action_steps: [],
        risks_and_exceptions: [],
        citations: [],
        missing_information: [
          "具体交易、付款或收入发生日期（例如 2024-03-15）",
          "或适用的财年 / 评估年度（例如 FY21-22、FY 2024-25、AY 2024-25）",
        ],
        clarification_kind: "INCOME_TAX_TIME",
        charge_eligible: false,
        policy_version: POLICY_VERSION,
      };
      // 这张卡片也是用户已经看到的会话内容，必须持久化；否则侧栏会有记录，
      // 打开时服务端却没有任何轮次，主区看起来像「新建对话」。它不带法律结论，
      // 不会污染后续事实判断或消耗追问额度。
      if (!previousTurn) clarificationResponse.conversation_title = truncateTitle(question);
      await appendTurn(conversation.id, {
        requestId: clarificationResponse.request_id,
        rawQuestion: displayQuestion,
        selfContainedQuestion: effectiveQuestion,
        shortConclusion: clarificationResponse.short_conclusion,
        mandatoryFirstSentences: [],
        citedLaws: [],
        relatedCases: [],
        attachmentIds: uploadedAttachments.map((item) => item.id),
        answerStatus: clarificationResponse.answer_status,
        chargeEligible: false,
        topicRelation,
        usedFollowUpCredit: false,
        rewriteLog,
        answer: trimAnswerForStorage(clarificationResponse),
      }, clarificationResponse.conversation_title);
      await completeAudit(clarificationResponse);
      return jsonResponse(clarificationResponse);
    }
    const targetDate = incomeTaxTime?.targetDate ?? payload.target_date;

    const publishedChunks = await getPublishedKnowledgeChunks();
    if (publishedChunks.length === 0) {
      const unavailableResponse: AnswerResponse = {
        request_id: id,
        conversation_id: conversation.id,
        answer_status: "UNABLE_TO_CONFIRM",
        failure_code: "INSUFFICIENT_EVIDENCE",
        short_conclusion:
          "当前开发环境尚未导入已审核知识库，因此不会用模型记忆生成印度法律结论。本次不扣次数。",
        key_figures: [],
        assumptions: [],
        action_steps: [
          {
            kind: "PRACTICAL",
            text: "请由管理员上传符合《知识库数据规范 V1.4》的TXT资料并完成发布审核。",
            citation_refs: [],
            unverified_claims: [],
          },
        ],
        risks_and_exceptions: [],
        citations: [],
        missing_information: [],
        charge_eligible: false,
        policy_version: POLICY_VERSION,
      };
      await completeAudit(unavailableResponse);
      return jsonResponse(unavailableResponse);
    }

    const knowledgeVersion = featuredKnowledgeVersion(publishedChunks.map((chunk) => chunk.documentId));
    // 标准答案只服务首页那五道“逐字相同”的首问。附件、适用日期、辖区、会话上文
    // 都可能改变结论，任何一个存在时均回到正常的 RAG 链路，绝不借缓存跳过事实判断。
    const canUseFeaturedAnswer = !previousTurn
      && uploadedAttachments.length === 0
      && !payload.target_date
      && !payload.jurisdiction
      && question === effectiveQuestion;
    const featuredAnswer = canUseFeaturedAnswer
      ? await findFeaturedAnswer(question, knowledgeVersion)
      : undefined;
    if (featuredAnswer) {
      // 标准答案由管理员维护；命中后原样返回，不能再混入实时检索结果。
      response = { request_id: id, conversation_id: conversation.id, ...featuredAnswer };
      usedFeaturedAnswer = true;
    } else if (!isDeepSeekConfigured()) {
      const unavailableResponse: AnswerResponse = {
        request_id: id,
        conversation_id: conversation.id,
        answer_status: "UNABLE_TO_CONFIRM",
        failure_code: "SYSTEM_ERROR",
        short_conclusion: "已找到发布资料，但问答模型尚未连接。请管理员检查本地DeepSeek配置。",
        key_figures: [],
        assumptions: [],
        action_steps: [],
        risks_and_exceptions: [],
        citations: [],
        missing_information: [],
        charge_eligible: false,
        policy_version: POLICY_VERSION,
      };
      await completeAudit(unavailableResponse);
      return jsonResponse(unavailableResponse);
    } else {
      // 同一问题在不同适用日期、不同辖区、不同上文背景下答案不同，缓存键必须包含这几项。
    // 追问的contextKey实际上把改写后的问题和上一轮上下文都拧在一起了，
    // 不同对话几乎不可能撞到同一个key，首问（无上文）不受影响、行为和之前完全一致。
    const contextKey = priorTurnContext ? JSON.stringify(priorTurnContext) : "";
    // ⚠附件ID必须进缓存键。answerCache 是**进程级**的（模块里的一个Map），
    // 不按会话隔离——只要键一样，不同会话、不同窗口、甚至不同用户都会拿到
    // 同一份缓存answer（10分钟内）。真实事故（2026-09-15）：用户在全新窗口里
    // 传了一份完全不同的Notice、打了一句几乎一样的问题，拿到的却是十分钟前
    // 另一份Notice的答案——因为那次Notice事实没提取出内容，effectiveQuestion
    // 退化成了用户打的那句话本身，和上一次的键完全相同，直接命中缓存。
    // 光靠 effectiveQuestion 里"顺便"包含了Notice事实来区分是不够的：事实为空、
    // 或者两份文件恰好提取出相同字段时，键就会撞车。把附件ID显式放进键里，
    // 不同的文件在任何情况下都不可能共用一条缓存。
    const attachmentKey = uploadedAttachments.map((item) => item.id).sort().join(",");
    // 缓存是进程全局的。即便法律问题文字相同，也不能在用户之间复用回答；用户的
    // 企业档案、附件和追问语境都可能让相同问题对应不同结论。游客也按请求隔离。
    const cacheScope = identity.user?.id ?? id;
    const cacheKey = [
      cacheScope,
      effectiveQuestion.toLowerCase(),
      targetDate ?? "",
      payload.jurisdiction ?? "",
      knowledgeVersion,
      contextKey,
      attachmentKey,
    ].join("::");

    // 诊断日志：答非所问时，第一件要排除的事就是"这次压根没重新生成、直接命中了
    // 缓存"。只打命中与否、话题关系、以及Notice提取到了**哪几个字段名**——
    // 不打字段内容，更不打文件原文（产品规则表要求用户上传文件不进普通日志）。
    // 字段名本身很关键：allegations（指控/要求事项）是唯一能说明"这份Notice
    // 到底是关于什么"的字段，它空不空，界面上的预览是看不出来的。
    const cached = answerCache.get(cacheKey);
    if (isAnswerTraceEnabled()) {
      const factFields = extractedNoticeFacts.flatMap((facts) =>
        Object.entries(facts)
          .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
          .map(([key]) => key));
      console.info(
        `[trace ${id}] cache=${cached && cached.expiresAt > Date.now() ? "HIT" : "MISS"}`
        + ` topic=${topicRelation} attachments=${uploadedAttachments.length}`
        + ` attachmentSource=${ownAttachmentIds.length ? "own" : uploadedAttachments.length ? "inherited" : "none"}`
        + ` noticeFactFields=${JSON.stringify(factFields)}`,
      );
    }
    if (cached && cached.expiresAt > Date.now()) {
      response = { request_id: id, conversation_id: conversation.id, ...cached.answer };
    } else {
      try {
        const generated = await answerFromPublishedKnowledge({
          requestId: id,
          conversationId: conversation.id,
          question: effectiveQuestion,
          publishedChunks,
          targetDate,
          jurisdiction: payload.jurisdiction,
          priorTurnContext,
          /*
           * 这段对话已经画过哪几条争议流程图。
           *
           * 扫**全部历史轮次**，不是只看上一轮：只看上一轮会出现
           * "第 2 轮略过 → 第 3 轮以为没画过 → 又画一遍"的跳变。
           *
           * 从存下来的完整 `answer` 里读，不新增存储字段——
           * `answer` 从 2026-09-17 起整份持久化，`dispute_track` 是它的一个字段。
           * 老数据里没有这个字段时是空集，行为退回"每轮都画"，和改动前一致。
           */
          shownDisputeTrackIds: conversation.turns
            .map((turn) => (turn.answer?.dispute_track as { id?: string } | undefined)?.id)
            .filter((id): id is string => Boolean(id)),
          // 原文节选也要送进去：只拼七个字段的话，"这份文件里税局质疑什么"这类
          // 问题模型根本无从答起，只能写通用流程——见 notice-extract.ts 里
          // subjectMatter 字段的事故记录。
          noticeExcerpts: uploadedAttachments
            .map((item) => item.extractedText)
            .filter((text): text is string => Boolean(text?.trim()))
            .map(buildNoticeExcerpt),
        });
        // 通用缓存只保存已经形成正常结论的答案。`SUFFICIENT` 同时包含
        // FULL（依据充分）和 PARTIAL（部分覆盖）——两者都是已交付的可复用答案。
        // 证据不足、需要补充信息或系统降级才不进缓存；缓存它们会让用户原样重试时
        // 反复拿到第一次的拒答。
        // 首页人工审核的五道标准题是另一条独立缓存链路，不受这里影响。
        if (generated.answer_status === "SUFFICIENT") {
          const { request_id: _requestId, conversation_id: _conversationId, ...cacheableAnswer } = generated;
          void _requestId;
          void _conversationId;
          answerCache.set(cacheKey, {
            expiresAt: Date.now() + 10 * 60 * 1_000,
            answer: cacheableAnswer,
          });
        }
        response = generated;
      } catch (error) {
        // 这里之前完全没打日志——出了SYSTEM_ERROR用户端只看到一句"暂时无法确认"，
        // 服务端却什么线索都留不下，事后没法诊断。哪怕暂时定位不到根因，先把异常记下来。
        console.error(
          `[chat] answerFromPublishedKnowledge threw for request ${id}:`,
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        const unavailableResponse: AnswerResponse = {
          request_id: id,
          conversation_id: conversation.id,
          answer_status: "UNABLE_TO_CONFIRM",
          failure_code: "SYSTEM_ERROR",
          short_conclusion: "检索或回答服务暂时未完成，本次不扣次数。请稍后重试。",
          key_figures: [],
          assumptions: [],
          action_steps: [],
          risks_and_exceptions: [],
          citations: [],
          missing_information: [],
          charge_eligible: false,
          policy_version: POLICY_VERSION,
        };
        await completeAudit(unavailableResponse);
        return jsonResponse(unavailableResponse);
      }
    }
    }
  }

  /*
   * 回复截止日提示行（2026-10-13 加）：这轮附件里有"写明了具体日期的回复截止日"
   * 时，单独下发给展示层——渲染成红色提示行 + 点击预填合规提醒。
   *
   * 只在能归一化成 YYYY-MM-DD 时下发（normalizeReplyDeadline 解析不了的相对期限
   * 直接跳过）；多个附件都有截止日时取第一个能解析的。日期本身经过
   * verifyDigitsAgainstSource 的数字核验（见 notice-extract.ts），但 OCR 认错数字
   * 挡不住，所以 text 原文写法一起带上，让用户能对回原文核对。
   * 注意：**只下发，不建提醒**——创建必须经用户在提醒页确认（产品规则表硬约束）。
   */
  let parsedDeadline: { authority?: string; text: string; date: string } | undefined;
  for (const facts of extractedNoticeFacts) {
    if (!facts.replyDeadline) continue;
    const date = normalizeReplyDeadline(facts.replyDeadline);
    if (date) {
      parsedDeadline = { authority: facts.authority, text: facts.replyDeadline, date };
      break;
    }
  }
  if (parsedDeadline) {
    response.reply_deadline = {
      date: parsedDeadline.date,
      text: parsedDeadline.text,
      authority: parsedDeadline.authority,
    };
  }

  // 追问免费额度覆盖：只在"延续上一问题"且原本会被扣费时生效，新话题/首问不受影响。
  const charging = applyFollowUpCharging({
    topicRelation,
    originalChargeEligible: response.charge_eligible,
    freeFollowUpsUsed: conversation.freeFollowUpsUsed,
  });
  response.charge_eligible = charging.chargeEligible;
  if (charging.note) {
    response.risks_and_exceptions = [...response.risks_and_exceptions, charging.note];
  }

  // 这一轮展示过的案例，供下一轮追问细节时定位docid用：这一轮真查到了新的
  // related_cases 就用新的；没查到（包括这一轮走的是案例细节现查现答分支，
  // 它本身不产出 related_cases）但话题没换，就继承上一轮展示过的案例——
  // 否则追问完案例细节A之后再追问一句"那金额呢"，第二次追问就找不到案例了。
  // 换了新话题（NEW_TOPIC）不继承，避免把早就聊完的案例错认成这次在问的。
  const relatedCasesForTurn: StoredRelatedCaseRef[] = response.related_cases?.length
    ? response.related_cases.map((item) => ({ docid: item.docid, caseName: item.caseName, officialUrl: item.official_url }))
    : topicRelation !== "NEW_TOPIC"
      ? (previousTurn?.relatedCases ?? [])
      : [];

  /*
   * 对话标题：只在这个对话的第一轮生成，之后再怎么追问都不重新生成。
   *
   * 必须在写入会话**之前**生成：此前放在 appendTurn 之后，前端虽能拿到标题，
   * 服务器存储的 title 却一直是空，跨设备打开时只能退回原问题截断。
   */
  if (!previousTurn) {
    response.conversation_title = await buildConversationTitle(question).catch(() => undefined);
  }

  // 记入会话历史，供下一轮追问改写和携带上下文用。其他提前返回的分支（范围外、
  // 缺Notice附件、知识库为空、模型未配置、异常兜底）不是真实案情讨论，不写入。
  // 所得税适用期间的专用追问是例外：它是本次对话的必要可见步骤，已在上面写入。
  await appendTurn(conversation.id, {
    requestId: response.request_id,
    rawQuestion: displayQuestion,
    selfContainedQuestion: effectiveQuestion,
    shortConclusion: response.short_conclusion,
    mandatoryFirstSentences: extractMandatoryFirstSentences(response.action_steps),
    citedLaws: extractCitedLaws(response.citations),
    relatedCases: relatedCasesForTurn,
    // 这一轮实际用到的附件（新上传的，或话题延续时继承下来的），供下一轮追问继续继承。
    attachmentIds: uploadedAttachments.map((item) => item.id),
    answerStatus: response.answer_status,
    chargeEligible: response.charge_eligible,
    topicRelation,
    usedFollowUpCredit: charging.usedFreeCredit,
    rewriteLog,
    // 完整回答也存一份，供「最近对话」点进去时原样重现回答卡片。
    // 超大回答会被裁掉证据原文（见 trimAnswerForStorage），不会撑爆存储文件。
    answer: trimAnswerForStorage(response),
  }, response.conversation_title);

  /*
   * 扣额度。**只在这一轮确实要扣费时才扣**——
   * 追问免费额度覆盖过的、拒答不扣次的、范围外的，`charge_eligible` 都是 false，
   * 额度系统完全不介入，既有的扣费规则是唯一的判断依据。
   *
   * 扣减失败（并发下刚好被别的请求用掉最后一次）不回收这次回答——
   * 用户已经拿到答案了，为了一次额度把答案撤回是本末倒置；下一次提问自然会被拦住。
   */
  /*
   * 前面按"看起来是追问"放行的请求，最后如果判定要扣费，说明确定性判据猜错了
   * （模型认定这是新话题）。这时候已经白花了一次检索和模型调用，但**付费墙不能破**——
   * 把答案换成额度耗尽提示。前置判据已经把这种情况压得很少了。
   */
  if (quotaBypass && response.charge_eligible) {
    await completeAudit(response, charging.usedFreeCredit, "BLOCKED_BY_QUOTA");
    return quotaExhaustedResponse(identity);
  }

  const extraHeaders: Record<string, string> = {};
  if (usedFeaturedAnswer) extraHeaders["X-Answer-Cache"] = "FEATURED";
  if (response.charge_eligible) {
    if (identity.user) {
      const updated = await consumeQuota(identity.user.id, currentYearMonth(), identity.quota.limit);
      if (updated) response.quota = quotaViewOf(updated);
    } else {
      const used = identity.anonymousUsed + 1;
      extraHeaders["Set-Cookie"] = trialCookie(used);
      /*
       * 两把锁都要记（2026-09-18 修的 P0 漏洞）：
       * Cookie 那把客户端说了算、随时能清；**IP 这把记在服务端**，
       * 不带 Cookie 的脚本躲不开它。只记 Cookie 就是修复前那个能被刷穿的状态。
       *
       * 写失败不回收这次回答——和 consumeQuota 同一条口径：
       * 用户已经拿到答案了，为了一次计数把答案撤回本末倒置。
       */
      let ipUsed = identity.ipTrialUsed;
      if (identity.clientIp) {
        ipUsed = await recordIpTrial(identity.clientIp).catch(() => identity.ipTrialUsed + 1);
      }
      response.quota = anonymousQuotaView(used, ipUsed);
    }
  } else {
    // 没扣费也要把当前额度带给前端，省得界面显示的数字和实际对不上。
    response.quota = identity.quota;
  }

  await completeAudit(response, charging.usedFreeCredit);

  return jsonResponse(response, extraHeaders);
}

/*
 * 顶层兜底（2026-10-15 DeepSeek 全面故障补）：此前 POST 内部没有 try/catch，
 * 模型服务超时/宕机时异常直接冒给框架，用户看到的是框架默认 500 对应的
 * 笼统「请求未完成，请稍后再试」——分不清是我们坏了还是上游坏了。
 * 这里统一接住，明确告知是 AI 模型服务侧的问题、本次不会扣次数。
 * 注意：走到异常说明扣费逻辑还没执行，额度确实没动，这么说没有歧义。
 */
export async function POST(request: Request) {
  const retryKey = clientRequestIdOf(request);
  const active = retryKey ? inFlightChatRequests.get(retryKey) : undefined;
  if (active) return (await active).clone();

  const pipeline = (async () => {
    try {
      return await handleChatPost(request);
    } catch (error) {
      console.error("[chat] answer pipeline crashed", error instanceof Error ? `${error.name}: ${error.message}` : error);
      return NextResponse.json(
        {
          error: "ANSWER_FAILED",
          message: "AI 模型服务暂时不可用（上游服务故障），请几分钟后重试。本次未扣除任何次数。",
        },
        { status: 503 },
      );
    }
  })();

  if (retryKey) {
    inFlightChatRequests.set(retryKey, pipeline);
    void pipeline.finally(() => {
      if (inFlightChatRequests.get(retryKey) === pipeline) inFlightChatRequests.delete(retryKey);
    });
  }

  // Response body 只能读取一次；每个原始请求/自动重连拿自己的 clone，互不影响。
  return (await pipeline).clone();
}
