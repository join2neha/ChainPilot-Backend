import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SwapIntelligenceProService } from './swap-intelligence-pro.service';
import { AccessTokenGuard } from 'src/common/guards/access-token.guard';

@ApiTags('swap-intelligence')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('swap-intelligence-pro')
export class SwapIntelligenceProController {
    constructor(private readonly swapIntelService: SwapIntelligenceProService) {}

    @Get()
    @ApiOperation({ summary: 'AI-powered swap recommendations with confidence scoring' })
    @ApiQuery({ name: 'mode', enum: ['conservative', 'balanced', 'aggressive'], required: false })
    @ApiResponse({ status: 200, description: 'Swap suggestions returned' })
    async getSwapIntelligence(
        @Request() req: { user: { sub: string } },
        @Query('mode') mode?: string,
    ) {
        const validMode = ['conservative', 'balanced', 'aggressive'].includes(mode ?? '')
            ? (mode as 'conservative' | 'balanced' | 'aggressive')
            : 'balanced';

        return this.swapIntelService.getSwapIntelligence(req.user.sub, validMode);
    }
}