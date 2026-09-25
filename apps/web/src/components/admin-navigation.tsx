import Link from "next/link";
import { accountIdForWebRequest } from "../server/auth-context.js";
import { isAdminAccount } from "../server/admin.js";
export async function AdminNavigation(){let id:string;try{id=await accountIdForWebRequest();}catch{return null;}return isAdminAccount(id)?<Link href="/admin">Admin</Link>:null;}
