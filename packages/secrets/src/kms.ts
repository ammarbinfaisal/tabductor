import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { AppError, type Config } from "@tabductor/core";
import { fileKeyWrapper, type KeyWrapper } from "./crypto.js";

/** Uses the workload credential chain; no AWS credentials are persisted in application data. */
export function kmsKeyWrapper(keyArn: string, region: string, client = new KMSClient({ region })): KeyWrapper {
  const context = { application: "tabductor", purpose: "envelope-key" };
  if (!/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-zA-Z0-9-]+$/.test(keyArn)) throw new AppError("kms_key_invalid", "an immutable KMS key ARN is required");
  return {
    async wrap(dek) {
      const result = await client.send(new EncryptCommand({ KeyId: keyArn, Plaintext: dek, EncryptionContext: context }));
      if (!result.CiphertextBlob || result.KeyId !== keyArn) throw new AppError("kms_wrap_failed", "KMS did not return the expected key");
      return { wrapped: Buffer.from(result.CiphertextBlob), kekRef: keyArn };
    },
    async unwrap(wrapped, kekRef) {
      // Old KMS keys remain usable during rotation if the workload role still permits them.
      if (!/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-zA-Z0-9-]+$/.test(kekRef)) throw new AppError("kms_key_invalid", "invalid stored KMS key reference");
      const result = await client.send(new DecryptCommand({ KeyId: kekRef, CiphertextBlob: wrapped, EncryptionContext: context }));
      if (!result.Plaintext || result.Plaintext.byteLength !== 32) throw new AppError("kms_unwrap_failed", "KMS returned an invalid data key");
      const plaintext = Buffer.from(result.Plaintext);
      result.Plaintext.fill(0);
      return plaintext;
    },
  };
}

export function configuredKeyWrapper(config: Pick<Config, "SECRETS_KMS_KEY_ARN" | "AWS_REGION" | "SECRETS_KEK_FILE_PATH" | "TABDUCTOR_DEPLOYMENT_MODE">): KeyWrapper {
  if (config.SECRETS_KMS_KEY_ARN) return kmsKeyWrapper(config.SECRETS_KMS_KEY_ARN, config.AWS_REGION);
  if (config.TABDUCTOR_DEPLOYMENT_MODE === "hosted") throw new AppError("kms_required", "hosted deployments require KMS wrapping");
  return fileKeyWrapper(config.SECRETS_KEK_FILE_PATH);
}
