import * as argon2 from 'argon2';
import type { PasswordHasher } from '../application/auth.js';
export const passwords: PasswordHasher = {
  hash: (password) => argon2.hash(password, { type: argon2.argon2id }),
  verify: (hash, password) => argon2.verify(hash, password),
};
