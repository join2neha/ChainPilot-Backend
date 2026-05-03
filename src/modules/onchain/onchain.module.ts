import { Module } from '@nestjs/common';
import { Web3Module } from '../../config/web3.module';
import { OnchainController } from './onchain.controller';
import { OnchainService } from './onchain.service';
import { PriceModule } from '../price/price.module';

@Module({
  imports: [Web3Module, PriceModule],
  controllers: [OnchainController],
  providers: [OnchainService],
  exports: [OnchainService],
})
export class OnchainModule {}