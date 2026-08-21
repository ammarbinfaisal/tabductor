import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sodium from "sodium-native";
import { AppError } from "@tabductor/core";

/**
 * Envelope encryption primitives (§16 Threat 4). Every value this module seals is a per-secret
 * random DEK, and every DEK is wrapped by a KEK behind `KeyWrapper` — the server never stores a
 * plaintext KEK, so a database compromise alone yields nothing.
 *
 * **Why `sodium-native` and why the AEAD API, not `crypto_secretbox_*`.** The design docs
 * (`techical_plan.md` §16, `S5b-secrets-broker.md`) name the algorithm as XChaCha20-Poly1305 and
 * point at `sodium-native`'s `crypto_secretbox_*` as the call to use — but libsodium's
 * `crypto_secretbox` construction is XSalsa20-Poly1305, not XChaCha20-Poly1305 (same nonce size,
 * different cipher). The construction actually named XChaCha20-Poly1305 in libsodium is
 * `crypto_aead_xchacha20poly1305_ietf_*`, so this file uses that API instead of the one the docs
 * mention by function name — matching the algorithm the design commits to rather than the
 * parenthetical that misnames it. `sodium-native` itself is the right (only) dependency either
 * way: it is the maintained Node binding to libsodium with prebuilt binaries for this platform,
 * it is what the design docs ask for, and it is the one new dependency this subphase is allowed
 * (`S5b-secrets-broker.md` style constraints).
 *
 * Nothing here hand-rolls a primitive; every export composes one or two libsodium calls.
 */

const KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES; // 32
const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES; // 24
const MAC_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES; // 16

export type Sealed = { ciphertext: Buffer; nonce: Buffer };

/** A fresh random 32-byte DEK in libsodium "secure" memory (`sodium_malloc`) — never a plain
 * `Buffer.alloc`, so the memory is locked and zeroable rather than left to the GC's mercy. */
export function randomDek(): Buffer {
  const dek = sodium.sodium_malloc(KEY_BYTES);
  sodium.randombytes_buf(dek);
  return dek;
}

/** `sodium.sodium_memzero`, given its own name here so every call site reads as "this buffer
 * held plaintext and is now destroyed" rather than an opaque library call. */
export function zero(buf: Buffer): void {
  sodium.sodium_memzero(buf);
}

/** Seals `plaintext` under `key` (a 32-byte DEK) with a fresh random nonce. `plaintext` is the
 * caller's to zero — this function only reads it. */
export function sealValue(key: Buffer, plaintext: Buffer): Sealed {
  if (key.byteLength !== KEY_BYTES) {
    throw new AppError("secrets_key_size_invalid", `key must be ${KEY_BYTES} bytes`);
  }
  const nonce = Buffer.alloc(NONCE_BYTES);
  sodium.randombytes_buf(nonce);
  const ciphertext = Buffer.alloc(plaintext.byteLength + MAC_BYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, plaintext, null, null, nonce, key);
  return { ciphertext, nonce };
}

/**
 * Opens `sealed` under `key`, returning the plaintext in secure memory. **The caller must
 * `zero()` the returned buffer in a `finally` the instant it is done reading it** — this is the
 * one-use-then-destroy discipline §16 requires of every plaintext this package ever produces.
 * Throws (rather than returning something falsy) on a forged or corrupted ciphertext — the
 * AEAD tag either authenticates or it doesn't.
 */
export function unsealValue(key: Buffer, sealed: Sealed): Buffer {
  if (key.byteLength !== KEY_BYTES) {
    throw new AppError("secrets_key_size_invalid", `key must be ${KEY_BYTES} bytes`);
  }
  if (sealed.ciphertext.byteLength < MAC_BYTES) {
    throw new AppError("secrets_ciphertext_invalid", "ciphertext shorter than the AEAD tag");
  }
  const plaintext = sodium.sodium_malloc(sealed.ciphertext.byteLength - MAC_BYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plaintext,
      null,
      sealed.ciphertext,
      null,
      sealed.nonce,
      key,
    );
  } catch (err) {
    zero(plaintext);
    throw new AppError("secrets_decrypt_failed", "ciphertext failed authentication", { cause: err });
  }
  return plaintext;
}

/**
 * What decrypts a DEK. One implementation exists today (`fileKeyWrapper`, dev/test); a KMS
 * implementation (AWS/GCP KMS, Vault Transit) is a later swap behind this exact interface — the
 * broker never imports a concrete `KeyWrapper`, only this type, so which one runs is a config
 * choice at the composition root, not a code change (`S5b-secrets-broker.md`).
 */
export type KeyWrapper = {
  wrap(dek: Buffer): Promise<{ wrapped: Buffer; kekRef: string }>;
  unwrap(wrapped: Buffer, kekRef: string): Promise<Buffer>;
};

/** On-disk shape of a `fileKeyWrapper`'s KEK store: every KEK this file has ever held, by ref,
 * plus which one new wraps use. Old refs are never removed by `wrap` — only `rotateFileKek`
 * adds one — so a secret wrapped under a retired ref still resolves via its own `kek_ref`. */
type KekFileShape = { current: string; keys: Record<string, string> };

function readOrInitKekFile(path: string): KekFileShape {
  if (!existsSync(path)) {
    const ref = "v1";
    const key = randomDek();
    const initial: KekFileShape = { current: ref, keys: { [ref]: key.toString("base64") } };
    zero(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(initial, null, 2), { mode: 0o600 });
    return initial;
  }
  return JSON.parse(readFileSync(path, "utf8")) as KekFileShape;
}

function kekBytes(file: KekFileShape, ref: string, path: string): Buffer {
  const b64 = file.keys[ref];
  if (!b64) {
    throw new AppError("secrets_kek_not_found", `KEK ref "${ref}" is not in ${path}`, {
      details: { kekRef: ref },
    });
  }
  return Buffer.from(b64, "base64");
}

/**
 * The dev/test `KeyWrapper`: a local JSON file holding every KEK this process has ever used, by
 * ref, and which one is current. Read fresh on every call — deliberately no in-memory cache,
 * matching the broker's own "no caching layer" rule, and the only way `rotateFileKek` (run by a
 * separate process, e.g. an ops script) takes effect without a restart.
 *
 * Not the production answer (`techical_plan.md` §16: "the DEK is wrapped by a KEK held in
 * KMS") — it exists so Tier 1 is fully testable before a KMS account exists, and the swap to a
 * real `KeyWrapper` touches configuration, never a call site.
 */
export function fileKeyWrapper(path: string): KeyWrapper {
  return {
    async wrap(dek) {
      const file = readOrInitKekFile(path);
      const kek = kekBytes(file, file.current, path);
      try {
        const { ciphertext, nonce } = sealValue(kek, dek);
        return { wrapped: Buffer.concat([nonce, ciphertext]), kekRef: file.current };
      } finally {
        zero(kek);
      }
    },
    async unwrap(wrapped, kekRef) {
      const file = readOrInitKekFile(path);
      const kek = kekBytes(file, kekRef, path);
      try {
        const nonce = wrapped.subarray(0, NONCE_BYTES);
        const ciphertext = wrapped.subarray(NONCE_BYTES);
        return unsealValue(kek, { ciphertext, nonce });
      } finally {
        zero(kek);
      }
    },
  };
}

/**
 * Ops/test-only: mints a new KEK, makes it the file's `current` (so every wrap from now on uses
 * it), and keeps every prior ref in place. The broker itself never calls this — rotation is an
 * operator action, and the whole point of `kek_ref` on each secret row is that rotating forward
 * never requires touching a secret that already exists.
 */
export function rotateFileKek(path: string): string {
  const file = readOrInitKekFile(path);
  let n = 1;
  while (file.keys[`v${n}`]) n++;
  const ref = `v${n}`;
  const key = randomDek();
  file.keys[ref] = key.toString("base64");
  zero(key);
  file.current = ref;
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  return ref;
}
