import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class AiAgentMessageDto {
    @ApiProperty({ example: 'I want to grow my portfolio' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    message!: string;
}