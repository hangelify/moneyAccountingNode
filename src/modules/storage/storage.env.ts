import { requireEnv } from '../auth/auth.env';

export interface StorageEnv {
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

export function readStorageEnv(): StorageEnv {
  const forcePathStyleRaw = process.env.S3_FORCE_PATH_STYLE ?? 'false';
  return {
    region: requireEnv('S3_REGION'),
    bucket: requireEnv('S3_BUCKET'),
    accessKey: requireEnv('S3_ACCESS_KEY'),
    secretKey: requireEnv('S3_SECRET_KEY'),
    endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: forcePathStyleRaw === 'true',
  };
}
