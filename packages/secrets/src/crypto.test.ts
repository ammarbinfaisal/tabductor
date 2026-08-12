import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fileKeyWrapper, randomDek, rotateFileKek, sealValue, unsealValue, zero } from "./crypto.js";

/**
 * Pure-function coverage for the envelope-encryption primitives — no DB, no Chrome. The
 * system test (`tests/system/secrets-broker.test.ts`) covers the same round trip through the
 * broker end-to-end; this file is what proves the crypto itself, in isolation, before anything
 * else is layered on top of it.
 */

let dir: string;
let kekPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabductor-secrets-crypto-"));
  kekPath = join(dir, "kek.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("seals and opens a value under a fresh DEK", () => {
  const dek = randomDek();
  const plaintext = Buffer.from("hunter2 but longer", "utf8");
  try {
    const sealed = sealValue(dek, plaintext);
    // The ciphertext is not the plaintext lying around under a different name.
    expect(sealed.ciphertext.includes(plaintext)).toBe(false);
    const opened = unsealValue(dek, sealed);
    try {
      expect(opened.toString("utf8")).toBe(plaintext.toString("utf8"));
    } finally {
      zero(opened);
    }
  } finally {
    zero(dek);
  }
});

it("refuses a forged ciphertext instead of returning garbage", () => {
  const dek = randomDek();
  try {
    const sealed = sealValue(dek, Buffer.from("payload", "utf8"));
    sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 0xff; // flip a bit post-seal
    expect(() => unsealValue(dek, sealed)).toThrow();
  } finally {
    zero(dek);
  }
});

it("wraps and unwraps a DEK through the file KeyWrapper", async () => {
  const wrapper = fileKeyWrapper(kekPath);
  const dek = randomDek();
  const dekCopy = Buffer.from(dek); // `unwrap` must hand back the same bytes; compare before zeroing
  try {
    const { wrapped, kekRef } = await wrapper.wrap(dek);
    const unwrapped = await wrapper.unwrap(wrapped, kekRef);
    try {
      expect(unwrapped.equals(dekCopy)).toBe(true);
    } finally {
      zero(unwrapped);
    }
  } finally {
    zero(dek);
  }
});

it("rotating the KEK file leaves a secret sealed under the old ref still decryptable", async () => {
  const wrapper = fileKeyWrapper(kekPath);
  const dek = randomDek();
  const dekCopy = Buffer.from(dek);
  const { wrapped, kekRef: oldRef } = await wrapper.wrap(dek);
  zero(dek);

  const newRef = rotateFileKek(kekPath);
  expect(newRef).not.toBe(oldRef);

  // A fresh wrap now uses the new ref...
  const dek2 = randomDek();
  const { kekRef: freshRef } = await wrapper.wrap(dek2);
  zero(dek2);
  expect(freshRef).toBe(newRef);

  // ...but the secret wrapped under the retired ref still resolves, via its own stored ref.
  const recovered = await wrapper.unwrap(wrapped, oldRef);
  try {
    expect(recovered.equals(dekCopy)).toBe(true);
  } finally {
    zero(recovered);
  }
});

it("an unknown KEK ref is a typed error, not a silent wrong answer", async () => {
  const wrapper = fileKeyWrapper(kekPath);
  const dek = randomDek();
  const { wrapped } = await wrapper.wrap(dek);
  zero(dek);
  await expect(wrapper.unwrap(wrapped, "v_does_not_exist")).rejects.toThrow(/kek/i);
});
