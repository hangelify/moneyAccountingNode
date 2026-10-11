import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LogoutDto {
  @ApiProperty({
    description:
      'Mobile mode only: refresh token to revoke. Web mode reads the ' +
      'refresh_token cookie. If neither is present, the current session ' +
      'is revoked.',
    required: false,
  })
  @IsOptional()
  @IsString()
  refresh_token?: string;
}
