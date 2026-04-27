export interface JwtPayload {
  sub: string;
  walletAddress: string;
  iat?: number;
  exp?: number;
}