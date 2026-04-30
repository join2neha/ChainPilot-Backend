import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import { AgentContextDto, ConversationStateDto, UserAnswersDto } from './common.dto';

export class RespondAgentDto {
  @ApiProperty({ type: () => AgentContextDto })
  @ValidateNested()
  @Type(() => AgentContextDto)
  context!: AgentContextDto;

  @ApiProperty({ type: () => ConversationStateDto })
  @ValidateNested()
  @Type(() => ConversationStateDto)
  state!: ConversationStateDto;

  @ApiProperty({ type: () => UserAnswersDto })
  @ValidateNested()
  @Type(() => UserAnswersDto)
  answers!: UserAnswersDto;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}