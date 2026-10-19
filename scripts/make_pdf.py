#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 case-extract.mjs batch 下载的 raw/<docid>.html 转成 pdf/<docid>.pdf。

印度 Kanoon API 不提供 PDF 端点，这里把取回的 HTML 正文清洗后，
用 reportlab 渲染为可读的 PDF 版本（含标题、来源、链接等元数据）。
"""
import sys, re, json, html, pathlib
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable


def strip_html(s):
    if not s:
        return ""
    s = re.sub(r"<(script|style)[^>]*>[\s\S]*?</\1>", " ", s, flags=re.I)
    s = re.sub(r"</(p|div|br|li|tr|h[1-6])>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def main():
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(".")
    raw = out / "raw"
    pdfdir = out / "pdf"
    pdfdir.mkdir(parents=True, exist_ok=True)

    ss = getSampleStyleSheet()
    title_style = ParagraphStyle("t", parent=ss["Title"], fontSize=13, leading=16, spaceAfter=4)
    meta_style = ParagraphStyle("m", parent=ss["Normal"], fontSize=8.5, leading=12, textColor="#333333")
    body_style = ParagraphStyle("b", parent=ss["Normal"], fontSize=8.5, leading=12.5, spaceBefore=2)

    meta_files = sorted(raw.glob("*.meta.json"))
    count = 0
    for mf in meta_files:
        docid = mf.name[:-len(".meta.json")]
        html_path = raw / f"{docid}.html"
        pdf_path = pdfdir / f"{docid}.pdf"
        if not html_path.exists():
            continue
        if pdf_path.exists():
            count += 1
            continue
        meta = json.loads(mf.read_text(encoding="utf-8"))
        text = strip_html(html_path.read_text(encoding="utf-8"))
        paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
        if not paras:
            paras = [text] if text else ["(正文为空)"]

        doc = SimpleDocTemplate(
            str(pdf_path), pagesize=A4,
            leftMargin=18 * mm, rightMargin=18 * mm,
            topMargin=16 * mm, bottomMargin=16 * mm,
            title=str(meta.get("title", "")),
        )
        flow = []
        flow.append(Paragraph(html.escape(str(meta.get("title", "(无标题)"))), title_style))
        flow.append(Paragraph(html.escape(f"IndianKanoon 文档ID：{meta.get('docid', '')}"), meta_style))
        flow.append(Paragraph(html.escape(f"来源：{meta.get('docsource', '')}　发布日期：{meta.get('publishdate', '')}"), meta_style))
        flow.append(Paragraph(html.escape(f"链接：{meta.get('link', '')}"), meta_style))
        flow.append(Spacer(1, 4))
        flow.append(HRFlowable(width="100%", thickness=0.6, color="#999999"))
        flow.append(Spacer(1, 4))
        for p in paras:
            flow.append(Paragraph(html.escape(p), body_style))
            flow.append(Spacer(1, 2))
        doc.build(flow)
        count += 1

    print(f"PDF 生成完成：{count} 份 -> {pdfdir}")


if __name__ == "__main__":
    main()
