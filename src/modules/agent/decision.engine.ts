import { AgentContext, Decision, MarketInput, UserAnswers } from './types';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function baseActionFromRsi(rsi: number): Decision['action'] {
  if (rsi < 30) return 'BUY';
  if (rsi > 70) return 'SELL';
  return 'HOLD';
}

export function generateDecision(
  market: MarketInput,
  ctx: AgentContext,
  answers: UserAnswers,
): Decision {
  const base = baseActionFromRsi(market.rsi);
  let action: Decision['action'] = base;
  let confidence = 65;

  // Base confidence from RSI strength
  if (market.rsi < 25 || market.rsi > 75) confidence += 12;
  else if (market.rsi >= 40 && market.rsi <= 60) confidence -= 6;

  // HOLDER bias toward HOLD unless strong signal
  if (ctx.behavior === 'HOLDER' && (market.rsi > 30 && market.rsi < 70)) {
    action = 'HOLD';
  }

  // High risk users allow stronger directional action
  if (ctx.riskScore > 6 && base !== 'HOLD') {
    action = base;
    confidence += 6;
  }

  // Intent-based adjustments
  if (answers.intent === 'SHORT_TERM' && market.rsi > 65) {
    action = 'SELL';
    confidence += 4;
  }

  if (answers.intent === 'LONG_TERM' && market.rsi < 35) {
    action = 'BUY';
    confidence += 4;
  }

  // Beginners are more cautious
  if (ctx.level === 'BEGINNER') {
    confidence -= 10;
    if (action !== 'HOLD' && answers.riskPreference === 'LOW') {
      action = 'HOLD';
    }
  }

  // Risk preference tuning
  if (answers.riskPreference === 'LOW' && action !== 'HOLD') confidence -= 7;
  if (answers.riskPreference === 'HIGH' && action !== 'HOLD') confidence += 5;

  confidence = clamp(Math.round(confidence), 35, 92);

  const reasoning =
    action === 'BUY'
      ? `${market.symbol} looks oversold (RSI: ${market.rsi}). Your profile supports a cautious accumulation setup.`
      : action === 'SELL'
      ? `${market.symbol} looks overbought (RSI: ${market.rsi}). Given your context, reducing exposure is reasonable.`
      : `${market.symbol} is in a neutral zone (RSI: ${market.rsi}), so waiting is the safer move right now.`;

  const suggestion =
    action === 'BUY'
      ? 'Consider a partial entry instead of full allocation.'
      : action === 'SELL'
      ? 'Consider partial profit booking rather than a full exit.'
      : 'Set alerts near RSI extremes before taking the next action.';

  return { action, confidence, reasoning, suggestion };
}