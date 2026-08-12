/**
 * `@types/sodium-native` on npm is pinned to the v2 API and has no declarations for
 * `crypto_aead_xchacha20poly1305_ietf_*` (`sodium-native` is at v5 here) — pulling it in would
 * be dead weight that still leaves the one API this package calls untyped. This is a minimal,
 * accurate ambient module scoped to exactly the functions `crypto.ts` uses, so strict mode holds
 * with no `as`-casting anywhere near key material.
 */
declare module "sodium-native" {
  /** A `Buffer` allocated by `sodium_malloc` — locked, zeroable, and the type `crypto.ts` uses
   * for every buffer that ever holds a DEK or a decrypted secret. */
  export type SecureBuffer = Buffer & { readonly secure: true };

  export const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_ABYTES: number;

  export function crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext: Buffer,
    message: Buffer,
    additionalData: Buffer | null,
    nsec: Buffer | null,
    npub: Buffer,
    key: Buffer,
  ): void;

  export function crypto_aead_xchacha20poly1305_ietf_decrypt(
    message: Buffer,
    nsec: Buffer | null,
    ciphertext: Buffer,
    additionalData: Buffer | null,
    npub: Buffer,
    key: Buffer,
  ): void;

  export function sodium_malloc(size: number): SecureBuffer;
  export function sodium_memzero(buffer: Buffer): void;
  export function randombytes_buf(buffer: Buffer): void;
}
