import { applyDecorators } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { MaxBytes } from '../../../common/validators/max-bytes';

export const PASSWORD_MIN_LENGTH = 8;
// bcrypt ignores everything past 72 bytes, so a longer password would be
// accepted with only its prefix actually checked.
export const PASSWORD_MAX_BYTES = 72;

/** Rules for a password being set (registration, change). */
export function IsNewPassword(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH),
    MaxBytes(PASSWORD_MAX_BYTES),
  );
}
