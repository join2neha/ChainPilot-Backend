import { AgentContext, ConversationState } from './types';

export function getInitialConversationState(): ConversationState {
  return {
    step: 'INIT',
    answers: {},
  };
}

export function getQuestionForState(state: ConversationState, ctx: AgentContext): string | null {
  if (state.step === 'ASK_INTENT') {
    if (ctx.behavior === 'HOLDER') {
      return 'You generally hold assets longer. Is your current goal SHORT_TERM opportunity or LONG_TERM growth?';
    }
    return 'What is your current goal: SHORT_TERM trade or LONG_TERM position?';
  }

  if (state.step === 'ASK_RISK') {
    if (ctx.riskScore > 6) {
      return 'Your wallet shows higher risk behavior. For this setup, should I follow LOW, MEDIUM, or HIGH risk preference?';
    }
    if (ctx.tradeFrequency < 2) {
      return 'You trade less frequently. Should I keep a conservative style (LOW/MEDIUM) or allow HIGH risk moves?';
    }
    if (ctx.level === 'ADVANCED') {
      return 'Do you want this recommendation to optimize for LOW, MEDIUM, or HIGH risk strategy?';
    }
    return 'What risk preference should I follow: LOW, MEDIUM, or HIGH?';
  }

  return null;
}

export function transitionState(
  state: ConversationState,
  payload: { intent?: 'SHORT_TERM' | 'LONG_TERM'; riskPreference?: 'LOW' | 'MEDIUM' | 'HIGH' },
): ConversationState {
  if (state.step === 'INIT') {
    return { ...state, step: 'ASK_INTENT' };
  }

  if (state.step === 'ASK_INTENT') {
    if (!payload.intent) return state;
    return {
      step: 'ASK_RISK',
      answers: {
        ...state.answers,
        intent: payload.intent,
      },
    };
  }

  if (state.step === 'ASK_RISK') {
    if (!payload.riskPreference) return state;
    return {
      step: 'DONE',
      answers: {
        ...state.answers,
        riskPreference: payload.riskPreference,
      },
    };
  }

  return state;
}