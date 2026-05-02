import { Body, Controller, Post, UseGuards, Request, Logger } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AiAgentService } from './ai-agent.service';
import { AiAgentMessageDto } from './dto/ai-agent-message.dto';
import { AccessTokenGuard } from 'src/common/guards/access-token.guard';

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('ai')
export class AiAgentController {
    private readonly logger = new Logger(AiAgentController.name);

    constructor(private readonly aiAgentService: AiAgentService) { }

    @Post('agent')
    @ApiOperation({
        summary: 'AI Decision Agent',
        description:
            'Multi-step conversational agent. Analyzes wallet, suggests trades, requires confirmation. Never executes. Lifecycle: INIT → GOAL → STRATEGY → CONFIRM → COMPLETE',
    })
    @ApiBody({ type: AiAgentMessageDto })
    @ApiResponse({ status: 201, description: 'Agent response returned' })
    async handleMessage(
        @Body() dto: AiAgentMessageDto,
        @Request() req: { user: { sub: string } },
    ) {
        const userId = req.user.sub;
        this.logger.log(`Agent request from userId=${userId}`);
        return this.aiAgentService.handleMessage(userId, dto.message);
    }
}