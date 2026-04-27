import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Alchemy, Network } from 'alchemy-sdk';

@Injectable()
export class Web3Service {
    private readonly alchemyClient: Alchemy;

    constructor(private readonly configService: ConfigService) {
        const apiKey = this.configService.get<string>('ALCHEMY_API_KEY');
        if (!apiKey) {
            throw new InternalServerErrorException('ALCHEMY_API_KEY is missing');
        }

        const networkName = this.configService.get<string>('ALCHEMY_NETWORK', 'ETH_SEPOLIA');
        const network =
            networkName === 'ETH_MAINNET' ? Network.ETH_MAINNET : Network.ETH_SEPOLIA;

        this.alchemyClient = new Alchemy({ apiKey, network });
    }

    get alchemy(): Alchemy {
        return this.alchemyClient;
    }
}