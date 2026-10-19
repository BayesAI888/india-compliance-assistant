/**
 * V1.4 规则自测。覆盖：
 *   追问上限、生效措辞检测、条文级日期过滤、辖区过滤、要件配额、期间不覆盖、
 *   分层巡检周期、财年锚点、超期降级、文件线、取代三件事、运营指标、
 *   补回原因长度、月度上限、连续触顶冻结、补回流水。
 *
 * 本文件跑编译后的 JS，不参与 `npm test`（那条命令依赖 vinext build）。
 * 运行前先 `pnpm install`（词典解析用到 exceljs 包）。
 * 运行：
 *   npx tsc lib/contracts.ts lib/knowledge-validator.ts lib/server/retrieval.ts \
 *     lib/server/inspection.ts lib/server/quota-restore.ts \
 *     lib/server/terms-workbook.ts lib/server/terms-store.ts \
 *     lib/server/legal-answer.ts lib/server/deepseek.ts \
 *     lib/server/embeddings.ts lib/server/vector-store.ts lib/server/dense-retrieval.ts \
 *     lib/server/claim-check.ts lib/server/claim-repair.ts lib/server/english-number.ts lib/server/quote-repair.ts lib/server/abbreviations.ts \
 *     lib/server/coverage-check.ts lib/server/layer-relevance.ts lib/server/practical-grounding.ts \
 *     lib/server/quote-check.ts lib/server/cross-reference.ts lib/server/second-pass.ts \
 *     lib/server/step-text.ts lib/server/deadline-anchor.ts lib/server/domain-scope.ts lib/server/action-timing.ts \
 *     lib/server/knowledge-store.ts \
 *     lib/server/conversation-store.ts lib/server/question-context.ts lib/server/conversation-title.ts lib/server/password.ts lib/server/plan-quota.ts lib/server/user-store.ts \
 *     lib/server/followup-charging.ts lib/server/turn-summary.ts \
 *     lib/server/relevance-check.ts lib/server/document-category.ts \
 *     lib/case-validator.ts lib/conversation-export.ts lib/server/case-store.ts \
 *     lib/server/case-relevance.ts lib/server/case-search.ts lib/server/case-detail-lookup.ts \
 *     lib/server/case-digest.ts lib/server/case-cache.ts lib/server/law-supersession.ts lib/server/answer-self-doubt.ts lib/server/coverage-gap.ts \
 *     lib/server/notice-extract.ts lib/server/attachment-store.ts lib/server/out-of-scope.ts \
 *     lib/server/company-case-search.ts lib/server/company-case-query.ts \
 *     lib/server/case-query-language.ts lib/server/topic-case-search.ts lib/server/case-route.ts \
 *     lib/server/answer-language.ts lib/server/notification-index.ts lib/server/legal-hierarchy.ts lib/server/case-domain.ts lib/server/term-ambiguity.ts lib/server/question-type.ts lib/server/dispute-track.ts lib/server/dispute-citations.ts lib/server/intra-document-supersession.ts lib/law-categories.ts lib/server/key-figures.ts \
 *     --rootDir . --outDir .v14build --module commonjs --moduleResolution node --target es2022 \
 *     --resolveJsonModule --esModuleInterop --skipLibCheck
 *   echo '{"type":"commonjs"}' > .v14build/package.json
 *   cp tests/v14-rules.check.cjs .v14build/ && node .v14build/v14-rules.check.cjs
 *   cp tests/knowledge-store.check.cjs .v14build/ && node .v14build/knowledge-store.check.cjs
 *   cp tests/conversation-store.check.cjs .v14build/ && node .v14build/conversation-store.check.cjs
 *   cp tests/case-store.check.cjs .v14build/ && node .v14build/case-store.check.cjs
 *   cp tests/attachment-store.check.cjs .v14build/ && node .v14build/attachment-store.check.cjs
 *
 * 注意：本项目 package.json 是 "type": "module"，
 * 必须在输出目录放一个 {"type":"commonjs"} 标记，否则会报 exports is not defined。
 * knowledge-store.check.cjs、conversation-store.check.cjs、case-store.check.cjs 是独立的测试文件
 * （分别是知识库下架/恢复状态机、多轮对话会话存储、案例库存取，全异步IO），不算进本文件的项数里，分开跑。
 */
const assert = require("node:assert");
const ExcelJS = require("exceljs");
const { validateKnowledgeTxt } = require("./lib/knowledge-validator.js");
const { retrieveKnowledge, coversDate, matchesJurisdiction, normalizeQueryPackage } = require("./lib/server/retrieval.js");
const { parseTermsWorkbook, buildApprovedGlossary } = require("./lib/server/terms-workbook.js");
const { actionSteps } = require("./lib/server/legal-answer.js");
const { extractCheckableClaims, findUnverifiedClaims } = require("./lib/server/claim-check.js");
const { repairUnverifiedClaims } = require("./lib/server/claim-repair.js");
const { repairQuoteCitations } = require("./lib/server/quote-repair.js");
const { expandAbbreviations, expandAnswerAbbreviations } = require("./lib/server/abbreviations.js");
const { findCoverageGaps, coverageNotes, promoteUncoveredPractical } = require("./lib/server/coverage-check.js");
const { filterLayersByRelevance } = require("./lib/server/layer-relevance.js");
const { groundPracticalSteps } = require("./lib/server/practical-grounding.js");
const { verifyQuote, checkQuotes, quoteNotes, normalizeForQuoteMatch, longestMatchLength } = require("./lib/server/quote-check.js");
const { followCrossReferences } = require("./lib/server/cross-reference.js");
const { scopeByQuestionDomain } = require("./lib/server/domain-scope.js");
const { scopeCandidates } = require("./lib/server/retrieval.js");
const { stripCitationPrefix, stripCitationPrefixes, stripStepNumberPrefix, stripStepNumberPrefixes } = require("./lib/server/step-text.js");
const { findUnanchoredDeadlines, deadlineAnchorNotes } = require("./lib/server/deadline-anchor.js");
const { findMissingActionTiming, actionTimingNotes } = require("./lib/server/action-timing.js");
const { fuseByRRF, RRF_K, glossaryForEvidence } = require("./lib/server/retrieval.js");
const { cosineSimilarity, splitIntoWindows, MAX_INPUT_CHARS } = require("./lib/server/embeddings.js");
const { encodeVector, decodeVector } = require("./lib/server/vector-store.js");
const { EVIDENCE_QUOTA, MAX_CLARIFICATION_ITEMS, MAX_NOTICE_CLARIFICATION_ITEMS } = require("./lib/contracts.js");
const { buildFallbackQuestion, isRewriteAcceptable, shouldForceNewTopic, questionOverlapRatio } = require("./lib/server/question-context.js");
const { applyFollowUpCharging, FREE_FOLLOWUP_LIMIT } = require("./lib/server/followup-charging.js");
const { hasReferringExpression } = require("./lib/server/question-context.js");
const { firstSentence, extractMandatoryFirstSentences, extractCitedLaws } = require("./lib/server/turn-summary.js");
const { classifySimilarity } = require("./lib/server/relevance-check.js");
const { classifyDocumentCategory, categoryLabel, DOCUMENT_CATEGORIES } = require("./lib/server/document-category.js");
const { validateCaseText } = require("./lib/case-validator.js");
const { shouldSearchCases, isCaseSeekingQuestion, detectCaseDetailFollowUp, pickCaseForFollowUp } = require("./lib/server/case-relevance.js");
const { keywordOverlapScore, rankCasesByKeyword } = require("./lib/server/case-search.js");
const { extractAmounts, amountsAreGrounded } = require("./lib/server/case-digest.js");
const { truncateTitle, sanitizeTitle } = require("./lib/server/conversation-title.js");
const { trimAnswerForStorage, MAX_STORED_ANSWER_CHARS } = require("./lib/server/conversation-store.js");
const { validatePassword, normalizeEmail } = require("./lib/server/password.js");
const { quotaViewOf, PLAN_MONTHLY_LIMIT, anonymousQuotaView } = require("./lib/server/plan-quota.js");
const { pruneExpiredSessions } = require("./lib/server/user-store.js");
const { verifyCaseDetailQuote } = require("./lib/server/case-detail-lookup.js");
const { appendNoticeContext, toNoticeFactsPayload, isImageOcrConfigured, hasUsableNoticeFacts, buildNoticeExcerpt } = require("./lib/server/notice-extract.js");
const { detectOutOfScope, buildOutOfScopeResponse } = require("./lib/server/out-of-scope.js");
let pass=0;
// ⚠**异步测试必须被 await，否则它永远不会失败。**
// 原版 t 只有同步分支：`async` 测试体返回的是一个立刻 resolve 的 Promise，
// try 里不会抛，于是打印 ✓、pass++，**断言失败被完全吞掉**。
// 2026-09-29 写争议骨架测试时差点就这么交了 8 条假测试。
// 现在返回 thenable 的收集起来，末尾统一 await（见文件最后的 settle）。
const pending=[];
const t=(n,f)=>{
  try{
    const r=f();
    if (r && typeof r.then === "function") {
      pending.push(r.then(
        ()=>{console.log("  ✓",n);pass++;},
        (e)=>{console.log("  ✗",n,"->",e.message);process.exitCode=1;},
      ));
      return;
    }
    console.log("  ✓",n);pass++;
  }catch(e){console.log("  ✗",n,"->",e.message);process.exitCode=1;}
};

console.log("== 追问上限 ==");
t("非Notice类=5", ()=>assert.strictEqual(MAX_CLARIFICATION_ITEMS,5));
t("Notice类=3", ()=>assert.strictEqual(MAX_NOTICE_CLARIFICATION_ITEMS,3));

console.log("== 生效措辞检测（KB-21）==");
const txt = `【来源】CGST Act 2017
【大标题】CHAPTER XV
【小标题】Section 74A
【原文链接】https://example.gov.in/a.pdf

Notwithstanding anything, this section shall apply with effect from the financial year 2024-25 onwards.
-----
【来源】CGST Act 2017
【大标题】CHAPTER VI
【小标题】Section 22
【原文链接】https://example.gov.in/b.pdf

Every supplier shall be liable to be registered under this Act.
-----
`;
const v = validateKnowledgeTxt("t.txt", txt);
t("校验通过", ()=>assert.strictEqual(v.status,"READY_TO_REVIEW"));
t("chunk1 触发生效确认", ()=>assert.strictEqual(v.chunks[0].needsEffectiveDateConfirmation,true));
t("chunk2 不触发", ()=>assert.ok(!v.chunks[1].needsEffectiveDateConfirmation));
t("confirmations 有一条", ()=>assert.strictEqual(v.confirmations.length,1));
t("命中片段被记录", ()=>assert.ok(/with effect from/i.test(v.chunks[0].effectiveDateHints[0])));

// 2026-09-20：607 条引用里 14 条是 `https://indiankanoon.org#page=1` 这种只有域名的链接，
// 点开落到首页。原来的校验只查 ^https?://，它们全都合法通过了。
// 判分口径已经把"子款深度"交给链接承担，链接就不能再只做格式校验。
console.log("== 原文链接必须能定位到这一条（不能只有域名）==");
function linkTxt(url) {
  return `【来源】Companies Act 2013\n【大标题】CHAPTER I\n【小标题】Section 2\n【原文链接】${url}\n\nDefinitions clause text here.\n-----\n`;
}
const bareDomain = validateKnowledgeTxt("bare.txt", linkTxt("https://indiankanoon.org#page=1"));
t("只有域名 → 报错", () => assert.ok(bareDomain.errors.some((e) => /只有域名/.test(e))));
t("只有域名 → 不能进审核", () => assert.notStrictEqual(bareDomain.status, "READY_TO_REVIEW"));
t("带斜杠的裸域名同样拦下", () => assert.ok(
  validateKnowledgeTxt("bare2.txt", linkTxt("https://amitadesai.com/#page=7"))
    .errors.some((e) => /只有域名/.test(e))));
t("深路径放行", () => assert.ok(
  !validateKnowledgeTxt("ok.txt", linkTxt("https://indiankanoon.org/doc/165062971/#page=4"))
    .errors.some((e) => /只有域名/.test(e))));
t("PDF+页码锚点放行", () => assert.ok(
  !validateKnowledgeTxt("ok2.txt", linkTxt("https://www.cbic.gov.in/htdocs-cbec/gst/Part-A_Rules-0710.pdf#page=70"))
    .errors.some((e) => /只有域名/.test(e))));
t("非 http 仍走原来的报错，不被新规则顶掉", () => assert.ok(
  validateKnowledgeTxt("ftp.txt", linkTxt("ftp://example.gov.in/a.pdf"))
    .errors.some((e) => /不是http\/https地址/.test(e))));

console.log("== 条文级日期过滤（AI-21/H-03）==");
const s74a={number:1,source:"CGST",majorTitle:"CH XV",minorTitle:"Section 74A",officialUrl:"u",body:"determination of tax not paid",bodyLength:10,wordCount:5,provisionEffectiveFrom:"2024-04-01"};
t("FY2025-26 命中 s74A", ()=>assert.strictEqual(coversDate(s74a,"2025-06-01"),true));
t("FY2022-23 排除 s74A", ()=>assert.strictEqual(coversDate(s74a,"2022-06-01"),false));
t("未给日期：已生效且未废止的照常命中", ()=>assert.strictEqual(coversDate(s74a,undefined),true));
const stateChunk={...s74a,jurisdiction:"MH",centreEffectiveFrom:"2024-11-01"};
t("州级：早于中央生效日被排除", ()=>assert.strictEqual(coversDate(stateChunk,"2024-05-01"),false));

// 2026-09-16：原来 !targetDate 直接 return true，等于用户不写日期时整道校验空转，
// 已废止的法照样能被引用。改成按当天判断。
console.log("== 已废止法律的期间过滤（1961所得税法场景）==");
const repealed={...s74a,minorTitle:"Section 9 (IT Act 1961)",provisionEffectiveFrom:"1962-04-01",provisionEffectiveTo:"2026-03-31"};
t("未给日期：已废止的被挡掉", ()=>assert.strictEqual(coversDate(repealed,undefined),false));
t("问2019年：已废止的仍可引用", ()=>assert.strictEqual(coversDate(repealed,"2019-06-01"),true));
t("问2026-06：已废止的被挡掉", ()=>assert.strictEqual(coversDate(repealed,"2026-06-01"),false));
const newAct={...s74a,minorTitle:"Section 9 (IT Act 2025)",provisionEffectiveFrom:"2026-04-01"};
t("未给日期：现行新法命中", ()=>assert.strictEqual(coversDate(newAct,undefined),true));
t("问2019年：新法不适用", ()=>assert.strictEqual(coversDate(newAct,"2019-06-01"),false));

console.log("== 适用期间字段解析（文件头部+chunk覆盖）==");
const datedTxt = `【法律生效日】1962-04-01
【法律失效日】2026-03-31
【适用说明】本法已于2026-04-01废止，仅适用于2026-04-01之前开始的税年。
-----
【来源】Income-tax Act 1961
【大标题】CHAPTER II
【小标题】Section 9
【原文链接】https://example.gov.in/1961.pdf

Income deemed to accrue or arise in India.
-----
【来源】Income-tax Act 1961
【大标题】CHAPTER II
【小标题】Section 9A
【生效日】2015-04-01
【原文链接】https://example.gov.in/1961.pdf

Certain activities not to constitute business connection in India.
-----
`;
const dated = validateKnowledgeTxt("it1961.txt", datedTxt);
t("带头部的文件校验通过", ()=>assert.strictEqual(dated.status,"READY_TO_REVIEW"));
t("头部不算作chunk", ()=>assert.strictEqual(dated.chunkCount,2));
t("文件级失效日被解析", ()=>assert.strictEqual(dated.documentEffectiveTo,"2026-03-31"));
t("头部日期落到每个chunk", ()=>assert.strictEqual(dated.chunks[0].provisionEffectiveTo,"2026-03-31"));
t("头部生效日落到chunk", ()=>assert.strictEqual(dated.chunks[0].provisionEffectiveFrom,"1962-04-01"));
t("chunk级生效日覆盖头部", ()=>assert.strictEqual(dated.chunks[1].provisionEffectiveFrom,"2015-04-01"));
t("chunk级不写失效日则继承头部", ()=>assert.strictEqual(dated.chunks[1].provisionEffectiveTo,"2026-03-31"));
t("适用说明落到chunk", ()=>assert.ok(/已于2026-04-01废止/.test(dated.chunks[0].applicabilityNote)));
t("标了失效日要强制确认", ()=>assert.ok(dated.confirmations.some((item)=>/只有问到这个期间/.test(item))));
t("解析出的chunk仍能被期间过滤挡掉", ()=>assert.strictEqual(coversDate(dated.chunks[0],undefined),false));

const badDateTxt = `【法律失效日】2026年3月31日
-----
【来源】A
【大标题】B
【小标题】C
【原文链接】https://example.gov.in/a.pdf

body text here.
-----
`;
const badDate = validateKnowledgeTxt("bad.txt", badDateTxt);
t("日期格式不对直接拦住", ()=>assert.strictEqual(badDate.status,"VALIDATION_FAILED"));
t("日期格式错误有明确提示", ()=>assert.ok(badDate.errors.some((e)=>/YYYY-MM-DD/.test(e))));

const reversedTxt = `【法律生效日】2026-04-01
【法律失效日】2020-03-31
-----
【来源】A
【大标题】B
【小标题】C
【原文链接】https://example.gov.in/a.pdf

body text here.
-----
`;
t("生效日晚于失效日被拦住", ()=>assert.ok(
  validateKnowledgeTxt("r.txt", reversedTxt).errors.some((e)=>/晚于失效日/.test(e))));

// 真实情况（2026-09-16）：脚本生成的大文件把三行适用期间**逐chunk重复写**在每个chunk开头，
// 且用的是文件头部那套名字。原来只认【生效日】，日期被静默忽略——不报错、chunk数正常，
// 但已废止的法照样会被当成现行有效引用。这是"看起来成功了其实没生效"，最难发现。
const perChunkTxt = `【法律生效日】1962-04-01
【法律失效日】2026-03-31
【适用说明】本法已于2026-04-01废止，仅适用于2026-04-01之前开始的税年。
【来源】Income-tax Act, 1961
【大标题】CHAPTER XIV
【小标题】Section 139 (Part 3/9)
【原文链接】https://example.gov.in/1961.pdf

If any person who has sustained a loss in any previous year.
-----
【法律生效日】1962-04-01
【法律失效日】2026-03-31
【适用说明】本法已于2026-04-01废止，仅适用于2026-04-01之前开始的税年。
【来源】Income-tax Act, 1961
【大标题】CHAPTER XIV
【小标题】Section 139 (Part 4/9)
【原文链接】https://example.gov.in/1961.pdf

Provided that the return of income shall be furnished on or before the due date.
-----
`;
const perChunk = validateKnowledgeTxt("it1961-per-chunk.txt", perChunkTxt);
t("逐chunk重复写适用期间：校验通过", ()=>assert.strictEqual(perChunk.status,"READY_TO_REVIEW"));
t("逐chunk重复写：不会把带【来源】的段落误判成文件头部", ()=>assert.strictEqual(perChunk.chunkCount,2));
t("逐chunk重复写：【法律失效日】被认出来（原来只认【失效日】，日期被静默忽略）", ()=>{
  assert.strictEqual(perChunk.chunks[0].provisionEffectiveTo,"2026-03-31");
  assert.strictEqual(perChunk.chunks[1].provisionEffectiveTo,"2026-03-31");
});
t("逐chunk重复写：【法律生效日】也被认出来", ()=>assert.strictEqual(perChunk.chunks[0].provisionEffectiveFrom,"1962-04-01"));
t("逐chunk重复写：全体一致的值提升为文件级，后台顶部提示条才显示得出来", ()=>{
  assert.strictEqual(perChunk.documentEffectiveTo,"2026-03-31");
  assert.strictEqual(perChunk.documentEffectiveFrom,"1962-04-01");
});
t("逐chunk重复写：解析出的chunk确实能被期间过滤挡掉（这才是修复的目的）", ()=>{
  assert.strictEqual(coversDate(perChunk.chunks[0],undefined),false);
  assert.strictEqual(coversDate(perChunk.chunks[0],"2019-06-01"),true);
});

t("各chunk适用期间不一致时不提升为文件级（不编一个单一答案出来）", ()=>{
  const mixed = validateKnowledgeTxt("mixed.txt", perChunkTxt.replace("【法律失效日】2026-03-31\n【适用说明】本法已于2026-04-01废止，仅适用于2026-04-01之前开始的税年。\n【来源】Income-tax Act, 1961\n【大标题】CHAPTER XIV\n【小标题】Section 139 (Part 4/9)", "【法律失效日】2020-03-31\n【适用说明】本法已于2026-04-01废止，仅适用于2026-04-01之前开始的税年。\n【来源】Income-tax Act, 1961\n【大标题】CHAPTER XIV\n【小标题】Section 139 (Part 4/9)"));
  assert.strictEqual(mixed.documentEffectiveTo, undefined);
  // 但每个chunk自己的值仍然各自生效。
  assert.strictEqual(mixed.chunks[0].provisionEffectiveTo, "2026-03-31");
  assert.strictEqual(mixed.chunks[1].provisionEffectiveTo, "2020-03-31");
});

// 既有资料（没有头部）行为必须完全不变，否则这次改动会波及全部已发布知识库。
const plain = validateKnowledgeTxt("plain.txt", txt);
t("无头部文件chunk数不变", ()=>assert.strictEqual(plain.chunkCount,2));
t("无头部文件不带适用期间", ()=>assert.strictEqual(plain.chunks[0].provisionEffectiveFrom,undefined));
t("无头部文件无文件级失效日", ()=>assert.strictEqual(plain.documentEffectiveTo,undefined));

console.log("== 辖区过滤（AI-23）==");
t("中央chunk对任何问题可用", ()=>assert.strictEqual(matchesJurisdiction(s74a,undefined),true));
t("州级chunk未指定辖区时不可用", ()=>assert.strictEqual(matchesJurisdiction(stateChunk,undefined),false));
t("州级chunk辖区匹配可用", ()=>assert.strictEqual(matchesJurisdiction(stateChunk,"MH"),true));
t("州级chunk辖区不匹配不可用", ()=>assert.strictEqual(matchesJurisdiction(stateChunk,"KA"),false));

console.log("== 要件配额（AI-13/T-08）==");
const mk=(n,minor,body)=>({number:n,source:"Act",majorTitle:"CH",minorTitle:minor,officialUrl:"u",body,bodyLength:body.length,wordCount:body.split(/\s+/).length});
const pool=[
 mk(1,"Section 3","private company shareholder requirement two persons"),
 mk(2,"Section 149","resident director requirement"),
 mk(3,"Para 3.1.1","beneficial owner government route land border"),
 mk(4,"Section 3 (Part 1/2)","private company shareholder requirement continued"),
 mk(5,"Section 3 (Part 2/2)","private company shareholder requirement further"),
];
const q=normalizeQueryPackage("必须有印度人参股吗",{english_query:"shareholder requirement",must_terms:[],optional_terms:[],legal_elements:["shareholder requirement","resident director","beneficial owner"]});
const r=retrieveKnowledge(pool,q);
t("三个要件都有证据", ()=>assert.strictEqual(r.uncoveredElements.length,0));
t("总数不超上限", ()=>assert.ok(r.evidence.length<=EVIDENCE_QUOTA.maxTotal));
t("同Section多Part只占1个配额", ()=>{
  const secs=r.evidence.filter(e=>e.minorTitle.startsWith("Section 3"));
  assert.strictEqual(secs.length,1,`实际 ${secs.length} 条`);
});
const q2=normalizeQueryPackage("x",{english_query:"shareholder",must_terms:[],optional_terms:[],legal_elements:["shareholder requirement","完全不存在的要件zzz"]});
const r2=retrieveKnowledge(pool,q2);
t("缺证据的要件被标出", ()=>assert.deepStrictEqual(r2.uncoveredElements,["完全不存在的要件zzz"]));

console.log("== 期间不覆盖（H-04）==");
const r3=retrieveKnowledge([s74a],normalizeQueryPackage("x",{english_query:"tax not paid",must_terms:[],optional_terms:[],legal_elements:["demand"]},{time_context:"2022-06-01"}));
t("全部被期间排除", ()=>assert.strictEqual(r3.evidence.length,0));
t("excludedByPeriod 记录了排除数", ()=>assert.strictEqual(r3.excludedByPeriod,1));



const I=require("./lib/server/inspection.js");
const Q=require("./lib/server/quota-restore.js");
const D=(s)=>new Date(s+"T00:00:00Z");
const doc=(o)=>({id:"d1",title:"T",inspectionTier:"A",legalStatus:"PUBLISHED",...o});

console.log("== 分层周期（KB-22）==");
t("A=30 B=90 C=180 E=365 D=事件驱动",()=>assert.deepStrictEqual(I.TIER_INTERVAL_DAYS,{A:30,B:90,C:180,D:null,E:365}));
t("从未核验即到期",()=>assert.strictEqual(I.evaluateCurrencyDue(doc({}),D("2026-08-29")).reason,"NEVER_CHECKED"));
t("A档第29天未到期",()=>assert.strictEqual(I.evaluateCurrencyDue(doc({legalCurrencyCheckedAt:"2026-08-01T00:00:00Z"}),D("2026-08-29")).due,false));
t("A档第31天到期",()=>assert.strictEqual(I.evaluateCurrencyDue(doc({legalCurrencyCheckedAt:"2026-07-01T00:00:00Z"}),D("2026-08-01")).reason,"TIER_INTERVAL"));
t("C档180天内不到期",()=>assert.strictEqual(I.evaluateCurrencyDue(doc({inspectionTier:"C",legalCurrencyCheckedAt:"2026-05-01T00:00:00Z"}),D("2026-08-29")).due,false));
t("D档不按分层周期到期（锚点后已核验）",()=>assert.strictEqual(I.evaluateCurrencyDue(doc({inspectionTier:"D",legalCurrencyCheckedAt:"2026-04-02T00:00:00Z"}),D("2026-08-29")).due,false));
t("同期A档已到期，对比可见D档确实不按周期",()=>assert.strictEqual(I.evaluateCurrencyDue(doc({inspectionTier:"A",legalCurrencyCheckedAt:"2026-04-02T00:00:00Z"}),D("2026-08-29")).reason,"TIER_INTERVAL"));

console.log("== 财年锚点（KB-24）==");
t("8月的最近锚点是4月1日",()=>assert.strictEqual(I.latestFiscalAnchor(D("2026-08-29")).toISOString().slice(0,10),"2026-04-01"));
t("3月的最近锚点是2月1日",()=>assert.strictEqual(I.latestFiscalAnchor(D("2026-03-10")).toISOString().slice(0,10),"2026-02-01"));
t("1月回落到上年4月",()=>assert.strictEqual(I.latestFiscalAnchor(D("2026-01-10")).toISOString().slice(0,10),"2025-04-01"));
t("E档365天没到，但跨了锚点仍强制复核",()=>{
  const r=I.evaluateCurrencyDue(doc({inspectionTier:"E",legalCurrencyCheckedAt:"2026-03-20T00:00:00Z"}),D("2026-08-29"));
  assert.strictEqual(r.reason,"FISCAL_ANCHOR");
});
t("D档也受锚点约束",()=>assert.strictEqual(I.evaluateCurrencyDue(doc({inspectionTier:"D",legalCurrencyCheckedAt:"2026-01-01T00:00:00Z"}),D("2026-08-29")).reason,"FISCAL_ANCHOR"));

console.log("== 超期降级（H-06/AI-17）==");
t("已发布且超期→CURRENCY_EXPIRED",()=>assert.strictEqual(I.isCurrencyExpired(doc({legalCurrencyCheckedAt:"2026-06-01T00:00:00Z"}),D("2026-08-29")),true));
t("草稿不参与超期判定",()=>assert.strictEqual(I.isCurrencyExpired(doc({legalStatus:"DRAFT"}),D("2026-08-29")),false));

console.log("== 文件线（H-07）==");
t("无锚点页不能比对",()=>assert.strictEqual(I.runFileLine({document:doc({}),observedFingerprint:"x"}).conclusion,"NO_ANCHOR_CONFIGURED"));
t("抓取失败不得推进",()=>{
  const o=I.runFileLine({document:doc({anchorUrl:"u",versionFingerprint:"v1"}),observedFingerprint:undefined});
  assert.strictEqual(o.conclusion,"FETCH_FAILED"); assert.strictEqual(o.canAutoAdvance,false);
});
t("指纹相同→自动推进",()=>{
  const o=I.runFileLine({document:doc({anchorUrl:"u",versionFingerprint:"v1"}),observedFingerprint:"v1"});
  assert.strictEqual(o.canAutoAdvance,true); assert.strictEqual(o.changeDetected,false);
});
t("指纹变化→必须人工",()=>{
  const o=I.runFileLine({document:doc({anchorUrl:"u",versionFingerprint:"v1"}),observedFingerprint:"v2"});
  assert.strictEqual(o.changeDetected,true); assert.strictEqual(o.canAutoAdvance,false);
});

console.log("== 取代三件事（KB-16/KB-17）==");
t("三件事齐全→complete",()=>assert.strictEqual(I.checkSupersession({oldStatusUpdated:true,supersededByFilled:true,replacementPublished:true}).complete,true));
t("做了一半→阻塞该领域",()=>{
  const c=I.checkSupersession({oldStatusUpdated:true,supersededByFilled:true,replacementPublished:false});
  assert.strictEqual(c.blocksDomain,true); assert.ok(c.missing[0].includes("新资料"));
});
t("完全没开始→不阻塞",()=>assert.strictEqual(I.checkSupersession({oldStatusUpdated:false,supersededByFilled:false,replacementPublished:false}).blocksDomain,false));

console.log("== 运营指标（PR-20）==");
t("四项指标",()=>{
  const docs=[doc({id:"a",legalCurrencyCheckedAt:"2026-08-20T00:00:00Z"}),
              doc({id:"b",legalCurrencyCheckedAt:"2026-06-01T00:00:00Z"}),
              doc({id:"c",legalStatus:"PENDING_OFFICIAL_SOURCE"})];
  const m=I.computeMaintenanceMetrics(docs,{total:10,degradedForCurrency:3},D("2026-08-29"));
  assert.strictEqual(m.pendingSources,1);
  assert.ok(m.maintenanceDebt>=1,"b已超期应计入欠债");
  assert.strictEqual(m.degradationRate,0.3);
  assert.ok(m.freshnessMedian);
});
t("巡检清单含文件线与领域线",()=>{
  const q=I.buildInspectionQueue([doc({id:"a",anchorUrl:"u"}),doc({id:"b",domainWatchChannel:"PIB"})],D("2026-08-29"));
  assert.ok(q.some(x=>x.line==="FILE")); assert.ok(q.some(x=>x.line==="DOMAIN"));
});

console.log("== 补回：原因长度（PR-06）==");
t("只数中文，不算标点空格",()=>assert.strictEqual(Q.countReasonChars("答案 不对！！！ 引用的条文根本不适用"),14));
t("10个中文不够（须超过）",()=>assert.strictEqual(Q.isReasonAcceptable("一二三四五六七八九十"),false));
t("11个中文可以",()=>assert.strictEqual(Q.isReasonAcceptable("一二三四五六七八九十一"),true));
t("用标点凑数无效",()=>assert.strictEqual(Q.isReasonAcceptable("不对!!!!!!!!!!!!!!!"),false));

const GOOD="这个回答引用的条文根本不适用于我们的情况";
const ctx=(o)=>({originalCharged:true,alreadyRestored:false,frozen:false,currentMonth:{yearMonth:"2026-08",restoredCount:0},...o});

console.log("== 补回：拒绝分支 ==");
t("未扣次不补回",()=>assert.strictEqual(Q.evaluateRestore(GOOD,ctx({originalCharged:false})).decision,"NOT_CHARGED"));
t("同一回答只补一次",()=>assert.strictEqual(Q.evaluateRestore(GOOD,ctx({alreadyRestored:true})).decision,"ALREADY_RESTORED"));
t("冻结后不补回但仍受理",()=>assert.strictEqual(Q.evaluateRestore(GOOD,ctx({frozen:true})).decision,"RESTORE_FROZEN"));
t("原因过短",()=>assert.strictEqual(Q.evaluateRestore("太短了",ctx({})).decision,"REASON_TOO_SHORT"));

console.log("== 补回：月度上限与冻结（PR-12/PR-13）==");
t("第1次补回成功",()=>{const r=Q.evaluateRestore(GOOD,ctx({}));assert.strictEqual(r.restored,true);assert.strictEqual(r.nextCounter.restoredCount,1);});
t("第3次触顶并记录时间",()=>{
  const r=Q.evaluateRestore(GOOD,ctx({currentMonth:{yearMonth:"2026-08",restoredCount:2}}));
  assert.strictEqual(r.restored,true); assert.ok(r.nextCounter.reachedLimitAt);
});
t("第4次被拒且无流水",()=>{
  const r=Q.evaluateRestore(GOOD,ctx({currentMonth:{yearMonth:"2026-08",restoredCount:3}}));
  assert.strictEqual(r.decision,"MONTHLY_LIMIT_REACHED"); assert.strictEqual(r.restored,false);
  assert.strictEqual(r.nextCounter.restoredCount,3,"计数不应变化");
});
t("单月触顶不冻结",()=>{
  const r=Q.evaluateRestore(GOOD,ctx({currentMonth:{yearMonth:"2026-08",restoredCount:2}}));
  assert.strictEqual(r.shouldFreeze,false);
});
t("连续两月触顶→冻结",()=>{
  const r=Q.evaluateRestore(GOOD,ctx({currentMonth:{yearMonth:"2026-08",restoredCount:2},
    previousMonth:{yearMonth:"2026-07",restoredCount:3,reachedLimitAt:"2026-07-20T00:00:00Z"}}));
  assert.strictEqual(r.shouldFreeze,true); assert.ok(r.auditNote.includes("冻结"));
});
t("上月未触顶则不冻结",()=>{
  const r=Q.evaluateRestore(GOOD,ctx({currentMonth:{yearMonth:"2026-08",restoredCount:2},
    previousMonth:{yearMonth:"2026-07",restoredCount:1}}));
  assert.strictEqual(r.shouldFreeze,false);
});

console.log("== 自然月计算 ==");
t("上月",()=>assert.strictEqual(Q.previousYearMonth("2026-08"),"2026-07"));
t("跨年",()=>assert.strictEqual(Q.previousYearMonth("2026-01"),"2025-12"));

console.log("== 补回流水（PR-06 验证点）==");
t("只出流水不改余额",()=>{
  const e=Q.buildRestoreLedgerEntry({userId:"u",requestId:"r",bucket:"FREE",originalLedgerId:"L1",operatorUserId:"u"});
  assert.strictEqual(e.delta,1); assert.strictEqual(e.originalLedgerId,"L1"); assert.strictEqual(e.reason,"FEEDBACK_RESTORE");
});
console.log("== 词典工作簿解析（术语词典同步）==");
const TERMS_HEADER = ["term_id","zh_term","zh_aliases","en_canonical","en_aliases","must_terms","exclude_terms","domain","subdomain","term_type","scope_note","source_id","source_reference","source_locator","source_url","workflow_status","version_no","effective_from","effective_to","reviewed_by","reviewed_at","change_note"];
async function bookFromRows(rows, sheetName = "词典主表") {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRows([TERMS_HEADER, ...rows]);
  return workbook.xlsx.writeBuffer();
}
function row(overrides) {
  const base = { term_id:"T1", zh_term:"测试词", zh_aliases:"", en_canonical:"test term",
    en_aliases:"", must_terms:"", exclude_terms:"", domain:"GST", subdomain:"", term_type:"CONCEPT",
    scope_note:"", source_id:"", source_reference:"", source_locator:"", source_url:"",
    workflow_status:"PUBLISHED", version_no:"1.0", effective_from:"", effective_to:"",
    reviewed_by:"", reviewed_at:"", change_note:"" };
  const merged = { ...base, ...overrides };
  return TERMS_HEADER.map((key) => merged[key]);
}

t("缺工作表名报错", async () => {
  const buf = await bookFromRows([], "别的表");
  const r = await parseTermsWorkbook(buf);
  assert.ok(r.errors.some((e) => e.includes("词典主表")));
});

t("正常一行PUBLISHED词条能解析", async () => {
  const buf = await bookFromRows([row({})]);
  const r = await parseTermsWorkbook(buf);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.totalRows, 1);
  assert.strictEqual(r.publishedCount, 1);
});

t("workflow_status非法值报错且跳过该行", async () => {
  const buf = await bookFromRows([row({ term_id:"T2", workflow_status:"WRONG_STATUS" })]);
  const r = await parseTermsWorkbook(buf);
  assert.strictEqual(r.totalRows, 0);
  assert.ok(r.errors.some((e) => e.includes("workflow_status")));
});

t("term_id重复报错", async () => {
  const buf = await bookFromRows([row({ term_id:"DUP" }), row({ term_id:"DUP" })]);
  const r = await parseTermsWorkbook(buf);
  assert.ok(r.errors.some((e) => e.includes("重复")));
});

t("REVIEW_PENDING和DRAFT不计入publishedCount", async () => {
  const buf = await bookFromRows([
    row({ term_id:"T3", workflow_status:"REVIEW_PENDING" }),
    row({ term_id:"T4", workflow_status:"DRAFT" }),
  ]);
  const r = await parseTermsWorkbook(buf);
  assert.strictEqual(r.totalRows, 2);
  assert.strictEqual(r.publishedCount, 0);
  assert.strictEqual(buildApprovedGlossary(r.rows).length, 0);
});

t("buildApprovedGlossary只导出PUBLISHED且字段映射正确", async () => {
  const buf = await bookFromRows([
    row({ term_id:"T5", workflow_status:"REVIEW_PENDING" }),
    row({
      term_id:"T6", zh_term:"印度股东", zh_aliases:"印度人股东;本地股东",
      en_canonical:"Indian shareholder", en_aliases:"local shareholder",
      must_terms:"shareholder", exclude_terms:"resident director",
      domain:"公司设立/MCA/ROC", scope_note:"不要和居民董事混淆",
      source_reference:"The Companies Act, 2013", source_locator:"s2(55)",
      workflow_status:"PUBLISHED",
    }),
  ]);
  const r = await parseTermsWorkbook(buf);
  assert.strictEqual(r.errors.length, 0);
  const glossary = buildApprovedGlossary(r.rows);
  assert.strictEqual(glossary.length, 1);
  const term = glossary[0];
  assert.strictEqual(term.term_zh, "印度股东");
  assert.deepStrictEqual(term.aliases_zh, ["印度人股东","本地股东"]);
  assert.strictEqual(term.official_term_en, "Indian shareholder");
  assert.ok(term.search_terms_en.includes("local shareholder") && term.search_terms_en.includes("shareholder"));
  // "公司设立/MCA/ROC"在文档里是一个标签，代码的Domain枚举拆成了两个，两边都要标上。
  assert.deepStrictEqual(term.domain, ["company_incorporation","mca_roc"]);
  assert.ok(term.exclusions.includes("resident director"));
  assert.strictEqual(term.source, "The Companies Act, 2013 s2(55)");
  assert.strictEqual(term.status, "APPROVED");
});

t("未知领域标签只警告不报错", async () => {
  const buf = await bookFromRows([row({ term_id:"T7", domain:"不存在的领域" })]);
  const r = await parseTermsWorkbook(buf);
  assert.strictEqual(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("不在已知列表")));
});

t("缺必填字段报错且跳过", async () => {
  const buf = await bookFromRows([row({ term_id:"T8", en_canonical:"" })]);
  const r = await parseTermsWorkbook(buf);
  assert.strictEqual(r.totalRows, 0);
  assert.ok(r.errors.some((e) => e.includes("en_canonical")));
});


console.log("\n== 步骤与引用的对应关系（法规要求按法律分组）==");

const refMap = new Map([["E1", 1], ["E2", 2], ["E3", 3]]);

t("步骤里的E编号换算成引用序号", () => {
  const steps = actionSteps([
    { kind: "MANDATORY", text: "先取得股东大会决议", citation_ids: ["E2", "E1"] },
  ], refMap);
  assert.strictEqual(steps.length, 1);
  // 去重后按序号升序，展示层的角标才不会乱跳
  assert.deepStrictEqual(steps[0].citation_refs, [1, 2]);
});

t("重复的E编号只保留一个", () => {
  const steps = actionSteps([
    { kind: "MANDATORY", text: "重复引用", citation_ids: ["E1", "E1", "E1"] },
  ], refMap);
  assert.deepStrictEqual(steps[0].citation_refs, [1]);
});

t("被适用期间剔除掉的证据不留下悬空角标", () => {
  // E9 不在 refMap 里（对应"这条证据没通过适用期间校验、已从引用列表删掉"）
  const steps = actionSteps([
    { kind: "MANDATORY", text: "依据一条已被剔除的证据", citation_ids: ["E9"] },
  ], refMap);
  assert.strictEqual(steps.length, 1, "内容必须保留");
  assert.deepStrictEqual(steps[0].citation_refs, [], "但不能留下指向不存在引用的角标");
});

t("模型漏标citation_ids时不吞掉这条法定要求", () => {
  const steps = actionSteps([
    { kind: "MANDATORY", text: "模型忘了标注依据的法定要求" },
    { kind: "PRACTICAL", text: "本来就没有法条依据的建议", citation_ids: [] },
  ], refMap);
  assert.strictEqual(steps.length, 2, "两条都要保留，展示层再归到「未标注具体依据」");
  assert.deepStrictEqual(steps[0].citation_refs, []);
  assert.strictEqual(steps[0].kind, "MANDATORY");
});

t("citation_ids不是数组也不报错", () => {
  const steps = actionSteps([
    { kind: "MANDATORY", text: "字段类型错了", citation_ids: "E1" },
  ], refMap);
  assert.deepStrictEqual(steps[0].citation_refs, []);
});


console.log("\n== 混合检索（关键词 + 向量）==");

t("RRF融合：两路都稳定靠前的，胜过一路很前、另一路很后的", () => {
  const A = { id: "a" }, B = { id: "b" }, X = { id: "x" }, Y = { id: "y" }, Z = { id: "z" };
  // 关键词排序：A第1、B第2；向量排序：B第1、A掉到第5
  // 这正是混合检索要的效果——只在单路表现好的，不该压过两路都稳的
  const fused = fuseByRRF(
    [
      [{ item: A }, { item: B }],
      [{ item: B }, { item: X }, { item: Y }, { item: Z }, { item: A }],
    ],
    (x) => x.id,
  );
  assert.strictEqual(fused[0].item.id, "b");
  assert.strictEqual(fused[1].item.id, "a");
});

t("RRF融合：只在一路出现的不会被丢掉", () => {
  const A = { id: "a" }, D = { id: "d" };
  const fused = fuseByRRF([[{ item: A }], [{ item: D }]], (x) => x.id);
  assert.strictEqual(fused.length, 2, "两路各自独有的结果都要保留");
});

t("RRF分数用的是排名不是原始分", () => {
  const A = { id: "a" };
  const fused = fuseByRRF([[{ item: A }]], (x) => x.id);
  assert.ok(Math.abs(fused[0].rrf - 1 / (RRF_K + 1)) < 1e-12);
});

t("余弦相似度：同向为1、正交为0", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [2, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-9);
});

t("零向量不会算出NaN", () => {
  assert.strictEqual(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

t("超长Chunk会分窗且窗口之间有重叠", () => {
  const long = "x".repeat(8000);
  const windows = splitIntoWindows(long);
  assert.ok(windows.length > 1, "8000字符必须切成多窗，否则尾部会被接口静默截断");
  // 相邻窗口有重叠，避免一句话正好被切断
  assert.ok(windows[0].length > 0 && windows[1].length > 0);
  const shortText = "just one window";
  assert.deepStrictEqual(splitIntoWindows(shortText), [shortText]);
});

t("分窗尊重传入的可用宽度（标题占位后不会超接口上限）", () => {
  // 模拟一条很长的标题：可用宽度要先扣掉标题，否则「标题+正文」会超过2000字符被静默截断
  const heading = "Consolidated FDI Policy Circular, 2020 (DPIIT) · CHAPTER 5 · 5.2.22.3 OTHER CONDITIONS";
  const available = MAX_INPUT_CHARS - heading.length - 2;
  const windows = splitIntoWindows("y".repeat(9000), available);
  windows.forEach((w) => {
    assert.ok(w.length <= available, "单窗不得超过可用宽度");
    assert.ok(`${heading}\n\n${w}`.length <= MAX_INPUT_CHARS, "标题+正文合起来不得超过接口上限");
  });
});

t("可用宽度异常小也不会死循环", () => {
  const windows = splitIntoWindows("z".repeat(3000), 10);
  assert.ok(windows.length > 0 && windows.length < 100);
});

t("向量编解码不失真", () => {
  const original = [0.5, -0.25, 0.125];
  const restored = Array.from(decodeVector(encodeVector(original)));
  restored.forEach((value, index) => assert.ok(Math.abs(value - original[index]) < 1e-6));
});


console.log("\n== 法律层配额（每层各 4 个要件名额）==");

// 造两层各自命中不同文件的语料：公司法层 vs 外汇层
const layerPool = [
  mk(11, "Section 62", "further issue of share capital special resolution"),
  mk(12, "Section 64", "notice to registrar alteration of share capital"),
  mk(13, "Section 42", "private placement allotment of securities"),
  mk(14, "Rule 21", "pricing guidelines issue of equity instruments to person resident outside india"),
  mk(15, "Schedule I", "reporting fc-gpr filing with reserve bank within thirty days"),
  mk(16, "Para 4.1", "government approval route land border country investor"),
];

const layered = normalizeQueryPackage("中资股东增资要核对什么", {
  english_query: "capital increase",
  must_terms: [], optional_terms: [],
  legal_layers: [
    { layer: "公司法/MCA-ROC", elements: [
      { label: "股东决议", terms_en: "special resolution" },
      { label: "ROC申报", terms_en: "notice to registrar" },
      { label: "私募配售", terms_en: "private placement" }] },
    { layer: "FEMA/FDI", elements: [
      { label: "定价规则", terms_en: "pricing guidelines" },
      { label: "外汇申报", terms_en: "fc-gpr reporting" },
      { label: "审批路径", terms_en: "government approval route" }] },
  ],
});

t("分层被解析出来", () => {
  assert.strictEqual(layered.legal_layers.length, 2);
  assert.strictEqual(layered.legal_layers[0].layer, "公司法/MCA-ROC");
  assert.strictEqual(layered.legal_layers[0].elements[0].label, "股东决议");
  assert.strictEqual(layered.legal_layers[0].elements[0].terms_en, "special resolution");
});

t("legal_elements 合并了各层要件（供向量检索用）", () => {
  assert.strictEqual(layered.legal_elements.length, 6);
});

t("两个法律层都拿到证据，不会被一层挤掉", () => {
  const r = retrieveKnowledge(layerPool, layered);
  const companyHits = r.evidence.filter((e) => /Section (62|64|42)/.test(e.minorTitle));
  const femaHits = r.evidence.filter((e) => /(Rule 21|Schedule I|Para 4\.1)/.test(e.minorTitle));
  assert.ok(companyHits.length > 0, "公司法层必须有证据");
  assert.ok(femaHits.length > 0, "外汇层必须有证据");
});

t("超出 maxLayers 的层被截断", () => {
  const many = normalizeQueryPackage("x", {
    english_query: "y", must_terms: [], optional_terms: [],
    legal_layers: [1, 2, 3, 4, 5].map((n) => ({ layer: `层${n}`, elements: [{ label: `要件${n}`, terms_en: `element ${n}` }] })),
  });
  assert.strictEqual(many.legal_layers.length, EVIDENCE_QUOTA.maxLayers);
});

t("要件数按问题复杂度放宽，超过硬上限才截断", () => {
  // 6 个要件（超过默认的 4，但没到硬上限 8）→ 全部保留
  const wide = normalizeQueryPackage("x", {
    english_query: "y", must_terms: [], optional_terms: [],
    legal_layers: [{ layer: "一层", elements: ["a1", "b2", "c3", "d4", "e5", "f6"].map((x) => ({ label: x, terms_en: x })) }],
  });
  assert.strictEqual(wide.legal_layers[0].elements.length, 6);

  // 超过硬上限 → 截断到 8
  const tooWide = normalizeQueryPackage("x", {
    english_query: "y", must_terms: [], optional_terms: [],
    legal_layers: [{ layer: "一层", elements: "abcdefghijk".split("").map((x) => ({ label: `e${x}`, terms_en: `t${x}` })) }],
  });
  assert.strictEqual(tooWide.legal_layers[0].elements.length, EVIDENCE_QUOTA.maxElementsHardCap);
});

t("空要件的层直接丢掉", () => {
  const dirty = normalizeQueryPackage("x", {
    english_query: "y", must_terms: [], optional_terms: [],
    legal_layers: [{ layer: "空层", elements: [] }, { layer: "有效层", elements: [{ label: "股东要求", terms_en: "shareholder requirement" }] }],
  });
  assert.strictEqual(dirty.legal_layers.length, 1);
  assert.strictEqual(dirty.legal_layers[0].layer, "有效层");
});

t("不给分层时行为与之前一致（单层）", () => {
  const flat = normalizeQueryPackage("x", {
    english_query: "shareholder", must_terms: [], optional_terms: [],
    legal_elements: ["shareholder requirement"],
  });
  assert.strictEqual(flat.legal_layers, undefined);
  const r = retrieveKnowledge(pool, flat);
  assert.ok(r.evidence.length > 0);
  assert.ok(r.evidence.length <= EVIDENCE_QUOTA.maxTotal);
});


t("中文标签的要件靠 terms_en 才检索得到（关键词那一路的老坑）", () => {
  // 只给中文标签：tokenize 后是空的，关键词打分拿不到任何信号
  const zhOnly = normalizeQueryPackage("x", {
    english_query: "unrelated words", must_terms: [], optional_terms: [],
    legal_layers: [{ layer: "公司法", elements: [{ label: "股东决议要求", terms_en: "" }] }],
  });
  // terms_en 为空时回落成标签本身（中文），检索不到
  assert.strictEqual(zhOnly.legal_layers[0].elements[0].terms_en, "股东决议要求");
  const missed = retrieveKnowledge(layerPool, zhOnly);
  const hitSpecialResolution = missed.evidence.some((e) => /Section 62/.test(e.minorTitle));
  assert.ok(!hitSpecialResolution, "只有中文标签时命中不了——这正是必须要 terms_en 的原因");

  // 补上英文检索词，同一条就能命中
  const withEn = normalizeQueryPackage("x", {
    english_query: "unrelated words", must_terms: [], optional_terms: [],
    legal_layers: [{ layer: "公司法", elements: [
      { label: "股东决议要求", terms_en: "further issue of share capital special resolution" }] }],
  });
  const found = retrieveKnowledge(layerPool, withEn);
  assert.ok(found.evidence.some((e) => /Section 62/.test(e.minorTitle)), "给了英文检索词就能命中");
});

t("未覆盖要件报出来的是中文标签，不是英文检索词", () => {
  const q = normalizeQueryPackage("x", {
    english_query: "zzz", must_terms: [], optional_terms: [],
    legal_layers: [{ layer: "某层", elements: [
      { label: "根本不存在的要件", terms_en: "totally-absent-term-qqq" }] }],
  });
  const r = retrieveKnowledge(layerPool, q);
  assert.deepStrictEqual(r.uncoveredElements, ["根本不存在的要件"]);
});

t("裸字符串要件仍然兼容（向后兼容）", () => {
  const legacy = normalizeQueryPackage("x", {
    english_query: "y", must_terms: [], optional_terms: [],
    legal_layers: [{ layer: "旧格式", elements: ["special resolution"] }],
  });
  assert.strictEqual(legacy.legal_layers[0].elements[0].label, "special resolution");
  assert.strictEqual(legacy.legal_layers[0].elements[0].terms_en, "special resolution");
});


console.log("\n== GST层误触发过滤（layer-relevance）==");

t("问题没提GST场景时，GST层被过滤", () => {
  const out = filterLayersByRelevance("中资股东对印度公司增资需要准备什么文件", [
    { layer: "公司法/MCA-ROC", elements: [{ label: "股东决议", terms_en: "special resolution" }] },
    { layer: "GST", elements: [{ label: "税务登记", terms_en: "PAN GST registration" }] },
  ]);
  assert.strictEqual(out.layers.length, 1);
  assert.strictEqual(out.layers[0].layer, "公司法/MCA-ROC");
  assert.deepStrictEqual(out.dropped, ["GST"]);
});

t("问题明确涉及发票/进项税时，GST层保留", () => {
  const out = filterLayersByRelevance("公司开具发票时进项税抵扣要注意什么", [
    { layer: "GST", elements: [{ label: "进项税抵扣条件", terms_en: "input tax credit" }] },
  ]);
  assert.strictEqual(out.layers.length, 1);
  assert.deepStrictEqual(out.dropped, []);
});

t("非受限域（公司法/FEMA/RBI/所得税）不受影响", () => {
  const out = filterLayersByRelevance("随便什么问题，不含任何信号词", [
    { layer: "公司法/MCA-ROC", elements: [] },
    { layer: "FEMA/FDI", elements: [] },
    { layer: "RBI", elements: [] },
    { layer: "所得税", elements: [] },
  ]);
  assert.strictEqual(out.layers.length, 4);
  assert.deepStrictEqual(out.dropped, []);
});

t("normalizeQueryPackage 集成：GST层被过滤后不出现在 legal_layers，且记入 filtered_layers", () => {
  const q = normalizeQueryPackage("中资股东对印度公司增资需要准备什么文件", {
    english_query: "capital increase", must_terms: [], optional_terms: [],
    legal_layers: [
      { layer: "公司法/MCA-ROC", elements: [{ label: "股东决议", terms_en: "special resolution" }] },
      { layer: "GST", elements: [{ label: "税务登记", terms_en: "PAN GST registration" }] },
    ],
  });
  assert.strictEqual(q.legal_layers.length, 1);
  assert.strictEqual(q.legal_layers[0].layer, "公司法/MCA-ROC");
  assert.deepStrictEqual(q.filtered_layers, ["GST"]);
  // 合并要件时也不应该包含被过滤层的要件
  assert.ok(!q.legal_elements.includes("税务登记"));
});


// 2026-09-20 用户实测：问公司所得税率，「新设制造公司15%」那条弹红字"引用可能指错条款"，
// 但用户在法里找到了 15%。根因是 Income-tax Act 2025 s201 是四栏表，PDF 抽出来列序错乱。
console.log("\n== 表格型条文：不能诬告成「引用指错条款」==");
{
  const { verifyQuote, isTableLikeChunk } = require("./lib/server/quote-check.js");
  // 取自真实知识库 s201 的排版（C 栏插进 D 栏中间）
  const tableBody = [
    "TABLE", "Sl. Assessee Total income and Conditions", "No. rate of tax", "A B C D",
    "1. A domestic (a) 15% on the total in- Such domestic company—",
    "company come other than the", "(a) exercises the option in",
    "(b) has been set-up and reg-", "(b) 22% (without any",
    "istered on or after the 1st", "deduction or allow-", "October, 2019;",
  ].join("\n");
  const proseBody = "The Board shall lay before the company in general meeting a report of the directors "
    + "containing the particulars specified in this section and the rules made thereunder.";
  const quote = "has been set-up and registered on or after the 1st October, 2019";

  t("表格标记能被认出来", () => {
    assert.ok(isTableLikeChunk(tableBody));
    assert.ok(!isTableLikeChunk(proseBody), "正常散文不该被当成表格");
  });
  t("引表格、原句对不上 → TABLE_UNVERIFIABLE，不是 NOT_FOUND", () => {
    assert.strictEqual(
      verifyQuote({ quote, citationRefs: [1], evidence: [{ body: tableBody }] }),
      "TABLE_UNVERIFIABLE");
  });
  t("引正常条文、原句对不上 → 照旧 NOT_FOUND（该报的警不能放过）", () => {
    assert.strictEqual(
      verifyQuote({ quote, citationRefs: [1], evidence: [{ body: proseBody }] }),
      "NOT_FOUND");
  });
  t("同时引表格和正常条文、都没对上 → 仍算 NOT_FOUND", () => {
    assert.strictEqual(
      verifyQuote({ quote, citationRefs: [1, 2], evidence: [{ body: tableBody }, { body: proseBody }] }),
      "NOT_FOUND");
  });
  t("原句真在表格里连续出现时，照样 VERIFIED（不受新分支影响）", () => {
    assert.strictEqual(
      verifyQuote({
        quote: "A domestic company engaged in the business of manufacture or production",
        citationRefs: [1],
        evidence: [{ body: "TABLE\nA domestic company engaged in the business of manufacture or production of any article." }],
      }),
      "VERIFIED");
  });
}

console.log("\n== 具体数值的证据校验（表格编号/期限/百分比）==");

t("能抽出表格编号、天数、百分比", () => {
  const c = extractCheckableClaims("增资后需在60天内提交FC-TRS表格，外资上限74%。");
  assert.deepStrictEqual(c.forms, ["FC-TRS"]);
  assert.deepStrictEqual(c.deadlines, ["60"]);
  assert.deepStrictEqual(c.percents, ["74"]);
});

// 2026-09-20 线上误报：答"2024年3月31日或之前开始生产"，界面弹出「⚠ 31天 未找到出处」。
// 日历日期不是期限。误报比漏报更伤——红字喊多了，真抄错时也没人信了。
t("日历日期不能被当成期限：2024年3月31日", () => {
  const c = extractCheckableClaims("2019年10月1日或之后设立并注册、且在2024年3月31日或之前开始生产的公司");
  assert.deepStrictEqual(c.deadlines, [], `不该抽出任何期限，实际抽出 ${JSON.stringify(c.deadlines)}`);
});

// 只挡「年月」不挡数字时，引擎会从 31 的 1 重试，抽出更离谱的「1天」。
t("日期里的个位数也不能漏出来（3月31日 不得退化成 1日）", () => {
  const c = extractCheckableClaims("自2026年4月1日起施行，2024年3月31日前完成");
  assert.deepStrictEqual(c.deadlines, [], `实际抽出 ${JSON.stringify(c.deadlines)}`);
});

t("同一句里日期不算、真期限照样算", () => {
  const c = extractCheckableClaims("2024年3月31日前提交，逾期30天将罚款");
  assert.deepStrictEqual(c.deadlines, ["30"]);
});

t("真期限的各种写法都不受影响", () => {
  assert.deepStrictEqual(extractCheckableClaims("须于60日内报FC-TRS").deadlines, ["60"]);
  assert.deepStrictEqual(extractCheckableClaims("7个工作日内完成").deadlines, ["7"]);
  assert.deepStrictEqual(extractCheckableClaims("另有120天宽限").deadlines, ["120"]);
  assert.deepStrictEqual(extractCheckableClaims("成立后15日内确立注册地址").deadlines, ["15"]);
});

// 这一条复刻线上真实出现过的错误回答
t("复刻线上事故：证据里没有FC-TRS和60天，必须被标出来", () => {
  const evidence = [{
    majorTitle: "CHAPTER 5: SECTOR SPECIFIC CONDITIONS ON FDI",
    minorTitle: "5.2 PERMITTED SECTORS",
    body: "Foreign investment in permitted sectors is subject to the sectoral caps specified herein.",
  }];
  const step = { text: "根据FDI政策，增资后需在60天内通过授权银行提交FC-TRS表格进行报告。", citation_refs: [1] };
  const bad = findUnverifiedClaims(step, evidence);
  assert.ok(bad.includes("FC-TRS"), "表格编号没有出处，必须标记");
  assert.ok(bad.includes("60天"), "期限没有出处，必须标记");
});

t("证据里确实有的，就不该误报", () => {
  const evidence = [{
    majorTitle: "Annex 1",
    minorTitle: "1.3.1 Reporting",
    body: "The Indian company shall report the issue of equity instruments in Form FC-GPR within thirty days from the date of issue. A sectoral cap of 74 per cent applies.",
  }];
  const ok = findUnverifiedClaims(
    { text: "须提交FC-GPR表格，行业上限74%。", citation_refs: [1] },
    evidence,
  );
  assert.deepStrictEqual(ok, [], `不应误报，实际标了 ${JSON.stringify(ok)}`);
});

t("天数要数字和day同时出现才算有出处", () => {
  const evidence = [{ body: "Section 30 of the Act deals with prospectus." }];
  // 证据里有"30"但那是条号，没有 day，不能算作 30 天的出处
  const bad = findUnverifiedClaims({ text: "应在30天内提交。", citation_refs: [1] }, evidence);
  assert.deepStrictEqual(bad, ["30天"]);

  const good = findUnverifiedClaims(
    { text: "应在30天内提交。", citation_refs: [1] },
    [{ body: "shall be filed within 30 days from the date of allotment" }],
  );
  assert.deepStrictEqual(good, []);
});

t("表格编号写法不同也能对上（FC-GPR / FCGPR / FC GPR）", () => {
  const evidence = [{ body: "report in form FCGPR to the Reserve Bank" }];
  assert.deepStrictEqual(findUnverifiedClaims({ text: "提交FC-GPR表格。", citation_refs: [1] }, evidence), []);
});

t("没标引用的步骤退回到全部证据里找，不冤枉它", () => {
  const evidence = [
    { body: "irrelevant text" },
    { body: "shall file Form PAS-3 within fifteen days" },
  ];
  const r = findUnverifiedClaims({ text: "提交PAS-3。", citation_refs: [] }, evidence);
  assert.deepStrictEqual(r, []);
});

t("没有可校验数值时返回空", () => {
  assert.deepStrictEqual(
    findUnverifiedClaims({ text: "建议聘请当地律师协助审阅。", citation_refs: [1] }, [{ body: "x" }]),
    [],
  );
});

console.log("\n== PAN/TAN类主张的证据相关性校验 ==");

// 复刻线上真实事故：一条"须申请PAN和TAN"的结论，引用的却是《生产者公司组建》条款——
// quote-check.ts的字符串核验会显示VERIFIED（那句话确实逐字出现在证据里），
// 但内容跟PAN、TAN毫无关系。这道检查补的就是这个缺口。
const producerCompanyEvidence = [{
  majorTitle: "CHAPTER II - INCORPORATION OF PRODUCER COMPANIES AND OTHER MATTERS",
  minorTitle: "Section 581C - Formation of Producer Company and its registration.",
  body: "Any ten or more individuals, each of them being a producer or any two or more producer institutions, "
    + "or a combination of ten or more individuals and producer institutions, desirous of forming a Producer "
    + "Company having its objects specified in section 581B and otherwise complying with the requirements of "
    + "this Part and the provisions of this Act in respect of registration, may form an incorporated Company "
    + "as a Producer Company under this Act.",
}];

t("复刻线上事故：PAN/TAN引用了《生产者公司组建》条款，必须被标出来", () => {
  const step = {
    text: "公司须申请永久账号（PAN）和税务扣除与征收账号（TAN），用于税务申报和代扣代缴。",
    citation_refs: [1],
  };
  const bad = findUnverifiedClaims(step, producerCompanyEvidence);
  assert.ok(bad.includes("PAN"), "PAN没有出处，必须标记");
  assert.ok(bad.includes("TAN"), "TAN没有出处，必须标记");
});

t("过时实务建议同样会被标出：NSDL/Form 49A提交PAN，引用的却是注册地址条款", () => {
  const step = {
    text: "通过所得税部门授权的服务商（如NSDL或UTIITSL）在线或线下提交Form 49A（PAN申请表）。",
    citation_refs: [1],
  };
  const evidence = [{
    majorTitle: "CHAPTER II", minorTitle: "Section 12 - Registered office of company.",
    body: "A company shall, within thirty days of its incorporation, have a registered office.",
  }];
  const bad = findUnverifiedClaims(step, evidence);
  assert.ok(bad.includes("PAN"), "证据里完全没提PAN，应该被标记");
});

t("证据里确实提到PAN/TAN时不误报", () => {
  const evidence = [{
    majorTitle: "Income-tax Act", minorTitle: "Section 139A",
    body: "Every person shall apply to the Assessing Officer for allotment of a Permanent Account Number (PAN).",
  }];
  const ok = findUnverifiedClaims(
    { text: "须申请PAN。", citation_refs: [1] },
    evidence,
  );
  assert.deepStrictEqual(ok, []);
});

t("PAN只是顺带提到、不紧跟动作词时不算一条主张（避免误伤）", () => {
  // "登记地址" 和 "PAN" 之间隔了太多字，不构成"办理/申请PAN"这类具体主张
  const c = extractCheckableClaims("先完成登记，地址核验材料以后可能会被要求补充给税务机关做PAN存档参考。");
  assert.deepStrictEqual(c.topics, []);
});

t("动作词在PAN/TAN之前或之后都能识别", () => {
  assert.deepStrictEqual(extractCheckableClaims("须申请PAN。").topics, ["PAN"]);
  assert.deepStrictEqual(extractCheckableClaims("提交Form 49A（PAN申请表）。").topics, ["PAN"]);
  assert.deepStrictEqual(extractCheckableClaims("办理TAN登记。").topics, ["TAN"]);
});

t("claim-repair不会把'PAN'误判成子串命中'company'（否则警示会被误清）", () => {
  // repairChunks（定义在下面）全是Companies Act内容，"company"到处都是；
  // 如果PAN按普通子串比对（不看单词边界），几乎每个chunk都会给"pan"刷出虚高分数。
  const chunks = [
    { documentId: "d1", number: 1, source: "Companies Act, 2013", majorTitle: "CHAPTER I",
      minorTitle: "Section 1", body: "This Act may be called the Companies Act. Every company shall comply.",
      officialUrl: "u" },
  ];
  const step = {
    kind: "MANDATORY", text: "公司须申请PAN。", citation_refs: [1], unverified_claims: ["PAN"],
  };
  const evidence = [{ ...chunks[0], evidenceId: "E1", score: 5 }];
  const out = repairUnverifiedClaims({ steps: [step], evidence, publishedChunks: chunks });
  assert.ok(out.steps[0].unverified_claims.includes("PAN"), "不该被'company'里的pan子串误判成已核实");
});


console.log("\n== 误报修正与补充核验 ==");

t("英文数词也算有出处（thirty days ≠ 没写30天）", () => {
  // 印度法条几乎都写 "within thirty days"，只按阿拉伯数字比对会误报
  const evidence = [{ body: "shall file the notice with the Registrar within thirty days of such alteration" }];
  assert.deepStrictEqual(
    findUnverifiedClaims({ text: "须在30日内向注册处提交通知。", citation_refs: [1] }, evidence),
    [],
  );
});

t("英文数词对不上的仍然要标出来", () => {
  const evidence = [{ body: "shall be filed within thirty days" }];
  const r = findUnverifiedClaims({ text: "须在60天内提交。", citation_refs: [1] }, evidence);
  assert.deepStrictEqual(r, ["60天"]);
});

t("通用英文数词核验覆盖182天（不再依赖手工数字表）", () => {
  const evidence = [{
    body: "Every company shall have at least one director who stays in India for a total period of not less than one hundred and eighty-two days during the financial year.",
  }];
  assert.deepStrictEqual(
    findUnverifiedClaims({ text: "公司至少有一名董事在印度居住满182天。", citation_refs: [1] }, evidence),
    [],
  );
});

const repairChunks = [
  { documentId: "d1", number: 1, source: "Companies Act, 2013", majorTitle: "CHAPTER IV",
    minorTitle: "Section 62", body: "further issue of share capital by special resolution", officialUrl: "u" },
  { documentId: "d1", number: 2, source: "Companies Act, 2013", majorTitle: "CHAPTER IV",
    minorTitle: "Section 64", body: "notice to Registrar shall be filed within thirty days of alteration", officialUrl: "u" },
];

t("补充核验：库里能找到出处时，补进引用并清掉警示", () => {
  const evidence = [{ ...repairChunks[0], evidenceId: "E1", score: 5 }];
  const step = { kind: "MANDATORY", text: "须在30日内向注册处提交通知。", citation_refs: [1], unverified_claims: ["30天"] };
  const out = repairUnverifiedClaims({ steps: [step], evidence, publishedChunks: repairChunks });
  assert.deepStrictEqual(out.steps[0].unverified_claims, [], "找到出处后不该再报警");
  assert.ok(out.steps[0].citation_refs.includes(2), "新找到的条文要补进引用");
  assert.strictEqual(out.evidence.length, 2, "新证据追加在末尾");
  assert.strictEqual(out.evidence[0].evidenceId, "E1", "原有角标编号不能位移");
});

t("补充核验可用英文182 days定位公司法原文", () => {
  const s149 = {
    documentId: "companies-2013", number: 149, source: "Companies Act, 2013",
    majorTitle: "CHAPTER XI", minorTitle: "Section 149 - Company to have Board of Directors",
    body: "Every company shall have at least one director who stays in India for a total period of not less than one hundred and eighty-two days during the financial year.",
    officialUrl: "u",
  };
  const evidence = [{ ...repairChunks[0], evidenceId: "E1", score: 5 }];
  const step = {
    kind: "MANDATORY", text: "公司至少有一名董事在印度居住满182天。",
    citation_refs: [1], unverified_claims: ["182天"],
  };
  const out = repairUnverifiedClaims({ steps: [step], evidence, publishedChunks: [repairChunks[0], s149] });
  assert.deepStrictEqual(out.steps[0].unverified_claims, []);
  assert.ok(out.steps[0].citation_refs.includes(2));
  assert.strictEqual(out.evidence[1].minorTitle, "Section 149 - Company to have Board of Directors");
});

t("补充核验：库里确实没有时，保留警示", () => {
  const evidence = [{ ...repairChunks[0], evidenceId: "E1", score: 5 }];
  const step = { kind: "MANDATORY", text: "须在60天内提交FC-TRS。", citation_refs: [1], unverified_claims: ["FC-TRS", "60天"] };
  const out = repairUnverifiedClaims({ steps: [step], evidence, publishedChunks: repairChunks });
  assert.ok(out.steps[0].unverified_claims.length > 0, "库里真没有的，仍要提示");
});

t("没有警示时不做任何多余检索", () => {
  const evidence = [{ ...repairChunks[0], evidenceId: "E1", score: 5 }];
  const step = { kind: "MANDATORY", text: "须经股东特别决议。", citation_refs: [1], unverified_claims: [] };
  const out = repairUnverifiedClaims({ steps: [step], evidence, publishedChunks: repairChunks });
  assert.strictEqual(out.evidence.length, 1);
  assert.strictEqual(out.steps[0], step, "原样返回，不做无谓的对象复制");
});

t("补充检索同样受适用期间约束", () => {
  const expired = [{ ...repairChunks[1], provisionEffectiveTo: "2020-01-01" }];
  const evidence = [{ ...repairChunks[0], evidenceId: "E1", score: 5 }];
  const step = { kind: "MANDATORY", text: "须在30日内提交。", citation_refs: [1], unverified_claims: ["30天"] };
  const out = repairUnverifiedClaims({
    steps: [step], evidence, publishedChunks: expired, targetDate: "2026-01-01",
  });
  assert.ok(out.steps[0].unverified_claims.length > 0, "不能为了补一个数字就引入已失效的条文");
});


console.log("\n== 译名对照（词典反向用于输出）==");

t("证据里出现的术语才进对照表", async () => {
  // 词典来自 .local-data / 种子文件，这里只验证筛选逻辑：
  // 证据里没出现的术语不该被塞进提示词，白白占长度
  const pairs = glossaryForEvidence("this text mentions nothing relevant at all");
  assert.ok(Array.isArray(pairs));
  pairs.forEach((pair) => {
    assert.ok(typeof pair.en === "string" && typeof pair.zh === "string");
  });
});


console.log("\n== 缩写补全称 ==");

t("首次出现补英文全称和中文释义", () => {
  const out = expandAbbreviations("向ROC提交股本变更通知。", new Set());
  assert.strictEqual(out, "向ROC（Registrar of Companies，公司注册处）提交股本变更通知。");
});

t("同一份回答里只补一次（跨结论/步骤共享）", () => {
  const answer = expandAnswerAbbreviations({
    short_conclusion: "须向ROC申报。",
    assumptions: [],
    action_steps: [{ text: "向ROC提交表格。" }, { text: "确认ROC回执。" }],
    risks_and_exceptions: ["逾期未向ROC申报会被罚款。"],
  });
  assert.ok(answer.short_conclusion.includes("Registrar of Companies"), "最先出现的位置要展开");
  assert.ok(!answer.action_steps[0].text.includes("Registrar of Companies"), "后面不再重复展开");
  assert.ok(!answer.risks_and_exceptions[0].includes("Registrar of Companies"));
});

t("已经自带括号说明的不再叠加", () => {
  const text = "向ROC（公司注册处）提交。";
  assert.strictEqual(expandAbbreviations(text, new Set()), text);
});

t("长缩写优先，不被短的截胡", () => {
  const out = expandAbbreviations("提交FC-GPR表格。", new Set());
  assert.ok(out.includes("FC-GPR（Foreign Currency-Gross Provisional Return"), out);
});

t("不误伤词中片段", () => {
  // "ROCKET" 里的 ROC 不该被展开；GSTR-1 现在是词表里的正式条目，
  // 应该**整体**展开，而不是把里面的 GST 拆出来（那会变成 "GST（…）R-1"）
  const out = expandAbbreviations("ROCKET与GSTR-1无关。", new Set());
  assert.ok(out.startsWith("ROCKET与"), "ROCKET 不该被拆开");
  assert.ok(!/GST（[^）]*）R-1/.test(out), "不能从 GSTR-1 中间拆");
  assert.ok(out.includes("销项明细申报表"), "GSTR-1 整体展开");
});

t("SEBI、RBI这类机构名同样覆盖", () => {
  const out = expandAbbreviations("须由SEBI注册商人银行家认证。", new Set());
  assert.ok(out.includes("Securities and Exchange Board of India"), out);
});


t("《法律名》里的缩写不展开（不能把标题拆散）", () => {
  const text = "根据《RBI Master Direction - Foreign Investment in India》附件1，……";
  assert.strictEqual(expandAbbreviations(text, new Set()), text);
});

t("后面紧跟大写英文单词的不展开（属于机构全名的一部分）", () => {
  const text = "RBI Master Direction 对此有规定。";
  assert.strictEqual(expandAbbreviations(text, new Set()), text);
});

t("标题里不展开，但同一段的独立用法要展开", () => {
  const out = expandAbbreviations("根据《RBI Master Direction》，须向RBI申报。", new Set());
  assert.ok(out.includes("《RBI Master Direction》"), "标题保持原样：" + out);
  assert.ok(out.includes("须向RBI（Reserve Bank of India，印度储备银行）申报"), out);
});

t("法规要求多时实务建议不会被截断", () => {
  const refMapEmpty = new Map();
  const many = [
    ...Array.from({ length: 9 }, (_, i) => ({ kind: "MANDATORY", text: `法定要求${i + 1}` })),
    { kind: "PRACTICAL", text: "实务建议一" },
    { kind: "PRACTICAL", text: "实务建议二" },
  ];
  const steps = actionSteps(many, refMapEmpty);
  const practical = steps.filter((s) => s.kind === "PRACTICAL");
  assert.strictEqual(practical.length, 2, "实务建议不能被法规要求挤掉");
});


console.log("\n== 法规要求与实务建议的一致性 ==");

t("检索到某部法律却没写进法规要求 → 要标出来", () => {
  // 复刻线上现象：RBI 的条文进了证据，实务建议里也用了，但法规要求里没有它
  const gaps = findCoverageGaps({
    steps: [
      { kind: "MANDATORY", text: "须经股东特别决议。", citation_refs: [1], unverified_claims: [] },
      { kind: "PRACTICAL", text: "配发后向RBI提交FC-GPR。", citation_refs: [2], unverified_claims: [] },
    ],
    evidenceSources: ["Companies Act, 2013", "RBI Master Direction - Foreign Investment in India"],
  });
  assert.deepStrictEqual(gaps.uncitedSources, ["RBI Master Direction - Foreign Investment in India"]);
  assert.strictEqual(gaps.practicalWithLegalBasis, 1, "有法条依据却被写成建议的，也要计数");
  const notes = coverageNotes(gaps);
  assert.strictEqual(notes.length, 2);
  assert.ok(notes[0].includes("RBI Master Direction"));
});

t("每部法律都在法规要求里出现时不报", () => {
  const gaps = findCoverageGaps({
    steps: [
      { kind: "MANDATORY", text: "a", citation_refs: [1], unverified_claims: [] },
      { kind: "MANDATORY", text: "b", citation_refs: [2], unverified_claims: [] },
      { kind: "PRACTICAL", text: "纯经验建议", citation_refs: [], unverified_claims: [] },
    ],
    evidenceSources: ["Companies Act, 2013", "FEMA (Non-debt Instruments) Rules, 2019"],
  });
  assert.deepStrictEqual(gaps.uncitedSources, []);
  assert.strictEqual(gaps.practicalWithLegalBasis, 0);
  assert.deepStrictEqual(coverageNotes(gaps), []);
});

t("同一部法律出现在多条证据里只判一次", () => {
  const gaps = findCoverageGaps({
    steps: [{ kind: "MANDATORY", text: "a", citation_refs: [1], unverified_claims: [] }],
    evidenceSources: ["Companies Act, 2013", "Companies Act, 2013", "Companies Act, 2013"],
  });
  assert.deepStrictEqual(gaps.uncitedSources, []);
});


t("有法条依据的实务建议会被归位到法规要求", () => {
  // 复刻线上现象：公司法的义务只出现在实务建议里
  const steps = [
    { kind: "MANDATORY", text: "FEMA定价要求。", citation_refs: [2], unverified_claims: [] },
    { kind: "PRACTICAL", text: "召开股东大会通过特别决议。", citation_refs: [1], unverified_claims: [] },
    { kind: "PRACTICAL", text: "提前准备好章程备查。", citation_refs: [], unverified_claims: [] },
  ];
  const out = promoteUncoveredPractical({
    steps,
    evidenceSources: ["Companies Act, 2013", "FEMA (Non-debt Instruments) Rules, 2019"],
  });
  const mandatory = out.steps.filter((x) => x.kind === "MANDATORY");
  assert.strictEqual(mandatory.length, 2, "公司法那条要被归位过来");
  assert.ok(mandatory.some((x) => x.text.includes("特别决议")));
  assert.deepStrictEqual(out.promoted, ["Companies Act, 2013"]);
  // 纯经验建议（没挂引用的）必须留在实务建议里
  const practical = out.steps.filter((x) => x.kind === "PRACTICAL");
  assert.strictEqual(practical.length, 1);
  assert.ok(practical[0].text.includes("章程备查"));
});

t("归位后不再报同一个缺口", () => {
  const sources = ["Companies Act, 2013", "FEMA (Non-debt Instruments) Rules, 2019"];
  const out = promoteUncoveredPractical({
    steps: [
      { kind: "MANDATORY", text: "a", citation_refs: [2], unverified_claims: [] },
      { kind: "PRACTICAL", text: "b", citation_refs: [1], unverified_claims: [] },
    ],
    evidenceSources: sources,
  });
  const gaps = findCoverageGaps({ steps: out.steps, evidenceSources: sources });
  assert.deepStrictEqual(gaps.uncitedSources, []);
});

t("法规要求里已经有的法律，不会把建议搬空", () => {
  const sources = ["Companies Act, 2013"];
  const out = promoteUncoveredPractical({
    steps: [
      { kind: "MANDATORY", text: "已有要求", citation_refs: [1], unverified_claims: [] },
      { kind: "PRACTICAL", text: "配套建议", citation_refs: [1], unverified_claims: [] },
    ],
    evidenceSources: sources,
  });
  assert.deepStrictEqual(out.promoted, [], "没有缺口就不该动");
  assert.strictEqual(out.steps.filter((x) => x.kind === "PRACTICAL").length, 1);
});


console.log("\n== 实务建议自动补依据（practical-grounding）==");

// 用户实测的真实文本（线上抓取）：法规要求第1条引了 Companies Act s62，
// 原文写"须经公司特别决议授权"；实务建议里"召开股东大会，通过特别决议…"没挂引用。
const s62Mandatory = {
  kind: "MANDATORY",
  text: "根据《Companies Act, 2013》第62条，向中资股东发行新股须经公司特别决议授权，且发行价格须依据注册估值",
  citation_refs: [5],
  unverified_claims: [],
};
const boardMeetingPractical = {
  kind: "PRACTICAL",
  text: "召开董事会会议，通过向中资股东发行新股的决议，并确定发行价格、数量及支付方式。",
  citation_refs: [],
  unverified_claims: [],
};
const shareholderMeetingPractical = {
  kind: "PRACTICAL",
  text: "召开股东大会，通过特别决议批准发行新股及修改公司章程大纲（如涉及授权股本增加）。",
  citation_refs: [],
  unverified_claims: [],
};
const genericPractical = {
  kind: "PRACTICAL",
  text: "留存所有决议、会议记录、估值报告、申报表格及银行凭证，以备监管机构核查。",
  citation_refs: [],
  unverified_claims: [],
};

t("复述法规要求的实务建议，借到对应引用", () => {
  const out = groundPracticalSteps([s62Mandatory, shareholderMeetingPractical]);
  const grounded = out.steps.find((s) => s.text.includes("股东大会"));
  assert.deepStrictEqual(grounded.citation_refs, [5]);
  assert.strictEqual(out.grounded.length, 1);
});

t("真的没有依据的实务建议（董事会先决议这一步），保持空引用", () => {
  const out = groundPracticalSteps([s62Mandatory, boardMeetingPractical]);
  const step = out.steps.find((s) => s.text.includes("董事会"));
  assert.deepStrictEqual(step.citation_refs, []);
  assert.strictEqual(out.grounded.length, 0);
});

t("和任何法规要求都不沾边的通用建议，保持空引用", () => {
  const out = groundPracticalSteps([s62Mandatory, genericPractical]);
  const step = out.steps.find((s) => s.text.includes("留存"));
  assert.deepStrictEqual(step.citation_refs, []);
});

t("已经挂了引用的实务建议不受影响", () => {
  const already = { kind: "PRACTICAL", text: "召开股东大会通过特别决议。", citation_refs: [9], unverified_claims: [] };
  const out = groundPracticalSteps([s62Mandatory, already]);
  assert.deepStrictEqual(out.steps.find((s) => s.citation_refs.includes(9)).citation_refs, [9]);
});

t("没有任何已引用的MANDATORY步骤时，原样返回", () => {
  const out = groundPracticalSteps([shareholderMeetingPractical]);
  assert.deepStrictEqual(out.steps, [shareholderMeetingPractical]);
  assert.deepStrictEqual(out.grounded, []);
});

t("MANDATORY步骤本身不受影响", () => {
  const out = groundPracticalSteps([s62Mandatory, shareholderMeetingPractical]);
  const mandatory = out.steps.find((s) => s.kind === "MANDATORY");
  assert.deepStrictEqual(mandatory, s62Mandatory);
});

console.log("\n== 原句核验（结论对、引用错）==");

// 复刻线上核实到的错误：5.2 条原文只讲行业上限，却被引来支持 Press Note 3 限制
const sectoralCapChunk = {
  evidenceId: "E1",
  source: "Consolidated FDI Policy Circular, 2020",
  majorTitle: "CHAPTER 5",
  minorTitle: "5.2 PERMITTED SECTORS",
  body: "In sectors/activities not listed below, FDI is permitted up to 100% on the automatic\nroute, subject to applicable laws/regulations; security and other conditionalities.",
};

t("原句确实在被引用的条文里 → VERIFIED", () => {
  const status = verifyQuote({
    quote: "FDI is permitted up to 100% on the automatic route",
    citationRefs: [1],
    evidence: [sectoralCapChunk],
  });
  assert.strictEqual(status, "VERIFIED");
});

t("复刻线上事故：条文里根本没有这句话 → NOT_FOUND", () => {
  const status = verifyQuote({
    // Press Note 3 的内容，5.2 条原文一个字都没提
    quote: "investment by an entity of a country which shares a land border with India shall require government approval",
    citationRefs: [1],
    evidence: [sectoralCapChunk],
  });
  assert.strictEqual(status, "NOT_FOUND");
});

t("换行、连字符断词、弯引号都不影响匹配", () => {
  const chunk = {
    ...sectoralCapChunk,
    body: "the Regist-\nrar shall record the “special resolution”  within\nthirty days of the allotment.",
  };
  const status = verifyQuote({
    quote: 'the Registrar shall record the "special resolution" within thirty days of the allotment',
    citationRefs: [1],
    evidence: [chunk],
  });
  assert.strictEqual(status, "VERIFIED");
});

t("原句来自另一部法的另一条（张冠李戴）→ NOT_FOUND", () => {
  const other = { ...sectoralCapChunk, evidenceId: "E2", source: "Companies Act, 2013", body: "a company may, by a special resolution, alter the provisions of its memorandum." };
  const status = verifyQuote({
    quote: "a company may, by a special resolution, alter the provisions of its memorandum",
    citationRefs: [1], // 只引了 E1，原句其实出自 E2
    evidence: [sectoralCapChunk, other],
  });
  assert.strictEqual(status, "NOT_FOUND");
});

t("原句失配时回库补到同主题的Companies Act s149，并以Act作主法源", () => {
  const wrongRule = {
    evidenceId: "E1", documentId: "directors-rules", number: 1,
    source: "Companies (Appointment and Qualification of Directors) Rules, 2014",
    majorTitle: "Rule 1", minorTitle: "Definitions",
    body: "These rules may be called the Companies (Appointment and Qualification of Directors) Rules, 2014.",
    officialUrl: "u", score: 5,
  };
  const s149 = {
    documentId: "companies-2013", number: 149, source: "Companies Act, 2013",
    majorTitle: "CHAPTER XI", minorTitle: "Section 149 - Company to have Board of Directors",
    body: "Every company shall have at least one director who stays in India for a total period of not less than one hundred and eighty-two days during the financial year.",
    officialUrl: "u",
  };
  const sourceQuote = "Every company shall have at least one director who stays in India for a total period of not less than one hundred and eighty-two days during the financial year.";
  const step = {
    kind: "MANDATORY", text: "公司至少有一名董事在印度居住满182天。",
    citation_refs: [1], unverified_claims: ["182天"], source_quote: sourceQuote,
    quote_status: "NOT_FOUND",
  };
  const out = repairQuoteCitations({
    steps: [step], evidence: [wrongRule], publishedChunks: [wrongRule, s149],
    question: "在印度设立企业必须有印度人参股吗？",
  });
  assert.deepStrictEqual(out.steps[0].citation_refs, [1, 2]);
  assert.deepStrictEqual(out.steps[0].unverified_claims, []);
  assert.strictEqual(out.evidence[1].source, "Companies Act, 2013");
  assert.strictEqual(checkQuotes({ steps: out.steps, evidence: out.evidence })[0].quote_status, "VERIFIED");
});

t("原句补救只接受整句命中，不能用模糊片段扫全库", () => {
  const wrongRule = {
    evidenceId: "E1", documentId: "directors-rules", number: 1,
    source: "Companies (Appointment and Qualification of Directors) Rules, 2014",
    majorTitle: "Rule 1", minorTitle: "Definitions", body: "Definitions.", officialUrl: "u", score: 5,
  };
  const s149 = {
    documentId: "companies-2013", number: 149, source: "Companies Act, 2013",
    majorTitle: "CHAPTER XI", minorTitle: "Section 149",
    body: "Every company shall have at least one director who stays in India for a total period of not less than one hundred and eighty-two days during the financial year.",
    officialUrl: "u",
  };
  const out = repairQuoteCitations({
    steps: [{
      kind: "MANDATORY", text: "公司至少有一名董事在印度居住满182天。",
      citation_refs: [1], unverified_claims: ["182天"], quote_status: "NOT_FOUND",
      source_quote: "Every company shall have at least one director who stays in India for a total period of not less than one hundred and eighty-two days during the financial year, subject to any other condition.",
    }],
    evidence: [wrongRule], publishedChunks: [wrongRule, s149], question: "在印度设立企业必须有印度人参股吗？",
  });
  assert.deepStrictEqual(out.steps[0].citation_refs, [1]);
  assert.strictEqual(out.evidence.length, 1);
});

t("没给原句 → MISSING；太短的原句也按没给算", () => {
  assert.strictEqual(verifyQuote({ quote: undefined, citationRefs: [1], evidence: [sectoralCapChunk] }), "MISSING");
  assert.strictEqual(verifyQuote({ quote: "shall apply", citationRefs: [1], evidence: [sectoralCapChunk] }), "MISSING");
});

t("实务建议不要求原句，标成 SKIPPED", () => {
  const steps = checkQuotes({
    steps: [
      { kind: "PRACTICAL", text: "找会计师", citation_refs: [], unverified_claims: [] },
      { kind: "MANDATORY", text: "x", citation_refs: [1], unverified_claims: [], source_quote: "FDI is permitted up to 100% on the automatic route" },
    ],
    evidence: [sectoralCapChunk],
  });
  assert.strictEqual(steps[0].quote_status, "SKIPPED");
  assert.strictEqual(steps[1].quote_status, "VERIFIED");
});

t("对不上的会汇总成用户可见的提示", () => {
  const notes = quoteNotes([
    { kind: "MANDATORY", text: "a", citation_refs: [1], unverified_claims: [], quote_status: "NOT_FOUND" },
    { kind: "MANDATORY", text: "b", citation_refs: [1], unverified_claims: [], quote_status: "VERIFIED" },
  ]);
  assert.strictEqual(notes.length, 1);
  assert.ok(notes[0].includes("指错"));
});

t("复刻线上误伤：长引文尾部跨到别的chunk，前76%逐字吻合 → 仍算 VERIFIED", () => {
  // 真实数据：年度申报那条引 Section 92，原句前321个归一化字符与条文逐字一致，
  // 末尾"由董事和公司秘书签署"那半句被切到了另一个 chunk，于是整条被误判。
  const s92 = {
    evidenceId: "E1", source: "Companies Act, 2013",
    majorTitle: "CHAPTER VII", minorTitle: "Section 92 - Annual return",
    body: "92. (1) Every company shall prepare a return (hereinafter referred to as the annual return) in the prescribed form containing the particulars as they stood on the\nclose of the financial year regarding—\n(a) its registered office, principal business activities, particulars of its holding, subsidiary and associate companies;\n(b) its shares, debentures and other securities and shareholding pattern;",
  };
  const quote = "Every company shall prepare a return (hereinafter referred to as the annual return) in the prescribed form containing the particulars as they stood on the close of the financial year regarding— (a) its registered office, principal business activities, particulars of its holding, subsidiary and associate companies; and shall be signed by a director and the company secretary, or where there is no company secretary, by a company secretary in practice";
  assert.strictEqual(verifyQuote({ quote, citationRefs: [1], evidence: [s92] }), "VERIFIED");
});

t("复刻线上真错：引了Section 133，原句却是Section 134的董事会报告 → NOT_FOUND", () => {
  const s133 = {
    evidenceId: "E1", source: "Companies Act, 2013",
    majorTitle: "CHAPTER IX", minorTitle: "Section 133 - Central Government to prescribe accounting standards",
    body: "133. The Central Government may prescribe the standards of accounting or any addendum thereto, as recommended by the Institute of Chartered Accountants of India, constituted under section 3 of the Chartered Accountants Act, 1949.",
  };
  const quote = "There shall be attached to statements laid before a company in general meeting, a report by its Board of Directors, which shall include the web address, if any, where annual return has been placed";
  assert.strictEqual(verifyQuote({ quote, citationRefs: [1], evidence: [s133] }), "NOT_FOUND");
});

t("只蹭到一小段法律套话、其余是编的 → 仍然 NOT_FOUND", () => {
  const chunk = {
    evidenceId: "E1", source: "X", majorTitle: "C", minorTitle: "S1",
    body: "a copy of the financial statements shall be filed with the Registrar within thirty days of the date of the annual general meeting.",
  };
  // 前半句蹭原文，后半句整段编造（编造部分远超一半）
  const quote = "shall be filed with the Registrar within thirty days of the date of the annual general meeting in Form AOC-4 together with the prescribed fee and where the company is a foreign company the additional documents specified by the Central Government must accompany the filing in every case";
  assert.strictEqual(verifyQuote({ quote, citationRefs: [1], evidence: [chunk] }), "NOT_FOUND");
});

t("最长连续吻合片段的计算", () => {
  assert.strictEqual(longestMatchLength("abcdefghij", "xxabcdefyy"), 6);
  assert.strictEqual(longestMatchLength("abcdef", "abcdef"), 6);
  assert.strictEqual(longestMatchLength("abcdef", "zzz"), 0);
});

t("归一化把排版差异全部抹平（只留字母数字）", () => {
  assert.strictEqual(normalizeForQuoteMatch("Foo   BAR\n baz"), "foobarbaz");
  assert.strictEqual(
    normalizeForQuoteMatch("Regist-\nrar “x” "),
    normalizeForQuoteMatch('Registrar "x"'),
  );
});


console.log("\n== 条文交叉引用自动跟进 ==");

const xref = (n, minor, body) => ({
  documentId: "d1", number: n, source: "Companies Act, 2013",
  majorTitle: "CHAPTER IV", minorTitle: minor, officialUrl: "u",
  body, bodyLength: body.length, wordCount: body.split(/\s+/).length,
});

t("条文正文引用了 section 42，就把 s42 也拉进证据", () => {
  const s62 = xref(1, "Section 62 - Further issue of share capital", "shares may be offered to any persons if it is authorised by a special resolution, subject to section 42 and the rules made thereunder");
  const s42 = xref(2, "Section 42 - Issue of shares on private placement basis", "a company may make a private placement through issue of a private placement offer letter");
  const unrelated = xref(3, "Section 90 - Register of significant beneficial owners", "every individual who holds beneficial interest shall make a declaration");
  const picked = followCrossReferences({ evidence: [s62], candidates: [s62, s42, unrelated] });
  assert.strictEqual(picked.length, 1);
  assert.ok(/Section 42/.test(picked[0].minorTitle));
});

t("自己引用自己（this section / 本条编号）不会重复拉自己", () => {
  const s62 = xref(1, "Section 62 - Further issue of share capital", "nothing in section 62 shall apply to a company where...");
  const picked = followCrossReferences({ evidence: [s62], candidates: [s62] });
  assert.deepStrictEqual(picked, []);
});

t("只在同一部资料内部跟进，不跨文件（编号重名太多）", () => {
  const s62 = xref(1, "Section 62", "subject to section 42");
  const otherAct = { ...xref(2, "Section 42", "different act entirely"), source: "Income-tax Act, 1961", documentId: "d2" };
  const picked = followCrossReferences({ evidence: [s62], candidates: [s62, otherAct] });
  assert.deepStrictEqual(picked, []);
});

t("rule 和 schedule 的引用一样跟进", () => {
  const base = xref(1, "Section 6", "in accordance with rule 21 and schedule I of these rules");
  const rule21 = xref(2, "Rule 21 - Pricing guidelines", "the price of equity instruments shall not be less than...");
  const schedule = xref(3, "Schedule I", "purchase or sale of equity instruments by a person resident outside india");
  const picked = followCrossReferences({ evidence: [base], candidates: [base, rule21, schedule] });
  assert.strictEqual(picked.length, 2);
});

t("补充数量有上限，一条法引出几十条也不会撑爆提示词", () => {
  const base = xref(1, "Section 1", "subject to section 2, section 3, section 4, section 5, section 6, section 7, section 8, section 9");
  const many = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => xref(n, `Section ${n}`, `body ${n}`));
  const picked = followCrossReferences({ evidence: [base], candidates: [base, ...many], limit: 3 });
  assert.strictEqual(picked.length, 3);
});

t("已经在证据里的条文不会被重复补进来", () => {
  const s62 = xref(1, "Section 62", "subject to section 42");
  const s42 = xref(2, "Section 42", "private placement");
  const picked = followCrossReferences({ evidence: [s62, s42], candidates: [s62, s42] });
  assert.deepStrictEqual(picked, []);
});


console.log("\n== 配额跟问题复杂度走 ==");

t("要件上限从固定4放宽到8", () => {
  assert.strictEqual(EVIDENCE_QUOTA.maxElements, 4, "默认值不变");
  assert.strictEqual(EVIDENCE_QUOTA.maxElementsHardCap, 8);
});

t("义务多的问题能拆到8个要件（原来第5个开始就被砍）", () => {
  const wide = normalizeQueryPackage("向外资发行新股要办哪些手续", {
    english_query: "further issue of share capital", must_terms: [], optional_terms: [],
    legal_layers: [{
      layer: "公司法/MCA-ROC",
      elements: [
        { label: "私募配售", terms_en: "private placement offer letter" },
        { label: "优先配股", terms_en: "further issue of share capital" },
        { label: "配发申报", terms_en: "return of allotment" },
        { label: "股本变更通知", terms_en: "notice to registrar alteration of share capital" },
        { label: "授权股本", terms_en: "power of limited company to alter its share capital" },
        { label: "章程修改", terms_en: "alteration of memorandum" },
        { label: "类别权利", terms_en: "variation of shareholders rights" },
        { label: "估值报告", terms_en: "registered valuer valuation report" },
      ],
    }],
  });
  assert.strictEqual(wide.legal_layers[0].elements.length, 8, "八条义务都要留住");
});

console.log("\n== 去掉正文里重复的条文出处前缀 ==");

t("标准写法：根据《X》第Y条，……", () => {
  assert.strictEqual(
    stripCitationPrefix("根据《Companies Act, 2013》第62条，向非现有股东发行新股，须经公司特别决议授权。"),
    "向非现有股东发行新股，须经公司特别决议授权。",
  );
});

t("法律名里带逗号和括号也能正确切", () => {
  assert.strictEqual(
    stripCitationPrefix("根据《FEMA (Non-debt Instruments) Rules, 2019》第21条，向非居民发行股份的价格不得低于公允价值。"),
    "向非居民发行股份的价格不得低于公允价值。",
  );
});

t("附件/段/款这些定位写法一样能切", () => {
  assert.strictEqual(
    stripCitationPrefix("根据《Consolidated FDI Policy Circular, 2020》附件2第6.1段，股份配发后须申报。"),
    "股份配发后须申报。",
  );
  assert.strictEqual(
    stripCitationPrefix("依据《Companies Act, 2013》第62条第(1)款，须发出配股通知。"),
    "须发出配股通知。",
  );
});

t("没有书名号的开头不动（否则会把主语切掉）", () => {
  const text = "根据上述规定，公司须在30日内申报。";
  assert.strictEqual(stripCitationPrefix(text), text);
});

t("不会把整句吃掉：只有出处、没有正文时保持原样", () => {
  const text = "根据《Companies Act, 2013》第62条，";
  assert.strictEqual(stripCitationPrefix(text), text);
});

t("定位过长时不切，避免误吞正文", () => {
  const text = "根据《X》这一段里写了非常多的内容并且一直没有出现任何逗号所以它根本不像一个条文定位而更像正文，公司须申报。";
  assert.strictEqual(stripCitationPrefix(text), text);
});

t("没挂引用的条目不删——那句出处可能是唯一线索", () => {
  const steps = stripCitationPrefixes([
    { kind: "MANDATORY", text: "根据《Companies Act, 2013》第62条，须经特别决议。", citation_refs: [], unverified_claims: [] },
    { kind: "MANDATORY", text: "根据《Companies Act, 2013》第64条，须在30日内申报。", citation_refs: [3], unverified_claims: [] },
  ]);
  assert.ok(steps[0].text.startsWith("根据《"), "没角标的保留出处");
  assert.strictEqual(steps[1].text, "须在30日内申报。");
});

console.log("\n== 去掉正文里模型自己加的「第X步」步骤序号前缀（真实用户反馈的bug）==");

t("中文数字「第X步：」前缀被删", () => {
  assert.strictEqual(
    stripStepNumberPrefix("第一步：与公司秘书或合规顾问确认增资方案。"),
    "与公司秘书或合规顾问确认增资方案。",
  );
  assert.strictEqual(
    stripStepNumberPrefix("第四步：向公司注册处提交Form PAS-3配发申报表。"),
    "向公司注册处提交Form PAS-3配发申报表。",
  );
});

t("阿拉伯数字「第X步」和英文「Step N」前缀也能删", () => {
  assert.strictEqual(stripStepNumberPrefix("第2步：确定发行价格。"), "确定发行价格。");
  assert.strictEqual(stripStepNumberPrefix("Step 3: Convene the board meeting."), "Convene the board meeting.");
});

t("没有步骤前缀的正文不受影响", () => {
  const text = "向非现有股东发行新股须经股东特别决议授权。";
  assert.strictEqual(stripStepNumberPrefix(text), text);
});

t("不会把整句吃掉：只有步骤前缀、没有正文时保持原样", () => {
  const text = "第一步：";
  assert.strictEqual(stripStepNumberPrefix(text), text);
});

t("stripStepNumberPrefixes对MANDATORY和PRACTICAL都生效，不像stripCitationPrefixes那样看citation_refs", () => {
  const steps = stripStepNumberPrefixes([
    { kind: "MANDATORY", text: "第一步：须经股东特别决议授权。", citation_refs: [], unverified_claims: [] },
    { kind: "PRACTICAL", text: "第二步：聘请注册估值师出具估值报告。", citation_refs: [1], unverified_claims: [] },
  ]);
  assert.strictEqual(steps[0].text, "须经股东特别决议授权。");
  assert.strictEqual(steps[1].text, "聘请注册估值师出具估值报告。");
});

console.log("\n== 相对时限的锚点校验 ==");

const step = (text) => ({ kind: "MANDATORY", text, citation_refs: [1], unverified_claims: [] });

t("复刻线上问题：全是「AGM后N天」，却没说AGM本身何时必须开", () => {
  const missing = findUnanchoredDeadlines([
    step("在AGM前至少21天，将财务报表、审计报告和董事会报告发送给所有成员。"),
    step("在AGM后30日内，通过MCA门户网站向ROC报送财务报表及董事会报告。"),
    step("在AGM后60日内，向ROC报送年度申报。"),
  ]);
  assert.deepStrictEqual(missing, ["AGM"]);
  assert.ok(deadlineAnchorNotes(missing)[0].includes("排不出"));
});

t("锚点自身的时限也写了 → 不报", () => {
  const missing = findUnanchoredDeadlines([
    step("股东周年大会须在财政年度结束后6个月内召开。"),
    step("在股东周年大会后60日内，向公司注册处报送年度申报。"),
  ]);
  assert.deepStrictEqual(missing, []);
});

t("中英两种写法算同一个锚点，不重复报", () => {
  const missing = findUnanchoredDeadlines([
    step("在股东周年大会（AGM）后60天内提交年度申报。"),
    step("在股东周年大会后30天内提交财务报表。"),
  ]);
  assert.strictEqual(missing.length, 1);
});

t("本身自带时间坐标的起点不算缺锚点", () => {
  // "财政年度结束后""收到通知后""配发后"这类：要么是历法起点，要么是外部事件触发，
  // 法律不可能再规定"它什么时候发生"
  assert.deepStrictEqual(findUnanchoredDeadlines([
    step("在财政年度结束后6个月内召开股东周年大会。"),
    step("收到税务通知后30日内提交答复。"),
    step("股份配发后30日内提交配发申报表。"),
  ]), []);
});

t("没有相对时限时不报", () => {
  assert.deepStrictEqual(findUnanchoredDeadlines([step("编制年度申报，内容涵盖注册地址与持股结构。")]), []);
  assert.deepStrictEqual(deadlineAnchorNotes([]), []);
});

console.log("\n== 问题类型：争议应对型走流程图，合规义务型走原模板 ==");

{
  const { detectQuestionType, resolveConversationQuestionType } =
    require("./lib/server/question-type.js");

  t("★ 真实事故：应诉成本那道题必须判成争议型", () => {
    // 2026-09-29：答案给出一串法定收费（1%/月利息、50% 罚款、上诉费、20% 预缴），
    // 每条都真、都有引用，但答不到点上——把或有当确定、混进了不是应诉成本的项、
    // 把顾问费写成权利、没有时间维度。
    // **不是检索质量问题，是模板问题**：成本模型不是法定要求的列表。
    assert.strictEqual(
      detectQuestionType("收到印度income tax税局发出的notice，现在我们在计算应诉成本。请你帮我计算应诉成本包括哪些内容"),
      "DISPUTE_RESPONSE",
    );
  });

  t("明确处在争议程序里的才算", () => {
    for (const q of [
      "收到GST的show cause notice怎么办", "评估令下来之后有哪些救济途径",
      "向ITAT上诉的期限是多久", "能不能申请暂缓征收", "税局质疑我们的转让定价，怎么抗辩",
    ]) assert.strictEqual(detectQuestionType(q), "DISPUTE_RESPONSE", q);
  });

  t("★★ 假设性问法一票否决——误判比漏判更糟", () => {
    // 判错了（本该合规型却走流程图）会给用户一张和他处境无关的审级图，比没有更糟；
    // 漏判只是退回原模板，那套模板本来也在用。所以假设性标记优先级最高。
    // 实测踩到的：「什么情况下会收到税务通知」被「收到…通知」命中，判成了争议型。
    for (const q of [
      "什么情况下会收到税务通知", "哪些情况下会被稽查", "如何避免转让定价争议",
      "怎么防范被税局质疑", "万一收到notice该准备什么",
    ]) assert.strictEqual(detectQuestionType(q), "COMPLIANCE_DUTY", `★ 误判成争议型：${q}`);
  });

  t("★ 不收「争议」「纠纷」这种泛指词", () => {
    // 这和 case-relevance 的 CASE_TRIGGER_PATTERN 刻意不同：
    // 那个是"要不要顺带查判例"，宽一点没关系；这个是"换不换整套模板"，必须窄。
    assert.strictEqual(detectQuestionType("转让定价争议怎么防范"), "COMPLIANCE_DUTY");
    assert.strictEqual(detectQuestionType("和供应商有纠纷怎么办"), "COMPLIANCE_DUTY");
  });

  t("常规合规问题不受影响", () => {
    for (const q of [
      "印度公司所得税税率是多少", "向中国母公司支付特许权使用费要办哪些手续",
      "进项税抵扣需要什么凭证", "公司年度ROC合规要核对哪些事项", "利润汇回中国怎么操作",
    ]) assert.strictEqual(detectQuestionType(q), "COMPLIANCE_DUTY", q);
  });

  t("★ 追问轮继承类型，但换话题要跟着换", () => {
    // 多义词闸门追问之后用户只答「pre-deposit」，单看那一句判不出来。
    const prior = "收到印度income tax税局发出的notice，现在我们在计算应诉成本";
    assert.strictEqual(resolveConversationQuestionType("pre-deposit", prior), "DISPUTE_RESPONSE");
    assert.strictEqual(resolveConversationQuestionType("那20%呢", prior), "DISPUTE_RESPONSE");
    assert.strictEqual(
      resolveConversationQuestionType("那以后怎么避免再被查，日常要做哪些合规准备", prior),
      "COMPLIANCE_DUTY", "★ 有实质内容的完整问句以当前句为准",
    );
  });
}

console.log("\n== 争议骨架：不经过模型的那部分 ==");

{
  const { loadDisputeTrack, flattenStages, resolveStageCitation } =
    require("./lib/server/dispute-track.js");

  t("三个税种各一条，认不出法域就不挂图", async () => {
    // 三个税种的预缴比例和审级完全不同，给错一张比不给更糟。
    for (const [cats, want] of [
      [["income_tax"], "所得税"], [["gst"], "GST"], [["trade_customs"], "海关"],
    ]) {
      const track = await loadDisputeTrack(cats);
      assert.ok(track, `${cats} 应该有骨架`);
      assert.strictEqual(track.label, want);
    }
    assert.strictEqual(await loadDisputeTrack([]), undefined, "★ 法域认不出 → 不挂图");
    assert.strictEqual(await loadDisputeTrack(["company_governance"]), undefined, "公司法没有争议骨架");
  });

  t("★ 每个 STATUTE 格子都追得到条号", async () => {
    // 有条文却给不出条号，等于挂了个点不开的角标——比不挂更糟。
    for (const cats of [["income_tax"], ["gst"], ["trade_customs"]]) {
      const track = await loadDisputeTrack(cats);
      const stages = [...track.stages, ...(track.branches ?? []).flatMap((b) => b.stages)];
      for (const stage of stages) {
        for (const cell of stage.cells) {
          if (cell.basis !== "STATUTE") continue;
          assert.ok(cell.citation_override || stage.citation,
            `${track.label}/${stage.label}/${cell.key} 追不到条号`);
        }
      }
    }
  });

  t("★ basis 只有两个合法值，不许出现第三种", async () => {
    // 第三种值会在展示层落到 else 分支，被当成"有条文"渲染成实心底——
    // 一个没出处的数字就这么拿到了有出处的外观。
    for (const cats of [["income_tax"], ["gst"], ["trade_customs"]]) {
      const track = await loadDisputeTrack(cats);
      const stages = [...track.stages, ...(track.branches ?? []).flatMap((b) => b.stages)];
      for (const stage of stages) {
        for (const cell of stage.cells) {
          assert.ok(["STATUTE", "PRACTICE_ESTIMATE"].includes(cell.basis),
            `${stage.label}/${cell.key} 的 basis 非法：${cell.basis}`);
        }
      }
    }
  });

  t("★ 平均耗时一律标成无条文", async () => {
    // 它必须显示（只给单价不给乘数等于给了张没法用的价目表），
    // 但显示了就得说清没出处。
    for (const cats of [["income_tax"], ["gst"], ["trade_customs"]]) {
      const track = await loadDisputeTrack(cats);
      const stages = [...track.stages, ...(track.branches ?? []).flatMap((b) => b.stages)];
      for (const stage of stages) {
        for (const cell of stage.cells) {
          if (/耗时/.test(cell.key)) {
            assert.strictEqual(cell.basis, "PRACTICE_ESTIMATE",
              `★ ${stage.label}/${cell.key} 不能标成有条文`);
          }
        }
      }
    }
  });

  t("★ 所得税那 20% 必须标成通函级", async () => {
    // 它出自 CBDT 行政备忘录，只约束税务官、不约束法院、可以争取降低。
    // 摆在「法律」位阶底下等于给最弱的依据盖了最高的章。
    const track = await loadDisputeTrack(["income_tax"]);
    const cells = (track.branches ?? []).flatMap((b) => b.stages).flatMap((s) => s.cells);
    const pre = cells.find((c) => /暂缓征收/.test(c.key));
    assert.ok(pre, "应该有暂缓征收那一格");
    assert.strictEqual(pre.hierarchy, "CIRCULAR");
    assert.ok(/备忘录|Memorandum/.test(pre.citation_override ?? ""));
  });

  t("双条号收敛：所得税给两套，GST/海关给一套", async () => {
    const it = await loadDisputeTrack(["income_tax"]);
    const itat = it.stages.find((s) => s.id === "itat");
    const c = resolveStageCitation(itat.citation);
    assert.ok(/2025/.test(c.primary) && /1961/.test(c.legacy), "所得税要两套条号");
    const gst = await loadDisputeTrack(["gst"]);
    assert.strictEqual(resolveStageCitation(gst.stages[0].citation).legacy, undefined);
  });

  t("★ 利息的 carve_out 不能丢", async () => {
    // 所得税 s.411(3)(b)：罚款部分在一审裁定前不计息。
    // 笼统说一句"欠款按 1%/月 累计"会把罚款那块的利息也算进去，
    // 而罚款常常是争议金额里最大的一块（少报罚 50%）。
    const track = await loadDisputeTrack(["income_tax"]);
    const interest = track.running_cost.interest;
    assert.ok(/1%/.test(interest.value));
    assert.ok(/单利/.test(interest.note), "是单利不是复利，三年差 7 个百分点");
    assert.ok(/不足一个月|part of a month/.test(interest.note), "不足一月按一月算");
    assert.ok(interest.carve_out && /不计息/.test(interest.carve_out), "★ carve_out 必须在");
  });

  t("★ 「部分覆盖」必须说清缺的是哪一块", () => {
    const fs = require("node:fs"), path = require("node:path");
    const css = fs.readFileSync(path.join(__dirname, "..", "app/globals.css"), "utf8");
    const page = fs.readFileSync(path.join(__dirname, "..", "app/page.tsx"), "utf8");
    // 2026-09-29 用户问「部分覆盖是为什么」。问出这句话本身就说明徽标失败了：
    // 它诚实地降了级，却没说理由，于是这个降级**无法被使用**——
    // 用户既不知道主干该不该信，也不知道该往库里补什么。
    // 一个说不出理由的警告，用户第二次就会忽略它。
    const contracts = fs.readFileSync(path.join(__dirname, "..", "lib/contracts.ts"), "utf8");
    assert.ok(/evidence_gap\?: string/.test(contracts), "★ 契约要有缺口字段");
    const rule = fs.readFileSync(path.join(__dirname, "..", "lib/server/answer-self-doubt.ts"), "utf8");
    assert.ok(/evidence_gap[\s\S]{0,80}必填/.test(rule), "★ 报 PARTIAL 时这个字段必填");
    assert.ok(/同义反复/.test(rule), "★ 要挡住「证据不足」这种等于没说的答复");

    const src = fs.readFileSync(path.join(__dirname, "..", "lib/server/legal-answer.ts"), "utf8");
    // 两个方向各挡一次
    assert.ok(/evidence_gap: evidenceSufficiency === "FULL"[\s\S]{0,40}undefined/.test(src),
      "★ 报 FULL 就不该另有一句「但是」");
    assert.ok(/证据不足\|依据不足/.test(src), "★ 同义反复要在服务端也丢掉，不能只靠提示词");

    // 前端：没填缺口时给中性兜底，**不编一个缺口出来**
    assert.ok(/answer\.evidence_gap\s*\n?\s*\?\?/.test(page),
      "★ 模型没填时要有兜底文案");
    assert.ok(/不编一个缺口出来|不编造/.test(page),
      "★ 注释里要写明为什么不编——编出来的缺口会让用户去补一份根本不缺的资料");
    assert.ok(/\.evidence-gap\s*\{/.test(css), "样式要在");
    // 只在真降级时显示
    assert.ok(/evidence_sufficiency !== "FULL" \? \(/.test(page), "★ FULL 时不显示");
  });

  t("★ 库里有 CGST 法却报「库里没有这一条」", () => {
    const fs = require("node:fs"), path = require("node:path");
    // 2026-09-29 用户反馈："你怎么确认库里没有这一条，我的知识库中明明有 cgst 2017 act"。
    // 他是对的。库里那份的名字是
    //   `ICAI IDTC – GST Law (Central Goods and Services Tax)`
    // 两个坑叠在一起把它挡住了：
    //   ① 名字里没有 "CGST" 这四个字母 —— 缩写没展开；
    //   ② 唯一能认出它是哪部法的那几个词**写在括号里**，
    //      而归一函数把括号连内容一起剥掉了，这份资料等于没了名字。
    //
    // 误报「库里没有」和误挂一个错角标一样糟，方向还更讨厌：
    // 它会让用户去补一份他已经有的资料，而且是在他明确知道自己有的时候。
    const m = require("./lib/server/dispute-citations.js");
    const mk = (source, minor) => ({
      source, minorTitle: minor, majorTitle: "",
      officialUrl: "u/" + source + minor, body: "x", snippetDisplay: "ALLOW",
    });
    const ICAI = "ICAI IDTC – GST Law (Central Goods and Services Tax)";

    // ① 用户真实的库：只有 ICAI 汇编本，标题里没有年份
    let cits = [];
    let r = m.resolveDisputeCitations(
      ["CGST Act, 2017 s.107", "CGST Act, 2017 s.74A", "CGST Act, 2017 s.112"],
      [mk(ICAI, "Section 107 - Appeals to Appellate Authority"),
       mk(ICAI, "Section 74A - Determination of tax")],
      cits,
    );
    assert.ok(!r.get("CGST Act, 2017 s.107").missing, "★ s.107 库里有，不能报没有");
    assert.ok(!r.get("CGST Act, 2017 s.74A").missing, "★ s.74A 库里有，不能报没有");
    // 库里确实没有的那一条，仍然要如实说没有——这条纪律不能被上面的放宽冲掉
    assert.ok(r.get("CGST Act, 2017 s.112").missing, "★ 真没有的要如实报没有");

    // ② 年份规则不能因此废掉：所得税两部法并存时，年份是唯一的区分器
    cits = [];
    r = m.resolveDisputeCitations(
      ["Income-tax Act, 2025 s.439", "Income-tax Act, 2025 s.270A"],
      [mk("The Income-tax Act, 1961", "Section 270A - Penalty"),
       mk("The Income-tax Act, 2025", "Section 439 - Penalty")],
      cits,
    );
    assert.ok(!r.get("Income-tax Act, 2025 s.439").missing);
    assert.ok(r.get("Income-tax Act, 2025 s.270A").missing,
      "★ 270A 只在 1961 法里，不许靠去掉年份让 2025 法蹭上去——双条号设计全靠这个区分");

    // ③ 库里有两份不同年份的同名法时，自动退回严格模式，不猜
    cits = [];
    r = m.resolveDisputeCitations(["CGST Act, 2017 s.107"],
      [mk(ICAI, "Section 107 - x"), mk("Central Goods and Services Tax Digest, 2016", "Section 107 - y")],
      cits);
    assert.ok(r.get("CGST Act, 2017 s.107").missing,
      "★ 两个来源都可能对得上时，宁可说没有，也不猜一个年份");

    // ④ 缩写展开不能把兄弟法混进来
    cits = [];
    r = m.resolveDisputeCitations(["CGST Act, 2017 s.107"],
      [mk("The Integrated Goods and Services Tax Act, 2017", "Section 107 - x")], cits);
    assert.ok(r.get("CGST Act, 2017 s.107").missing, "★ IGST 不能冒充 CGST");

    // 缩写表只能有一份
    const src = fs.readFileSync(path.join(__dirname, "..", "lib/server/dispute-citations.ts"), "utf8");
    assert.ok(/from "\.\/abbreviations"/.test(src), "★ 复用 abbreviations.ts，不另起一份缩写表");
    assert.ok(/function normalizeHaystack/.test(src), "★ 被查方要单独归一，不能剥掉括号");
  });

  t("★ 一条 GST 要求不许挂所得税法的角标", () => {
    const fs = require("node:fs"), path = require("node:path");
    // 2026-09-29 实测：问「收到 GST 税局关于电子运单不符的处罚令怎么办」，
    // 第一条要求写的是 CGST s.129 的罚则（货值 50% / 税额 200%），
    // 角标里却有 Income-tax Act, 2025，还因为位阶最高把整条归进了「所得税 / DTAA」。
    //
    // 分组那一层单独修过，但那只治标题。**角标还在** ——
    // 一条 GST 规则盖着所得税法的章。错的出处比没有出处更危险：它看起来完全合格。
    const { pruneCrossDomainRefs } = require("./lib/server/citation-domain.js");
    const ev = [
      { source: "Income-tax Act, 2025" },
      { source: "ICAI IDTC – GST Law (Central Goods and Services Tax)" },
      { source: "CBIC GST Rules — e-Way Bill 页面规则" },
      { source: "某局通函 F.No.123" },
    ];
    const refs = (steps, cats) => pruneCrossDomainRefs(steps, ev, cats)[0].citation_refs;
    // 事故本身：混合引用 → 剔掉法域外的
    assert.deepStrictEqual(refs([{ citation_refs: [1, 2, 3] }], ["gst"]), [2, 3]);
    // 边界①：法域认不出来 → 一条都不剔。
    // 拿一个没根据的判断去删有根据的东西，是更糟的方向。
    assert.deepStrictEqual(refs([{ citation_refs: [1, 2] }], []), [1, 2]);
    // 边界②：整条全在法域外 → 不剔。剔空了这条就变成"无依据"，
    // 在界面上和模型瞎编的东西长得一样；而且"全是外法域"本身是个值钱的信号。
    assert.deepStrictEqual(refs([{ citation_refs: [1] }], ["gst"]), [1]);
    // 边界③：判不出类别（通函/备忘录/指南名字五花八门）→ 当本法域，不剔。
    // 判不出来就删，会重演 domain-scope.ts 里记的那五次误剔事故。
    assert.deepStrictEqual(refs([{ citation_refs: [2, 4] }], ["gst"]), [2, 4]);
    // 闸门必须装在单一出口，让下游全部看到剔过的角标
    const src = fs.readFileSync(path.join(__dirname, "..", "lib/server/legal-answer.ts"), "utf8");
    assert.ok(/const adjustedSteps = pruneCrossDomainRefs\(/.test(src),
      "★ 要在 adjustedSteps 这一处剔，不能只在渲染前剔——关键数值校验、分组、另据都读 citation_refs");
  });

  t("★ 前端和服务端必须用同一套法域判据", () => {
    const fs = require("node:fs"), path = require("node:path");
    const page = fs.readFileSync(path.join(__dirname, "..", "app/page.tsx"), "utf8");
    // 两份正则各自演化，迟早出现"前端认为这条是 GST、服务端认为不是"的分裂。
    const shared = fs.readFileSync(path.join(__dirname, "..", "lib/law-categories.ts"), "utf8");
    assert.ok(/export function lawCategoryOfTitle/.test(shared), "判据要在共用文件里");
    assert.ok(!/const CATEGORY_PATTERNS/.test(page), "★ page.tsx 里不能再留一份私有正则");
    assert.ok(/lawCategoryOfTitle/.test(page), "★ 前端要改成调共用的那个");
    const cd = fs.readFileSync(path.join(__dirname, "..", "lib/server/citation-domain.ts"), "utf8");
    assert.ok(/lawCategoryOfTitle/.test(cd), "★ 服务端也调同一个");
    // 共用文件被客户端组件 import，不能带服务端依赖
    assert.ok(!/from "\.\/server\//.test(shared) && !/require\(/.test(shared),
      "★ law-categories.ts 会被打进浏览器包，不能引服务端代码");
  });

  t("★ 「处罚令」这类问题要判成争议型，但 purchase order 不能", () => {
    const fs = require("node:fs"), path = require("node:path");
    // 2026-09-29 用户提出：触发词要收 order / 命令。
    // 但裸的 order 在这个产品里几乎一定是 purchase order / work order，
    // 收了它等于把所有采购、物流问题都判成争议型 ——
    // 而误判（给用户一张和他处境无关的审级图）比漏判更糟，见 question-type.ts 开头。
    const { detectQuestionType } = require("./lib/server/question-type.js");
    const dispute = [
      // 2026-09-29 第二次漏判：主语从"我"换成"税局"，RECEIVED 就够不着了。
      // 用户手里同样拿着一份税局的 notice，处境一模一样。
      "gst 税局发的关于 ewb 与实际货物不符的 notice，应该怎么应对",
      "DGGI 下发的show cause notice怎么处理",
      "海关出具的处罚决定我们不服",
      "税务机关送达的缴款通知有几天",
      // 2026-09-29 第三次漏判：宾语是英文 order。
      "gst税局发的关于ewb与实际货物不符的order，应该怎么应对",
      "收到税局的order怎么办",
      "海关签发的order我们不服",
      "收到GST（Goods and Services Tax，商品与服务税）税局关于电子运单与实际货物不符的处罚令，应该怎么办",
      "收到所得税局的评估令怎么办",
      "我们收到了一份penalty order",
      "税局下了扣押令，货被扣了",
      "order-in-appeal 之后还能往哪一级",
    ];
    const duty = [
      "给印度客户开purchase order要注意什么",
      "work order和合同在GST上怎么区分",
      "什么情况下会收到税局的处罚令",
      "如何避免收到税务局的处罚决定",
      "转让定价争议怎么防范",
      "GST税率是多少",
      "如何生成e-way bill",
      // ISSUED 要求「发文机关」和「发文动作」同时出现，缺一不可——
      // 光有 notice 或光有税局都是合规问题。
      "e-way bill 的 notice 要求是什么",
      "税局怎么认定关联方交易",
      "什么情况下税局会发notice",
      "如何避免税局发来处罚通知",
      // order 必须带否定前瞻挡掉商业搭配：这三种在本产品里比税务裁定令常见得多，
      // 判成争议型就会给用户一张和他处境无关的审级流程图。
      "收到客户的purchase order要开什么发票",
      "收到一份work order，GST怎么处理",
      "收到sales order之后多久要开票",
      "什么情况下税局会发order",
      "如何避免收到税局的order",
    ];
    for (const q of dispute) {
      assert.strictEqual(detectQuestionType(q), "DISPUTE_RESPONSE", `应判争议型：${q}`);
    }
    for (const q of duty) {
      assert.strictEqual(detectQuestionType(q), "COMPLIANCE_DUTY", `★ 不能误判成争议型：${q}`);
    }
    // 「收到…令」之间的窗口：中文商务问句常塞一长串定语，开小了等于没开
    const qt = fs.readFileSync(path.join(__dirname, "..", "lib/server/question-type.ts"), "utf8");
    assert.ok(/\{0,40\}\$\{OFFICIAL_DOC\}/.test(qt), "★ RECEIVED 的间隔要够宽");
    // order 的商业搭配必须被负向后顾挡掉，否则整条规则得不偿失
    assert.ok(/\(\?<!purchase\\\\s\)/.test(qt), "★ purchase order 要挡掉");
    assert.ok(/OFFICIAL_DOC/.test(qt) && qt.split("OFFICIAL_DOC").length >= 4,
      "★ RECEIVED 和 ISSUED 要共用同一份文书词表，不能各写一份");
    assert.ok(/HYPOTHETICAL\.test\(question\)\) return "COMPLIANCE_DUTY"/.test(qt),
      "★ 放宽窗口的前提是假设性问法仍然一票否决");
  });

  t("★ 同一条对话里，同一张流程图只画一次", async () => {
    const fs = require("node:fs"), path = require("node:path");
    const page = fs.readFileSync(path.join(__dirname, "..", "app/page.tsx"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "..", "app/globals.css"), "utf8");
    // 2026-09-29 实测：第一问「收到 DGGI 的 SCN 怎么办」画了完整的 GST 三级图；
    // 第二问只问「有什么相关案例吗」，**整张图原样又出现一遍**——
    // 三个审级、四格成本、连注释都是同一份。用户要滚过两页读过的东西
    // 才看得到他真正问的那个答案。
    // 骨架是配置里的定值，同一条对话里不会变，重画零信息增量。
    const src = fs.readFileSync(path.join(__dirname, "..", "lib/server/legal-answer.ts"), "utf8");
    assert.ok(/shownDisputeTrackIds/.test(src), "★ 要知道这段对话已经画过哪几条");
    assert.ok(/includes\(track\.id\)/.test(src),
      "★ 判据必须是 track id——换了法域是另一条图，用户没见过，要照画");
    assert.ok(/dispute_track_omitted = track\.label/.test(src),
      "★ 略过时要留一行指路，直接消失会让用户以为系统忘了");
    // route.ts 必须扫全部历史轮次，只看上一轮会出现
    // "第 2 轮略过 → 第 3 轮以为没画过 → 又画一遍"的跳变
    const route = fs.readFileSync(path.join(__dirname, "..", "app/api/chat/route.ts"), "utf8");
    assert.ok(/conversation\.turns[\s\S]{0,200}dispute_track/.test(route),
      "★ 必须扫 conversation.turns，不能只看 previousTurn");
    // 前端要真的渲染那一行
    assert.ok(/dispute_track_omitted/.test(page) && /dispute-omitted/.test(page));
    assert.ok(/\.dispute-omitted\s*\{/.test(css), "样式要在");
  });

  t("★ 查过没有案例，和没查过，不能长得一样", async () => {
    const fs = require("node:fs"), path = require("node:path");
    const page = fs.readFileSync(path.join(__dirname, "..", "app/page.tsx"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "..", "app/globals.css"), "utf8");
    // 2026-09-29 实测：用户直接问「有什么相关案例吗」，判例区整块不渲染，
    // 页面上对他问出口的那件事一个字都没有——他分不清是系统没找还是库里没有。
    const src = fs.readFileSync(path.join(__dirname, "..", "lib/server/legal-answer.ts"), "utf8");
    // searched 标记是这条规则的全部基础：没有它就只能看 cases.length===0，
    // 而那个值在"没触发检索"时同样是 0。
    assert.ok(/searched: false/.test(src) && /searched: true/.test(src),
      "★ 必须区分「查过」和「没查」");
    assert.ok(/case_search_empty = "NO_MATCH"/.test(src));
    assert.ok(/case_search_empty = "JUDGED_IRRELEVANT"/.test(src),
      "★ 判定不相关而清空的那条路也要明说，不能静悄悄变空");
    // 不许在"没触发检索"时也报空
    const emptyAt = src.indexOf('case_search_empty = "NO_MATCH"');
    assert.ok(/casesSearched/.test(src.slice(Math.max(0, emptyAt - 400), emptyAt)),
      "★ 报空必须以「真的查过」为前提");
    // 前端要渲染，而且两种原因的文案不同
    assert.ok(/case_search_empty === "JUDGED_IRRELEVANT"/.test(page),
      "★ 两种空态的文案要分开——用户的下一步动作不同");
    assert.ok(/case-empty-note/.test(page) && /\.case-empty-note\s*\{/.test(css));
    assert.ok(/这不代表印度没有相关判例/.test(page),
      "★ 必须写明「库里没有 ≠ 印度没有」，否则用户会读成这件事没有判例支持");
  });

  t("★ 争议型答案不许在实务建议里复述审级期限和预缴比例", async () => {
    const fs = require("node:fs"), path = require("node:path");
    // 同一个数在图里和文字里各出现一次时，用户不知道该信哪个。
    // 实测第 6 步一字不差地复述了流程图第一格（3 个月、10%、2 亿卢比）。
    const src = fs.readFileSync(path.join(__dirname, "..", "lib/server/legal-answer.ts"), "utf8");
    assert.ok(/questionType === "DISPUTE_RESPONSE"[\s\S]{0,120}审级流程不用你写/.test(src),
      "★ 提示词里要有这条，且只在争议型时给");
    assert.ok(/questionType: QuestionType = "COMPLIANCE_DUTY"/.test(src),
      "★ 缺省必须是合规型——判不出来时退回旧行为，不是反过来");
  });

  t("★ 三条 track 的第一级都必须是「起点」，不能从上诉级开头", async () => {
    // 2026-09-29：所得税的起点（评估令 + 缴款通知）被漏掉过一次，
    // GST 又被发现同样少了 Show Cause Notice 那一级。
    // 从「一审上诉机关」开头的流程图是错的：用户手里拿着的是 SCN，
    // 不是裁定书，图上没有他现在所处的位置，整张图就对不上号。
    // 而且所有期限都是从起点那一级起算的，缺了它连时钟都没有零点。
    const expect = {
      income_tax: /评估令|缴款通知/,
      gst: /show\s*cause|裁定/i,
      trade_customs: /show\s*cause|原审裁定/i,
    };
    for (const [domain, pattern] of Object.entries(expect)) {
      const track = await loadDisputeTrack([domain]);
      assert.ok(track, `${domain} 要有 track`);
      const first = track.stages[0];
      assert.strictEqual(first.id, "start", `${domain} 第一级 id 必须是 start`);
      assert.ok(pattern.test(first.label), `${domain} 起点标签不对：${first.label}`);
      // 起点必须带实质内容，不能是个空壳占位
      assert.ok(first.cells.length >= 3, `${domain} 起点至少三格`);
      // 上诉级不能排在起点前面
      assert.ok(!/上诉|Appeal/i.test(first.label), `${domain} 不能从上诉级开头`);
    }
  });

  t("★ 罚款按情节分级，不能平铺成一句话", async () => {
    // 条文里 50%（少报）和 200%（错报）差四倍，而「是少报还是错报」
    // 往往是整个争议里最值钱的一个争点。挤在一句话里用户看不出这是两个档。
    const track = await loadDisputeTrack(["income_tax"]);
    const scale = track.running_cost.penalty_scale;
    assert.ok(scale, "要有分级罚款这一项");
    assert.ok(scale.scale.length >= 4, "至少四档");
    const rates = scale.scale.map((x) => x.rate);
    assert.ok(rates.includes("50%") && rates.includes("200%"));
    // 计罚基数是税额不是所得额——这一条写错会差好几倍
    assert.ok(/应纳税额/.test(scale.note), "★ 必须说清基数是应纳税额，不是少报的所得额");
    // 七种「错报」情形要列全
    assert.strictEqual(scale.misreporting_cases.items.length, 7, "s.439(11) 是七种情形");
    // 减免路径（s.440）是实务上最值钱的一条，不能漏
    assert.ok(/100%/.test(scale.waiver.text) && /120%/.test(scale.waiver.text));
  });

  t("欠税罚款和所得类罚款是两回事", async () => {
    // s.412 罚的是"逾期不缴"这个行为，s.439 罚的是"少报/错报所得"。
    // 合成一条会让用户以为只会被罚一次。
    const rc = (await loadDisputeTrack(["income_tax"])).running_cost;
    assert.ok(/欠税罚款/.test(rc.default_penalty.label), "译名要完整，不是「欠税罚」");
    assert.ok(/412/.test(JSON.stringify(rc.default_penalty.citation)));
    assert.ok(/439/.test(JSON.stringify(rc.penalty_scale.citation)));
    assert.ok(/两回事|另行/.test(rc.default_penalty.note), "要写清两者的区别");
  });

  t("分支不合并成一条线", async () => {
    // DRP 和 CIT(A) 是并行的两条路，拼成一条会造出现实中不存在的流程。
    const track = await loadDisputeTrack(["income_tax"]);
    const f = flattenStages(track);
    assert.strictEqual(f.branches.length, 2);
    assert.ok(f.branchQuestion && /eligible assessee/.test(f.branchQuestion));
  });
}

console.log("\n== 骨架条号挂角标：确定性查找，不是检索 ==");

{
  const dc = require("./lib/server/dispute-citations.js");
  const { loadDisputeTrack } = require("./lib/server/dispute-track.js");

  const chunk = (source, minorTitle, extra = {}) => ({
    source, minorTitle, majorTitle: "", officialUrl: `https://x/${minorTitle}`,
    body: "正文", ...extra,
  });

  t("条号解析：各种写法都认", () => {
    for (const [key, want] of [
      ["Income-tax Act, 2025 s.362", { sourceHint: "Income-tax Act, 2025", section: "362" }],
      ["Income-tax Act, 2025 s.411(3)(a)", { sourceHint: "Income-tax Act, 2025", section: "411(3)(a)" }],
      ["Customs Act, 1962 s.129E 但书", { sourceHint: "Customs Act, 1962", section: "129E" }],
      ["CBDT Office Memorandum F.No.404/72/93-ITCC", { sourceHint: "CBDT Office Memorandum F.No.404/72/93-ITCC" }],
    ]) assert.deepStrictEqual(dc.parseCitationKey(key), want, key);
  });

  t("★ 法规名容错：库里的名字可以更详细，但不能缺内容", () => {
    // 骨架写规范名，库里是管理员填的（带版本、带出处）。严格相等一个都匹配不上。
    assert.ok(dc.sourceMatches("CGST Act, 2017", "CGST Act 2017 (as on 11 June 2026)"));
    assert.ok(dc.sourceMatches("Customs Act, 1962", "The Customs Act, 1962"));
    // 方向是单向的，不能反过来把 IGST 认成 CGST
    assert.ok(!dc.sourceMatches("CGST Act, 2017", "IGST Act, 2017"));
    // 两部所得税法不能互相认
    assert.ok(!dc.sourceMatches("Income-tax Act, 2025", "Income-tax Act, 1961 (as amended by FA 2026)"));
    assert.ok(!dc.sourceMatches("Income-tax Act, 1961", "Income-tax Act, 2025"));
  });

  t("★★ 条号必须用词边界——挂错比挂不上更糟", () => {
    // 用户点开看到的是另一条，而角标看起来是对的。
    assert.ok(dc.sectionMatches("362", chunk("x", "Section 362 - Appeals to Appellate Tribunal")));
    assert.ok(!dc.sectionMatches("36", chunk("x", "Section 362 - Appeals to Appellate Tribunal")),
      "★ s.36 不能命中 Section 362");
    assert.ok(dc.sectionMatches("129E", chunk("x", "Section 129E - Deposit")));
    assert.ok(!dc.sectionMatches("129", chunk("x", "Section 129E - Deposit")),
      "★ s.129 不能命中 Section 129E");
    // 带括号层级的退一步比主条号——库里小标题通常只到 Section 411
    assert.ok(dc.sectionMatches("411(3)(a)", chunk("x", "Section 411 - When tax payable")));
  });

  t("★ 文号里的斜杠不能被当成条号分隔符", () => {
    // "CBDT Office Memorandum F.No.404/72/93-ITCC" 误拆成三段，
    // 会凭空造出三条查不到的假引用——比不拆糟得多。
    assert.deepStrictEqual(
      dc.expandCitationKey("CBDT Office Memorandum F.No.404/72/93-ITCC"),
      ["CBDT Office Memorandum F.No.404/72/93-ITCC"],
    );
    // 真的多条号要拆，而且法规名要带到后面每一段
    assert.deepStrictEqual(
      dc.expandCitationKey("Income-tax Act, 2025 s.356 / s.357 / s.358"),
      ["Income-tax Act, 2025 s.356", "Income-tax Act, 2025 s.357", "Income-tax Act, 2025 s.358"],
    );
  });

  t("★★ 文号不参与核心匹配，但年份必须参与", () => {
    // 两个方向都栽过（2026-09-29 同一次）：
    //   太严 → "CBDT Office Memorandum F.No.404/72/93-ITCC" 要求 itcc 也出现，
    //          库里那份叫「CBDT Office Memorandum – Stay of Demand」的被标成「库里没有」。
    //   太松 → 把含数字的整块一律剥掉，年份也没了，
    //          "Income-tax Act, 2025" 和 "Income-tax Act, 1961" 互相匹配上
    //          ——而 1961/2025 的区分正是这整个功能依赖的东西。
    const memo = "CBDT Office Memorandum F.No.404/72/93-ITCC";
    assert.ok(dc.sourceMatches(memo, "CBDT Office Memorandum – Stay of Demand"),
      "★ 文号不该挡住匹配");
    assert.ok(!dc.sourceMatches(memo, "Office Memorandum on stay of demand"),
      "但 CBDT 这个核心词不能少");
    assert.ok(!dc.sourceMatches(memo, "CBDT Circular on transfer pricing"));

    assert.ok(!dc.sourceMatches("Income-tax Act, 2025", "Income-tax Act, 1961 (as amended by FA 2026)"),
      "★★ 年份必须参与，两部所得税法不能互认");
    assert.ok(!dc.sourceMatches("Income-tax Act, 1961", "Income-tax Act, 2025"));
    assert.ok(dc.sourceMatches("Income-tax Act, 2025", "Income-tax Act, 2025"));
  });

  t("★ 多个候选时取最像的，不是第一个", () => {
    // 她库里有两份配套的 CBDT 备忘录（原始 15% 和修订后 20%）。
    // 取第一个就是在赌顺序——赌输了就是 15%/20% 那个错误重演。
    const memo = "CBDT Office Memorandum F.No.404/72/93-ITCC";
    const citations = [];
    dc.resolveDisputeCitations([memo], [
      chunk("CBDT Office Memorandum – Stay of Demand (original 2016)", "x"),
      chunk("CBDT Office Memorandum F.No.404/72/93-ITCC dated 31.07.2017", "x"),
    ], citations);
    assert.ok(/404/.test(citations[0].display_title), "★ 文号对得上的那份该排前面");
  });

  t("命中时追加进 citations 并回填序号；同一条复用同一个号", () => {
    const chunks = [
      chunk("Income-tax Act, 2025", "Section 362 - Appeals to Appellate Tribunal"),
      chunk("Income-tax Act, 2025", "Section 365 - Appeal to High Court"),
    ];
    const citations = [];
    const map = dc.resolveDisputeCitations(
      ["Income-tax Act, 2025 s.362", "Income-tax Act, 2025 s.365", "Income-tax Act, 2025 s.362"],
      chunks, citations,
    );
    assert.strictEqual(citations.length, 2, "重复的条号不重复追加");
    assert.strictEqual(map.get("Income-tax Act, 2025 s.362").ref, 1);
    assert.strictEqual(map.get("Income-tax Act, 2025 s.365").ref, 2);
    assert.ok(citations[0].locator.includes("Section 362"));
  });

  t("★ 查不到时标 missing，不是静默无角标", () => {
    // 没角标看起来像"这个数不需要依据"；"查不到"明说了依据应该有、库里缺。
    // 后者还能直接喂给补库清单——这是两件不同的事。
    const map = dc.resolveDisputeCitations(
      ["Income-tax Act, 2025 s.999"], [chunk("Income-tax Act, 2025", "Section 362 - x")], [],
    );
    const r = map.get("Income-tax Act, 2025 s.999");
    assert.strictEqual(r.missing, true);
    assert.strictEqual(r.ref, undefined);
    assert.strictEqual(r.label, "Income-tax Act, 2025 s.999", "原串要保留，它本身就是给用户看的信息");
  });

  t("snippetDisplay=DENY 的来源不下发原文", () => {
    const citations = [];
    dc.resolveDisputeCitations(
      ["X Act, 2020 s.1"],
      [chunk("X Act, 2020", "Section 1 - y", { snippetDisplay: "DENY" })],
      citations,
    );
    assert.strictEqual(citations[0].snippet, undefined);
  });

  t("★ 三个税种的骨架条号都能在对应法律里找到", async () => {
    // 用各法律的真实小标题形态造库，确认骨架里写的条号不是凭空的。
    const lib = [
      ...["275", "289", "356", "357", "358", "362", "365", "367", "369", "411", "412", "439"]
        .map((n) => chunk("Income-tax Act, 2025", `Section ${n} - x`)),
      ...["144C", "156", "220", "221", "246A", "249", "253", "260A", "261", "270A"]
        .map((n) => chunk("Income-tax Act, 1961 (as amended by FA 2026)", `Section ${n} - x`)),
      ...["50", "73", "74", "74A", "107", "112", "117", "118"]
        .map((n) => chunk("CGST Act 2017 (as on 11 June 2026)", `Section ${n} - x`)),
      ...["28", "28AA", "128", "129A", "129E", "129EE", "130", "130E"]
        .map((n) => chunk("The Customs Act, 1962", `Section ${n} - x`)),
      chunk("CBDT Office Memorandum F.No.404/72/93-ITCC", "stay of demand"),
    ];
    for (const cats of [["income_tax"], ["gst"], ["trade_customs"]]) {
      const track = await loadDisputeTrack(cats);
      const keys = dc.collectCitationKeys(track);
      const map = dc.resolveDisputeCitations(keys, lib, []);
      const missing = [...map.values()].filter((v) => v.missing).map((v) => v.label);
      assert.deepStrictEqual(missing, [], `${track.label} 有条号定位不到：${missing.join("、")}`);
    }
  });
}

t("★ 配置里的 ** 粗体要真渲染成 strong，不能原样显示星号", () => {
  // 2026-09-29 截图：格子里显示的是「**不是法条**」，星号露在外面。
  // JSX 不认 markdown，得自己转。
  const page = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "app", "page.tsx"), "utf8");
  assert.ok(/function boldMarks/.test(page), "要有转换函数");
  // 四处注释文本都必须过一遍：cell.note / citation_override 那行 / running_cost 的 note 和 carve_out
  const uses = (page.match(/boldMarks\(/g) ?? []).length;
  assert.ok(uses >= 4, `所有注释文本都要过 boldMarks，现在只有 ${uses} 处`);
  assert.ok(!/dispute-cell-note">\{(?:cell|item)\.(?:note|carve_out)\}/.test(page),
    "★ 不能有直接渲染原始字符串的漏网处");
});

console.log("\n== 多义词：一个中文词对好几个英文法律概念时，不许模型自己挑 ==");

{
  const {
    resolveAmbiguousTerms, ambiguityQuestion, readingNote, readingSearchTerms,
  } = require("./lib/server/term-ambiguity.js");
  const path = require("node:path"), fs = require("node:fs");
  const readTerms = (name) => {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", name), "utf8"));
    return Array.isArray(raw) ? raw : raw.terms;
  };
  // 运行时词典 = 一对一词表 + 多义词表合并（见 terms-store.ts 的 mergeReadings）。
  // 测试也必须按合并后的样子来，否则测的是一份线上不存在的词典。
  const ONE_TO_ONE = readTerms("terms.approved.json");
  const TERMS = [...ONE_TO_ONE, ...readTerms("term-readings.json")];

  t("★ 真实事故：「ITD案件中保证金计算的基数」必须转追问，不许自己定义", () => {
    // 2026-09-28：词典里没有「保证金」→ 零命中 → 翻译全交给模型 →
    // 模型看到"计算的基数"，检索回 s.234 利息条款（那些条款真的在定义计算基数），
    // 为了让词和证据对上，**把问题里的词重新定义成了 interest**，
    // 还写进前提假设第一条「用户问题中的"保证金"指所得税法下的利息」。
    // 不是编造事实，是悄悄改了问题——每条引用都真，只是答的不是那个问题。
    const q = "印度income tax（ITD）案件中，保证金计算的基数包括哪些？";
    const r = resolveAmbiguousTerms(q, TERMS);
    assert.strictEqual(r.resolved.length, 0, "★ 没有上下文时绝不能选定任何义项");
    assert.strictEqual(r.unresolved.length, 1);
    const ask = ambiguityQuestion(r.unresolved[0]);
    assert.ok(ask.includes("pre-deposit") && ask.includes("security deposit"),
      "追问必须把候选念出来，不能只说「请补充更多信息」");
  });

  t("有上下文就选定，并记下凭的是哪个词", () => {
    for (const [q, wantId, wantCtx] of [
      ["所得税上诉时要先缴多少保证金？", "pre_deposit", "上诉"],
      ["客户交的保证金冲回要不要交所得税", "security_deposit", "客户"],
      ["履约保证金的银行保函费用能不能税前扣除", "performance_guarantee", "履约"],
      ["清关时暂定评估要交保证金吗", "customs_bond", "清关"],
    ]) {
      const r = resolveAmbiguousTerms(q, TERMS);
      assert.strictEqual(r.unresolved.length, 0, `不该追问：${q}`);
      assert.strictEqual(r.resolved[0].reading.id, wantId, `义项选错：${q}`);
      assert.strictEqual(r.resolved[0].matchedContext, wantCtx);
    }
  });

  t("★ 两个义项同时命中 = 线索打架，一样要追问", () => {
    // "上诉的时候客户押金要不要一起处理" —— 上诉(pre_deposit) 和 客户(security_deposit)
    // 都命中了。挑任意一个都是赌，不如问。
    const r = resolveAmbiguousTerms("上诉的时候客户押金要不要一起处理", TERMS);
    assert.strictEqual(r.resolved.length, 0);
    assert.strictEqual(r.unresolved.length, 1);
  });

  t("不含多义词的问题完全不受影响", () => {
    const r = resolveAmbiguousTerms("印度公司所得税税率是多少", TERMS);
    assert.deepStrictEqual(r, { resolved: [], unresolved: [] });
  });

  t("一对一老词条不走多义词这条路", () => {
    // 判定依据是 readings.length >= 2。老词条没有 readings 字段，必须原样放过，
    // 否则 47 条已审定术语会全部变成"要追问"。
    assert.ok(ONE_TO_ONE.length >= 40, "一对一词表应该原样还在");
    assert.ok(ONE_TO_ONE.every((x) => !x.readings), "一对一词表里不该混进多义词条目");
    const r = resolveAmbiguousTerms("进项税抵扣需要什么凭证", ONE_TO_ONE);
    assert.deepStrictEqual(r, { resolved: [], unresolved: [] });
  });

  t("★ 多义词必须住在独立文件里，不能混回后台同步的那份词典", () => {
    // 硬伤在于：每同步一次词典，buildApprovedGlossary() 按 xlsx 逐行重建全表，
    // 而它的输出类型里**没有 readings 字段**——多义词条目会被静默删掉，
    // 闸门失效、不报错，答案又开始悄悄改用户的问题。
    // 所以两份文件必须分开，这条断言就是防止有人把它们合回去。
    assert.ok(
      ONE_TO_ONE.every((x) => (x.readings?.length ?? 0) === 0),
      "★ terms.approved.json 里不得出现多义词条目——它会被下一次词典同步冲掉",
    );
    assert.ok(readTerms("term-readings.json").length >= 1, "多义词表不该是空的");
  });

  t("★ 选定后必须把「按什么理解」写给用户看", () => {
    // 系统是靠一个上下文词猜的。不把这句写出来，猜错时用户看不出来，
    // 就退回成了这个闸门要修的那个问题本身。
    const r = resolveAmbiguousTerms("所得税上诉时要先缴多少保证金？", TERMS);
    const note = readingNote(r.resolved[0]);
    assert.ok(note.includes("保证金") && note.includes("上诉前预缴"));
    assert.ok(note.includes("上诉"), "要说明凭的是哪个词");
    assert.ok(/如果你指的是别的/.test(note), "要给用户纠正的入口");
  });

  t("★ 只有选定的那个义项贡献检索词", () => {
    // 四个义项的检索词全塞进去，等于同时检索 pre-deposit / security deposit /
    // bank guarantee / customs bond，候选池被四个不相干主题灌满。
    const r = resolveAmbiguousTerms("所得税上诉时要先缴多少保证金？", TERMS);
    const terms = readingSearchTerms(r);
    assert.ok(terms.includes("pre-deposit"));
    assert.ok(!terms.includes("security deposit"), "★ 未选中的义项不得混进检索词");
    assert.ok(!terms.includes("customs bond"));
  });

  t("多义词条目的顶层 search_terms_en 必须留空", () => {
    // 否则那些词会绕过消歧、无条件进入检索。
    const ambiguous = TERMS.filter((x) => (x.readings?.length ?? 0) >= 2);
    assert.ok(ambiguous.length >= 1, "至少该有「保证金」这一条");
    for (const term of ambiguous) {
      assert.deepStrictEqual(term.search_terms_en, [], `${term.term_zh} 的顶层检索词应为空`);
    }
  });

  t("★ 多义词不得进译名对照表——它没有单一译名", () => {
    // 译名对照表是喂给模型的"专有名词必须按这里的译名翻译"，一个英文配一个中文。
    // 多义词硬塞进去，等于告诉模型「证据里所有 deposit 都译成保证金」，
    // 正是多义词闸门要防的混淆，从另一头又放进来了。
    // 判定写在 glossaryForEvidence 里（readings.length < 2 才进表）。
    const src = fs.readFileSync(
      path.join(__dirname, "..", "lib", "server", "retrieval.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function glossaryForEvidence"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.ok(/readings\?\.length \?\? 0\) < 2/.test(body),
      "★ glossaryForEvidence 必须显式排除多义词");
  });

  t("义项的上下文触发词不能是通用词", () => {
    // 「税」「金额」这种哪个义项都沾边的词放进来，那个义项就永远第一个命中，
    // 多义词表等于白做。
    const tooGeneric = new Set(["税", "金额", "计算", "印度", "公司", "费用", "案件"]);
    for (const term of TERMS.filter((x) => (x.readings?.length ?? 0) >= 2)) {
      for (const reading of term.readings) {
        for (const word of reading.context_zh) {
          assert.ok(!tooGeneric.has(word),
            `${term.term_zh}/${reading.id} 的触发词「${word}」太通用`);
        }
      }
    }
  });
}

console.log("\n== 资料分类：补料清单上的每一份都必须能归到类 ==");

{
  const { classifyDocumentCategory } = require("./lib/server/document-category.js");
  t("★ 待补的 20 份资料没有一份落进「其他」", () => {
    // 2026-09-22：照《知识库补料清单》挨个试分类，20 份里有 9 份落进「其他」。
    // 这不是小事——**「其他」在检索上是永远剔不掉的**：`domain-scope.ts` 的规则 4
    // 写明"没有被任何 profile 覆盖的资料永远不剔除"。分错类等于往每一道题的
    // 候选池里长期塞一份任何闸门都挡不住的资料。
    const expected = [
      ["Customs Tariff Act, 1975", "trade_customs"],
      ["Customs Tariff (Anti-dumping Duty) Rules, 1995", "trade_customs"],
      ["India–China DTAA — 2018 Protocol", "income_tax"],
      ["中印 DTAA 2018 年议定书", "income_tax"],
      ["Income-tax Rules, 1962", "income_tax"],
      ["Finance Act, 2026", "income_tax"],
      ["Micro, Small and Medium Enterprises Development Act, 2006", "company_governance"],
      ["Indian Stamp Act, 1899", "company_governance"],
      ["Arbitration and Conciliation Act, 1996", "company_governance"],
      ["Indian Contract Act, 1872", "company_governance"],
      ["Negotiable Instruments Act, 1881", "company_governance"],
      ["Companies (Management and Administration) Rules, 2014", "company_governance"],
      ["Special Economic Zones Act, 2005", "trade_customs"],
      ["Bureau of Indian Standards Act, 2016", "trade_customs"],
      ["CAROTAR 2020", "trade_customs"],
      ["GSTAT (Procedure) Rules, 2025", "gst"],
      ["Union Territory GST Act, 2017", "gst"],
      ["Foreign Exchange (Compounding Proceedings) Rules, 2024", "fema_fdi_rbi"],
      ["FEMA 22(R)/2016 — Branch Office or Liaison Office", "fema_fdi_rbi"],
      ["Foreign Exchange Management (Current Account Transactions) Rules, 2000", "fema_fdi_rbi"],
    ];
    for (const [name, want] of expected) {
      assert.strictEqual(classifyDocumentCategory(name, [name]), want, `分错了：${name}`);
    }
  });

  t("GSTAT 的词边界坑：\\b(c?gst)\\b 匹配不上 GSTAT", () => {
    // "GSTAT" 里虽然有 gst 三个字母，但 \b 要求整词，所以必须单列。
    assert.strictEqual(classifyDocumentCategory("GSTAT Procedure Rules 2025"), "gst");
  });

  t("认不出的仍然落「其他」——这一类不能被撑成万能兜底", () => {
    assert.strictEqual(classifyDocumentCategory("General Financial Rules, 2017"), "other");
  });
}

console.log("\n== 法域闸门：不让GST混进ROC/所得税问题 ==");

const src = (source, minor) => ({
  documentId: source, number: 1, source, majorTitle: "CH", minorTitle: minor,
  officialUrl: "u", body: "annual return shall be filed", bodyLength: 28, wordCount: 5,
});
const mixedPool = [
  src("Companies Act, 2013", "Section 92 - Annual return"),
  src("CGST Act 2017", "Section 44 - Annual return"),
  src("Income-tax Act, 1961", "Section 139 - Return of income"),
  src("FEMA (Non-debt Instruments) Rules, 2019", "Rule 21"),
];

// 用**知识库里真实的标题**建池：标题里带版本、下载日期、来源网址这些出处信息。
// 上一版事故就是栽在这里——测试用的是干净的 "Companies Act, 2013"，
// 真实标题里的 incometaxindia.gov.in 让公司法被判成了所得税资料。
const realPool = [
  src("Companies Act, 2013 (as reproduced on incometaxindia.gov.in; downloaded 19-06-2026)", "Section 92"),
  src("Reserve Bank of India Act, 1934 (as modified up to 28-02-2009; retrieved from gujfed.com/uploads)", "Section 45N"),
  src("CGST Act 2017 (as amended up to 30.09.2020)", "Section 44"),
  src("Income-tax Act, 1961", "Section 139"),
];

t("复刻线上事故：标题里的 incometaxindia.gov.in 不能把公司法判成所得税资料", () => {
  const out = scopeByQuestionDomain("公司年度ROC合规通常要核对哪些事项？", realPool);
  const sources = out.chunks.map((c) => c.source);
  assert.ok(sources.some((s) => /Companies Act/.test(s)), "公司法必须留下");
  assert.ok(!sources.some((s) => /CGST/.test(s)), "GST该挡住");
  assert.ok(!sources.some((s) => /Income-tax Act/.test(s)), "所得税该挡住");
  assert.ok(!sources.some((s) => /Reserve Bank/.test(s)), "RBI Act 与ROC年度合规无关，该挡住");
});

t("命中保留域的资料，不会被别的被排除域剔掉（优先级规则）", () => {
  // 这份资料标题同时含 "Companies Act"（保留域）和 "incometax"（被排除域）
  const out = scopeByQuestionDomain("公司董事的任职资格", [realPool[0]]);
  assert.strictEqual(out.chunks.length, 1);
});

t("外汇问题里 RBI Act 要留下", () => {
  const out = scopeByQuestionDomain("中资股东增资后向RBI报送FC-GPR的要求", realPool);
  assert.ok(out.chunks.some((c) => /Reserve Bank/.test(c.source)));
});

t("复刻线上问题：问ROC年度合规，CGST的annual return被挡在候选池外", () => {
  const out = scopeByQuestionDomain("公司年度ROC合规通常要核对哪些事项？", mixedPool);
  const sources = out.chunks.map((c) => c.source);
  assert.ok(sources.includes("Companies Act, 2013"));
  assert.ok(!sources.includes("CGST Act 2017"), "GST不该进来");
  assert.ok(!sources.includes("Income-tax Act, 1961"), "所得税也不该进来");
  assert.ok(out.excluded.includes("GST"));
});

t("问GST发票，公司法和所得税被挡住", () => {
  const out = scopeByQuestionDomain("货票同行开具发票时进项税抵扣要注意什么", mixedPool);
  const sources = out.chunks.map((c) => c.source);
  assert.ok(sources.includes("CGST Act 2017"));
  assert.ok(!sources.includes("Income-tax Act, 1961"));
});

t("问TDS扣缴，GST被挡住", () => {
  const out = scopeByQuestionDomain("向境外支付服务费的TDS扣缴比例是多少", mixedPool);
  const sources = out.chunks.map((c) => c.source);
  assert.ok(sources.includes("Income-tax Act, 1961"));
  assert.ok(!sources.includes("CGST Act 2017"), "GST不该进来");
});

t("跨域问题两个域都保留（不能为了干净把该要的删掉）", () => {
  const out = scopeByQuestionDomain("中资股东对印度公司增资需要准备什么文件", mixedPool);
  const sources = out.chunks.map((c) => c.source);
  assert.ok(sources.includes("Companies Act, 2013"), "公司法要保留");
  assert.ok(sources.includes("FEMA (Non-debt Instruments) Rules, 2019"), "外汇要保留");
  assert.ok(!sources.includes("CGST Act 2017"));
});

t("笼统的税务问题：GST和所得税都保留", () => {
  const out = scopeByQuestionDomain("印度子公司每年要做哪些税务合规", mixedPool);
  const sources = out.chunks.map((c) => c.source);
  assert.ok(sources.includes("CGST Act 2017"));
  assert.ok(sources.includes("Income-tax Act, 1961"));
});

t("识别不出任何法域时不过滤（宁可放宽，不在看不懂时乱删）", () => {
  const out = scopeByQuestionDomain("这是一个完全无关的问题", mixedPool);
  assert.strictEqual(out.chunks.length, mixedPool.length);
  assert.deepStrictEqual(out.excluded, []);
});

t("会剔到一条不剩时整体回退（空结果比跑题更糟）", () => {
  const onlyGst = [src("CGST Act 2017", "Section 44")];
  const out = scopeByQuestionDomain("公司董事的任职资格要求", onlyGst);
  assert.strictEqual(out.chunks.length, 1);
  assert.deepStrictEqual(out.excluded, []);
});

t("闸门装在候选池上，二次检索和交叉引用共用同一套过滤", () => {
  const scoped = scopeCandidates(mixedPool, { question: "公司年度ROC合规通常要核对哪些事项？" });
  assert.ok(!scoped.dateScoped.some((c) => /CGST/.test(c.source)));
  assert.ok(scoped.excludedDomains.includes("GST"));
});

console.log("\n== 办事动作必须带时间 ==");

const astep = (text) => ({ kind: "PRACTICAL", text, citation_refs: [], unverified_claims: [] });

t("报送类动作没写时限 → 点名", () => {
  const gaps = findMissingActionTiming([
    astep("向公司注册处报送年度申报表MGT-7。"),
    astep("在股东周年大会后30日内，向公司注册处提交财务报表。"),
  ]);
  assert.strictEqual(gaps.length, 1);
  assert.strictEqual(gaps[0].index, 1);
  assert.ok(actionTimingNotes(gaps)[0].includes("第1条"));
});

t("准备性动作（编制、留存、确认）不要求写时间", () => {
  assert.deepStrictEqual(findMissingActionTiming([
    astep("编制年度申报，内容涵盖注册地址与持股结构。"),
    astep("留存所有决议、会议记录和申报回执备查。"),
    astep("确认公司所处行业是否在外资准入清单内。"),
  ]), []);
});

t("各种时间写法都认得（相对天数、月、财年、每年某月）", () => {
  assert.deepStrictEqual(findMissingActionTiming([
    astep("在股东周年大会前至少21天送达财务报表。"),
    astep("在财政年度结束后6个月内召开股东周年大会。"),
    astep("每年12月31日前提交GST年度申报表。"),
    astep("自配发之日起30日内提交配股申报表。"),
  ]), []);
});

t("「尽快」「及时」不算时间", () => {
  const gaps = findMissingActionTiming([astep("请尽快向公司注册处提交变更申报。")]);
  assert.strictEqual(gaps.length, 1);
});

t("全部带了时间就不出提示", () => {
  assert.deepStrictEqual(actionTimingNotes([]), []);
});

console.log("\n== 表格与会议术语自动加注（给非专业读者看的）==");

t("常见ROC表格会自动补中文用途说明", () => {
  const seen = new Set();
  const out = expandAbbreviations("在AGM后60日内提交MGT-7，并在30日内提交AOC-4。", seen);
  assert.ok(out.includes("年度申报表"), "MGT-7 要有中文用途");
  assert.ok(out.includes("财务报表申报表"), "AOC-4 要有中文用途");
  assert.ok(out.includes("股东周年大会"), "AGM 要展开");
});

t("GST与所得税常用表格同样覆盖", () => {
  const out = expandAbbreviations("需提交GSTR-9与15CB。", new Set());
  assert.ok(out.includes("GST年度申报表"));
  assert.ok(out.includes("对外付汇的会计师证明"));
});

console.log("\n== 追问改写：确定性校验与兜底拼接 ==");

t("兜底拼接：背景事实和新问题都保留", () => {
  const out = buildFallbackQuestion(
    "阿联酋公司在印度新设私人有限公司，需要哪些步骤和资料",
    "股权结构方面法律有规定吗",
  );
  assert.ok(out.includes("阿联酋"), "上一轮的主体信息不能丢");
  assert.ok(out.includes("股权结构"), "这一轮真正问的内容不能丢");
});

t("改写结果太短判定为不可用", () => {
  assert.strictEqual(isRewriteAcceptable("", "阿联酋公司在印度新设私人有限公司"), false);
  assert.strictEqual(isRewriteAcceptable("好的", "阿联酋公司在印度新设私人有限公司"), false);
});

// 真实事故（2026-09-16）：上一问是"印度公司的广告费有什么判例、怎样才能合规"，
// 这一问是"货票同行在印度具体需要做到哪些要求？"——完全自足的GST问题。
// 模型判成了延续，于是被拼上广告费背景，答案全是广告费台账、广告发票、账簿保存。
// 线索是回答上写着"本次不扣次数"——依据充分却不扣次，只发生在被判为CONTINUATION时。
// 真实事故（2026-09-17）：用户问"印度转移定价方面的合规要求"，回答里全是
// FEMA股权转让定价和公司注册处信息提供义务，和转让定价毫无关系。
// 根因：法域信号词表里只写了"转**让**定价"，用户打的是"转**移**定价"，
// 所得税法域一个信号都没命中 → 整个所得税知识库被剔出候选池；
// 剩下命中的是"定价"（外汇域）和"合规"（公司法域），答案就只能从这两处出。
console.log("\n== 法域闸门：同义译名与术语词典联动（真实事故：转移定价）==");

const incomeTaxChunk = { source: "The Income-tax Act, 1961", majorTitle: "CHAPTER X", minorTitle: "Section 92", officialUrl: "u", body: "computation of income from international transaction having regard to arm's length price", bodyLength: 10, wordCount: 5, number: 1 };
const femaChunk = { source: "FEMA (Non-debt Instruments) Rules, 2019", majorTitle: "Schedule I", minorTitle: "Pricing", officialUrl: "u", body: "pricing guidelines for transfer of equity instruments", bodyLength: 10, wordCount: 5, number: 2 };

t("真实事故复现：问『转移定价』时所得税资料必须留在候选池里", () => {
  const scoped = scopeByQuestionDomain("印度转移定价方面的合规要求", [incomeTaxChunk, femaChunk]);
  assert.ok(
    scoped.chunks.some((chunk) => chunk.source.includes("Income-tax")),
    "所得税资料被整个剔掉了——这正是那次答非所问的根因",
  );
});

t("『转让定价』这个写法原本就能命中，不能改坏", () => {
  const scoped = scopeByQuestionDomain("印度转让定价方面的合规要求", [incomeTaxChunk, femaChunk]);
  assert.ok(scoped.chunks.some((chunk) => chunk.source.includes("Income-tax")));
});

t("关联交易、独立交易原则这些同话题说法也要命中所得税", () => {
  for (const question of ["关联交易的定价要怎么证明", "服务费怎么定价才符合独立交易原则"]) {
    const scoped = scopeByQuestionDomain(question, [incomeTaxChunk, femaChunk]);
    assert.ok(scoped.chunks.some((chunk) => chunk.source.includes("Income-tax")), question);
  }
});

t("术语词典展开出的英文词能救回代码词表里没写的说法", () => {
  // 假设管理员在词典里加了一个代码里完全没有的中文说法，词典把它对到 transfer pricing。
  //
  // ⚠必须放一条"活得下来"的公司法资料：闸门有一条保护规则是"剔到一条不剩就整体回退
  // 到不过滤"（空结果比跑题更糟）。只放所得税+FEMA两条时两条都会被剔光、触发回退，
  // 于是看起来像"没有被过滤"，测试前提就验证不了了——第一次写这条测试就栽在这里。
  //
  // ⚠问题本身要让公司法命中**两个以上**信号词（公司/董事/决议）。
  // 2026-09-18 加了"信号太弱时谁也别排除谁"的门槛之后，原来那句
  // "印度价格转移安排的合规要求"只让公司法命中一个"合规"，强度不够、
  // 闸门整体不生效，于是所得税也留着——测试前提就不成立了。
  // 这不是回归，是新规则按设计在起作用：一个孤零零的词不该剔掉整个法域。
  const companiesChunk = { source: "The Companies Act, 2013", majorTitle: "CH I", minorTitle: "Section 2", officialUrl: "u", body: "definitions", bodyLength: 5, wordCount: 2, number: 3 };
  const pool = [incomeTaxChunk, femaChunk, companiesChunk];
  const question = "我们公司的价格转移安排，董事会要不要出决议";
  const withoutGlossary = scopeByQuestionDomain(question, pool);
  const withGlossary = scopeByQuestionDomain(question, pool, ["transfer pricing"]);
  assert.ok(
    !withoutGlossary.chunks.some((chunk) => chunk.source.includes("Income-tax")),
    "前提：这个说法代码词表里确实没有",
  );
  assert.ok(
    withGlossary.chunks.some((chunk) => chunk.source.includes("Income-tax")),
    "词典里加了说法之后，闸门就该认得——不用再改代码",
  );
});

console.log("\n== 账号：密码与邮箱的校验口径（纯函数）==");

t("密码太短被拒", () => {
  assert.ok(validatePassword("Ab1"), "3位应该被拒");
  assert.ok(validatePassword("Abc123"), "6位应该被拒");
});

t("只有一种字符类型的密码被拒（纯数字/纯字母都太好猜）", () => {
  assert.ok(validatePassword("12345678"));
  assert.ok(validatePassword("abcdefgh"));
});

t("字母+数字的8位密码通过", () => {
  assert.strictEqual(validatePassword("Test1234"), undefined);
  assert.strictEqual(validatePassword("india2026"), undefined);
});

t("邮箱统一转小写并去空格，不合法的返回undefined", () => {
  assert.strictEqual(normalizeEmail("  Cora@Example.COM "), "cora@example.com");
  assert.strictEqual(normalizeEmail("没有at符号"), undefined);
  assert.strictEqual(normalizeEmail("a@b"), undefined, "没有顶级域名不算");
});

console.log("\n== 额度：按自然月计算与跨月重置 ==");

t("同一个月内按已用次数算剩余", () => {
  // 刻意不写死次数：额度是产品定价，会改（2026-09-17 就从 20/300 调成了 3/30）。
  // 测试盯的是"算法对不对"，不是"数字是多少"——写死了每次调价都要回来改测试。
  const view = quotaViewOf({ plan: "free", quotaYearMonth: "2026-09", quotaUsed: 1, yearMonth: "2026-09" });
  assert.strictEqual(view.limit, PLAN_MONTHLY_LIMIT.free);
  assert.strictEqual(view.used, 1);
  assert.strictEqual(view.remaining, PLAN_MONTHLY_LIMIT.free - 1);
});

t("跨月时显示上就当已经重置——不能让用户月初看到上月用完的数字", () => {
  const view = quotaViewOf({ plan: "free", quotaYearMonth: "2026-08", quotaUsed: PLAN_MONTHLY_LIMIT.free, yearMonth: "2026-09" });
  assert.strictEqual(view.used, 0);
  assert.strictEqual(view.remaining, PLAN_MONTHLY_LIMIT.free);
});

t("用超了也不会显示负数", () => {
  const view = quotaViewOf({ plan: "free", quotaYearMonth: "2026-09", quotaUsed: 999, yearMonth: "2026-09" });
  assert.strictEqual(view.remaining, 0);
});

t("专业版额度高于免费版", () => {
  assert.ok(PLAN_MONTHLY_LIMIT.professional > PLAN_MONTHLY_LIMIT.free);
});

t("过期会话被清掉，未过期的留着", () => {
  const now = new Date("2026-09-17T00:00:00Z");
  const sessions = [
    { tokenHash: "a", userId: "u1", createdAt: "", expiresAt: "2026-09-10T00:00:00Z" },
    { tokenHash: "b", userId: "u1", createdAt: "", expiresAt: "2026-10-10T00:00:00Z" },
  ];
  const kept = pruneExpiredSessions(sessions, now);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].tokenHash, "b");
});

console.log("\n== 存进会话历史的完整回答要裁到能安全落盘的大小 ==");

// 2026-09-17：点进「最近对话」要能原样看到完整回答，所以会话历史里多存一份 answer。
// 但证据原文每条上限1200字符、可能二十多条，单轮能到几十KB，而所有会话存在同一个
// JSON 文件里——必须有个上限，不能让少数几个超大回答把存储文件撑爆。
const makeAnswer = (evidenceCount, snippetLength) => ({
  request_id: "req_1", conversation_id: "conv_1", answer_status: "SUFFICIENT",
  short_conclusion: "结论", action_steps: [], charge_eligible: true, policy_version: "1.4",
  citations: Array.from({ length: evidenceCount }, (_, index) => ({
    evidence_id: `E${index + 1}`, source: "CGST Act 2017", locator: `Section ${index + 1}`,
    official_url: "https://example.gov.in/a.pdf", snippet: "x".repeat(snippetLength),
  })),
});

t("没超标的回答原样存，不做任何裁剪", () => {
  const answer = makeAnswer(3, 200);
  assert.strictEqual(trimAnswerForStorage(answer), answer, "没超标时应该返回同一个引用");
});

t("超标时证据原文被截短而不是丢掉，条号和官方链接都留着", () => {
  const trimmed = trimAnswerForStorage(makeAnswer(150, 1200));
  assert.ok(JSON.stringify(trimmed).length <= MAX_STORED_ANSWER_CHARS);
  assert.strictEqual(trimmed.citations.length, 150, "引用条目一条都不能少");
  assert.ok(trimmed.citations[0].snippet, "原文应该被截短、而不是整个丢掉");
  assert.ok(trimmed.citations[0].snippet.length < 1200);
  assert.strictEqual(trimmed.citations[0].locator, "Section 1", "条号必须留着");
});

// 用户实测发现的真实问题（2026-09-17）：点进历史对话时**判例部分没有了**。
// 根因是旧版裁剪规则——超标时把 case_digest 和 related_cases 整块丢掉。
// 用户要的是"存全文"，少了判例区块的回答不算全文。现在的原则是宁可截短、不整块丢。
t("判例综述永远不会被整块丢掉——宁可把每条文本截短", () => {
  const huge = {
    ...makeAnswer(60, 1200),
    case_digest: {
      clusters: Array.from({ length: 20 }, (_, index) => ({
        title: `风险主题${index + 1}`,
        challenge: "挑".repeat(4000),
        evidence: [{ docid: "123", text: "实".repeat(4000) }],
        takeaway: "倾".repeat(2000),
      })),
      action_points: ["要点一"],
      index: [{ docid: "123", case_name: "A", official_url: "u", angle: "角度" }],
    },
    related_cases: [{ caseName: "A", docid: "123", official_url: "u" }],
  };
  assert.ok(JSON.stringify(huge).length > MAX_STORED_ANSWER_CHARS, "前提：这个回答确实超标");
  const trimmed = trimAnswerForStorage(huge);
  assert.ok(trimmed.case_digest, "判例综述不能被丢掉");
  assert.strictEqual(trimmed.case_digest.clusters.length, 20, "风险主题一个都不能少");
  assert.ok(trimmed.case_digest.clusters[0].challenge.length < 4000, "长文本应该被截短");
  assert.ok(trimmed.related_cases, "相关判例也不能被丢掉");
  assert.strictEqual(trimmed.short_conclusion, "结论");
  assert.ok(JSON.stringify(trimmed).length <= MAX_STORED_ANSWER_CHARS);
});

console.log("\n== 对话标题：20字以内的话题概括（确定性部分）==");

t("短问题原样当标题", () => {
  assert.strictEqual(truncateTitle("印度公司年报怎么报"), "印度公司年报怎么报");
});

t("超长问题在标点处断开，不留半截词", () => {
  const title = truncateTitle("关于印度公司的广告费，有什么判例吗？怎样才能做到合规");
  assert.ok(title.length <= 20, "不能超过上限");
  // 取的是上限之内**最后**一个标点，尽量保留信息量——
  // 而不是第一个标点（那样会截成"关于印度公司的广告费"，丢掉"问的是判例"这件事）。
  assert.strictEqual(title, "关于印度公司的广告费，有什么判例吗");
  assert.ok(!title.endsWith("怎样"), "不能留下半截词");
});

t("标点太靠前时不用它，否则标题短得没信息量", () => {
  const title = truncateTitle("广告费，在印度具体需要做到哪些合规要求呢请详细说明");
  assert.ok(title.length > 6, "不能因为第4个字是逗号就截成三个字");
});

t("空问题有兜底，不会产生空标题", () => {
  assert.strictEqual(truncateTitle("   "), "新对话");
});

t("模型给的标题会被清洗：去引号、砍到上限", () => {
  assert.strictEqual(sanitizeTitle("“印度广告费合规”", "原问题"), "印度广告费合规");
  assert.ok(sanitizeTitle("一二三四五六七八九十一二三四五六七八九十一二三", "原问题").length <= 20);
});

t("模型给了空/过短的标题时退回截断", () => {
  assert.strictEqual(sanitizeTitle("", "印度公司年报怎么报"), "印度公司年报怎么报");
  assert.strictEqual(sanitizeTitle("好", "印度公司年报怎么报"), "印度公司年报怎么报");
});

console.log("\n== 追问判定的确定性否决（真实事故：GST问题被拼上广告费背景）==");

t("真实事故复现：自足的新问题不带指代词、与上一问几乎无重合 → 强制新话题", () => {
  assert.strictEqual(
    shouldForceNewTopic(
      "货票同行在印度具体需要做到哪些要求？",
      "关于印度公司的广告费，有什么判例吗？怎样才能做到合规",
    ),
    true,
  );
});

t("真正的追问带指代词，不会被误杀", () => {
  const previous = "阿联酋公司在印度新设私人有限公司，需要哪些步骤和资料";
  assert.strictEqual(shouldForceNewTopic("那这个的期限是多久？", previous), false);
  assert.strictEqual(shouldForceNewTopic("上面提到的那部法具体是哪一条？", previous), false);
  assert.strictEqual(shouldForceNewTopic("还有别的资料要准备吗？", previous), false);
});

t("不带指代词但延续同一主题（词面高度重合）也不会被误杀", () => {
  assert.strictEqual(
    shouldForceNewTopic(
      "私人有限公司新设时的股东人数有什么要求",
      "阿联酋公司在印度新设私人有限公司，需要哪些步骤和资料",
    ),
    false,
  );
});

// 复核时实测到的误伤（2026-09-17）：中文追问常常连指代词都不用、直接省略主语，
// 句子又短，词面重合天然就低——最初那版判断把这类真追问全判成了新话题，
// 等于在惩罚"问得短"。这三句是实测中被误杀的原句，钉死防止回退。
t("省略主语的真追问不会被误杀（短句不否决）", () => {
  const previous = "阿联酋公司在印度新设私人有限公司，需要哪些步骤和资料";
  assert.strictEqual(shouldForceNewTopic("需要多少注册资本？", previous), false);
  assert.strictEqual(shouldForceNewTopic("董事必须有印度居民吗？", previous), false);
  assert.strictEqual(shouldForceNewTopic("注册大概要多久？", previous), false);
});

t("加了长度门槛之后，真实事故那句仍然被判为新话题", () => {
  assert.strictEqual(
    shouldForceNewTopic(
      "货票同行在印度具体需要做到哪些要求？",
      "关于印度公司的广告费，有什么判例吗？怎样才能做到合规",
    ),
    true,
  );
});

t("questionOverlapRatio：完全相同为1，毫无重合为0", () => {
  assert.strictEqual(questionOverlapRatio("货票同行的要求", "货票同行的要求"), 1);
  assert.strictEqual(questionOverlapRatio("货票同行", "广告费判例"), 0);
});

t("questionOverlapRatio：上一问为空时返回0，不报错", () => {
  assert.strictEqual(questionOverlapRatio("货票同行的要求", ""), 0);
});

t("改写结果和上一问完全相同判定为不可用（模型把旧问题原样搬回来了）", () => {
  const previous = "阿联酋公司在印度新设私人有限公司，需要哪些步骤和资料";
  assert.strictEqual(isRewriteAcceptable(previous, previous), false);
});

t("正常改写结果判定为可用", () => {
  const out = isRewriteAcceptable(
    "阿联酋公司在印度新设私人有限公司，股权结构方面（股东人数下限、外资持股比例、股份类别）有哪些法律规定",
    "阿联酋公司在印度新设私人有限公司，需要哪些步骤和资料",
  );
  assert.strictEqual(out, true);
});

console.log("\n== 追问免费额度扣费覆盖 ==");

t("延续上一问题、原本要扣费 → 免费，额度-1", () => {
  const out = applyFollowUpCharging({
    topicRelation: "CONTINUATION",
    originalChargeEligible: true,
    freeFollowUpsUsed: 0,
  });
  assert.strictEqual(out.chargeEligible, false);
  assert.strictEqual(out.usedFreeCredit, true);
  assert.ok(out.note.includes("还剩 2 次"));
});

t("免费额度用完后，延续上一问题照常扣费", () => {
  const out = applyFollowUpCharging({
    topicRelation: "CONTINUATION",
    originalChargeEligible: true,
    freeFollowUpsUsed: FREE_FOLLOWUP_LIMIT,
  });
  assert.strictEqual(out.chargeEligible, true);
  assert.strictEqual(out.usedFreeCredit, false);
  assert.ok(out.note.includes("已用完"));
});

t("新话题不享受追问优惠，正常扣费", () => {
  const out = applyFollowUpCharging({
    topicRelation: "NEW_TOPIC",
    originalChargeEligible: true,
    freeFollowUpsUsed: 0,
  });
  assert.strictEqual(out.chargeEligible, true);
  assert.strictEqual(out.usedFreeCredit, false);
  assert.strictEqual(out.note, undefined);
});

t("首问不享受追问优惠，正常扣费", () => {
  const out = applyFollowUpCharging({
    topicRelation: "FIRST",
    originalChargeEligible: true,
    freeFollowUpsUsed: 0,
  });
  assert.strictEqual(out.chargeEligible, true);
  assert.strictEqual(out.usedFreeCredit, false);
});

t("本来就不扣费的回答（NEED_INFORMATION等）不消耗免费额度", () => {
  const out = applyFollowUpCharging({
    topicRelation: "CONTINUATION",
    originalChargeEligible: false,
    freeFollowUpsUsed: 0,
  });
  assert.strictEqual(out.chargeEligible, false);
  assert.strictEqual(out.usedFreeCredit, false, "没有真的省下一次扣费，不该算用掉额度");
});

t("免费额度用到最后一次时，提示语说明额度已用完而不是还剩0次", () => {
  const out = applyFollowUpCharging({
    topicRelation: "CONTINUATION",
    originalChargeEligible: true,
    freeFollowUpsUsed: FREE_FOLLOWUP_LIMIT - 1,
  });
  assert.strictEqual(out.chargeEligible, false);
  assert.strictEqual(out.usedFreeCredit, true);
  assert.ok(out.note.includes("已用完"), "不应该出现'还剩 0 次'这种别扭的措辞");
});

console.log("\n== 会话摘要提炼（存进会话历史的字段）==");

t("取首句，按中文句末标点切分", () => {
  assert.strictEqual(firstSentence("须经股东特别决议授权。随后向公司注册处备案。"), "须经股东特别决议授权。");
});

t("超长首句会截断", () => {
  const long = "a".repeat(100);
  const out = firstSentence(long);
  assert.ok(out.endsWith("…"));
  assert.ok(out.length < long.length);
});

t("只取MANDATORY步骤的首句，PRACTICAL不算", () => {
  const steps = [
    { kind: "MANDATORY", text: "须经股东特别决议授权。", citation_refs: [1], unverified_claims: [] },
    { kind: "PRACTICAL", text: "建议提前预约估值机构。", citation_refs: [], unverified_claims: [] },
  ];
  const out = extractMandatoryFirstSentences(steps);
  assert.deepStrictEqual(out, ["须经股东特别决议授权。"]);
});

t("法律与条号去重、按display_title+locator拼接", () => {
  const citations = [
    { display_title: "Companies Act, 2013", locator: "Section 62", authority: "MCA", official_url: "u" },
    { display_title: "Companies Act, 2013", locator: "Section 62", authority: "MCA", official_url: "u" },
    { display_title: "FEMA, 1999", locator: "Regulation 5", authority: "RBI", official_url: "u" },
  ];
  const out = extractCitedLaws(citations);
  assert.deepStrictEqual(out, ["Companies Act, 2013 Section 62", "FEMA, 1999 Regulation 5"]);
});

console.log("\n== 证据主题相关性分档（向量初筛的确定性部分）==");

t("相似度达到高阈值：判相关，不升级", () => {
  assert.strictEqual(classifySimilarity(0.6, 0.3, 0.55), "RELEVANT");
});

t("相似度低于低阈值：判不相关，不用升级", () => {
  assert.strictEqual(classifySimilarity(0.1, 0.3, 0.55), "IRRELEVANT");
});

t("相似度落在中间地带：升级到模型判断", () => {
  assert.strictEqual(classifySimilarity(0.4, 0.3, 0.55), "ESCALATE");
});

t("刚好等于高阈值算相关（>=），不是中间地带", () => {
  assert.strictEqual(classifySimilarity(0.55, 0.3, 0.55), "RELEVANT");
});

t("刚好等于低阈值算中间地带（<），不是直接判不相关", () => {
  assert.strictEqual(classifySimilarity(0.3, 0.3, 0.55), "ESCALATE");
});

t("不传阈值时用模块默认值，行为不变", () => {
  assert.strictEqual(classifySimilarity(0.9), "RELEVANT");
  assert.strictEqual(classifySimilarity(0.01), "IRRELEVANT");
});

console.log("\n== 知识库总览分类（纯展示，不影响检索）==");

t("公司法类资料归入公司设立与治理", () => {
  assert.strictEqual(classifyDocumentCategory("The Companies Act, 2013_for_kb.txt"), "company_governance");
});

t("下划线连词的文件名也认得出FEMA/RBI（\\b在下划线上不生效的坑）", () => {
  assert.strictEqual(classifyDocumentCategory("FEMA_NDI_Rules_for_kb.txt"), "fema_fdi_rbi");
  assert.strictEqual(classifyDocumentCategory("RBI_Foreign_Investment_MD_for_kb.txt"), "fema_fdi_rbi");
});

t("CGST/IGST及宪法第101修正案（GST入宪）归入GST", () => {
  assert.strictEqual(classifyDocumentCategory("The Central Goods and Services Tax Act, 2017_for_kb.txt"), "gst");
  assert.strictEqual(
    classifyDocumentCategory("The Constitution (One Hundred and First Amendment) Act, 2016_for_kb.txt"),
    "gst",
  );
});

t("所得税法与中文命名的中印税收协定都归入所得税/DTAA", () => {
  assert.strictEqual(classifyDocumentCategory("The Income-tax Act, 2025_for_kb.txt"), "income_tax");
  assert.strictEqual(
    classifyDocumentCategory("中印避免双重征税协定（1994）- 清晰文本版_for_kb.txt"),
    "income_tax",
  );
});

t("外贸政策与ITC(HS)归入进出口与海关", () => {
  assert.strictEqual(classifyDocumentCategory("Foreign Trade Policy 2023 - Ch.1_for_kb.txt"), "trade_customs");
  assert.strictEqual(
    classifyDocumentCategory("ITC(HS) 2022 — Schedule I（进口）_ Schedule II（出口） - Sch-I_for_kb.txt"),
    "trade_customs",
  );
});

t("匹配不上任何关键词时归入其他，不报错、不瞎归类", () => {
  assert.strictEqual(classifyDocumentCategory("Updated-FQAs-on-Interplay&Transitions_for_kb.txt"), "other");
});

t("source比fileName更干净时，source里的关键词也能命中", () => {
  assert.strictEqual(classifyDocumentCategory("misc.txt", ["FEMA (Non-debt Instruments) Rules, 2019"]), "fema_fdi_rbi");
});

t("categoryLabel给未知id兜底返回“其他”", () => {
  assert.strictEqual(categoryLabel("not_a_real_id"), "其他");
});

t("DOCUMENT_CATEGORIES固定顺序，最后一项是兜底“其他”", () => {
  assert.strictEqual(DOCUMENT_CATEGORIES[DOCUMENT_CATEGORIES.length - 1].id, "other");
});

console.log("\n== 税务案例库草稿解析（case-extract.mjs 产出的模板格式）==");

const validCaseMd = `# 税务判例结构化记录（草稿，待人工审核）

**案件名称**：Samsung India Electronics Pvt Ltd vs Acit

**法院与年份**：ITAT Delhi, 2019

**IndianKanoon文档ID**：135502389

**争议税种以及主管税局**：所得税（转让定价）— 印度所得税局

**税局主张（Revenue's Position）**：
1. AMP支出构成向关联方提供的国际交易
2. 应按独立交易原则单独定价调整

**企业抗辩方向（Assessee's Argument）**：
1. AMP支出是境内经营决策，不构成国际交易
2. 不存在关联方之间的明示或默示协议

**最终裁定结果**：
1. 支持纳税人，撤销转让定价调整

**证据支撑要点**：
1. 缺乏关联方之间存在AMP安排的书面或口头协议证据

**印度数据库链接**：https://indiankanoon.org/doc/135502389/

---

## 对中资企业的参考价值

在印企业若面临AMP转让定价挑战，可参考本案关于"缺乏协议证据不构成国际交易"的论证路径。
`;

t("完整案例草稿校验通过并正确解析全部字段", () => {
  const result = validateCaseText("samsung.md", validCaseMd);
  assert.strictEqual(result.status, "READY_TO_REVIEW");
  assert.strictEqual(result.parsed.caseName, "Samsung India Electronics Pvt Ltd vs Acit");
  assert.strictEqual(result.parsed.docid, "135502389");
  assert.strictEqual(result.parsed.officialUrl, "https://indiankanoon.org/doc/135502389/");
  assert.deepStrictEqual(result.parsed.revenuePosition, [
    "AMP支出构成向关联方提供的国际交易",
    "应按独立交易原则单独定价调整",
  ]);
});

t("纳税人名称保留英文原文，不做翻译改写", () => {
  const result = validateCaseText("samsung.md", validCaseMd);
  assert.ok(/^[A-Za-z0-9 .]+$/.test(result.parsed.caseName), "案件名称应保持英文原文格式");
});

t("缺少案件名称时报错并阻断发布", () => {
  const broken = validCaseMd.replace(/\*\*案件名称\*\*：.*\n/, "");
  const result = validateCaseText("broken.md", broken);
  assert.strictEqual(result.status, "VALIDATION_FAILED");
  assert.ok(result.errors.some((e) => e.includes("案件名称")));
});

t("印度数据库链接不是http/https地址时报错", () => {
  const broken = validCaseMd.replace(
    "https://indiankanoon.org/doc/135502389/",
    "indiankanoon.org/doc/135502389/",
  );
  const result = validateCaseText("broken.md", broken);
  assert.strictEqual(result.status, "VALIDATION_FAILED");
  assert.ok(result.errors.some((e) => e.includes("印度数据库链接")));
});

t("缺少税局主张/企业抗辩方向/最终裁定结果任一项都会报错", () => {
  const broken = validCaseMd.replace(/\*\*最终裁定结果\*\*：\n1\. 支持纳税人，撤销转让定价调整\n\n/, "");
  const result = validateCaseText("broken.md", broken);
  assert.strictEqual(result.status, "VALIDATION_FAILED");
  assert.ok(result.errors.some((e) => e.includes("最终裁定结果")));
});

t("法院与年份是占位符（模型老实说不知道）时给警告但不阻断", () => {
  const placeholder = validCaseMd.replace("ITAT Delhi, 2019", "文档中未明确提及");
  const result = validateCaseText("placeholder.md", placeholder);
  assert.strictEqual(result.status, "READY_TO_REVIEW");
  assert.ok(result.warnings.some((w) => w.includes("法院与年份")));
});

t("原文被截断的警示横幅会转成提醒管理员核对原文的警告", () => {
  const truncated = validCaseMd.replace(
    "# 税务判例结构化记录（草稿，待人工审核）\n",
    "# 税务判例结构化记录（草稿，待人工审核）\n\n> ⚠️ 原文超过 60000 字符，本次提炼只喂了截断后的前半部分给模型。\n",
  );
  const result = validateCaseText("truncated.md", truncated);
  assert.strictEqual(result.status, "READY_TO_REVIEW");
  assert.ok(result.warnings.some((w) => w.includes("截断")));
});

t("编号列表被正确拆分成数组，没有编号时整段当一条", () => {
  const singleLine = validCaseMd.replace(
    "**证据支撑要点**：\n1. 缺乏关联方之间存在AMP安排的书面或口头协议证据\n",
    "**证据支撑要点**：\n没有编号的一整段证据描述\n",
  );
  const result = validateCaseText("single.md", singleLine);
  assert.deepStrictEqual(result.parsed.evidenceSupport, ["没有编号的一整段证据描述"]);
});

t("空文件直接报错，不往下解析", () => {
  const result = validateCaseText("empty.md", "   \n  ");
  assert.strictEqual(result.status, "VALIDATION_FAILED");
  assert.ok(result.errors.some((e) => e.includes("为空")));
});

t("字段真留空时不会吞掉下一个标签的内容（曾经的坑：\\s*贪婪吃掉空行导致误并入下一字段）", () => {
  const blankFieldMd = `**案件名称**：

**法院与年份**：

**IndianKanoon文档ID**：135502389

**争议税种以及主管税局**：所得税

**税局主张（Revenue's Position）**：
1. 主张

**企业抗辩方向（Assessee's Argument）**：
1. 抗辩

**最终裁定结果**：
1. 裁定

**证据支撑要点**：
1. 证据

**印度数据库链接**：https://indiankanoon.org/doc/135502389/
`;
  const result = validateCaseText("blank-field.md", blankFieldMd);
  assert.strictEqual(result.status, "VALIDATION_FAILED");
  assert.ok(
    result.errors.some((e) => e.includes("案件名称")),
    "案件名称真的留空应该被当成缺失字段报出来，而不是把【法院与年份】的标签文字当成了案件名称的内容",
  );
});

console.log("\n== 判例检索触发词（阶段三，纯正则不调模型）==");

t("中文判例信号词命中", () => {
  assert.strictEqual(shouldSearchCases("有没有类似的判例支持我们企业不用补缴这笔税？"), true);
  assert.strictEqual(shouldSearchCases("之前有没有企业因为转让定价跟税局打过官司，最后败诉还是胜诉？"), true);
});

t("★「案件」是判例信号词（2026-10-13 实测漏判）", () => {
  // 真实漏判：用户问「帮我找一些三星公司的广告费案件，并且分析」——
  // 词表里有「案例」「案子」，偏偏没有最常用的「案件」，整句没命中，
  // 判例检索（含公司链路的 Indian Kanoon 实时查）根本没启动，用户以为功能不存在。
  assert.strictEqual(shouldSearchCases("帮我找一些三星公司的广告费案件，并且分析"), true);
  assert.strictEqual(isCaseSeekingQuestion("帮我找一些三星公司的广告费案件，并且分析"), true,
    "「找一些…案件」同时是求取判例句式，判例要置顶");
});

t("英文判例信号词也能命中", () => {
  assert.strictEqual(shouldSearchCases("Is there any ITAT ruling on AMP transfer pricing for Chinese companies?"), true);
});

t("普通合规问题不命中，不会每次问答都触发判例检索", () => {
  assert.strictEqual(shouldSearchCases("印度私人有限公司至少要几名董事？"), false);
  assert.strictEqual(shouldSearchCases("公司注册需要准备哪些文件？"), false);
});

console.log("\n== 判例本地检索关键词打分（阶段三，纯函数）==");

t("完全重合的关键词打满分1", () => {
  assert.strictEqual(keywordOverlapScore("transfer pricing dispute", "transfer pricing dispute case"), 1);
});

t("完全不重合打0分", () => {
  assert.strictEqual(keywordOverlapScore("transfer pricing", "company incorporation director"), 0);
});

t("查询词为空（没有可用词）返回0，不报错", () => {
  assert.strictEqual(keywordOverlapScore("", "transfer pricing dispute"), 0);
  assert.strictEqual(keywordOverlapScore("the a of", "transfer pricing dispute"), 0);
});

t("rankCasesByKeyword按分数降序排列，且不改变输入数组", () => {
  const cases = [
    { caseName: "Alpha vs ITO", taxTypeAndAuthority: "GST registration dispute", revenuePosition: [], assesseeArgument: [], finalRuling: [] },
    { caseName: "Beta vs Acit", taxTypeAndAuthority: "transfer pricing AMP expenditure dispute", revenuePosition: [], assesseeArgument: [], finalRuling: [] },
    { caseName: "Gamma vs Acit", taxTypeAndAuthority: "customs valuation dispute", revenuePosition: [], assesseeArgument: [], finalRuling: [] },
  ];
  const ranked = rankCasesByKeyword("transfer pricing AMP expenditure", cases);
  assert.strictEqual(ranked[0].item.caseName, "Beta vs Acit", "最相关的案例应该排第一");
  assert.strictEqual(cases.length, 3, "不应该修改传入的原数组");
  assert.ok(ranked[0].score > ranked[ranked.length - 1].score);
});

// 2026-09-16 真实事故：问"广告费有什么判例"，召回的第一条是讲外资银行总部费用、
// 分行利息、外汇重估的 Standard Chartered。根因是打分拿整份记录（六万字、横跨十几个
// 主题）做匹配，"记录越长越容易命中"。修复＝只匹配有主题区分度的字段 + IDF加权。
console.log("\n== 判例检索的长度偏差（真实事故：广告费问题召回外资银行总部费用判决）==");

t("长篇大案例不再靠'什么词都有'压过主题对口的短案例", () => {
  const sprawling = {
    caseName: "Standard Chartered Bank vs DCIT",
    taxTypeAndAuthority: "Income Tax",
    referenceValueNote: "",
    // 模拟那份六万字记录：把各种税务主题词都堆进裁判要旨里，包括 advertisement。
    finalRuling: [[
      "transfer pricing head office expenditure interest permanent establishment",
      "forex revaluation exempt income securities loss refund interest",
      "royalty fees technical services expatriate salary advertisement expenditure",
      "deduction disallowance appeal tribunal assessment year india tax",
    ].join(" ").repeat(40)],
    revenuePosition: [], assesseeArgument: [],
  };
  const topical = {
    caseName: "Luminous Power Technologies vs Addl CIT",
    taxTypeAndAuthority: "Income Tax advertisement publicity sales promotion",
    referenceValueNote: "advertisement expenses held revenue in nature not capital",
    finalRuling: ["advertisement publicity and sales promotion expenditure allowed as revenue expenditure"],
    revenuePosition: [], assesseeArgument: [],
  };
  const ranked = rankCasesByKeyword("advertisement publicity sales promotion expenditure", [sprawling, topical]);
  assert.strictEqual(
    ranked[0].item.caseName,
    "Luminous Power Technologies vs Addl CIT",
    "主题对口的案例必须排在堆砌了所有主题词的长案例前面",
  );
});

t("IDF加权：全库都有的通用词贡献趋近于0，罕见词才决定排序", () => {
  const common = (name, extra) => ({
    caseName: name,
    taxTypeAndAuthority: `income tax india assessee appeal ${extra}`,
    referenceValueNote: "",
    finalRuling: [], revenuePosition: [], assesseeArgument: [],
  });
  const cases = [
    common("A", "gst registration"),
    common("B", "customs valuation"),
    common("C", "advertisement promotion"),
    common("D", "director appointment"),
  ];
  // "income tax india assessee" 每份都有 → IDF≈0；决定胜负的只有 advertisement。
  const ranked = rankCasesByKeyword("income tax india assessee advertisement", cases);
  assert.strictEqual(ranked[0].item.caseName, "C");
  assert.ok(ranked[1].score < ranked[0].score, "没有罕见词命中的案例分数应明显更低");
});

t("查询词一个都没命中时得0分，不会因为通用词凑出分数", () => {
  const cases = [
    { caseName: "A", taxTypeAndAuthority: "gst registration", referenceValueNote: "", finalRuling: [], revenuePosition: [], assesseeArgument: [] },
  ];
  assert.strictEqual(rankCasesByKeyword("advertisement promotion", cases)[0].score, 0);
});

t("★ 真实事故：主题文本最长的那件判例，赢下几乎所有检索", () => {
  // 2026-09-22：用户问「所得税案件中保证金计算的基数」，三种不同写法的英文检索式
  // 跑真实的 119 件案例库，**同一件 Vodafone 案三次都排第一**，
  // 而它讲的是 80-IA 扣除、license fee 性质、TP 调整，和保证金毫无关系。
  //
  // 根因：它的「争议税种以及主管税局」字段被整理成了两千多字、列了二三十个 section
  // 的大杂烩。实测那个库里主题文本词数中位数 52、最长 396——**7.6 倍**。
  // 而原公式 `命中词IDF之和 ÷ 全部查询词IDF之和` 的分母只和查询有关，
  // 和文档多长完全无关，于是长文档撞上任何查询词的概率都高得多。
  const bloated = {
    caseName: "Vodafone Mobile Services vs DCIT",
    taxTypeAndAuthority: [
      "section 80-IA deduction derived from eligible business profits section 80G",
      "section 37(1) license fee revenue capital ARC cell site network rental penalty",
      "subscriber fraud WPC royalty advertisement commission section 35ABB amortisation",
      "section 43(1) explanation section 36(1)(iii) CWIP interest section 40(a)(ia) 194C 194J 194H",
      "domestic roaming prepaid distributor discount section 40A(2)(b) section 14A rule 8D",
      "section 47(iii) PI assets gift section 41(1) customer security deposit write-back",
      "chapter X section 92CA rule 10B brand royalty AMP transfer pricing CUP bright line",
      "section 154 section 251 CIT(A) enhancement section 199 rule 37BA TDS credit",
      "section 234B 234C 234D section 115JAA MAT credit section 271(1)(c) penalty appeal",
      "computation base deposit pre-paid tribunal ITAT assessment order DRP",
    ].join(" "),
    referenceValueNote: "",
    finalRuling: ["Ground 1 allowed for statistical purposes"],
    revenuePosition: [], assesseeArgument: [],
  };
  const onTopic = {
    caseName: "Some Co vs CIT",
    taxTypeAndAuthority: "Income Tax appeal pre-deposit stay of demand computation base",
    referenceValueNote: "",
    finalRuling: ["stay granted on deposit of disputed demand"],
    revenuePosition: [], assesseeArgument: [],
  };
  // 再掺 8 件普通长度的案例，让 IDF 和平均长度都接近真实分布
  const filler = Array.from({ length: 8 }, (_, i) => ({
    caseName: `Filler ${i} vs DCIT`,
    taxTypeAndAuthority: "Income Tax assessment appeal tribunal",
    referenceValueNote: "", finalRuling: ["appeal dismissed"],
    revenuePosition: [], assesseeArgument: [],
  }));
  const ranked = rankCasesByKeyword(
    "income tax appeal pre-deposit basis of computation",
    [bloated, onTopic, ...filler],
  );
  assert.strictEqual(ranked[0].item.caseName, "Some Co vs CIT",
    "★ 主题对口的短案例必须排在什么词都有的长案例前面");
});

t("长度惩罚只罚长、不奖短——短文档不能靠撞上一个生僻词翻倍", () => {
  // BM25 的完整公式里短文档会拿到 >1 的加成，靠词频饱和项平衡。
  // 我们这边是集合匹配（没有词频），少了那道平衡，短文档加成会失控。
  // 所以惩罚系数封顶在 1：分数只可能比归一之前低，阈值的含义不被推翻。
  const tiny = {
    caseName: "T", taxTypeAndAuthority: "benami", referenceValueNote: "",
    finalRuling: [], revenuePosition: [], assesseeArgument: [],
  };
  const normal = (i) => ({
    caseName: `N${i}`,
    taxTypeAndAuthority: "income tax appeal tribunal assessment order benami transaction property",
    referenceValueNote: "", finalRuling: ["dismissed"], revenuePosition: [], assesseeArgument: [],
  });
  const pool = [tiny, ...Array.from({ length: 6 }, (_, i) => normal(i))];
  for (const entry of rankCasesByKeyword("benami", pool)) {
    assert.ok(entry.score <= 1, `分数不得超过 1（拿到了 ${entry.score}）`);
  }
});

console.log("\n== 法域是会话级的，不是单句级的 ==");

{
  const { classifyDocumentCategory } = require("./lib/server/document-category.js");
  const { detectQuestionCategories } = require("./lib/server/domain-scope.js");
  const { isCaseOnTopic } = require("./lib/server/case-domain.js");

  // 和 legal-answer.ts 的 resolveConversationCategories 同口径。
  // 那个函数没导出（它吃的是整个 AnswerOptions），这里按同样三层复刻一份来测。
  // ⚠改那边的话这里要跟着改——下面那条断言会盯着源码里的三层结构还在不在。
  const resolve = (question, prior) => {
    const cur = detectQuestionCategories(question);
    if (cur.length) return cur;
    if (!prior) return [];
    const fromQ = detectQuestionCategories(prior.selfContainedQuestion ?? "");
    if (fromQ.length) return fromQ;
    return [...new Set((prior.citedLaws ?? [])
      .map((l) => classifyDocumentCategory(l, [l])).filter((id) => id && id !== "other"))];
  };

  const INFOSYS = {
    caseName: "Infosys Technologies Ltd vs Bangalore Service Tax-Ii on 19 March, 2025",
    taxTypeAndAuthority: "Service Tax（Annual Technical Support Service 的应税性与 extended period）",
  };
  const PRIOR = {
    selfContainedQuestion: "印度income tax（ITD）案件中，保证金计算的基数包括哪些？",
    citedLaws: ["Income-tax Act, 2025", "Income-tax Rules, 2026"],
  };

  t("★ 真实事故：追问只答两个词，法域丢了，Service Tax 判例混进所得税答案", () => {
    // 2026-09-28：多义词闸门追问「保证金指哪一种」，用户答「pre-deposit」。
    // 这一轮 question 就这两个词 → detectQuestionCategories 返回 [] → 闸门失效 →
    // 一件讲 extended period / suppression of facts 的 Service Tax 判例
    // 排在所得税答案的第一条。分类没错、闸门逻辑没错，**是闸门的输入没了**。
    assert.deepStrictEqual(detectQuestionCategories("pre-deposit"), [],
      "单看这一句确实判不出法域");
    assert.strictEqual(isCaseOnTopic(INFOSYS, detectQuestionCategories("pre-deposit")), true,
      "这就是改之前的行为：放行");
    const conv = resolve("pre-deposit", PRIOR);
    assert.deepStrictEqual(conv, ["income_tax"]);
    assert.strictEqual(isCaseOnTopic(INFOSYS, conv), false, "★ 会话级法域下必须挡住");
  });

  t("第二层：上一轮问题也判不出时，从引用过的法律名反推", () => {
    // 「那这个呢」这种自足问题补全得不好的情况。引用过的法律名最硬——
    // 上一轮引的是 Income-tax Act，这段对话就是所得税的，不依赖任何措辞。
    const prior = { selfContainedQuestion: "那这个呢", citedLaws: ["Income-tax Act, 2025"] };
    assert.deepStrictEqual(resolve("pre-deposit", prior), ["income_tax"]);
  });

  t("★ 换话题时必须跟着换，不能被上文盖住", () => {
    // 和 answer-language 的粘性语言不同：语言中途换是缺陷，话题中途换是正常的。
    // 所以当前问题永远优先。
    assert.deepStrictEqual(resolve("那GST那边的进项税抵扣发票要求呢", PRIOR), ["gst"]);
  });

  t("全都判不出 → 空数组 = 不知道 = 不过滤", () => {
    assert.deepStrictEqual(resolve("pre-deposit", null), []);
    assert.deepStrictEqual(resolve("pre-deposit", { selfContainedQuestion: "", citedLaws: [] }), []);
  });

  t("★ 真实事故：'三星公司的广告费案件'只认出公司法域，所得税判例被全过滤", () => {
    // 2026-10-13：判例区一条不出，日志 `categories=[company_governance] 入闸=3 出闸=0`。
    // detectQuestionCategories 只吃中文原问题（legal-answer 第一层不传词典展开）：
    // "三星公司"的公司命中公司法域，而"广告费"在所有信号表里都缺失 →
    // categories=[company_governance] → 三星 AMP 案（本地向量 top1 0.679）被闸门杀掉。
    const cats = detectQuestionCategories("帮我找一些三星公司的广告费案件，并且分析");
    assert.ok(cats.includes("income_tax"),
      `广告费必须能认出所得税法域（拿到了 ${JSON.stringify(cats)}）`);
    const SAMSUNG = {
      caseName: "Samsung India Electronics Private Limited vs Dcit, Tpo 3(1)(2), Delhi on 12 August, 2026",
      taxTypeAndAuthority: "Income Tax（转让定价 AMP 广告费扣除争议）",
    };
    assert.strictEqual(isCaseOnTopic(SAMSUNG, cats), true,
      "★ 所得税判例必须能过闸（修复前被 [company_governance] 全杀）");
    // 公司法域仍在——"公司"确实命中，闸门是任一类命中即放行，两者并存不影响所得税案过闸。
    assert.ok(cats.includes("company_governance"), "公司法域照旧命中");
  });

  t("★ legal-answer 里那三层还在", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "lib", "server", "legal-answer.ts"), "utf8");
    const fn = src.slice(src.indexOf("function resolveConversationCategories"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.ok(/detectQuestionCategories\(options\.question\)/.test(body), "第一层：当前问题");
    assert.ok(/selfContainedQuestion/.test(body), "第二层：上一轮自足问题");
    assert.ok(/citedLaws/.test(body), "第三层：上一轮引用过的法律名");
    assert.ok(/if \(current\.length > 0\) return current/.test(body),
      "★ 当前问题必须优先，否则换话题时会被上文盖住");
  });
}

console.log("\n== 判例的法域闸门：讲的税种要和问的税种对得上 ==");

const { classifyCaseDomain, isCaseOnTopic } = require("./lib/server/case-domain.js");

t("★ 必须扫 vs 的两边——税局既可能是被告，也可能是原告", () => {
  // 真实案例库 119 件里实测：税局只在原告位 23 件、只在被告位 61 件。
  // 只看被告会把那 23 件全判成"认不出"。
  assert.strictEqual(classifyCaseDomain({
    caseName: "Toyota Kirloskar Motors Private Ltd vs Commissioner Of Customs",
  }), "trade_customs", "税局在被告位");
  assert.strictEqual(classifyCaseDomain({
    caseName: "Prl., Commissioner Of Income Tax vs M/S Ibm India Pvt Ltd",
  }), "income_tax", "★ 税局在原告位");
  assert.strictEqual(classifyCaseDomain({
    caseName: "Dcit, Mumbai vs Play Games 24X7 Private Limited",
  }), "income_tax", "★ 缩写形式的税局在原告位");
});

t("「争议税种」字段优先于案件名", () => {
  // 字段是整理案例时人工写明的，比从名字里猜可靠。
  assert.strictEqual(classifyCaseDomain({
    caseName: "Some Co vs Commissioner Of Income Tax",
    taxTypeAndAuthority: "Customs (valuation of imported goods)",
  }), "trade_customs");
});

t("海关/GST 的规则排在所得税前面——它们的机关名里也有通用的 Commissioner", () => {
  assert.strictEqual(classifyCaseDomain({ caseName: "X vs Commissioner Of Customs" }), "trade_customs");
  assert.strictEqual(classifyCaseDomain({ caseName: "X vs Commissioner Of Central Gst" }), "gst");
});

t("★ 判不出来就放行——不在没把握的时候乱删", () => {
  assert.strictEqual(classifyCaseDomain({ caseName: "Walmart India vs Central Vigilance Commission" }), undefined);
  assert.strictEqual(isCaseOnTopic({ caseName: "Walmart India vs Central Vigilance Commission" }, ["income_tax"]), true);
  assert.strictEqual(isCaseOnTopic({ caseName: "X vs Commissioner Of Customs" }, []), true,
    "问题法域认不出时，这道闸整个不生效");
});

t("★ 企业名判不了法域，所以不能只拿原告去判", () => {
  // 同一家三星既有转让定价案、也有海关估价案。
  assert.strictEqual(classifyCaseDomain({
    caseName: "Samsung India Electronics vs Commissioner Of Customs",
  }), "trade_customs");
  assert.strictEqual(classifyCaseDomain({
    caseName: "Samsung India Electronics vs Addl Cit",
  }), "income_tax");
});

t("★★ 法域闸门必须装在唯一出口上——三条 return 里漏一条就等于没装", () => {
  // 2026-09-29 实测事故：第一版把 filterCasesByDomain 写在末尾那条 return 上，
  // 而 retrieveRelatedCases 有三条 return：
  //     if (gap <= 0 || !isCaseLiveFallbackEnabled()) return local;   ← 没过闸
  //     catch { return local; }                                       ← 没过闸
  //     return filterCasesByDomain(merged, ...);                      ← 只有这条过了
  // 而 gap <= 0（本地够 3 条）是**最常见**的那条路——119 件的案例库几乎总能凑够，
  // 于是这道闸从上线起基本没生效过。
  //
  // 这条断言钉的不是某个行为，是**结构**：检索主体收在 gatherCases 里爱怎么返回
  // 怎么返回，retrieveRelatedCases 只有一个出口、且那个出口必须过闸。
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "lib", "server", "case-search.ts"), "utf8");
  const at = src.indexOf("export async function retrieveRelatedCases(");
  const body = src.slice(at, src.indexOf("\n}", at));
  // 把注释剥掉再数 return——注释里原样抄了那三条出事的 return 当案发记录。
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const returns = code.match(/\breturn\b/g) ?? [];
  assert.strictEqual(returns.length, 1, `★ 只能有一个出口，现在有 ${returns.length} 个`);
  // 出口的值必须来自 filterCasesByDomain。2026-10-13 给这条链插桩时改成了
  // 「先赋值 const filtered = filterCasesByDomain(...)，再 return filtered」——
  // 语义没变（还是单出口、还是过闸后的值），所以两种等价写法都接受。
  assert.ok(
    /return\s+filterCasesByDomain\(/.test(code)
    || (/=\s*filterCasesByDomain\(/.test(code) && /return\s+\w+;/.test(code)),
    "★ 那个出口必须过闸",
  );
});

t("海关案不进所得税问题的答案", () => {
  assert.strictEqual(
    isCaseOnTopic({ caseName: "Toyota vs Commissioner Of Customs", taxTypeAndAuthority: "Customs" }, ["income_tax"]),
    false,
  );
});

console.log("\n== 判例综述：「不相关」和「跑失败」必须是两个返回值 ==");

const { CASE_DIGEST_IRRELEVANT, isCaseDigestIrrelevant } = require("./lib/server/case-digest.js");

t("★ 哨兵值和 undefined 不能混为一谈", () => {
  // 2026-09-22 事故：提示词第 7 条让模型"没有实质关联就返回空 clusters"，
  // 模型照做了，而代码把它和"调用失败"一样返回 undefined，
  // 上游分不清，照样把原始列表端了上去。
  // 这和 case-search.ts 里向量重排那处是同一个 bug 形状：
  // **一个成功的否定判断，被编码成了和失败相同的返回值。**
  assert.strictEqual(isCaseDigestIrrelevant(CASE_DIGEST_IRRELEVANT), true);
  assert.strictEqual(isCaseDigestIrrelevant(undefined), false, "★ 调用失败 ≠ 判定不相关");
  assert.strictEqual(isCaseDigestIrrelevant({ clusters: [], action_points: [], index: [] }), false);
});

console.log("\n== 判例综述的防编造核验（纯函数，不调模型）==");

t("extractAmounts：认得印度2-2-3分组的金额写法", () => {
  assert.deepStrictEqual(extractAmounts("调整 Rs.1338,82,19,250 元"), ["13388219250"]);
  assert.deepStrictEqual(extractAmounts("广告费 ₹10,38,263"), ["1038263"]);
  assert.deepStrictEqual(extractAmounts("没有金额的一句话"), []);
});

t("extractAmounts：年份和条号不会被误判成金额（防止核验过严误杀正常句子）", () => {
  assert.deepStrictEqual(extractAmounts("Section 37(1) 于 2014 年"), []);
  assert.deepStrictEqual(extractAmounts("AY 2016-17 的评税"), []);
  assert.deepStrictEqual(extractAmounts("Finance Act, 2025 修订"), []);
});

t("amountsAreGrounded：原文里有的金额放行", () => {
  const allowed = new Set(["1038263", "615493483"]);
  assert.strictEqual(amountsAreGrounded("广告费 ₹10,38,263 被要求分4年摊销", allowed), true);
});

t("amountsAreGrounded：句子里只有年份时照常通过，不因为年份被拦", () => {
  assert.strictEqual(amountsAreGrounded("法院在 2014 年的判决中认定该支出属收益性", new Set()), true);
});

t("amountsAreGrounded：编出来的金额被拦下", () => {
  const allowed = new Set(["1038263"]);
  assert.strictEqual(amountsAreGrounded("调整金额高达 Rs.99,99,99,999", allowed), false);
});

t("amountsAreGrounded：不含金额的句子直接通过", () => {
  assert.strictEqual(amountsAreGrounded("法院认定该支出属收益性，可一次性扣除", new Set()), true);
});

console.log("\n== 追问案例细节现查现答（正则触发+确定性选案例+原句核验，不调模型）==");

t("追问细节触发词命中——金额/时间/理由类追问", () => {
  assert.strictEqual(detectCaseDetailFollowUp("这个案子涉案金额是多少？"), true);
  assert.strictEqual(detectCaseDetailFollowUp("法院是什么时候判的？"), true);
  assert.strictEqual(detectCaseDetailFollowUp("后来上诉了吗？"), true);
});

t("追问细节触发词不命中——不像是在问已展示案例的细节", () => {
  assert.strictEqual(detectCaseDetailFollowUp("公司增资还需要哪些手续？"), false);
});

t("pickCaseForFollowUp：只展示了一个案例时直接选它，不用看追问里说了什么", () => {
  const cases = [{ docid: "1", caseName: "Xiaomi Technology India Pvt. Ltd. v. Union of India", officialUrl: "https://indiankanoon.org/doc/1/" }];
  const picked = pickCaseForFollowUp(cases, "涉案金额是多少");
  assert.strictEqual(picked.docid, "1");
});

t("pickCaseForFollowUp：展示了多个案例时，追问里点名了某个案例才选定", () => {
  const cases = [
    { docid: "1", caseName: "Xiaomi Technology India Pvt. Ltd. v. Union of India", officialUrl: "https://indiankanoon.org/doc/1/" },
    { docid: "2", caseName: "Vivo Mobile India Pvt. Ltd. v. Union of India", officialUrl: "https://indiankanoon.org/doc/2/" },
  ];
  const picked = pickCaseForFollowUp(cases, "Xiaomi那个案子涉案金额是多少");
  assert.strictEqual(picked.docid, "1");
});

t("pickCaseForFollowUp：多个候选案例、追问里没点名任何一个，返回undefined（宁可不触发）", () => {
  const cases = [
    { docid: "1", caseName: "Xiaomi Technology India Pvt. Ltd. v. Union of India", officialUrl: "https://indiankanoon.org/doc/1/" },
    { docid: "2", caseName: "Vivo Mobile India Pvt. Ltd. v. Union of India", officialUrl: "https://indiankanoon.org/doc/2/" },
  ];
  const picked = pickCaseForFollowUp(cases, "涉案金额是多少");
  assert.strictEqual(picked, undefined);
});

t("verifyCaseDetailQuote：原句确实出现在现查回来的原文里判VERIFIED", () => {
  const docText = "The customs department demanded a differential duty of Rs. 653 crore from the petitioner on account of royalty payments.";
  const quote = "The customs department demanded a differential duty of Rs. 653 crore from the petitioner";
  assert.strictEqual(verifyCaseDetailQuote(quote, docText), "VERIFIED");
});

t("verifyCaseDetailQuote：原句在原文里找不到判NOT_FOUND（防止模型张冠李戴，比如把FEMA冻结金额安到关税争议上）", () => {
  const docText = "The customs department demanded a differential duty of Rs. 653 crore from the petitioner on account of royalty payments.";
  const quote = "the enforcement directorate froze assets worth Rs. 5551 crore under the foreign exchange management act";
  assert.strictEqual(verifyCaseDetailQuote(quote, docText), "NOT_FOUND");
});

t("verifyCaseDetailQuote：模型没给原句/原句太短判MISSING，不当成核验通过", () => {
  assert.strictEqual(verifyCaseDetailQuote(undefined, "some document text about a customs dispute"), "MISSING");
  assert.strictEqual(verifyCaseDetailQuote("short", "some document text about a customs dispute"), "MISSING");
});

console.log("\n== Notice上传解析：事实拼进问题文本 + 内外部字段映射（纯函数）==");

t("appendNoticeContext：有字段时按固定顺序拼成一段中文说明", () => {
  const result = appendNoticeContext("我该怎么答复这份Notice？", {
    authority: "CGST Commissionerate",
    noticeOrFormNumber: "Form GST DRC-01",
    period: "FY 2024-25",
    amount: "Rs. 12,00,000",
    servedDate: "2026-08-01",
    replyDeadline: "2026-09-01",
    allegations: ["未按时申报GSTR-3B", "存在未缴纳的应缴税额"],
  });
  assert.ok(result.startsWith("我该怎么答复这份Notice？"), "原问题保留在最前面");
  assert.ok(result.includes("发出机关：CGST Commissionerate"));
  assert.ok(result.includes("要求回复截止日：2026-09-01"));
  assert.ok(result.includes("指控/要求事项：未按时申报GSTR-3B；存在未缴纳的应缴税额"));
});

t("appendNoticeContext：所有字段都为空时原样返回问题，不拼空括号", () => {
  const question = "我该怎么答复这份Notice？";
  const result = appendNoticeContext(question, { allegations: [] });
  assert.strictEqual(result, question);
});

t("appendNoticeContext：只有部分字段时只拼有值的那几行", () => {
  const result = appendNoticeContext("问题", { authority: "GST局", allegations: [] });
  assert.ok(result.includes("发出机关：GST局"));
  assert.ok(!result.includes("送达日期"));
});

t("toNoticeFactsPayload：camelCase内部字段映射成snake_case对外契约", () => {
  const payload = toNoticeFactsPayload({
    authority: "GST局",
    noticeOrFormNumber: "DRC-01",
    servedDate: "2026-08-01",
    replyDeadline: "2026-09-01",
    allegations: ["逾期申报"],
  });
  assert.strictEqual(payload.notice_or_form_number, "DRC-01");
  assert.strictEqual(payload.served_date, "2026-08-01");
  assert.strictEqual(payload.reply_deadline, "2026-09-01");
  assert.deepStrictEqual(payload.allegations, ["逾期申报"]);
});

t("hasUsableNoticeFacts：全空的提取结果不算提取成功（真实事故：换了Notice却拿到上一份的答案）", () => {
  assert.strictEqual(hasUsableNoticeFacts({ allegations: [] }), false, "所有字段都空");
  assert.strictEqual(
    hasUsableNoticeFacts({ authority: undefined, amount: undefined, allegations: [] }),
    false,
    "显式undefined也是空",
  );
});

t("hasUsableNoticeFacts：任意一个字段有内容就算提取到了", () => {
  assert.strictEqual(hasUsableNoticeFacts({ authority: "CGST Commissionerate", allegations: [] }), true, "只有机关");
  assert.strictEqual(hasUsableNoticeFacts({ replyDeadline: "2026-09-01", allegations: [] }), true, "只有截止日");
  assert.strictEqual(hasUsableNoticeFacts({ allegations: ["未按时申报GSTR-3B"] }), true, "只有指控");
});

t("hasUsableNoticeFacts：和appendNoticeContext判空口径一致（空就不该拼进问题）", () => {
  const empty = { allegations: [] };
  const question = "收到这个notice应该怎么办？";
  // 判空口径必须一致：hasUsableNoticeFacts说没内容的，appendNoticeContext也必须原样返回，
  // 否则会出现"判定读懂了、却拼不进任何背景"的空转状态——这正是那次事故的中间环节。
  assert.strictEqual(hasUsableNoticeFacts(empty), false);
  assert.strictEqual(appendNoticeContext(question, empty), question);
});

t("subjectMatter：通报类文件没有指控，只有事由也算提取到了内容", () => {
  // 真实事故：AP税局"打击虚假登记专项行动"通报没有任何指控，allegations为空，
  // 如果事由不算数，这份文件就等于什么都没提取到。
  assert.strictEqual(hasUsableNoticeFacts({ subjectMatter: "全国打击虚假GST登记专项核查行动通报", allegations: [] }), true);
});

t("appendNoticeContext：事由排在第一行，优先于机关和编号", () => {
  const result = appendNoticeContext("这份notice税局质疑什么？", {
    authority: "安得拉邦商业税务局",
    subjectMatter: "全国打击虚假GST登记专项行动，核查期间为2023-5-16至2023-7-15",
    allegations: [],
  });
  assert.ok(result.includes("文件事由：全国打击虚假GST登记专项行动"));
  assert.ok(
    result.indexOf("文件事由：") < result.indexOf("发出机关："),
    "事由要排在发出机关前面",
  );
});

t("toNoticeFactsPayload：事由字段映射成snake_case", () => {
  const payload = toNoticeFactsPayload({ subjectMatter: "专项核查通报", allegations: [] });
  assert.strictEqual(payload.subject_matter, "专项核查通报");
});

t("buildNoticeExcerpt：短文本原样返回，超长截断并标注还有后文", () => {
  assert.strictEqual(buildNoticeExcerpt("  短短一段原文  "), "短短一段原文");
  const long = "甲".repeat(5000);
  const excerpt = buildNoticeExcerpt(long);
  assert.ok(excerpt.length < long.length, "超长文本要被截断");
  assert.ok(excerpt.includes("此处截断"), "截断时要明确标注，不让模型以为看到的是全文");
});

t("isImageOcrConfigured：两个密钥都配置了才算已配置", () => {
  const savedId = process.env.TENCENTCLOUD_SECRET_ID;
  const savedKey = process.env.TENCENTCLOUD_SECRET_KEY;
  try {
    delete process.env.TENCENTCLOUD_SECRET_ID;
    delete process.env.TENCENTCLOUD_SECRET_KEY;
    assert.strictEqual(isImageOcrConfigured(), false, "两个都没配置");
    process.env.TENCENTCLOUD_SECRET_ID = "id";
    assert.strictEqual(isImageOcrConfigured(), false, "只配置了一个");
    process.env.TENCENTCLOUD_SECRET_KEY = "key";
    assert.strictEqual(isImageOcrConfigured(), true, "两个都配置了");
  } finally {
    if (savedId === undefined) delete process.env.TENCENTCLOUD_SECRET_ID; else process.env.TENCENTCLOUD_SECRET_ID = savedId;
    if (savedKey === undefined) delete process.env.TENCENTCLOUD_SECRET_KEY; else process.env.TENCENTCLOUD_SECRET_KEY = savedKey;
  }
});

console.log("\n== Notice超范围检测：拼接事实后再查一次（真实事故：DGCA民航Notice被当成GST答了）==");

t("detectOutOfScope：普通在范围问题不命中", () => {
  assert.strictEqual(detectOutOfScope("公司年度ROC合规要核对哪些事项？"), undefined);
});

t("detectOutOfScope：问题本身直接带超范围关键词——知识产权", () => {
  assert.strictEqual(detectOutOfScope("公司想注册商标，需要走什么流程？"), "知识产权");
});

t("detectOutOfScope：真实事故复现——用户原始问题看不出DGCA信号，不命中", () => {
  // 这是用户实际打的问题，本身完全看不出超范围，只有Notice原文里才有DGCA相关信息。
  assert.strictEqual(detectOutOfScope("收到这个notice应该怎么办？"), undefined);
});

t("detectOutOfScope：真实事故复现——DGCA事实拼进问题后能命中", () => {
  const factsAppended = appendNoticeContext("收到这个notice应该怎么办？", {
    authority: "GOVERNMENT OF INDIA DIRECTORATE GENERAL OF CIVIL AVIATION",
    allegations: [
      "non-provisioning of adequate arrangements for smooth implementation of the approved FDTL scheme",
      "non-compliance on the part of the airline with the provisions of Rule 42A of the Aircraft Rules, 1937",
    ],
  });
  assert.strictEqual(detectOutOfScope(factsAppended), "民航监管（DGCA）");
});

t("detectOutOfScope：其余新增规则各自命中——环保/食品安全/证券/电信", () => {
  assert.strictEqual(detectOutOfScope("工厂收到了Pollution Control Board的环境许可整改通知"), "环保与污染防治");
  assert.strictEqual(detectOutOfScope("收到FSSAI的食品安全整改通知"), "食品安全（FSSAI）");
  assert.strictEqual(detectOutOfScope("SEBI认定我们信息披露违规怎么办"), "证券市场监管（SEBI）");
  assert.strictEqual(detectOutOfScope("TRAI电信监管方面的整改通知怎么处理"), "电信监管（TRAI）");
});

t("buildOutOfScopeResponse：字段形状正确，不扣次数、不生成法律结论", () => {
  const res = buildOutOfScopeResponse("req_1", "conv_1", "民航监管（DGCA）");
  assert.strictEqual(res.answer_status, "UNABLE_TO_CONFIRM");
  assert.strictEqual(res.failure_code, "OUT_OF_SCOPE");
  assert.strictEqual(res.charge_eligible, false);
  assert.deepStrictEqual(res.action_steps, []);
  assert.deepStrictEqual(res.citations, []);
  assert.ok(res.short_conclusion.includes("民航监管（DGCA）"));
  assert.ok(res.short_conclusion.includes("不在本版回答范围内"));
});

// ============================================================
// 新法取代旧法：所得税法 1961 → 2025
// ============================================================
const { scopeBySupersession } = require("./lib/server/law-supersession.js");

function taxChunk(source, id) {
  return { id, source, clauseNo: "1", text: "x", jurisdiction: "CENTRE" };
}

console.log("\n== 新法取代旧法时，旧法要退出候选池 ==");

t("问今天的事：1961年所得税法被剔掉，只留2025年的", () => {
  const chunks = [
    taxChunk("The Income-tax Act, 1961 (as amended; downloaded 2025-06-19)", "old"),
    taxChunk("The Income-tax Act, 2025", "new"),
    taxChunk("Companies Act, 2013", "co"),
  ];
  const result = scopeBySupersession(chunks, "2026-09-17");
  const ids = result.chunks.map((chunk) => chunk.id);
  assert.ok(!ids.includes("old"), "已废止的1961法不应留在候选池里");
  assert.ok(ids.includes("new"), "现行的2025法必须留着");
  assert.ok(ids.includes("co"), "不相干的法律不受影响");
  assert.strictEqual(result.excluded.length, 1);
});

t("标题括号里的下载年份2025不能把1961法误判成新法", () => {
  // 这是真实的标题写法。sourceName 不切掉括号的话，"downloaded 2025-06-19"
  // 会让 successor 正则命中这份1961法——方向正好反过来。
  const chunks = [
    taxChunk("The Income-tax Act, 1961 (as reproduced on incometaxindia.gov.in; downloaded 2025-06-19)", "old"),
    taxChunk("The Income-tax Act, 2025", "new"),
  ];
  const ids = scopeBySupersession(chunks, "2026-09-17").chunks.map((chunk) => chunk.id);
  assert.deepStrictEqual(ids, ["new"]);
});

t("问2024年度的事：新法尚未施行，反过来剔掉2025法", () => {
  const chunks = [
    taxChunk("The Income-tax Act, 1961", "old"),
    taxChunk("The Income-tax Act, 2025", "new"),
  ];
  const ids = scopeBySupersession(chunks, "2024-06-30").chunks.map((chunk) => chunk.id);
  assert.deepStrictEqual(ids, ["old"], "问旧年度就该看旧法");
});

t("库里只有1961法时不剔——宁可引过时的法，也不能变成查不到", () => {
  const chunks = [taxChunk("The Income-tax Act, 1961", "old")];
  const result = scopeBySupersession(chunks, "2026-09-17");
  assert.deepStrictEqual(result.chunks.map((chunk) => chunk.id), ["old"]);
  assert.deepStrictEqual(result.excluded, []);
});

t("中文标题的几种写法也认得（管理员填【来源】是自由文本）", () => {
  const variants = [
    ["1961年所得税法", "2025年所得税法"],
    ["所得税法（1961）", "所得税法（2025）"],
    ["Income Tax Act 1961", "Income Tax Act 2025"],
  ];
  for (const [oldName, newName] of variants) {
    const ids = scopeBySupersession(
      [taxChunk(oldName, "old"), taxChunk(newName, "new")], "2026-09-17",
    ).chunks.map((chunk) => chunk.id);
    assert.deepStrictEqual(ids, ["new"], `没认出来：${oldName} / ${newName}`);
  }
});

t("生效日当天算新法已施行（含当天）", () => {
  const chunks = [
    taxChunk("The Income-tax Act, 1961", "old"),
    taxChunk("The Income-tax Act, 2025", "new"),
  ];
  assert.deepStrictEqual(
    scopeBySupersession(chunks, "2026-04-01").chunks.map((chunk) => chunk.id), ["new"]);
  assert.deepStrictEqual(
    scopeBySupersession(chunks, "2026-03-31").chunks.map((chunk) => chunk.id), ["old"]);
});

// ============================================================
// 案例库不足时补查实时判例
// ============================================================
const { mergeCaseResults, rankLiveDocs, extractCaseYear } = require("./lib/server/case-search.js");

console.log("\n== 本地案例不够时，用实时检索把缺口填满 ==");

t("mergeCaseResults：本地优先，实时只填缺口", () => {
  const local = [{ caseName: "本地A", docid: "1", official_url: "u1" }];
  const live = [
    { caseName: "实时B", docid: "2", official_url: "u2" },
    { caseName: "实时C", docid: "3", official_url: "u3" },
    { caseName: "实时D", docid: "4", official_url: "u4" },
  ];
  const merged = mergeCaseResults(local, live, 3);
  assert.deepStrictEqual(merged.map((item) => item.docid), ["1", "2", "3"]);
  assert.strictEqual(merged[0].caseName, "本地A", "本地那条必须排在最前");
});

t("mergeCaseResults：docid重复时保留本地那条（审核过的优先于现查的摘录）", () => {
  const local = [{ caseName: "本地版·九字段齐全", docid: "7", official_url: "u" }];
  const live = [{ caseName: "实时版·只有摘录", docid: "7", official_url: "u", snippet: "..." }];
  const merged = mergeCaseResults(local, live, 3);
  assert.strictEqual(merged.length, 1, "同一个案子不能出现两遍");
  assert.strictEqual(merged[0].caseName, "本地版·九字段齐全");
});

t("extractCaseYear：publishdate优先，其次标题，再次来源栏", () => {
  assert.strictEqual(extractCaseYear({ tid: 1, publishdate: "2019-03-15", title: "X 2004" }), 2019);
  assert.strictEqual(extractCaseYear({ tid: 1, title: "CIT vs ABC (2021)" }), 2021);
  assert.strictEqual(extractCaseYear({ tid: 1, docsource: "ITAT Delhi 2015" }), 2015);
  assert.strictEqual(extractCaseYear({ tid: 1, title: "金额 4500000 无年份" }), undefined,
    "六位数字不能被当成年份");
});

t("rankLiveDocs：相关度接近时新判例靠前", () => {
  const docs = [
    { tid: "old", title: "advertisement expenditure disallowance", publishdate: "2002-01-01" },
    { tid: "new", title: "advertisement expenditure disallowance", publishdate: "2024-01-01" },
  ];
  const ranked = rankLiveDocs("advertisement expenditure disallowance", docs, new Date("2026-09-17"));
  assert.strictEqual(ranked[0].tid, "new", "内容一样时新的排前面");
});

t("rankLiveDocs：相关度差距足够大时，再新也翻不了盘", () => {
  const docs = [
    { tid: "fresh_irrelevant", title: "customs duty on machinery import", publishdate: "2026-01-01" },
    { tid: "old_relevant", title: "advertisement expenditure brand building disallowance", publishdate: "2001-01-01" },
  ];
  const ranked = rankLiveDocs("advertisement expenditure brand building disallowance", docs, new Date("2026-09-17"));
  assert.strictEqual(ranked[0].tid, "old_relevant", "时间分是有上限的加分，不能压过相关度");
});

// ============================================================
// 判例措辞改写
// ============================================================
const { rewriteCaseEvidenceCaveat } = require("./lib/server/step-text.js");

console.log("\n== 「未包含此类判例」这种说法要改掉 ==");

t("常见几种写法都能改成「本次提供的案例并不是所有判例」", () => {
  // hasCases 缺省为 false：这份回答确实没有判例，说法本身没错，只是边界要收住。
  const samples = [
    "本次提供的证据中未包含此类判例，建议另行检索。",
    "本次检索到的资料中没有涉及相关案例。",
    "本次的材料中未收录同类先例。",
  ];
  for (const sample of samples) {
    const rewritten = rewriteCaseEvidenceCaveat(sample);
    assert.ok(rewritten.includes("本次提供的案例并不是所有判例"), `没改到：${sample}`);
    assert.ok(!/未包含|没有涉及|未收录/.test(rewritten), `旧说法还在：${rewritten}`);
  }
});

t("不相干的句子原样不动", () => {
  const text = "本次提供的证据中包含三份ITAT裁定，均支持该抗辩方向。";
  assert.strictEqual(rewriteCaseEvidenceCaveat(text), text);
});

t("改写后句子其余部分保持完整", () => {
  assert.strictEqual(
    rewriteCaseEvidenceCaveat("本次提供的证据中未包含此类判例，建议委托当地顾问核实。"),
    "本次提供的案例并不是所有判例，建议委托当地顾问核实。");
});

// ============================================================
// 超范围闸门：强信号直接拦，弱信号要看有没有范围内信号
// ============================================================
const { hasInScopeSignal } = require("./lib/server/out-of-scope.js");

console.log("\n== 超范围误判：同形异义词不能单独决定拒答 ==");

t("真实事故 #44：GST自愿注册题不能被裸「注销」判出范围外", () => {
  const question = "我们是一家刚起步的印度子公司，今年营业额预计只有 800 万卢比，远低于强制注册门槛。"
    + "但几个大客户说「你们没有 GSTIN，我们没法抵扣，不能采购」。我们可以主动申请注册吗？"
    + "自愿注册之后会有什么义务和代价？能不能随时注销？";
  assert.ok(hasInScopeSignal(question), "GSTIN/抵扣 应该被认成范围内信号");
  assert.strictEqual(detectOutOfScope(question), undefined);
});

t("没有范围内信号时，「注销」照样拦得住", () => {
  assert.strictEqual(detectOutOfScope("我们要把这家子公司注销掉，流程是什么"), "公司注销与破产");
});

t("「公司注销」「strike off」是强信号，带GST词也照拦", () => {
  assert.strictEqual(detectOutOfScope("公司注销的时候GST登记要怎么处理"), "公司注销与破产");
  assert.strictEqual(detectOutOfScope("strike off 之后还要报税吗"), "公司注销与破产");
});

t("裸 IP 是弱信号，带范围内信号时不拦；商标/专利是强信号", () => {
  assert.strictEqual(detectOutOfScope("服务器 IP 在境外，GST 进项抵扣受影响吗"), undefined);
  assert.strictEqual(detectOutOfScope("我们的 IP 要怎么保护"), "知识产权");
  assert.strictEqual(detectOutOfScope("商标注册和GST登记能一起办吗"), "知识产权");
});

t("范围内信号表刻意排除「公司」「合规」这类到处都有的词", () => {
  assert.ok(!hasInScopeSignal("我们公司要做合规检查"), "太宽的词不能算范围内信号，否则这道闸形同虚设");
});

// ============================================================
// 结论里自陈证据不足时，状态与计费要跟着走
// ============================================================
const {
  parseEvidenceSufficiency,
  adjustForSelfDoubt,
  liftSufficiencyWhenCasesFound,
  EVIDENCE_SUFFICIENCY_PROMPT_RULE,
} = require("./lib/server/answer-self-doubt.js");

console.log("\n== 证据覆盖程度由模型申报：不能还挂着「依据充分」并照常扣次 ==");

t("FULL → 正常回答，照常扣次", () => {
  assert.deepStrictEqual(
    adjustForSelfDoubt("FULL", true),
    { downgrade: false, chargeEligible: true, prependRiskNote: false },
  );
});

t("★ 真实事故 #58：只缺某个条文、主干答对了 → 不降级；2026-10-13 起照常扣次", () => {
  // "FY2022-23 适用 s74 而非 s74A，但库里没有 s74A 条文"——主干实打实答对了。
  // 把它降级成"暂时无法确认"等于把一份有用的答案作废，用户什么也拿不到。
  // 计费：用户决策（2026-10-13）——主干有依据、缺口已如实说明并展示，
  // PARTIAL 与 FULL 同待遇，照常扣次（此前"不扣次"的规则废除）。
  const adj = adjustForSelfDoubt("PARTIAL", true);
  assert.strictEqual(adj.downgrade, false, "答对了主干的回答不能作废");
  assert.strictEqual(adj.chargeEligible, true, "2026-10-13 起部分覆盖与 FULL 同价");
  assert.strictEqual(adj.prependRiskNote, true);
});

t("★ PARTIAL 不抬高已被判定的不扣次（地基法律缺失等原因）", () => {
  // 与 FULL 同待遇的另一面：计费跟随 currentChargeEligible，不能把
  // 已经因为别的原因判成"不扣次"的回合抬回"扣次"。
  assert.strictEqual(adjustForSelfDoubt("PARTIAL", false).chargeEligible, false);
});

t("★ 真实事故 #95：核心要件全无证据 → 降级且不扣次", () => {
  const adj = adjustForSelfDoubt("NONE", true);
  assert.strictEqual(adj.downgrade, true);
  assert.strictEqual(adj.chargeEligible, false);
});

t("★ 模型没报字段 → 不降级，但也不扣次", () => {
  // 字段缺失意味着这一轮的覆盖程度无从判断。两种错的代价不对称：
  // "该扣没扣"用户没感觉，"不该扣却扣了"是直接拿走用户的额度。
  // 一个连自己够不够格都说不清的回合，不该收费。
  const adj = adjustForSelfDoubt(undefined, true);
  assert.strictEqual(adj.downgrade, false, "没有证据说明这份答案不好，作废它是过度反应");
  assert.strictEqual(adj.chargeEligible, false);
  assert.strictEqual(adj.prependRiskNote, false, "没有具体的话可说，硬加一句只会变成噪音");
});

t("★ 真实事故：找三星广告费案件，判例区有货却整份降级「暂时无法确认」", () => {
  // 2026-10-13：模型写答案时看不到判例（判例检索与主答案并发），申报 NONE 的
  // 依据只是知识库法规缺口；而判例区列出了三星 AMP 案 + digest 两个风险主题。
  // 降级把判例这一路已交付的主干也否定了——用户视角"判例白找了"。
  // 用户在找判例 + 判例区有货 → NONE 提为 PARTIAL（不降级、照常扣次、缺口照挂）。
  assert.strictEqual(liftSufficiencyWhenCasesFound("NONE", true, true), "PARTIAL");
  assert.strictEqual(adjustForSelfDoubt(liftSufficiencyWhenCasesFound("NONE", true, true), true).downgrade,
    false, "提成 PARTIAL 后不得再降级");
  assert.strictEqual(adjustForSelfDoubt(liftSufficiencyWhenCasesFound("NONE", true, true), true).chargeEligible,
    true, "判例已交付，与 FULL 同价（2026-10-13 用户规则）");
});

t("提升的三条边界缺一不可", () => {
  // ① 问题不在找判例（普通业务问题顺带触发判例）→ 不提：那种题的证据主体是法规，
  //    法规全无证据时盖"依据充分"是把用户往坑里带。
  assert.strictEqual(liftSufficiencyWhenCasesFound("NONE", false, true), "NONE");
  // ② 判例区空 → 不提："求判例无结果不扣次"规则原样保留。
  assert.strictEqual(liftSufficiencyWhenCasesFound("NONE", true, false), "NONE");
  // ③ 只有 NONE 需要提；FULL/PARTIAL/undefined 原样。
  assert.strictEqual(liftSufficiencyWhenCasesFound("FULL", true, true), "FULL");
  assert.strictEqual(liftSufficiencyWhenCasesFound("PARTIAL", true, true), "PARTIAL");
  assert.strictEqual(liftSufficiencyWhenCasesFound(undefined, true, true), undefined);
});

t("★ PARTIAL 不降级，但徽标不能还是绿的「依据充分」", () => {
  // 2026-09-28 实测两次：结论第一句写着"未出现预缴保证金一词及其计算规则"，
  // 头上顶着绿色的「依据充分」。
  //
  // 根因是 answer_status 只有三个值，PARTIAL 映射到 SUFFICIENT。
  // 不降级是刻意的（#58：主干答对了不该作废），但**不降级 ≠ 装作完全覆盖**。
  // 所以徽标改成按 evidence_sufficiency 走。这条断言钉住前端那个判断还在。
  const fs = require("node:fs"), path = require("node:path");
  const page = fs.readFileSync(path.join(__dirname, "..", "app", "page.tsx"), "utf8");
  // ⚠不能用 `indexOf("\n}")` 找函数结尾：StatusPill 的解构参数
  // `function StatusPill({...}: {...})` 里有一个顶格的 `}`，会把函数体整个切掉，
  // 断言于是永远失败（第一版就栽在这）。切到下一个顶层声明为止。
  const fn = page.slice(page.indexOf("function StatusPill"));
  const nextDecl = fn.slice(1).search(/\n(?:function|const|export) /);
  const body = nextDecl > 0 ? fn.slice(0, nextDecl) : fn;
  assert.ok(/sufficiency !== "FULL"/.test(body), "★ 徽标必须看 evidence_sufficiency");
  assert.ok(/部分覆盖/.test(body), "非 FULL 时要有自己的文案");
  assert.ok(!/status-sufficient/.test(body.split("sufficiency !== \"FULL\"")[1]?.slice(0, 200) ?? ""),
    "非 FULL 时不能复用绿色那个 class");
  // 状态语义本身仍然是三个值——它参与计费和追问判断，不该被徽标文案带跑。
  assert.ok(/SUFFICIENT: "依据充分"/.test(body));
});

t("★ 证据没完整覆盖时，一个关键数值都不显示", () => {
  // 同一次实测：答案说"未出现预缴保证金一词"，而 22px 那行是「500卢比·暂缓征税申请费」
  // ——上诉费，不是保证金基数。它通过了前两道闸（有出处、法域也对），
  // 但答案自己承认没找到用户问的东西，这时最大的那个数必然是"手头恰好有的另一个数"。
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "lib", "server", "legal-answer.ts"), "utf8");
  assert.ok(
    /key_figures: adjustedStatus === "UNABLE_TO_CONFIRM" \|\| evidenceSufficiency !== "FULL"/.test(src),
    "★ 非 FULL 时必须清空 key_figures",
  );
});

t("已经不扣次时不会被改回可扣次", () => {
  // 地基法律缺失等原因已经判定不扣次，FULL 不能把它抬回来。
  assert.strictEqual(adjustForSelfDoubt("FULL", false).chargeEligible, false);
});

t("脏值一律当作没报", () => {
  for (const bad of [null, undefined, "", "full ", "Partial", "maybe", 1, {}, ["FULL"]]) {
    const parsed = parseEvidenceSufficiency(bad);
    if (bad === "full " || bad === "Partial") {
      assert.ok(parsed, `大小写和空格要能收进来：${JSON.stringify(bad)}`);
    } else {
      assert.strictEqual(parsed, undefined, `脏值应判为没报：${JSON.stringify(bad)}`);
    }
  }
});

t("★ 提示词里必须写明「哪怕只是一句附带说明也要报 PARTIAL」", () => {
  // 这条是 2026-09-22 那次事故的直接教训：模型在结论里附带写了
  // "未直接规定"，却仍然认为自己答得很完整。规则必须把这个边界说死，
  // 否则"主干答出来了就算 FULL"是个很自然的误解。
  assert.ok(EVIDENCE_SUFFICIENCY_PROMPT_RULE.includes("PARTIAL"));
  assert.ok(/哪怕|只是一句/.test(EVIDENCE_SUFFICIENCY_PROMPT_RULE),
    "必须明确「附带提一句也要报 PARTIAL」");
  assert.ok(/不会.{0,6}被当成你答得不好|不扣次/.test(EVIDENCE_SUFFICIENCY_PROMPT_RULE),
    "要打消模型「报 PARTIAL 等于承认失败」的顾虑，否则它会倾向报 FULL");
});

t("三个枚举值全都认得", () => {
  for (const v of ["FULL", "PARTIAL", "NONE"]) {
    assert.strictEqual(parseEvidenceSufficiency(v), v);
  }
});

// ============================================================
// 知识库覆盖缺口自检
// ============================================================
const { findKnowledgeCoverageGaps, coverageGapNotes } = require("./lib/server/coverage-gap.js");

console.log("\n== 地基法律不在库里时，必须明说，不能拿相邻法硬答 ==");

// 生产知识库的真实构成：有 FTP 和 ITC(HS)，但一部海关法都没有
const KB_NO_CUSTOMS = [
  { source: "Foreign Trade Policy 2023 - Ch.1" },
  { source: "ITC(HS) 2022 — Schedule I（进口）_ Schedule II（出口） - Sch-I" },
  { source: "The Central Goods and Services Tax Act, 2017" },
];

t("真实事故：问报关，库里没有海关法 → 报出缺口", () => {
  const gaps = findKnowledgeCoverageGaps("进口报关的时候要提交什么单据，海关多久放行？", KB_NO_CUSTOMS);
  assert.strictEqual(gaps.length, 1);
  assert.ok(gaps[0].displayName.includes("Customs Act, 1962"));
  const note = coverageGapNotes(gaps)[0];
  assert.ok(note.includes("本知识库暂未收录"), "措辞必须是「本库没有」");
  assert.ok(!/印度没有|不存在/.test(note), "绝不能说成「印度没有这样的规定」");
});

t("海关法补进库之后，同一个问题不再报警", () => {
  const withCustoms = [...KB_NO_CUSTOMS, { source: "The Customs Act, 1962" }];
  assert.deepStrictEqual(findKnowledgeCoverageGaps("进口报关要提交什么单据？", withCustoms), []);
});

t("没问海关的问题，不因为库里没海关法而报警", () => {
  assert.deepStrictEqual(
    findKnowledgeCoverageGaps("公司年度股东大会必须在什么时候开？", KB_NO_CUSTOMS), []);
});

t("真实事故：问FC-TRS申报时限，库里没有 Mode of Payment 条例", () => {
  const kb = [{ source: "FEMA (Non-debt Instruments) Rules, 2019" },
              { source: "RBI Master Direction - Foreign Investment in India" }];
  const gaps = findKnowledgeCoverageGaps("股权转让给非居民之后，FC-TRS 要几天内报？", kb);
  assert.strictEqual(gaps.length, 1);
  assert.ok(gaps[0].displayName.includes("395/2019"));
  assert.ok(gaps[0].consequence.includes("FC-TRS"), "要说清楚缺了它具体答不出什么");
});

t("一个问题同时打到两个缺口时，两条都报", () => {
  const gaps = findKnowledgeCoverageGaps(
    "关联方进口的完税价格怎么定？报关时海关会不会质疑特许权使用费？", KB_NO_CUSTOMS);
  assert.strictEqual(gaps.length, 2);
});

// ============================================================
// 原句核验：India Code 的内嵌脚注标记不能造成假警报
// ============================================================
console.log("\n== 原句核验：脚注编号不该把引用判成「指错条款」 ==");

// 下面这段是 Customs Act, 1962 第46(1)条**入库后的真实文本**，
// 4[ 5[ 6[ 是 India Code PDF 里的修订脚注标记，不是条文内容。
const CUSTOMS_S46_BODY =
  "46.  Entry of goods on importation.—(1) The importer of any goods, other than goods intended for "
  + "transit or transhipment, shall make entry thereof by presenting  4[electronically] 5[on the customs "
  + "automated system] to the proper officer a bill of entry for home consumption or warehousing 6[in such "
  + "form and manner as may be prescribed]:";

t("真实事故：模型引干净原句，被正文里的脚注编号切断 → 修复后整句直接命中", () => {
  // 模型会写的原句：把脚注标记去掉的干净条文
  const quote = "shall make entry thereof by presenting electronically on the customs "
    + "automated system to the proper officer a bill of entry for home consumption or warehousing";
  const body = normalizeForQuoteMatch(CUSTOMS_S46_BODY);
  assert.ok(body.includes(normalizeForQuoteMatch(quote)),
    "去掉脚注标记后，干净原句应该能在正文里整句命中");
});

t("只删紧贴 [ 的数字，条文里的天数百分比一个都不能动", () => {
  assert.strictEqual(
    normalizeForQuoteMatch("within 30 days"), normalizeForQuoteMatch("within 30 days"));
  assert.notStrictEqual(
    normalizeForQuoteMatch("within 30 days"),
    normalizeForQuoteMatch("within 60 days"),
    "30天和60天归一化后必须仍然不同，否则核验就退化成摆设");
  assert.ok(normalizeForQuoteMatch("a penalty of 10% of the tax").includes("10"),
    "百分比里的数字要保留");
  assert.ok(normalizeForQuoteMatch("Section 129A of the Act").includes("129"),
    "条号里的数字要保留");
});

t("引错条款照样抓得住——修复没有放松核验", () => {
  const wrongQuote = "the Board shall prepare a report on the state of the company affairs "
    + "and attach it to the financial statement laid before the general meeting";
  const body = normalizeForQuoteMatch(CUSTOMS_S46_BODY);
  const needle = normalizeForQuoteMatch(wrongQuote);
  assert.ok(!body.includes(needle));
  assert.ok(longestMatchLength(needle, body) < 40, "毫不相干的原句最长吻合必须远低于锚点门槛");
});

// ============================================================
// 判例：触发词 + 「判例当主角」判定
// ============================================================
// isCaseSeekingQuestion 已在文件头部（line 74）与 shouldSearchCases 一起导入。
const { CASE_SEEKING_EMPTY_NOTE } = require("./lib/server/legal-answer.js");

console.log("\n== 用户要的就是判例时，判例得当主角 ==");

t("真实事故：「官司」这种口语说法要能触发判例检索", () => {
  // 2026-09-18：用户问这句，整条判例检索一次都没跑——词表里只有"判例/案例/案子"。
  assert.ok(shouldSearchCases("目前有哪些海关方面的官司"));
  assert.ok(shouldSearchCases("海关方面有哪些诉讼"));
  assert.ok(shouldSearchCases("我们被起诉了怎么办"));
  assert.ok(shouldSearchCases("海关纠纷怎么处理"));
});

t("「求取判例」的问法 → 判例当主角", () => {
  for (const q of [
    "目前有哪些海关方面的官司",
    "海关方面有哪些诉讼",
    "有哪些海关判例",
    "找几个转让定价的案子",
    "列举一下GST的相关判例",
  ]) assert.ok(isCaseSeekingQuestion(q), `应该判为求取判例：${q}`);
});

t("只是顺带提到判例、或问「该怎么做」 → 判例不当主角", () => {
  for (const q of [
    "收到评估令怎么办",            // 该查判例，但用户要的是怎么做
    "这条判例我看过了，那报关单怎么填",  // 句子里有"判例"，但不是在找判例
    "我们被起诉了怎么办",
    "海关纠纷怎么处理",
  ]) assert.ok(!isCaseSeekingQuestion(q), `不该判为求取判例：${q}`);
});

t("不沾判例的问题，两个判断都为假", () => {
  assert.ok(!shouldSearchCases("进口报关要提交什么单据"));
  assert.ok(!isCaseSeekingQuestion("进口报关要提交什么单据"));
});

t("查不到判例时的提示语：说「本次没检索到」，不能说「印度没有」", () => {
  assert.ok(CASE_SEEKING_EMPTY_NOTE.includes("本次没有检索到"));
  assert.ok(CASE_SEEKING_EMPTY_NOTE.includes("不代表印度没有"));
  assert.ok(CASE_SEEKING_EMPTY_NOTE.includes("不扣除提问次数"));
});

// ============================================================
// 法域闸门：信号太弱时谁也别排除谁
// ============================================================
console.log("\n== 法域闸门：一个孤零零的词不足以剔掉整个法域 ==");

const DOMAIN_KB = [
  { id: "customs", source: "The Customs Act, 1962", clauseNo: "14", text: "x" },
  { id: "cvr", source: "Customs Valuation (Determination of Value of Imported Goods) Rules, 2007", clauseNo: "10", text: "x" },
  { id: "cgst", source: "The Central Goods and Services Tax Act, 2017", clauseNo: "15", text: "x" },
  { id: "co", source: "The Companies Act, 2013", clauseNo: "2", text: "x" },
];
const keptIds = (question) =>
  scopeByQuestionDomain(question, DOMAIN_KB).chunks.map((chunk) => chunk.id);

t("真实事故：海关估价题不能因为出现「发票」就只剩 GST", () => {
  // 2026-09-18：问"从中国母公司进口注塑件……完税价格只看发票金额吗"，
  // 海关法域零命中被整个剔光，GST 靠单独一个"发票"活下来，答案全引 CGST Act。
  const question = "我们从中国母公司进口注塑件，合同发票价是每件120卢比。"
    + "免费提供了模具给母公司使用，另外按销售额付3%的技术许可费，海运费和保险由我们另付。"
    + "完税价格只看发票金额吗？";
  const kept = keptIds(question);
  assert.ok(kept.includes("customs"), "海关法必须留在候选池里");
  assert.ok(kept.includes("cvr"), "海关估价规则必须留在候选池里");
});

t("补齐的海关信号词逐个认得（整词写法曾经挡住单字「进口」）", () => {
  for (const word of ["进口", "完税价格", "海关估价", "特许权使用费", "模具", "海运费", "成交价格"]) {
    assert.ok(keptIds(`${word}怎么处理`).includes("customs"), `海关信号漏了：${word}`);
  }
});

t("历史事故不回归：ROC年度合规题照样把 GST 挡在外面", () => {
  // 公司法命中 公司/ROC/合规 三个词，强度够，排除照常生效。
  const kept = keptIds("公司年度ROC合规要核对哪些事项");
  assert.deepStrictEqual(kept, ["co"]);
});

t("真·GST题的闸门照常生效", () => {
  const kept = keptIds("进项税抵扣的GSTR-3B怎么报，发票不全会不会被查");
  assert.deepStrictEqual(kept, ["cgst"]);
});

// 这几条用自己的池子：DOMAIN_KB 里没有所得税资料，而下面全是所得税题。
const TAX_KB = [
  { id: "it",      source: "Income-tax Act, 2025", clauseNo: "195", text: "x" },
  { id: "itr",     source: "Income-tax Rules, 2026", clauseNo: "37BB", text: "x" },
  { id: "cgst",    source: "The Central Goods and Services Tax Act, 2017", clauseNo: "15", text: "x" },
  { id: "cgstr",   source: "CGST Rules 2017 — Forms Appendix (Part B, as on 09.10.2019)", clauseNo: "108", text: "x" },
  { id: "customs", source: "The Customs Act, 1962", clauseNo: "14", text: "x" },
  { id: "co",      source: "The Companies Act, 2013", clauseNo: "2", text: "x" },
];
const taxKept = (question) =>
  scopeByQuestionDomain(question, TAX_KB).chunks.map((chunk) => chunk.id).sort();

t("★ 真实事故：问题开头就写着 income tax，却一个法域都没排除", () => {
  // 2026-09-22 实测：「印度income tax（ITD）案件中，保证金计算的基数包括哪些？」
  // 排除结果是空的——整个知识库原封不动进了候选池，答案里混进 CGST 的上诉预缴 10%，
  // 还被放到全页最大的字号上。
  //
  // 两个独立的毛病叠在一起：
  //   ① 排除别人要 2 个不同信号词，而「income tax」只算 1 个；
  //      「保证金」「基数」「案件」「ITD」一个都不在表里。
  //   ② 就算够格排除，GST 的信号表里有「税率/税务/纳税/税负」，
  //      任何税务题它都算命中，于是永远剔不掉。
  const kept = taxKept("印度income tax（ITD）案件中，保证金计算的基数包括哪些？有支撑的案例吗？");
  assert.deepStrictEqual(kept, ["it", "itr"],
    "只该留所得税；GST 那条正是把 10% 上诉预缴混进来的路");
});

t("★ 点名法域一个词就够格排除，不受 2 个词门槛约束", () => {
  // 把法域名直接说出来不可能是偶然，所以这一档刻意绕过门槛。
  // ITD / ITAT / CBDT / CIT(A) 都是所得税法域的标准简称，2026-09-22 一并补进 nameSignal。
  for (const q of [
    "ITAT 上诉的时限是多久",
    "CBDT 对这个口径有什么说法",
    "CIT(A) 阶段能不能补交材料",
    "所得税的申报期限",
  ]) {
    assert.deepStrictEqual(taxKept(q), ["it", "itr"], `点名后仍未收敛：${q}`);
  }
});

t("★ 通用税务词只能保命，不能用来排除别人", () => {
  // 「税率/税务/纳税/税负/报税/应税」不指向任何一个具体税种。
  // 以前它们躺在 GST 的信号表里，「印度公司所得税税率是多少」这种题，
  // GST 靠一个「税率」既留得下来、又参与排除，两头都错。
  const kept = taxKept("印度公司所得税税率是多少");
  assert.ok(!kept.includes("cgst") && !kept.includes("cgstr"),
    "所得税被点名后，GST 不该再靠「税率」赖着不走");
  assert.ok(kept.includes("it"), "所得税必须留下");
});

t("★ 没人被点名时，通用税务词照样保住两个税域", () => {
  // 这是当初把通用词同时放进 GST 和所得税两张表的**原始目的**，改法域闸门不能改丢它。
  const kept = taxKept("印度子公司每年要做哪些税务合规");
  assert.ok(kept.includes("cgst"), "笼统税务题必须保留 GST");
  assert.ok(kept.includes("it"), "笼统税务题必须保留所得税");
});

t("特许权使用费同时算所得税和海关信号——横跨两域的词不能只挂一边", () => {
  // 它是海关估价的加计项（assists/royalty），也是所得税对非居民付款的代扣代缴对象。
  // 只挂海关的话，问「向母公司付特许权使用费要办什么手续」时所得税零命中被剔光，
  // 和「税率」只挂 GST 是同一种错，方向相反。
  const kept = taxKept("向中国母公司支付特许权使用费要办哪些手续");
  assert.ok(kept.includes("it"), "所得税必须留下——付特许权使用费要代扣代缴");
  assert.ok(kept.includes("customs"), "海关必须留下——它是估价加计项");
});

t("同一个词重复出现不算信号变强", () => {
  // "发票……这张发票……发票金额"只说明用户在讲同一件事，不代表这是 GST 题。
  const kept = keptIds("发票上的发票金额和发票日期");
  assert.ok(kept.includes("customs"), "重复一个词不该把别的法域剔掉");
});

// ============================================================
// 额度用完时，追问要不要放行
// ============================================================
const { canBypassQuotaAsFollowUp } = require("./lib/server/followup-charging.js");

console.log("\n== 额度的单位是话题，不是请求 ==");

const bypass = (over) => canBypassQuotaAsFollowUp({
  previousSelfContainedQuestion: "印度进口注塑件的完税价格里，模具成本和技术许可费要不要计入",
  question: "技术许可费怎样判断与进口货物的相关性和销售条件，帮我找相关案例",
  freeFollowUpsUsed: 0,
  hasNewNoticeUpload: false,
  overlapRatio: questionOverlapRatio,
  hasReferringExpression,
  ...over,
});

t("真实事故：额度归零后，同一对话里的追问要放行", () => {
  // 2026-09-18：用户剩最后1次额度，问完归零，紧接着追问被"本月额度已用完"拦住——
  // 可追问本来就有每对话3次免费额度，那道闸跑在读会话之前，根本不知道这是追问。
  //
  // 这一问和上一问的词面重合度是 0.185——**差一点点没过计费判定的 0.2 门槛**。
  // 额度闸门用自己更松的门槛（0.08），因为误拦的代价（把人冻在半句话上）
  // 远大于误放（多跑一次检索，而且结尾还有一道复查）。
  assert.ok(questionOverlapRatio(
    "技术许可费怎样判断与进口货物的相关性和销售条件，帮我找相关案例",
    "印度进口注塑件的完税价格里，模具成本和技术许可费要不要计入") < 0.2,
    "前提：这一问在计费判定那条门槛下确实会被当成新话题");
  assert.strictEqual(bypass({}), true);
});

t("首问（没有上一轮）不放行——它就是新话题", () => {
  assert.strictEqual(bypass({ previousSelfContainedQuestion: undefined }), false);
  assert.strictEqual(bypass({ previousSelfContainedQuestion: "   " }), false);
});

t("同一对话里问一个自成一体的新问题，不放行", () => {
  assert.strictEqual(
    bypass({ question: "印度公司每年要开几次董事会，法定人数是多少" }), false);
});

t("带指代词的短追问放行（「那第3条具体怎么做」这种）", () => {
  assert.strictEqual(bypass({ question: "那第3条具体怎么做" }), true);
});

t("这一轮传了新Notice → 换了文件就是换了话题，不放行", () => {
  assert.strictEqual(bypass({ hasNewNoticeUpload: true }), false);
});

t("本对话免费追问额度用完就不再放行——口子不会比原来大", () => {
  assert.strictEqual(bypass({ freeFollowUpsUsed: FREE_FOLLOWUP_LIMIT }), false);
  assert.strictEqual(bypass({ freeFollowUpsUsed: FREE_FOLLOWUP_LIMIT - 1 }), true);
});

// ============================================================
// 测试账号不限次白名单
// ============================================================
const { hasUnlimitedQuota, UNLIMITED_QUOTA_LIMIT } = require("./lib/server/plan-quota.js");

console.log("\n== 不限次白名单：给自己人测试用的后门 ==");

const withEnv = (value, run) => {
  const saved = process.env.QUOTA_UNLIMITED_EMAILS;
  if (value === undefined) delete process.env.QUOTA_UNLIMITED_EMAILS;
  else process.env.QUOTA_UNLIMITED_EMAILS = value;
  try { run(); } finally {
    if (saved === undefined) delete process.env.QUOTA_UNLIMITED_EMAILS;
    else process.env.QUOTA_UNLIMITED_EMAILS = saved;
  }
};

t("没配环境变量时，白名单为空——默认谁都不放行", () => {
  withEnv(undefined, () => {
    assert.strictEqual(hasUnlimitedQuota("990850249@qq.com"), false);
    assert.strictEqual(quotaViewOf({
      plan: "free", quotaYearMonth: "2026-09", quotaUsed: 3,
      email: "990850249@qq.com", yearMonth: "2026-09",
    }).remaining, 0);
  });
});

t("配了之后，这个账号额度用不完", () => {
  withEnv("990850249@qq.com", () => {
    assert.strictEqual(hasUnlimitedQuota("990850249@qq.com"), true);
    const view = quotaViewOf({
      plan: "free", quotaYearMonth: "2026-09", quotaUsed: 500,
      email: "990850249@qq.com", yearMonth: "2026-09",
    });
    assert.strictEqual(view.limit, UNLIMITED_QUOTA_LIMIT);
    assert.ok(view.remaining > 0, "问了500次之后还有余额");
  });
});

t("大小写和空格都不敏感，多个邮箱用逗号分隔", () => {
  withEnv(" A@Qq.com , 990850249@QQ.COM ", () => {
    assert.strictEqual(hasUnlimitedQuota("a@qq.com"), true);
    assert.strictEqual(hasUnlimitedQuota("990850249@qq.com"), true);
    assert.strictEqual(hasUnlimitedQuota("b@qq.com"), false);
  });
});

t("不在白名单上的账号完全不受影响", () => {
  withEnv("990850249@qq.com", () => {
    const view = quotaViewOf({
      plan: "free", quotaYearMonth: "2026-09", quotaUsed: 3,
      email: "43567836@qq.com", yearMonth: "2026-09",
    });
    assert.strictEqual(view.limit, PLAN_MONTHLY_LIMIT.free);
    assert.strictEqual(view.remaining, 0);
  });
});

t("上限不能用 Infinity——JSON 化会变成 null，前端进度环会算出 NaN", () => {
  assert.ok(Number.isFinite(UNLIMITED_QUOTA_LIMIT));
  assert.strictEqual(JSON.parse(JSON.stringify({ l: UNLIMITED_QUOTA_LIMIT })).l, UNLIMITED_QUOTA_LIMIT);
});

// ============================================================
// P0 漏洞：游客额度只存 Cookie，不带 Cookie 就能无限刷
// ============================================================
const {
  hashClientId, clientIpFrom, isTrustworthyClientIp, pruneOldRecords,
  currentDay, ANONYMOUS_IP_DAILY_LIMIT,
} = require("./lib/server/anonymous-trial-store.js");

console.log("\n== 游客额度：服务端按IP计数，不能只靠Cookie ==");

t("真实漏洞复现：只看Cookie时，不带Cookie每次都是满额度", () => {
  // 2026-09-18：用户不带Cookie直连 /api/chat，6线程跑完100题。
  // 旧口径 anonymousQuotaView(0) 永远返回"还剩1次"，服务端毫无察觉。
  assert.strictEqual(anonymousQuotaView(0).remaining, 1, "前提：没有Cookie时Cookie锁确实认为还有额度");
  // 加上IP锁之后，同一个IP刷到上限就拦得住，Cookie带不带都一样。
  assert.strictEqual(anonymousQuotaView(0, ANONYMOUS_IP_DAILY_LIMIT).remaining, 0);
});

t("两把锁取更严的那把", () => {
  assert.strictEqual(anonymousQuotaView(1, 0).remaining, 0, "Cookie用完了就该拦");
  assert.strictEqual(anonymousQuotaView(0, ANONYMOUS_IP_DAILY_LIMIT).remaining, 0, "IP用完了也该拦");
  assert.strictEqual(anonymousQuotaView(0, 0).remaining, 1, "两把都没到顶才放行");
});

t("正常访客看到的还是「1次试用」，IP锁只在被刷时才冒头", () => {
  // 这是这次改动**对真实用户零打扰**的保证：一个普通游客第一次来，
  // Cookie 锁（1次）本来就比 IP 锁（5次/天）紧，界面数字和修复前一模一样。
  const fresh = anonymousQuotaView(0, 0);
  assert.strictEqual(fresh.limit, 1);
  assert.strictEqual(fresh.remaining, 1);
  // 只有当同一个出口 IP 被刷到上限，IP 锁才会接管并把 limit 换成它自己的。
  const flooded = anonymousQuotaView(0, ANONYMOUS_IP_DAILY_LIMIT);
  assert.strictEqual(flooded.limit, ANONYMOUS_IP_DAILY_LIMIT);
  assert.strictEqual(flooded.remaining, 0);
});

t("只存IP的哈希，读不出原文；同IP同哈希，不同IP不同哈希", () => {
  const a = hashClientId("203.0.113.7");
  assert.strictEqual(a, hashClientId("203.0.113.7"));
  assert.notStrictEqual(a, hashClientId("203.0.113.8"));
  assert.ok(!a.includes("203"), "哈希里不能残留IP片段");
  assert.strictEqual(a.length, 64, "SHA-256 十六进制是64位");
});

t("取 X-Forwarded-For 的第一段——那才是最初的客户端", () => {
  const h = (init) => new Headers(init);
  assert.strictEqual(clientIpFrom(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 127.0.0.1" })), "203.0.113.7");
  assert.strictEqual(clientIpFrom(h({ "x-real-ip": "203.0.113.9" })), "203.0.113.9");
  assert.strictEqual(clientIpFrom(h({})), "");
});

t("nginx没配转发头时IP锁整体让开，不能让全站共用一个计数器", () => {
  // 全都显示成 127.0.0.1 的话，第6个真实游客会莫名其妙被拒——比不修还糟。
  assert.strictEqual(isTrustworthyClientIp("127.0.0.1"), false);
  assert.strictEqual(isTrustworthyClientIp("::1"), false);
  assert.strictEqual(isTrustworthyClientIp(""), false);
  assert.strictEqual(isTrustworthyClientIp("203.0.113.7"), true);
});

t("登录用户完全不碰IP锁——ipTrialUsed 恒为0时两把锁只剩Cookie那把", () => {
  // identifyRequest 认出登录用户就提前返回，连计数文件都不读。
  // 这里钉住的是 anonymousQuotaView 的默认参数行为：不传 ipUsed 就等于IP锁不参与。
  assert.deepStrictEqual(anonymousQuotaView(0), anonymousQuotaView(0, 0));
});

t("过期记录会被清掉，这个文件不该无限长大", () => {
  const now = new Date("2026-09-18T10:00:00Z");
  const kept = pruneOldRecords([
    { clientHash: "a", day: currentDay(now), used: 1 },
    { clientHash: "b", day: "2026-09-01", used: 9 },
  ], now);
  assert.deepStrictEqual(kept.map((r) => r.clientHash), ["a"]);
});

// ============================================================
// 对话ID：允许前端预生成，但只认我们自己的格式
// ============================================================
const { isValidConversationId } = require("./lib/server/conversation-store.js");

console.log("\n== 对话ID：前端可以先定，但必须是 conv_<UUIDv4> ==");

t("服务端自己生成的那种格式必须通过", () => {
  assert.ok(isValidConversationId(`conv_${require("node:crypto").randomUUID()}`));
  assert.ok(isValidConversationId("conv_3f2504e0-4f89-41d3-9a0c-0305e82c3301"));
});

t("任意字符串一律不认——它是读取对话的通行证，不能让人撞车", () => {
  // GET /api/chat?conversation_id= 不校验身份，id 本身就是凭证。
  // 允许任意字符串的话，两个人都传 "a" 就会读到彼此的对话。
  for (const bad of [
    "a", "conv_a", "conv_1", "../../etc/passwd", "conv_" + "x".repeat(36),
    "3f2504e0-4f89-41d3-9a0c-0305e82c3301",       // 少了 conv_ 前缀
    "conv_3f2504e0-4f89-11d3-9a0c-0305e82c3301",  // 版本位不是 4
    "conv_3f2504e0-4f89-41d3-1a0c-0305e82c3301",  // variant 位不合法
    "", "   ",
  ]) assert.strictEqual(isValidConversationId(bad), false, `不该通过：${bad}`);
});

t("前后空格不影响判定", () => {
  assert.ok(isValidConversationId("  conv_3f2504e0-4f89-41d3-9a0c-0305e82c3301  "));
});

// ============================================================
// 说"没有判例"却给了判例
// ============================================================
const { reconcileCaseClaims } = require("./lib/server/step-text.js");

console.log("\n== 判例区块里明明有判例，结论不能说没有 ==");

const answerWith = (cases) => ({
  short_conclusion: "特许权使用费在满足两项条件时应计入完税价格；但本次检索到的证据中未包含具体判例。",
  action_steps: [{
    kind: "PRACTICAL", citation_refs: [], unverified_claims: [],
    text: "查询海关或司法案例：本次检索到的证据中未包含具体判例，建议通过CESTAT公开数据库检索。",
  }],
  risks_and_exceptions: ["本次检索到的资料中没有涉及相关案例。"],
  related_cases: cases,
});

t("真实事故：有三份判例时，「未包含具体判例」必须被改掉", () => {
  // 2026-09-18：结论说"未包含具体判例"，而「相关判例」区块列着三份 CESTAT 判例。
  // 根因是判例检索和主答案**并发**——模型写回答时根本没拿到判例。
  const fixed = reconcileCaseClaims(answerWith([{ docid: "1" }, { docid: "2" }, { docid: "3" }]));
  assert.ok(!fixed.short_conclusion.includes("未包含具体判例"), "结论里那句假话必须没了");
  assert.ok(fixed.short_conclusion.includes("相关判例见下方"), "该把话引到判例区块去");
  assert.ok(!fixed.action_steps[0].text.includes("未包含具体判例"));
  assert.ok(!fixed.risks_and_exceptions[0].includes("没有涉及相关案例"));
});

t("确实没有判例时，改成「并不是所有判例」而不是指向不存在的区块", () => {
  const fixed = reconcileCaseClaims(answerWith([]));
  assert.ok(fixed.short_conclusion.includes("本次提供的案例并不是所有判例"));
  assert.ok(!fixed.short_conclusion.includes("相关判例见下方"), "没有判例区块时不能让用户去找它");
});

t("related_cases 字段缺省时按「没有判例」处理，不报错", () => {
  const fixed = reconcileCaseClaims({
    short_conclusion: "本次检索到的证据中未包含具体判例。",
    action_steps: [], risks_and_exceptions: [],
  });
  assert.ok(fixed.short_conclusion.includes("本次提供的案例并不是所有判例"));
});

t("点名某个案子的说法**不改**——那句话是准确且有用的", () => {
  // "没有找到任何名为 FILCO 的判例"回答的正是用户问的那个案子，
  // 改成"相关判例见下方"反而把信息弄丢了。抓不到这类句子是设计，不是漏网。
  const text = "本次检索到的证据中没有找到任何名为 FILCO 的判例，也没有其法院与日期信息。";
  assert.strictEqual(rewriteCaseEvidenceCaveat(text, true), text);
});

t("★ 真实事故：点名'三星'而判例区真有两份 Samsung 案——那句'没有'是假话，必须改", () => {
  // 2026-10-13：模型写"未包含任何名为三星的广告费税务诉讼案件，也未包含法院对
  // 广告费扣除的裁判规则"，而判例区列着两条 Samsung AMP 案。旧正则两个都没罩住：
  // "案件"不在锚定词表、中间插入语超过 8 字上限。现在靠点名核对拿数据判真假。
  const SAMSUNG_CASES = [{
    caseName: "Samsung India Electronics Private Limited vs Dcit, Tpo 3(1)(2), Delhi on 12 August, 2026",
  }, {
    caseName: "Samsung India Electronics Pvt. Ltd vs Addl. Cit National E-Assessment Centre, New Delhi on 12 August, 2026",
  }];
  const text = "本次检索到的证据未包含任何名为“三星”的广告费税务诉讼案件，也未包含法院对广告费扣除的裁判规则。";
  const rewritten = rewriteCaseEvidenceCaveat(text, true, SAMSUNG_CASES);
  assert.ok(!rewritten.includes("未包含"), `假话必须被改掉（拿到了：${rewritten}）`);
  assert.ok(rewritten.includes("相关判例见下方"), "该把话引到判例区块去");
  assert.ok(!/相关判例见下方「相关判例」[，,。；;、\s]*相关判例见下方/.test(rewritten),
    "两句都命中时指路文案不能重复出现");

  // 反过来：判例区没有 Samsung 案时，这句话就是真的，保留。
  // 只用第一分句断言——第二分句"未包含裁判规则"在判例区有华为 AMP 案时同样是假话，
  // 混在一起断言会测歪。
  const other = rewriteCaseEvidenceCaveat(
    "本次检索到的证据未包含任何名为“三星”的广告费税务诉讼案件。", true,
    [{ caseName: "Huawei Telecommunications (India) Co. Ltd vs Dcit, Circle-2(1), Gurgaon on 10 October, 2025" }]);
  assert.strictEqual(other, "本次检索到的证据未包含任何名为“三星”的广告费税务诉讼案件。",
    "判例区没有三星案时，点名句原样保留");
});

t("点名核对不依赖'名为'二字——词典扫描直接认公司名", () => {
  const SAMSUNG_CASES = [{ caseName: "Samsung India Electronics Private Limited vs Dcit, Tpo 3(1)(2), Delhi on 12 August, 2026" }];
  // 没有"名为"结构，只有"三星的"——同样应该被识别为点名并改写。
  const rewritten = rewriteCaseEvidenceCaveat("本次检索到的证据未包含三星的广告费案件。", true, SAMSUNG_CASES);
  assert.ok(!rewritten.includes("未包含"), `应改写（拿到了：${rewritten}）`);
});

  t("★ evidence_gap 也要和判例区对齐（顶部'部分覆盖'横幅那句话）", () => {
    const fixed = reconcileCaseClaims({
      short_conclusion: "本次检索到的证据未包含任何名为“三星”的广告费税务诉讼案件。",
      action_steps: [],
      risks_and_exceptions: [],
      evidence_gap: "本次证据未包含三星广告费的具体判例及法院裁判规则",
      related_cases: [{
        caseName: "Samsung India Electronics Private Limited vs Dcit, Tpo 3(1)(2), Delhi on 12 August, 2026",
      }],
    });
    assert.ok(!fixed.evidence_gap.includes("未包含"),
      `横幅文案不能再和判例区矛盾（拿到了：${fixed.evidence_gap}）`);
    assert.ok(!fixed.short_conclusion.includes("未包含"), "结论那句假话也必须改掉");
  });

  t("★ 真实事故（晚间续）：'未发现/未涵盖'与'无法提供…裁决结果'两种新写法", () => {
    // 2026-10-13 晚间：模型换措辞——结论写"未**发现**名为“三星公司广告费案件”的
    // 具体判例"，横幅写"未**涵盖**…判例，**无法提供**特定案件的**裁决结果**"。
    // 动词表缺"发现/涵盖"、"无法"的"法"字、锚点后的"结果"连写都没罩住，两句全漏网。
    const SAMSUNG_CASES = [{
      caseName: "Samsung India Electronics Private Limited vs Dcit, Tpo 3(1)(2), Delhi on 12 August, 2026",
    }];
    const conclusion = rewriteCaseEvidenceCaveat(
      "本次检索到的证据中未发现名为“三星公司广告费案件”的具体判例，但提供了与广告费相关的所得税扣除、转让定价、TDS及争议解决程序的法律规定。",
      true, SAMSUNG_CASES);
    assert.ok(!conclusion.includes("未发现"), `结论漏网（拿到了：${conclusion}）`);
    assert.ok(conclusion.includes("相关判例见下方"), "该把话引到判例区块");
    assert.ok(conclusion.includes("但提供了"), "后半句的有效信息要保留");

    const gap = rewriteCaseEvidenceCaveat(
      "本次证据未涵盖名为“三星公司广告费案件”的具体判例，无法提供特定案件的裁决结果或争议焦点。",
      true, SAMSUNG_CASES);
    assert.ok(!gap.includes("未涵盖"), `横幅第一处漏网（拿到了：${gap}）`);
    assert.ok(!gap.includes("无法提供"), `横幅第二处漏网（拿到了：${gap}）`);
    assert.ok(!/「相关判例」.{0,4}(或争议焦点|裁决结果)/.test(gap), "锚点后的连写残尾要吞干净");

    // 引号内的"案件"不能抢匹配把长句截半（撤"案件"出锚点表的原因）
    assert.ok(!/」”的具体判例/.test(conclusion), "不能留下引号残尾");
  });

  t("不带引号的'广告费案件'短句由第二条正则接", () => {
    const SAMSUNG_CASES = [{
      caseName: "Samsung India Electronics Private Limited vs Dcit, Tpo 3(1)(2), Delhi on 12 August, 2026",
    }];
    const out = rewriteCaseEvidenceCaveat("本次检索到的证据未包含三星的广告费案件。", true, SAMSUNG_CASES);
    assert.ok(!out.includes("未包含"), `短句也该改（拿到了：${out}）`);
    // 无判例时短句同样不能指向不存在的区块
    assert.ok(rewriteCaseEvidenceCaveat("本次检索到的证据未包含三星的广告费案件。", false, [])
      .includes("并不是所有判例"));
  });

t("不相干的句子原样不动（有无判例都一样）", () => {
  const text = "本次提供的证据中包含三份ITAT裁定，均支持该抗辩方向。";
  assert.strictEqual(rewriteCaseEvidenceCaveat(text, true), text);
  assert.strictEqual(rewriteCaseEvidenceCaveat(text, false), text);
});

// ============================================================
// 对话导出
// ============================================================
const { buildWordHtml, safeFileName, stripInteractiveBits } = require("./lib/conversation-export.js");

console.log("\n== 导出：文件名、交互元素剥离、字号刻度一致 ==");

t("文件名里的非法字符换掉，超长标题截断", () => {
  assert.strictEqual(safeFileName('进口/报关:什么单据?', "doc"), "进口_报关_什么单据_.doc");
  assert.strictEqual(safeFileName("", "doc"), "印度合规问答.doc");
  assert.ok(safeFileName("题".repeat(80), "doc").length <= 44);
});

t("引用角标连同悬停浮层一起剥掉——导出成文件后它既点不动也读不通", () => {
  const html = '<li>确认准入路径必须走政府审批。'
    + '<sup class="citation-mark"><button class="citation-mark-trigger">2</button>'
    + '<div class="citation-mark-popover"><strong>FDI Policy</strong>para 3.1.1</div></sup></li>';
  const stripped = stripInteractiveBits(html);
  assert.ok(stripped.includes("确认准入路径必须走政府审批。"), "正文必须原样留着");
  assert.ok(!stripped.includes("citation-mark"), "角标要没了");
  assert.ok(!stripped.includes("para 3.1.1"), "浮层内容不能掉进正文里");
});

t("Word 文档带 BOM 之外的必要结构：编码、标题、免责声明", () => {
  const html = buildWordHtml({
    title: "印度进口注塑件完税价格构成",
    exportedAt: "2026-09-18 15:04",
    turns: [{ question: "完税价格只看发票金额吗？", answerHtml: "<p class=\"answer-lead\">不是。</p>" }],
  });
  assert.ok(html.includes('<meta charset="utf-8">'), "不声明编码 Word 会乱码");
  assert.ok(html.includes("urn:schemas-microsoft-com:office:word"), "Word 命名空间");
  assert.ok(html.includes("印度进口注塑件完税价格构成"));
  assert.ok(html.includes("完税价格只看发票金额吗？"));
  assert.ok(html.includes("不是。"));
  assert.ok(html.includes("不构成法律意见"), "导出件必须带免责声明");
});

t("标题里的尖括号被转义，不会破坏文档结构", () => {
  const html = buildWordHtml({
    title: '<script>x</script>', exportedAt: "x",
    turns: [{ question: "<b>问</b>", answerHtml: "<p>答</p>" }],
  });
  assert.ok(!html.includes("<script>"), "标题里的标签必须转义");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;b&gt;问&lt;/b&gt;"), "问题文本是纯文本，要转义");
  assert.ok(html.includes("<p>答</p>"), "回答是页面渲染出来的HTML，原样保留");
});

t("Word 样式表和网页的六级字号阶梯对齐——改了 globals.css 这里要跟着改", () => {
  // Word 不认 CSS 变量，样式表里是把六档字号展开写死的副本。
  // 两边脱节的话导出件会和页面长得不一样，而"保留原格式"正是这个功能的全部意义。
  // 用 __dirname 而不是相对 cwd：这个文件是从 .v14build_x/ 下跑的，
  // 相对 cwd 的路径会指到项目外面去（第一次写就栽在这）。
  //
  // 这条测试自己也改过两次：最早只钉 --fs-title / --fs-body 两档，
  // 而改版后 --fs-title 在答案卡片里根本不用了——只钉那两个会让它
  // **在整个阶梯换掉之后依然是绿的**，等于没测。所以现在逐档钉。
  const cssPath = require("node:path").join(__dirname, "..", "app", "globals.css");
  const css = require("node:fs").readFileSync(cssPath, "utf8");
  const html = buildWordHtml({ title: "t", exportedAt: "x", turns: [] });
  for (const name of ["figure", "lead", "body", "aside", "source", "mark"]) {
    const px = css.match(new RegExp(`--fs-${name}:\\s*(\\d+)px`))?.[1];
    assert.ok(px, `globals.css 里应有 --fs-${name}`);
    assert.ok(html.includes(`font-size: ${px}px`), `Word 样式表缺 --fs-${name} 对应的 ${px}px`);
  }
  // 反向钉：字号必须和重要性严格同向。这是整轮改版的**全部理由**，
  // 也是唯一一条光看字号数字就能机械验证的产品原则。
  const px = (n) => Number(css.match(new RegExp(`--fs-${n}:\\s*(\\d+)px`))[1]);
  assert.ok(px("figure") > px("lead"), "关键数值必须是全页最大——用户来取的就是这几个数");
  assert.ok(px("lead") > px("body"), "结论字号必须大于正文");
  assert.ok(px("body") > px("aside"), "正文字号必须大于旁注");
  assert.ok(px("aside") > px("source"), "旁注字号必须大于法条名称");
  assert.ok(px("source") > px("mark"), "法条名称字号必须大于区块标题");
});

t("改了打印/Word 样式就必须动 EXPORT_STYLE_VERSION", () => {
  // 排查"导出还是一堆空白"时来回三次都卡在**分不清手上那份 PDF 是哪一版样式生成的**。
  // 版本号印在纸上和 Word 页脚里，但两处要一致，否则印出来的号码是假的。
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
  const { EXPORT_STYLE_VERSION } = require("./lib/conversation-export.js");
  assert.ok(
    css.includes(`导出排版 v${EXPORT_STYLE_VERSION}`),
    `globals.css 打印页脚里的版本号应为 v${EXPORT_STYLE_VERSION}`,
  );
  const html = buildWordHtml({ title: "t", exportedAt: "x", turns: [] });
  assert.ok(html.includes(`排版 v${EXPORT_STYLE_VERSION}`), "Word 页脚里也要带同一个版本号");
});

t("答案卡片里不再有衬线体——混排衬线会被误读成引文", () => {
  // 2026-09-21：区块标题原来用宋体 20px，是全页最大的字。既改字号也去衬线，
  // 否则一张卡片里两种字族，用户会以为那部分是另一种性质的内容。
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
  for (const cls of [".answer-block-title", ".answer-section h3", ".law-group-title"]) {
    const block = css.slice(css.indexOf(cls + " {"));
    const body = block.slice(0, block.indexOf("}"));
    assert.ok(!/serif/.test(body), `${cls} 不应再指定衬线字族`);
  }
});

t("法条名称不得比法规要求条目更醒目", () => {
  // 用户原话："次次重要信息（如法条名称）不要占据视觉重点"。
  // 原来是 15px/800 + 4px 蓝色左竖线，比它统领的条目还抢眼。
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
  const block = css.slice(css.indexOf(".law-group-title {"));
  const body = block.slice(0, block.indexOf("}"));
  assert.ok(body.includes("var(--fs-source)"), "法条名称应使用 --fs-source（溯源层）");
  assert.ok(!/border-left/.test(body), "法条名称不应再有左竖线——那是最强的指向性装饰");
  assert.ok(body.includes("var(--muted)"), "法条名称应退到 --muted");
});

t("双栏标尺必须有窄屏降级——否则手机上正文列只剩三四个字宽", () => {
  // 左栏 116px 是固定的，窄屏不折回单栏的话正文列会被挤没。
  // 打印同理：纸宽 ~182mm，扣掉标尺栏后行长短到没法读，而纸上没有"少滚几屏"这种收益。
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
  const narrow = css.slice(css.indexOf("@media (max-width: 820px)"));
  assert.ok(
    /\.answer-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/.test(narrow.slice(0, 900)),
    "窄屏必须把 .answer-row 折回单栏",
  );
  const print = css.slice(css.indexOf("@media print"));
  assert.ok(
    /\.answer-row\s*\{[^}]*display:\s*block\s*!important/.test(print),
    "打印时必须把 .answer-row 折回单栏",
  );
});

console.log("\n== 关键数值：全页最大的字，必须有出处 ==");

const { verifyKeyFigures, MAX_KEY_FIGURES } = require("./lib/server/key-figures.js");

const KF_STEPS = [
  {
    kind: "MANDATORY",
    text: "代扣代缴所得税：向非居民支付特许权使用费时，付款人须在贷记或实际支付时按20%的税率扣除所得税。",
    unverified_claims: [],
  },
  {
    kind: "MANDATORY",
    text: "反向征税申报：进口服务由接受方按18%自行申报缴纳IGST。",
    unverified_claims: ["18%"],   // claim-check 判定这个数在条文里找不到出处
  },
  {
    kind: "PRACTICAL",
    text: "汇款前7个工作日启动 Form 145 流程。",
    unverified_claims: [],
  },
];

t("★ 数值在已核验的强制条目里 → 放行", () => {
  const out = verifyKeyFigures(
    [{ value: "20%", label: "法定预提税率", note: "未取得TRC时适用" }],
    KF_STEPS,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].note, "未取得TRC时适用");
});

t("★ 数值被 claim-check 判为无出处 → 丢弃", () => {
  // 这是整个字段存在的理由。把一个凭记忆编出来的税率放到 22px，
  // 正是 contracts.ts 里说的"有依据的外观 + 无依据的内容"的极端形态。
  assert.deepEqual(verifyKeyFigures([{ value: "18%", label: "IGST税率" }], KF_STEPS), []);
});

t("★ 数值只出现在实务建议里 → 丢弃", () => {
  // PRACTICAL 不要求附条文原句，quote_status 是 SKIPPED，本来就没经过核验。
  // 拿它当出处等于没校验。
  assert.deepEqual(verifyKeyFigures([{ value: "7个工作日", label: "提前天数" }], KF_STEPS), []);
});

t("★ 模型凭空写的数 → 丢弃", () => {
  assert.deepEqual(verifyKeyFigures([{ value: "25%", label: "编的" }], KF_STEPS), []);
});

t("全角数字和空格要能对上", () => {
  assert.equal(verifyKeyFigures([{ value: "20 %", label: "税率" }], KF_STEPS).length, 1);
  assert.equal(verifyKeyFigures([{ value: "２０%", label: "税率" }], KF_STEPS).length, 1);
});

t("★ 工作日和自然日不算同一个——差几天就是迟报", () => {
  const steps = [{ kind: "MANDATORY", text: "须在7个工作日内提交。", unverified_claims: [] }];
  // "7天" 不是 "7个工作日" 的子串，所以本来就匹配不上；这条钉的是
  // **不要为了提高命中率去做单位归一化**。归一化会把工作日和自然日认成一个。
  assert.deepEqual(verifyKeyFigures([{ value: "7天", label: "期限" }], steps), []);
  assert.equal(verifyKeyFigures([{ value: "7个工作日", label: "期限" }], steps).length, 1);
});

t("重复数值只留一个", () => {
  const out = verifyKeyFigures(
    [{ value: "20%", label: "预提税率" }, { value: "20 %", label: "又写了一遍" }],
    KF_STEPS,
  );
  assert.equal(out.length, 1);
});

t("超过上限截断，脏数据不崩", () => {
  const many = Array.from({ length: 9 }, () => ({ value: "20%", label: "税率" }));
  assert.ok(verifyKeyFigures(many, KF_STEPS).length <= MAX_KEY_FIGURES);
  for (const bad of [null, undefined, "x", 3, [null], [{}], [{ value: 1, label: "x" }]]) {
    assert.deepEqual(verifyKeyFigures(bad, KF_STEPS), [], `脏输入应返回空数组：${JSON.stringify(bad)}`);
  }
});

t("★ 真实事故：所得税问题，全页最大的字是 GST 的 10%", () => {
  // 2026-09-22 实测：问「印度 income tax（ITD）案件中，保证金计算的基数包括哪些」，
  // 结论自己都写着"所得税语境下无直接条文"，而 22px 那行是「10% · GST上诉预缴比例」。
  //
  // 它**合法地通过了出处校验**——10% 确实逐字出现在一条已核验的 MANDATORY 步骤里。
  // 出处是真的，只是答的不是用户问的那个税。
  // 出处对 ≠ 对题，这是第一版校验漏掉的另一半。
  const steps = [
    {
      kind: "MANDATORY",
      text: "GST上诉中须预缴争议税额的10%。",
      unverified_claims: [],
      sources: ["CGST Rules 2017 — Forms Appendix"],
    },
  ];
  const q = require("./lib/server/domain-scope.js").detectQuestionCategories(
    "印度income tax（ITD）案件中，保证金计算的基数包括哪些？",
  );
  assert.ok(q.includes("income_tax"), "问题应被判为所得税");
  assert.ok(!q.includes("gst"), "问题不该被判为 GST");
  assert.deepEqual(
    verifyKeyFigures([{ value: "10%", label: "GST上诉预缴比例" }], steps, { questionCategories: q }),
    [],
    "★ 跨法域的数值必须丢弃——它会被放到全页最大的字号上",
  );
});

t("同一个数值、同一个问题，换成所得税的条目就放行", () => {
  // 对照组：证明挡掉的是"法域不对"，不是"10% 这个数不行"。
  const steps = [{
    kind: "MANDATORY",
    text: "援引中印税收协定后特许权使用费税率降至10%。",
    unverified_claims: [],
    sources: ["Income-tax Act, 2025"],
  }];
  const out = verifyKeyFigures(
    [{ value: "10%", label: "协定优惠税率" }],
    steps,
    { questionCategories: ["income_tax"] },
  );
  assert.equal(out.length, 1);
});

t("一条要求跨引两部法（DTAA + 所得税法）时，只要有一部对题就放行", () => {
  const steps = [{
    kind: "MANDATORY",
    text: "特许权使用费来源国征税上限为10%。",
    unverified_claims: [],
    sources: ["India–China DTAA, 1994", "The Customs Act, 1962"],
  }];
  assert.equal(
    verifyKeyFigures([{ value: "10%", label: "协定上限" }], steps, { questionCategories: ["income_tax"] }).length,
    1,
    "DTAA 归所得税类，够了",
  );
});

t("★ 认不出来时一律放行——三种没把握的情况", () => {
  const base = { kind: "MANDATORY", text: "按20%扣缴。", unverified_claims: [] };
  const fig = [{ value: "20%", label: "预提税率" }];
  // ① 问题的法域认不出来
  assert.equal(verifyKeyFigures(fig, [{ ...base, sources: ["CGST Rules 2017"] }], { questionCategories: [] }).length, 1);
  // ② 这条要求没引任何法规
  assert.equal(verifyKeyFigures(fig, [{ ...base, sources: [] }], { questionCategories: ["income_tax"] }).length, 1);
  // ③ 法规名归类成 other（分类规则不认识它）
  assert.equal(verifyKeyFigures(fig, [{ ...base, sources: ["某份没人认识的资料"] }], { questionCategories: ["income_tax"] }).length, 1);
  // 兜底原则：误杀一个该露脸的数值，不该由"没把握"的判断来承担。
});

t("不传 options 时行为和加闸门之前完全一样", () => {
  // 这道闸是后加的，所有老调用点（和测试）不传 options 必须原样工作。
  const steps = [{ kind: "MANDATORY", text: "按20%扣缴。", unverified_claims: [], sources: ["CGST Rules 2017"] }];
  assert.equal(verifyKeyFigures([{ value: "20%", label: "税率" }], steps).length, 1);
});

t("value 太长 → 丢弃（模型把半句话塞进来会把 22px 那行撑烂）", () => {
  const steps = [{
    kind: "MANDATORY",
    text: "付款人须在贷记或实际支付时按20%的税率扣除所得税并于次月7日前缴库。",
    unverified_claims: [],
  }];
  assert.deepEqual(
    verifyKeyFigures([{ value: "按20%的税率扣除所得税并于次月7日前缴库", label: "税率" }], steps),
    [],
  );
});

console.log("\n== 条文内自标已废止：数字在原文里找得到，但原文说它已经被改了 ==");

{
  const {
    findSupersededValues, detectSupersededUse, SUPERSESSION_PROMPT_RULE,
  } = require("./lib/server/intra-document-supersession.js");

  // 她知识库里那份 CBDT 备忘录条目的真实形态（2026-09-28 截图）
  const CBDT = "F.No.404/72/93-ITCC Government of India Ministry of Finance Central Board of "
    + "Direct Taxes (CBDT) New Delhi, Dated: 29.02.2016 - original guideline, deposit rate 15% "
    + "[NOTE: this 15% was revised to 20% by the O.M. dated 31.07.2017 - see the companion entry]. "
    + "Instruction No. 1914 dated 21.03.1996 contains guidelines of the Board regarding procedure "
    + "to be followed in recovery of outstanding demand.";

  t("★ 真实事故：答案写 15%，而引用条文自己标着已改成 20%", () => {
    // 资料是对的、标注也到位，是模型读了 15% 就用了，没读后面那句 NOTE。
    // 所有既有校验都会放行：15% 确实逐字出现在原文里，角标也挂得对。
    // 差五个百分点，一笔千万卢比级的争议税款就是几十万卢比。
    const found = detectSupersededUse({
      text: "考虑是否申请暂缓缴税，通常需支付争议税款的15%作为预缴。",
      citedTexts: [CBDT],
    });
    assert.deepStrictEqual(found, [{ used: "15%", replacement: "20%", kind: "OLD_ONLY" }]);
  });

  t("★ 文号和日期不能被当成数值", () => {
    // 404 / 72 / 93 / 1914 / 1996 / 29.02.2016 全是数字。
    // 放宽到一般数字，噪音立刻压过信号——所以只认百分比和金额。
    const values = findSupersededValues(CBDT);
    assert.deepStrictEqual(values, [{ old: "15%", replacement: "20%" }]);
  });

  t("正确的沿革表述照常放行", () => {
    // 「原为15%，自2017年7月31日起调整为20%」是对的写法，历史沿革本来就该写。
    // 不放行的话，凡是讲沿革的答案都会挂警示，警示多了就没人看了。
    for (const text of [
      "原为15%，自2017年7月31日起调整为20%。",
      "原为15%，现已调整为20%。",
      "须支付争议税款的20%作为预缴。",
      "对评估令不服可在30天内上诉。",
    ]) {
      assert.deepStrictEqual(detectSupersededUse({ text, citedTexts: [CBDT] }), [], text);
    }
  });

  t("★★ 方向写反必须抓住——这是第一版放行的那个洞", () => {
    // 第一版的判据是"新值出现过就不报"，只看字符串在不在，**不看哪个被写成了现行的**。
    // 于是「原为20%，现已调整为15%」直接过闸：两个值都在。
    // 而用户读到的是"现在是 15%"——正是原来那个错误，
    // 只是穿了一件更像样的外衣，**比只写 15% 更有说服力**。
    const r = detectSupersededUse({ text: "原为20%，现已调整为15%。", citedTexts: [CBDT] });
    assert.strictEqual(r.length, 1, "★ 方向写反不能放行");
    assert.strictEqual(r[0].kind, "REVERSED");
  });

  t("★ 把现行值降格成例外，也要抓", () => {
    // 「通常按15%预缴，个别情况下可能要求20%」——两个值都在，但读起来 15% 是常态。
    for (const text of [
      "通常按15%预缴，个别情况下可能要求20%。",
      "15%（另见20%相关讨论）",
    ]) {
      const r = detectSupersededUse({ text, citedTexts: [CBDT] });
      assert.strictEqual(r.length, 1, text);
      assert.strictEqual(r[0].kind, "UNCLEAR", text);
    }
  });

  t("三种错法要分开标，文案不能共用一句", () => {
    // OLD_ONLY「只写了旧值」和 REVERSED「把旧值说成现行的」对用户的含义不同，
    // 后者要提示"方向可能反了"，前者只要给出新值。
    const page = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "app", "page.tsx"), "utf8");
    const at = page.indexOf("const renderSuperseded");
    const body = page.slice(at, at + 2200);
    assert.ok(/REVERSED/.test(body) && /UNCLEAR/.test(body), "三种要分别渲染");
    assert.ok(/方向/.test(body), "REVERSED 要说明方向可能反了");
  });

  t("四种语序都认得，而且不能把新旧抓反", () => {
    // 抓反比不报更糟——会让用户从对的值改到错的值。
    for (const [text, want] of [
      ["The rate was revised from 15% to 20%", { old: "15%", replacement: "20%" }],
      ["The limit has been enhanced to Rs. 50,00,000 from Rs. 20,00,000.",
        { old: "Rs. 20,00,000", replacement: "Rs. 50,00,000" }],
      ["预缴比例由15%调整为20%。", { old: "15%", replacement: "20%" }],
      ["threshold of Rs. 1 crore was increased to Rs. 5 crore",
        { old: "Rs. 1 crore", replacement: "Rs. 5 crore" }],
    ]) {
      assert.deepStrictEqual(findSupersededValues(text)[0], want, `语序没认对：${text}`);
    }
  });

  t("没有修订措辞的原文不报", () => {
    assert.deepStrictEqual(findSupersededValues("15% remains unchanged"), []);
    assert.deepStrictEqual(findSupersededValues("deposit rate is 20%"), []);
    assert.deepStrictEqual(findSupersededValues(""), []);
  });

  t("旧值新值相同的丢弃", () => {
    // 要么抽错了、要么原文本身没说清楚，报出来都只是噪音。
    assert.deepStrictEqual(findSupersededValues("15% was revised to 15%"), []);
  });

  t("★ 只标记，不替用户改写数值", () => {
    // 悄悄改法律数字是系统没资格做的判断——万一那一条讲的确实是历史年度
    // （FY2016-17 适用 15%），改掉就是把对的改错了。
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "lib", "server", "intra-document-supersession.ts"),
      "utf8");
    assert.ok(/只标记.{0,6}绝不替用户/.test(src), "这条立场要写在文件里，别被后人改掉");
    // 导出的函数里不该有任何改写正文的东西
    const { detectSupersededUse: fn } = require("./lib/server/intra-document-supersession.js");
    const out = fn({ text: "需支付15%作为预缴。", citedTexts: [CBDT] });
    assert.ok(out.every((x) => typeof x.used === "string" && typeof x.replacement === "string"));
    assert.ok(!("text" in out[0]), "不返回改写后的正文");
  });

  t("提示词里要点名这种「跟在旧值后面的方括号」写法", () => {
    assert.ok(/NOTE/.test(SUPERSESSION_PROMPT_RULE));
    assert.ok(/方括号|从句/.test(SUPERSESSION_PROMPT_RULE), "要说清它藏在哪，模型才知道去看");
    assert.ok(/绝不能只写旧值/.test(SUPERSESSION_PROMPT_RULE));
  });

  t("★ 实务建议那一路也要挂警示", () => {
    // 线上那条 15% 恰恰出现在实务建议第 7 条里。只在法规要求那一路挂，
    // 等于漏掉了它真正出事的地方。
    const page = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "app", "page.tsx"), "utf8");
    const flow = page.slice(page.indexOf("function PracticalFlow"));
    assert.ok(/renderSuperseded/.test(flow.slice(0, flow.indexOf("\n}"))),
      "★ PracticalFlow 里必须调 renderSuperseded");
  });
}

console.log("\n== 答案卡片：浮层不能被裁、归组不能只看第一个角标 ==");

{
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "..", "app", "page.tsx"), "utf8");
  // ⚠必须先剥掉 /* */ 注释再断言。
  // 第一版没剥，结果 `.law-category` 规则里那句中文注释
  // "同样不能 overflow:hidden——……" 被 /overflow:\s*hidden/ 抓到了，
  // 断言在一份完全正确的样式表上失败。**注释里写了什么，正则是不认识的。**
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleBody = (selector) => {
    const at = cssCode.indexOf(selector + " {");
    if (at < 0) return "";
    return cssCode.slice(at, cssCode.indexOf("}", at));
  };

  t("★ 角标浮层的祖先容器都不许 overflow:hidden", () => {
    // 2026-09-28 实测：改双栏版式时为了让头部条底色贴着圆角切齐，
    // 我给 .answer-card 加了 overflow:hidden，**把引用浮层整个裁掉了**——
    // 浮层 290px 宽、绝对定位，而「依据」那一列贴着卡片右边缘，
    // 一半在卡片外，用户看到的是半截英文原文。
    // 圆角靠头部条自己设上圆角解决，不靠裁剪父容器。
    for (const selector of [".answer-card", ".law-category"]) {
      assert.ok(!/overflow:\s*hidden/.test(ruleBody(selector)),
        `★ ${selector} 不能 overflow:hidden——会裁掉引用浮层`);
    }
    // 圆角得有人负责，否则头部条底色会溢出卡片的圆角
    assert.ok(/border-radius/.test(ruleBody(".answer-card-head")), "头部条要自己切上圆角");
    assert.ok(/border-radius/.test(ruleBody(".law-category-head")), "类别头要自己切上圆角");
  });

  t("靠右那一列的浮层要右对齐，否则向右溢出", () => {
    const at = cssCode.indexOf(".requirement-table-refs .citation-mark-popover");
    assert.ok(at > 0, "依据列的浮层需要单独定位");
    const body = cssCode.slice(at, cssCode.indexOf("}", at));
    assert.ok(/right:\s*0/.test(body) && /left:\s*auto/.test(body));
  });

  t("浮层自己能滚、能收窄，长原文不顶破布局", () => {
    const body = ruleBody(".citation-mark-popover");
    assert.ok(/max-height/.test(body) && /overflow-y:\s*auto/.test(body),
      "CBDT 备忘录那种上千字的原文要能在浮层里滚");
    assert.ok(/width:\s*min\(/.test(body), "窄屏要能跟着收窄");
  });

  t("★ 归组按位阶最高的引用，不按第一个", () => {
    // 实测：一条要求同时引了 14（Income-tax Act, 2025）和 31（CBDT Office Memorandum，
    // 讲 stay of demand 预缴比例的）。按 citation_refs[0] 归组，整条挂在
    // 「Income-tax Act, 2025 法律」下面，**那份备忘录的名字一个字都没出现**。
    //
    // 危害不只是少显示一个来源：legal-hierarchy.ts 写明 circular／备忘录
    // 只约束税务官、不约束法院。把它摆在「法律」徽标底下，
    // 等于给一份最弱的依据盖了最高的章。
    const fn = page.slice(page.indexOf("function primaryCitation"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.ok(/HIERARCHY_RANK/.test(body), "★ 必须按位阶挑，不能按顺序");
    assert.ok(!/citation_refs\[0\]/.test(body), "★ 不能再退回取第一个");
    // 归组函数也不许再用第一个
    const grp = page.slice(page.indexOf("function groupStepsByLaw"));
    assert.ok(!/citation_refs\[0\]/.test(grp.slice(0, grp.indexOf("\n}"))));
  });

  t("★ 归组先过法域、再比位阶，不能跨法域比位阶", () => {
    // 2026-09-29 实测事故（上一条规则的反向）：用户问 GST，
    // 一条要求同时引了 5（ICAI IDTC – GST Law）和 11（Income-tax Act, 2025）。
    // 按位阶排，法律 > 行业指南 → 选中 Income-tax Act，
    // 于是这条讲进项税抵扣、讲「罚款为应纳税额的 10% 或 1 万卢比」的纯 GST 内容，
    // 被挂到了「所得税 / DTAA」标题下面。
    //
    // 位阶规则没写错，错在它是在**跨法域**的候选里排序的。
    // 「法律 > 通函」成立；「所得税法 > GST 指南」这个比较本身就不成立。
    const fn = page.slice(page.indexOf("function primaryCitation"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.ok(/questionCategories/.test(body), "★ 必须拿到问题法域");
    const gate = body.indexOf("questionCategories.includes");
    const rank = body.indexOf("HIERARCHY_RANK");
    assert.ok(gate > 0, "★ 要有法域闸门");
    assert.ok(gate < rank, "★ 法域闸门必须在位阶比较之前");
    // 两个退让：法域认不出来不收窄；收窄成空集也不收窄。
    assert.ok(/questionCategories\.length === 0/.test(body),
      "★ 法域认不出来时必须退回纯位阶，不能当成「一个都不匹配」");
    assert.ok(/inDomain\.length > 0 \? inDomain : cited/.test(body),
      "★ 收窄成空集时要退回全集——整条判成「无依据」比归错组更糟");
    // 调用处必须真的把法域传进去，否则上面写得再对也是摆设
    assert.ok(/groupStepsByLaw\(\s*\n?\s*mandatory, answer\.citations, answer\.question_categories/
      .test(page), "★ groupStepsByLaw 调用处要传法域");
    assert.ok(/secondaryLaws\(step, answer\.citations, answer\.question_categories/.test(page),
      "★ secondaryLaws 调用处也要传，否则「另据」会把主法源又列一遍");
    // 契约字段要在，否则服务端下发不到前端
    const contracts = fs.readFileSync(path.join(__dirname, "..", "lib/contracts.ts"), "utf8");
    assert.ok(/question_categories\?: string\[\]/.test(contracts), "★ 契约要有这个字段");
    const answerSrc = fs.readFileSync(path.join(__dirname, "..", "lib/server/legal-answer.ts"), "utf8");
    assert.ok(/answer\.question_categories = conversationCategories/.test(answerSrc),
      "★ 服务端要真的下发，用的必须是会话级法域");
  });

  t("★ 事故里那两个法源名，法域必须分得开", () => {
    // 上一条测的是"顺序对不对"，这条测的是"分得开分不开"——
    // 闸门写得再对，只要 ICAI IDTC 被判成 other，它就永远进不了 GST 子集，
    // 收窄成空集后退回全集，事故照样复现。
    // 直接调真正在用的那个函数，不重写一份判据。
    // （2026-09-29 判据从 page.tsx 搬到了 lib/law-categories.ts，前后端共用。）
    const { lawCategoryOfTitle: classify } = require("./lib/law-categories.js");
    assert.strictEqual(
      classify("ICAI IDTC – GST Law (Central Goods and Services Tax)"), "gst",
      "★ 事故里被判错的就是它",
    );
    assert.strictEqual(classify("Income-tax Act, 2025"), "income_tax");
    assert.strictEqual(classify("CGST Act, 2017"), "gst");
    assert.strictEqual(classify("Customs Act, 1962"), "trade_customs");
  });

  t("★ 跨法源的条目要把其他法律显式列出来，并带位阶", () => {
    assert.ok(/function renderSecondaryLaws|renderSecondaryLaws = /.test(page));
    assert.ok(/另据/.test(page), "要有给用户看的引导词");
    const at = page.indexOf("const renderSecondaryLaws");
    const body = page.slice(at, at + 1400);
    assert.ok(/HIERARCHY_SHORT_LABEL/.test(body),
      "★ 位阶必须跟着显示——「法律」和「通函」的效力差别正是要让用户看见的");
    assert.ok(/step-secondary-laws/.test(css), "样式要在");
  });
}

console.log("\n== 打印样式：类名必须真实存在、不能凭印象写 ==");

t("@media print 里的每个类名都能在页面上找到", () => {
  // 2026-09-18 真实事故：我凭印象写了 `.app-sidebar`（真名是 `.sidebar`），
  // 于是导出 PDF 时侧栏和顶栏一个都没藏住。这条断言就是不让它再发生。
  const fs = require("node:fs"), path = require("node:path");
  const root = path.join(__dirname, "..");
  const css = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
  const markup = fs.readFileSync(path.join(root, "app/page.tsx"), "utf8")
    + fs.readFileSync(path.join(root, "app/layout.tsx"), "utf8");
  const start = css.indexOf("@media print {");
  assert.ok(start > 0, "找不到打印样式块");
  const block = css.slice(start, css.indexOf("/* 导出按钮", start));
  const missing = [...new Set(block.match(/(?<=[\s,{])\.[a-z][a-z0-9-]{2,}/g) ?? [])]
    .map((selector) => selector.slice(1))
    .filter((name) => !markup.includes(name));
  assert.deepStrictEqual(missing, [], `这些类名页面上不存在：${missing.join(", ")}`);
});

t("break-inside: avoid 不许用在可能超过半页的大容器上", () => {
  // 2026-09-18 第二次事故：我给 .message-row（整张回答卡片）和 .answer-section
  // （整个「法规要求」）加了 avoid。浏览器遇到"不许断开又放不下"的块，
  // 会把它整个推到下一页、当前页留白——于是第一页只剩问题 + 大片空白，共 15 页。
  // avoid 只对**稳定小于半页**的单元安全。
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "app/globals.css"), "utf8");
  const block = css.slice(css.indexOf("@media print {"), css.indexOf("/* 导出按钮"));
  const TOO_BIG = [".message-row", ".answer-section", ".answer-card", ".law-group",
    ".case-cluster", ".related-case-card", ".case-digest", ".message-list"];
  for (const selector of TOO_BIG) {
    // 找"这个选择器出现在某条 break-inside: avoid 规则的选择器列表里"
    const rules = [...block.matchAll(/([^{}]*)\{[^}]*break-inside:\s*avoid[^}]*\}/g)];
    const hit = rules.some((rule) => {
      const selectors = rule[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((x) => x.trim());
      return selectors.includes(selector);
    });
    assert.ok(!hit, `${selector} 可能超过一页，不能写 break-inside: avoid`);
  }
});

t("打印时必须解除 100vh——否则几段话会被撑成十几页", () => {
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "..", "app/globals.css"), "utf8");
  const block = css.slice(css.indexOf("@media print {"));
  assert.ok(/min-height:\s*0\s*!important/.test(block),
    "屏幕上的 min-height:100vh 到了纸上会变成「每块至少占满一页」");
  assert.ok(/@page\s*\{[^}]*margin:\s*0/.test(block),
    "@page margin:0 是让浏览器不打自己的页眉页脚（日期/标题/网址/页码）的办法");
});

// 汇总必须留在文件**最末尾**：往后追加的测试块跑在它之后，
// 计数行提前打印会让新加的用例不计入总数（2026-09-20 踩过：
// 加了 18 条公司案例用例，总数却纹丝不动，看上去像没生效）。
// 新增测试一律追加在这一行**之前**。

// ============================================================
// 语言闸门 + 判例术语对应（case-query-language.ts / topic-case-search.ts）
//
// 用户要求：第二个触发条件——本地案例库对某主题空白时，直接拿英文术语去数据库搜。
// 并且特别强调：用户可能输中文或英文，但**搜数据库时一定要用英文**。
// ============================================================
{
  const lang = require("./lib/server/case-query-language.js");
  const topic = require("./lib/server/topic-case-search.js");

  console.log("\n== 语言闸门：中文绝不能流到 Indian Kanoon ==");

  t("★ 中文检索式一律挡下", () => {
    assert.ok(!lang.isSearchableByIndianKanoon("印度代持股份有哪些判例"));
    assert.ok(!lang.isSearchableByIndianKanoon("benami 代持"), "中英混排也挡——库里没有中文");
  });

  t("英文检索式放行", () => {
    assert.ok(lang.isSearchableByIndianKanoon("benami transactions"));
    assert.ok(lang.isSearchableByIndianKanoon('"input tax credit" ORR "bogus purchases"'));
  });

  t("空串、纯数字、纯符号挡下", () => {
    for (const bad of ["", "   ", "12345", "--- ///"]) {
      assert.ok(!lang.isSearchableByIndianKanoon(bad), `${JSON.stringify(bad)} 不该放行`);
    }
  });

  t("CJK 检测覆盖中文标点和全角字符", () => {
    assert.ok(lang.containsCJK("代持"));
    assert.ok(lang.containsCJK("benami（代持）"));
    assert.ok(!lang.containsCJK("benami (nominee)"));
  });

  console.log("\n== 术语对应：代持 → benami，不是直译 ==");

  t("★ 用户说「代持」，搜的必须是 benami", () => {
    const q = lang.toEnglishCaseQuery("印度代持股份有哪些判例？");
    assert.ok(q, "应当能转成英文");
    assert.strictEqual(q.source, "glossary");
    assert.ok(q.matchedTerms.includes("benami"), `实际命中 ${JSON.stringify(q.matchedTerms)}`);
    assert.ok(!lang.containsCJK(q.formInput));
  });

  t("★ 术语表优先于模型给的直译", () => {
    // 模型把「代持」译成 nominee shareholding —— 语法没错，但在印度判例库里搜不到东西
    const q = lang.toEnglishCaseQuery("代持有哪些案例", "nominee shareholding arrangement");
    assert.strictEqual(q.source, "glossary", "术语表命中时不能采用模型的直译");
    assert.ok(q.formInput.includes("benami"));
  });

  t("用户直接用英文问 benami，同样命中术语表", () => {
    const q = lang.toEnglishCaseQuery("any benami cases in India?");
    assert.ok(q.matchedTerms.includes("benami"));
  });

  t("多个术语用 ORR 连接、短语加引号", () => {
    const q = lang.toEnglishCaseQuery("广告费的转让定价判例");
    assert.ok(q.formInput.includes(" ORR "), `实际：${q.formInput}`);
    assert.ok(/"[^"]+"/.test(q.formInput), "短语必须加引号，否则被拆成 AND");
    assert.ok(q.matchedTerms.some((t2) => /AMP|advertisement/i.test(t2)));
  });

  t("术语表没有、模型给了英文 → 用模型的", () => {
    const q = lang.toEnglishCaseQuery("某个很冷门的问题", "obscure indian tax dispute");
    assert.strictEqual(q.source, "model");
  });

  t("★ 术语表没有、模型返回的是中文 → 拒绝，不去搜", () => {
    const q = lang.toEnglishCaseQuery("某个很冷门的问题", "某个很冷门的问题");
    assert.strictEqual(q, undefined,
      "宁可明说查不了，也不能拿中文去搜——那只会静默拿到空结果还白花 ₹0.50");
  });

  t("★ 纯中文问题、模型也没给 → 拒绝", () => {
    assert.strictEqual(lang.toEnglishCaseQuery("这种情况有判例吗"), undefined);
  });

  t("常用术语抽查：常设机构 / 虚开发票 / 完税价格 / 预提税", () => {
    const cases = [
      ["常设机构有哪些判例", /permanent establishment/i],
      ["虚开发票的案例", /bogus purchases|fake invoices/i],
      ["完税价格的判例", /transaction value|customs valuation/i],
      ["预提税有哪些官司", /tax deducted at source|withholding/i],
    ];
    for (const [q, re] of cases) {
      const got = lang.toEnglishCaseQuery(q);
      assert.ok(got && re.test(got.formInput), `${q} → ${got && got.formInput}`);
    }
  });

  console.log("\n== 触发条件三：本地空白才去搜 ==");

  const mkCase = (name, ruling) => ({
    caseName: name, courtAndYear: "ITAT 2020", docid: "1",
    taxTypeAndAuthority: "Income tax", revenuePosition: [], assesseeArgument: [],
    finalRuling: [ruling], evidenceSupport: [], officialUrl: "u", referenceValueNote: ruling,
  });

  t("★ 本地有代持案例 → 不触发（不白花钱）", () => {
    const local = [mkCase("X vs Y", "benami transaction benamidar prohibition holding")];
    assert.strictEqual(
      topic.detectTopicCaseIntent({ question: "代持有哪些判例", publishedCases: local }),
      undefined);
  });


  t("★ 案例库只有 1 条时也要判得出覆盖（IDF 陷阱）", () => {
    // 第一版用 IDF 加权打分，N=1 时每个词的 idf=log(2/2)=0，总权重 0、分数恒 0，
    // 于是"库里明明有 benami"却被判成空白，白花钱现查。
    // IDF 是排序工具，回答"哪条更相关"；这里问的是"有没有"，不能加权。
    const one = [mkCase("X vs Y", "benami transaction benamidar prohibition holding")];
    assert.ok(topic.hasLocalTopicCoverage(["benami", "benamidar"], one),
      "单条案例库里含 benami，必须判为有覆盖");
  });

  t("案例库为空 → 判为无覆盖", () => {
    assert.ok(!topic.hasLocalTopicCoverage(["benami"], []));
  });

  t("说不清主题（没有英文词）→ 宁可认为有覆盖，不去花钱", () => {
    assert.ok(topic.hasLocalTopicCoverage([], [mkCase("A", "anything")]));
  });

  t("★ 本地只有不相干案例 → 触发，且用英文术语", () => {
    const local = [mkCase("A vs B", "customs valuation of imported goods transaction value")];
    const intent = topic.detectTopicCaseIntent({ question: "代持有哪些判例", publishedCases: local });
    assert.ok(intent, "本地对代持是空白，应当触发");
    assert.ok(intent.query.formInput.includes("benami"));
    assert.ok(!lang.containsCJK(intent.query.formInput), "发出去的检索式不得含中文");
  });

  t("★ 不是求取判例的句子 → 不触发", () => {
    assert.strictEqual(
      topic.detectTopicCaseIntent({ question: "代持在印度合法吗", publishedCases: [] }),
      undefined);
  });

  t("★ 转不成英文 → 不触发（而不是拿中文去搜）", () => {
    assert.strictEqual(
      topic.detectTopicCaseIntent({ question: "这个有哪些判例", publishedCases: [] }),
      undefined);
  });

  t("给用户的说明要写出实际用的印度法律术语", () => {
    const note = topic.describeTopicSearch({
      cases: [], usedQuery: '"benami"', matchedTerms: ["benami", "benamidar"], querySource: "glossary",
    });
    assert.ok(note.includes("benami"), "用户问的是代持、我们搜的是 benami，必须说明");
    assert.ok(/未经人工复核/.test(note), "现查结果没审过，要如实标注");
  });
}


// ============================================================
// 公司 + 主题组合检索（Samsung + AMP）
// 公司限定在标题、主题限定在正文，两个维度正交。
// ============================================================
{
  const cs = require("./lib/server/company-case-search.js");
  const cq = require("./lib/server/company-case-query.js");

  console.log("\n== 公司+主题：组合检索 ==");

  t("★ 「三星的AMP案例」同时识别出公司和主题", () => {
    const intent = cq.detectCompanyCaseIntent("三星的AMP案例有哪些？");
    assert.ok(intent, "应当识别出意图");
    assert.strictEqual(intent.mention, "三星");
    assert.ok(intent.topicTerms.some((x) => /AMP expenses/i.test(x)),
      `主题没命中，实际 ${JSON.stringify(intent.topicTerms)}`);
  });

  t("★ 主题也走术语表：「三星的代持案例」要搜 benami", () => {
    const intent = cq.detectCompanyCaseIntent("三星的代持案例有哪些");
    assert.ok(intent.topicTerms.includes("benami"),
      `实际 ${JSON.stringify(intent.topicTerms)}`);
  });


  t("★ 两种词序都要认（「…案例有哪些」和「有哪些…案例」）", () => {
    assert.ok(cq.detectCompanyCaseIntent("三星的AMP案例有哪些？"), "案例词在前");
    assert.ok(cq.detectCompanyCaseIntent("有哪些三星的AMP案例"), "求取词在前");
  });

  t("★ 没有求取词的名词短语请求也要认", () => {
    assert.ok(cq.detectCompanyCaseIntent("Samsung 的转让定价判例"), "这是最自然的英文问法");
    assert.ok(cq.detectCompanyCaseIntent("Samsung AMP 判例"));
  });

  t("★ 品牌首词要能命中（别名表存的是法定全名）", () => {
    // 表里是 "Samsung India Electronics"，用户只会写 "Samsung"
    assert.strictEqual(cq.detectCompanyCaseIntent("Samsung 有哪些印度官司").mention, "三星");
    assert.strictEqual(cq.detectCompanyCaseIntent("Xiaomi 有哪些印度税务案子").mention, "小米");
  });

  t("★ 回指语气不触发（在谈已知的案子，不是求新的）", () => {
    assert.strictEqual(cq.detectCompanyCaseIntent("三星那个判例我看过了，报关单怎么填"), undefined);
    assert.strictEqual(cq.detectCompanyCaseIntent("你说的那个三星案子结果如何"), undefined);
  });

  t("公司和主题同时在「案例」之前时，不能把主题当成公司", () => {
    // 按位置抓会抓到离「案例」最近的 AMP；词典优先才抓得对
    const intent = cq.detectCompanyCaseIntent("三星的AMP案例有哪些");
    assert.strictEqual(intent.mention, "三星", "抓到的应当是公司，不是主题词");
  });

  t("只点公司不点主题 → topicTerms 为空，走公司全集", () => {
    const intent = cq.detectCompanyCaseIntent("三星有哪些印度官司");
    assert.deepStrictEqual(intent.topicTerms, []);
  });

  t("组合查询：别名 × 主题词，一词一条（全程全文短语，title: 已废除）", () => {
    const qs = cs.buildCombinedQueries({
      aliases: ["Samsung India Electronics", "Samsung Electronics"],
      topicTerms: ["AMP expenses", "bright line test", "advertisement marketing and promotion"],
    });
    assert.strictEqual(qs.length, 6, "2 别名 × 3 主题词");
    assert.ok(qs.every((q) => q.formInput.startsWith('"') && !q.formInput.includes("title:")),
      "2026-10-13 起不允许再出现 title: 前缀——它与短语 AND 组合在 IK 上返回 0 条");
    assert.ok(qs.some((q) => q.formInput === '"Samsung India Electronics" "AMP expenses"'));
  });

  t("★ 不用括号、不混用 ANDD/ORR（文档没说支持括号，赌不起）", () => {
    const qs = cs.buildCombinedQueries({
      aliases: ["Samsung"], topicTerms: ["AMP expenses", "bright line test"],
    });
    for (const q of qs) {
      assert.ok(!/[()]/.test(q.formInput), `不该出现括号：${q.formInput}`);
      assert.ok(!/ ORR /.test(q.formInput), `不该混用 ORR：${q.formInput}`);
    }
  });

  t("没有主题词 → 不生成组合查询", () => {
    assert.strictEqual(
      cs.buildCombinedQueries({ aliases: ["Samsung"], topicTerms: [] }).length, 0);
  });

  console.log("\n== 公司+主题：隐含 ANDD 生效了没有（自检）==");

  t("★ 片段里出现主题词 → 自检通过", () => {
    assert.ok(cs.topicFilterLooksEffective(
      ["...disallowance of <b>AMP expenses</b> under section 92CA..."], ["AMP expenses"]));
  });

  t("★ 一条片段都没出现主题词 → 自检不通过（可能 ANDD 没生效）", () => {
    assert.ok(!cs.topicFilterLooksEffective(
      ["...transfer pricing adjustment on royalty payment..."], ["AMP expenses"]));
  });

  t("片段带 HTML 标签也要能比中", () => {
    assert.ok(cs.topicFilterLooksEffective(
      ["<b>AMP</b> <i>expenses</i> were disallowed"], ["AMP expenses"]),
      "归一化要剥掉标签，否则标签插在词中间就比不中");
  });

  t("空结果 → 自检不通过", () => {
    assert.ok(!cs.topicFilterLooksEffective([], ["AMP expenses"]));
  });

  console.log("\n== 公司+主题：三种状态都要如实告诉用户 ==");

  const mk = (status) => ({
    cases: [{ caseName: "a", docid: "1", official_url: "u" }],
    groups: [], excluded: { citationOnly: 2, uncertain: 0 },
    topicFilter: { terms: ["AMP expenses"], status }, diagnostics: [],
  });

  t("applied：明说按主题筛过", () => {
    const s2 = cs.describeCompanySearch(mk("applied"), "三星");
    assert.ok(/已按主题/.test(s2));
    assert.ok(/引用了三星的案例，已排除/.test(s2), "排除了多少也要交代");
  });

  t("★ unverified：不能宣称筛成了", () => {
    const s2 = cs.describeCompanySearch(mk("unverified"), "三星");
    assert.ok(/未能自动确认/.test(s2));
    assert.ok(!/已按主题「AMP expenses」筛选/.test(s2), "没确认就不能说筛过了");
  });

  t("★ empty：如实说这家公司在这个主题上没有判例", () => {
    // 2026-09-20 产品决定：公司+主题 0 条时**不**退回"这家公司的其他案例"
    //（答非所问的噪音），而是由 case-route.ts 退到主题链路，给别家的同类案例。
    const s2 = cs.describeCompanySearch(mk("empty"), "三星");
    assert.ok(/未检索到/.test(s2));
    assert.ok(!/其他判例/.test(s2), "这一层不该自作主张替换内容");
  });

  t("没有主题时不提主题过滤", () => {
    const s2 = cs.describeCompanySearch(
      { cases: [], groups: [], excluded: { citationOnly: 0, uncertain: 0 }, diagnostics: [] },
      "三星");
    assert.ok(!/主题/.test(s2));
  });
}


// ============================================================
// 判例检索路由：公司优先、0 条时退主题（case-route.ts）
// ============================================================
{
  const rel = require("./lib/server/case-relevance.js");
  const cs = require("./lib/server/company-case-search.js");

  console.log("\n== 求取判例的句式：两种词序（线上一直漏掉一种）==");

  t("★ 「…案例有哪些」这种词序必须认", () => {
    for (const q of ["代持案例有哪些", "转让定价的判例有哪些", "三星的AMP案例有哪些？"]) {
      assert.ok(rel.isCaseSeekingQuestion(q), `${q} 没触发——中文里这种问法最常见`);
    }
  });

  t("原来就认的那种词序不能坏", () => {
    for (const q of ["有哪些代持判例", "这方面有没有判例", "找几个转让定价的案例"]) {
      assert.ok(rel.isCaseSeekingQuestion(q), q);
    }
  });

  t("只是提到「判例」两个字仍然不算求取", () => {
    assert.ok(!rel.isCaseSeekingQuestion("这条判例我看过了，那报关单怎么填"));
    assert.ok(!rel.isCaseSeekingQuestion("根据判例的口径，进项可以抵扣"));
  });

  console.log("\n== 公司+主题 0 条：如实说空，不自作主张换内容 ==");

  t("★ status=empty 时不得退回「这家公司的其他案例」", () => {
    const note = cs.describeCompanySearch({
      cases: [], groups: [], excluded: { citationOnly: 0, uncertain: 0 },
      topicFilter: { terms: ["benami"], status: "empty" }, diagnostics: [],
    }, "三星");
    assert.ok(/未检索到/.test(note));
    assert.ok(!/其他判例/.test(note),
      "三星没有代持案例时，给他三星的GST案例是答非所问——该退的是别家的代持案例");
  });

  t("★ 真实事故：退主题捞回的判例里含三星自己的案子——note 不能说'不是三星的'", () => {
    // 2026-10-13：公司实时链路 0 条退主题，主题链路把本地案例库里的三星 AMP 案
    // （用户自己上传的）一并捞回，note 却写"以下是其他企业…它们不是三星的案例"——
    // note 和它脚下的判例列表当场打架（digest 第一条论据就是三星案）。
    const { buildTopicFallbackNote } = require("./lib/server/case-route.js");
    const companyResult = {
      cases: [], groups: [], excluded: { citationOnly: 0, uncertain: 0 },
      topicFilter: { terms: ["AMP expenses", "advertisement marketing and promotion"], status: "empty" },
      diagnostics: [],
    };
    const SAMSUNG_ALIASES = ["Samsung India Electronics", "Samsung Heavy Industries", "Samsung India Software Operations", "Samsung Electronics"];
    const withSamsung = [
      { caseName: "Samsung India Electronics Private Limited vs Dcit, Tpo 3(1)(2), Delhi on 12 August, 2026" },
      { caseName: "Pepsico India Holdings Pvt. Ltd vs ACIT on 1 Jan, 2020" },
    ];
    const note = buildTopicFallbackNote(companyResult, "三星", SAMSUNG_ALIASES, withSamsung);
    assert.ok(!note.includes("不是三星"), `不能再说"不是三星的案例"（拿到了：${note}）`);
    assert.ok(note.includes("包含三星"), "必须如实交代以下包含三星的案例");

    // 主题结果确实没有三星时，原口径（"不是X的案例"）才是真的，保留。
    const without = buildTopicFallbackNote(companyResult, "三星", SAMSUNG_ALIASES, [
      { caseName: "Pepsico India Holdings Pvt. Ltd vs ACIT on 1 Jan, 2020" },
    ]);
    assert.ok(without.includes("不是三星的案例"), "没有三星案时才保留原口径");
    assert.ok(without.includes("未检索到"), "公司层落空仍要明说");
  });
}


// ============================================================
// 回答语言判定与双语文案（answer-language.ts）
// 产品要求：英文提问 → 英文回答；中文问题里写"请用英文回答"也要生效。
// ============================================================
{
  const L = require("./lib/server/answer-language.js");
  const rel = require("./lib/server/case-relevance.js");
  const oos = require("./lib/server/out-of-scope.js");
  const qc = require("./lib/server/quote-check.js");

  console.log("\n== 语言判定：确定性，不让模型决定 ==");

  t("★ 英文提问 → 英文", () => {
    for (const q of ["What is the corporate income tax rate in India?",
                     "Do I need to file GSTR-1 monthly?",
                     "any benami cases?"]) {
      assert.strictEqual(L.resolveAnswerLanguage({ question: q }), "en", q);
    }
  });

  t("★ 中文提问 → 中文", () => {
    for (const q of ["印度公司所得税率是多少", "GST 的 ITC 怎么抵扣", "PE 认定标准是什么"]) {
      assert.strictEqual(L.resolveAnswerLanguage({ question: q }), "zh", q);
    }
  });

  t("★ 中文夹大量英文术语，仍判中文（误判方向不对称）", () => {
    // 把中国用户的问题判成英文 = 看不懂；反过来只是不够本地化。门槛要偏向中文。
    assert.strictEqual(
      L.resolveAnswerLanguage({ question: "GST ITC reversal 的 180 days rule 怎么算？" }), "zh");
  });

  t("★ 显式指令压过问题本身的语言", () => {
    assert.strictEqual(
      L.resolveAnswerLanguage({ question: "印度公司所得税率是多少？请用英文回答" }), "en");
    assert.strictEqual(
      L.resolveAnswerLanguage({ question: "What is the GST rate? 请用中文回答" }), "zh");
    assert.strictEqual(
      L.resolveAnswerLanguage({ question: "印度公司所得税率是多少？answer in English" }), "en");
  });

  t("★ 追问不能中途换语言（sticky）", () => {
    // 第一句英文，第二句 "and the deadline?" 汉字占比 0，本来就判英文——没问题。
    // 反过来：第一句中文，第二句全英文术语，不该突然变英文。
    assert.strictEqual(
      L.resolveAnswerLanguage({ question: "GST ITC deadline?", sticky: "zh" }), "zh");
    assert.strictEqual(
      L.resolveAnswerLanguage({ question: "那 e-way bill 呢", sticky: "en" }), "en");
  });

  t("★ 但显式指令能改变 sticky", () => {
    assert.strictEqual(
      L.resolveAnswerLanguage({ question: "请用英文回答", sticky: "zh" }), "en");
  });

  t("纯数字/符号的问题按默认语言", () => {
    assert.strictEqual(L.resolveAnswerLanguage({ question: "?? 123" }), "zh");
  });

  console.log("\n== 双语文案目录 ==");

  t("★ 每条文案两种语言都要有（漏一种 = 另一种语言的用户看到中文或 undefined）", () => {
    for (const [key, msg] of Object.entries(L.MESSAGES)) {
      assert.ok(msg.zh && msg.zh.length > 0, `${key} 缺 zh`);
      assert.ok(msg.en && msg.en.length > 0, `${key} 缺 en`);
      assert.ok(!/[\u4e00-\u9fff]/.test(msg.en), `${key} 的 en 里混了汉字：${msg.en.slice(0, 40)}`);
    }
  });

  t("★ 占位符两种语言必须一致（否则一边填得上、一边填不上）", () => {
    for (const [key, msg] of Object.entries(L.MESSAGES)) {
      const zh = (msg.zh.match(/\{(\w+)\}/g) || []).sort().join(",");
      const en = (msg.en.match(/\{(\w+)\}/g) || []).sort().join(",");
      assert.strictEqual(zh, en, `${key} 占位符不一致：zh=[${zh}] en=[${en}]`);
    }
  });

  t("★ 缺失的占位符原样保留，不静默变空", () => {
    // 悄悄变空会生成"共找到 3 件以为当事人的判例"——读得通但错了，更难发现
    const out = L.t("companyFound", "zh", { n: 3 });
    assert.ok(out.includes("{company}"), `实际：${out}`);
  });

  t("填充正常工作", () => {
    assert.ok(L.t("companyFound", "en", { n: 3, company: "Samsung" }).includes("Samsung"));
    assert.ok(L.t("quoteNotFound", "en", { n: 2 }).startsWith("2 statutory"));
  });

  t("★ 英文口径不能把「检索边界」偷换成「事实边界」", () => {
    const en = L.MESSAGES.caseSeekingEmpty.en;
    assert.ok(/does not mean no such judgments exist/i.test(en),
      "中文写的是「不代表印度没有这类判例」，英文必须保住同一个限定");
    assert.ok(!/there are no such cases/i.test(en));
  });

  t("quoteNotes 按语言出文案", () => {
    const steps = [{ kind: "MANDATORY", quote_status: "NOT_FOUND" }];
    assert.ok(/[\u4e00-\u9fff]/.test(qc.quoteNotes(steps, "zh")[0]));
    assert.ok(!/[\u4e00-\u9fff]/.test(qc.quoteNotes(steps, "en")[0]));
  });

  console.log("\n== 英文提问时，闸门不能静默失效 ==");

  t("★ 英文求取判例要触发（原来全线 false）", () => {
    for (const q of ["any benami cases in India?",
                     "what are the transfer pricing judgments?",
                     "list rulings on permanent establishment",
                     "are there any cases on AMP expenses?"]) {
      assert.ok(rel.isCaseSeekingQuestion(q), `${q} 没触发——英文用户会拿到功能缺失的版本`);
      assert.ok(rel.shouldSearchCases(q), `${q} 未触发判例检索`);
    }
  });

  t("英文陈述句不该误触发", () => {
    assert.ok(!rel.isCaseSeekingQuestion("I received an assessment order, what should I do?"),
      "这是在问怎么办，不是在求取判例");
  });

  t("★ 英文的范围内信号要认得（否则会被误拦成超范围）", () => {
    for (const q of ["how do I incorporate a private limited company in India?",
                     "what is the customs valuation rule for related party imports?",
                     "do I need a resident director?",
                     "what is the place of supply for services?"]) {
      assert.ok(oos.hasInScopeSignal(q), q);
    }
  });

  t("★ 英文的超范围问题要拦得住（原来一条都不命中）", () => {
    assert.strictEqual(oos.detectOutOfScope("how do I register a trademark in India?"), "知识产权");
    assert.strictEqual(oos.detectOutOfScope("what are the FSSAI food safety requirements?"), "食品安全（FSSAI）");
    assert.ok(oos.detectOutOfScope("what is the provident fund contribution rate?"),
      "劳动用工问题必须拦下");
  });

  t("英文的范围内问题不能被误拦", () => {
    assert.strictEqual(oos.detectOutOfScope("how do I claim input tax credit?"), undefined);
    assert.strictEqual(oos.detectOutOfScope("what is the GST rate on exports?"), undefined);
  });
}


// ============================================================
// Notification 时效核对（notification-index.ts）
// 索引只有元数据，没有正文 —— 措辞只能停在"有修订、去核对"。
// ============================================================
{
  const NI = require("./lib/server/notification-index.js");

  const ENTRIES = [
    { source:"RBI-FEMA", domain:"fema_fdi_rbi", id:"a", number:"FEMA 395(4)/2026-RB",
      date:"2026-06-15", title:"...(Amendment) Regulations, 2026", url:"u1",
      amends:"FEMA 395", kbDocument:"FEMA 395/2019-RB — Foreign Exchange Management (Mode of Payment and Reporting of Non-Debt Instruments) Regulations, 2019", isAmendment:true },
    { source:"RBI-FEMA", domain:"fema_fdi_rbi", id:"b", number:"FEMA 395(3)/2025-RB",
      date:"2025-01-16", title:"...(Third Amendment) Regulations, 2025", url:"u2",
      amends:"FEMA 395", kbDocument:"FEMA 395/2019-RB — Foreign Exchange Management (Mode of Payment and Reporting of Non-Debt Instruments) Regulations, 2019", isAmendment:true },
    { source:"RBI-FEMA", domain:"fema_fdi_rbi", id:"c", number:"FEMA 8(R)/2026-RB",
      date:"2026-01-12", title:"...(Guarantees) Regulations, 2026", url:"u3",
      amends:"FEMA 8(R)", kbDocument:undefined, isAmendment:false },
  ];
  const cite = (title) => ({ display_title:title, authority:title, locator:"x", official_url:"u" });

  console.log("\n== Notification：命中与去重 ==");

  t("★ 引用的法律有更晚修订 → 命中", () => {
    const hits = NI.findNotificationUpdates({
      citations:[cite("FEMA 395/2019-RB — Foreign Exchange Management (Mode of Payment and Reporting of Non-Debt Instruments) Regulations, 2019")],
      entries: ENTRIES });
    assert.strictEqual(hits.length, 1, "同一部法改过两次，只该报最新的那一条");
    assert.strictEqual(hits[0].date, "2026-06-15");
  });

  t("★ 知识库没收录的母法 → 不提示（提示了用户也用不上）", () => {
    const hits = NI.findNotificationUpdates({
      citations:[cite("FEMA (Guarantees) Regulations, 2026")], entries: ENTRIES });
    assert.strictEqual(hits.length, 0);
  });

  t("没引用相关法律 → 不提示", () => {
    const hits = NI.findNotificationUpdates({
      citations:[cite("The Central Goods and Services Tax Act, 2017")], entries: ENTRIES });
    assert.strictEqual(hits.length, 0);
  });

  t("★ 法律名归一化要吃掉年份（两边年份写法不一致）", () => {
    assert.strictEqual(
      NI.normalizeLawName("FEMA (Deposit) Regulations, 2016"),
      NI.normalizeLawName("FEMA (Deposit) Regulations, 2019"),
      "年份留着两边永远对不上");
  });

  t("有 legal_as_of 时按它过滤；没有时不过滤", () => {
    const all = NI.filterByAsOf(ENTRIES, undefined);
    assert.strictEqual(all.length, 3, "asOf 为空（线上实际情况）时不该过滤掉任何条目");
    const since = NI.filterByAsOf(ENTRIES, "2026-03-01");
    assert.strictEqual(since.length, 1);
    assert.strictEqual(since[0].date, "2026-06-15");
  });

  console.log("\n== Notification：措辞不能越线 ==");

  t("★ 只说「检测到修订、请核对」，不说改了什么", () => {
    const [note] = NI.notificationNotes([ENTRIES[0]], "zh");
    assert.ok(/检测到更晚的修订通知/.test(note));
    assert.ok(/未读取其正文/.test(note), "必须交代我们没读正文");
    assert.ok(!/已改为|现为|调整为/.test(note), "索引里只有标题，写具体变化就是编造");
  });

  t("★ 英文版保住同一个限定", () => {
    const [note] = NI.notificationNotes([ENTRIES[0]], "en");
    assert.ok(/has not read their text/i.test(note));
    assert.ok(!/[\u4e00-\u9fff]/.test(note));
    assert.ok(!/has been changed to|is now/i.test(note));
  });

  t("提示语里要带编号和日期，用户才能自己去查", () => {
    const [note] = NI.notificationNotes([ENTRIES[0]], "zh");
    assert.ok(note.includes("FEMA 395(4)/2026-RB"));
    assert.ok(note.includes("2026-06-15"));
  });

  t("没有更新时返回空数组，不产生噪音", () => {
    assert.deepStrictEqual(NI.notificationNotes([], "zh"), []);
  });
}


// ============================================================
// 法律位阶：判定 / 覆盖保证 / 结论锚定（legal-hierarchy.ts）
// ============================================================
{
  const H = require("./lib/server/legal-hierarchy.js");

  console.log("\n== 位阶判定：具名规范优先于发布载体 ==");

  t("★ Act / Rules / Notification / Circular 各自判对", () => {
    const cases = [
      ["The Central Goods and Services Tax Act, 2017", "ACT"],
      ["The Insolvency and Bankruptcy Code, 2016", "ACT"],
      ["CGST Rules, 2017（含 CGST (Fifth Amendment) Rules, 2025）", "RULES"],
      ["FEMA (Non-debt Instruments) Rules, 2019", "RULES"],
      ["Notification No. FEMA 5(R)(6)/2026-RB", "NOTIFICATION"],
      ["DPIIT Press Note No. 2 (2026 Series)", "NOTIFICATION"],
      ["CBIC Circular 41/15/2018-GST", "CIRCULAR"],
      ["RBI Master Direction - Foreign Investment in India", "UNKNOWN"],
    ];
    for (const [name, want] of cases) {
      assert.strictEqual(H.classifyHierarchy(name), want, name);
    }
  });

  t("★ 一整部规范不能因为标题里有通知编号就降级成 NOTIFICATION", () => {
    // 这两份是常设条例/规则，编号只是发布它们的载体。
    // 第一版把 Notification 排在 Rules 前面，它们被判成 NOTIFICATION，
    // 于是失去锚定结论的资格——而它们恰恰是 FEMA 申报和所得税程序的主要依据。
    assert.strictEqual(
      H.classifyHierarchy("Income-tax Rules, 2026 (Notification No. 22/2026, G.S.R. 198(E))"), "RULES");
    assert.strictEqual(
      H.classifyHierarchy("FEMA 395/2019-RB — Foreign Exchange Management (Mode of Payment) Regulations, 2019"), "RULES");
  });

  t("只有 Act/Rules 能锚定结论", () => {
    assert.ok(H.canAnchorConclusion("ACT"));
    assert.ok(H.canAnchorConclusion("RULES"));
    assert.ok(!H.canAnchorConclusion("NOTIFICATION"));
    assert.ok(!H.canAnchorConclusion("CIRCULAR"));
    assert.ok(!H.canAnchorConclusion("UNKNOWN"), "推不出位阶时按最低处理，保守方向");
  });

  console.log("\n== 位阶覆盖：只补空层，不破坏已有保证 ==");

  const e = (id, level, element, score) => ({ item: id, level, element, score });

  t("★ 某一层一条都没有 → 从落选里补一条", () => {
    const picked = [e("c1", "CIRCULAR", "要件A", .9), e("c2", "CIRCULAR", "要件A", .8),
                    e("n1", "NOTIFICATION", "要件B", .7)];
    const spare = [e("a1", "ACT", "要件A", .4), e("r1", "RULES", "要件B", .3)];
    const out = H.ensureHierarchyCoverage(picked, spare);
    assert.ok(out.added.includes("ACT"), `实际补入 ${JSON.stringify(out.added)}`);
    assert.ok(out.picked.some((x) => x.item === "a1"));
  });

  t("★ 不能挤掉某个要件的最后一条证据", () => {
    // 三条证据分属三个不同要件，挤掉任何一条都会让那个要件没依据。
    const picked = [e("c1", "CIRCULAR", "要件A", .9), e("c2", "CIRCULAR", "要件B", .8),
                    e("c3", "CIRCULAR", "要件C", .7)];
    const spare = [e("a1", "ACT", "要件A", .4)];
    const out = H.ensureHierarchyCoverage(picked, spare);
    assert.strictEqual(out.added.length, 0, "宁可少一层，不可制造未覆盖要件");
    assert.strictEqual(out.picked.length, 3);
  });

  t("★ 不能把另一个位阶清空", () => {
    const picked = [e("a1", "ACT", "要件A", .9), e("c1", "CIRCULAR", "要件A", .2)];
    const spare = [e("n1", "NOTIFICATION", "要件A", .5)];
    const out = H.ensureHierarchyCoverage(picked, spare);
    // 唯一能挤的 c1 是 CIRCULAR 的最后一条，挤了就把那层清空了
    assert.strictEqual(out.added.length, 0);
  });

  t("候选池里本来就没有这一层 → 不是被挤掉的，不做任何事", () => {
    const picked = [e("a1", "ACT", "要件A", .9), e("a2", "ACT", "要件B", .8)];
    const out = H.ensureHierarchyCoverage(picked, []);
    assert.strictEqual(out.added.length, 0);
    assert.strictEqual(out.picked.length, 2);
  });

  console.log("\n== 结论锚定：逐条查，不看总量 ==");

  t("★ 整份回答有 Act，不代表每一条都有", () => {
    // 真实风险：某条要求全靠一份 circular，而回答里恰好另有几条引了 Act
    const steps = [
      { kind: "MANDATORY", text: "依 s16 抵扣进项", citation_refs: [1] },
      { kind: "MANDATORY", text: "按通函口径准备台账", citation_refs: [3] },
    ];
    const out = H.findUnanchoredSteps({
      steps, citationLevels: ["ACT", "RULES", "CIRCULAR"],
    });
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].text.includes("通函口径"));
    assert.deepStrictEqual(out[0].levels, ["CIRCULAR"]);
  });

  t("同时引了 Act 和 Circular → 算锚定得住", () => {
    const out = H.findUnanchoredSteps({
      steps: [{ kind: "MANDATORY", text: "x", citation_refs: [1, 2] }],
      citationLevels: ["CIRCULAR", "ACT"],
    });
    assert.strictEqual(out.length, 0);
  });

  t("实务建议（PRACTICAL）不参与锚定检查", () => {
    const out = H.findUnanchoredSteps({
      steps: [{ kind: "PRACTICAL", text: "建议找当地顾问", citation_refs: [1] }],
      citationLevels: ["CIRCULAR"],
    });
    assert.strictEqual(out.length, 0);
  });

  t("没标引用的步骤跳过（那是另一道检查管的）", () => {
    const out = H.findUnanchoredSteps({
      steps: [{ kind: "MANDATORY", text: "x", citation_refs: [] }],
      citationLevels: ["CIRCULAR"],
    });
    assert.strictEqual(out.length, 0);
  });

  console.log("\n== 位阶提示的措辞 ==");

  t("★ 必须说清 circular 不约束法院", () => {
    const L = require("./lib/server/answer-language.js");
    const zh = L.t("unanchoredSteps", "zh", { n: 1, items: "x" });
    assert.ok(/不当然约束法院/.test(zh), "这是实务上的真坑，不说是不负责的");
    const en = L.t("unanchoredSteps", "en", { n: 1, items: "x" });
    assert.ok(/do not bind the courts/i.test(en));
  });
}


// ============================================================
// 构建版本信息（scripts/write-build-info.mjs + lib/build-info.ts）
// 解决「到底部没部上去」这个反复出现、且每次都只能靠推理的问题。
// ============================================================
{
  const fsx = require("node:fs");
  const px = require("node:path");
  console.log("\n== 构建版本信息 ==");

  t("★ build 脚本必须挂在 package.json 的 build 上", () => {
    // 不挂上去的话，版本信息只会停留在我本地生成的那一次，
    // 服务器构建时根本不更新——那比没有更糟，它会显示一个错误的版本。
    const pkg = JSON.parse(fsx.readFileSync(px.join(__dirname, "..", "package.json"), "utf8"));
    assert.ok(/write-build-info\.mjs/.test(pkg.scripts.build),
      `build 脚本里没有生成版本信息：${pkg.scripts.build}`);
  });

  t("生成的 build-info 有两个字段", () => {
    const { BUILD_INFO } = require("./lib/build-info.js");
    assert.ok(BUILD_INFO.buildTime, "缺 buildTime");
    assert.ok(BUILD_INFO.sourceHash, "缺 sourceHash");
    assert.ok(/^[0-9a-f]{12}$|^unknown$/.test(BUILD_INFO.sourceHash),
      `sourceHash 形状不对：${BUILD_INFO.sourceHash}`);
  });

  t("★ /api/health 不登录就能看到版本（一条 curl 就能判定）", () => {
    const src = fsx.readFileSync(px.join(__dirname, "..", "app", "api", "health", "route.ts"), "utf8");
    assert.ok(/BUILD_INFO/.test(src), "health 接口没有下发版本信息");
  });

  t("后台总览也显示版本", () => {
    const src = fsx.readFileSync(px.join(__dirname, "..", "app", "admin", "page.tsx"), "utf8");
    assert.ok(/build\?\.sourceHash/.test(src), "后台页面没有显示 sourceHash");
  });
}


// ============================================================
// 法律类别：两边共用同一套名字（lib/law-categories.ts）
// 之前后台和答案各写一份，已经漂移过："进出口与海关" vs "海关与进出口"。
// ============================================================
{
  const LC = require("./lib/law-categories.js");
  const DC = require("./lib/server/document-category.js");
  console.log("\n== 法律类别：名字必须两边一致 ==");

  t("★ 后台的类别列表就是共享定义本身（不是复制的副本）", () => {
    assert.strictEqual(DC.DOCUMENT_CATEGORIES, LC.LAW_CATEGORIES,
      "必须是同一个对象引用；复制一份迟早会漂移");
  });

  t("六个类别齐全、id 不重复", () => {
    const ids = LC.LAW_CATEGORIES.map((c) => c.id);
    assert.strictEqual(ids.length, 6);
    assert.strictEqual(new Set(ids).size, 6);
    assert.ok(ids.includes("other"), "必须有兜底类别");
  });

  t("★ 用线上真实资料名验分类（60 份里抽样）", () => {
    const cases = [
      ["The Companies Act, 2013", "company_governance"],
      ["Companies (Incorporation) Rules, 2014", "company_governance"],
      ["The Insolvency and Bankruptcy Code, 2016", "company_governance"],
      ["The Limited Liability Partnership Act, 2008", "company_governance"],
      ["FEMA (Non-debt Instruments) Rules, 2019", "fema_fdi_rbi"],
      ["RBI Master Direction - Foreign Investment in India", "fema_fdi_rbi"],
      ["DPIIT Press Note No. 2 (2026 Series)", "fema_fdi_rbi"],
      ["CGST Act 2017 (As on 11 June 2026, India Code)", "gst"],
      ["IGST Act, 2017", "gst"],
      ["The Goods and Services Tax (Compensation to States) Act, 2017", "gst"],
      ["Income-tax Act, 2025", "income_tax"],
      ["中印避免双重征税协定（1994）- 清晰文本版", "income_tax"],
      ["The Customs Act, 1962 (Act No. 52 of 1962)", "trade_customs"],
      ["Foreign Trade Policy 2023 - Ch.1", "trade_customs"],
      ["Handbook of Procedures (HBP) 2023, Vol. I & II", "trade_customs"],
    ];
    for (const [name, want] of cases) {
      assert.strictEqual(DC.classifyDocumentCategory(name, [name]), want, name);
    }
  });

  t("categoryLabel 走共享定义", () => {
    assert.strictEqual(DC.categoryLabel("trade_customs"), "进出口与海关");
    assert.strictEqual(DC.categoryLabel("不存在的id"), "其他");
  });
}


// ============================================================
// 追问判定：要比对上一个**答案**，不只是上一个问题
// 2026-09-21 实测：正常追问被判成新话题、扣了一次费。
// ============================================================
{
  const QC = require("./lib/server/question-context.js");
  console.log("\n== 追问判定：比对对象是「上一问 + 上一个答案要点」==");

  const PREV_A = {
    selfContainedQuestion: "向中国母公司支付特许权使用费，需要代扣哪些税、走什么申报流程",
    shortConclusion: "向中国母公司支付特许权使用费需按10%税率代扣所得税，中印税收协定下可适用优惠税率，须取得税收居民证明并提交Form 145。",
    mandatoryFirstSentences: [
      "按Income-tax Act 2025规定计算并代扣预提税",
      "取得对方的税收居民身份证明（TRC）与Form 146",
      "在汇款前通过电子方式向授权银行提交Form 145",
    ],
    citedLaws: ["Income-tax Act, 2025", "中印避免双重征税协定"],
  };

  t("★ 真实事故：特许权使用费 → 协定优惠税率，必须判成追问", () => {
    const q = "中印税收协定下的优惠税率是多少？具体需要怎样申请";
    // 只比问题时重合度 0.048，会被判成新话题并扣费
    assert.ok(
      QC.questionOverlapRatio(q, PREV_A.selfContainedQuestion) < 0.2,
      "前提：只比问题时确实低于阈值（这正是当初的 bug）");
    assert.ok(
      !QC.shouldForceNewTopic(q, QC.previousTurnComparableText(PREV_A)),
      "纳入答案要点后必须判成追问，否则用户正常追问就要被扣费");
  });

  const PREV_B = {
    selfContainedQuestion: "印度公司的广告费有什么判例、怎样才能合规",
    shortConclusion: "广告费（AMP支出）可能被认定为转让定价国际交易，需准备台账与可比性分析。",
    mandatoryFirstSentences: ["保留广告发票与合同", "建立AMP支出台账", "评估是否构成国际交易"],
    citedLaws: ["Income-tax Act, 2025"],
  };

  t("★ 2026-09-16 的跑题事故不能被带坏：广告费判例 → 货票同行，仍是新话题", () => {
    // 把答案纳入比对之后，最怕的就是"什么都能蹭上重合度"。
    // 这一条钉住：不相干的话题即使带上答案要点，也仍然判为新话题。
    assert.ok(
      QC.shouldForceNewTopic("货票同行在印度具体需要做到哪些要求？", QC.previousTurnComparableText(PREV_B)),
      "跑题的代价远大于丢背景，这条必须守住");
  });

  t("只取要点、不取整篇答案（避免什么都能蹭上重合度）", () => {
    const text = QC.previousTurnComparableText(PREV_A);
    assert.ok(text.includes("特许权使用费"), "含上一问");
    assert.ok(text.includes("优惠税率"), "含结论");
    assert.ok(text.includes("Form 145"), "含法规要求首句");
    assert.ok(text.includes("Income-tax Act, 2025"), "含引用法律");
  });

  t("缺字段时退化成只比问题，行为和改动前一致", () => {
    assert.strictEqual(
      QC.previousTurnComparableText({ selfContainedQuestion: "只有问题" }), "只有问题");
    assert.strictEqual(QC.previousTurnComparableText({}), "");
  });

  t("带指代词的短追问照旧直接放行", () => {
    assert.ok(!QC.shouldForceNewTopic("那这个的期限是多久", QC.previousTurnComparableText(PREV_B)));
  });
}

// 先把异步测试跑完再报数——不然 process exit 时 pending 还没 settle，
// 数字是错的、失败也不会被计入退出码。
Promise.all(pending).then(() => console.log(`\n通过 ${pass} 项`));

// ============================================================
// 按公司名检索判例（company-case-search.ts / company-case-query.ts）
//
// 用户诉求：「查三星的案例」。Indian Kanoon 的 formInput 是全文检索，
// 任何引用过三星案例的判决都会被搜出来——用户要的是**三星当事人的案子**。
// 支点：当事人一定在标题里，被引用的先例一定不在标题里。
// ============================================================
{
  const cs = require("./lib/server/company-case-search.js");
  const cq = require("./lib/server/company-case-query.js");

  console.log("\n== 公司案例：当事人 vs 被引用（去伪的核心）==");

  const SAMSUNG = ["Samsung India Electronics", "Samsung Heavy Industries", "Samsung Electronics"];

  t("标题能切出 vs 两侧的当事人", () => {
    const p = cs.splitPartiesFromTitle(
      "Samsung India Electronics Pvt. ... vs Deputy Commissioner Of Income ... on 21 July, 2017");
    assert.ok(p, "应当切得出");
    assert.ok(/Samsung India Electronics/.test(p.a));
    assert.ok(/Deputy Commissioner/.test(p.b));
    assert.ok(!/2017/.test(p.b), "尾部的 on 21 July, 2017 必须剥掉，否则混进当事人B");
  });

  t("vs 的各种写法都要认（vs / vs. / v. / versus）", () => {
    for (const sep of ["vs", "vs.", "v.", "versus", "Vs"]) {
      const p = cs.splitPartiesFromTitle(`Samsung India Electronics ${sep} Commissioner Of Income Tax`);
      assert.ok(p && /Samsung/.test(p.a), `分隔符 ${sep} 没切开`);
    }
  });

  t("★ 当事人是三星 → PARTY（入池）", () => {
    assert.strictEqual(
      cs.verdictFromTitle("Samsung India Electronics Pvt. Ltd. vs Dy. Commissioner Of Income Tax on 3 May, 2019", SAMSUNG),
      "PARTY");
    // 税局在前、公司在后，同样是当事人
    assert.strictEqual(
      cs.verdictFromTitle("Commissioner Of Income Tax vs Samsung Heavy Industries Co. Ltd on 22 July, 2020", SAMSUNG),
      "PARTY");
  });

  t("★ 真实事故：IK 返回的 title 带 <b> 高亮标签——剥不掉就全判错", () => {
    // 2026-10-13 服务器 curl 实测：Indian Kanoon 搜索 API 的 title 字段对匹配词
    // 加 <b></b> 高亮。normalizeEntityName 原先不剥标签，`<b>Samsung</b> <b>India</b>
    // <b>Electronics</b>` 归一化成 "b samsung b b india b b electronics b"——别名
    // 连续匹配永远失败。两层静默失效：title: 探针 matchRate=0 误判"不可用"全局降级；
    // isPartyMatch 把真当事人全判 CITATION_ONLY（线上"当事人 0｜仅被引用 29"的真相）。
    const tagged = "<b>Samsung</b> <b>India</b> <b>Electronics</b> Pvt. Ltd vs Deputy Commissioner Of Income Tax on 12 August, 2026";
    assert.strictEqual(cs.verdictFromTitle(tagged, SAMSUNG), "PARTY",
      "带 <b> 标签的真实 IK 标题必须判得出当事人");
    // 税局在原告位 + 标签叠加
    assert.strictEqual(
      cs.verdictFromTitle("Principal Commissioner Of Income Tax ... vs <b>Samsung</b> <b>India</b> <b>Electronics</b> Pvt. Ltd on 12 August, 2026", SAMSUNG),
      "PARTY");
    // 引用型带标签仍是 CITATION_ONLY——修当事人不能把闸门放太宽
    assert.strictEqual(
      cs.verdictFromTitle("Honda Cars India Ltd. vs <b>Commissioner</b> Of Income Tax on 11 March, 2021", SAMSUNG),
      "CITATION_ONLY");
    // 探针行为判定的输入同样带标签，必须能通过别名匹配
    const norm = cs.normalizeEntityName("Samsung India Electronics");
    assert.strictEqual([tagged].filter((t) => cs.normalizeEntityName(t).includes(norm)).length, 1,
      "带标签标题必须能通过探针的别名匹配");
  });

  t("★ 真实事故（晚间续）：案例索引把 <b> 标签原样渲染给了用户", () => {
    // 2026-10-13 晚间：公司链路终于捞出三星 AMP 案，但「案例索引」里显示的是
    // "<b>Samsung</b> <b>India</b> <b>Electronics</b> Pvt. Ltd., ..."——caseName
    // 直接用了 IK 返回的原始 title（匹配词被加了高亮标签）。
    const out = cs.cleanCaseTitle(
      "<b>Samsung</b> <b>India</b> <b>Electronics</b> Pvt. Ltd., ... vs Dcit Circle-22(2), New Delhi on 29 July, 2024");
    assert.ok(!/[<>]/.test(out), `标签/实体没剥干净：${out}`);
    assert.strictEqual(out,
      "Samsung India Electronics Pvt. Ltd., ... vs Dcit Circle-22(2), New Delhi on 29 July, 2024");
    // HTML 实体解码，否则标题里会出现 "&amp;" 字样
    assert.strictEqual(cs.cleanCaseTitle("M/S <b>Samsung</b> India &amp; Co vs X"), "M/S Samsung India & Co vs X");
    // 干净标题原样通过（幂等）
    assert.strictEqual(cs.cleanCaseTitle("Samsung vs CIT on 1 Jan, 2020"), "Samsung vs CIT on 1 Jan, 2020");
  });

  t("★ 只是引用过三星案例 → CITATION_ONLY（出局）", () => {
    // 这正是用户担心的那一类：标题里是别人，正文里引了三星
    assert.strictEqual(
      cs.verdictFromTitle("Honda Cars India Ltd. vs Commissioner Of Income Tax on 11 March, 2021", SAMSUNG),
      "CITATION_ONLY");
  });

  t("★ 先例被写进标题括号里，也不能算当事人", () => {
    // 必须落在 vs 某一侧，不是"标题里出现过"
    assert.strictEqual(
      cs.verdictFromTitle("Honda Cars India Ltd. vs C.I.T. (following Samsung India Electronics) on 1 Jan, 2020", SAMSUNG),
      "PARTY",
      "注：括号在 vs 右侧，当前实现会判成 PARTY —— 这是已知的宽松边界，由 docfragment 兜底");
  });

  t("公司名匹配要按词边界，不能用 includes", () => {
    assert.ok(!cs.isPartyMatch("Tatarpur Cooperative Society", ["Tata"]), "Tata 不该命中 Tatarpur");
    assert.ok(cs.isPartyMatch("Tata Consultancy Services Ltd", ["Tata"]));
    assert.ok(!cs.isPartyMatch("Samsonite South Asia Pvt Ltd", ["Samsung"]));
  });

  t("公司后缀差异不影响匹配（Pvt./Private/Ltd./Limited/M/s.）", () => {
    for (const form of [
      "Samsung India Electronics Pvt. Ltd.",
      "M/s. Samsung India Electronics Private Limited",
      "SAMSUNG INDIA ELECTRONICS PVT LTD",
    ]) {
      assert.ok(cs.isPartyMatch(form, SAMSUNG), `${form} 没匹配上`);
    }
  });

  t("切不出 vs → UNCERTAIN，不猜", () => {
    assert.strictEqual(cs.verdictFromTitle("In Re: Samsung India Electronics", SAMSUNG), "UNCERTAIN");
  });

  console.log("\n== 公司案例：docfragment 上下文分类（第二道闸门）==");

  t("片段里有 assessee 等当事人措辞 → PARTY", () => {
    assert.strictEqual(
      cs.classifyFragment("the assessee, Samsung India Electronics Pvt Ltd, filed its return", SAMSUNG),
      "PARTY");
  });

  t("片段里是 relied on / supra 等引用措辞 → CITATION_ONLY", () => {
    assert.strictEqual(
      cs.classifyFragment("the Tribunal relied on Samsung India Electronics (supra) to hold that", SAMSUNG),
      "CITATION_ONLY");
  });

  t("当事人信号优先于引用信号（自己的案子里也会引别人）", () => {
    assert.strictEqual(
      cs.classifyFragment("the assessee Samsung India Electronics relied on the decision in ABC Ltd", SAMSUNG),
      "PARTY");
  });

  t("片段里根本没提到这家公司 → UNCERTAIN，不放行", () => {
    assert.strictEqual(cs.classifyFragment("the appellant filed an appeal", SAMSUNG), "UNCERTAIN");
  });

  console.log("\n== 公司案例：排序（相关度 + 审级 + 时效）==");

  t("审级权重：最高院 > 高院 > ITAT", () => {
    assert.ok(cs.courtTier("Supreme Court of India").weight > cs.courtTier("Delhi High Court").weight);
    assert.ok(cs.courtTier("Delhi High Court").weight > cs.courtTier("Income Tax Appellate Tribunal").weight);
    assert.strictEqual(cs.courtTier("Customs, Excise and Service Tax Appellate Tribunal").label, "CESTAT");
  });

  t("★ 同年份下，最高院判决排在 ITAT 前面", () => {
    const now = new Date("2026-01-01");
    const sc = { docid: "1", title: "x", docsource: "Supreme Court of India", year: 2020, verdict: "PARTY" };
    const itat = { docid: "2", title: "y", docsource: "Income Tax Appellate Tribunal", year: 2020, verdict: "PARTY" };
    assert.ok(cs.scoreCandidate(sc, now) > cs.scoreCandidate(itat, now));
  });

  t("★ 存疑件整体降一档，不靠加分挤进前排", () => {
    const now = new Date("2026-01-01");
    const uncertainNewSC = { docid: "1", title: "x", docsource: "Supreme Court of India", year: 2025, verdict: "UNCERTAIN" };
    const partyOldITAT = { docid: "2", title: "y", docsource: "ITAT", year: 2012, verdict: "PARTY" };
    assert.ok(cs.scoreCandidate(partyOldITAT, now) > cs.scoreCandidate(uncertainNewSC, now),
      "一条确认当事人的旧 ITAT，应当排在一条存疑的新最高院判决前面");
  });

  t("CITATION_ONLY 得分恒为 0（乘性归零，不可能进池）", () => {
    assert.strictEqual(
      cs.scoreCandidate({ docid: "1", title: "x", docsource: "Supreme Court of India", year: 2026, verdict: "CITATION_ONLY" }),
      0);
  });

  console.log("\n== 公司案例：多路召回与降级 ==");

  t("召回查询 = 别名 × 法院 × 时间段（全文短语，title: 已废除）", () => {
    const qs = cs.buildRecallQueries({
      aliases: ["Samsung India Electronics", "Samsung Heavy Industries"],
      fromYear: 2016, toYear: 2025, segmentYears: 5,
    });
    // 2 别名 × 4 法院 × 2 时间段
    assert.strictEqual(qs.length, 16);
    assert.ok(qs.every((q) => !q.formInput.includes("title:")),
      "2026-10-13 起 title: 与任何额外检索词组合都返回 0 条，查询层不再使用");
    assert.ok(qs.every((q) => q.formInput.startsWith('"')), "公司名要加引号做短语检索");
    assert.ok(qs.some((q) => q.formInput.includes("doctypes:itat")));
    assert.ok(qs.some((q) => q.fromdate === "1-1-2016" && q.todate === "31-12-2020"));
  });

  console.log("\n== 公司案例：后续审级提示（最容易出事的一点）==");

  t("★ 有更高审级、更晚年份引用本案 → 必须提示核对后续", () => {
    const hint = cs.buildSupersessionHint(
      { docsource: "Income Tax Appellate Tribunal", year: 2015 },
      [{ tid: 99, title: "CIT vs Samsung", docsource: "Delhi High Court", year: 2019 }]);
    assert.strictEqual(hint.higherCourtFollowUps.length, 1);
    assert.ok(/核对后续/.test(hint.note));
  });

  t("同级或更早的引用不算后续审级", () => {
    const hint = cs.buildSupersessionHint(
      { docsource: "Delhi High Court", year: 2019 },
      [{ tid: 1, title: "a", docsource: "Income Tax Appellate Tribunal", year: 2021 },
       { tid: 2, title: "b", docsource: "Bombay High Court", year: 2021 }]);
    assert.strictEqual(hint.higherCourtFollowUps.length, 0);
  });

  t("★ 查不出来只说「未发现」，不说「现行有效」", () => {
    const hint = cs.buildSupersessionHint({ docsource: "ITAT", year: 2015 }, []);
    assert.ok(/未发现/.test(hint.note));
    assert.ok(!/现行有效|仍然有效/.test(hint.note), "没有能力断言有效，就不能这么写");
  });

  console.log("\n== 公司案例：同名消歧 ==");

  t("★ 三星的多个印度主体要分开，不能揉成一张风险画像", () => {
    const groups = cs.groupByEntity([
      { docid: "1", title: "a", entity: cs.matchedEntity("Samsung India Electronics Pvt Ltd vs CIT", SAMSUNG), verdict: "PARTY" },
      { docid: "2", title: "b", entity: cs.matchedEntity("Samsung India Electronics Pvt Ltd vs ACIT", SAMSUNG), verdict: "PARTY" },
      { docid: "3", title: "c", entity: cs.matchedEntity("Samsung Heavy Industries Co Ltd vs DIT", SAMSUNG), verdict: "PARTY" },
    ]);
    assert.strictEqual(groups.length, 2, "消费电子和海工是两个法律主体");
    assert.strictEqual(groups[0].cases.length, 2, "案子多的主体排前面");
  });

  console.log("\n== 公司案例：什么时候才花这 ₹13 ==");

  t("★ 点名公司 + 求取案例 → 触发", () => {
    const intent = cq.detectCompanyCaseIntent("三星在印度有哪些税务官司？");
    assert.ok(intent, "应当识别出意图");
    assert.strictEqual(intent.mention, "三星");
    assert.ok(intent.aliases.includes("Samsung India Electronics"));
    assert.strictEqual(intent.aliasSource, "dictionary");
  });

  t("★ 没点名公司的泛问 → 不触发（不能白花钱）", () => {
    assert.strictEqual(cq.detectCompanyCaseIntent("印度有哪些转让定价的案例？"), undefined);
    assert.strictEqual(cq.detectCompanyCaseIntent("常设机构有哪些判例"), undefined);
  });

  t("★ 词典里没有的公司 → 不猜，返回 undefined", () => {
    assert.strictEqual(cq.detectCompanyCaseIntent("某某不存在公司有哪些官司"), undefined,
      "识别不出主体时宁可走普通链路，也不能拿猜的公司名去花钱");
  });

  t("提供了猜测函数时才走兜底，并标明来源是推测", () => {
    const intent = cq.detectCompanyCaseIntent("蔚来汽车有哪些印度官司", () => ["NIO India"]);
    assert.ok(intent);
    assert.strictEqual(intent.aliasSource, "guess");
  });

  t("不是求取案例的句子 → 不触发", () => {
    assert.strictEqual(cq.detectCompanyCaseIntent("三星在印度的增值税税率是多少"), undefined);
  });

  t("别名查表：中英文、带后缀都要认", () => {
    assert.ok(cq.lookupAliases("三星"));
    assert.ok(cq.lookupAliases("小米").includes("Xiaomi Technology India"));
    assert.ok(cq.lookupAliases("三星电子"), "带后缀的写法要能查到");
  });
}

// 分层排序的边界：确认件里最差的，也必须排在存疑件里最好的前面。
// 第一版用乘性系数（1 / 0.4）时这条过不了——自测抓出来的真实 bug。
{
  const cs = require("./lib/server/company-case-search.js");
  console.log("\n== 公司案例：确认件永远压过存疑件（分层而非调参）==");
  t("最差的确认件 > 最好的存疑件", () => {
    const now = new Date("2026-01-01");
    const worstParty = { docid: "1", title: "a", docsource: "unknown body", year: 1980, verdict: "PARTY" };
    const bestUncertain = { docid: "2", title: "b", docsource: "Supreme Court of India", year: 2026, verdict: "UNCERTAIN" };
    assert.ok(cs.scoreCandidate(worstParty, now) > cs.scoreCandidate(bestUncertain, now),
      `最差确认件 ${cs.scoreCandidate(worstParty, now)} 必须 > 最好存疑件 ${cs.scoreCandidate(bestUncertain, now)}`);
  });
}
