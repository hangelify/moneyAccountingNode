import { Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({
    description: 'Token from the link in the verification email',
    example: 'a3f1…(64 hex characters)',
  })
  @Matches(/^[0-9a-f]{64}$/, { message: 'token must be 64 hex characters' })
  token!: string;
}
