import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');

        if (!redisUrl) {
          throw new Error('REDIS_URL is not defined in environment variables');
        }

        const client = new Redis(redisUrl, {
          maxRetriesPerRequest: 3,
          enableReadyCheck: true,
          lazyConnect: false,
          reconnectOnError: (err) => {
            console.error('Redis reconnect error:', err);
            return true;
          },
        });

        // ✅ Better logging
        client.on('connect', () => {
          console.log('Redis connected');
        });

        client.on('ready', () => {
          console.log('Redis ready to use');
        });

        client.on('error', (err) => {
          console.error('Redis error:', err);
        });

        client.on('close', () => {
          console.warn('Redis connection closed');
        });

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}