/**
 * Loaded by `tests/system/secrets-loader.test.ts` through `node --import tsx` — the loader the
 * engine itself runs under. Kept as a file rather than an inline `-e` string because `-e` gets
 * a different resolution context than a real module, and the whole point is to reproduce the
 * engine's exactly.
 */
import { fileKeyWrapper, randomDek } from "@tabductor/secrets";

const [, , kekPath] = process.argv;
if (!kekPath) throw new Error("usage: secrets-roundtrip.ts <kek-path>");

const dek = randomDek();
const wrapper = fileKeyWrapper(kekPath);
const { wrapped, kekRef } = await wrapper.wrap(dek);
const unwrapped = await wrapper.unwrap(wrapped, kekRef);
if (Buffer.compare(unwrapped, dek) !== 0) throw new Error("dek did not survive the round trip");
console.log("ok");
