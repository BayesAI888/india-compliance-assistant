/**
 * 多轮对话的服务器端会话存储。
 *
 * 和 knowledge-store.ts 同构：单机 JSON 文件 + 串行写入队列防并发写坏文件，
 * 贴合腾讯云 Lighthouse 单机、无数据库依赖的部署现状。
 *
 * 原本只存"链式压缩"追问需要的最小字段、不存完整答案，理由是存储会涨得很快、
 * 而且完整答案对下一轮追问没有用。**2026-09-17 改了**：产品要求点进「最近对话」
 * 能看到原样的完整回答，所以现在多存一份 `turn.answer`。存储增长这个顾虑仍然成立，
 * 用三道边界兜着——每会话最多20轮、超30天整个清掉、单轮回答超过
 * MAX_STORED_ANSWER_CHARS 时裁掉证据原文。**用户量上来之后这块必须迁到真正的数据库。**
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnswerResponse } from "../contracts";

export type TopicRelation = "FIRST" | "CONTINUATION" | "NEW_TOPIC";

/**
 * 上一轮展示过的案例的最小引用——只存追问链路认得出案例、找得到docid需要的字段，
 * 不存完整的九字段内容（那些字段的正文没有存在会话历史里的必要，追问细节现查现答时
 * 会重新现查判决书原文，不依赖这里存的内容）。
 */
export interface StoredRelatedCaseRef {
  docid: string;
  caseName: string;
  officialUrl: string;
}

export interface RewriteLog {
  /** 喂给改写模型的追问原文。 */
  input: string;
  /** 改写结果（正常改写的自包含问题，或兜底拼接结果）。 */
  output: string;
  /** true表示模型改写不可用（为空/照抄上一问/调用失败），退回了确定性拼接兜底。 */
  usedFallback: boolean;
  durationMs: number;
}

export interface ConversationTurn {
  turnId: string;
  /**
   * 这次回答对外返回的 request_id。
   *
   * 反馈、运营排障都必须通过这个服务端生成的标识回查原回答，不能接受客户端自报
   * 的 user_id、扣次状态或流水号。老数据没有该字段，读出来仍保持兼容，但不能参与
   * 自动补回。
   */
  requestId?: string;
  askedAt: string;
  /** 用户在这一轮实际打的字。 */
  rawQuestion: string;
  /** 送进检索和回答生成的问题——首问等于rawQuestion，追问是改写后的自包含问题。 */
  selfContainedQuestion: string;
  shortConclusion: string;
  /** 上一轮「法规要求」各条的首句，供追问时用作"已经讲过什么"的轻量上下文。 */
  mandatoryFirstSentences: string[];
  /** 上一轮引用到的法律与条号，例如"Companies Act, 2013 Section 62"。 */
  citedLaws: string[];
  /**
   * 这一轮展示过的案例（来自 related_cases，或者继承自上一轮——话题延续但这一轮
   * 没有新触发判例检索时，追问细节仍然要能定位到更早展示过的那个案例）。
   * 话题切换（NEW_TOPIC）时不继承，见 route.ts 里写入这个字段的地方。
   */
  relatedCases: StoredRelatedCaseRef[];
  /**
   * 这一轮实际使用的Notice附件ID（这一轮新上传的，或者话题延续时继承自上一轮的）。
   *
   * 真实事故（2026-09-15）：上传Notice问完第一个问题后，再追问"这份notice里税局
   * 主要质疑什么"，系统回了"请上传完整清晰的Notice文件"——因为前端在回答成功后
   * 会清空附件列表，追问那一轮不再带 attachment_ids，服务端就认为"没有可用的
   * Notice信息"。Notice事实其实一直都在（存在附件库里，上一轮也用过），只是没人
   * 把它接续到下一轮。存这个字段就是为了让追问能继承上一轮用过的附件——
   * 和上面 relatedCases 的继承逻辑同一个路子。
   * 老数据里没有这个字段，读的时候一律按空数组兜底。
   */
  attachmentIds: string[];
  answerStatus: AnswerResponse["answer_status"];
  /** 覆盖免费追问额度之后的最终扣费结果。 */
  chargeEligible: boolean;
  topicRelation: TopicRelation;
  /** 这一轮是否消耗了一次免费追问额度。 */
  usedFollowUpCredit: boolean;
  rewriteLog?: RewriteLog;
  /**
   * 这一轮的完整回答（2026-09-17加），供「最近对话」点进去时原样重现回答卡片。
   *
   * 在这之前只存了 shortConclusion，点进历史对话只能看到一句话结论；用户要求
   * 看到完整回答，所以这里把整个 AnswerResponse 存下来。
   *
   * 体积要留心：一条回答里最大的是证据原文（每条上限1200字符、可能十几二十条），
   * 单轮可能到几十KB。有两道现成的边界兜着——每个会话最多留20轮
   * （MAX_TURNS_PER_CONVERSATION）、超过30天的会话整个清掉
   * （MAX_CONVERSATION_AGE_DAYS）；再加上 trimAnswerForStorage() 的体积上限，
   * 单轮超标时丢掉证据原文只留定位信息。当前是文件存储、单机单文件，
   * **用户量上来之后这块必须迁到真正的数据库**，这条限制在README里也写了。
   *
   * 老数据里没有这个字段，读的时候按 undefined 处理——前端拿不到完整回答时
   * 退回只显示问题和结论，不报错。
   */
  answer?: AnswerResponse;
}

export interface StoredConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 这个对话属于哪个账号。游客的对话没有这个字段。
   *
   * 2026-09-18 加：在这之前「最近对话」列表**只存在浏览器的 localStorage 里**，
   * 换个浏览器、换台设备、清一次缓存，列表就空了——服务端的对话内容一直都在，
   * 只是再也对不上 ID。用户实测撞上了这件事：同一个账号换浏览器登录，历史全没了。
   *
   * 记上归属之后，列表就能跟着账号走，而不是跟着浏览器走。
   * 顺带解决一个安全问题：`GET /api/chat?conversation_id=` 原来**完全不校验身份**，
   * 谁拿到 ID 谁就能读。有了归属，别人的对话就读不到了（见 canReadConversation）。
   */
  userId?: string;
  /** 20字以内的话题概括，首问时由 conversation-title.ts 生成。列表上显示这个。 */
  title?: string;
  /** 本对话已经用掉的免费追问次数，上限见 lib/server/followup-charging.ts。 */
  freeFollowUpsUsed: number;
  turns: ConversationTurn[];
}

/**
 * 这个请求能不能读这个对话。
 *
 * 规则刻意简单，因为它管的是"别人的资料能不能被看到"：
 * - 对话**有主**：只有本人能读。别人（包括游客）一律拒绝。
 * - 对话**无主**（历史游客数据）：一律拒绝。游客不再有服务端历史记录，避免
 *   把 URL 里的 ID 当作访问敏感问答内容的凭证。
 *
 * 纯函数，导出供单测——这种"谁能看谁的东西"的判断，必须有测试钉住。
 */
export function canReadConversation(
  conversation: Pick<StoredConversation, "userId">,
  requesterUserId: string | undefined,
): boolean {
  return Boolean(requesterUserId && conversation.userId === requesterUserId);
}

interface ConversationStoreFile {
  schemaVersion: "1.0";
  conversations: StoredConversation[];
}

/** 每个会话只保留最近这么多轮——链式改写只依赖上一轮，更早的历史留着也用不上。 */
export const MAX_TURNS_PER_CONVERSATION = 20;
/** 超过这么多天没有新提问的会话，下次写入时顺带清掉。产品定位是无人值守SaaS，
 *  不能像AstrBot那样指望管理员手动清（调研见README「多轮对话」节）。 */
export const MAX_CONVERSATION_AGE_DAYS = 30;

const dataDirectory = process.env.LOCAL_CONVERSATION_DIR?.trim()
  || process.env.LOCAL_KNOWLEDGE_DIR?.trim()
  || path.join(process.cwd(), ".local-data");
const storePath = path.join(dataDirectory, "conversation-store.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

function emptyStore(): ConversationStoreFile {
  return { schemaVersion: "1.0", conversations: [] };
}

async function readFileStore(): Promise<ConversationStoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as ConversationStoreFile;
    return Array.isArray(parsed.conversations) ? parsed : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

async function writeFileStore(store: ConversationStoreFile) {
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

/**
 * 存进会话历史的单轮回答体积上限（字符数）。超过就丢掉证据原文只留定位信息——
 * 点回历史对话时仍然看得到结论、步骤、引用了哪几条法条和官方链接，
 * 只是展不开原文；想看原文在这条对话里重新问一次即可。
 *
 * 为什么要有这个上限：证据原文每条上限1200字符，多法律层的问题可能带二十多条，
 * 再加上判例综述，单轮能到几十KB。20轮就是几百KB，而所有会话存在同一个JSON文件里。
 * 宁可在极端情况下少存一点，也不能让存储文件被少数几个超大回答撑爆。
 */
export const MAX_STORED_ANSWER_CHARS = 120_000;

/** 单条证据原文在落盘时的截断长度。超标时先截它，而不是整条丢掉。 */
const STORED_SNIPPET_CHARS = 400;

/**
 * 纯函数：把回答裁到可以安全落盘的大小。没超标就原样返回（同一个引用，不复制）。
 *
 * **2026-09-17 改过一次**：上限原来是 24000 字符，而且超标时的处理是
 * "先丢掉全部证据原文，还超标就把判例综述和相关判例整个丢掉"。
 * 用户实测发现点进历史对话时**判例部分没有了**——正是这条规则干的。
 *
 * 现在的原则倒过来：**宁可把长文本截短，也不要整块丢掉**。
 * 用户要的是"存全文"，一个少了判例区块的回答不算全文；而截短的段落至少
 * 还看得出讲的是什么、还能顺着链接看原文。顺序是：
 *   1. 没超标 → 原样存（绝大多数回答都走这里，上限提高到12万字符之后更是如此）
 *   2. 超标 → 证据原文各自截到400字，条号/法律名/官方链接全部保留
 *   3. 还超标 → 判例综述里的长文本截短，**但结构和条目一条不少**
 *   4. 仍然超标（几乎不可能）→ 才丢掉证据原文，但判例区块始终保留
 */
export function trimAnswerForStorage(answer: AnswerResponse): AnswerResponse {
  if (JSON.stringify(answer).length <= MAX_STORED_ANSWER_CHARS) return answer;

  const clamp = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);

  // ① 证据原文截短（不是丢掉）。
  let trimmed: AnswerResponse = {
    ...answer,
    citations: answer.citations.map((citation) => (citation.snippet
      ? { ...citation, snippet: clamp(citation.snippet, STORED_SNIPPET_CHARS) }
      : citation)),
  };
  if (JSON.stringify(trimmed).length <= MAX_STORED_ANSWER_CHARS) return trimmed;

  // ② 判例综述里的长文本截短，条目数量不变——用户要看的是"有哪些风险主题"，
  //    把整块丢掉等于回答缺了一部分，截短只是每条少几句话。
  if (trimmed.case_digest) {
    trimmed = {
      ...trimmed,
      case_digest: {
        ...trimmed.case_digest,
        clusters: trimmed.case_digest.clusters.map((cluster) => ({
          ...cluster,
          challenge: clamp(cluster.challenge, 300),
          takeaway: cluster.takeaway ? clamp(cluster.takeaway, 300) : undefined,
          evidence: cluster.evidence.map((item) => ({ ...item, text: clamp(item.text, 300) })),
        })),
      },
    };
  }
  if (JSON.stringify(trimmed).length <= MAX_STORED_ANSWER_CHARS) return trimmed;

  // ③ 最后手段：丢掉证据原文（条号和链接仍在）。**判例区块不动**。
  return {
    ...trimmed,
    citations: trimmed.citations.map((citation) => {
      const withoutSnippet = { ...citation };
      delete withoutSnippet.snippet;
      return withoutSnippet;
    }),
  };
}

/** 纯函数，独立于文件IO，方便单测：把超过保留期的会话过滤掉。 */
export function pruneExpiredConversations(
  conversations: StoredConversation[],
  now: Date = new Date(),
  maxAgeDays: number = MAX_CONVERSATION_AGE_DAYS,
): StoredConversation[] {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  return conversations.filter((conversation) => new Date(conversation.updatedAt).getTime() >= cutoff);
}

export async function getConversation(id: string): Promise<StoredConversation | null> {
  const store = await readFileStore();
  return store.conversations.find((conversation) => conversation.id === id) ?? null;
}

/**
 * 只在回答属于当前登录账号时返回。反馈接口用它把 request_id 重新绑定到服务端
 * 会话记录，避免客户端伪造用户、扣次状态或额度流水。
 */
export async function findAnswerRequestForUser(userId: string, requestId: string): Promise<{
  conversation: StoredConversation;
  turn: ConversationTurn;
} | null> {
  if (!userId || !requestId) return null;
  const store = await readFileStore();
  for (const conversation of store.conversations) {
    if (conversation.userId !== userId) continue;
    const turn = conversation.turns.find((item) => item.requestId === requestId);
    if (turn) return { conversation, turn };
  }
  return null;
}

/**
 * 客户端能不能自己定 conversation_id？**只有长得像我们自己生成的那种才认。**
 *
 * 背景（2026-09-18）：前端改成了"发请求之前就先生成 conversation_id"，
 * 这样手机上切到别的 App、页面被系统回收时，前端**早就把这个 id 写进「最近对话」了**，
 * 回来还能点进去把答案取出来。在这之前 id 只在响应里回传，
 * 响应一丢，那次问答就成了孤儿：**次数扣了、答案存在服务器上，用户永远找不到**。
 *
 * 客户端自定 id 仍须校验形状：读取时会校验登录账号归属，但低熵的任意字符串
 * 容易碰撞，也不能成为会话标识。
 *
 * 所以只接受 `conv_<UUID v4>` 这一种形状——它和服务端自己生成的格式完全一致，
 * 熵足够大，猜不出来。不合格的一律当没传，照旧由服务端生成。
 */
const CONVERSATION_ID_PATTERN =
  /^conv_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidConversationId(id: string): boolean {
  return CONVERSATION_ID_PATTERN.test(id.trim());
}

export async function createConversation(id?: string, userId?: string): Promise<StoredConversation> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    store.conversations = pruneExpiredConversations(store.conversations);
    const now = new Date().toISOString();
    const conversation: StoredConversation = {
      // 客户端传来的 id 已经过 isValidConversationId 校验（见 getOrCreateConversation）。
      id: id ?? `conv_${randomUUID()}`,
      ...(userId ? { userId } : {}),
      createdAt: now,
      updatedAt: now,
      freeFollowUpsUsed: 0,
      turns: [],
    };
    store.conversations.push(conversation);
    await writeFileStore(store);
    return conversation;
  });
}

/**
 * 只允许账号本人复用自己的对话。ID 不属于当前账号时返回 null，调用方统一回 404，
 * 避免把 ID 当作跨账号访问凭证。
 */
export async function getOrCreateConversation(
  id?: string,
  userId?: string,
): Promise<StoredConversation | null> {
  const trimmed = id?.trim();
  if (trimmed) {
    const existing = await getConversation(trimmed);
    if (existing) return canReadConversation(existing, userId) ? existing : null;
    // 没找到但格式合法：这是前端**在发请求之前**生成的新对话 id，按它建。
    // 格式不合法就当没传——绝不能拿用户给的任意字符串当对话标识，理由见
    // isValidConversationId 的注释。
    if (isValidConversationId(trimmed)) return createConversation(trimmed, userId);
  }
  return createConversation(undefined, userId);
}

export function getLastTurn(conversation: StoredConversation): ConversationTurn | undefined {
  return conversation.turns[conversation.turns.length - 1];
}

export async function appendTurn(
  conversationId: string,
  turn: Omit<ConversationTurn, "turnId" | "askedAt">,
  /** 首问时由 conversation-title.ts 概括出来的标题；追问轮次不传。 */
  title?: string,
): Promise<StoredConversation | null> {
  return serializedMutation(async () => {
    const store = await readFileStore();
    store.conversations = pruneExpiredConversations(store.conversations);
    const conversation = store.conversations.find((item) => item.id === conversationId);
    if (!conversation) return null;
    // 标题只在第一次写进去，后面的追问不覆盖——列表上要的是"话题的名字"，
    // 不是"最后一问的名字"。
    if (title && !conversation.title) conversation.title = title;

    const fullTurn: ConversationTurn = {
      ...turn,
      turnId: `turn_${randomUUID()}`,
      askedAt: new Date().toISOString(),
    };
    conversation.turns.push(fullTurn);
    conversation.turns = conversation.turns.slice(-MAX_TURNS_PER_CONVERSATION);
    if (turn.usedFollowUpCredit) conversation.freeFollowUpsUsed += 1;
    conversation.updatedAt = fullTurn.askedAt;

    await writeFileStore(store);
    return conversation;
  });
}

/** 「最近对话」列表上需要的那点信息。不带 turns——列表不需要正文，也不该把正文拖出来。 */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
}

/**
 * 某个账号的对话列表，最近的在前。
 *
 * 2026-09-18 加。在这之前列表只活在浏览器的 localStorage 里，
 * 换浏览器就全没了（用户实测撞上）。现在它跟着账号走。
 *
 * 只返回**这个账号自己的**对话：游客建的对话没有 userId，不会出现在任何人的列表里
 * ——那些仍然靠浏览器里的 localStorage 找回来，这是游客没有账号可绑的固有限制。
 *
 * 默认返回**全部**（2026-09-30 改）：之前只取最近 20 条，用户要求「最近对话」全量展示，
 * 每个账号都能看到自己的所有历史对话。保留 `limit` 参数仅供少数需要截断的调用方显式使用。
 */
export async function listConversationsForUser(
  userId: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<ConversationSummary[]> {
  if (!userId) return [];
  const store = await readFileStore();
  return store.conversations
    .filter((conversation) => conversation.userId === userId && conversation.turns.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title
        // 老数据没有 title 字段（2026-09-18 之前建的），退回用第一问的开头，
        // 不显示"新对话"这种等于没说的占位。
        || conversation.turns[0]?.rawQuestion.slice(0, 20)
        || "历史对话",
      updatedAt: conversation.updatedAt,
      turnCount: conversation.turns.length,
    }));
}
