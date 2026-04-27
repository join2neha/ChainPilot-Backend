import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

type AuthenticatedRequest = Request & { user?: JwtPayload };

@Injectable()
export class AccessTokenGuard implements CanActivate {
    constructor(private readonly jwtService: JwtService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            throw new UnauthorizedException('Authorization header missing');
        }

        const [type, token] = authHeader.split(' ');
        if (type !== 'Bearer' || !token) {
            throw new UnauthorizedException('Invalid authorization format');
        }

        try {
            const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
                secret: process.env.JWT_ACCESS_SECRET,
            });

            req.user = payload;
            return true;
        } catch {
            throw new UnauthorizedException('Invalid or expired access token');
        }
    }
}