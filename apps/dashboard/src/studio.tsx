import { AgStudio, createWidgets } from 'ag-studio-react';
import { studioTheme } from 'ag-studio';
import type {
  AgBaseWidgetDefinition,
  AgDefaultRegistry,
  AgDefaultWidgetDefinition,
  AgDataSourcesDefinition,
  AgReportState,
} from 'ag-studio';
import type { DashboardData } from '../../firewall/src/dashboard/data.ts';

export type Stats = Omit<DashboardData, 'audit'> & {
  query_mode: 'claude' | 'synthetic' | 'disabled';
  policy_preview_mode?: 'claude' | 'synthetic' | 'disabled';
};
type BudgetDefinition = AgBaseWidgetDefinition<'spendwall-budget'>;
interface Registry extends Omit<AgDefaultRegistry, 'widgets'> {
  widgets: readonly (AgDefaultWidgetDefinition | BudgetDefinition)[];
}
const money = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    value,
  );
function Budget({ context }: { context: { agents: Stats['agents'] } }) {
  return (
    <div className="budget-list">
      <p className="widget-note">
        Reserved funds, including pending approvals. Monitoring budgets do not
        enforce policy.
      </p>
      {context.agents.length === 0 ? (
        <p>No agents in this snapshot.</p>
      ) : (
        context.agents.map((agent) => (
          <section key={agent.agent} className="budget-row">
            <div>
              <strong>{agent.agent}</strong>
              <span>
                {agent.utilization === null
                  ? 'No budget configured'
                  : `${Math.round(agent.utilization * 100)}%`}
              </span>
            </div>
            {agent.utilization !== null && (
              <progress
                aria-label={`${agent.agent} monitoring budget utilization`}
                max={100}
                value={Math.min(agent.utilization * 100, 100)}
              />
            )}
            <small>
              {money(agent.reserved_usd)} reserved
              {agent.budget_usd === null
                ? ''
                : ` / ${money(agent.budget_usd)} monitoring budget`}
            </small>
          </section>
        ))
      )}
    </div>
  );
}
const widgets = createWidgets<Registry>({
  additionalTypes: [
    {
      id: 'spendwall-budget',
      label: 'Reservation utilization',
      comp: Budget,
      form: (params) => params.createDefaults({}),
      defaultSize: { width: 500, height: 300 },
      minSize: { width: 240, height: 180 },
    },
  ],
});
export const theme = studioTheme.withParams({
  fontFamily: 'var(--font)',
  fontSize: 14,
  textColor: 'var(--ink)',
  foregroundColor: 'var(--ink)',
  subtleTextColor: 'var(--muted)',
  backgroundColor: 'var(--surface)',
  borderColor: 'var(--border)',
  accentColor: 'var(--accent)',
  studioMinWidth: 0,
  studioCanvasMinWidth: 0,
  studioWrapperBorder: false,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: 'var(--canvas)',
  studioCanvasBackgroundColor: 'var(--canvas)',
  studioCanvasBorder: false,
  studioCanvasPadding: 0,
  studioCanvasRowHeight: 20,
  studioWidgetBackgroundColor: 'var(--surface)',
  studioWidgetBorder: { width: 1, color: 'var(--border)' },
  studioWidgetBorderRadius: 8,
  studioWidgetPadding: 14,
  studioWidgetTitleFontSize: 16,
  studioWidgetTitleFontWeight: 600,
  chartPaletteFills1Color: '#267564',
  chartPaletteFills2Color: '#b66b14',
  chartPaletteFills3Color: '#b4443b',
  gridRowHeight: 38,
});
const title = (text: string) => ({ title: { text, enabled: true } });
const field = (id: string) => ({ id });
const sum = (id: string) => ({ id, aggregation: 'sum' as const });
function report(narrow: boolean): AgReportState<Registry> {
  const definitions: AgReportState<Registry>['pages'][number]['widgets'] = {
    money: {
      type: 'column-chart-grouped',
      dataMapping: {
        categoryKey: [field('hourly.hour')],
        valueKey: [sum('hourly.usd')],
      },
      format: title('Confirmed refunds by hour · USD'),
    },
    decisions: {
      type: 'donut-chart',
      dataMapping: {
        categoryKey: [field('decisions.decision')],
        valueKey: [sum('decisions.count')],
      },
      format: title('Refund decisions · last 24 hours'),
    },
    budget: {
      type: 'spendwall-budget',
      format: title('Agent reservation utilization'),
    },
    risk: {
      type: 'grid',
      dataMapping: {
        cols: [
          field('agents.agent'),
          sum('agents.attempts'),
          sum('agents.denied'),
          field('agents.denial_rate'),
        ],
      },
      format: title('Agent signals · denial rate'),
    },
    pending: {
      type: 'grid',
      dataMapping: {
        cols: [
          field('pending.agent'),
          field('pending.approval_id'),
          field('pending.usd'),
          field('pending.expires_at'),
        ],
      },
      format: title('Awaiting human approval'),
    },
    rules: {
      type: 'grid',
      dataMapping: {
        cols: [
          field('rules.rule'),
          sum('rules.count'),
          field('rules.policy_version'),
        ],
      },
      format: title('Rule matches on denied requests'),
    },
  };
  const layout = Object.fromEntries(
    Object.keys(definitions).map((id, i) => [
      id,
      {
        xTrack: narrow ? 0 : (i % 2) * 12,
        yTrack: (narrow ? i : Math.floor(i / 2)) * 18,
        xSpan: narrow ? 24 : 12,
        ySpan: 18,
      },
    ]),
  );
  return {
    selectedPageId: 'overview',
    pages: [
      {
        id: 'overview',
        widgets: definitions,
        widgetLayout: layout,
      },
    ],
  };
}
function sources(stats: Stats): AgDataSourcesDefinition<Registry> {
  return {
    sources: [
      {
        id: 'hourly',
        fields: [
          { id: 'hour', name: 'Hour (UTC)', format: 'textFormat' },
          { id: 'usd', name: 'Confirmed USD', format: 'decimalFormat' },
        ],
        data: stats.hourly.map((r) => ({
          ...r,
          hour: r.hour.slice(5, 16).replace('T', ' '),
        })),
      },
      {
        id: 'decisions',
        data: stats.decisions.map((r) => ({
          ...r,
          decision: {
            allow: 'Allowed',
            require_approval: 'Needs approval',
            deny: 'Denied',
          }[r.decision],
        })),
      },
      {
        id: 'agents',
        fields: [
          { id: 'agent', name: 'Agent', format: 'textFormat' },
          { id: 'attempts', name: 'Attempts', format: 'integerFormat' },
          { id: 'denied', name: 'Denied', format: 'integerFormat' },
          {
            id: 'denial_rate',
            name: 'Denial rate',
            format: 'percentageFormat',
          },
        ],
        data: stats.agents,
      },
      {
        id: 'pending',
        fields: [
          { id: 'agent', name: 'Agent', format: 'textFormat' },
          { id: 'approval_id', name: 'Approval ID', format: 'textFormat' },
          { id: 'usd', name: 'USD', format: 'currencyFormat' },
          { id: 'expires_at', name: 'Expires (UTC)', format: 'textFormat' },
        ],
        data: stats.pending,
      },
      {
        id: 'rules',
        fields: [
          { id: 'rule', name: 'Rule reference', format: 'textFormat' },
          {
            id: 'policy_version',
            name: 'Policy version',
            format: 'textFormat',
          },
          { id: 'count', name: 'Count', format: 'integerFormat' },
        ],
        data: stats.rules,
      },
    ],
  };
}
export function Report({ stats, narrow }: { stats: Stats; narrow: boolean }) {
  return (
    <AgStudio<Registry>
      key={`${stats.as_of}/${narrow}`}
      data={sources(stats)}
      context={{ agents: stats.agents }}
      widgets={widgets}
      initialState={report(narrow)}
      theme={theme}
      panels={{ view: { left: [], right: [] } }}
      mode="view"
      style={{ width: '100%', height: narrow ? 2240 : 1160 }}
    />
  );
}
