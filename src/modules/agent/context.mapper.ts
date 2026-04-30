import { AgentBehavior, AgentContext, WalletAnalysisRecord } from './types';

function normalizeBehavior(raw?: string): AgentBehavior {
  const value = (raw ?? '').toUpperCase();
  if (value.includes('DEGEN')) return 'DEGEN';
  if (value.includes('TRADER') || value.includes('SWING') || value.includes('DAY')) return 'TRADER';
  return 'HOLDER';
}

export function mapWalletAnalysisToContext(record: WalletAnalysisRecord): AgentContext {
  return {
    level: record.wallet_level ?? 'BEGINNER',
    riskScore: Number(record.risk_score ?? 0),
    behavior: normalizeBehavior(record.behavior_type),
    tradeFrequency: Number(record.trade_frequency ?? 0),
    avgHoldDays: Number(record.avg_hold_time_days ?? 0),
    walletHealth: Number(record.wallet_health_score ?? 0),
  };
}

export function buildIntroFromContext(ctx: AgentContext): string {
  const holdStyle =
    ctx.avgHoldDays > 60
      ? 'hold assets for the long term'
      : ctx.avgHoldDays > 14
      ? 'mix medium-term holding with occasional exits'
      : 'move in and out relatively quickly';

  const activity =
    ctx.tradeFrequency < 2 ? 'trade less frequently' : 'trade quite actively';

  return `I analyzed your wallet. You look like an ${ctx.level} user, you usually ${holdStyle}, and you ${activity}.`;
}