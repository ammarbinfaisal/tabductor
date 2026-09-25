/** USD is stored as integer millionths. Never multiply a JS decimal to parse money. */
export const USD_SCALE = 1_000_000;
export function usdMicros(value: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter a USD amount with at most six decimal places");
  const amount = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("USD amount is too large");
  return Number(amount);
}
export function usdDecimal(micros: number): string {
  if (!Number.isSafeInteger(micros)) throw new Error("Invalid USD amount");
  const amount = BigInt(micros), absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${amount < 0n ? "-" : ""}${absolute / 1_000_000n}.${fraction}`;
}
export const formatUsd = (micros: number): string => `$${usdDecimal(micros)}`;
export function scaledAmount(quantity: number, rate: number, divisor = 1): number {
  if (![quantity, rate, divisor].every(Number.isSafeInteger) || quantity < 0 || rate < 0 || divisor < 1) throw new Error("Invalid monetary calculation");
  const value = (BigInt(quantity) * BigInt(rate) + BigInt(divisor) - 1n) / BigInt(divisor);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("USD amount overflow");
  return Number(value);
}
