/**
 * 法律**类别**的唯一定义（id + 中文名）。
 *
 * ## 为什么要单独一个文件
 *
 * 这套类别名同时出现在两个地方：
 *   - 后台「知识库结构」按类别分组列资料（`lib/server/document-category.ts`）
 *   - 答案里「法规要求」按类别分组（`app/page.tsx`）
 *
 * originally 两边各写了一份，结果**已经漂移了**：一边叫"进出口与海关"、
 * 另一边叫"海关与进出口"；一边"所得税 / DTAA"、另一边"所得税与转让定价"。
 * 用户看到的是同一个产品的两个页面，名字却对不上。
 *
 * 所以把**名字**抽到这里统一，以**知识库结构那一套为准**（用户的原话：
 * "用知识库的结构去统一两边"）——知识库是资料的来源，它怎么分，答案就怎么分。
 *
 * ## 什么留在各自的文件里
 *
 * **判定规则按输入分，不按调用方分。** 两种输入天然不同：
 *   - `fileName`（`FEMA_NDI_Rules_for_kb.txt`）→ 判据在 `lib/server/document-category.ts`
 *   - 法律正式名（`FEMA (Non-debt Instruments) Rules, 2019`）→ 判据是下面的
 *     `lawCategoryOfTitle`
 * 硬把两种输入合成一套正则，等于让两边互相迁就，反而更容易判错。
 *
 * ⚠`lawCategoryOfTitle` 原来是写在 `app/page.tsx` 里的私有函数。2026-09-29
 * 搬到这里，因为服务端也要用同一套判据：引用的法域闸门（`citation-domain.ts`）
 * 判的是**同一个东西**——引用里的法律正式名。两份正则各自演化，
 * 迟早会出现"前端认为这条是 GST、服务端认为不是"的分裂，
 * 那正是这个文件开头记的那次名称漂移事故换了个位置重演。
 *
 * ## 这个文件不能引入任何服务端依赖
 *
 * `app/page.tsx` 是客户端组件。它 import 的任何东西都会被打进浏览器包，
 * 引入 `lib/server/*` 会把服务端代码（可能含密钥读取逻辑）带到前端。
 * 这里只放纯数据，没有 import。
 */

export interface LawCategory {
  id: string;
  label: string;
}

/**
 * 顺序有意义：后台总览和答案里的类别都按这个次序排。
 *
 * 排法是按**中资企业在印度实际碰到的顺序**——先把公司设起来（公司法/MCA），
 * 再解决钱怎么进来（FEMA/FDI），然后是日常最高频的流转税（GST）、
 * 年度所得税，最后是有进出口业务才涉及的海关。
 * 不是按法律位阶排，那个维度由 `legal-hierarchy.ts` 单独管。
 */
export const LAW_CATEGORIES: LawCategory[] = [
  { id: "company_governance", label: "公司设立与治理（MCA / ROC / LLP）" },
  { id: "fema_fdi_rbi", label: "FEMA / FDI / RBI" },
  { id: "gst", label: "GST" },
  { id: "income_tax", label: "所得税 / DTAA" },
  { id: "trade_customs", label: "进出口与海关" },
  { id: "other", label: "其他" },
];

export const LAW_CATEGORY_IDS = LAW_CATEGORIES.map((category) => category.id);

export function lawCategoryLabel(id: string): string {
  return LAW_CATEGORIES.find((category) => category.id === id)?.label ?? "其他";
}

/** 类别在上面那个数组里的位置，用于排序。认不出的排最后。 */
export function lawCategoryOrder(id: string): number {
  const index = LAW_CATEGORIES.findIndex((category) => category.id === id);
  return index >= 0 ? index : LAW_CATEGORIES.length;
}

/**
 * 按**法律正式名**判类别（引用里的 `display_title`、chunk 的 `source`）。
 *
 * 和 `lib/server/document-category.ts` 的区别只有输入：那个判文件名。
 *
 * ⚠这个文件被客户端组件 import，所以不能有任何服务端依赖——只放纯正则。
 */
const TITLE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "company_governance", pattern: /companies act|company act|公司法|\bMCA\b|\bROC\b|\bLLP\b|limited liability partnership|partnership act|insolvency|bankruptcy|competition act|money-?laundering|nclt|nclat|iepf/i },
  { id: "fema_fdi_rbi", pattern: /\bFEMA\b|foreign exchange management|\bRBI\b|reserve bank|\bFDI\b|press note|dpiit|payment and settlement/i },
  { id: "gst", pattern: /\b[CI]?GST\b|goods and services tax|货物与服务税|compensation to states|hundred and first amendment/i },
  { id: "income_tax", pattern: /income[\s-]?tax|所得税|\bDTAA\b|double taxation|双重征税|transfer pricing|form no\.? 48/i },
  { id: "trade_customs", pattern: /customs|海关|foreign trade|\bDGFT\b|ITC\s*\(?\s*HS|tariff|handbook of procedures/i },
];

/** 认不出来时返回 `"other"`——**不猜**。下游据此退回"不收窄"，不会误剔。 */
export function lawCategoryOfTitle(title: string): string {
  return TITLE_PATTERNS.find((category) => category.pattern.test(title))?.id ?? "other";
}
