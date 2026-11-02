import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsNewPassword,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from './password.decorator';

export class ChangePasswordDto {
  @ApiProperty({ description: 'The password in use now' })
  @IsString()
  @IsNotEmpty()
  current_password!: string;

  @ApiProperty({
    description: `New password: at least ${PASSWORD_MIN_LENGTH} characters, at most ${PASSWORD_MAX_BYTES} bytes in UTF-8`,
    minLength: PASSWORD_MIN_LENGTH,
  })
  @IsNewPassword()
  new_password!: string;
}
