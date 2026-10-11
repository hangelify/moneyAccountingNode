import {
  IsEmail,
  IsString,
  IsOptional,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NormalizeEmail } from '../../../common/transforms/normalize-email';
import {
  IsNewPassword,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from './password.decorator';

// varchar(255) columns of the users table.
const NAME_MAX_LENGTH = 255;

export class RegisterDto {
  @ApiProperty({
    description: 'User email address',
    example: 'user@example.com',
  })
  @NormalizeEmail()
  @IsEmail()
  email!: string;

  @ApiProperty({
    description: `User password: at least ${PASSWORD_MIN_LENGTH} characters, at most ${PASSWORD_MAX_BYTES} bytes in UTF-8`,
    example: 'password123',
    minLength: PASSWORD_MIN_LENGTH,
  })
  @IsNewPassword()
  password!: string;

  @ApiProperty({
    description: 'User first name',
    example: 'John',
    maxLength: NAME_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  first_name!: string;

  @ApiPropertyOptional({
    description: 'User last name',
    example: 'Doe',
    maxLength: NAME_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(NAME_MAX_LENGTH)
  @IsOptional()
  last_name?: string;

  @ApiPropertyOptional({
    description: 'Username (optional)',
    example: 'johndoe',
    maxLength: NAME_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(NAME_MAX_LENGTH)
  @IsOptional()
  username?: string;
}
