export type AgentLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
export type AgentBehavior = 'HOLDER' | 'TRADER' | 'DEGEN';

export type AgentContext = {
  level: AgentLevel;
  riskScore: number;
  behavior: AgentBehavior;
  tradeFrequency: number;
  avgHoldDays: number;
  walletHealth: number;
};

export type UserIntent = 'SHORT_TERM' | 'LONG_TERM';
export type RiskPreference = 'LOW' | 'MEDIUM' | 'HIGH';

export type UserAnswers = {
  intent?: UserIntent;
  riskPreference?: RiskPreference;
};

export type ConversationStep = 'INIT' | 'ASK_INTENT' | 'ASK_RISK' | 'DONE';

export type ConversationState = {
  step: ConversationStep;
  answers: UserAnswers;
};

export type MarketInput = {
  symbol: string;
  price: number;
  rsi: number;
};

export type Decision = {
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasoning: string;
  suggestion: string;
};

export type WalletAnalysisRecord = {
  wallet_level?: AgentLevel;
  risk_score?: number;
  behavior_type?: string;
  trade_frequency?: number;
  avg_hold_time_days?: number;
  wallet_health_score?: number;
};