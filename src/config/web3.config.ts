import { Alchemy, Network } from 'alchemy-sdk';

export const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ETH_SEPOLIA,
});