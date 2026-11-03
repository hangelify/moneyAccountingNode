import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNVERIFIED_KEY = 'allowUnverified';

// Opens a JwtAuthGuard route to users whose email is not verified yet.
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED_KEY, true);
