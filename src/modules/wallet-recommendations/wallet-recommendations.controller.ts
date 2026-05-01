import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../../common/guards/access-token.guard';
import { WalletRecommendationsService } from './wallet-recommendations.service';


@ApiTags('wallet-recommendations')
@Controller('wallet')
export class WalletRecommendationsController {
  constructor(
    private readonly walletRecommendationsService: WalletRecommendationsService,
  ) {}

  @Get('recommendations')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get AI recommendations for wallet' })
  @ApiResponse({ status: 200, description: 'Recommendations fetched' })
  getRecommendations(@Req() req: Request & { user: { sub: string } }) {
    return this.walletRecommendationsService.getRecommendations(req.user.sub);
  }
}