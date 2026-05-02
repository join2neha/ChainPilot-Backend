import { Module } from '@nestjs/common';
import { Web3Module } from '../../config/web3.module';
import { OnchainController } from './onchain.controller';
import { OnchainService } from './onchain.service';

@Module({
  imports: [Web3Module],
  controllers: [OnchainController],
  providers: [OnchainService],
})
export class OnchainModule {}