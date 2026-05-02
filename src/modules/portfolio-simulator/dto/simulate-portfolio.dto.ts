import { IsIn, IsInt, IsNumber, Max, Min } from 'class-validator';

export class SimulatePortfolioDto {
    @IsNumber()
    @Min(0.01)
    capital!: number;

    @IsInt()
    @Min(0)
    @Max(100)
    riskTolerance!: number;

    @IsIn(['3m', '6m', '1y', '3y'])
    horizon!: '3m' | '6m' | '1y' | '3y';
}