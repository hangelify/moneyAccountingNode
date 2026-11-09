import { Logger } from '@nestjs/common';
import { BillPhotoIngestService } from './bill-photo-ingest.service';
import type { IngestInput } from './bill-photo-ingest.service';

describe('BillPhotoIngestService', () => {
  const parseAndCategorize = jest.fn();
  const findDraftByImageHash = jest.fn();
  const createDraftFromParsed = jest.fn();
  let service: BillPhotoIngestService;

  const input: IngestInput = {
    image: Buffer.from('jpeg-bytes'),
    mediaType: 'image/jpeg',
    imageSha256: 'sha-1',
    householdId: 'hh-1',
    userId: 'user-1',
  };

  beforeEach(() => {
    parseAndCategorize.mockReset();
    findDraftByImageHash.mockReset();
    createDraftFromParsed.mockReset();
    service = new BillPhotoIngestService(
      { parseAndCategorize } as never,
      { findDraftByImageHash, createDraftFromParsed } as never,
    );
  });

  it('answers with the open draft of the same image without calling the AI', async () => {
    findDraftByImageHash.mockResolvedValue({
      parsed: { draft_id: 'draft-old' },
      requestId: 'req-old',
    });

    await expect(service.ingest(input)).resolves.toEqual({
      kind: 'existing',
      billId: 'draft-old',
      parsed: { draft_id: 'draft-old' },
      requestId: 'req-old',
    });
    expect(findDraftByImageHash).toHaveBeenCalledWith('hh-1', 'sha-1');
    expect(parseAndCategorize).not.toHaveBeenCalled();
    expect(createDraftFromParsed).not.toHaveBeenCalled();
  });

  it('parses, saves the draft and passes the image key through', async () => {
    const parsed = { items: [{ name: 'BREAD' }] };
    findDraftByImageHash.mockResolvedValue(null);
    parseAndCategorize.mockResolvedValue({
      parsed,
      requestId: 'req-1',
      isReceipt: true,
    });
    createDraftFromParsed.mockResolvedValue({
      id: 'draft-1',
      duplicate: false,
    });

    const res = await service.ingest({ ...input, imageKey: 'bills/a.jpg' });

    expect(parseAndCategorize).toHaveBeenCalledWith(
      input.image,
      'image/jpeg',
      'hh-1',
      'user-1',
    );
    expect(createDraftFromParsed).toHaveBeenCalledWith(
      'hh-1',
      'user-1',
      parsed,
      { imageSha256: 'sha-1', aiRequestId: 'req-1', imageKey: 'bills/a.jpg' },
    );
    expect(res).toEqual({
      kind: 'draft',
      billId: 'draft-1',
      duplicate: false,
      requestId: 'req-1',
      parsed,
    });
  });

  it('reports a duplicate draft', async () => {
    findDraftByImageHash.mockResolvedValue(null);
    parseAndCategorize.mockResolvedValue({
      parsed: { items: [] },
      requestId: 'req-1',
      isReceipt: true,
    });
    createDraftFromParsed.mockResolvedValue({ id: 'draft-2', duplicate: true });

    await expect(service.ingest(input)).resolves.toMatchObject({
      kind: 'draft',
      billId: 'draft-2',
      duplicate: true,
    });
  });

  it('reports a photo that is not a receipt and saves no draft', async () => {
    findDraftByImageHash.mockResolvedValue(null);
    parseAndCategorize.mockResolvedValue({
      parsed: { items: [] },
      requestId: 'req-nr',
      isReceipt: false,
    });

    await expect(service.ingest(input)).resolves.toEqual({
      kind: 'not_a_receipt',
      requestId: 'req-nr',
    });
    expect(createDraftFromParsed).not.toHaveBeenCalled();
  });

  it('keeps the parsed bill when the draft cannot be saved, and logs it', async () => {
    const parsed = { items: [{ name: 'BREAD' }] };
    findDraftByImageHash.mockResolvedValue(null);
    parseAndCategorize.mockResolvedValue({
      parsed,
      requestId: 'req-9',
      isReceipt: true,
    });
    createDraftFromParsed.mockRejectedValue(
      new Error('numeric field overflow'),
    );
    const logSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(service.ingest(input)).resolves.toEqual({
      kind: 'save_failed',
      requestId: 'req-9',
      parsed,
    });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('lets AI errors propagate unchanged', async () => {
    const boom = new Error('gateway down');
    findDraftByImageHash.mockResolvedValue(null);
    parseAndCategorize.mockRejectedValue(boom);

    await expect(service.ingest(input)).rejects.toBe(boom);
    expect(createDraftFromParsed).not.toHaveBeenCalled();
  });
});
