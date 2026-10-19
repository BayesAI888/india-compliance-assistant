"use client";

import Link from "next/link";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import type { AnswerResponse, KnowledgeValidationResult } from "../../lib/contracts";
import { validateKnowledgeTxt } from "../../lib/knowledge-validator";
import { validateCaseText } from "../../lib/case-validator";
import { DOCUMENT_CATEGORIES } from "../../lib/server/document-category";

const adminNav = ["总览", "会员与订单", "资料上传", "审核与发布", "税务案例库", "术语词典", "来源配置", "标准答案缓存", "测试与日志"];
type ReviewStatus = "PENDING" | "IN_REVIEW" | "PUBLISHED";
interface KnowledgeStats {
  publishedDocumentCount: number;
  reviewDocumentCount: number;
  publishedChunkCount: number;
}

interface TermsSyncMeta {
  sourceFileName: string;
  syncedAt: string;
  totalRows: number;
  publishedCount: number;
  warnings: string[];
}

interface TermsStatus {
  synced: boolean;
  meta: TermsSyncMeta | null;
  termCount: number;
  sample: Array<{ term_zh: string; official_term_en: string; domain: string[] }>;
}

interface TermsUploadResult {
  ok: boolean;
  message?: string;
  errors?: string[];
  warnings?: string[];
  totalRows?: number;
  publishedCount?: number;
  termCount?: number;
}

type FeaturedCachedAnswer = Omit<AnswerResponse,
  "request_id" | "conversation_id" | "quota" | "conversation_title" | "reply_deadline"
>;

interface FeaturedAnswerAdminRecord {
  id: string;
  label: string;
  question: string;
  enabled: boolean;
  fresh: boolean;
  updatedAt: string;
  updatedBy: "初始审核" | "管理员";
  answer?: FeaturedCachedAnswer;
}

interface FeaturedAnswersPayload {
  records: FeaturedAnswerAdminRecord[];
  knowledgeVersion: string;
}

interface FeaturedAnswerForm {
  shortConclusion: string;
  assumptions: string[];
  mandatoryTexts: string[];
  practicalTexts: string[];
  risks: string[];
  caseSearchNote: string;
  caseClusters: Array<{ challenge: string; evidence: string[]; takeaway: string }>;
  caseActionPoints: string[];
}

function formOfFeaturedAnswer(answer: FeaturedCachedAnswer): FeaturedAnswerForm {
  return {
    shortConclusion: answer.short_conclusion,
    assumptions: [...answer.assumptions],
    mandatoryTexts: answer.action_steps.filter((step) => step.kind === "MANDATORY").map((step) => step.text),
    practicalTexts: answer.action_steps.filter((step) => step.kind === "PRACTICAL").map((step) => step.text),
    risks: [...answer.risks_and_exceptions],
    caseSearchNote: answer.case_search_note ?? "",
    caseClusters: answer.case_digest?.clusters.map((cluster) => ({
      challenge: cluster.challenge,
      evidence: cluster.evidence.map((entry) => entry.text),
      takeaway: cluster.takeaway ?? "",
    })) ?? [],
    caseActionPoints: [...(answer.case_digest?.action_points ?? [])],
  };
}

async function fetchKnowledgeStats(): Promise<KnowledgeStats | null> {
  try {
    const response = await fetch("/api/admin/knowledge", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json() as KnowledgeStats;
  } catch {
    return null;
  }
}

async function fetchTermsStatus(): Promise<TermsStatus | null> {
  try {
    const response = await fetch("/api/admin/terms", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json() as TermsStatus;
  } catch {
    return null;
  }
}

function AdminBrand() {
  return (
    <div className="admin-brand">
      <span>印</span>
      <div><strong>印度合规助手</strong><small>超级管理员后台</small></div>
    </div>
  );
}

function ResultPanel({
  result,
  onReview,
  reviewStatus,
  staged,
}: {
  result: KnowledgeValidationResult;
  onReview: () => void;
  reviewStatus: ReviewStatus;
  staged: boolean;
}) {
  const formatReady = result.status === "READY_TO_REVIEW";
  const ready = formatReady && staged;
  const badgeText = !formatReady
    ? "格式校验失败"
    : !staged
      ? "资料尚未保存"
    : reviewStatus === "PUBLISHED"
      ? "审核完成，已记录"
      : reviewStatus === "IN_REVIEW"
        ? "人工审核进行中"
        : "格式通过，等待审核";
  const buttonText = !formatReady
    ? "修正后重新上传"
    : !staged
      ? "保存失败，请重新上传"
    : reviewStatus === "PUBLISHED"
      ? "查看已发布内容"
      : reviewStatus === "IN_REVIEW"
        ? "继续人工审核"
        : "进入人工审核";
  return (
    <section className="validation-result">
      <div className="validation-summary">
        <div>
          <span className={`validation-badge ${ready ? "ready" : "failed"}`}>{badgeText}</span>
          <h2>{result.fileName}</h2>
          <p>{result.chunkCount}个Chunk · {result.separatorCount}个分隔符 · {result.errors.length}个错误 · {result.warnings.length}个提醒</p>
        </div>
        <button type="button" disabled={!ready} onClick={onReview}>{buttonText}</button>
      </div>

      {/* 适用期间（2026-09-16加）：标了失效日的资料是已废止的旧法，发布后只在问到
          该期间时才会被引用。这件事必须在发布前一眼能看见，否则填错了没人会发现。 */}
      {(result.documentEffectiveFrom || result.documentEffectiveTo || result.documentApplicabilityNote) && (
        <div className={`applicability-banner${result.documentEffectiveTo ? " expired" : ""}`}>
          <strong>
            适用期间：{result.documentEffectiveFrom ?? "不限起点"} 至 {result.documentEffectiveTo ?? "现行有效"}
          </strong>
          {result.documentApplicabilityNote && <span>{result.documentApplicabilityNote}</span>}
          {result.documentEffectiveTo && (
            <span>
              这是一部已废止/已过期的资料。发布后，只有问到这个期间的问题才会引用它；
              问当前有效规则时不会出现。请确认期间填对了再发布。
            </span>
          )}
        </div>
      )}

      {(result.errors.length > 0 || result.warnings.length > 0 || result.confirmations.length > 0) && (
        <div className="issue-grid">
          {result.errors.length > 0 && <div className="issue-card issue-error"><strong>阻断错误</strong><ul>{result.errors.map((error) => <li key={error}>{error}</li>)}</ul></div>}
          {result.warnings.length > 0 && <div className="issue-card issue-warning"><strong>需要确认</strong><ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
          {/* confirmations 之前算出来了却从来没显示过——《知识库数据规范 V1.4》§3 要求
              管理员逐条确认条文级生效日"不得跳过"，但界面上根本看不到这些提示。 */}
          {result.confirmations.length > 0 && <div className="issue-card issue-warning"><strong>发布前请逐条确认</strong><ul>{result.confirmations.map((item) => <li key={item}>{item}</li>)}</ul></div>}
        </div>
      )}

      {result.preview.length > 0 && (
        <div className="chunk-preview">
          <div className="admin-section-title"><div><span>CHUNK PREVIEW</span><h2>前5个Chunk</h2></div><small>法规正文只在管理员后台显示</small></div>
          <div className="admin-table-wrap">
            <table>
              <thead><tr><th>来源</th><th>定位</th><th>官方链接</th><th>正文字符</th></tr></thead>
              <tbody>{result.preview.map((chunk, index) => (
                <tr key={`${chunk.minorTitle}-${index}`}>
                  <td><strong>{chunk.source || "—"}</strong><span>{chunk.majorTitle || "—"}</span></td>
                  <td>{chunk.minorTitle || "—"}</td>
                  <td>{chunk.officialUrl ? <a href={chunk.officialUrl} target="_blank" rel="noreferrer">查看原始链接 ↗</a> : "—"}</td>
                  <td>{chunk.bodyLength.toLocaleString("zh-CN")}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function ReviewPanel({
  result,
  onBack,
  published,
  onPublish,
}: {
  result: KnowledgeValidationResult;
  onBack: () => void;
  published: boolean;
  onPublish: () => Promise<void>;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [confirmed, setConfirmed] = useState(published);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const selected = result.chunks[selectedIndex];

  if (!selected) {
    return (
      <section className="admin-placeholder">
        <span>暂无资料</span>
        <h2>没有可审核的Chunk</h2>
        <button type="button" onClick={onBack}>返回资料上传</button>
      </section>
    );
  }

  async function publish() {
    if (!confirmed || publishing) return;
    setPublishError("");
    setPublishing(true);
    try {
      await onPublish();
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : "发布失败，请重试。");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section className="review-workspace">
      <div className="review-toolbar">
        <div>
          <button type="button" className="text-button" onClick={onBack}>← 返回校验结果</button>
          <h2>{result.fileName}</h2>
          <p>{result.chunkCount}个Chunk · {result.warnings.length}个提醒 · 当前第{selected.number}条</p>
        </div>
        <span className={`review-status ${published ? "published" : ""}`}>
          {published ? "已发布到知识库" : "待人工审核"}
        </span>
      </div>

      {published && (
        <div className="publish-success" role="status">
          <strong>已发布，用户端可以检索这份资料。</strong>
          <span>当前保存在本地开发知识库。上线腾讯云时再迁移到正式数据库和对象存储。</span>
        </div>
      )}

      {/* 适用期间也要在审核界面显示一份（2026-09-16补）：原来只加在了「校验结果」那一屏，
          但管理员真正花时间的是这一屏，逐条看 chunk 时看不到"这份传的是已废止的旧法"。 */}
      {(result.documentEffectiveFrom || result.documentEffectiveTo || result.documentApplicabilityNote) && (
        <div className={`applicability-banner${result.documentEffectiveTo ? " expired" : ""}`}>
          <strong>
            适用期间：{result.documentEffectiveFrom ?? "不限起点"} 至 {result.documentEffectiveTo ?? "现行有效"}
          </strong>
          {result.documentApplicabilityNote && <span>{result.documentApplicabilityNote}</span>}
          {result.documentEffectiveTo && (
            <span>
              这是一部已废止/已过期的资料。发布后，只有问到这个期间的问题才会引用它；
              问当前有效规则时不会出现。请确认期间填对了再发布。
            </span>
          )}
        </div>
      )}

      <div className="review-layout">
        <aside className="chunk-list" aria-label="Chunk列表">
          <div className="chunk-list-title"><strong>Chunk列表</strong><span>{result.chunkCount}条</span></div>
          <div className="chunk-list-scroll">
            {result.chunks.map((chunk, index) => (
              <button
                key={`${chunk.number}-${chunk.minorTitle}`}
                type="button"
                className={selectedIndex === index ? "active" : ""}
                onClick={() => setSelectedIndex(index)}
              >
                <span>#{chunk.number}</span>
                <strong>{chunk.minorTitle || "未填写小标题"}</strong>
                {(chunk.warning || chunk.needsEffectiveDateConfirmation) && <i>需确认</i>}
              </button>
            ))}
          </div>
        </aside>

        <article className="chunk-review-card">
          <div className="chunk-review-head">
            <div><span>CHUNK {selected.number}</span><h3>{selected.minorTitle}</h3></div>
            <div className="chunk-pager">
              <button type="button" onClick={() => setSelectedIndex((value) => Math.max(0, value - 1))} disabled={selectedIndex === 0}>上一条</button>
              <button type="button" onClick={() => setSelectedIndex((value) => Math.min(result.chunks.length - 1, value + 1))} disabled={selectedIndex === result.chunks.length - 1}>下一条</button>
            </div>
          </div>

          {selected.warning && <p className="chunk-warning">{selected.warning}</p>}

          {/* 条文级生效确认提示：校验器早就算出来了（needsEffectiveDateConfirmation），
              但一直只在「校验结果」那屏的汇总里出现过，逐条审核时看不到是哪一条、
              因为哪句话被标记的。《知识库数据规范 V1.4》§3 要求逐条确认"不得跳过"，
              看不到就谈不上确认。 */}
          {selected.needsEffectiveDateConfirmation && (
            <p className="chunk-warning">
              这一条出现了生效措辞{selected.effectiveDateHints?.length ? `（${selected.effectiveDateHints[0]}）` : ""}，
              请确认它的条文级生效日。与整部法一致也要确认一次，不得跳过。
            </p>
          )}

          <dl className="chunk-meta">
            <div><dt>来源</dt><dd>{selected.source}</dd></div>
            <div><dt>大标题</dt><dd>{selected.majorTitle}</dd></div>
            {/* 适用期间：文件头部声明的，或这一条自己覆盖的。留空＝现行有效，不渲染这一行。 */}
            {(selected.provisionEffectiveFrom || selected.provisionEffectiveTo) && (
              <div>
                <dt>适用期间</dt>
                <dd>
                  {selected.provisionEffectiveFrom ?? "不限起点"} 至 {selected.provisionEffectiveTo ?? "现行有效"}
                  {selected.applicabilityNote && <small>{selected.applicabilityNote}</small>}
                </dd>
              </div>
            )}
            <div><dt>正文长度</dt><dd>{selected.wordCount.toLocaleString("zh-CN")}词 · {selected.bodyLength.toLocaleString("zh-CN")}字符</dd></div>
            <div><dt>官方链接</dt><dd><a href={selected.officialUrl} target="_blank" rel="noreferrer">打开官方链接 ↗</a><small>大陆网络无法访问印度链接</small></dd></div>
          </dl>

          <div className="official-body">
            <div><strong>官方英文原文</strong><span>仅管理员可见</span></div>
            <pre>{selected.body}</pre>
          </div>
        </article>
      </div>

      <div className="publish-panel">
        <label>
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={published} />
          <span>我已检查来源、标题、官方链接、正文和{result.warnings.length}个提醒。</span>
        </label>
        <button type="button" onClick={publish} disabled={!confirmed || published || publishing}>
          {published ? "已发布到知识库" : publishing ? "正在发布" : "确认通过并发布"}
        </button>
      </div>
      {publishError && <p className="admin-error" role="alert">{publishError}</p>}
    </section>
  );
}

function formatDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function TermsPanel({
  status,
  onUploaded,
}: {
  status: TermsStatus | null;
  onUploaded: () => Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<TermsUploadResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setResult(null);
    setUploading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        setResult({ ok: false, message: "请上传《中英文检索词典模板》.xlsx文件。" });
        return;
      }
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/admin/terms", { method: "POST", body: formData });
      const payload = await response.json() as {
        message?: string;
        errors?: string[];
        warnings?: string[];
        totalRows?: number;
        publishedCount?: number;
        termCount?: number;
      };
      if (!response.ok) {
        setResult({
          ok: false,
          message: payload.message || "同步失败，请重试。",
          errors: payload.errors,
          warnings: payload.warnings,
          totalRows: payload.totalRows,
          publishedCount: payload.publishedCount,
        });
        return;
      }
      setResult({
        ok: true,
        warnings: payload.warnings,
        totalRows: payload.totalRows,
        publishedCount: payload.publishedCount,
        termCount: payload.termCount,
      });
      await onUploaded();
    } catch {
      setResult({ ok: false, message: "上传失败，请检查网络后重试。" });
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  return (
    <>
      <section className="admin-stats" aria-label="检索词典状态">
        <article><small>已同步词条</small><strong>{status?.termCount ?? 0}</strong><span>{status?.synced ? "来自管理员上传的工作簿" : "尚未同步，暂用内置种子词典"}</span></article>
        <article><small>最近同步文件</small><strong>{status?.meta?.sourceFileName ?? "—"}</strong><span>{status?.meta ? formatDateTime(status.meta.syncedAt) : "从未同步"}</span></article>
        <article><small>最近一次工作簿</small><strong>{status?.meta ? `${status.meta.publishedCount}/${status.meta.totalRows}` : "—"}</strong><span>PUBLISHED词条数 / 总词条数</span></article>
      </section>

      <section className="upload-card">
        <div className="upload-copy">
          <span className="upload-index">01</span>
          <div><h2>上传《中英文检索词典模板》</h2><p>只读取&quot;词典主表&quot; sheet，只会同步 workflow_status=PUBLISHED 的词条；DRAFT / REVIEW_PENDING 不会进入检索。上传通过校验会立即替换现有词典，无需重启服务。</p></div>
        </div>
        <input ref={inputRef} hidden type="file" accept=".xlsx" onChange={handleFile} />
        <button type="button" className="upload-zone" onClick={() => inputRef.current?.click()} disabled={uploading}>
          <span className="upload-symbol">XLSX</span>
          <strong>{uploading ? "正在同步" : "选择词典文件"}</strong>
          <small>字段名和&quot;词典主表&quot; sheet 名不能修改</small>
        </button>
      </section>

      {result && (
        <section className="validation-result">
          <div className="validation-summary">
            <div>
              <span className={`validation-badge ${result.ok ? "ready" : "failed"}`}>{result.ok ? "同步成功" : "同步未完成"}</span>
              <h2>{result.ok ? "词典已更新" : (result.message || "校验未通过")}</h2>
              {(result.totalRows !== undefined) && (
                <p>{result.totalRows}条有效词条 · {result.publishedCount}条PUBLISHED{result.ok ? ` · 已导入${result.termCount}条` : ""}</p>
              )}
            </div>
          </div>
          {((result.errors?.length ?? 0) > 0 || (result.warnings?.length ?? 0) > 0) && (
            <div className="issue-grid">
              {(result.errors?.length ?? 0) > 0 && <div className="issue-card issue-error"><strong>阻断错误（本次未同步）</strong><ul>{result.errors!.map((error) => <li key={error}>{error}</li>)}</ul></div>}
              {(result.warnings?.length ?? 0) > 0 && <div className="issue-card issue-warning"><strong>需要留意</strong><ul>{result.warnings!.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
            </div>
          )}
        </section>
      )}

      {status && status.sample.length > 0 && (
        <section className="chunk-preview">
          <div className="admin-section-title"><div><span>GLOSSARY PREVIEW</span><h2>当前生效词典（前5条）</h2></div></div>
          <div className="admin-table-wrap">
            <table>
              <thead><tr><th>中文</th><th>英文</th><th>领域</th></tr></thead>
              <tbody>{status.sample.map((term) => (
                <tr key={term.term_zh}>
                  <td><strong>{term.term_zh}</strong></td>
                  <td>{term.official_term_en}</td>
                  <td>{term.domain.join("、") || "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

interface OverviewSection {
  title: string;
  chunkCount: number;
  sampleSubsections: string[];
  subsectionCount: number;
}

interface OverviewDocument {
  id: string;
  fileName: string;
  status: "TO_REVIEW" | "PUBLISHED" | "WITHDRAWN";
  createdAt: string;
  publishedAt?: string;
  withdrawnAt?: string;
  chunkCount: number;
  warningCount: number;
  sources: string[];
  sections: OverviewSection[];
  category: string;
  /** 法律位阶。没人工确认过时是系统按资料名推断的值。 */
  hierarchyLevel: "ACT" | "RULES" | "NOTIFICATION" | "CIRCULAR" | "UNKNOWN";
  /** false = 还没人过目，界面上要标出来。 */
  hierarchyConfirmed: boolean;
}

interface VectorCoverage {
  vectorizedChunks: number;
  documents: number;
  models: string[];
  dimension: number;
  configured: boolean;
}

interface AbbreviationRow {
  key: string;
  en: string;
  zh?: string;
  group: string;
}

interface OverviewPayload extends KnowledgeStats {
  documentCount?: number;
  documents: OverviewDocument[];
  /** 构建版本，由 /api/admin/knowledge?view=overview 下发。见 scripts/write-build-info.mjs。 */
  build?: { buildTime: string; sourceHash: string; fileCount: number };
  vectors?: VectorCoverage;
  abbreviations?: AbbreviationRow[];
}

/** 总览：按「资料 → 章 → 节」把整个知识库的结构摊开给管理员看。 */
function OverviewPanel({
  onGoUpload,
  onResumeReview,
}: {
  onGoUpload: () => void;
  /** 待审核的资料点「继续审核」时，把它加载进审核界面。 */
  onResumeReview: (documentId: string) => void;
}) {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string>("");
  const [indexing, setIndexing] = useState(false);
  const [indexMessage, setIndexMessage] = useState("");
  const [pendingWithdrawId, setPendingWithdrawId] = useState<string>("");
  const [actionBusyId, setActionBusyId] = useState<string>("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/admin/knowledge?view=overview", { cache: "no-store" });
        const payload = await response.json() as OverviewPayload;
        if (!response.ok) throw new Error("读取知识库结构失败。");
        if (!cancelled) setData(payload);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "读取知识库结构失败。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <section className="admin-placeholder"><span>读取中</span><h2>总览</h2><p>正在统计知识库结构…</p></section>;
  }
  if (error) {
    return <section className="admin-placeholder"><span>出错了</span><h2>总览</h2><p>{error}</p></section>;
  }
  if (!data || data.documents.length === 0) {
    return (
      <section className="admin-placeholder">
        <span>还没有资料</span><h2>总览</h2>
        <p>知识库里还没有任何资料。上传并发布第一份TXT之后，这里会显示完整结构。</p>
        <button type="button" onClick={onGoUpload}>先上传知识库资料</button>
      </section>
    );
  }

  const published = data.documents.filter((document) => document.status === "PUBLISHED");
  const toReview = data.documents.filter((document) => document.status === "TO_REVIEW");
  const withdrawn = data.documents.filter((document) => document.status === "WITHDRAWN");
  const totalSections = data.documents.reduce((total, document) => total + document.sections.length, 0);

  // 按法律类别分组，只保留题下真的当有资料的分类——避免每次都显示一整排空标题。
  // 顺序固定用 DOCUMENT_CATEGORIES 里的先后，不随上传顺序变，方便管理员每次扫一眼
  // 都在同一个位置找同一类资料（GST总在GST底下，不会因为最近上传了什么就挪位置）。
  const groupedDocuments = DOCUMENT_CATEGORIES
    .map((category) => ({
      ...category,
      documents: data.documents.filter((document) => (document.category || "other") === category.id),
    }))
    .filter((group) => group.documents.length > 0);
  const vectors = data.vectors;
  const vectorGap = vectors ? data.publishedChunkCount - vectors.vectorizedChunks : 0;

  async function refreshOverview() {
    const refreshed = await fetch("/api/admin/knowledge?view=overview", { cache: "no-store" });
    if (refreshed.ok) setData(await refreshed.json() as OverviewPayload);
  }

  /** 下架/恢复共用：下架前台走二次确认（先点"下架"再点"确认下架"），恢复不需要二次确认——它是可逆动作。 */
  /**
   * 法律位阶的可选项。顺序按位阶从高到低，和 `legal-hierarchy.ts` 的 HIERARCHY_RANK 一致。
   * 这里写死一份副本而不是从服务端拿：它是个固定的枚举，不会动态变，
   * 为它多一次请求不值得；真要改，两处一起改（服务端那边有白名单校验兜底）。
   */
  const HIERARCHY_OPTIONS = [
    { value: "ACT", label: "法律 Act" },
    { value: "RULES", label: "规则 Rules / Regulations" },
    { value: "NOTIFICATION", label: "通知 Notification" },
    { value: "CIRCULAR", label: "通函 Circular" },
    { value: "UNKNOWN", label: "未确定" },
  ] as const;

  /**
   * 保存位阶。保存成功后刷新总览——`hierarchyConfirmed` 会从 false 变 true，
   * 界面上那个"未确认"标记随之消失，管理员能看出自己改过哪些。
   */
  async function saveHierarchy(documentId: string, hierarchyLevel: string) {
    setActionBusyId(documentId);
    setActionMessage((current) => ({ ...current, [documentId]: "" }));
    try {
      const response = await fetch("/api/admin/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setHierarchy", documentId, hierarchyLevel }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "位阶保存失败，请重试。");
      await refreshOverview();
    } catch (caught) {
      setActionMessage((current) => ({
        ...current,
        [documentId]: caught instanceof Error ? caught.message : "位阶保存失败，请重试。",
      }));
    } finally {
      setActionBusyId("");
    }
  }

  /**
   * 按类别批量确认位阶。
   *
   * 为什么需要：58 份资料里绝大多数推断是对的，一份份点"确认"太折磨人，
   * 而折磨人的流程的真实结局是**没人去点**，位阶字段就永远停在"未确认"——
   * 和 `legalCurrencyCheckedAt` 那个字段的下场一样。
   *
   * 这么做会不会削弱"人工确认"的意义？不会，前提是**你先把这一类扫一眼**：
   * 界面上同一类别的资料是并排列出来的，28 份公司法规则是不是都该归"规则"，
   * 一眼就能看出来。真有不对的先单独改掉，再批量确认剩下的。
   * 按类别而不是"全部确认"，就是为了让这一眼扫得过来。
   */
  async function confirmCategory(documentIds: string[]) {
    if (documentIds.length === 0) return;
    setBulkBusy(true);
    try {
      // 串行而不是并发：后端的写入走 serializedMutation 队列，
      // 并发发过去只会在队列里排队，还可能让某几个请求超时。
      for (const documentId of documentIds) {
        const document = data.documents.find((item) => item.id === documentId);
        if (!document) continue;
        await fetch("/api/admin/knowledge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "setHierarchy",
            documentId,
            hierarchyLevel: document.hierarchyLevel,
          }),
        });
      }
      await refreshOverview();
    } finally {
      setBulkBusy(false);
    }
  }

  async function runDocumentAction(documentId: string, action: "withdraw" | "restore") {
    setActionBusyId(documentId);
    setActionMessage((current) => ({ ...current, [documentId]: "" }));
    try {
      const response = await fetch("/api/admin/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, documentId }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) {
        throw new Error(payload.message || (action === "withdraw" ? "下架失败，请重试。" : "恢复失败，请重试。"));
      }
      setPendingWithdrawId("");
      await refreshOverview();
    } catch (caught) {
      setActionMessage((current) => ({
        ...current,
        [documentId]: caught instanceof Error ? caught.message : "操作失败，请重试。",
      }));
    } finally {
      setActionBusyId("");
    }
  }

  async function reindex(force: boolean) {
    setIndexing(true);
    setIndexMessage("");
    try {
      const response = await fetch("/api/admin/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reindex", force }),
      });
      const payload = await response.json() as {
        vectorizedChunks?: number; skippedExisting?: number; failedChunks?: number; message?: string;
      };
      if (!response.ok) throw new Error(payload.message || "生成向量失败。");
      setIndexMessage(
        `完成：新生成 ${payload.vectorizedChunks ?? 0} 条`
        + `，跳过已有 ${payload.skippedExisting ?? 0} 条`
        + `${payload.failedChunks ? `，失败 ${payload.failedChunks} 条` : ""}。`,
      );
      await refreshOverview();
    } catch (caught) {
      setIndexMessage(caught instanceof Error ? caught.message : "生成向量失败。");
    } finally {
      setIndexing(false);
    }
  }

  return (
    <>
      <section className="admin-stats" aria-label="知识库总览">
        <article><small>资料总数</small><strong>{data.documents.length}</strong><span>{published.length} 份已发布 · {toReview.length} 份待审核 · {withdrawn.length} 份已下架</span></article>
        <article><small>已发布Chunk</small><strong>{data.publishedChunkCount}</strong><span>进入问答检索范围</span></article>
        <article><small>章节数</small><strong>{totalSections}</strong><span>按一级标题统计</span></article>
        {/* 当前运行的版本。放在总览的统计卡片里——每次进后台都会看到，
            不用特地去找。sourceHash 是源码指纹：**只重新构建、没换代码时它不会变**，
            所以"改了但没生效"这种情况一眼能看出来。判读方法见 scripts/write-build-info.mjs。 */}
        <article>
          <small>当前版本</small>
          <strong className="build-hash">{data.build?.sourceHash ?? "未知"}</strong>
          <span>{data.build?.buildTime ? `构建于 ${formatDateTime(data.build.buildTime)}` : "构建信息不可用"}</span>
        </article>
        <article><small>已向量化</small><strong>{vectors?.vectorizedChunks ?? 0}</strong><span>{vectors?.configured ? (vectorGap > 0 ? `还差 ${vectorGap} 条未生成` : "已全部覆盖") : "未配置向量服务"}</span></article>
      </section>

      <section className="vector-bar">
        <div>
          <strong>混合检索</strong>
          <small>
            {vectors?.configured
              ? vectorGap > 0
                ? `有 ${vectorGap} 条已发布Chunk还没有向量，这部分目前只能被关键词检索到。`
                : "全部已发布Chunk都有向量，关键词与向量两路都在生效。"
              : "尚未配置 EMBEDDING_API_KEY，当前只走关键词检索。"}
          </small>
        </div>
        <div className="vector-bar-actions">
          {indexMessage && <span className="vector-message">{indexMessage}</span>}
          <button type="button" onClick={() => reindex(false)} disabled={indexing || !vectors?.configured}>
            {indexing ? "生成中…" : "补算缺失向量"}
          </button>
          <button type="button" className="ghost" onClick={() => reindex(true)} disabled={indexing || !vectors?.configured}>
            全部重算
          </button>
        </div>
      </section>

      <section className="overview-list">
        <div className="admin-section-title">
          <div><span>KNOWLEDGE STRUCTURE</span><h2>知识库结构</h2></div>
          <small>点资料名展开章节</small>
        </div>

        {groupedDocuments.map((group) => (
          <div key={group.id} className="overview-category">
            <h3 className="overview-category-title">
              {group.label}
              <span className="overview-category-count">{group.documents.length} 份</span>
              {/* 按类别批量确认：同一类别的资料并排列着，位阶对不对一眼扫得过来。
                  只在这一类还有未确认的时候出现，全确认完就消失，不留无用按钮。 */}
              {group.documents.some((document) => !document.hierarchyConfirmed) && (
                <button
                  type="button"
                  className="ghost overview-category-confirm"
                  disabled={bulkBusy}
                  onClick={() => confirmCategory(
                    group.documents.filter((d) => !d.hierarchyConfirmed).map((d) => d.id),
                  )}
                >
                  {bulkBusy ? "确认中…" : `确认本类别位阶（${group.documents.filter((d) => !d.hierarchyConfirmed).length} 份）`}
                </button>
              )}
            </h3>
            {group.documents.map((document) => (
          <article key={document.id} className="overview-doc">
            <div className="overview-doc-row">
              <button
                type="button"
                className="overview-doc-head"
                aria-expanded={expanded === document.id}
                onClick={() => setExpanded((current) => (current === document.id ? "" : document.id))}
              >
                <span className={`overview-status ${
                  document.status === "PUBLISHED" ? "is-published"
                    : document.status === "WITHDRAWN" ? "is-withdrawn" : "is-review"
                }`}>
                  {document.status === "PUBLISHED" ? "已发布" : document.status === "WITHDRAWN" ? "已下架" : "待审核"}
                </span>
                <span className="overview-doc-name">
                  <strong>{document.fileName}</strong>
                  <small>
                    {document.chunkCount} 个Chunk · {document.sections.length} 章
                    {document.warningCount > 0 ? ` · ${document.warningCount} 个提醒` : ""}
                    {document.publishedAt ? ` · 发布于 ${formatDateTime(document.publishedAt)}` : ""}
                    {document.withdrawnAt ? ` · 下架于 ${formatDateTime(document.withdrawnAt)}` : ""}
                  </small>
                </span>
                <span className="overview-toggle" aria-hidden="true">{expanded === document.id ? "收起" : "展开"}</span>
              </button>

              {/* 法律位阶。放在展开按钮外面、和下架按钮同一行——它是**每份资料都要核**的，
                  藏进展开区里等于没人会去改。
                  onClick stopPropagation：这一块在 overview-doc-row 里，
                  不拦住冒泡的话点下拉会把整份资料展开/收起。 */}
              <div className="overview-hierarchy">
                <label htmlFor={`hier-${document.id}`}>位阶</label>
                <select
                  id={`hier-${document.id}`}
                  value={document.hierarchyLevel}
                  disabled={actionBusyId === document.id}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => saveHierarchy(document.id, event.target.value)}
                >
                  {HIERARCHY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {!document.hierarchyConfirmed && (
                  <>
                    {/* 「确认」必须是一个**独立按钮**，不能靠下拉的 onChange。
                        onChange 只在值真的变了才触发——推断值已经是"规则"时，
                        再选一次"规则"浏览器不认为是改动，什么都不会发生。
                        实测就是这么卡住的：选了没反应，状态永远停在未确认。
                        「确认推断值」和「改成别的」是两个不同的动作，要各有各的入口。 */}
                    <button
                      type="button"
                      className="ghost overview-hierarchy-confirm"
                      disabled={actionBusyId === document.id || bulkBusy}
                      onClick={() => saveHierarchy(document.id, document.hierarchyLevel)}
                    >
                      确认
                    </button>
                    <span className="overview-hierarchy-unconfirmed" title="系统按资料名推断，还没有人工确认">
                      未确认
                    </span>
                  </>
                )}
              </div>

              {document.status === "PUBLISHED" && (
                <div className="overview-doc-actions">
                  {pendingWithdrawId === document.id ? (
                    <>
                      <button
                        type="button"
                        className="danger"
                        disabled={actionBusyId === document.id}
                        onClick={() => runDocumentAction(document.id, "withdraw")}
                      >
                        {actionBusyId === document.id ? "下架中…" : "确认下架"}
                      </button>
                      <button type="button" className="ghost" onClick={() => setPendingWithdrawId("")}>取消</button>
                    </>
                  ) : (
                    <button type="button" className="ghost" onClick={() => setPendingWithdrawId(document.id)}>下架</button>
                  )}
                </div>
              )}

              {/* 待审核的资料原来没有任何操作按钮，而「审核与发布」那一屏只认刚上传完的
                  页面状态，刷新就回不去——这份资料会永远卡住：审核不了、发布不了、也删不掉
                  （2026-09-16 用户实际撞上）。这里补两个出口。 */}
              {document.status === "TO_REVIEW" && (
                <div className="overview-doc-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={actionBusyId === document.id}
                    onClick={() => onResumeReview(document.id)}
                  >
                    继续审核
                  </button>
                  {pendingWithdrawId === document.id ? (
                    <>
                      <button
                        type="button"
                        className="danger"
                        disabled={actionBusyId === document.id}
                        onClick={() => runDocumentAction(document.id, "withdraw")}
                      >
                        {actionBusyId === document.id ? "丢弃中…" : "确认丢弃"}
                      </button>
                      <button type="button" className="ghost" onClick={() => setPendingWithdrawId("")}>取消</button>
                    </>
                  ) : (
                    <button type="button" className="ghost" onClick={() => setPendingWithdrawId(document.id)}>丢弃</button>
                  )}
                </div>
              )}

              {document.status === "WITHDRAWN" && (
                <div className="overview-doc-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={actionBusyId === document.id}
                    onClick={() => runDocumentAction(document.id, "restore")}
                  >
                    {actionBusyId === document.id ? "恢复中…" : "恢复发布"}
                  </button>
                </div>
              )}
            </div>
            {actionMessage[document.id] && <p className="overview-doc-message">{actionMessage[document.id]}</p>}

            {expanded === document.id && (
              <div className="overview-doc-body">
                {document.sources.length > 0 && (
                  <p className="overview-sources"><strong>来源标识：</strong>{document.sources.join("；")}</p>
                )}
                <table className="overview-table">
                  <thead><tr><th scope="col">一级标题（章）</th><th scope="col">Chunk数</th><th scope="col">二级标题（节）</th></tr></thead>
                  <tbody>
                    {document.sections.map((section) => (
                      <tr key={section.title}>
                        <td>{section.title}</td>
                        <td>{section.chunkCount}</td>
                        <td>
                          {section.sampleSubsections.length > 0 ? (
                            <>
                              {section.sampleSubsections.join("；")}
                              {section.subsectionCount > section.sampleSubsections.length
                                ? ` …等 ${section.subsectionCount} 节`
                                : ""}
                            </>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
            ))}
          </div>
        ))}
      </section>

      {data.abbreviations && data.abbreviations.length > 0 && (
        <section className="overview-list">
          <div className="admin-section-title">
            <div><span>ABBREVIATIONS</span><h2>缩写自动补全称</h2></div>
            <small>共 {data.abbreviations.length} 条 · 回答中首次出现时自动展开</small>
          </div>
          <div className="overview-doc">
            <div className="overview-doc-body" style={{ borderTop: 0, paddingTop: 16 }}>
              <p className="overview-sources">
                回答里出现这些缩写时，系统会在<strong>最先出现的位置</strong>自动补上英文全称和中文释义，
                例如「ROC」会显示成「ROC（Registrar of Companies，公司注册处）」，后面再出现就不重复展开。
                这份表目前在代码里维护（lib/server/abbreviations.ts），需要增删或改译法时告诉我，改完重新部署即可生效。
              </p>
              <table className="overview-table">
                <thead><tr><th scope="col">分类</th><th scope="col">缩写</th><th scope="col">英文全称</th><th scope="col">中文释义</th></tr></thead>
                <tbody>
                  {data.abbreviations.map((row) => (
                    <tr key={row.key}>
                      <td>{row.group}</td>
                      <td><strong>{row.key}</strong></td>
                      <td>{row.en}</td>
                      <td>{row.zh ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

interface CaseRecord {
  id: string;
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
  status: "TO_REVIEW" | "PUBLISHED" | "WITHDRAWN";
  createdAt: string;
  publishedAt?: string;
  withdrawnAt?: string;
  sourceFileName: string;
}

/**
 * 税务案例库：上传 `scripts/case-extract.mjs` 产出的结构化草稿md，
 * 校验通过就暂存为待审核，管理员看过九个字段没问题再点发布。
 * 和知识库TXT上传的思路一致，但案例是单条记录，不需要chunk预览那一套。
 */
function CasesPanel() {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string>("");
  const [uploadError, setUploadError] = useState("");
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string>("");
  const [pendingWithdrawId, setPendingWithdrawId] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const response = await fetch("/api/admin/cases", { cache: "no-store" });
      const payload = await response.json() as { cases?: CaseRecord[] };
      setCases(payload.cases ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError("");
    setUploadMessage("");
    setUploading(true);
    try {
      const lowerName = file.name.toLowerCase();
      if (!(lowerName.endsWith(".md") || lowerName.endsWith(".txt"))) {
        throw new Error("这里只接收案例结构化模板的 .md 或 .txt 文件（案例内容按九字段模板格式，扩展名不影响解析）。");
      }
      const text = await file.text();
      const preview = validateCaseText(file.name, text);
      if (preview.status !== "READY_TO_REVIEW") {
        setUploadError(`校验没通过：${preview.errors.join("；")}`);
        return;
      }
      const response = await fetch("/api/admin/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stage", fileName: file.name, text }),
      });
      const payload = await response.json() as { id?: string; caseName?: string; duplicate?: boolean; message?: string };
      if (!response.ok || !payload.id) throw new Error(payload.message || "保存失败，请重试。");
      setUploadMessage(
        payload.duplicate
          ? `《${payload.caseName}》这个docid已经在库里了，复用了已有记录，没有造出重复数据。`
          : `《${payload.caseName}》已存入待审核列表，展开核对九个字段没问题后再点发布。`,
      );
      if (preview.warnings.length > 0) {
        setUploadMessage((current) => `${current}\n提醒：${preview.warnings.join("；")}`);
      }
      await refresh();
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "文件读取失败，请重新上传。");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  async function runAction(id: string, action: "publish" | "withdraw") {
    setActionBusyId(id);
    try {
      const response = await fetch("/api/admin/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message || "操作失败，请重试。");
      setPendingWithdrawId("");
      await refresh();
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "操作失败，请重试。");
    } finally {
      setActionBusyId("");
    }
  }

  const toReview = cases.filter((item) => item.status === "TO_REVIEW");
  const published = cases.filter((item) => item.status === "PUBLISHED");
  const withdrawn = cases.filter((item) => item.status === "WITHDRAWN");

  if (loading) {
    return <section className="admin-placeholder"><span>读取中</span><h2>税务案例库</h2><p>正在读取案例列表…</p></section>;
  }

  return (
    <>
      <section className="admin-stats" aria-label="案例库状态">
        <article><small>案例总数</small><strong>{cases.length}</strong><span>{published.length} 已发布 · {toReview.length} 待审核 · {withdrawn.length} 已下架</span></article>
        <article><small>已发布</small><strong>{published.length}</strong><span>进入问答检索范围</span></article>
        <article><small>待审核</small><strong>{toReview.length}</strong><span>需要人工看过九个字段再发布</span></article>
      </section>

      <section className="upload-card">
        <div className="upload-copy">
          <span className="upload-index">01</span>
          <div>
            <h2>上传案例结构化草稿</h2>
            <p>用 <code>scripts/case-extract.mjs</code> 生成的md文件，或者手改过、字段格式没变的同类文件。同一个 IndianKanoon 文档ID重复上传会自动复用已有记录。</p>
          </div>
        </div>
        <input ref={inputRef} hidden type="file" accept=".md,.txt,text/markdown,text/plain" onChange={handleFile} />
        <button type="button" className="upload-zone" onClick={() => inputRef.current?.click()} disabled={uploading}>
          <span className="upload-symbol">MD/TXT</span>
          <strong>{uploading ? "正在处理" : "选择案例草稿md或txt文件"}</strong>
          <small>九个字段缺任何一个必填项都会被退回</small>
        </button>
        {uploadError && <p className="admin-error" role="alert">{uploadError}</p>}
        {uploadMessage && <p className="overview-doc-message" style={{ color: "#227159", whiteSpace: "pre-line" }}>{uploadMessage}</p>}
      </section>

      <section className="overview-list">
        <div className="admin-section-title">
          <div><span>TAX CASE LIBRARY</span><h2>案例列表</h2></div>
          <small>点案例名展开九个字段</small>
        </div>

        {cases.length === 0 && <p className="overview-doc-message">还没有任何案例，先上传一份草稿md。</p>}

        {cases.map((item) => (
          <article key={item.id} className="overview-doc">
            <div className="overview-doc-row">
              <button
                type="button"
                className="overview-doc-head"
                aria-expanded={expanded === item.id}
                onClick={() => setExpanded((current) => (current === item.id ? "" : item.id))}
              >
                <span className={`overview-status ${
                  item.status === "PUBLISHED" ? "is-published"
                    : item.status === "WITHDRAWN" ? "is-withdrawn" : "is-review"
                }`}>
                  {item.status === "PUBLISHED" ? "已发布" : item.status === "WITHDRAWN" ? "已下架" : "待审核"}
                </span>
                <span className="overview-doc-name">
                  <strong>{item.caseName}</strong>
                  <small>
                    {item.courtAndYear} · docid {item.docid}
                    {item.publishedAt ? ` · 发布于 ${formatDateTime(item.publishedAt)}` : ""}
                    {item.withdrawnAt ? ` · 下架于 ${formatDateTime(item.withdrawnAt)}` : ""}
                  </small>
                </span>
                <span className="overview-toggle" aria-hidden="true">{expanded === item.id ? "收起" : "展开"}</span>
              </button>

              <div className="overview-doc-actions">
                {item.status === "TO_REVIEW" && (
                  <button type="button" disabled={actionBusyId === item.id} onClick={() => runAction(item.id, "publish")}>
                    {actionBusyId === item.id ? "发布中…" : "确认发布"}
                  </button>
                )}
                {item.status === "PUBLISHED" && (
                  pendingWithdrawId === item.id ? (
                    <>
                      <button type="button" className="danger" disabled={actionBusyId === item.id} onClick={() => runAction(item.id, "withdraw")}>
                        {actionBusyId === item.id ? "下架中…" : "确认下架"}
                      </button>
                      <button type="button" className="ghost" onClick={() => setPendingWithdrawId("")}>取消</button>
                    </>
                  ) : (
                    <button type="button" className="ghost" onClick={() => setPendingWithdrawId(item.id)}>下架</button>
                  )
                )}
                {item.status === "WITHDRAWN" && (
                  <button type="button" className="ghost" disabled={actionBusyId === item.id} onClick={() => runAction(item.id, "publish")}>
                    {actionBusyId === item.id ? "恢复中…" : "恢复发布"}
                  </button>
                )}
              </div>
            </div>

            {expanded === item.id && (
              <div className="overview-doc-body">
                <p className="overview-sources"><strong>争议税种以及主管税局：</strong>{item.taxTypeAndAuthority}</p>
                <p className="overview-sources"><strong>印度数据库链接：</strong><a href={item.officialUrl} target="_blank" rel="noreferrer">{item.officialUrl}</a></p>
                <table className="case-field-table">
                  <tbody>
                    <tr><td>税局主张</td><td><ul>{item.revenuePosition.map((point, index) => <li key={index}>{point}</li>)}</ul></td></tr>
                    <tr><td>企业抗辩方向</td><td><ul>{item.assesseeArgument.map((point, index) => <li key={index}>{point}</li>)}</ul></td></tr>
                    <tr><td>最终裁定结果</td><td><ul>{item.finalRuling.map((point, index) => <li key={index}>{point}</li>)}</ul></td></tr>
                    <tr><td>证据支撑要点</td><td><ul>{item.evidenceSupport.map((point, index) => <li key={index}>{point}</li>)}</ul></td></tr>
                    <tr><td>参考价值</td><td>{item.referenceValueNote}</td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </article>
        ))}
      </section>
    </>
  );
}

interface AdminMembershipRow {
  userId: string;
  email: string;
  plan: string;
  active: boolean;
  paidThrough: string;
  daysLeft: number;
  updatedAt: string;
}

interface AdminOrderRow {
  outTradeNo: string;
  email: string;
  channel: "WECHAT" | "ALIPAY";
  months: number;
  amountYuan: string;
  status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
  createdAt: string;
  paidAt: string | null;
  transactionId: string | null;
  failReason: string | null;
}

interface AdminMembershipPayload {
  memberships: AdminMembershipRow[];
  orders: AdminOrderRow[];
  stats: { activeMemberCount: number; paidOrderCount: number; pendingOrderCount: number; totalRevenueYuan: string };
}

interface AdminQuestionAuditRow {
  id: string;
  requestId: string;
  conversationId: string;
  user: string;
  askedAt: string;
  displayQuestion: string;
  selfContainedQuestion: string;
  status: "SUFFICIENT" | "NEED_INFORMATION" | "UNABLE_TO_CONFIRM" | "PROCESSING" | "QUOTA_EXHAUSTED";
  failureCode?: string;
  shortConclusion?: string;
  deliveryStatus?: "DELIVERED" | "BLOCKED_BY_QUOTA";
  chargeEligible?: boolean;
  usedFollowUpCredit?: boolean;
  topicRelation?: string;
  rewriteLog?: { input: string; output: string; usedFallback: boolean; durationMs: number };
  incomeTaxTime?: { targetDate?: string; source?: string };
  citationCount: number;
  citations: Array<{ title: string; locator: string; authority: string; officialUrl: string }>;
  completedAt?: string;
}

interface AdminQuestionAuditPayload {
  questions: AdminQuestionAuditRow[];
  stats: {
    total: number;
    processing: number;
    sufficient: number;
    needInformation: number;
    unableToConfirm: number;
    quotaExhausted: number;
  };
}

interface QuestionAnswerViewEvent {
  id: string;
  adminUsername: string;
  viewedAt: string;
  outcome: "VIEWED" | "UNAVAILABLE";
}

interface AdminFullAnswerPayload {
  answer: AnswerResponse;
  viewedAt: string;
  viewEvents: QuestionAnswerViewEvent[];
}

const ORDER_STATUS_TEXT: Record<AdminOrderRow["status"], string> = {
  PENDING: "待支付",
  PAID: "已支付",
  FAILED: "失败",
  EXPIRED: "已过期",
};

const QUESTION_STATUS_TEXT: Record<AdminQuestionAuditRow["status"], string> = {
  SUFFICIENT: "已回答",
  NEED_INFORMATION: "待补充",
  UNABLE_TO_CONFIRM: "暂不能确认",
  PROCESSING: "处理中",
  QUOTA_EXHAUSTED: "额度已尽",
};

const INCOME_TIME_SOURCE_TEXT: Record<string, string> = {
  TRANSACTION_DATE: "具体交易日期",
  FINANCIAL_YEAR: "财年 FY",
  ASSESSMENT_YEAR: "评估年度 AY",
  CURRENT: "当前期间",
};

/** 完整回答只在管理员主动点开后渲染；原始数据折叠在最后，便于逐字段复核。 */
function FullAnswerPanel({ data }: { data: AdminFullAnswerPayload }) {
  const { answer } = data;
  // 旧版历史回答可能少了后来新增的字段；后台查看不能因为一条旧记录白屏。
  const actionSteps = answer.action_steps ?? [];
  const keyFigures = answer.key_figures ?? [];
  const assumptions = answer.assumptions ?? [];
  const risks = answer.risks_and_exceptions ?? [];
  const missingInformation = answer.missing_information ?? [];
  const citations = answer.citations ?? [];
  const mandatory = actionSteps.filter((step) => step.kind === "MANDATORY");
  const practical = actionSteps.filter((step) => step.kind === "PRACTICAL");
  return (
    <div className="question-full-answer-content">
      <div className="question-full-answer-head">
        <div><span>FULL ANSWER</span><h3>完整回答</h3></div>
        <small>本次查看：{formatDateTime(data.viewedAt)}</small>
      </div>
      {answer.evidence_gap && <div className="question-analysis-block"><span>证据覆盖提示</span><p>{answer.evidence_gap}</p></div>}
      <div className="question-analysis-block"><span>结论</span><p>{answer.short_conclusion || "—"}</p></div>
      {keyFigures.length > 0 && <div className="question-full-answer-section"><h4>关键数值</h4><ul>{keyFigures.map((item) => <li key={`${item.label}-${item.value}`}><strong>{item.value}</strong> · {item.label}{item.note ? `（${item.note}）` : ""}</li>)}</ul></div>}
      {assumptions.length > 0 && <div className="question-full-answer-section"><h4>适用前提</h4><ul>{assumptions.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {mandatory.length > 0 && <div className="question-full-answer-section"><h4>法规要求</h4><ol>{mandatory.map((step, index) => <li key={`${step.text}-${index}`}><p>{step.text}</p><small>依据：{step.citation_refs.length ? step.citation_refs.map((ref) => `#${ref}`).join("、") : "未标注具体依据"}</small>{step.unverified_claims.length > 0 && <em>未核验主张：{step.unverified_claims.join("、")}</em>}</li>)}</ol></div>}
      {practical.length > 0 && <div className="question-full-answer-section"><h4>实务建议</h4><ol>{practical.map((step, index) => <li key={`${step.text}-${index}`}><p>{step.text}</p><small>依据：{step.citation_refs.length ? step.citation_refs.map((ref) => `#${ref}`).join("、") : "未标注具体依据"}</small></li>)}</ol></div>}
      {risks.length > 0 && <div className="question-full-answer-section"><h4>风险与例外</h4><ul>{risks.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {missingInformation.length > 0 && <div className="question-full-answer-section"><h4>仍需补充</h4><ul>{missingInformation.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {answer.related_cases && answer.related_cases.length > 0 && <div className="question-full-answer-section"><h4>相关判例</h4><ul>{answer.related_cases.map((item) => <li key={item.docid}><a href={item.official_url} target="_blank" rel="noreferrer">{item.caseName}</a>{item.court_and_year ? ` · ${item.court_and_year}` : ""}</li>)}</ul></div>}
      <div className="question-full-answer-section"><h4>引用来源</h4>{citations.length === 0 ? <p>本次未使用法律引用。</p> : <ul>{citations.map((citation, index) => <li key={`${citation.display_title}-${citation.locator}-${index}`}><a href={citation.official_url} target="_blank" rel="noreferrer">#{index + 1} {citation.display_title} · {citation.locator}</a><small>{citation.authority}</small>{citation.snippet && <blockquote>{citation.snippet}</blockquote>}</li>)}</ul>}</div>
      <details className="question-full-answer-raw">
        <summary>展开完整原始回答数据</summary>
        <pre>{JSON.stringify(answer, null, 2)}</pre>
      </details>
      <div className="question-view-log"><span>查看日志</span>{data.viewEvents.length === 0 ? <p>暂无记录。</p> : <ul>{data.viewEvents.map((event) => <li key={event.id}>{event.adminUsername} · {formatDateTime(event.viewedAt)} · {event.outcome === "VIEWED" ? "已查看" : "内容不可用"}</li>)}</ul>}</div>
    </div>
  );
}

/**
 * 后台问答运营台：默认只呈现排障需要的信息。完整回答必须由管理员主动点开，
 * 附件原文始终不在这里展示。
 */
function QuestionsPanel() {
  const [data, setData] = useState<AdminQuestionAuditPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [fullAnswer, setFullAnswer] = useState<AdminFullAnswerPayload | null>(null);
  const [fullAnswerBusy, setFullAnswerBusy] = useState(false);
  const [fullAnswerError, setFullAnswerError] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/questions?limit=200", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as AdminQuestionAuditPayload & { message?: string };
        if (!response.ok) throw new Error(payload.message || "读取问答运营记录失败。");
        if (alive) {
          setData(payload);
          setSelectedRequestId((current) => current || payload.questions[0]?.requestId || "");
        }
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : "读取问答运营记录失败。");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <section className="admin-placeholder"><span>LOADING</span><h2>正在读取问答记录</h2><p>只加载排障需要的状态和分析元数据。</p></section>;
  if (error) return <section className="admin-placeholder"><span>ERROR</span><h2>读取失败</h2><p>{error}</p></section>;
  if (!data) return null;
  const selected = data.questions.find((item) => item.requestId === selectedRequestId) ?? data.questions[0];

  async function showFullAnswer() {
    if (!selected || fullAnswerBusy) return;
    setFullAnswerBusy(true);
    setFullAnswerError("");
    try {
      const response = await fetch(`/api/admin/questions/${encodeURIComponent(selected.requestId)}/answer`, { cache: "no-store" });
      const payload = await response.json() as AdminFullAnswerPayload & { message?: string };
      if (!response.ok) throw new Error(payload.message || "无法读取完整回答。");
      setFullAnswer(payload);
    } catch (caught) {
      setFullAnswerError(caught instanceof Error ? caught.message : "无法读取完整回答。");
    } finally {
      setFullAnswerBusy(false);
    }
  }

  return (
    <>
      <section className="admin-stats" aria-label="问答状态概览">
        <article><small>最近记录</small><strong>{data.stats.total}</strong><span>保留 90 天，最多 10,000 条</span></article>
        <article><small>已回答</small><strong>{data.stats.sufficient}</strong><span>证据链已完成</span></article>
        <article><small>待补充</small><strong>{data.stats.needInformation}</strong><span>不会扣除提问次数</span></article>
        <article><small>异常 / 拦截</small><strong>{data.stats.unableToConfirm + data.stats.quotaExhausted}</strong><span>暂不能确认或额度已尽</span></article>
      </section>

      <section className="questions-intro">
        <div><span>QUESTION OPERATIONS</span><h2>用户问了什么，系统怎么处理</h2><p>列表默认展示脱敏用户和状态；点开一条可查看改写、适用期间、引用和处理结果。不会展示上传文件原文。</p></div>
        <small>{data.stats.processing > 0 ? `${data.stats.processing} 条仍在处理中` : "当前没有处理中请求"}</small>
      </section>

      <div className="questions-layout">
        <div className="questions-list" role="list" aria-label="最近问答记录">
          {data.questions.length === 0 ? (
            <p className="questions-empty">还没有问答记录。下一次提问后会自动留档。</p>
          ) : data.questions.map((row) => (
            <button
              key={row.requestId}
              type="button"
              className={selected?.requestId === row.requestId ? "active" : ""}
              onClick={() => {
                setSelectedRequestId(row.requestId);
                setFullAnswer(null);
                setFullAnswerError("");
              }}
            >
              <span className={`question-status question-status-${row.status}`}>{QUESTION_STATUS_TEXT[row.status]}</span>
              <strong>{row.displayQuestion}</strong>
              <small>{row.user} · {formatDateTime(row.askedAt)} · {row.citationCount} 条引用</small>
            </button>
          ))}
        </div>

        {selected && (
          <section className="question-detail" aria-label="问答处理详情">
            <div className="question-detail-title">
              <div><span>REQUEST DETAIL</span><h2>{QUESTION_STATUS_TEXT[selected.status]}</h2></div>
              <span className={`question-status question-status-${selected.status}`}>{selected.failureCode || selected.status}</span>
            </div>
            <dl className="question-meta">
              <div><dt>用户</dt><dd>{selected.user}</dd></div>
              <div><dt>提交时间</dt><dd>{formatDateTime(selected.askedAt)}</dd></div>
              <div><dt>扣次</dt><dd>{selected.chargeEligible ? (selected.usedFollowUpCredit ? "免费追问，不扣次" : "是") : "否"}</dd></div>
              <div><dt>用户端交付</dt><dd>{selected.deliveryStatus === "BLOCKED_BY_QUOTA" ? "额度复核后拦截" : "已交付"}</dd></div>
              <div><dt>处理完成</dt><dd>{selected.completedAt ? formatDateTime(selected.completedAt) : "仍在处理"}</dd></div>
              <div><dt>请求标识</dt><dd>{selected.requestId}</dd></div>
              <div><dt>会话标识</dt><dd>{selected.conversationId}</dd></div>
            </dl>

            <div className="question-analysis-block"><span>用户输入</span><p>{selected.displayQuestion}</p></div>
            <div className="question-analysis-block"><span>用于分析的问题</span><p>{selected.selfContainedQuestion}</p></div>
            {selected.shortConclusion && <div className="question-analysis-block"><span>处理结论</span><p>{selected.shortConclusion}</p></div>}

            <div className="question-full-answer">
              <div><span>RESTRICTED</span><p>完整回答仅在本页主动打开；每次查看都会留下管理员访问日志。附件原文不会显示。</p></div>
              <button type="button" onClick={() => void showFullAnswer()} disabled={fullAnswerBusy}>
                {fullAnswerBusy ? "读取并记录中…" : fullAnswer ? "重新读取完整回答" : "查看完整回答"}
              </button>
            </div>
            {fullAnswerError && <p className="question-full-answer-error" role="alert">{fullAnswerError}</p>}
            {fullAnswer && <FullAnswerPanel data={fullAnswer} />}

            <div className="question-analysis-grid">
              <div><span>话题关系</span><strong>{selected.topicRelation || "首问"}</strong></div>
              <div><span>所得税适用期间</span><strong>{selected.incomeTaxTime?.targetDate
                ? `${INCOME_TIME_SOURCE_TEXT[selected.incomeTaxTime.source ?? ""] || "已识别"} · ${selected.incomeTaxTime.targetDate}`
                : "未涉及或未确定"}</strong></div>
              <div><span>改写结果</span><strong>{selected.rewriteLog ? (selected.rewriteLog.usedFallback ? "确定性兜底" : "模型改写") : "未改写"}</strong></div>
              <div><span>改写耗时</span><strong>{selected.rewriteLog ? `${selected.rewriteLog.durationMs} ms` : "—"}</strong></div>
            </div>

            {selected.rewriteLog && <div className="question-analysis-block"><span>追问改写</span><p>{selected.rewriteLog.output}</p></div>}
            <div className="question-citations">
              <span>本次引用（{selected.citationCount}）</span>
              {selected.citations.length === 0 ? <p>本次未使用法律引用。</p> : <ul>{selected.citations.map((citation) => (
                <li key={`${citation.title}-${citation.locator}`}><a href={citation.officialUrl} target="_blank" rel="noreferrer">{citation.title} · {citation.locator}</a><small>{citation.authority}</small></li>
              ))}</ul>}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

interface SourceConfigurationPayload {
  sourceStatus: string;
  matchingRule: string;
  authorities: Array<{
    id: string;
    name: string;
    domains: string[];
    coveredDomains: string[];
    verificationStatus: "verified_official" | "expert_review_required";
    note?: string;
  }>;
  stateAuthorities: { note: string; matching_rule: string; jurisdictions_with_own_act: number };
  launchDomains: Array<{ id: string; label_zh: string; enabled: boolean }>;
  outOfScope: Array<{ id: string; label_zh: string }>;
  reviewOrder: Array<{ id: string; label: string }>;
  legalEffectLevels: Array<{ id: string; label: string; typical_types: string[]; rank: number | null; note?: string }>;
  currencyRules: { inspection_tiers: Record<string, number | string>; expired_effect: string; superseded_effect: string };
  priorityStatus: string;
}

const SOURCE_VERIFICATION_TEXT: Record<SourceConfigurationPayload["authorities"][number]["verificationStatus"], string> = {
  verified_official: "已核验官方域名",
  expert_review_required: "待专家复核",
};

/**
 * 来源配置是可审计的法律治理规则，不在后台提供“随手编辑”。来源白名单或位阶一旦
 * 改错会直接影响用户结论，应当走专家确认、代码复核和重新部署。
 */
function SourcesPanel() {
  const [data, setData] = useState<SourceConfigurationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/sources", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as SourceConfigurationPayload & { message?: string };
        if (!response.ok) throw new Error(payload.message || "读取来源配置失败。");
        if (alive) setData(payload);
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : "读取来源配置失败。");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <section className="admin-placeholder"><span>LOADING</span><h2>正在读取来源配置</h2><p>正在加载官方来源白名单与证据优先级。</p></section>;
  if (error) return <section className="admin-placeholder"><span>ERROR</span><h2>读取失败</h2><p>{error}</p></section>;
  if (!data) return null;
  const verifiedCount = data.authorities.filter((item) => item.verificationStatus === "verified_official").length;

  return (
    <>
      <section className="admin-stats" aria-label="来源配置概览">
        <article><small>官方来源</small><strong>{data.authorities.length}</strong><span>{verifiedCount} 个已核验官方域名</span></article>
        <article><small>覆盖领域</small><strong>{data.launchDomains.length}</strong><span>当前产品回答范围</span></article>
        <article><small>证据复核步骤</small><strong>{data.reviewOrder.length}</strong><span>冲突不能排除时不下确定结论</span></article>
        <article><small>州级 GST</small><strong>{data.stateAuthorities.jurisdictions_with_own_act}</strong><span>有独立 Act 的辖区</span></article>
      </section>

      <section className="questions-intro">
        <div><span>SOURCE GOVERNANCE</span><h2>官方来源与证据优先级</h2><p>这里展示系统当前采用的来源治理口径。为避免误改法律依据，本页只读；变更需要专家确认、代码复核并重新部署。</p></div>
        <small>来源域名匹配：{data.matchingRule === "exact_host_or_subdomain_only" ? "仅精确域名或子域名" : data.matchingRule}</small>
      </section>

      <section className="source-config-card">
        <div className="admin-section-title"><div><span>OFFICIAL SOURCES</span><h2>官方来源白名单</h2></div><small>“待专家复核”不能单独支撑确定结论</small></div>
        <div className="admin-table-wrap">
          <table>
            <thead><tr><th>来源</th><th>官方域名</th><th>覆盖领域</th><th>核验状态</th></tr></thead>
            <tbody>{data.authorities.map((source) => <tr key={source.id}>
              <td><strong>{source.name}</strong>{source.note && <span>{source.note}</span>}</td>
              <td>{source.domains.map((domain) => <a key={domain} href={`https://${domain}`} target="_blank" rel="noreferrer">{domain}</a>)}</td>
              <td>{source.coveredDomains.join("、")}</td>
              <td><span className={`source-status source-status-${source.verificationStatus}`}>{SOURCE_VERIFICATION_TEXT[source.verificationStatus]}</span></td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="source-state-note"><strong>州级来源：</strong>{data.stateAuthorities.note}</p>
      </section>

      <div className="source-config-grid">
        <section className="source-config-card">
          <div className="admin-section-title"><div><span>REVIEW ORDER</span><h2>引用前复核顺序</h2></div><small>按顺序逐项通过</small></div>
          <ol className="source-review-order">{data.reviewOrder.map((item, index) => <li key={item.id}><b>{index + 1}</b><span>{item.label}</span></li>)}</ol>
          <p className="source-state-note"><strong>时效过期：</strong>{data.currencyRules.expired_effect}</p>
          <p className="source-state-note"><strong>已被取代：</strong>{data.currencyRules.superseded_effect}</p>
        </section>
        <section className="source-config-card">
          <div className="admin-section-title"><div><span>LEGAL EFFECT</span><h2>法律位阶</h2></div><small>同一法域内比较</small></div>
          <div className="source-effect-list">{data.legalEffectLevels.map((level) => <article key={level.id}><strong>{level.label}</strong><span>{level.typical_types.join(" / ")}</span><small>{level.rank ? `优先级 ${level.rank}` : level.note || "结合法院层级与案件事实判断"}</small></article>)}</div>
        </section>
      </div>

      <section className="source-config-card source-scope-card">
        <div className="admin-section-title"><div><span>SCOPE</span><h2>当前回答范围</h2></div><small>范围外问题会明确提示且不扣次数</small></div>
        <div><h3>已覆盖</h3><p>{data.launchDomains.map((item) => item.label_zh).join(" · ")}</p></div>
        <div><h3>暂不覆盖</h3><p>{data.outOfScope.map((item) => item.label_zh).join(" · ")}</p></div>
      </section>
    </>
  );
}

/**
 * 首页五个高频题的人工审核答案。
 *
 * 文本可由管理员更新；引用、英文原句和条目结构只读，避免为了改一句中文把
 * 已核对的法源关系一并改坏。需要增删法规要求时，仍要从资料审核流程进入。
 */
function FeaturedAnswersPanel() {
  const [data, setData] = useState<FeaturedAnswersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<FeaturedAnswerForm | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/featured-answers", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as FeaturedAnswersPayload & { message?: string };
        if (!response.ok) throw new Error(payload.message || "读取标准答案失败。");
        if (!alive) return;
        setData(payload);
        const first = payload.records.find((item) => item.answer) ?? payload.records[0];
        if (first) {
          setSelectedId(first.id);
          setEnabled(first.enabled);
          setForm(first.answer ? formOfFeaturedAnswer(first.answer) : null);
        }
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : "读取标准答案失败。");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <section className="admin-placeholder"><span>LOADING</span><h2>正在读取标准答案</h2><p>只读取管理员维护的高频题缓存。</p></section>;
  if (error) return <section className="admin-placeholder"><span>ERROR</span><h2>读取失败</h2><p>{error}</p></section>;
  if (!data) return null;
  const selected = data.records.find((item) => item.id === selectedId) ?? data.records[0];

  function select(record: FeaturedAnswerAdminRecord) {
    setSelectedId(record.id);
    setEnabled(record.enabled);
    setForm(record.answer ? formOfFeaturedAnswer(record.answer) : null);
    setReviewed(false);
    setNotice("");
  }

  function changeLines(field: "assumptions" | "mandatoryTexts" | "practicalTexts" | "risks" | "caseActionPoints", index: number, value: string) {
    setReviewed(false);
    setForm((current) => {
      if (!current) return current;
      const lines = [...current[field]];
      lines[index] = value;
      return { ...current, [field]: lines };
    });
  }

  function changeCaseCluster(index: number, field: "challenge" | "takeaway" | "evidence", value: string, evidenceIndex?: number) {
    setReviewed(false);
    setForm((current) => {
      if (!current) return current;
      const clusters = current.caseClusters.map((cluster, clusterIndex) => {
        if (clusterIndex !== index) return cluster;
        if (field !== "evidence") return { ...cluster, [field]: value };
        const evidence = [...cluster.evidence];
        if (evidenceIndex != null) evidence[evidenceIndex] = value;
        return { ...cluster, evidence };
      });
      return { ...current, caseClusters: clusters };
    });
  }

  async function save() {
    if (!selected?.answer || !form || saving) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/admin/featured-answers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, enabled, reviewed, text: form }),
      });
      const payload = await response.json() as { record?: FeaturedAnswerAdminRecord; message?: string };
      if (!response.ok || !payload.record) throw new Error(payload.message || "保存失败。");
      setData((current) => current ? {
        ...current,
        records: current.records.map((item) => item.id === payload.record!.id
          ? { ...payload.record!, fresh: true }
          : item),
      } : current);
      setNotice("已保存。之后的逐字相同首问会直接使用这版答案。");
      setReviewed(false);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="admin-stats" aria-label="标准答案缓存概览">
        <article><small>标准问题</small><strong>{data.records.length}</strong><span>仅首页高频问题</span></article>
        <article><small>已启用</small><strong>{data.records.filter((item) => item.enabled && item.answer && item.fresh).length}</strong><span>题目逐字相同才命中</span></article>
        <article><small>待补充</small><strong>{data.records.filter((item) => !item.answer).length}</strong><span>不会提前启用</span></article>
        <article><small>资料已变化</small><strong>{data.records.filter((item) => item.answer && !item.fresh).length}</strong><span>变化后自动回到知识库检索</span></article>
      </section>

      <section className="questions-intro">
        <div><span>REVIEWED ANSWER CACHE</span><h2>首页高频问题的标准答案</h2><p>缓存只跳过模型生成，不跳过收费、会话留档或管理员问答日志。题目有附件、日期、辖区或历史上下文时，系统仍检索知识库。</p></div>
        <small>法律原文和引用结构锁定，防止编辑文字时误改法源。</small>
      </section>

      <div className="featured-answer-layout">
        <div className="featured-answer-list" role="list" aria-label="标准答案列表">
          {data.records.map((record) => (
            <button key={record.id} type="button" className={selected?.id === record.id ? "active" : ""} onClick={() => select(record)}>
              <span className={record.enabled && record.answer && record.fresh ? "featured-status ready" : "featured-status"}>
                {record.answer ? (record.enabled && record.fresh ? "已启用" : record.enabled ? "待复核" : "未启用") : "待补充"}
              </span>
              <strong>{record.label}</strong>
              <small>{record.question}</small>
            </button>
          ))}
        </div>

        {selected && !selected.answer && (
          <section className="featured-answer-editor">
            <span>WAITING FOR ANSWER</span><h2>{selected.label}</h2><p>这题还没有经审核的标准答案，因此不会命中缓存。收到并复核答案后再启用。</p>
          </section>
        )}

        {selected?.answer && form && (
          <section className="featured-answer-editor">
            <div className="featured-editor-head">
              <div><span>EDIT REVIEWED ANSWER</span><h2>{selected.question}</h2><p>上次更新：{formatDateTime(selected.updatedAt)} · {selected.updatedBy}</p></div>
              <label className="featured-enable"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用缓存</label>
            </div>
            {!selected.fresh && <p className="featured-stale">知识库资料已变化。这条答案当前不会被使用；确认仍适用后，保存一次即可重新启用。</p>}

            <label className="featured-field"><span>结论</span><textarea value={form.shortConclusion} onChange={(event) => { setReviewed(false); setForm({ ...form, shortConclusion: event.target.value }); }} /></label>
            <div className="featured-sections">
              <fieldset><legend>适用前提</legend>{form.assumptions.map((line, index) => <textarea key={`assumption-${index}`} value={line} onChange={(event) => changeLines("assumptions", index, event.target.value)} />)}</fieldset>
              <fieldset><legend>风险与例外</legend>{form.risks.map((line, index) => <textarea key={`risk-${index}`} value={line} onChange={(event) => changeLines("risks", index, event.target.value)} />)}</fieldset>
            </div>
            <fieldset className="featured-steps"><legend>法规要求</legend>{form.mandatoryTexts.map((line, index) => {
              const source = selected.answer!.action_steps.filter((step) => step.kind === "MANDATORY")[index];
              return <label key={`mandatory-${index}`}><span>{index + 1}. 引用 #{source.citation_refs.join("、")}</span><textarea value={line} onChange={(event) => changeLines("mandatoryTexts", index, event.target.value)} /></label>;
            })}</fieldset>
            <fieldset className="featured-steps"><legend>实务建议</legend>{form.practicalTexts.map((line, index) => <label key={`practical-${index}`}><span>{index + 1}.</span><textarea value={line} onChange={(event) => changeLines("practicalTexts", index, event.target.value)} /></label>)}</fieldset>
            {selected.answer.case_digest && (
              <fieldset className="featured-steps featured-case-editor">
                <legend>相关判例</legend>
                <label><span>检索口径</span><textarea value={form.caseSearchNote} onChange={(event) => { setReviewed(false); setForm({ ...form, caseSearchNote: event.target.value }); }} /></label>
                {form.caseClusters.map((cluster, clusterIndex) => {
                  const sourceCluster = selected.answer!.case_digest!.clusters[clusterIndex];
                  return (
                    <section key={sourceCluster.title} className="featured-case-cluster">
                      <h3>{sourceCluster.title}</h3>
                      <label><span>争议点</span><textarea value={cluster.challenge} onChange={(event) => changeCaseCluster(clusterIndex, "challenge", event.target.value)} /></label>
                      {cluster.evidence.map((line, evidenceIndex) => <label key={`${sourceCluster.title}-evidence-${evidenceIndex}`}><span>案例 #{sourceCluster.evidence[evidenceIndex].docid}</span><textarea value={line} onChange={(event) => changeCaseCluster(clusterIndex, "evidence", event.target.value, evidenceIndex)} /></label>)}
                      <label><span>裁判要点</span><textarea value={cluster.takeaway} onChange={(event) => changeCaseCluster(clusterIndex, "takeaway", event.target.value)} /></label>
                    </section>
                  );
                })}
                <section className="featured-case-cluster"><h3>应对要点</h3>{form.caseActionPoints.map((line, index) => <label key={`case-action-${index}`}><span>{index + 1}.</span><textarea value={line} onChange={(event) => changeLines("caseActionPoints", index, event.target.value)} /></label>)}</section>
                <p className="featured-case-lock">案例名称、原文链接和引用法条已锁定；需要增删案例或法条时，请先走案例库或资料审核。</p>
              </fieldset>
            )}
            <section className="featured-citations"><h3>锁定的法律原文</h3><p>引用与英文原句已复核。需要新增、删除或替换法条时，先走资料审核，不在这里直接改。</p><ol>{selected.answer.citations.map((citation, index) => <li key={`${citation.display_title}-${citation.locator}`}><a href={citation.official_url} target="_blank" rel="noreferrer">#{index + 1} {citation.display_title} · {citation.locator}</a>{citation.snippet && <small>{citation.snippet}</small>}</li>)}</ol></section>
            <label className="featured-review"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /> 我已逐条核对本次编辑文字与锁定的法源；启用后将直接展示给用户。</label>
            {notice && <p className={notice.startsWith("已保存") ? "featured-notice ok" : "featured-notice"} role="status">{notice}</p>}
            <button type="button" className="featured-save" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存并更新缓存"}</button>
          </section>
        )}
      </div>
    </>
  );
}

/**
 * 「会员与订单」页签：谁买了、买了多久、什么时候到期、每一笔钱的来龙去脉。
 *
 * 只读。这里没有「帮某用户加时长」的按钮——后台手改和支付回调并发写
 * 同一个 JSON 文件迟早打架，真要调整个别用户，去服务器上停服改文件再启动。
 */
function MembershipPanel() {
  const [data, setData] = useState<AdminMembershipPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/admin/membership", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as AdminMembershipPayload & { message?: string };
        if (!response.ok) throw new Error(payload.message || "读取会员数据失败。");
        if (alive) setData(payload);
      })
      .catch((caught: unknown) => {
        if (alive) setError(caught instanceof Error ? caught.message : "读取会员数据失败。");
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <section className="admin-placeholder"><span>LOADING</span><h2>正在读取会员数据</h2><p>从服务器上的 membership-store.json 汇总。</p></section>;
  if (error) return <section className="admin-placeholder"><span>ERROR</span><h2>读取失败</h2><p>{error}</p></section>;
  if (!data) return null;

  return (
    <>
      <section className="admin-stats" aria-label="会员营收概览">
        <article><small>生效中会员</small><strong>{data.stats.activeMemberCount}</strong><span>paidThrough 尚未到期</span></article>
        <article><small>累计已收</small><strong>¥{data.stats.totalRevenueYuan}</strong><span>只统计已支付订单</span></article>
        <article><small>已支付订单</small><strong>{data.stats.paidOrderCount}</strong><span>自上线以来</span></article>
        <article><small>待支付订单</small><strong>{data.stats.pendingOrderCount}</strong><span>30 分钟未付自动作废</span></article>
      </section>

      <div className="admin-section-title"><div><span>MEMBERSHIPS</span><h2>会员有效期</h2></div><small>过期那一刻起自动降回免费版</small></div>
      <div className="admin-table-wrap">
        <table>
          <thead><tr><th>用户</th><th>状态</th><th>有效期至</th><th>剩余天数</th><th>最近变动</th></tr></thead>
          <tbody>
            {data.memberships.length === 0 ? (
              <tr><td><strong>还没有人买过会员</strong><span>第一笔订单到账后会出现在这里</span></td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
            ) : data.memberships.map((row) => (
              <tr key={row.userId}>
                <td><strong>{row.email}</strong><span>plan: {row.plan}</span></td>
                <td>{row.active ? "生效中" : "已过期"}</td>
                <td>{formatDateTime(row.paidThrough)}</td>
                <td>{row.active ? `${row.daysLeft} 天` : "—"}</td>
                <td>{formatDateTime(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="admin-section-title"><div><span>ORDERS</span><h2>订单流水</h2></div><small>最近 200 笔，新的在前</small></div>
      <div className="admin-table-wrap">
        <table>
          <thead><tr><th>商户订单号</th><th>用户</th><th>渠道 / 时长</th><th>金额</th><th>状态</th><th>创建 / 支付时间</th></tr></thead>
          <tbody>
            {data.orders.length === 0 ? (
              <tr><td><strong>还没有订单</strong><span>用户端点开「专业版」就会产生订单</span></td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>
            ) : data.orders.map((row) => (
              <tr key={row.outTradeNo}>
                <td><strong>{row.outTradeNo}</strong><span>{row.transactionId ? `渠道流水: ${row.transactionId}` : "无渠道流水"}</span></td>
                <td>{row.email}</td>
                <td>{row.channel === "WECHAT" ? "微信" : "支付宝"} · {row.months} 个月</td>
                <td>¥{row.amountYuan}</td>
                <td>{ORDER_STATUS_TEXT[row.status]}{row.failReason ? `（${row.failReason}）` : ""}</td>
                <td>{formatDateTime(row.createdAt)}{row.paidAt ? ` / ${formatDateTime(row.paidAt)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function AdminPage() {
  const [active, setActive] = useState("资料上传");
  const [result, setResult] = useState<KnowledgeValidationResult | null>(null);
  const [documentId, setDocumentId] = useState("");
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("PENDING");
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats>({
    publishedDocumentCount: 0,
    reviewDocumentCount: 0,
    publishedChunkCount: 0,
  });
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [termsStatus, setTermsStatus] = useState<TermsStatus | null>(null);

  async function refreshKnowledgeStats() {
    const payload = await fetchKnowledgeStats();
    if (payload) setKnowledgeStats(payload);
  }

  async function refreshTermsStatus() {
    const payload = await fetchTermsStatus();
    setTermsStatus(payload);
  }

  /**
   * 回到一份未完成的审核：从服务端把已暂存的资料取回来，装进审核界面。
   * 在此之前，「审核与发布」只认刚上传完的页面状态，刷新就再也进不去了。
   */
  async function resumeReview(id: string) {
    setError("");
    try {
      const response = await fetch(`/api/admin/knowledge?view=document&id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json() as KnowledgeValidationResult & { documentId?: string; message?: string };
      if (!response.ok) throw new Error(payload.message || "打不开这份资料，请重试。");
      setResult(payload);
      setDocumentId(payload.documentId ?? id);
      setReviewStatus("IN_REVIEW");
      setActive("审核与发布");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "打不开这份资料，请重试。");
    }
  }

  useEffect(() => {
    let active = true;
    void fetchKnowledgeStats().then((payload) => {
      if (active && payload) setKnowledgeStats(payload);
    });
    void fetchTermsStatus().then((payload) => {
      if (active) setTermsStatus(payload);
    });
    return () => { active = false; };
  }, []);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    setDocumentId("");
    setReading(true);
    try {
      if (!file.name.toLowerCase().endsWith(".txt")) {
        throw new Error("这里只接收UTF-8 TXT文件。");
      }
      const text = await file.text();
      const nextResult = validateKnowledgeTxt(file.name, text);
      setResult(nextResult);
      setReviewStatus("PENDING");
      if (nextResult.status === "READY_TO_REVIEW") {
        const response = await fetch("/api/admin/knowledge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stage", fileName: file.name, text }),
        });
        const payload = await response.json() as {
          documentId?: string;
          status?: "TO_REVIEW" | "PUBLISHED";
          message?: string;
        };
        if (!response.ok || !payload.documentId) {
          throw new Error(payload.message || "资料保存失败，请重新上传。");
        }
        setDocumentId(payload.documentId);
        setReviewStatus(payload.status === "PUBLISHED" ? "PUBLISHED" : "PENDING");
        await refreshKnowledgeStats();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件读取失败，请重新上传。");
    } finally {
      setReading(false);
      event.target.value = "";
    }
  }

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <AdminBrand />
        <nav aria-label="管理员导航">
          {adminNav.map((item) => <button key={item} type="button" className={active === item ? "active" : ""} onClick={() => {
            if (item === "审核与发布" && result?.status === "READY_TO_REVIEW" && reviewStatus === "PENDING") {
              setReviewStatus("IN_REVIEW");
            }
            setActive(item);
          }}><i aria-hidden="true" />{item}</button>)}
        </nav>
        <div className="admin-security"><span>AUTH</span><p><strong>超级管理员</strong><small>当前使用 Basic Auth；问答运营记录保留 90 天</small></p></div>
        <Link href="/">← 返回用户端</Link>
      </aside>

      <div className="admin-main">
        <header className="admin-header">
          <div><span>KNOWLEDGE OPERATIONS</span><h1>{active}</h1></div>
          <div className="admin-header-actions"><button type="button">查看规范</button><span className="admin-avatar">C</span></div>
        </header>

        {active === "资料上传" ? (
          <>
            <section className="admin-stats" aria-label="知识库状态">
              <article><small>已发布资料</small><strong>{knowledgeStats.publishedDocumentCount}</strong><span>{knowledgeStats.publishedDocumentCount > 0 ? "已进入问答检索范围" : "等待首次导入"}</span></article>
              <article><small>{reviewStatus === "IN_REVIEW" ? "审核中" : "待审核"}</small><strong>{knowledgeStats.reviewDocumentCount}</strong><span>{reviewStatus === "IN_REVIEW" ? "确认发布后归零" : "只有发布后才能回答"}</span></article>
              <article><small>已发布Chunk</small><strong>{knowledgeStats.publishedChunkCount}</strong><span>仅管理员可见正文</span></article>
              <article><small>链接巡检</small><strong>—</strong><span>发布后每30天检查</span></article>
            </section>

            <section className="upload-card">
              <div className="upload-copy">
                <span className="upload-index">01</span>
                <div><h2>上传官方资料TXT</h2><p>系统先检查UTF-8、分隔符、四个固定字段、正文、链接和重复Chunk。任何错误都会退回整份文件。</p></div>
              </div>
              <input ref={inputRef} hidden type="file" accept=".txt,text/plain" onChange={handleFile} />
              <button type="button" className="upload-zone" onClick={() => inputRef.current?.click()} disabled={reading}>
                <span className="upload-symbol">TXT</span>
                <strong>{reading ? "正在读取文件" : "选择TXT文件"}</strong>
                <small>每个Chunk以单独一行“-----”结束</small>
              </button>
              {error && <p className="admin-error" role="alert">{error}</p>}
            </section>

            {result ? <ResultPanel result={result} reviewStatus={reviewStatus} staged={Boolean(documentId)} onReview={() => {
              if (reviewStatus === "PENDING") setReviewStatus("IN_REVIEW");
              setActive("审核与发布");
            }} /> : (
              <section className="format-contract">
                <div className="admin-section-title"><div><span>FORMAT CONTRACT</span><h2>上传前，文件要长这样</h2></div><small>字段名和顺序不能修改</small></div>
                <pre>{`【来源】Companies Act 2013 (as amended upto 01.04.2021)\n【大标题】CHAPTER I\n【小标题】Section 1 - Short title... (Part 1/3)\n【原文链接】https://official.example/file.pdf#page=16\n\n[官方英文正文，保持原句]\n-----`}</pre>
              </section>
            )}
          </>
        ) : active === "审核与发布" && result?.status === "READY_TO_REVIEW" && documentId ? (
          <ReviewPanel
            result={result}
            published={reviewStatus === "PUBLISHED"}
            onPublish={async () => {
              const response = await fetch("/api/admin/knowledge", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "publish", documentId }),
              });
              const payload = await response.json() as { message?: string };
              if (!response.ok) throw new Error(payload.message || "发布失败，请重试。");
              setReviewStatus("PUBLISHED");
              await refreshKnowledgeStats();
            }}
            onBack={() => setActive("资料上传")}
          />
        ) : active === "总览" ? (
          <OverviewPanel onGoUpload={() => setActive("资料上传")} onResumeReview={resumeReview} />
        ) : active === "会员与订单" ? (
          <MembershipPanel />
        ) : active === "来源配置" ? (
          <SourcesPanel />
        ) : active === "标准答案缓存" ? (
          <FeaturedAnswersPanel />
        ) : active === "测试与日志" ? (
          <QuestionsPanel />
        ) : active === "税务案例库" ? (
          <CasesPanel />
        ) : active === "术语词典" ? (
          <TermsPanel status={termsStatus} onUploaded={refreshTermsStatus} />
        ) : (
          <section className="admin-placeholder">
            <span>{active === "审核与发布" ? "暂无待审核资料" : "开发中"}</span><h2>{active}</h2><p>{active === "审核与发布" ? "上传并通过格式校验后，可以在这里逐条审核。" : "这一模块的数据结构已经预留。首批TXT完成上传后继续联调。"}</p>
            <button type="button" onClick={() => setActive("资料上传")}>先上传知识库资料</button>
          </section>
        )}
      </div>
    </main>
  );
}
