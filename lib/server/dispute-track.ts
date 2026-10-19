/**
 * 争议应对型答案的**审级骨架**加载器。
 *
 * 数据在 `config/dispute-tracks.json`，那个文件顶部写了为什么它是配置而不是模型生成。
 * 一句话：审级顺序、期限、规费、预缴比例一年变不了一次，让模型每次现编，
 * 就会重演已经修过的那几类错——编数字、用被取代的旧值、漏掉分支。
 *
 * 这个模块只做三件事：**读文件、按法域选一条、把两套条号收敛成一套**。
 * 不做任何判断，判断在 `question-type.ts`（是不是争议型）和
 * `domain-scope.ts`（哪个法域）里已经做完了。
 *
 * ## 关于所得税的双条号
 *
 * Income-tax Act, 2025 自 2026-04-01 施行，**条号整个重排**（700+ 条并成 536 条）。
 * 骨架里每个 cell 的 citation 存了两套。
 *
 * 渲染时**默认用 2025 法**，同时把 1961 法的对应条号作为 `legacyCitation` 一起下发。
 * 不追问用户税期，理由有两条：
 *   ① 多义词闸门已经在追问了，再加一个会让争议型问题几乎必然先被问一次。
 *   ② "程序法适用提起程序时有效的法律"本身有解释空间——与其让系统猜，
 *      不如两套条号都摆出来，让用户自己对。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type CitationBasis = "STATUTE" | "PRACTICE_ESTIMATE";

export interface TrackCell {
  key: string;
  value: string;
  basis: CitationBasis;
  note?: string;
  /** 这一格的条文和所在审级不同时用（例如 20% 预缴出自 CBDT 备忘录）。 */
  citation_override?: string;
  /** 位阶。只在和所在审级不同时标（CIRCULAR 尤其要标——它不约束法院）。 */
  hierarchy?: string;
}

export interface TrackStage {
  id: string;
  label: string;
  /** 字符串（GST/海关）或双条号对象（所得税）。 */
  citation?: string | { act_2025: string; act_1961: string };
  note?: string;
  cells: TrackCell[];
  next: string | null;
}

export interface DisputeTrack {
  id: string;
  domain: string;
  label: string;
  clock_start?: Record<string, unknown>;
  default_payment?: Record<string, unknown>;
  running_cost?: Record<string, unknown>;
  scn_limitation?: Array<Record<string, unknown>>;
  branch_question?: string;
  branches?: Array<{ id: string; when: string; label: string; stages: TrackStage[] }>;
  stages: TrackStage[];
}

interface TracksFile {
  tracks?: DisputeTrack[];
}

const tracksPath = path.join(process.cwd(), "config", "dispute-tracks.json");

let cache: TracksFile | null = null;

/**
 * 读配置。失败时返回空——**争议模板是增强，不该让它挡住整条回答链路**。
 * 和 `terms-store.ts` 读多义词表同一个立场。
 */
async function load(): Promise<TracksFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(tracksPath, "utf8");
    cache = JSON.parse(raw) as TracksFile;
  } catch {
    cache = {};
  }
  return cache;
}

/** 管理员改了配置之后调这个，不用重启。和词典的 refresh 同一个模式。 */
export function refreshDisputeTrackCache(): void {
  cache = null;
}

/**
 * 按法域取骨架。
 *
 * `questionCategories` 是会话级法域（`resolveConversationCategories` 的结果）。
 * **空数组 = 认不出法域 → 返回 undefined**，不猜一个税种给用户看——
 * 三个税种的预缴比例和审级完全不同，给错一张图比不给更糟。
 *
 * 命中多个法域时取第一个：跨法域的争议问题（"GST 和海关都被查了"）很少见，
 * 而且真出现时给两张图会让页面失去焦点。这里刻意只给一张，
 * 另一个法域由正文的「法规要求」承载。
 */
export async function loadDisputeTrack(
  questionCategories: string[],
): Promise<DisputeTrack | undefined> {
  if (questionCategories.length === 0) return undefined;
  const { tracks = [] } = await load();
  for (const category of questionCategories) {
    const hit = tracks.find((track) => track.domain === category);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 把一个审级的 citation 收敛成「主条号 + 旧条号」。
 *
 * 所得税是双条号对象，GST 和海关是字符串。调用方不该关心这个差别。
 */
export function resolveStageCitation(
  citation: TrackStage["citation"],
): { primary?: string; legacy?: string } {
  if (!citation) return {};
  if (typeof citation === "string") return { primary: citation };
  return { primary: citation.act_2025, legacy: citation.act_1961 };
}

/**
 * 把分支和主干拼成**一条线性的审级序列**，供展示层直接遍历。
 *
 * 分支（所得税的 DRP / CIT(A)）在这里**不合并**——它们是并行的两条路，
 * 拼成一条会造出一个现实中不存在的流程。调用方拿到的是
 * `{ branches, stages }`，自己决定怎么画分叉。
 *
 * 之所以单开这个函数而不是让展示层自己拼：`next` 指针的解析逻辑
 * （分支末尾指向主干的 itat）只该有一份。
 */
export function flattenStages(track: DisputeTrack): {
  branchQuestion?: string;
  branches: Array<{ id: string; when: string; label: string; stages: TrackStage[] }>;
  trunk: TrackStage[];
} {
  return {
    branchQuestion: track.branch_question,
    branches: track.branches ?? [],
    trunk: track.stages ?? [],
  };
}
