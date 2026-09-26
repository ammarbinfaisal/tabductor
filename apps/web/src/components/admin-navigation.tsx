import Link from "next/link";
import { accountIdForWebRequest } from "../server/auth-context.js";
import { isAdminAccount } from "../server/admin.js";
import { db } from "../server/db.js";
export async function AdminNavigation(){let id:string;try{id=await accountIdForWebRequest();}catch{return null;}return await isAdminAccount(db(),id)?<Link href="/admin">Admin</Link>:null;}
