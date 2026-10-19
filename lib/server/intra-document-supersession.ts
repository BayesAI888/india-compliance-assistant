/**
 * 条文**内部**的新旧值：答案引了一个已被同一份文件自己标注为"已改成别的"的数字。
 *
 * ## 起因（2026-09-28 实测）
 *
 * 用户问所得税上诉的预缴，答案写的是「通常需支付争议税款的 **15%** 作为预缴」。
 * 而它引的那份 CBDT 备忘录，知识库条目里**白纸黑字标着**：
 *
 *     deposit rate 15% [NOTE: this 15% was revised to 20% by the O.M. dated ... ]
 *
 * 资料是对的、标注也到位，**是模型读了 15% 就用了，没读后面那句 NOTE**。
 * 15% 和 20% 差五个百分点，一笔千万卢比级的争议税款就是几十万卢比的现金差别。
 *
 * ## 为什么 `law-supersession.ts` 管不了这个
 *
 * 那个模块解决的是"两部法哪一部现行"——1961 年所得税法 vs 2025 年所得税法，
 * 判据是**文件级**的适用期间。而这里是**同一份文件内部**：一份备忘录里
 * 既写着原始比例、又写着它已经被后来的备忘录改掉了。文件级的闸门看不到这一层。
 *
 * ## 立场：警示，不改写
 *
 * 这里**只标记，绝不替用户把 15% 改成 20%**。理由和 `claim-check.ts`
 * 只出 `unverified_claims`、不动正文是同一条：
 * 悄悄改法律数字，等于系统替用户做了一个它没资格做的判断——
 * 万一那一条讲的确实是历史年度（FY2016-17 适用 15%），改掉就是把对的改错了。
 * 把冲突摆到台面上，让用户自己核对，是唯一安全的做法。
 *
 * ## 也不指望提示词
 *
 * 证据原文里那句 NOTE 本来就送进模型了，它没读。所以这道闸是**确定性兜底**：
 * 从 chunk 里机械抽出「旧值 → 新值」，再机械检查答案用了哪一个。
 */

export interface SupersededValue {
  /** 已被取代的旧值，逐字取自原文，例如 "15%"。 */
  old: string;
  /** 取代它的新值，例如 "20%"。 */
  replacement: string;
}

/**
 * 「X 改成了 Y」的写法。
 *
 * 顺序有意义：**先试带方向词的完整句式**（revised from X to Y），
 * 再试只有一个值的（revised to Y，此时旧值要往前找）。
 * 反过来的话，"revised from 15% to 20%" 会被后一条先匹配上、把 from 15% 当成旧值漏掉。
 *
 * 只认**百分比和金额**这两类，不认一般数字：
 * 「Instruction No. 1914 dated 21.03.1996」里的 1914 和 1996 也是数字，
 * 放宽到一般数字会把文号和日期当成税率抓出来，噪音立刻压过信号。
 */
const VALUE = String.raw`(\d{1,3}(?:\.\d+)?\s*%|(?:Rs\.?|₹)\s*[\d,]+(?:\.\d+)?(?:\s*(?:lakh|crore|lakhs|crores))?)`;

const PATTERNS: Array<{ re: RegExp; oldIndex: number; newIndex: number }> = [
  // revised / increased / enhanced / reduced / substituted **from X to Y**
  {
    re: new RegExp(
      String.raw`(?:revised|increased|enhanced|reduced|modified|substituted|amended)\s+from\s+${VALUE}\s+to\s+${VALUE}`,
      "gi",
    ),
    oldIndex: 1, newIndex: 2,
  },
  // **倒装**：enhanced **to** 新值 **from** 旧值。
  // 英文公文两种语序都常见，只写 from…to… 会漏掉一半。
  // ⚠必须排在下面那条"旧值在前"的规则**前面**：否则
  // "enhanced to Rs.50,00,000 from Rs.20,00,000" 会被那条按"前面的是旧值"抓反，
  // 把新值当成旧值报出来——报反比不报更糟。
  {
    re: new RegExp(
      String.raw`(?:revised|increased|enhanced|reduced|modified|substituted|amended)\s+to\s+${VALUE}\s+from\s+${VALUE}`,
      "gi",
    ),
    oldIndex: 2, newIndex: 1,
  },
  // 中文：由 X 修订/调整/提高/降低 为/到 Y
  {
    re: new RegExp(String.raw`由\s*${VALUE}\s*(?:修订|调整|修改|提高|上调|降低|下调|变更)\s*(?:为|到|至)\s*${VALUE}`, "gi"),
    oldIndex: 1, newIndex: 2,
  },
  // X ... was revised to Y —— 旧值在前、动词在后（CBDT 那句就是这种）
  {
    re: new RegExp(
      String.raw`${VALUE}[^.。;；\n]{0,60}?(?:was|has been|stands?)?\s*(?:revised|increased|enhanced|reduced|modified|substituted|amended|replaced)\s+(?:to|by|with)\s+${VALUE}`,
      "gi",
    ),
    oldIndex: 1, newIndex: 2,
  },
  // 中文：X 已被/已修订为 Y
  {
    re: new RegExp(String.raw`${VALUE}[^。；\n]{0,40}?(?:已(?:被)?(?:修订|调整|取代|替换|上调|下调|提高|降低))\s*(?:为|到|至)?\s*${VALUE}`, "gi"),
    oldIndex: 1, newIndex: 2,
  },
];

/** 去掉空白，让 "15 %" 和 "15%" 算同一个值。大小写一并抹平（Rs./RS.）。 */
export function normalizeValue(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * 从一段条文原文里抽出所有「旧值 → 新值」。
 *
 * 旧值和新值**相同**的丢弃：`"15% ... revised to 15%"` 要么是抽错了、
 * 要么原文本身没说清楚，两种情况下报出来都只是噪音。
 */
export function findSupersededValues(text: string): SupersededValue[] {
  if (!text?.trim()) return [];
  const out: SupersededValue[] = [];
  const seen = new Set<string>();
  for (const { re, oldIndex, newIndex } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      const oldValue = match[oldIndex]?.trim();
      const replacement = match[newIndex]?.trim();
      if (!oldValue || !replacement) continue;
      if (normalizeValue(oldValue) === normalizeValue(replacement)) continue;
      const key = `${normalizeValue(oldValue)}→${normalizeValue(replacement)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ old: oldValue, replacement });
    }
  }
  return out;
}

export interface StepForSupersessionCheck {
  text: string;
  /** 这一条引到的条文原文（逐条，已经是最终引用）。 */
  citedTexts: string[];
}

/** 一条要求用了已被取代的值。 */
export interface SupersededUse {
  /** 答案里写的那个（旧）值。 */
  used: string;
  /** 引用条文自己标注的新值。 */
  replacement: string;
  /**
   * 哪一种错法。文案要分开写——「只写了旧值」和「把旧值说成现行的」
   * 对用户的含义不同，后者更危险。
   */
  kind: "OLD_ONLY" | "REVERSED" | "UNCLEAR";
}

/**
 * 「这个值是现行的」的提示词，用来判断答案把哪一个值当成了现在有效的那个。
 *
 * 匹配的是**紧挨在数值前面**的那一小段。空白已经在 `normalizeValue` 里抹掉了，
 * 所以这里的英文写法也不能带空格（`revisedto` 而不是 `revised to`）。
 */
const CURRENT_CUE = new RegExp(
  "(?:"
  + "现已?(?:调整|修订|修改|变更|改)?为?|现行|目前|当前|自[^，。；]{1,24}起(?:调整|修订|变更)?为?"
  + "|(?:调整|修订|修改|变更|上调|下调|提高|降低)为|改为"
  + "|revisedto|increasedto|enhancedto|reducedto|amendedto|substitutedby|replacedby"
  + "|witheffectfrom[^,.;]{0,24}|w\\.e\\.f\\.[^,.;]{0,24}|currently|atpresent|now"
  + ")$",
  "i",
);

/**
 * 这个值在答案里是不是被写成了"现行有效的那个"。
 *
 * 判据是**紧挨在它前面的那 26 个字符里有没有现行提示词**。
 * 26 是量出来的：能装下「自2017年7月31日起调整为」这种最长的中文提示，
 * 再长就会把上一句的提示词误算到这个值头上。
 */
function framedAsCurrent(normalizedText: string, value: string): boolean {
  const needle = normalizeValue(value);
  let from = 0;
  for (;;) {
    const at = normalizedText.indexOf(needle, from);
    if (at < 0) return false;
    if (CURRENT_CUE.test(normalizedText.slice(Math.max(0, at - 26), at))) return true;
    from = at + needle.length;
  }
}

/**
 * 这一条要求有没有把一个"引用条文自己说已经改掉了"的值当成现行值用。
 *
 * ## 第一版错在哪（2026-09-28 当天就发现了）
 *
 * 第一版的规则是"答案里只要**出现过**新值就不报"，理由是
 * 「原为15%，现已调整为20%」是正确的沿革表述，不该被警示打扰。
 * 理由本身没错，但判据太糙——它只看字符串在不在，**不看哪一个被写成了现行的**。
 *
 * 于是这句直接过闸：
 *
 *     原为**20%**，现已调整为**15%**
 *
 * 方向写反了。两个值都在，规则放行。而用户读到的是"现在是 15%"——
 * **正是原来那个错误，只是穿了一件更像样的外衣，比只写 15% 更有说服力。**
 * 还有一种：「通常按15%预缴，个别情况下可能要求20%」，把现行值降格成了例外。
 *
 * 所以判据改成**方向**：新值必须是被写成"现行的"那一个。
 *
 * ## 三种报法
 *
 *   OLD_ONLY  只写了旧值，完全没提新值。
 *   REVERSED  **把旧值写成了现行的**（现行提示词紧挨着旧值）。最危险的一种。
 *   UNCLEAR   新值出现了，但没有任何提示词说它是现行的——说不清哪个当前有效。
 *
 * 只有一种情况不报：新值挂着现行提示词，且旧值没有被标成现行。
 * 这正好就是「原为15%，自××起调整为20%」那种写法，它照常放行。
 */
export function detectSupersededUse(step: StepForSupersessionCheck): SupersededUse[] {
  const stepText = normalizeValue(step.text);
  const out: SupersededUse[] = [];
  const seen = new Set<string>();
  for (const citedText of step.citedTexts) {
    for (const { old, replacement } of findSupersededValues(citedText)) {
      const oldKey = normalizeValue(old);
      const newKey = normalizeValue(replacement);
      if (!stepText.includes(oldKey)) continue;   // 答案压根没用这个旧值

      const oldIsCurrent = framedAsCurrent(stepText, old);
      const newIsCurrent = framedAsCurrent(stepText, replacement);

      let kind: SupersededUse["kind"] | undefined;
      if (oldIsCurrent) kind = "REVERSED";                    // 旧值被说成现行的，最重
      else if (!stepText.includes(newKey)) kind = "OLD_ONLY";
      else if (!newIsCurrent) kind = "UNCLEAR";
      if (!kind) continue;                                     // 新值挂着现行提示词 → 正确的沿革表述

      if (seen.has(oldKey)) continue;
      seen.add(oldKey);
      out.push({ used: old, replacement, kind });
    }
  }
  return out;
}

/**
 * 给提示词用的说明。和判定逻辑放同一个文件，理由同 `key-figures.ts`：
 * 要求模型怎么做、服务端怎么校验，这两段话必须一起改。
 */
export const SUPERSESSION_PROMPT_RULE =
  `⚠**证据原文里如果自己标注了某个数值已被修改，必须用修改后的值。**
    典型写法："deposit rate 15% [NOTE: this 15% was revised to 20% by the O.M. dated ...]"、
    "由15%调整为20%"。这种标注常常跟在旧值后面的方括号或从句里，很容易读漏。
    要写沿革就把新旧都写出来（"原为15%，自××起调整为20%"），
    **绝不能只写旧值**。服务端会逐条比对引用原文，只写旧值会被标成显著警示。`;
