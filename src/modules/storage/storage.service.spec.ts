import { createHash } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3StorageService } from './storage.service';
import type { StorageEnv } from './storage.env';

jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/s3-request-presigner');

const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<
  typeof getSignedUrl
>;
const MockedS3Client = S3Client as unknown as jest.Mock;

function makeEnv(overrides: Partial<StorageEnv> = {}): StorageEnv {
  return {
    region: 'us-east-1',
    bucket: 'test-bucket',
    accessKey: 'ak',
    secretKey: 'sk',
    endpoint: 'http://minio.test:9000',
    forcePathStyle: true,
    ...overrides,
  };
}

type SendFn = (cmd: unknown) => Promise<unknown>;

function wireSendMock(send: SendFn): void {
  MockedS3Client.mockImplementation(() => ({ send }));
}

class NotFoundError extends Error {
  override readonly name = 'NotFound';
  readonly $metadata = { httpStatusCode: 404 };
}

describe('S3StorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('put', () => {
    it('stores the buffer at ai/images/<sha256>.<ext> and returns the key', async () => {
      const buf = Buffer.from('fake-png-bytes');
      const expectedHash = createHash('sha256').update(buf).digest('hex');
      const send = jest
        .fn()
        .mockImplementationOnce(() =>
          Promise.reject(new NotFoundError('missing')),
        )
        .mockImplementationOnce(() => Promise.resolve({}));
      wireSendMock(send);

      const svc = new S3StorageService(makeEnv());
      const { key } = await svc.put(buf, 'image/png');

      expect(key).toBe(`ai/images/${expectedHash}.png`);
      expect(send).toHaveBeenNthCalledWith(1, expect.any(HeadObjectCommand));
      expect(send).toHaveBeenNthCalledWith(2, expect.any(PutObjectCommand));
    });

    it('uses the jpg extension for image/jpeg', async () => {
      const buf = Buffer.from('j');
      const send = jest
        .fn()
        .mockImplementationOnce(() =>
          Promise.reject(new NotFoundError('missing')),
        )
        .mockImplementationOnce(() => Promise.resolve({}));
      wireSendMock(send);

      const svc = new S3StorageService(makeEnv());
      const { key } = await svc.put(buf, 'image/jpeg');

      expect(key.endsWith('.jpg')).toBe(true);
    });

    it('refuses an unknown media type instead of writing a ".undefined" key', async () => {
      const send = jest.fn().mockResolvedValue({});
      wireSendMock(send);

      const svc = new S3StorageService(makeEnv());
      await expect(
        svc.put(Buffer.from('x'), 'image/jpg' as never),
      ).rejects.toThrow(/image\/jpg/);

      expect(send).not.toHaveBeenCalled();
    });

    it('dedupes: skips PUT when the object already exists', async () => {
      const buf = Buffer.from('already-there');
      const send = jest.fn().mockResolvedValue({});
      wireSendMock(send);

      const svc = new S3StorageService(makeEnv());
      await svc.put(buf, 'image/png');

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
    });

    it('propagates non-404 errors from HEAD', async () => {
      const send = jest.fn().mockRejectedValue(
        Object.assign(new Error('denied'), {
          $metadata: { httpStatusCode: 403 },
        }),
      );
      wireSendMock(send);

      const svc = new S3StorageService(makeEnv());
      await expect(svc.put(Buffer.from('x'), 'image/png')).rejects.toThrow(
        'denied',
      );
    });
  });

  describe('exists', () => {
    it('returns true when HEAD succeeds', async () => {
      wireSendMock(jest.fn().mockResolvedValue({}));
      const svc = new S3StorageService(makeEnv());
      expect(await svc.exists('ai/images/x.png')).toBe(true);
    });

    it('returns false when HEAD reports NotFound by name', async () => {
      wireSendMock(jest.fn().mockRejectedValue(new NotFoundError('missing')));
      const svc = new S3StorageService(makeEnv());
      expect(await svc.exists('ai/images/missing.png')).toBe(false);
    });

    it('returns false when HEAD reports 404 via $metadata', async () => {
      wireSendMock(
        jest.fn().mockRejectedValue({
          $metadata: { httpStatusCode: 404 },
        }),
      );
      const svc = new S3StorageService(makeEnv());
      expect(await svc.exists('ai/images/missing.png')).toBe(false);
    });

    it('throws on non-404 errors', async () => {
      wireSendMock(
        jest.fn().mockRejectedValue(
          Object.assign(new Error('boom'), {
            $metadata: { httpStatusCode: 500 },
          }),
        ),
      );
      const svc = new S3StorageService(makeEnv());
      await expect(svc.exists('k')).rejects.toThrow('boom');
    });
  });

  describe('getSignedUrl', () => {
    it('delegates to @aws-sdk/s3-request-presigner with a GetObjectCommand', async () => {
      wireSendMock(jest.fn());
      mockedGetSignedUrl.mockResolvedValue('https://signed.example');

      const svc = new S3StorageService(makeEnv());
      const url = await svc.getSignedUrl('ai/images/abc.png', 60);

      expect(url).toBe('https://signed.example');
      expect(mockedGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(GetObjectCommand),
        { expiresIn: 60 },
      );
    });

    it('defaults the expiry to 15 minutes', async () => {
      wireSendMock(jest.fn());
      mockedGetSignedUrl.mockResolvedValue('https://signed.example');

      const svc = new S3StorageService(makeEnv());
      await svc.getSignedUrl('k');

      expect(mockedGetSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(GetObjectCommand),
        { expiresIn: 900 },
      );
    });
  });

  describe('ensureBucket', () => {
    it('no-ops when the bucket already exists', async () => {
      const send = jest.fn().mockResolvedValue({});
      wireSendMock(send);

      const svc = new S3StorageService(makeEnv());
      await svc.ensureBucket();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.any(HeadBucketCommand));
    });

    it('creates the bucket when HEAD fails', async () => {
      const send = jest
        .fn()
        .mockImplementationOnce(() =>
          Promise.reject(new NotFoundError('missing')),
        )
        .mockImplementationOnce(() => Promise.resolve({}));
      wireSendMock(send);

      const svc = new S3StorageService(makeEnv());
      await svc.ensureBucket();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenNthCalledWith(1, expect.any(HeadBucketCommand));
      expect(send).toHaveBeenNthCalledWith(2, expect.any(CreateBucketCommand));
    });
  });

  describe('construction', () => {
    it('passes env-derived config to the S3Client', () => {
      wireSendMock(jest.fn());
      new S3StorageService(
        makeEnv({
          region: 'eu-west-1',
          endpoint: 'http://mock:9000',
          forcePathStyle: true,
        }),
      );

      expect(MockedS3Client).toHaveBeenCalledWith({
        region: 'eu-west-1',
        endpoint: 'http://mock:9000',
        forcePathStyle: true,
        credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
      });
    });
  });
});
