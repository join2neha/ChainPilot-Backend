export type AgentStep = 'INIT' | 'GOAL' | 'STRATEGY' | 'CONFIRM' | 'COMPLETE';
export type AgentGoal = 'increase_returns' | 'reduce_risk' | 'explore';

export type SuggestedTrade = {
    tokenIn: string;
    tokenOut: string;
    amountPercent: number;
};

export type AgentSession = {
    userId: string;
    step: AgentStep;
    goal?: AgentGoal;
    suggestedTrade?: SuggestedTrade;
    contextSnapshot?: AgentContextSnapshot;
    updatedAt: number;
};

export type AgentContextSnapshot = {
    stablePercent: number;      // % of portfolio in stablecoins
    l1Percent: number;          // % in ETH/BTC etc.
    altPercent: number;         // % in DeFi/Memes
    riskScore: number;          // from wallet analysis
    walletLevel: string;
    behavior: string;
    avgHoldDays: number;
};

export type AgentResponse = {
    success: true;
    data: {
        reply: string;
        step: AgentStep;
        actions?: string[];
        trade?: SuggestedTrade;
    };
};

export type DecisionMemory = {
    userId: string;
    decision: SuggestedTrade | undefined;
    goal: AgentGoal | undefined;
    timestamp: number;
    contextSnapshot: AgentContextSnapshot | undefined;
};