import type {
  KnowledgeChunkReview,
  KnowledgeChunkPreview,
  KnowledgeValidationResult,
} from "./contracts";

const REQUIRED_FIELDS = ["来源", "大标题", "小标题", "原文链接"] as const;

/**
 * 适用期间字段（2026-09-16 加）。
 *
 * 起因：印度2025年所得税法自2026-04-01起施行，同日废止1961年所得税法；但1961年法
 * 对2026-04-01之前开始的税年、以及据此启动的待决评估/上诉/重开程序继续适用。
 * 也就是说知识库里必须同时存在两部法，靠"适用期间"而不是靠"删掉旧法"来区分。
 *
 * 在此之前，`provisionEffectiveFrom`/`provisionEffectiveTo` 这些字段虽然在类型和
 * 数据库schema里都有、`coversDate()` 也在读，但**上传格式里根本没有地方填**，
 * 运行时永远是 undefined——那道期间校验实际上一直在空转。这次补的就是从txt
 * 解析到存储这一段。
 *
 * 两个层级，都可选，不填＝现行有效（既有资料完全不受影响，不需要回头补）：
 *   1. 文件头部（第一个 ----- 之前的整块）：对该文件所有chunk生效，
 *      用于"整部法有统一的施行日/废止日"这种最常见的情况。
 *   2. chunk自己的字段：覆盖文件头部的值，用于条文级生效日与整部法不一致的情况
 *      （正文出现 with effect from、inserted by ... Act, 20XX 时校验器会提醒确认）。
 *      注意必须写在【原文链接】**之前**——【原文链接】后面紧跟空行才是正文起点。
 */
const HEADER_FIELD_MAP = {
  法律生效日: "provisionEffectiveFrom",
  法律失效日: "provisionEffectiveTo",
  适用说明: "applicabilityNote",
} as const;

/**
 * chunk 级字段。同时认【生效日】和【法律生效日】两种写法——
 * 真实情况（2026-09-16）：用户用脚本生成1383个chunk的文件时，把三行适用期间
 * **逐chunk重复写**在了每个chunk开头，且用的是文件头部那套名字（法律生效日/法律失效日）。
 * 原来只认【生效日】，于是日期被**静默忽略**：不报错、chunk数也正常，
 * 但 provisionEffectiveFrom/To 全是空，已废止的1961年法照样会被当成现行有效引用。
 * 这种"看起来成功了、实际没生效"的失败最难发现，所以这里选择兼容两种写法，
 * 而不是让用户回去重新生成文件。
 */
const CHUNK_FIELD_MAP = {
  生效日: "provisionEffectiveFrom",
  失效日: "provisionEffectiveTo",
  法律生效日: "provisionEffectiveFrom",
  法律失效日: "provisionEffectiveTo",
  适用说明: "applicabilityNote",
} as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 《知识库数据规范 V1.4》§3：条文生效日常与整部法不同。
 * 正文出现下列措辞时，必须由管理员确认条文级生效日，可确认“与整部法一致”，但不得跳过。
 */
const EFFECTIVE_DATE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "with effect from", pattern: /with\s+effect\s+from[^.\n]{0,80}/gi },
  { label: "w.e.f.", pattern: /\bw\.e\.f\.[^.\n]{0,60}/gi },
  { label: "shall come into force", pattern: /shall\s+come\s+into\s+force[^.\n]{0,80}/gi },
  { label: "inserted by", pattern: /inserted\s+by[^.\n]{0,80}?Act,?\s*\d{4}/gi },
  { label: "substituted by", pattern: /substituted\s+by[^.\n]{0,80}?Act,?\s*\d{4}/gi },
  { label: "omitted by", pattern: /omitted\s+by[^.\n]{0,80}?Act,?\s*\d{4}/gi },
  { label: "for the tax year", pattern: /for\s+the\s+tax\s+year[^.\n]{0,60}/gi },
  { label: "financial year", pattern: /(?:from|for)\s+(?:the\s+)?financial\s+year\s+\d{4}[-–]\d{2,4}/gi },
];

function detectEffectiveDateHints(body: string): string[] {
  const hits: string[] = [];
  for (const { pattern } of EFFECTIVE_DATE_PATTERNS) {
    const matches = body.match(pattern);
    if (matches) {
      for (const match of matches) {
        const cleaned = match.replace(/\s+/g, " ").trim();
        if (cleaned && !hits.includes(cleaned)) hits.push(cleaned);
        if (hits.length >= 4) return hits;
      }
    }
  }
  return hits;
}

function readField(chunk: string, name: string) {
  const match = chunk.match(new RegExp(`^【${name}】[ \\t]*(.+)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

interface ApplicabilityFields {
  provisionEffectiveFrom?: string;
  provisionEffectiveTo?: string;
  applicabilityNote?: string;
}

/**
 * 从一段文本里读出适用期间字段。`fieldMap` 决定认哪几个标签
 * （文件头部用【法律生效日】，chunk级用【生效日】）。
 * 日期格式错误只收集进 errors，不抛异常——一次校验要把所有问题一起报给管理员。
 */
function readApplicability(
  text: string,
  fieldMap: Record<string, keyof ApplicabilityFields>,
  errors: string[],
  where: string,
): ApplicabilityFields {
  const fields: ApplicabilityFields = {};
  for (const [label, key] of Object.entries(fieldMap)) {
    const value = readField(text, label);
    if (!value) continue;
    // 同一个字段有两种写法时（生效日 / 法律生效日），先出现的那个写法优先，不互相覆盖。
    if (fields[key] !== undefined) continue;
    if (key !== "applicabilityNote" && !DATE_PATTERN.test(value)) {
      errors.push(`${where}的【${label}】必须写成 YYYY-MM-DD（当前是“${value}”）。`);
      continue;
    }
    fields[key] = value;
  }
  const { provisionEffectiveFrom: from, provisionEffectiveTo: to } = fields;
  if (from && to && from > to) {
    errors.push(`${where}的生效日（${from}）晚于失效日（${to}），请检查。`);
  }
  return fields;
}

/**
 * 【原文链接】是不是"只有域名"——例如 `https://indiankanoon.org#page=1`。
 *
 * 起因（2026-09-20）：100 题验收里 607 条引用有 14 条是这个形状，来自 3 份上传资料。
 * 用户点"查看原文"会落到网站首页，**既找不到那一条，也不知道自己被送错了地方**——
 * 比没有链接更糟，因为界面明确承诺了"这是官方出处"。
 *
 * 为什么必须在这里拦、而且判成 error 不判成 warning：
 * 判分口径已经改成"条号只比到条一级，子款深度由用户点链接看原文来补"。
 * 也就是说**一部分正确性被明确地押在了链接上**。押上去了就不能只是提醒一句，
 * 否则等于把要求挪到了一个没人管的地方。原来的校验只查了 `^https?://`，
 * 这 14 条全都合法地通过了——**格式对不等于能用**。
 *
 * `#page=1` 这种片段要先切掉再看路径：片段不是路径，带着它判会漏。
 * 解析失败也算坏链——连 URL 都构造不出来的字符串，更不可能打得开。
 */
function isBareDomainUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return parsed.pathname === "" || parsed.pathname === "/";
  } catch {
    return true;
  }
}

/**
 * 判断第一段是不是"文件头部"而不是第一个chunk：没有【来源】、但带了适用期间字段。
 * 这样既有的、没有头部的文件解析结果完全不变。
 */
function looksLikeApplicabilityHeader(segment: string) {
  if (readField(segment, "来源")) return false;
  return Object.keys(HEADER_FIELD_MAP).some((label) => Boolean(readField(segment, label)));
}

export function validateKnowledgeTxt(
  fileName: string,
  rawText: string,
): KnowledgeValidationResult {
  const normalized = rawText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const separatorMatches = normalized.match(/^-----[ \t]*$/gm) ?? [];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!normalized.trim()) {
    errors.push("TXT文件为空。请上传包含正式资料的文件。");
  }

  if (!/^-----[ \t]*$/m.test(normalized)) {
    errors.push("没有找到单独占一行的“-----”分隔符。");
  }

  if (normalized.trim() && !/\n-----[ \t]*$/.test(normalized.trimEnd())) {
    errors.push("最后一个Chunk也必须以“-----”结束。");
  }

  const segments = normalized
    .split(/^-----[ \t]*$/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  // 文件头部（可选）：整份资料统一的适用期间，对下面每个chunk生效。
  const hasHeader = segments.length > 0 && looksLikeApplicabilityHeader(segments[0]);
  const documentApplicability = hasHeader
    ? readApplicability(segments[0], HEADER_FIELD_MAP, errors, "文件头部")
    : {};
  const chunks = hasHeader ? segments.slice(1) : segments;

  if (hasHeader && chunks.length === 0) {
    errors.push("文件里只有适用期间头部，没有任何Chunk。");
  }

  const preview: KnowledgeChunkPreview[] = [];
  const reviewChunks: KnowledgeChunkReview[] = [];
  const fingerprints = new Set<string>();
  const confirmations: string[] = [];

  chunks.forEach((chunk, index) => {
    const number = index + 1;
    const values = Object.fromEntries(
      REQUIRED_FIELDS.map((field) => [field, readField(chunk, field)]),
    ) as Record<(typeof REQUIRED_FIELDS)[number], string>;

    REQUIRED_FIELDS.forEach((field) => {
      if (!values[field]) {
        errors.push(`Chunk ${number} 缺少或未填写【${field}】。`);
      }
    });

    if (
      values.原文链接 &&
      !/^https?:\/\//i.test(values.原文链接)
    ) {
      errors.push(`Chunk ${number} 的【原文链接】不是http/https地址。`);
    } else if (values.原文链接 && isBareDomainUrl(values.原文链接)) {
      // 见 isBareDomainUrl 的说明：只有域名的链接会把用户送到首页。
      errors.push(
        `Chunk ${number} 的【原文链接】只有域名（${values.原文链接}），`
        + "点开会落到网站首页、找不到这一条。请填能直接打开这一条的完整地址。",
      );
    }

    const bodyStart = chunk.search(/【原文链接】[^\n]*\n\s*\n/);
    const body = bodyStart >= 0
      ? chunk.slice(bodyStart).replace(/^【原文链接】[^\n]*\n\s*\n/, "").trim()
      : "";

    if (!body) {
      errors.push(`Chunk ${number} 缺少字段后的空行或官方正文。`);
    }

    const fingerprint = `${values.小标题}\n${body}`;
    if (body && fingerprints.has(fingerprint)) {
      errors.push(`Chunk ${number} 与前面的标题和正文重复。`);
    }
    fingerprints.add(fingerprint);

    const words = body.split(/\s+/).filter(Boolean).length;
    const warning = words > 1000
      ? `Chunk ${number} 约${words}词，请检查是否需要拆成Part。`
      : undefined;
    if (warning) warnings.push(warning);

    const effectiveDateHints = detectEffectiveDateHints(body);
    if (effectiveDateHints.length) {
      confirmations.push(
        `Chunk ${number} 出现生效措辞（${effectiveDateHints[0]}），`
        + "请确认条文级生效日期。可确认“与整部法一致”，但不得跳过。",
      );
    }

    // chunk自己写的适用期间覆盖文件头部；都没写就留空（＝现行有效）。
    const chunkApplicability = readApplicability(
      chunk,
      CHUNK_FIELD_MAP,
      errors,
      `Chunk ${number}`,
    );
    const applicability = { ...documentApplicability, ...chunkApplicability };

    const reviewChunk: KnowledgeChunkReview = {
      number,
      source: values.来源,
      majorTitle: values.大标题,
      minorTitle: values.小标题,
      officialUrl: values.原文链接,
      bodyLength: body.length,
      body,
      wordCount: words,
      warning,
      needsEffectiveDateConfirmation: effectiveDateHints.length > 0,
      effectiveDateHints: effectiveDateHints.length ? effectiveDateHints : undefined,
      ...applicability,
    };
    reviewChunks.push(reviewChunk);
    preview.push(reviewChunk);
  });

  /*
   * 没有文件头部、但每个chunk都自己写了适用期间时（逐chunk重复写的那种文件），
   * 把**全体一致**的值提升为文件级，好让后台界面顶部那条提示也能显示出来。
   * 只要有一条不一致就不提升——那种情况下"这份资料的适用期间"本来就不存在单一答案，
   * 编一个出来反而会误导。
   */
  const unanimous = <K extends "provisionEffectiveFrom" | "provisionEffectiveTo" | "applicabilityNote">(key: K) => {
    if (reviewChunks.length === 0) return undefined;
    const first = reviewChunks[0][key];
    if (!first) return undefined;
    return reviewChunks.every((chunk) => chunk[key] === first) ? first : undefined;
  };
  if (!hasHeader) {
    documentApplicability.provisionEffectiveFrom ??= unanimous("provisionEffectiveFrom");
    documentApplicability.provisionEffectiveTo ??= unanimous("provisionEffectiveTo");
    documentApplicability.applicabilityNote ??= unanimous("applicabilityNote");
  }

  // 标了失效日＝这是一部已废止/已过期的法，发布后只在问到该期间时才会被引用。
  // 这件事影响面太大（填错会让现行法答不出来、或让废止法继续被引用），强制管理员确认一次。
  if (documentApplicability.provisionEffectiveTo) {
    confirmations.push(
      `这份资料被标记为【${documentApplicability.provisionEffectiveFrom ?? "不限起点"} 至 `
      + `${documentApplicability.provisionEffectiveTo}】适用。发布后，只有问到这个期间的问题才会引用它，`
      + "问当前有效规则时不会出现。请确认这个期间填对了。",
    );
  }

  return {
    fileName,
    chunkCount: chunks.length,
    separatorCount: separatorMatches.length,
    status: errors.length ? "VALIDATION_FAILED" : "READY_TO_REVIEW",
    errors,
    warnings,
    confirmations,
    preview: preview.slice(0, 5),
    chunks: reviewChunks,
    documentEffectiveFrom: documentApplicability.provisionEffectiveFrom,
    documentEffectiveTo: documentApplicability.provisionEffectiveTo,
    documentApplicabilityNote: documentApplicability.applicabilityNote,
  };
}
