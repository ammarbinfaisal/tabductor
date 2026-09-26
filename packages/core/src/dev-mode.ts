/** Runtime flag also works for local containers built with NODE_ENV=production. */
export function isDevMode(): boolean {
  if (process.env.TABDUCTOR_DEV_MODE !== undefined) return process.env.TABDUCTOR_DEV_MODE === "1";
  return process.env.NODE_ENV === undefined || process.env.NODE_ENV === "development";
}
