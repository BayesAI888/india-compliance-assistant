#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
citation_gate.py — 案例草稿「援引溯源」入库闸门
============================================================
用途
----
在草稿入库（上传知识库 / 进 RAG）前，逐篇核验草稿里提到的
    ① 法条（Section / Article / Rule / Schedule + 条号）
    ② 援引案例（X vs Y 之类案名）
是否都能在**对应的原始 HTML**（raw/<docid>.html）里找到。
凡“源文查无”者 → 列为【拦截项】，提示人工删除或改注，
避免模型臆造的法条/案例进入知识库（RAG 会把它当“本案认定”呈现，误导合规判断）。

⚠️ 关键设计（血泪教训，勿改回精确匹配）
--------------------------------------
IndianKanoon 的 HTML 是扫描件，OCR 噪声极大：
  - `ITR` 常被 OCR 成 `1TR` / `UR` / `ITF` / `1TF`
  - 案号 `4803/2021` 文中写作 `4803 of 2021`；`615-620` 写作 `615 to 620`
  - 条号常只写基础号（MD 写 `271(1)(c)`，文里可能只有 `271`）
因此**绝不能**用精确串匹配判“缺失”（会误报一片）。
本脚本对法条用「整串 → 基础条号+上下文」两级匹配；对案例用「整串 → 区分性关键词」。
注意：两张文本要分开——`hs`（带空格，供词边界/邻近匹配）与 `ht`（紧排，供子串/上下文匹配）。
曾把紧排文本误传给词边界匹配，导致回退失效、多报 4 项。

用法
----
    python3 citation_gate.py                       # 默认查 ./案例库_草稿 vs ./raw
    python3 citation_gate.py --md-dir X --raw-dir Y
    python3 citation_gate.py --strict              # 有拦截项则退出码=1（CI / 入库钩子用）
    python3 citation_gate.py --report out.csv      # 导出台账
    python3 citation_gate.py --only 138432220,41727579
    python3 citation_gate.py --types 法条,案例      # 默认就这两类；案号/引证噪音大，需要再加

退出码：0 = 通过；1 = 有拦截项（仅当 --strict）；2 = 参数/环境错误。
"""
import argparse
import csv
import html
import os
import re
import sys
from collections import Counter

# ---------------------------------------------------------------- 归一化
def tight(s: str) -> str:
    """小写 + 只保留 [a-z0-9()]，用于“整串包含 / 上下文”匹配。"""
    s = s.lower().replace("\u2019", "'").replace("\u2018", "'")
    s = s.replace("\u201c", '"').replace("\u201d", '"')
    return re.sub(r"[^a-z0-9()]", "", s)


STOP = set("""ltd pvt private limited co company corporation corp corpn inc llp the and of for
vs versus ms shri sri smt dr mr mrs ors anr others india indian mumbai delhi new chennai
bangalore bengaluru kolkata calcutta bombay karnataka maharashtra gujarat rajasthan punjab
haryana pradesh telangana kerala tribunal appellate court high supreme commissioner income
tax customs excise service goods central state union authority office circle ward bench sons
brothers enterprises industries traders trading exports imports international national general
standard united assessee appellant respondent petitioner plaintiff defendant matter matters
case cases order orders appeal appeals section rule article schedule clause act regulations
rules no nos dated""".split())


def strong_tokens(s: str):
    return [t for t in re.findall(r"[A-Za-z]{4,}", s) if t.lower() not in STOP]


def wb(s: str):
    return re.compile(r"(?<![0-9A-Za-z])" + re.escape(s) + r"(?![0-9A-Za-z])")


def near(t: str, a: str, b: str, win: int = 80) -> bool:
    for m in wb(a).finditer(t):
        if wb(b).search(t[max(0, m.start() - win): m.end() + win]):
            return True
    return False


# ---------------------------------------------------------------- 抽取
PROV_RE = re.compile(
    r"\b(?:Section|Sec\.?|S\.|Article|Art\.?|Rule|Schedule|Clause)\s*"
    r"(\d+[A-Za-z]*(?:\s*\([0-9A-Za-z]+\))*)", re.I)
PROV_ENUM_RE = re.compile(          # 枚举式：Section 133(6)、194C、194H
    r"\b(?:Section|Sec\.?|S\.)\s*(\d+[A-Za-z]*(?:\([0-9A-Za-z]+\))*)"
    r"((?:\s*[、,，/]\s*\d+[A-Za-z]*(?:\([0-9A-Za-z]+\))*)+)")
CASE_RE = re.compile(
    r"([A-Z][A-Za-z0-9&.,()'\- ]{2,70}?)\s+(?:vs\.?|v\.s\.?|versus)\s+"
    r"([A-Z][A-Za-z0-9&.,()'\- ]{2,70})")
REPORTER_RE = re.compile(
    r"\b(\d{1,4})\s*(ITR|ELT|taxmann\.?\s?com|Taxman|SCC|SCR|STC|GST|SOT|CompCas|ComCas|VST)\s*(\d{1,5})\b",
    re.I)
SLASH1_RE = re.compile(r"\b(\d{1,4}(?:\s*[&\-,\u2013]\s*\d{1,4})*)\s*/\s*([A-Za-z]{1,4})\s*/\s*(\d{2,4})")
SLASH2_RE = re.compile(r"\b(\d{1,5})\s*/\s*(\d{4})\b")


def extract_items(md: str, types):
    """returns list of (类型, 引文)"""
    out = []
    if "法条" in types:
        provs = [re.sub(r"\s+", "", m.group(1)) for m in PROV_RE.finditer(md)]
        for m in PROV_ENUM_RE.finditer(md):
            for tok in re.split(r"[、,，/]", m.group(2)):
                tok = re.sub(r"\s+", "", tok)
                if tok:
                    provs.append(tok)
        for p in dict.fromkeys(provs):
            out.append(("法条", p))
    if "案例" in types:
        seen = set()
        for a, b in CASE_RE.findall(md):
            a, b = a.strip(), b.strip()
            ph = f"{a} vs {b}"
            k = tight(ph)
            if k and k not in seen:
                seen.add(k)
                out.append(("案例", ph))
    if "引证" in types:
        for v, code, pg in REPORTER_RE.findall(md):
            out.append(("引证", f"{v} {code} {pg}"))
    if "案号" in types:
        for m in SLASH1_RE.finditer(md):
            out.append(("案号", m.group(0).strip()))
        for m in SLASH2_RE.finditer(md):
            out.append(("案号", m.group(0).strip()))
    return out


# ---------------------------------------------------------------- HTML 文本
def html_texts(path: str):
    """返回 (hs 带空格小写文本, ht 紧排文本)。"""
    d = open(path, encoding="utf-8", errors="ignore").read()
    d = re.sub(r"<script[\s\S]*?</script>", " ", d, flags=re.I)
    d = re.sub(r"<style[\s\S]*?</style>", " ", d, flags=re.I)
    hs = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", d))).lower()
    return hs, tight(hs)


# ---------------------------------------------------------------- 匹配
# 条号里的字母易被 OCR 认错：B↔8/6/0、O↔0、I↔1/l、S↔5、Z↔2、G↔6、D↔0、
# A↔4、E↔3、C↔6/0、T↔7、Q↔9、U↔0。用于识别被 OCR 败坏的条号（如 92B→928/920）。
_OCR_CONF = {
    "b": ["b", "8", "6", "0"], "o": ["o", "0"], "i": ["i", "1"], "l": ["l", "1"],
    "s": ["s", "5"], "z": ["z", "2"], "g": ["g", "6"], "d": ["d", "0"],
    "a": ["a", "4"], "e": ["e", "3"], "c": ["c", "6", "0"], "t": ["t", "7"],
    "q": ["q", "9"], "u": ["u", "0"],
}


def ocr_variants_base(base: str):
    """把 '92B' / '92CA' 这类“数字+字母”的基础条号，生成 OCR 混淆变体（不含原串以外时返回原串）。"""
    m = re.match(r"^(\d+)([A-Za-z]*)$", base)
    if not m or not m.group(2):
        return {base.lower()}
    import itertools
    digits, letters = m.group(1), m.group(2).lower()
    opts = [_OCR_CONF.get(ch, [ch]) for ch in letters]
    out = set()
    for combo in itertools.product(*opts):
        out.add(digits + "".join(combo))
        if len(out) > 24:
            break
    out.add(base.lower())
    return out


def prov_found(core: str, ht: str):
    if tight(core) in ht:
        return True, "完整"
    m = re.match(r"(\d+[A-Za-z]*)", core)
    if not m:
        return False, ""
    base = m.group(1).lower()
    rest = core[len(m.group(1)):]
    for ctx in ("section" + base, "sec" + base, base + "(", "article" + base,
                "rule" + base, "schedule" + base, "clause" + base, base + "ofthe"):
        if ctx in ht:
            return True, "部分:" + ctx
    # OCR 变体：如 MD 写 92B，文里是 928/920。
    # 注意：rest 为空时（如 92B）**不能**用裸子串判定（会把无关数字 1928 之类误判为命中），
    # 必须落在条号上下文里（section928 / 928( …）。
    for v in ocr_variants_base(base):
        if v == base:
            continue
        if rest and tight(v + rest) in ht:
            return True, "OCR变体:" + v
        for ctx in ("section" + v, "sec" + v, v + "(", "article" + v,
                    "rule" + v, "schedule" + v, "clause" + v):
            if ctx in ht:
                return True, "OCR变体:" + v
    return False, ""


def name_found(party: str, ht: str):
    if tight(party) in ht:
        return True, "整串"
    hits = [t for t in strong_tokens(party) if len(t) >= 5 and tight(t) in ht]
    if hits:
        return True, "词:" + ",".join(hits[:3])
    return False, ""


def item_found(typ: str, text: str, hs: str, ht: str):
    """返回 (状态, 说明)；状态 ∈ 命中 / 命中(变体) / 拦截 / 跳过"""
    if typ == "法条":
        ok, how = prov_found(text, ht)
        if not ok:
            return "拦截", "源文无此条号"
        return ("命中(OCR)", how) if how.startswith("OCR变体") else ("命中", how)
    if typ == "案例":
        a, _, b = text.partition(" vs ")
        fa, ha = name_found(a, ht)
        fb, hb = name_found(b, ht)
        if fa or fb:
            return "命中", (("A:" + ha) if fa else "") + (("B:" + hb) if fb else "")
        if not strong_tokens(a) and not strong_tokens(b):
            return "跳过", "泛化主体(无区分性关键词)"
        return "拦截", "案名在源文无匹配"
    if typ == "引证":
        nums = re.findall(r"\d{2,4}", text)
        if tight(text) in ht:
            return "命中", "整串"
        if len(nums) >= 2 and near(hs, nums[0], nums[-1]):
            return "命中(变体)", f"{nums[0]}≈{nums[-1]} 邻近"
        return "拦截", "报告引证在源文无匹配"
    if typ == "案号":
        parts = re.findall(r"\d+", text)
        if parts and all(wb(p).search(hs) for p in parts):
            return "命中(变体)", "各数字词边界出现(of/to 分隔)"
        return "拦截", "案号在源文无匹配"
    return "跳过", "未知类型"


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(description="案例草稿援引溯源入库闸门")
    ap.add_argument("--md-dir", default=None, help="草稿目录（默认脚本旁的 案例库_草稿）")
    ap.add_argument("--raw-dir", default=None, help="原始 HTML 目录（默认脚本旁的 raw）")
    ap.add_argument("--report", default=None, help="导出台账 CSV 路径")
    # 默认只查「法条 + 案例」——正是“援引案例和法条”的范畴。
    # 引证/案号噪音大（含日期、表单号、他案上诉号），需要时再显式加：--types 法条,案例,引证,案号
    ap.add_argument("--types", default="法条,案例", help="要核验的类型，逗号分隔（默认 法条,案例）")
    ap.add_argument("--only", default=None, help="只查指定 docid，逗号分隔")
    ap.add_argument("--strict", action="store_true", help="有拦截项则退出码=1")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    md_dir = args.md_dir or os.path.join(here, "案例库_草稿")
    raw_dir = args.raw_dir or os.path.join(here, "raw")
    types = [t.strip() for t in args.types.split(",") if t.strip()]

    if not os.path.isdir(md_dir):
        print(f"[错误] 草稿目录不存在：{md_dir}", file=sys.stderr); return 2
    if not os.path.isdir(raw_dir):
        print(f"[错误] raw 目录不存在：{raw_dir}", file=sys.stderr); return 2

    mds = sorted(f for f in os.listdir(md_dir) if f.endswith(".md"))
    only = set(args.only.split(",")) if args.only else None

    rows, block, missing_html, stats = [], [], [], Counter()
    n_checked = 0
    for fn in mds:
        stem = os.path.splitext(fn)[0]
        m = re.match(r"(\d{3,})", stem)          # 兼容 <docid>.md 与 <docid>_标题.md
        docid = m.group(1) if m else stem
        if only and docid not in only:
            continue
        hp = os.path.join(raw_dir, docid + ".html")
        if not os.path.exists(hp):
            missing_html.append(docid); continue
        hs, ht = html_texts(hp)
        md = open(os.path.join(md_dir, fn), encoding="utf-8", errors="ignore").read()
        n_checked += 1
        for typ, text in extract_items(md, types):
            st, why = item_found(typ, text, hs, ht)
            stats[st] += 1
            if st == "拦截":
                block.append((docid, typ, text))
            rows.append((docid, typ, text, st, why))

    total = (stats["命中"] + stats["命中(变体)"] + stats["命中(OCR)"]
             + stats["拦截"] + stats["跳过"])
    hit = stats["命中"] + stats["命中(变体)"] + stats["命中(OCR)"]
    print("=" * 60)
    print("援引溯源闸门结果")
    print("=" * 60)
    print(f"核验草稿 : {n_checked} 篇" + (f"（缺 HTML：{missing_html}）" if missing_html else ""))
    print(f"核验项   : {total}")
    print(f"  命中         : {stats['命中']}")
    print(f"  命中(变体/OCR): {stats['命中(变体)']}")
    print(f"  命中(条号OCR) : {stats['命中(OCR)']}  （如 92B 在文里被扫成 928）")
    print(f"  跳过         : {stats['跳过']}（泛化主体，无区分性关键词）")
    print(f"  拦截         : {stats['拦截']}  <-- 源文查无，需人工处理")
    if total:
        print(f"可定位率 : {hit / total * 100:.2f}%")
    if block:
        print("\n【拦截清单】")
        for d, t, x in block:
            print(f"  [{t}] {d}: {x}")

    if args.report:
        with open(args.report, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f); w.writerow(["docid", "类型", "引文", "结果", "说明"])
            w.writerows(rows)
        print(f"\n台账已导出：{args.report}")

    if stats["拦截"] > 0:
        if args.strict:
            print(f"\n[FAIL] 存在 {stats['拦截']} 项源文查无的援引，已阻断入库。", file=sys.stderr)
            return 1
        print(f"\n[WARN] 存在 {stats['拦截']} 项源文查无的援引，建议人工处理。")
        return 0
    print("\n[PASS] 无源文查无的援引。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
