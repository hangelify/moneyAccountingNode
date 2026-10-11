import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';

export const PASSWORD_HASH_COST = 12;
// Cost of the hashes stored before PASSWORD_HASH_COST was raised.
const LEGACY_HASH_COST = 10;

export interface PasswordCheck {
  valid: boolean;
  /** The hash is valid but weaker than PASSWORD_HASH_COST. */
  needsRehash: boolean;
}

@Injectable()
export class PasswordService implements OnModuleInit {
  // Random hashes per cost, compared against to spend bcrypt work without a
  // real hash: for an unknown email, and to pad a failed check of a weaker
  // hash. Either way a failed login takes as long as one at the current cost
  // and does not reveal which emails exist.
  private readonly dummyHashes = new Map<number, Promise<string>>();

  // Computed up front so the first failed login does not pay for an extra
  // hash and stand out by its timing.
  onModuleInit(): void {
    void this.dummyHash(PASSWORD_HASH_COST);
    void this.dummyHash(LEGACY_HASH_COST);
  }

  hash(password: string): Promise<string> {
    return bcrypt.hash(password, PASSWORD_HASH_COST);
  }

  async verify(password: string, hash: string): Promise<PasswordCheck> {
    const valid = await bcrypt.compare(password, hash);
    const cost = this.costOf(hash);
    if (!valid) {
      await this.padToCurrentCost(password, cost);
    }
    return { valid, needsRehash: valid && cost < PASSWORD_HASH_COST };
  }

  async verifyAgainstDummy(password: string): Promise<false> {
    await bcrypt.compare(password, await this.dummyHash(PASSWORD_HASH_COST));
    return false;
  }

  // bcrypt work doubles with each cost step: 2^current = 2^(current - cost)
  // comparisons at `cost`, one of which has already been made.
  private async padToCurrentCost(
    password: string,
    cost: number,
  ): Promise<void> {
    if (cost >= PASSWORD_HASH_COST) return;
    const dummy = await this.dummyHash(cost);
    for (let i = 1; i < 2 ** (PASSWORD_HASH_COST - cost); i++) {
      await bcrypt.compare(password, dummy);
    }
  }

  private costOf(hash: string): number {
    try {
      return bcrypt.getRounds(hash);
    } catch {
      // Not a bcrypt hash: nothing to upgrade or pad.
      return PASSWORD_HASH_COST;
    }
  }

  private dummyHash(cost: number): Promise<string> {
    let hash = this.dummyHashes.get(cost);
    if (!hash) {
      hash = bcrypt.hash(randomUUID(), cost);
      this.dummyHashes.set(cost, hash);
    }
    return hash;
  }
}
