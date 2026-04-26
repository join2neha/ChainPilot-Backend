import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { walletConnectDto } from './dto/wallet-connect.dto';

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
}