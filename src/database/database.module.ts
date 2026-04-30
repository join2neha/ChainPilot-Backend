import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { WalletAnalysis } from './entities/wallet-analysis.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('SUPABASE_DB_URL'),
        entities: [User, WalletAnalysis],
        synchronize: true,
        ssl: {
          rejectUnauthorized: false,
        },
        extra: {
          max: 5,
        },
      }),
    })
  ],
})
export class DatabaseModule { }