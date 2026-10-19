#!/usr/bin/env python3
"""
CBIC PDF → 知识库 txt 转换器
- 每份 PDF 一个 txt，镜像 {税目}/{类型}/{年}/ 结构，输出到 CBIC/txt/
- 文字层用 PyMuPDF 提取；无文字层的扫描件用 macOS Vision OCR（/tmp/ocrbin，Swift 编译）
- 每个 chunk 自包含：【来源】【大标题】【小标题】【原文链接】+ 正文，块间 `-----`
- 【原文链接】= 实际下载直链（taxinformation.cbic.gov.in/content/pdf/<path>），
  取自抓取脚本的 state 文件；Central Excise / Service Tax 由 API 实时补映射。

用法：python3 cbic-pdf-to-txt.py [--all]
"""
import os, sys, json, ssl, subprocess, tempfile, urllib.request, re
import fitz  # PyMuPDF

CBIC = "/Users/cora/Desktop/工作/印度税法/源文件/CBIC"
OUT = os.path.join(CBIC, "txt")
SCRIPTS = "/Users/cora/Desktop/印度合规机器人/site/scripts"
HOST = "https://taxinformation.cbic.gov.in"
OCRBIN = "/tmp/ocrbin"
MAX_CHARS = 5000   # 单块正文上限（约 1500 token 硬上限内）
DPI = 300          # OCR 渲染分辨率

FORCE = "--all" in sys.argv


def san(s, mx=90):
    s = re.sub(r'[\\/:*?"<>|]+', '-', s or "")
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:mx]


def san40(s):
    return san(s, 40)


# ── 1) 链接 / 元数据映射 ─────────────────────────────────────────
def load_state_maps():
    url_map, meta_map = {}, {}
    p = os.path.join(SCRIPTS, "cbic-history-state.json")
    if os.path.exists(p):
        for _id, e in json.load(open(p, encoding="utf-8")).get("seen", {}).items():
            tax, year = e.get("tax"), e.get("date")
            files, urls = e.get("files") or [], e.get("urls") or []
            for i, f in enumerate(files):
                u = urls[i] if i < len(urls) else (urls[0] if urls else None)
                key = f"{tax}/Notification/{year}/{f}"
                if u:
                    url_map[key] = u
                    meta_map[key] = {"no": e.get("number") or "", "title": e.get("name") or ""}
    p = os.path.join(SCRIPTS, "cbic-circular-history-state.json")
    if os.path.exists(p):
        for _id, e in json.load(open(p, encoding="utf-8")).get("seen", {}).items():
            f, u = e.get("file"), e.get("url")
            if f and u:
                key = f"{e.get('taxName')}/Circular/{e.get('year')}/{f}"
                url_map[key] = u
                meta_map[key] = {"no": e.get("no") or "", "title": e.get("title") or ""}
    return url_map, meta_map


def _fetch(path):
    ctx = ssl._create_unverified_context()
    req = urllib.request.Request(HOST + path, headers={
        "Accept": "application/json", "User-Agent": "Mozilla/5.0",
        "language": "en", "Referer": HOST + "/content-page/explore-notification"})
    last = None
    for _ in range(5):
        try:
            with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as ex:
            last = ex
    raise last


def load_extra_map():
    """Central Excise(1000003)/Service Tax(1000004)：按 san40(no) 匹配文件名前缀"""
    out = {}
    jobs = [
        ("Central Excise", "Notification", "/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=1000003&year=2026&page=0&size=300", "notificationNo", "notificationName"),
        ("Service Tax", "Notification", "/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=1000004&year=2022&page=0&size=300", "notificationNo", "notificationName"),
        ("Service Tax", "Notification", "/api/cbic-notification-msts/fetchNotificationByYearAndCategory?taxId=1000004&year=2023&page=0&size=300", "notificationNo", "notificationName"),
        ("Service Tax", "Circular", "/api/cbic-circular-msts/fetchCircularByYearCategory?taxId=1000004&year=2023&page=0&size=300", "circularNo", "circularName"),
        ("Service Tax", "Circular", "/api/cbic-circular-msts/fetchCircularByYearCategory?taxId=1000004&year=2020&page=0&size=300", "circularNo", "circularName"),
    ]
    for tax, typ, path, nof, namef in jobs:
        try:
            arr = _fetch(path)
        except Exception as ex:
            print(f"  [warn] 取 {tax} {typ} 链接失败：{ex}")
            continue
        if not isinstance(arr, list):
            continue
        for it in arr:
            no, fp = it.get(nof), it.get("docFilePath")
            if not no or not fp:
                continue
            url = f"{HOST}/content/pdf/{str(fp).replace(chr(92), '/')}"
            out[(tax, typ, san40(no))] = {"url": url, "no": no, "title": it.get(namef) or ""}
    return out


# ── 2) 取文本 / OCR ──────────────────────────────────────────────
def extract(pdf):
    d = fitz.open(pdf)
    return "".join(d.load_page(i).get_text("text") for i in range(d.page_count))


def ocr(pdf):
    d = fitz.open(pdf)
    out = []
    for i in range(d.page_count):
        fn = tempfile.mktemp(suffix=".png")
        d.load_page(i).get_pixmap(dpi=DPI).save(fn)
        try:
            r = subprocess.run([OCRBIN, fn], capture_output=True, text=True, timeout=180)
            out.append(r.stdout or "")
        finally:
            if os.path.exists(fn):
                os.unlink(fn)
    return "\n".join(out)


# ── 3) 分块 ──────────────────────────────────────────────────────
def split_text(body, mx):
    body = body.strip()
    if len(body) <= mx:
        return [body]
    parts, cur = [], []
    for ln in body.split("\n"):
        if cur and sum(len(x) + 1 for x in cur) + len(ln) > mx:
            parts.append("\n".join(cur)); cur = []
        cur.append(ln)
    if cur:
        parts.append("\n".join(cur))
    return parts


def build(tax, typ, year, no, title, url, body):
    src = f"CBIC - {tax} {typ}"
    big = f"{tax} {typ} {year}"
    label = " - ".join([x for x in [no, title] if x]) or year
    parts = split_text(body, MAX_CHARS)
    n = len(parts)
    blocks = []
    for i, p in enumerate(parts):
        small = label + (f" (part {i+1}/{n})" if n > 1 else "")
        blocks.append(f"【来源】{src}\n【大标题】{big}\n【小标题】{small}\n【原文链接】{url}\n\n{p.strip()}")
    return "\n-----\n".join(blocks) + "\n"


def main():
    url_map, meta_map = load_state_maps()
    extra = load_extra_map()
    print(f"state 映射 {len(url_map)} 条；extra(Central Excise/Service Tax) {len(extra)} 条")

    pdfs = []
    for r, _dirs, fs in os.walk(CBIC):
        if "_hindi_removed" in r or r == OUT or r.startswith(OUT + os.sep):
            continue
        for f in fs:
            if f.lower().endswith(".pdf"):
                pdfs.append(os.path.join(r, f))
    pdfs.sort()
    print(f"待处理 PDF：{len(pdfs)} 份\n")

    ok = skip = ocr_n = fail = miss = 0
    missing = []
    for p in pdfs:
        rel = os.path.relpath(p, CBIC)
        seg = rel.split(os.sep)  # tax/type/year/basename
        if len(seg) < 4:
            fail += 1; continue
        tax, typ, year, base = seg[-4], seg[-3], seg[-2], seg[-1]
        key = f"{tax}/{typ}/{year}/{base}"
        info = None
        if key in url_map:
            m = meta_map.get(key, {})
            info = {"url": url_map[key], "no": m.get("no", ""), "title": m.get("title", "")}
        else:
            pre = base.split("__")[0]
            info = extra.get((tax, typ, pre))
        if not info:
            miss += 1; missing.append(rel)

        no = info["no"] if info else (base.split("__")[0] if "__" in base else base)
        title = info["title"] if info else (base.split("__")[1] if "__" in base else "")
        url = info["url"] if info else f"{HOST}/content-page/explore-notification"

        outp = os.path.join(OUT, tax, typ, year, os.path.splitext(base)[0] + ".txt")
        if os.path.exists(outp) and os.path.getsize(outp) > 50 and not FORCE:
            skip += 1; continue

        try:
            txt = extract(p)
            used_ocr = False
            # 触发 OCR：文字层近空，或「文字层明显不足 + 每页都有整页图像」（扫描件常只留签名/页脚文字）
            need = len(txt.strip()) < 50
            if not need:
                try:
                    d = fitz.open(p)
                    pg = max(1, d.page_count)
                    imgs = sum(len(d.load_page(i).get_images()) for i in range(d.page_count))
                    if imgs >= pg and len(txt.strip()) < 300 * pg:
                        need = True
                except Exception:
                    pass
            if need:
                txt = ocr(p); used_ocr = True
        except Exception as ex:
            print(f"  ✗ 解析失败 {rel}: {ex}"); fail += 1; continue

        os.makedirs(os.path.dirname(outp), exist_ok=True)
        with open(outp, "w", encoding="utf-8") as fh:
            fh.write(build(tax, typ, year, no, title, url, txt))
        if used_ocr:
            ocr_n += 1
            print(f"  [OCR] {rel}  ({len(txt)} 字符)")
        ok += 1
        if ok % 100 == 0:
            print(f"  ...已转换 {ok}")

    print(f"\n完成：转换 {ok}（其中 OCR {ocr_n}），跳过已存在 {skip}，失败 {fail}，缺链接 {miss}")
    if missing:
        print("缺链接清单（前 20）：")
        for m in missing[:20]:
            print("   ", m)
        with open(os.path.join(OUT, "_missing_links.txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(missing))


if __name__ == "__main__":
    main()
