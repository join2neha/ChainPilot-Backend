import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import { AgentContextDto, ConversationStateDto, MarketInputDto } from './common.dto';

export class DecisionAgentDto {
    @ApiProperty({ type: () => AgentContextDto })
    @ValidateNested()
    @Type(() => AgentContextDto)
    context!: AgentContextDto;

    @ApiProperty({ type: () => ConversationStateDto })
    @ValidateNested()
    @Type(() => ConversationStateDto)
    state!: ConversationStateDto;

    @ValidateNested()
    @Type(() => MarketInputDto)
    market!: MarketInputDto;

    @ApiProperty({ required: false, default: true })
    @IsOptional()
    @IsBoolean()
    useLlm?: boolean;
}