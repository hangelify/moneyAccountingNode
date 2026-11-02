import { ApiProperty } from '@nestjs/swagger';

export class TokenResponseDto {
  @ApiProperty({
    description: 'JWT access token',
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  })
  access_token!: string;

  @ApiProperty({
    description:
      'JWT refresh token. Mobile mode only; web clients receive it as the ' +
      'HttpOnly refresh_token cookie instead.',
    required: false,
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  })
  refresh_token!: string;

  @ApiProperty({
    description: 'Token expiration time in seconds',
    example: 900,
  })
  expires_in!: number;

  @ApiProperty({
    description: 'Token type',
    example: 'Bearer',
  })
  token_type!: string;
}

// What the auth endpoints return: web mode strips refresh_token (it goes to
// the cookie), mobile mode returns the full TokenResponseDto.
export type ClientTokenResponse = Omit<TokenResponseDto, 'refresh_token'> &
  Partial<Pick<TokenResponseDto, 'refresh_token'>>;
