import { newId } from "@tabductor/core";
import { secretGrants, secrets, type Db } from "@tabductor/db";
import { randomDek, sealValue, zero, type KeyWrapper } from "./crypto.js";

/**
 * Secret administration: creating and granting, never reading. Separate from `broker.ts` on
 * purpose — this file's functions are called by an operator/admin surface (a future secrets
 * manager, S7/U3) and by this package's own tests to seed fixtures; the broker's `fill`/
 * `injectIntoMcpArg` are the only run-time, run-scoped entry points, and keeping this file's
 * concerns out of `broker.ts` is what keeps that one "one module, two public methods" true.
 */

export type CreateSecretInput = {
  userId: string;
  name: string;
  description?: string;
  value: string;
  allowedOrigins: string[];
};

/** Encrypts `value` under a fresh DEK, wraps the DEK, and inserts the row. Returns the new
 * secret's id. The plaintext `value` and the DEK are both zeroed before this returns. */
export async function createSecret(db: Db, keyWrapper: KeyWrapper, input: CreateSecretInput): Promise<string> {
  const dek = randomDek();
  const plaintext = Buffer.from(input.value, "utf8");
  try {
    const { ciphertext, nonce } = sealValue(dek, plaintext);
    const { wrapped, kekRef } = await keyWrapper.wrap(dek);
    const id = newId("secret");
    await db.insert(secrets).values({
      id,
      userId: input.userId,
      name: input.name,
      description: input.description ?? "",
      tier: "server",
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      dekWrapped: wrapped.toString("base64"),
      kekRef,
      allowedOrigins: input.allowedOrigins,
    });
    return id;
  } finally {
    zero(dek);
    zero(plaintext);
  }
}

/** Declared now, per techical_plan §14 — *enforcement* is Phase 7 (S7's grant sweep); this
 * subphase's broker does not consult this table. `onConflictDoNothing` because granting a task
 * a secret it already has is a no-op, not an error, matching the composite primary key. */
export async function grantSecret(db: Db, taskId: string, secretName: string): Promise<void> {
  await db.insert(secretGrants).values({ taskId, secretName }).onConflictDoNothing();
}
