import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MarketService } from './market.service';

@ApiTags('market')
@Controller('market')
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

  @Get('live-insights')
  @ApiOperation({ summary: 'Get live insight cards + recommendation' })
  @ApiQuery({ name: 'refresh', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Live insights fetched' })
  async getLiveInsights(@Query('refresh') refresh?: string) {
    const forceRefresh = String(refresh).toLowerCase() === 'true';
    return this.marketService.getLiveInsights(forceRefresh);
  }
}