import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { RedisModule } from './config/redis.module';
import { AgentModule } from './modules/agent/agent.module';
import { MarketModule } from './modules/market/market.module';
import { WalletIntelligenceModule } from './modules/wallet-intelligence/wallet-intelligence.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    WalletModule,
    RedisModule,
    AgentModule,
    MarketModule,
    WalletIntelligenceModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
