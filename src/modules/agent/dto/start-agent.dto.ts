import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class StartAgentDto {
  @ApiProperty({ example: '9c3f6a7d-2c28-4b7f-8a91-8a0f9cf69a52' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}