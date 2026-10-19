/**
 * 法律层的"入场券"校验。
 *
 * 起因：用户问"中资股东对印度公司增资需要准备什么文件"，命中了 GST 层的
 * 《CGST Act 2017》第25条——"申请GST注册须持有PAN"。这条规定本身是真的，
 * 但和"增资"这件事没有关系：PAN 是几乎任何公司事项都会用到的通用要求，
 * 光凭它命中不能证明 GST 这个法域和问题本身相关。
 *
 * 用户此前也报告过反过来的问题（FEMA该命中却没命中），说明"要件该不该拉入某一层"
 * 光靠模型自己判断不够稳——这条经验在这个项目上反复出现。这里不是不信任模型的判断，
 * 而是给少数**特别容易被通用词带偏**的法域加一道硬门槛：层名匹配到这个域时，
 * 用户的原始问题文本必须包含这个域的专属信号词，否则整层丢弃，
 * 并把丢弃原因如实写进风险提示，而不是悄悄消失。
 *
 * 只给"已经被实测报告过误触发"的域设门槛（目前是 GST）；公司法/FEMA/RBI/所得税
 * 没出现过这个问题，不设限制，避免"宁可错杀"造成新的漏检。
 */

export interface LayerLike {
  layer: string;
  elements: unknown[];
}

interface DomainGate {
  /** 判断"层名"是否落在这个域。 */
  test: RegExp;
  /** 判断"用户原始问题"是否包含这个域的专属信号词。 */
  signals: RegExp;
  /** 给风险提示用的中文域名。 */
  label: string;
}

const DOMAIN_GATES: DomainGate[] = [
  {
    test: /GST|货物与服务税|增值税/i,
    signals: /GST|货物与服务税|增值税|发票|invoice|进项税|销项税|税率|input\s*tax\s*credit|e-?way\s*bill|报税|应税|供应|采购|销售|开票/i,
    label: "GST",
  },
];

/**
 * 过滤掉"层名匹配到某个受限域、但问题原文没有该域专属信号词"的法律层。
 * 不匹配任何受限域的层（公司法、FEMA、RBI、所得税等）原样保留，不受影响。
 */
export function filterLayersByRelevance<T extends LayerLike>(
  question: string,
  layers: T[],
): { layers: T[]; dropped: string[] } {
  const dropped: string[] = [];
  const kept = layers.filter((entry) => {
    const gate = DOMAIN_GATES.find((candidate) => candidate.test.test(entry.layer));
    if (!gate) return true;
    if (gate.signals.test(question)) return true;
    dropped.push(entry.layer);
    return false;
  });
  return { layers: kept, dropped };
}
