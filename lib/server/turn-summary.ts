/**
 * 从一次回答里提炼"存进会话历史给下一轮追问用"的轻量摘要。
 *
 * 不存完整的法规要求/实务建议正文——十几条正文存进会话文件、又原样喂给下一轮的
 * 改写和回答生成，既拖存储又挤占本轮真正要用的证据的上下文位置。只取首句和引用来源，
 * 够让下一轮知道"已经讲过什么"就行。纯函数，不接触存储或网络，方便单测。
 */
import type { AnswerResponse, Citation } from "../contracts";

const MAX_FIRST_SENTENCES = 8;
const MAX_CITED_LAWS = 10;
const MAX_SENTENCE_LENGTH = 60;

/** 取一段文本的第一句，按中文常见的句末标点切分；超长就截断加省略号。 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^[^。；;\n]+[。；;]?/);
  const sentence = (match ? match[0] : trimmed).trim();
  return sentence.length > MAX_SENTENCE_LENGTH
    ? `${sentence.slice(0, MAX_SENTENCE_LENGTH)}…`
    : sentence;
}

export function extractMandatoryFirstSentences(
  steps: AnswerResponse["action_steps"],
  limit: number = MAX_FIRST_SENTENCES,
): string[] {
  const sentences = steps
    .filter((step) => step.kind === "MANDATORY")
    .map((step) => firstSentence(step.text))
    .filter(Boolean);
  return [...new Set(sentences)].slice(0, limit);
}

function citedLawLabel(citation: Citation): string {
  return [citation.display_title, citation.locator].filter(Boolean).join(" ").trim();
}

export function extractCitedLaws(
  citations: Citation[],
  limit: number = MAX_CITED_LAWS,
): string[] {
  const labels = citations.map(citedLawLabel).filter(Boolean);
  return [...new Set(labels)].slice(0, limit);
}
