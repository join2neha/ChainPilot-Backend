import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class UserAnswersDto {
  @ApiProperty({ required: false, enum: ['SHORT_TERM', 'LONG_TERM'] })
  @IsOptional()
  @IsEnum(['SHORT_TERM', 'LONG_TERM'])
  intent?: 'SHORT_TERM' | 'LONG_TERM';

  @ApiProperty({ required: false, enum: ['LOW', 'MEDIUM', 'HIGH'] })
  @IsOptional()
  @IsEnum(['LOW', 'MEDIUM', 'HIGH'])
  riskPreference?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export class ConversationStateDto {
  @ApiProperty({ enum: ['INIT', 'ASK_INTENT', 'ASK_RISK', 'DONE'] })
  @IsEnum(['INIT', 'ASK_INTENT', 'ASK_RISK', 'DONE'])
  step!: 'INIT' | 'ASK_INTENT' | 'ASK_RISK' | 'DONE';

  @ApiProperty({ type: () => UserAnswersDto })
  @ValidateNested()
  @Type(() => UserAnswersDto)
  answers!: UserAnswersDto;
}

export class AgentContextDto {
  @ApiProperty({ enum: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'] })
  @IsEnum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED'])
  level!: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

  @ApiProperty({ example: 7 })
  @IsNumber()
  riskScore!: number;

  @ApiProperty({ enum: ['HOLDER', 'TRADER', 'DEGEN'] })
  @IsEnum(['HOLDER', 'TRADER', 'DEGEN'])
  behavior!: 'HOLDER' | 'TRADER' | 'DEGEN';

  @ApiProperty({ example: 1 })
  @IsNumber()
  tradeFrequency!: number;

  @ApiProperty({ example: 629.41 })
  @IsNumber()
  avgHoldDays!: number;

  @ApiProperty({ example: -2.1 })
  @IsNumber()
  walletHealth!: number;
}

export class MarketInputDto {
  @ApiProperty({ example: 'ETH' })
  @IsString()
  symbol!: string;

  @ApiProperty({ example: 3120.45 })
  @IsNumber()
  price!: number;
  
  @ApiProperty({ example: 28 })
  @IsNumber()
  rsi!: number;
}

export class UseLlmDto {
  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}