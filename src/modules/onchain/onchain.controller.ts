import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OnchainService } from './onchain.service';


@ApiTags('onchain')
@Controller('onchain')
export class OnchainController {
  constructor(private readonly onchainService: OnchainService) {}

  @Get('signals')
  @ApiOperation({ summary: 'Aggregated onchain signals for dashboard' })
  @ApiResponse({ status: 200, description: 'Signals fetched' })
  getSignals() {
    return this.onchainService.getOnchainSignals();
  }
}