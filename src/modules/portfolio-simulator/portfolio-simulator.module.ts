import { Module } from '@nestjs/common';
import { PortfolioSimulatorController } from './portfolio-simulator.controller';
import { PortfolioSimulatorService } from './portfolio-simulator.service';

@Module({
  controllers: [PortfolioSimulatorController],
  providers: [PortfolioSimulatorService],
  exports: [PortfolioSimulatorService],
})
export class PortfolioSimulatorModule {}