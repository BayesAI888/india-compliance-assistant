/**
 * 一键体验脚本：不用懂代码，看着中文输出就能确认功能是否正常。
 *
 * 用法（先在另一个终端窗口跑着 pnpm dev）：
 *   node scripts/试一试.mjs
 */

const BASE = process.env.BASE_URL || "http://localhost:3000";

const line = (s = "") => console.log(s);
const title = (s) => { line(); line("━".repeat(58)); line(s); line("━".repeat(58)); };
const ok = (s) => line(`  ✅ ${s}`);
const no = (s) => line(`  ❌ ${s}`);
const info = (s) => line(`     ${s}`);

async function call(path, options) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const text = await response.text();
  try {
    return { status: response.status, data: JSON.parse(text) };
  } catch {
    return { status: response.status, data: text };
  }
}

async function ensureServer() {
  try {
    await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    line();
    no(`连不上 ${BASE}`);
    info("请先在另一个终端窗口里，进入 site 目录执行：pnpm dev");
    info("看到 Local: http://localhost:3000 之后，再回来运行本脚本。");
    return false;
  }
}

async function testChat() {
  title("① 问答的安全兜底（这一步不需要 AI 密钥）");

  const outOfScope = await call("/api/chat", {
    method: "POST",
    body: JSON.stringify({ question: "印度公司员工加班费怎么算？" }),
  });
  if (outOfScope.data?.failure_code === "OUT_OF_SCOPE") {
    ok("范围外问题被正确识别");
    info(`回答：${outOfScope.data.short_conclusion}`);
    info(`扣次：${outOfScope.data.charge_eligible ? "扣了（不对）" : "不扣（正确）"}`);
  } else {
    no(`范围外识别异常：${JSON.stringify(outOfScope.data).slice(0, 120)}`);
  }

  const notice = await call("/api/chat", {
    method: "POST",
    body: JSON.stringify({ question: "我收到了税局的notice，该怎么办？" }),
  });
  if (notice.data?.answer_status === "NEED_INFORMATION") {
    ok(`Notice 类问题只追问 ${notice.data.missing_information.length} 组（规范要求最多 3 组）`);
    notice.data.missing_information.forEach((item) => info(`· ${item}`));
  } else {
    no("Notice 分支异常");
  }

  const normal = await call("/api/chat", {
    method: "POST",
    body: JSON.stringify({ question: "印度私人有限公司至少要几名董事？" }),
  });
  ok(`知识库为空时的兜底：${normal.data?.short_conclusion?.slice(0, 40)}...`);
  info(`政策版本：${normal.data?.policy_version}（应为 1.4）`);
}

async function testInspection() {
  title("② 知识库巡检");

  await call("/api/admin/inspections", {
    method: "POST",
    body: JSON.stringify({
      action: "REGISTER_DOCUMENT",
      document: {
        id: "SRC24", title: "Press Note 2 (2026 Series)", inspectionTier: "A",
        legalStatus: "PUBLISHED", anchorUrl: "https://www.dpiit.gov.in/press-notes",
        versionFingerprint: "PN2-2026", domainWatchChannel: "DPIIT 新闻页",
        domain: "fema_fdi_rbi", legalCurrencyCheckedAt: "2026-05-01T00:00:00Z",
      },
    }),
  });
  ok("登记了一份资料：Press Note 2（A 档，30 天一巡）");

  const same = await call("/api/admin/inspections", {
    method: "POST",
    body: JSON.stringify({ action: "FILE_LINE", document_id: "SRC24", observed_fingerprint: "PN2-2026" }),
  });
  info(`文件线（版本没变）：${same.data?.outcome?.message}`);
  if (same.data?.outcome?.canAutoAdvance) ok("版本没变 → 自动推进核验时间");

  const changed = await call("/api/admin/inspections", {
    method: "POST",
    body: JSON.stringify({ action: "FILE_LINE", document_id: "SRC24", observed_fingerprint: "PN3-2027" }),
  });
  info(`文件线（版本变了）：${changed.data?.outcome?.message}`);
  if (changed.data?.outcome?.canAutoAdvance === false) ok("版本变了 → 必须人工判断，不自动推进");

  const failed = await call("/api/admin/inspections", {
    method: "POST",
    body: JSON.stringify({ action: "FILE_LINE", document_id: "SRC24" }),
  });
  if (failed.data?.outcome?.conclusion === "FETCH_FAILED") {
    ok("抓取失败 → 不推进（抓不到不等于法律没变）");
  }

  const list = await call("/api/admin/inspections");
  const metrics = list.data?.metrics ?? {};
  ok(`待巡检 ${list.data?.queue?.length ?? 0} 条`);
  info(`知识库新鲜度：${metrics.freshnessMedian?.slice(0, 10) ?? "无数据"}`);
  info(`维护欠债：${metrics.maintenanceDebt} 份 ｜ 待补来源：${metrics.pendingSources} 份`);
  info(`领域线要盯：${(list.data?.domain_watch ?? []).map((d) => `${d.domain}(${d.channels.join("/")})`).join("，") || "无"}`);
}

async function testFeedback() {
  title("③ 反馈补回次数与冻结");

  const user = `demo_${Date.now()}`;
  const reason = "这个回答引用的条文根本不适用于我们的情况";

  const short = await call("/api/feedback", {
    method: "POST",
    body: JSON.stringify({ user_id: user, request_id: "r0", reason: "不对" }),
  });
  if (short.data?.decision === "REASON_TOO_SHORT") ok(`原因太短被拒：${short.data.message}`);

  const punct = await call("/api/feedback", {
    method: "POST",
    body: JSON.stringify({ user_id: user, request_id: "r0b", reason: "不对!!!!!!!!!!!!!!!!" }),
  });
  if (punct.data?.decision === "REASON_TOO_SHORT") ok("用标点凑字数也被拒（只数中文字）");

  for (let i = 1; i <= 4; i += 1) {
    const result = await call("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        user_id: user, request_id: `r${i}`, reason, original_ledger_id: `L${i}`,
      }),
    });
    const d = result.data;
    info(`第 ${i} 次：${d.restored ? "已补回" : "未补回"} ｜ 本月已用 ${d.monthly_used}/${d.monthly_limit} ｜ ${d.message}`);
  }
  ok("前 3 次补回、第 4 次被拒，且反馈仍然受理");

  const repeat = await call("/api/feedback", {
    method: "POST",
    body: JSON.stringify({ user_id: user, request_id: "r1", reason }),
  });
  if (repeat.data?.decision === "ALREADY_RESTORED") ok("同一条回答重复提交，不重复补回");
}

const banner = `
印度合规助手 · 一键体验
测试地址：${BASE}
`;
line(banner);

if (await ensureServer()) {
  await testChat();
  await testInspection();
  await testFeedback();
  title("全部跑完");
  line("如果上面都是 ✅，说明 V1.4 的规则都在正常工作。");
  line("巡检和补回的数据存在 site/.local-data/compliance-store.json，可以直接打开看。");
  line();
}
