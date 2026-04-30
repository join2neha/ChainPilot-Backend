import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletAnalysis } from 'src/database/entities/wallet-analysis.entity';
import { mapWalletAnalysisToContext, buildIntroFromContext } from './context.mapper';
import { generateDecision } from './decision.engine';
import {
  getInitialConversationState,
  getQuestionForState,
  transitionState,
} from './question.engine';
import { LlmService } from './llm.service';
import {
  AgentContext,
  ConversationState,
  Decision,
  MarketInput,
  UserAnswers,
  WalletAnalysisRecord,
} from './types';

@Injectable()
export class AgentService {
  constructor(
    @InjectRepository(WalletAnalysis)
    private readonly walletAnalysisRepository: Repository<WalletAnalysis>,
    private readonly llmService: LlmService,
  ) {}

  private async getContextForUser(userId: string): Promise<AgentContext> {
    const latest = await this.walletAnalysisRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    if (!latest) {
      throw new NotFoundException('No wallet analysis found for this user');
    }

    const raw: WalletAnalysisRecord = {
      wallet_level: latest.walletLevel as any,
      risk_score: Number(latest.riskScore),
      behavior_type: latest.behaviorType,
      trade_frequency: Number(latest.tradeFrequency),
      avg_hold_time_days: Number(latest.avgHoldTimeDays),
      wallet_health_score: Number(latest.walletHealthScore),
    };

    return mapWalletAnalysisToContext(raw);
  }

  async start(userId: string, useLlm = true) {
    const context = await this.getContextForUser(userId);
    const state = getInitialConversationState();
    const intro = buildIntroFromContext(context);

    const moved = transitionState(state, {});
    const question = getQuestionForState(moved, context);

    const introMessage = useLlm
      ? await this.llmService.formatResponseWithLLM(intro)
      : intro;

    const questionMessage = useLlm && question
      ? await this.llmService.formatResponseWithLLM(question)
      : question;

    return {
      state: moved,
      context,
      intro: introMessage,
      question: questionMessage,
    };
  }

  async respond(
    context: AgentContext,
    state: ConversationState,
    payload: UserAnswers,
    useLlm = true,
  ) {
    const nextState = transitionState(state, payload);

    if (nextState.step === 'DONE') {
      return {
        state: nextState,
        question: null,
      };
    }

    const question = getQuestionForState(nextState, context);
    const formatted = useLlm && question
      ? await this.llmService.formatResponseWithLLM(question)
      : question;

    return {
      state: nextState,
      question: formatted,
    };
  }

  async decision(
    context: AgentContext,
    state: ConversationState,
    market: MarketInput,
    useLlm = true,
  ) {
    if (state.step !== 'DONE') {
      return {
        error: 'Conversation is not complete yet',
        state,
      };
    }

    const finalDecision: Decision = generateDecision(market, context, state.answers);

    const conversational = useLlm
      ? await this.llmService.formatResponseWithLLM(finalDecision)
      : `${finalDecision.reasoning} Suggestion: ${finalDecision.suggestion}`;

    return {
      decision: finalDecision, // source of truth (rule-based)
      message: conversational, // LLM formatted text only
    };
  }
}