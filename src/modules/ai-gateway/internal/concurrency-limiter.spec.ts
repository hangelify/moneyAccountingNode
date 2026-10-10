import { ConcurrencyLimiter } from './concurrency-limiter';

describe('ConcurrencyLimiter', () => {
  it('hands out up to `max` slots and refuses the next one', () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });

  it('frees a slot on release', () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = limiter.tryAcquire();
    expect(limiter.tryAcquire()).toBeNull();
    release!();
    expect(limiter.tryAcquire()).not.toBeNull();
  });

  it('ignores a repeated release of the same slot', () => {
    const limiter = new ConcurrencyLimiter(2);
    const release = limiter.tryAcquire()!;
    limiter.tryAcquire();
    release();
    release();
    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });
});
