import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { AnalyzeWalletDto } from './dto/analyze-wallet.dto';

@ApiTags('wallet')
@Controller('wallet')
export class WalletController {
    constructor(private readonly walletService: WalletService) { }

    @Post('analyze-wallet')
    @ApiOperation({ summary: 'Create/fetch user by wallet and issue tokens' })
    @ApiResponse({ status: 201, description: 'Wallet analyzed and tokens generated' })
    analyzeWallet(@Body() dto: AnalyzeWalletDto) {
        return this.walletService.analyzeWallet(dto.walletAddress);
    }
}