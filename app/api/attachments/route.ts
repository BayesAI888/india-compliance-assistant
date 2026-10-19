import { NextResponse } from "next/server";
import type { AttachmentUploadResponse, AttachmentUploadResult } from "../../../lib/contracts";
import { getOrCreateConversation } from "../../../lib/server/conversation-store";
import { saveAttachment } from "../../../lib/server/attachment-store";
import { extractNoticeFacts, extractTextFromFile, toNoticeFactsPayload } from "../../../lib/server/notice-extract";
import { identifyRequest } from "../../../lib/server/request-identity";

/**
 * Notice/合同/申报文件上传接口。前端选好文件后立刻调用这个接口（不等用户提问），
 * 拿到 attachment_id 和提取出的 notice_facts 预览——用户可以在真正提问前先确认
 * 提取得对不对，提问时把 attachment_id 放进 /api/chat 的 attachment_ids 数组即可。
 *
 * 按《产品规则表 V1.4》"文件只对上传者……可见"：上传接口要求带 conversation_id
 * （没有就新建一个，和 /api/chat 首问不带 conversation_id 时的行为一致），
 * 附件落在这个会话名下，/api/chat 那边按会话ID核对归属，见 attachment-store.ts。
 *
 * 每次请求最多处理 5 个文件、单个文件不超过 15MB——这两个数字都是占位默认值，
 * 产品规则表把"用户上传文件的OCR语言、最大文件大小、页数"列为待定问题，
 * 等产品正式定下来了要回来改。
 */
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 5;
const MAX_UPLOAD_REQUEST_BYTES = MAX_FILE_BYTES * MAX_FILES_PER_REQUEST + 2 * 1024 * 1024;
const MAX_FILE_NAME_CHARS = 180;

function jsonResponse(body: AttachmentUploadResponse) {
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const identity = await identifyRequest(request);
  if (!identity.user) {
    return NextResponse.json(
      { error: "LOGIN_REQUIRED", message: "上传文件前请先登录，文件仅对上传账号可见。" },
      { status: 401 },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    return NextResponse.json(
      { error: "REQUEST_TOO_LARGE", message: "本次上传总大小超过上限，请减少文件或压缩后重试。" },
      { status: 413 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "INVALID_FORM", message: "上传格式无效，请使用文件上传表单提交。" }, { status: 400 });
  }

  const conversationIdField = formData.get("conversation_id");
  const conversation = await getOrCreateConversation(
    typeof conversationIdField === "string" ? conversationIdField : undefined,
    identity.user.id,
  );
  if (!conversation) {
    return NextResponse.json(
      { error: "CONVERSATION_NOT_FOUND", message: "这条对话已经过期或不存在（对话保留30天）。" },
      { status: 404 },
    );
  }

  const files = formData.getAll("files").filter((item): item is File => item instanceof File).slice(0, MAX_FILES_PER_REQUEST);
  if (files.length === 0) {
    return NextResponse.json({ error: "NO_FILE", message: "没有收到文件，请重新选择要上传的文件。" }, { status: 400 });
  }

  const results: AttachmentUploadResult[] = [];

  for (const file of files) {
    if (file.name.length > MAX_FILE_NAME_CHARS) {
      results.push({
        attachment_id: "",
        file_name: file.name.slice(0, MAX_FILE_NAME_CHARS),
        status: "FAILED",
        error_message: `文件名超过 ${MAX_FILE_NAME_CHARS} 个字符，请缩短后重试。`,
      });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      results.push({
        attachment_id: "",
        file_name: file.name,
        status: "FAILED",
        error_message: `文件超过大小上限（${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB），请压缩后重新上传。`,
      });
      continue;
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const extracted = await extractTextFromFile({ buffer, mimeType: file.type, fileName: file.name });

    if (!extracted.ok) {
      const saved = await saveAttachment({
        conversationId: conversation.id,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        status: "UNSUPPORTED",
        errorMessage: extracted.reason,
      });
      results.push({
        attachment_id: saved.id,
        file_name: file.name,
        status: "UNSUPPORTED",
        error_message: extracted.reason,
      });
      continue;
    }

    try {
      const noticeFacts = await extractNoticeFacts(extracted.text);
      const saved = await saveAttachment({
        conversationId: conversation.id,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        status: "EXTRACTED",
        extractedText: extracted.text,
        noticeFacts,
      });
      results.push({
        attachment_id: saved.id,
        file_name: file.name,
        status: "EXTRACTED",
        notice_facts: toNoticeFactsPayload(noticeFacts),
      });
    } catch (error) {
      // 只打文件名和错误类型，不打提取出的原文/事实——那是敏感内容，
      // 产品规则表要求"不在普通日志中记录用户上传文件全文；敏感字段脱敏"。
      console.error("[attachments] extractNoticeFacts failed:", file.name, error instanceof Error ? error.name : "unknown error");
      const saved = await saveAttachment({
        conversationId: conversation.id,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        status: "FAILED",
        errorMessage: "文字已提取，但事实提取服务暂时未完成，请稍后重试。",
        extractedText: extracted.text,
      });
      results.push({
        attachment_id: saved.id,
        file_name: file.name,
        status: "FAILED",
        error_message: "文字已提取，但事实提取服务暂时未完成，请稍后重试。",
      });
    }
  }

  return jsonResponse({ conversation_id: conversation.id, results });
}
