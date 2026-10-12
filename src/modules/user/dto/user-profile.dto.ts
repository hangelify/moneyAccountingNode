import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Currency } from '../../../types/currency.enum';
import { LanguageCode } from '../../../types/language-code.enum';

export class UserProfileDto {
  @ApiProperty({
    description: 'User unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  id!: string;

  @ApiProperty({
    description: 'User email address',
    example: 'user@example.com',
  })
  email!: string;

  @ApiProperty({
    description:
      'Whether the email address is confirmed; household invites need it',
    example: true,
  })
  email_verified!: boolean;

  @ApiProperty({
    description: 'User first name',
    example: 'John',
  })
  first_name!: string;

  @ApiPropertyOptional({
    description: 'User last name',
    example: 'Doe',
  })
  last_name?: string;

  @ApiPropertyOptional({
    description: 'Username',
    example: 'johndoe',
  })
  username?: string;

  @ApiProperty({
    description: 'User currency preference',
    enum: Currency,
    example: Currency.EUR,
  })
  currency!: Currency;

  @ApiPropertyOptional({
    description: 'User language preference',
    enum: LanguageCode,
    example: LanguageCode.EN,
  })
  language_code?: LanguageCode;

  @ApiProperty({
    description: 'Account creation date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  created_at!: Date;

  @ApiProperty({
    description: 'Last update date',
    example: '2025-01-01T00:00:00.000Z',
    type: Date,
  })
  updated_at!: Date;
}
