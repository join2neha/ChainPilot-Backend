import { IsNotEmpty, IsEthereumAddress } from 'class-validator';

export class AnalyzeWalletDto {
  @IsNotEmpty()
  @IsEthereumAddress()
  walletAddress: string;
}