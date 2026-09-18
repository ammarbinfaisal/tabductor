import { randomDek, sealValue, unsealValue, zero, type KeyWrapper } from "./crypto.js";

export type EncryptedEnvelope = { ciphertext: string; nonce: string; wrapped: string; kekRef: string };

/** Used for server-side provider credentials and profile snapshots; callers supply the key wrapper. */
export async function encryptEnvelope(wrapper: KeyWrapper, value: Buffer): Promise<EncryptedEnvelope> {
  const dek = randomDek();
  try {
    const sealed = sealValue(dek, value);
    const key = await wrapper.wrap(dek);
    return { ciphertext: sealed.ciphertext.toString("base64"), nonce: sealed.nonce.toString("base64"),
      wrapped: key.wrapped.toString("base64"), kekRef: key.kekRef };
  } finally { zero(dek); }
}

/** Plaintext lives only for the duration of an operation and is zeroed even on failure. */
export async function withEnvelope<T>(wrapper: KeyWrapper, envelope: EncryptedEnvelope,
  operation: (value: Buffer) => Promise<T>): Promise<T> {
  const dek = await wrapper.unwrap(Buffer.from(envelope.wrapped, "base64"), envelope.kekRef);
  let value: Buffer | undefined;
  try {
    value = unsealValue(dek, { ciphertext: Buffer.from(envelope.ciphertext, "base64"), nonce: Buffer.from(envelope.nonce, "base64") });
    return await operation(value);
  } finally { zero(dek); if (value) zero(value); }
}
