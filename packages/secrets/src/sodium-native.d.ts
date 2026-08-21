/**
 * `@types/sodium-native` on npm is pinned to the v2 API and has no declarations for
 * `crypto_aead_xchacha20poly1305_ietf_*` (`sodium-native` is at v5 here) — pulling it in would
 * be dead weight that still leaves the one API this package calls untyped. This is a minimal,
 * accurate ambient module scoped to exactly the functions `crypto.ts` uses, so strict mode holds
 * with no `as`-casting anywhere near key material.
 *
 * **Declared as a default export, and imported as one.** `sodium-native` is CJS whose members
 * are attached to `module.exports` by the native binding at load time, so `cjs-module-lexer`
 * cannot see them statically. Node's ESM interop therefore synthesizes a namespace that is
 * *missing* most of them — under `node --import tsx`, `import * as sodium` yields a namespace
 * where `crypto_aead_xchacha20poly1305_ietf_KEYBYTES` is `undefined`, which made `KEY_BYTES`
 * undefined at module load and `randomDek()` throw `invalid size`. That is how the engine runs
 * (`node --import tsx apps/engine/src/main.ts`), so the whole secrets subsystem was dead in the
 * deployed process while the suite stayed green — vitest's transform produces different interop
 * and hid it. The `default` binding is the real `module.exports` under every loader here, so
 * this shape is the one that works in both.
 */
declare module "sodium-native" {
  /** A `Buffer` allocated by `sodium_malloc` — locked, zeroable, and the type `crypto.ts` uses
   * for every buffer that ever holds a DEK or a decrypted secret. */
  export type SecureBuffer = Buffer & { readonly secure: true };

  const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  const crypto_aead_xchacha20poly1305_ietf_ABYTES: number;

  function crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext: Buffer,
    message: Buffer,
    additionalData: Buffer | null,
    nsec: Buffer | null,
    npub: Buffer,
    key: Buffer,
  ): void;

  function crypto_aead_xchacha20poly1305_ietf_decrypt(
    message: Buffer,
    nsec: Buffer | null,
    ciphertext: Buffer,
    additionalData: Buffer | null,
    npub: Buffer,
    key: Buffer,
  ): void;

  function sodium_malloc(size: number): SecureBuffer;
  function sodium_memzero(buffer: Buffer): void;
  function randombytes_buf(buffer: Buffer): void;

  const sodium: {
    crypto_aead_xchacha20poly1305_ietf_KEYBYTES: typeof crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: typeof crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
    crypto_aead_xchacha20poly1305_ietf_ABYTES: typeof crypto_aead_xchacha20poly1305_ietf_ABYTES;
    crypto_aead_xchacha20poly1305_ietf_encrypt: typeof crypto_aead_xchacha20poly1305_ietf_encrypt;
    crypto_aead_xchacha20poly1305_ietf_decrypt: typeof crypto_aead_xchacha20poly1305_ietf_decrypt;
    sodium_malloc: typeof sodium_malloc;
    sodium_memzero: typeof sodium_memzero;
    randombytes_buf: typeof randombytes_buf;
  };
  export default sodium;
}
