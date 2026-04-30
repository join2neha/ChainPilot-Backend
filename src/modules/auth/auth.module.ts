import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenGuard } from '../../common/guards/access-token.guard'

@Module({
  imports: [JwtModule.register({})],
  providers: [AccessTokenGuard],
  exports: [JwtModule, AccessTokenGuard],
})
export class AuthModule {}