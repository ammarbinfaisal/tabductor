import { TRPCError } from "@trpc/server";
import { accountIdentities, type Db } from "@tabductor/db";
import { and, eq, inArray } from "drizzle-orm";
import { procedure } from "./trpc.js";

const configuredAdmins=()=>(process.env.ADMIN_ACCOUNT_IDS??"").split(",").map(x=>x.trim()).filter(Boolean);

/** Accept stable internal account IDs and Clerk user IDs without trusting request input. */
export async function isAdminAccount(db:Db,accountId:string|undefined){
  if(!accountId)return false;
  const configured=configuredAdmins();
  if(configured.includes(accountId))return true;
  const clerkSubjects=configured.flatMap(value=>value.startsWith("clerk:")?[value.slice("clerk:".length)]:value.startsWith("user_")?[value]:[]);
  if(!clerkSubjects.length)return false;
  const [identity]=await db.select({accountId:accountIdentities.accountId}).from(accountIdentities).where(and(
    eq(accountIdentities.accountId,accountId),eq(accountIdentities.provider,"clerk"),inArray(accountIdentities.subject,clerkSubjects),
  )).limit(1);
  return Boolean(identity);
}

export const adminProcedure=procedure.use(async ({ctx,next})=>{
  if(!await isAdminAccount(ctx.db,ctx.accountId))throw new TRPCError({code:"FORBIDDEN",message:"Administrator access required"});
  return next({ctx:{...ctx,accountId:ctx.accountId!}});
});
