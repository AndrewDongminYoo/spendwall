export const auditPrompts = [
  { intent: 'weekly_refunds', prompt: '이번 주 $100 넘는 환불 시도 보여줘' },
  { intent: 'denial_reasons', prompt: '차단 사유별로 묶어줘' },
  { intent: 'support_budget', prompt: 'support-bot 한도 소진 추이' },
] as const;
export type AuditIntent = (typeof auditPrompts)[number]['intent'];
export type AuditResult = {
  intent: AuditIntent;
  as_of: string;
  title: string;
  note: string;
  columns: {
    id: string;
    name: string;
    format: 'textFormat' | 'decimalFormat' | 'percentageFormat';
  }[];
  rows: Record<string, string | number>[];
};
export type QueryClassifier = (
  question: string,
  signal: AbortSignal,
) => Promise<unknown>;
// Studio's reactive source updates keep a fixed schema for all supported views.
export const auditFields: AuditResult['columns'] = [
  { id: 'id', name: 'Request', format: 'textFormat' },
  { id: 'at', name: 'Time (UTC)', format: 'textFormat' },
  { id: 'agent', name: 'Agent', format: 'textFormat' },
  { id: 'decision', name: 'Decision', format: 'textFormat' },
  { id: 'usd', name: 'USD', format: 'decimalFormat' },
  { id: 'rule', name: 'Rule reference', format: 'textFormat' },
  { id: 'policy_version', name: 'Policy version', format: 'textFormat' },
  { id: 'count', name: 'Denied attempts', format: 'decimalFormat' },
  { id: 'hour', name: 'Time (UTC)', format: 'textFormat' },
  { id: 'reserved_usd', name: 'Reserved USD', format: 'decimalFormat' },
  {
    id: 'budget_usd',
    name: 'Current monitoring budget USD',
    format: 'decimalFormat',
  },
  { id: 'utilization', name: 'Utilization', format: 'percentageFormat' },
];
export function parseIntent(value: unknown): AuditIntent | 'unsupported' {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('intent' in value)
  )
    throw new Error('Query unavailable.');
  const intent = value.intent;
  if (
    intent === 'unsupported' ||
    auditPrompts.some((entry) => entry.intent === intent)
  )
    return intent as AuditIntent | 'unsupported';
  throw new Error('Query unavailable.');
}
