import { ApiProperty } from '@nestjs/swagger';
import { IsEthereumAddress } from 'class-validator';

export class AnalyzeWalletDto {
    @ApiProperty({
        example: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    })
    @IsEthereumAddress()
    walletAddress: string;
}