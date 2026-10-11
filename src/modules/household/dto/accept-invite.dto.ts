import { IsHexadecimal, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AcceptInviteDto {
  @ApiProperty({
    description: 'Raw invite token from the invite URL (64 hex characters)',
  })
  @IsHexadecimal()
  @Length(64, 64)
  token!: string;
}
