import { Injectable, Logger } from '@nestjs/common';
import { BillPhotoService } from './bill-photo.service';
import { BillCrudService } from './bill-crud.service';
import type { ParsedBillResponseDto } from './dto/parsed-bill-response.dto';
import type { ImageMediaType } from '../storage/storage.service';

export interface IngestInput {
  /** The normalized receipt image. */
  image: Buffer;
  mediaType: ImageMediaType;
  imageSha256: string;
  /** Storage key of the image, kept on the draft when given. */
  imageKey?: string;
  householdId: string;
  userId: string;
}

export type IngestResult =
  /** The same photo already has an open draft; no AI call was made. */
  | {
      kind: 'existing';
      billId: string;
      /** The stored draft, as read by the lookup. */
      parsed: ParsedBillResponseDto;
      requestId: string | null;
    }
  | {
      kind: 'draft';
      billId: string;
      duplicate: boolean;
      /** AI request that produced the draft. */
      requestId: string;
      /** What the AI recognized, for callers whose saved draft is gone. */
      parsed: ParsedBillResponseDto;
    }
  | { kind: 'not_a_receipt'; requestId: string }
  /** Recognized and paid for, but the draft could not be saved. */
  | {
      kind: 'save_failed';
      requestId: string;
      parsed: ParsedBillResponseDto;
    };

/**
 * Turns a prepared receipt image into a draft bill. Shared by the
 * parse-photo endpoint and the batch worker. AI errors propagate unchanged.
 */
@Injectable()
export class BillPhotoIngestService {
  private readonly log = new Logger(BillPhotoIngestService.name);

  constructor(
    private readonly billPhoto: BillPhotoService,
    private readonly billCrud: BillCrudService,
  ) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    const { householdId, userId, imageSha256, imageKey } = input;
    // The same photo again: answer with its open draft instead of paying
    // for another AI call.
    const existing = await this.billCrud.findDraftByImageHash(
      householdId,
      imageSha256,
    );
    if (existing) {
      return {
        kind: 'existing',
        billId: existing.parsed.draft_id,
        parsed: existing.parsed,
        requestId: existing.requestId,
      };
    }

    const { parsed, requestId, isReceipt } =
      await this.billPhoto.parseAndCategorize(
        input.image,
        input.mediaType,
        householdId,
        userId,
      );
    if (!isReceipt) {
      return { kind: 'not_a_receipt', requestId };
    }

    try {
      const draft = await this.billCrud.createDraftFromParsed(
        householdId,
        userId,
        parsed,
        { imageSha256, aiRequestId: requestId, imageKey },
      );
      return {
        kind: 'draft',
        billId: draft.id,
        duplicate: draft.duplicate,
        requestId,
        parsed,
      };
    } catch (err) {
      // The AI call is already paid for: hand back what it recognized so the
      // caller can create the bill manually instead of paying again.
      this.log.error(
        `Saving the draft for AI request ${requestId} failed`,
        err instanceof Error ? err.stack : String(err),
      );
      return { kind: 'save_failed', requestId, parsed };
    }
  }
}
