import {
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import sharp from 'sharp';
import { prepareReceiptImage } from './receipt-image';

const GPS_EXIF = {
  IFD0: { Make: 'TestCam', Model: 'Receipt 1' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 31/1 0/1' },
};

function solid(width: number, height: number): sharp.Sharp {
  return sharp({
    create: { width, height, channels: 3, background: '#808080' },
  });
}

describe('prepareReceiptImage', () => {
  it('downscales a large PNG to a JPEG of at most 2000 px without EXIF or GPS', async () => {
    const png = await solid(4000, 3000).withExif(GPS_EXIF).png().toBuffer();
    expect((await sharp(png).metadata()).exif).toBeDefined();

    const out = await prepareReceiptImage(png);

    expect(out.mediaType).toBe('image/jpeg');
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(1500);
    expect(meta.exif).toBeUndefined();
    expect(out.buffer.includes('TestCam')).toBe(false);
  });

  it('does not enlarge a small image', async () => {
    const jpeg = await solid(300, 200).jpeg().toBuffer();

    const out = await prepareReceiptImage(jpeg);

    const meta = await sharp(out.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([300, 200]);
  });

  it('applies the EXIF orientation, so the result is upright and has no orientation tag', async () => {
    // Stored landscape, tagged "rotate 90° CW": the photo is really portrait.
    const rotated = await solid(400, 200)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(rotated).metadata()).orientation).toBe(6);

    const out = await prepareReceiptImage(rotated);

    const meta = await sharp(out.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([200, 400]);
    expect(meta.orientation).toBeUndefined();
  });

  it('accepts WebP', async () => {
    const webp = await solid(50, 50).webp().toBuffer();

    const out = await prepareReceiptImage(webp);

    expect((await sharp(out.buffer).metadata()).format).toBe('jpeg');
  });

  it('flattens transparency onto white instead of black', async () => {
    const transparent = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const out = await prepareReceiptImage(transparent);

    const { data } = await sharp(out.buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });

  it('rejects a text file with 415, whatever it is named', async () => {
    const err = await prepareReceiptImage(
      Buffer.from('just some text, not a receipt photo'),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('rejects a recognized but non-whitelisted image type (GIF) with 415', async () => {
    const gif = await solid(10, 10).gif().toBuffer();

    const err = await prepareReceiptImage(gif).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it.each(['heic', 'hevc'])(
    'rejects HEIC (brand %s) with 415 and tells the user how to send a JPEG',
    async (brand) => {
      // ISO-BMFF "ftyp" box with an iPhone brand ("hevc": HEIC sequence).
      const heic = Buffer.concat([
        Buffer.from([0, 0, 0, 0x18]),
        Buffer.from(`ftyp${brand}`, 'ascii'),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from(`mif1${brand}`, 'ascii'),
        Buffer.alloc(64),
      ]);

      const err = await prepareReceiptImage(heic).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnsupportedMediaTypeException);
      expect((err as UnsupportedMediaTypeException).message).toMatch(/HEIC/);
    },
  );

  it('answers 422 when the bytes look like a JPEG but cannot be decoded', async () => {
    const jpeg = await solid(100, 100).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, 40);

    const err = await prepareReceiptImage(truncated).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
  });

  it('answers 413 for an image with too many pixels to decode safely', async () => {
    // Tiny file, huge canvas: a decompression bomb.
    const bomb = await sharp({
      create: { width: 12000, height: 10000, channels: 3, background: '#fff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const err = await prepareReceiptImage(bomb).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PayloadTooLargeException);
  });
});
