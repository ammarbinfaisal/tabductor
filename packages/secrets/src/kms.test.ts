import { expect, it, vi } from "vitest";
import { KMSClient, DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";
import { configuredKeyWrapper, kmsKeyWrapper } from "./kms.js";
import { loadConfig } from "@tabductor/core";

it("binds KMS wrapping to the application context and zeroes the SDK plaintext buffer", async () => {
  const keyArn = "arn:aws:kms:ap-southeast-2:523227112806:key/fixture-key";
  const client = new KMSClient({ region: "ap-southeast-2" });
  const plaintext = new Uint8Array(32).fill(42);
  const send = vi.spyOn(client, "send").mockImplementation(async (command) => {
    expect(command.input).toMatchObject({ KeyId: keyArn, EncryptionContext: { application: "tabductor", purpose: "envelope-key" } });
    if (command instanceof EncryptCommand) return { CiphertextBlob: Buffer.from("wrapped"), KeyId: keyArn };
    expect(command).toBeInstanceOf(DecryptCommand);
    return { Plaintext: plaintext };
  });
  const wrapper = kmsKeyWrapper(keyArn, "ap-southeast-2", client);
  const sealed = await wrapper.wrap(Buffer.alloc(32, 42));
  expect(await wrapper.unwrap(sealed.wrapped, sealed.kekRef)).toEqual(Buffer.alloc(32, 42));
  expect(plaintext.every((byte) => byte === 0)).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
  await expect(wrapper.unwrap(sealed.wrapped, "file-key-v1")).rejects.toMatchObject({ code: "kms_key_invalid" });
  expect(send).toHaveBeenCalledTimes(2);
});

it("refuses a file wrapping key in hosted mode", () => {
  expect(() => configuredKeyWrapper(loadConfig({ TABDUCTOR_DEPLOYMENT_MODE: "hosted" }))).toThrow("hosted deployments require KMS");
});
