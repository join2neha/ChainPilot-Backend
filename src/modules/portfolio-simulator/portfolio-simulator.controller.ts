import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../../common/guards/access-token.guard';
import { PortfolioSimulatorService } from './portfolio-simulator.service';
import { SimulatePortfolioDto } from './dto/simulate-portfolio.dto';

@ApiTags('portfolio')
@Controller('portfolio')
export class PortfolioSimulatorController {
  constructor(private readonly portfolioSimulatorService: PortfolioSimulatorService) {}

  @Post('simulate')
  @ApiOperation({ summary: 'Simulate portfolio allocation and projections' })
  @ApiBody({ type: SimulatePortfolioDto })
  @ApiResponse({ status: 201, description: 'Simulation completed' })
  simulate(@Body() dto: SimulatePortfolioDto) {
    return this.portfolioSimulatorService.simulate({
      capital: dto.capital,
      riskTolerance: dto.riskTolerance,
      horizon: dto.horizon,
    });
  }
}