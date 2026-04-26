import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { User } from 'src/database/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.register({}),
  ],
  providers: [WalletService],
  controllers: [WalletController],
})
export class WalletModule { }