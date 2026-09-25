import { TRPCError } from "@trpc/server";
import { procedure } from "./trpc.js";
export function isAdminAccount(accountId:string|undefined){return Boolean(accountId&&(process.env.ADMIN_ACCOUNT_IDS??"").split(",").map(x=>x.trim()).filter(Boolean).includes(accountId));}
export const adminProcedure=procedure.use(({ctx,next})=>{
  if(!isAdminAccount(ctx.accountId))throw new TRPCError({code:"FORBIDDEN",message:"Administrator access required"});
  return next({ctx:{...ctx,accountId:ctx.accountId!}});
});
