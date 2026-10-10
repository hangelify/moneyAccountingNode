import {
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import sharp from 'sharp';

/** Upload cap enforced by multer while the request is still streaming in. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Anthropic recommends at most 2000 px per side; cost grows with the area.
const MAX_SIDE_PX = 2000;
// Decoding is refused above this, so a tiny file cannot expand into
// gigabytes of pixels (sharp's own default is ~268 MP).
const MAX_INPUT_PIXELS = 100_000_000;
const JPEG_QUALITY = 85;

const ACCEPTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// iPhone photos. The prebuilt sharp binaries decode AVIF only, not HEVC.
const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

export interface PreparedImage {
  buffer: Buffer;
  mediaType: 'image/jpeg';
}

/**
 * Checks the upload's real type by its content (the client's Content-Type is
 * ignored), then re-encodes it: EXIF orientation applied, downscaled to fit
 * MAX_SIDE_PX, transparency flattened onto white, every metadata block
 * (EXIF, GPS, ICC) dropped. Only the result may reach storage or an AI
 * provider.
 */
export async function prepareReceiptImage(
  input: Buffer,
): Promise<PreparedImage> {
  const { fileTypeFromBuffer } = await import('file-type');
  const detected = await fileTypeFromBuffer(input);
  if (detected && HEIC_MIME_TYPES.has(detected.mime)) {
    throw new UnsupportedMediaTypeException(
      'HEIC photos are not supported; send a JPEG, PNG or WebP (on iPhone: Settings → Camera → Formats → Most Compatible)',
    );
  }
  if (!detected || !ACCEPTED_MIME_TYPES.has(detected.mime)) {
    throw new UnsupportedMediaTypeException(
      'The image must be a JPEG, PNG or WebP file',
    );
  }

  try {
    const buffer = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: MAX_SIDE_PX,
        height: MAX_SIDE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    return { buffer, mediaType: 'image/jpeg' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/pixel limit/i.test(message)) {
      throw new PayloadTooLargeException(
        'The image has too many pixels; send a smaller photo',
      );
    }
    throw new UnprocessableEntityException('The image could not be decoded');
  }
}
