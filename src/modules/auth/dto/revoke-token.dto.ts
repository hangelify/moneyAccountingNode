import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RevokeTokenDto {
  @ApiProperty({
    description:
      'Refresh token whose session is revoked. Required in mobile mode ' +
      '(X-Client-Type: mobile); ignored in web mode, which reads the ' +
      'refresh_token cookie.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  refresh_token?: string;

  // RFC 7009 §2.1 lets clients send a hint; only refresh tokens are
  // revocable here, so the value is accepted and ignored.
  @ApiProperty({
    description: 'Accepted and ignored (RFC 7009 §2.1)',
    required: false,
    example: 'refresh_token',
  })
  @IsOptional()
  @IsString()
  token_type_hint?: string;
}
