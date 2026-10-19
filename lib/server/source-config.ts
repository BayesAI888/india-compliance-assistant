/**
 * 管理后台「来源配置」的只读数据源。
 *
 * 来源白名单与证据位阶属于法律治理规则，不能在页面上随手改；修改必须经专家审核、
 * 代码复核和重新部署。本模块只把当前生效的配置清楚展示给管理员，避免配置躺在
 * JSON 文件里却无人知道系统按什么口径审核资料。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

interface AuthorityConfig {
  id: string;
  name: string;
  domains: string[];
  domains_covered: string[];
  verification_status: "verified_official" | "expert_review_required";
  note?: string;
}

interface AuthoritiesConfig {
  status: string;
  matching_rule: string;
  authorities: AuthorityConfig[];
  state_authorities: { note: string; matching_rule: string; jurisdictions_with_own_act: number };
}

interface DomainsConfig {
  launch_domains: Array<{ id: string; label_zh: string; enabled: boolean }>;
  out_of_scope: Array<{ id: string; label_zh: string }>;
}

interface SourcePriorityConfig {
  status: string;
  decision_order: string[];
  legal_effect_levels: Array<{ id: string; typical_types: string[]; rank: number | null; note?: string }>;
  currency_rules: { inspection_tiers: Record<string, number | string>; expired_effect: string; superseded_effect: string };
}

const decisionLabels: Record<string, string> = {
  legal_currency_not_expired: "法律有效性仍在核验期内",
  not_superseded_by_later_source: "未被后来适用的文件取代",
  applicability_to_subject_industry_entity_and_transaction: "适用于该主体、行业与交易",
  validity_on_target_date_at_provision_level: "目标日期内条文层面有效",
  jurisdiction_match_for_state_and_case_law: "辖区与州别/判例管辖一致",
  legal_effect_level: "法律位阶足以支持该结论",
  specific_rule_over_general_rule: "具体规则优先于一般规则",
  latest_applicable_version_and_amendments: "采用最新适用版本及修订",
  unresolved_conflict_requires_no_definitive_conclusion: "冲突无法排除时不作确定结论",
};

const levelLabels: Record<string, string> = {
  PRIMARY_LAW: "成文法 / 条约",
  SUBORDINATE_LEGISLATION: "规则 / 通知等下位立法",
  ADMINISTRATIVE_DIRECTION: "行政指引",
  OFFICIAL_GUIDANCE: "官方说明",
  JUDICIAL_DECISION: "司法裁判",
};

async function readConfig<T>(fileName: string): Promise<T> {
  const source = await readFile(path.join(process.cwd(), "config", fileName), "utf8");
  return JSON.parse(source) as T;
}

export async function getSourceConfigurationOverview() {
  const [authorities, domains, priority] = await Promise.all([
    readConfig<AuthoritiesConfig>("authorities.draft.json"),
    readConfig<DomainsConfig>("domains.draft.json"),
    readConfig<SourcePriorityConfig>("source-priority.draft.json"),
  ]);
  const labels = new Map(domains.launch_domains.map((domain) => [domain.id, domain.label_zh]));

  return {
    sourceStatus: authorities.status,
    matchingRule: authorities.matching_rule,
    authorities: authorities.authorities.map((authority) => ({
      id: authority.id,
      name: authority.name,
      domains: authority.domains,
      coveredDomains: authority.domains_covered.map((id) => labels.get(id) ?? id),
      verificationStatus: authority.verification_status,
      note: authority.note,
    })),
    stateAuthorities: authorities.state_authorities,
    launchDomains: domains.launch_domains.filter((domain) => domain.enabled),
    outOfScope: domains.out_of_scope,
    reviewOrder: priority.decision_order.map((id) => ({ id, label: decisionLabels[id] ?? id })),
    legalEffectLevels: priority.legal_effect_levels.map((level) => ({
      ...level,
      label: levelLabels[level.id] ?? level.id,
    })),
    currencyRules: priority.currency_rules,
    priorityStatus: priority.status,
  };
}
