import { Module } from '@nestjs/common';
import { RETENTION_CONFIG, readRetentionConfig } from './retention.env';
import { RETENTION_BATCH_SIZE, RetentionService } from './retention.service';

@Module({
  providers: [
    RetentionService,
    { provide: RETENTION_CONFIG, useFactory: readRetentionConfig },
    { provide: RETENTION_BATCH_SIZE, useValue: 5000 },
  ],
})
export class RetentionModule {}
