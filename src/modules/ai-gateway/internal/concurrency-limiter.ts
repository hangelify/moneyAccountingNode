/**
 * Non-blocking counting semaphore. The count lives in this process only, so
 * with N instances up to N × `max` calls may run at once.
 */
export class ConcurrencyLimiter {
  private active = 0;

  constructor(private readonly max: number) {}

  /** Returns a release function, or `null` when every slot is taken. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}
