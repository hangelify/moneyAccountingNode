import { Module } from '@nestjs/common';
import { readStorageEnv } from './storage.env';
import {
  S3StorageService,
  STORAGE_ENV,
  STORAGE_SERVICE,
} from './storage.service';

@Module({
  providers: [
    { provide: STORAGE_ENV, useFactory: () => readStorageEnv() },
    S3StorageService,
    { provide: STORAGE_SERVICE, useExisting: S3StorageService },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
