import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';
import type { StorageEnv } from './storage.env';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface StorageService {
  /**
   * Stores an image under its content hash, in the household's folder when
   * one is given, so a household's images can be listed and deleted.
   */
  put(
    buffer: Buffer,
    mediaType: ImageMediaType,
    householdId?: string,
  ): Promise<{ key: string }>;
  exists(key: string): Promise<boolean>;
  getSignedUrl(key: string, expiresInSec?: number): Promise<string>;
}

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
export const STORAGE_ENV = Symbol('STORAGE_ENV');

const EXTENSION_MAP: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const maybe = err as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (maybe.name === 'NotFound') {
    return true;
  }
  if (
    typeof maybe.$metadata === 'object' &&
    maybe.$metadata !== null &&
    maybe.$metadata.httpStatusCode === 404
  ) {
    return true;
  }
  return false;
}

@Injectable()
export class S3StorageService implements StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(STORAGE_ENV) env: StorageEnv) {
    this.bucket = env.bucket;
    this.client = new S3Client({
      region: env.region,
      endpoint: env.endpoint,
      forcePathStyle: env.forcePathStyle,
      credentials: {
        accessKeyId: env.accessKey,
        secretAccessKey: env.secretKey,
      },
    });
  }

  async put(
    buffer: Buffer,
    mediaType: ImageMediaType,
    householdId?: string,
  ): Promise<{ key: string }> {
    const ext = Object.hasOwn(EXTENSION_MAP, mediaType)
      ? EXTENSION_MAP[mediaType]
      : undefined;
    if (!ext) {
      throw new Error(`Unsupported image media type: ${String(mediaType)}`);
    }
    const hash = createHash('sha256').update(buffer).digest('hex');
    const dir = householdId ? `ai/images/${householdId}` : 'ai/images';
    const key = `${dir}/${hash}.${ext}`;
    // Written even when the key exists: a rewrite restarts the bucket
    // lifecycle expiry, so a re-uploaded photo lives as long as a new one.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mediaType,
      }),
    );
    return { key };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return false;
      }
      throw err;
    }
  }

  async getSignedUrl(key: string, expiresInSec = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSec },
    );
  }

  // Utility used by tests and the dev init flow. Idempotent.
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created S3 bucket '${this.bucket}'`);
    }
  }
}
