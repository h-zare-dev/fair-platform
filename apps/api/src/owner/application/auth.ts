import { createHash, randomBytes } from 'node:crypto';

export const IDLE_MS = 30 * 60 * 1000;
export const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export interface OwnerAuthStore {
  bootstrap(hash: string): Promise<boolean>;
  reset(hash: string): Promise<boolean>;
  revoke(): Promise<void>;
  attempt(): Promise<boolean>;
  passwordHash(): Promise<string | null>;
  login(
    expectedHash: string,
    hash: string,
    previousHash: string | null,
  ): Promise<boolean>;
  session(hash: string): Promise<boolean>;
  logout(hash: string): Promise<void>;
  denied(): Promise<void>;
  cleanup(): Promise<void>;
}
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}
export class OwnerAuth {
  constructor(
    private readonly store: OwnerAuthStore,
    private readonly hasher: PasswordHasher,
    private readonly dummyHash: string,
  ) {}
  async bootstrap(password: string): Promise<boolean> {
    return this.store.bootstrap(await this.hasher.hash(password));
  }
  async reset(password: string): Promise<boolean> {
    return this.store.reset(await this.hasher.hash(password));
  }
  async login(
    password: string,
    previous: string | null,
  ): Promise<{ kind: 'ok'; token: string } | { kind: 'denied' | 'limited' }> {
    if (!(await this.store.attempt())) return { kind: 'limited' };
    const hash = await this.store.passwordHash();
    const valid = await this.hasher.verify(hash ?? this.dummyHash, password);
    if (!valid || !hash) {
      await this.store.denied();
      return { kind: 'denied' };
    }
    const token = randomBytes(32).toString('base64url');
    if (
      !(await this.store.login(
        hash,
        tokenHash(token),
        previous ? tokenHash(previous) : null,
      ))
    )
      return { kind: 'denied' };
    return { kind: 'ok', token };
  }
  async authenticated(token: string | null): Promise<boolean> {
    return (
      token !== null &&
      /^[A-Za-z0-9_-]{43}$/.test(token) &&
      this.store.session(tokenHash(token))
    );
  }
  async logout(token: string | null): Promise<void> {
    if (token) await this.store.logout(tokenHash(token));
  }
}
