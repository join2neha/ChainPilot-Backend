export type TimelineEventType = 'TRADE' | 'AI_SIGNAL' | 'REBALANCE' | 'ALERT' | 'SENTIMENT';

export type TimelineEvent = {
    id: string;
    type: TimelineEventType;
    title: string;
    subtitle: string;
    timestamp: number; // epoch ms
    metadata?: Record<string, any>;
};