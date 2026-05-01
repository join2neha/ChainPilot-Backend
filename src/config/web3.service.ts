import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Alchemy, Network } from 'alchemy-sdk';

type SupportedNetwork =
  | 'eth-mainnet'
  | 'eth-sepolia'
  | 'polygon-mainnet'
  | 'arb-mainnet';

@Injectable()
export class Web3Service {
  private readonly alchemyClient: Alchemy;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('ALCHEMY_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException('ALCHEMY_API_KEY is missing');
    }

    const networkEnv = (
      this.configService.get<string>('ALCHEMY_NETWORK') ?? 'eth-mainnet'
    ).toLowerCase() as SupportedNetwork;

    const networkMap: Record<SupportedNetwork, Network> = {
      'eth-mainnet': Network.ETH_MAINNET,
      'eth-sepolia': Network.ETH_SEPOLIA,
      'polygon-mainnet': Network.MATIC_MAINNET,
      'arb-mainnet': Network.ARB_MAINNET,
    };

    const network = networkMap[networkEnv];
    if (!network) {
      throw new InternalServerErrorException(
        `Invalid ALCHEMY_NETWORK: ${networkEnv}. Allowed: eth-mainnet, eth-sepolia, polygon-mainnet, arb-mainnet`,
      );
    }

    this.alchemyClient = new Alchemy({
      apiKey,
      network,
    });
  }

  get alchemy(): Alchemy {
    return this.alchemyClient;
  }
}