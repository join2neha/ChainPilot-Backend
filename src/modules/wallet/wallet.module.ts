import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { User } from '../../database/entities/user.entity'
import { AuthModule } from '../auth/auth.module';
import { Web3Module } from '../../config/web3.module'
import { WalletAnalysis } from 'src/database/entities/wallet-analysis.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, WalletAnalysis]),
    JwtModule.register({}),
    AuthModule,
    Web3Module
  ],
  providers: [WalletService],
  controllers: [WalletController],
})
export class WalletModule { }