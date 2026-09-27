import { type Db } from "@tabductor/db";
import { encryptEnvelope, withEnvelope, zero, type EncryptedEnvelope, type KeyWrapper } from "@tabductor/secrets";
import { sql } from "drizzle-orm";
import { z } from "zod";
export const proxyCredentialSchema = z.object({ server: z.string().url().refine(value => {
  const url = new URL(value); return ["http:", "https:", "socks5:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}), username: z.string().min(1).max(500), password: z.string().min(1).max(500) }).strict();
export async function saveAccountProxy(db: Db, wrapper: KeyWrapper, accountId: string, hash: string, input: z.input<typeof proxyCredentialSchema>) {
  const bytes = Buffer.from(JSON.stringify(proxyCredentialSchema.parse(input)));
  try {
    const envelope = await encryptEnvelope(wrapper, bytes);
    await db.transaction(async trx => {
      await trx.execute(sql`insert into proxy_accounts(hash,label,account_id) values(${hash},'Account proxy',${accountId})
        on conflict(hash) do update set account_id=excluded.account_id where proxy_accounts.account_id=excluded.account_id`);
      const owner = (await trx.execute<{account_id:string}>(sql`select account_id from proxy_accounts where hash=${hash}`)).rows[0];
      if (owner?.account_id !== accountId) throw new Error("Proxy belongs to another account");
      await trx.execute(sql`insert into account_proxy_credentials(account_id,hash,envelope) values(${accountId},${hash},${JSON.stringify(envelope)}::jsonb)
        on conflict(account_id) do update set hash=excluded.hash,envelope=excluded.envelope`);
    });
  } finally { zero(bytes); }
}
export async function withAccountProxy<T>(db: Db, wrapper: KeyWrapper, accountId: string, use: (proxy: z.infer<typeof proxyCredentialSchema> | undefined) => Promise<T>) {
  const row = (await db.execute<{envelope:EncryptedEnvelope}>(sql`select envelope from account_proxy_credentials where account_id=${accountId}`)).rows[0];
  if (!row) return use(undefined);
  return withEnvelope(wrapper, row.envelope, bytes => use(proxyCredentialSchema.parse(JSON.parse(bytes.toString("utf8")))));
}
