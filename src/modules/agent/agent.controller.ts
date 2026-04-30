import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { StartAgentDto } from './dto/start-agent.dto';
import { RespondAgentDto } from './dto/respond-agent.dto';
import { DecisionAgentDto } from './dto/decision-agent.dto';

@ApiTags('ai-agent')
@Controller('ai-agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('start')
  @ApiOperation({
    summary: 'Start AI conversation',
    description:
      'Fetches latest wallet analysis, maps context, and returns intro + first rule-based question.',
  })
  @ApiBody({ type: StartAgentDto })
  @ApiResponse({
    status: 201,
    description: 'Conversation started successfully',
  })
  async start(@Body() dto: StartAgentDto) {
    return this.agentService.start(dto.userId, dto.useLlm ?? true);
  }

  @Post('respond')
  @ApiOperation({
    summary: 'Continue conversation',
    description:
      'Accepts user answer(s), updates conversation state, and returns next question or completion state.',
  })
  @ApiBody({ type: RespondAgentDto })
  @ApiResponse({
    status: 201,
    description: 'Conversation progressed successfully',
  })
  async respond(@Body() dto: RespondAgentDto) {
    return this.agentService.respond(
      dto.context,
      dto.state,
      dto.answers,
      dto.useLlm ?? true,
    );
  }

  @Post('decision')
  @ApiOperation({
    summary: 'Generate final decision',
    description:
      'Runs strict rule-based BUY/SELL/HOLD logic and optionally formats explanation using LLM.',
  })
  @ApiBody({ type: DecisionAgentDto })
  @ApiResponse({
    status: 201,
    description: 'Decision generated successfully',
  })
  async decision(@Body() dto: DecisionAgentDto) {
    return this.agentService.decision(
      dto.context,
      dto.state,
      dto.market,
      dto.useLlm ?? true,
    );
  }
}