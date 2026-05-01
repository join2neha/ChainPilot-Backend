import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../../common/guards/access-token.guard';
import { WalletIntelligenceService } from './wallet-intelligence.service';

@ApiTags('wallet')
@Controller('wallet')
export class WalletIntelligenceController {
  constructor(
    private readonly walletIntelligenceService: WalletIntelligenceService,
  ) {}

  @Get('intelligence')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get wallet intelligence / trader DNA' })
  @ApiResponse({ status: 200, description: 'Wallet intelligence fetched' })
  getWalletIntelligence(@Req() req: Request & { user: { sub: string } }) {
    return this.walletIntelligenceService.getWalletIntelligence(req.user.sub);
  }
}