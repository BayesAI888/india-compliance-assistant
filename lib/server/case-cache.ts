/**
 * 实时判例的**后台自动缓存**：本地案例库不够用、临时去 Indian Kanoon 现查回来的判例，
 * 顺手提炼成案例库的九字段结构存下来，下次同类问题就不用再花钱现查。
 *
 * 用户的原话（2026-09-17）：「当现存案例库不能满足搜索要求时……主动触发indiankanoon
 * 数据库搜索……同时在后台缓存这几个案例进入案例库。」
 *
 * ## 三条硬性设计约束
 *
 * **一、绝不拖慢用户看到答案的时间。**
 * 缓存要下载判决书全文 + 再调一次模型提炼，慢且花钱。所以它是 fire-and-forget：
 * `retrieveRelatedCases` 拿到实时结果就立刻返回给主流程，缓存在后台自己跑完。
 * 缓存失败对用户完全无感——本来也只是省下次的钱，不是这次答案的前提。
 *
 * **二、自动提炼的案例一律进「待审核」，不直接进问答检索范围。**
 * 这是整个项目一以贯之的底线：模型提炼的结构化字段没有人看过，就不能当成证据用。
 * 走 `stageCase` 和管理员手工上传完全同一条路、同一套校验，状态同样是 TO_REVIEW，
 * 管理员在后台点「发布」它才会进入本地检索。
 * 想让它自动发布的话，配 `CASE_AUTO_CACHE_PUBLISH=on`——默认关着，这是有意的：
 * 「误放进一条没人看过的判例」比「多花一次现查的钱」代价大得多。
 *
 * **三、提炼结果要过和 `case-digest.ts`、`quote-check.ts` 同一套反编造核验。**
 * 金额必须在判决书原文里真的出现过；docid 必须和实际下载到的那份对得上。
 * 过不了就整条丢掉，不存——宁可缓存为空，也不能往案例库里灌假数据。
 */
import type { RelatedCase } from "../contracts";
import { CaseValidationError, publishCase, stageCase } from "./case-store";
import { fetchCaseFullText } from "./case-detail-lookup";
import { amountsAreGrounded, extractAmounts } from "./case-digest";
import { requestStructuredJson } from "./deepseek";

/** 送进模型提炼的判决书正文上限。和 case-detail-lookup 的取值口径保持一致。 */
const MAX_DOC_CHARS = 40_000;
/** 一次问答最多后台缓存几条，防止一个问题触发一串下载+模型调用。 */
const MAX_CACHE_PER_QUESTION = 3;

export function isCaseAutoCacheEnabled(): boolean {
  const flag = process.env.CASE_AUTO_CACHE?.trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  // 两个前提都得有：能下载原文（IK token）、能提炼（DeepSeek key）。
  return Boolean(process.env.INDIANKANOON_API_TOKEN?.trim() && process.env.DEEPSEEK_API_KEY?.trim());
}

/** 自动缓存的案例是否直接发布。默认否——见文件头第二条约束。 */
function shouldAutoPublish(): boolean {
  const flag = process.env.CASE_AUTO_CACHE_PUBLISH?.trim().toLowerCase();
  return flag === "on" || flag === "true" || flag === "1";
}

interface RawExtractedCase {
  case_name?: string;
  court_and_year?: string;
  tax_type_and_authority?: string;
  revenue_position?: string[];
  assessee_argument?: string[];
  final_ruling?: string[];
  evidence_support?: string[];
  reference_value_note?: string;
}

const PLACEHOLDER = "文档中未明确提及";

function cleanLines(values: string[] | undefined, allowedAmounts: Set<string>): string[] {
  return (values ?? [])
    .map((line) => line?.trim() ?? "")
    .filter(Boolean)
    // 反编造：带了原文里没有的金额，整行丢掉。
    .filter((line) => amountsAreGrounded(line, allowedAmounts))
    .slice(0, 6);
}

function numberedList(items: string[]): string {
  if (items.length === 0) return PLACEHOLDER;
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

/**
 * 把提炼结果拼回案例库的 Markdown 模板。
 *
 * 为什么绕一圈拼成文本、再交给 `stageCase` 去解析，而不是直接构造 `ParsedCase`：
 * 这样自动缓存和人工上传走的是**同一个校验器**（`validateCaseText`）。
 * 将来模板加字段、改必填项，两条路自动一起跟上，不会出现"人工上传拦得住、
 * 自动缓存漏进来"的偏差。多绕的这一次正则解析，成本可以忽略。
 */
export function buildCaseMarkdown(fields: {
  caseName: string;
  courtAndYear: string;
  docid: string;
  taxTypeAndAuthority: string;
  revenuePosition: string[];
  assesseeArgument: string[];
  finalRuling: string[];
  evidenceSupport: string[];
  officialUrl: string;
  referenceValueNote: string;
}): string {
  return [
    `# ${fields.caseName}`,
    "",
    `**案件名称**：${fields.caseName}`,
    `**法院与年份**：${fields.courtAndYear || PLACEHOLDER}`,
    `**IndianKanoon文档ID**：${fields.docid}`,
    `**争议税种以及主管税局**：${fields.taxTypeAndAuthority || PLACEHOLDER}`,
    `**税局主张（Revenue's Position）**：`,
    numberedList(fields.revenuePosition),
    `**企业抗辩方向（Assessee's Argument）**：`,
    numberedList(fields.assesseeArgument),
    `**最终裁定结果**：`,
    numberedList(fields.finalRuling),
    `**证据支撑要点**：`,
    numberedList(fields.evidenceSupport),
    `**印度数据库链接**：${fields.officialUrl}`,
    "",
    "---",
    "",
    "## 对中资企业的参考价值",
    "",
    fields.referenceValueNote || PLACEHOLDER,
  ].join("\n");
}

/**
 * 下载一份判决书原文，提炼成九字段并存进案例库。
 * 成功返回案例记录 id，任何一步失败返回 null（静默，不抛）。
 */
/**
 * IK 的 title 字段可能带 `<b>…</b>` 高亮标签（搜索接口对命中词加粗，
 * doc 接口不保证干净）。入库或喂模型前剥掉——带标签的标题存进案例库
 * 就是持久污染（2026-10-13 线上实测：「案例索引」渲染出了 `<b>Samsung</b>`）。
 */
function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function cacheOneCase(item: RelatedCase): Promise<string | null> {
  try {
    const full = await fetchCaseFullText(item.docid);
    if (!full?.text) return null;
    // docid 一致性：下载到的那份必须就是我们要的那份，否则存进去的链接和内容对不上。
    if (full.docid !== item.docid) return null;

    const docText = full.text.slice(0, MAX_DOC_CHARS);
    const allowedAmounts = new Set(extractAmounts(docText));

    const { data } = await requestStructuredJson<RawExtractedCase>({
      role: "answer",
      maxTokens: 2_200,
      messages: [
        {
          role: "system",
          content: [
            "你在把一份印度税务判决书提炼成合规案例库的结构化记录，读者是在印度经营的中资企业。",
            "",
            "硬性要求：",
            "1. 只能写判决书原文里真实存在的内容。**原文没写的，一律写「文档中未明确提及」，不要推断、不要补全。**",
            "2. 金额、税额、条款号必须与原文写法一致，不得换算、估算或四舍五入。",
            "3. 每个数组字段写 2–5 条，每条一句话，中文表述，案件名/法条号/英文术语保留原文。",
            "4. 「对中资企业的参考价值」写这个判例对中资企业有什么实操启示，3 句以内。",
            "",
            "只返回 JSON，结构：",
            '{"case_name":"","court_and_year":"法院名 + 判决年份","tax_type_and_authority":"争议税种与主管税局",',
            '"revenue_position":[],"assessee_argument":[],"final_ruling":[],"evidence_support":[],',
            '"reference_value_note":""}',
          ].join("\n"),
        },
        {
          role: "user",
          content: `判决书标题：${stripTags(full.title) || item.caseName}\n\n判决书正文：\n${docText}`,
        },
      ],
    });

    // full.title 来自 IK 的 doc 接口——搜索接口的 title 带 `<b>` 高亮标签
    // （2026-10-13 线上实测过），doc 接口不保证干净；入库的标题带标签的话，
    // 以后从案例库展示就成了持久污染。一并剥掉。
    const caseName = (data.case_name?.trim() || stripTags(full.title) || item.caseName).trim();
    const finalRuling = cleanLines(data.final_ruling, allowedAmounts);
    const revenuePosition = cleanLines(data.revenue_position, allowedAmounts);
    const assesseeArgument = cleanLines(data.assessee_argument, allowedAmounts);
    // 三个必填字段任何一个被核验剔空，整条都不要——半条案例记录在问答里只会误导。
    if (!caseName || finalRuling.length === 0 || revenuePosition.length === 0 || assesseeArgument.length === 0) {
      return null;
    }

    const markdown = buildCaseMarkdown({
      caseName,
      courtAndYear: data.court_and_year?.trim() || item.court_and_year || "",
      docid: item.docid,
      taxTypeAndAuthority: data.tax_type_and_authority?.trim() || "",
      revenuePosition,
      assesseeArgument,
      finalRuling,
      evidenceSupport: cleanLines(data.evidence_support, allowedAmounts),
      officialUrl: item.official_url,
      referenceValueNote: amountsAreGrounded(data.reference_value_note ?? "", allowedAmounts)
        ? data.reference_value_note?.trim() ?? ""
        : "",
    });

    const { record, duplicate } = await stageCase(`auto_${item.docid}.md`, markdown);
    if (duplicate) return record.id;
    if (shouldAutoPublish()) await publishCase(record.id);
    return record.id;
  } catch (error) {
    // 校验不通过说明模型提炼得不完整，和网络失败一样——静默跳过这一条。
    if (error instanceof CaseValidationError) return null;
    return null;
  }
}

/**
 * 后台缓存入口。**故意不 await**（调用方用 `void`），不进入用户等待答案的关键路径。
 * 逐条串行跑，不并发——三条判决书全文同时下载再同时调模型，对单机没有必要。
 */
export async function cacheLiveCases(cases: RelatedCase[]): Promise<number> {
  if (!isCaseAutoCacheEnabled()) return 0;
  let cached = 0;
  for (const item of cases.slice(0, MAX_CACHE_PER_QUESTION)) {
    const id = await cacheOneCase(item);
    if (id) cached += 1;
  }
  return cached;
}
