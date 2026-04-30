import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { walletConnectDto } from './dto/wallet-connect.dto';
import { AccessTokenGuard } from '../../common/guards/access-token.guard'
import { AnalyzeWalletDto } from './dto/analyze-wallet.dto';

@ApiTags('wallet')
@Controller('wallet')
export class WalletController {
    constructor(private readonly walletService: WalletService) { }

    @Post('connect')
    @ApiOperation({ summary: 'Create/fetch user by wallet and issue tokens' })
    @ApiResponse({ status: 201, description: 'Wallet connect and tokens generated' })
    walletConnect(@Body() dto: walletConnectDto) {
        return this.walletService.walletConnect(dto.walletAddress);
    }

    @Get('analyze-wallet')
    @UseGuards(AccessTokenGuard)
    @ApiBearerAuth('access-token')
    @ApiOperation({ summary: 'Analyze authenticated user wallet via Alchemy' })
    analyzeWalletDetails(@Req() req: Request & { user: { sub: string } }) {
        return this.walletService.analyzeWalletDetails(req.user.sub);
    }

    @Post('logout')
    @UseGuards(AccessTokenGuard)
    @ApiBearerAuth('access-token')
    @ApiOperation({ summary: 'Logout wallet session' })
    @ApiResponse({ status: 200, description: 'Session logged out successfully' })
    logout(@Req() req: Request & { user: { sub: string } }) {
        return this.walletService.logout(req.user.sub);
    }


    @Get('global-market')
    @UseGuards(AccessTokenGuard) 
    @ApiBearerAuth('access-token')
    getGlobalMarket() {
        return this.walletService.getGlobalMarketData();
    }

}