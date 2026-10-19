#!/usr/bin/env python3
"""
RBI FEMA Notification 下载器（2024/2025/2026） —— 2026-09-21（稳健版）

中继 api.cors.lol 限流极严：连续两次请求即 429。本脚本对【每次】中继请求
强制留 >=10s 间隔，429 时退避 30s，避免触发连续限流。

页面 BS_FemaNotifications.aspx 默认只渲染最近 ~20 条；切换年份靠 JS 回发
（GetYearMonth 设 hdnYear/hdnMonth 后 click 隐藏 btn=UsrFontCntr$btn）。
  - 2025/2026 直接用已抓到的默认页 HTML（/tmp/rbi_fema.html）解析；
  - 2024 尝试 POST 回发拿全年；若中继不转发 POST / 连续失败，则退化为仅默认页里的 1 条 2024。

输出：<OUT>/<年>/<编号>__<标题>.pdf  +  <OUT>/RBI-FEMA-index.md（含源站 PDF 直链）
断点续传：磁盘已存在则跳过；失败写日志，可重跑补齐。
"""
import os, re, sys, time, json, urllib.parse, urllib.request
from pathlib import Path

OUT = Path("/Users/cora/Desktop/工作/印度税法/源文件/RBI/FEMA Notifications")
OUT.mkdir(parents=True, exist_ok=True)
STATE = OUT / ".rbi_fema_state.json"
REL = "https://api.cors.lol/?url="
DEFAULT_HTML = "/tmp/rbi_fema.html"
PAGE_URL = "https://www.rbi.org.in/Scripts/BS_FemaNotifications.aspx"

_last_req = 0.0
_consec_429 = 0
def rate_limit(gap=10.0):
    """每次中继请求前强制留间隔，避免连续 429。"""
    global _last_req
    dt = time.time() - _last_req
    if dt < gap:
        time.sleep(gap - dt)
    _last_req = time.time()

def relay_fetch(url, method="GET", data=None, retries=8, timeout=70):
    global _consec_429
    rate_limit(10.0)
    relay = REL + urllib.parse.quote(url, safe='')
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(relay, data=data, method=method)
            req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            if data is not None:
                req.add_header("Content-Type", "application/x-www-form-urlencoded")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                _consec_429 = 0
                return r.read(), r.status
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                _consec_429 += 1
                if _consec_429 >= 3:
                    # 连续 3 次 429 → 中继全局限流，长冷却 5 分钟让窗口重置
                    print(f"    [429×{_consec_429}] 中继全局限流，长冷却 300s…", flush=True)
                    time.sleep(300)
                    _consec_429 = 0
                wait = 30 + i * 10
                print(f"    [429] 退避 {wait}s (尝试 {i+1}/{retries})", flush=True)
                time.sleep(wait)
                rate_limit(10.0)
                continue
            print(f"    HTTP {e.code} {e.reason}", flush=True)
            return None, e.code
        except Exception as e:
            last = e
            print(f"    ERR {e} (尝试 {i+1}/{retries})", flush=True)
            time.sleep(15)
    print(f"    [FAIL] 放弃 {url} -> {last}", flush=True)
    return None, 0

def field(html, name):
    m = re.search(r'(?:name|id)="' + re.escape(name) + r'"[^>]*value="([^"]*)"', html)
    return m.group(1) if m else ""

PDF_RE = re.compile(r'rbidocs\.rbi\.org\.in/rdocs/notification/PDFs/[A-Za-z0-9%().]+\.PDF', re.I)

def parse_entries(html):
    """按 <tr> 切块解析：每条通知的 PDF 链接 / 编号 / 标题 / 日期 都在同一 <tr> 内，
    日期在紧邻的上一个 <tr><th> 里。避免跨条目误抓编号。"""
    out = []
    cur_date = ""
    for m in re.finditer(r'<tr>(.*?)</tr>', html, re.S):
        row = m.group(1)
        dm = re.search(r'(\w{3}\s+\d{1,2},\s*\d{4})', row)
        if dm:
            cur_date = dm.group(1)
        if 'rbidocs.rbi.org.in' in row and re.search(r'\.PDF', row, re.I):
            um = re.search(r'href="(https://rbidocs[^"]+\.PDF)"', row, re.I)
            if not um:
                continue
            url = um.group(1)
            nm = re.search(r'(?:Notification No\.|No\.)\s*([^<]{3,80})', row)
            notif = re.sub(r'\s+', ' ', nm.group(1).strip()) if nm else ""
            tt = re.search(r"href=BS_FemaNotifications\.aspx\?Id=\d+\s*>([^<]+)</a>", row)
            title = re.sub(r'\s+', ' ', tt.group(1).strip()) if tt else ""
            ym = re.search(r'(\d{4})-RB', notif)
            if ym:
                year = ym.group(1)
            else:
                ym2 = re.search(r'(20\d{2})', url)
                year = ym2.group(1) if ym2 else "?"
            out.append({"year": year, "notif": notif, "title": title, "date": cur_date, "url": url})
    seen = {}
    for e in out:
        seen.setdefault(e["url"], e)
    return list(seen.values())

def sanitize(s, n=70):
    s = re.sub(r'[\\/:*?"<>|]', '_', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s[:n]

def main():
    entries = []
    if os.path.exists(DEFAULT_HTML):
        html = open(DEFAULT_HTML, encoding='utf-8', errors='ignore').read()
        entries += parse_entries(html)
        print(f"[默认页] 解析到 {len(entries)} 条", flush=True)

    # 尝试 2024 POST（限 3 次，失败丢弃）
    print("[2024] 尝试 POST 回发拿全年列表...", flush=True)
    ph = relay_fetch(PAGE_URL)
    if ph and ph[0]:
        html = ph[0].decode('utf-8', 'ignore')
        vs, vsg, ev = field(html, '__VIEWSTATE'), field(html, '__VIEWSTATEGENERATOR'), field(html, '__EVENTVALIDATION')
        body = urllib.parse.urlencode({
            "__VIEWSTATE": vs, "__VIEWSTATEGENERATOR": vsg, "__EVENTVALIDATION": ev,
            "hdnYear": "2024", "hdnMonth": "0", "UsrFontCntr$btn": "",
        }).encode()
        pr = relay_fetch(PAGE_URL, method="POST", data=body, retries=3)
        if pr and pr[0]:
            y24 = parse_entries(pr[0].decode('utf-8', 'ignore'))
            y24_2024 = [e for e in y24 if e["year"] == "2024"]
            print(f"[2024 POST] 返回 {len(y24)} 条，其中 2024 年 {len(y24_2024)} 条", flush=True)
            if len(y24_2024) > 1:
                entries += y24
            else:
                print("  [!] POST 未返回更多 2024 数据（中继可能未转发 POST），仅用默认页的 2024 条目", flush=True)
        else:
            print("  [!] 2024 POST 失败，跳过", flush=True)
    else:
        print("  [!] 无法取得页面 VIEWSTATE，2024 仅用默认页条目", flush=True)

    by_url = {}
    for e in entries:
        by_url.setdefault(e["url"], e)
    entries = list(by_url.values())
    entries = [e for e in entries if e["year"] in ("2024", "2025", "2026")]
    entries.sort(key=lambda e: (e["year"], e["notif"]))
    print(f"\n[汇总] 待下载 {len(entries)} 个 PDF", flush=True)
    for y in ("2024", "2025", "2026"):
        print(f"  {y}: {sum(1 for e in entries if e['year']==y)}", flush=True)

    state = {}
    if STATE.exists():
        try: state = json.loads(STATE.read_text())
        except: state = {}

    downloaded = skipped = failed = 0
    manifest = []
    for e in entries:
        y, notif, title, url = e["year"], e["notif"], e["title"], e["url"]
        base = f"{sanitize(notif, 40)}__{sanitize(title, 60)}" or sanitize(url, 60)
        d = OUT / y
        d.mkdir(parents=True, exist_ok=True)
        fname = f"{base}.pdf"
        fpath = d / fname
        if fpath.exists() and fpath.stat().st_size > 1000:
            skipped += 1
            manifest.append((y, notif, title, url, fname))
            continue
        print(f"  ↓ {y} {notif} <- {url.split('/')[-1]}", flush=True)
        data, code = relay_fetch(url)
        if data and len(data) > 1000 and data[:4] == b'%PDF':
            fpath.write_bytes(data)
            downloaded += 1
            manifest.append((y, notif, title, url, fname))
            print(f"    ✓ {fname} ({len(data)//1024}KB)", flush=True)
        else:
            failed += 1
            print(f"    ✗ 失败 code={code} len={len(data) if data else 0}", flush=True)
        time.sleep(10)

    rows = ["| 年份 | 编号 | 标题 | 源站链接 | 本地文件 |",
            "| --- | --- | --- | --- | --- |"]
    for y, notif, title, url, fname in manifest:
        rows.append(f"| {y} | {notif} | {title} | [PDF]({url}) | {fname} |")
    head = (f"# RBI FEMA Notifications 索引（2024–2026）\n\n生成：{time.strftime('%Y-%m-%d %H:%M')}  \n"
            f"来源：https://www.rbi.org.in/Scripts/BS_FemaNotifications.aspx  \n"
            f"共 {len(manifest)} 个 PDF（{downloaded} 新下 / {skipped} 已存在 / {failed} 失败）\n\n")
    (OUT / "RBI-FEMA-index.md").write_text(head + "\n".join(rows) + "\n", encoding="utf-8")
    STATE.write_text(json.dumps({"updated": time.strftime('%Y-%m-%d %H:%M'), "count": len(manifest)}, indent=2))

    print(f"\n[完成] 新下 {downloaded} / 跳过 {skipped} / 失败 {failed}", flush=True)
    print(f"索引：{OUT/'RBI-FEMA-index.md'}", flush=True)

if __name__ == "__main__":
    main()
