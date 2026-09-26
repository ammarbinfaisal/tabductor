import { AppError } from "@tabductor/core";
import { workflowDeletions, workflows, type Db } from "@tabductor/db";
import type { BlobStore } from "@tabductor/browser";
import { deprovision } from "@tabductor/store";
import type { Pool } from "pg";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import { audit } from "./billing-prices.js";
import { stopBrowserSession } from "./browser-session-control.js";

export async function requestWorkflowDeletion(db:Db,accountId:string,workflowId:string){
  return db.transaction(async trx=>{
    const [prior]=await trx.select().from(workflowDeletions).where(and(eq(workflowDeletions.workflowId,workflowId),eq(workflowDeletions.accountId,accountId)));
    if(prior)return prior;
    const [workflow]=await trx.select().from(workflows).where(and(eq(workflows.id,workflowId),eq(workflows.accountId,accountId))).for("update");
    if(!workflow)throw new AppError("workflow_not_found","Workflow not found");
    await trx.update(workflows).set({deletingAt:new Date()}).where(eq(workflows.id,workflowId));
    await trx.execute(sql`update schedules set enabled=false where task_id in (select t.id from tasks t join workflow_versions v on v.id=t.workflow_version_id where v.workflow_id=${workflowId})`);
    await trx.execute(sql`update workflow_shares set revoked_at=now() where workflow_id=${workflowId}`);
    const [job]=await trx.insert(workflowDeletions).values({workflowId,accountId}).returning();return job!;
  });
}
const refsIn=(value:unknown)=>[...new Set(JSON.stringify(value).match(/sha256:[0-9a-f]{64}/g)??[])];
const blobRefPattern="(sha256:[0-9a-f]{64})";

/**
 * Extract references in Postgres instead of returning every source row to Node and
 * stringifying it there. Trace payloads can be several gigabytes even for a modest number
 * of runs; materialising those rows in the engine made one deletion consume the whole V8
 * heap. The result of this query is bounded by the number of distinct content hashes.
 */
async function storedRefs(db:Db,documents:SQL):Promise<string[]> {
  const result=await db.execute<{ref:string}>(sql`
    select distinct found.parts[1] as ref
    from (${documents}) documents
    cross join lateral regexp_matches(documents.data, ${blobRefPattern}, 'g') as found(parts)
  `);
  return result.rows.map(row=>row.ref);
}

async function expandRefs(blobs:BlobStore,roots:string[]){
  const seen=new Set<string>(),queue=[...roots];
  for(let i=0;i<queue.length;i++){
    const ref=queue[i]!;if(seen.has(ref))continue;seen.add(ref);
    // JSON manifests reference workspace files and historical conversation chunks.
    const bytes=await blobs.get(ref);let value:unknown;
    try{value=JSON.parse(bytes.toString());}catch{continue;}
    queue.push(...refsIn(value).filter(r=>!seen.has(r)));
  }
  return [...seen];
}
export async function processWorkflowDeletion(db:Db,pool:Pool,blobs:BlobStore){
  const [job]=await db.select().from(workflowDeletions).where(ne(workflowDeletions.status,"deleted")).orderBy(workflowDeletions.updatedAt).limit(1);
  if(!job)return;
  try{
    if(job.status!=="blobs")await db.transaction(async trx=>{
      const lock=await trx.execute<{locked:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`delete:${job.workflowId}`},0)) as locked`);
      if(!lock.rows[0]?.locked)return;
      const [current]=await trx.select().from(workflowDeletions).where(eq(workflowDeletions.workflowId,job.workflowId)).for("update");
      if(!current||current.status==="blobs"||current.status==="deleted")return;
      const id=job.workflowId;
      const versions=sql`select id from workflow_versions where workflow_id=${id}`;
      const taskIds=sql`select id from tasks where workflow_version_id in (${versions})`;
      const runIds=sql`select id from runs where workflow_version_id in (${versions})`;
      const executionIds=sql`select id from workflow_executions where workflow_id=${id}`;
      const sessionIds=sql`select id from browser_sessions where execution_id in (${executionIds})`;
      await trx.execute(sql`update runs set status='cancelled',ended_at=now(),error='Workflow deleted' where id in (${runIds}) and status in ('queued','running','awaiting_approval','awaiting_human')`);
      await trx.execute(sql`update approvals set status='cancelled',decided_at=now() where run_id in (${runIds}) and status='pending'`);
      await trx.execute(sql`update workflow_executions set status='cancelled',ended_at=now() where workflow_id=${id} and status='running'`);
      await trx.execute(sql`update compile_jobs set status='failed' where task_id in (${taskIds}) and status in ('queued','running')`);
      await trx.execute(sql`update browser_learning_jobs set status='failed' where task_id in (${taskIds}) and status in ('queued','running')`);
      const sessions=await trx.execute<{id:string;status:string}>(sql`select id,status from browser_sessions where id in (${sessionIds})`);
      for(const session of sessions.rows)if(!["ended","failed","stopping"].includes(session.status))await stopBrowserSession(trx,{accountId:job.accountId,sessionId:session.id});
      const pending=await trx.execute(sql`select 1 from credit_reservations c where c.status='active' and (
        c.id in (select reservation_id from model_operations where workflow_id=${id} or run_id in (${runIds})) or
        c.id in (select reservation_id from captcha_jobs where run_id in (${runIds})) or
        c.id in (select reservation_id from browser_billing where session_id in (${sessionIds})) or
        c.id in (select a.reservation_id from challenge_attempts a join browser_challenges b on b.id=a.challenge_id where b.session_id in (${sessionIds}))) limit 1`);
      if(pending.rows.length||sessions.rows.some(s=>!["ended","failed"].includes(s.status))){
        await trx.update(workflowDeletions).set({status:"settling",error:"Waiting for browser shutdown and outstanding charges to settle.",updatedAt:new Date()}).where(eq(workflowDeletions.workflowId,id));return;
      }
      const roots=await storedRefs(trx,sql`select to_jsonb(t)::text as data from trace_entries t where run_id in (${runIds}) union all
        select to_jsonb(a)::text from artifacts a where run_id in (${runIds}) union all
        select to_jsonb(s)::text from task_state s where task_id in (${taskIds}) union all
        select to_jsonb(c)::text from compiled_scripts c where task_id in (${taskIds}) union all
        select to_jsonb(r)::text from browser_recording_segments r where session_id in (${sessionIds})`);
      const blobRefs=await expandRefs(blobs,roots);
      // Operational receipts may be deleted only after their financial facts are retained.
      const receipts=await trx.execute(sql`select reservation_id,to_jsonb(b) as data from browser_billing b where session_id in (${sessionIds})
          union all select reservation_id,to_jsonb(c)-'solution_json' from captcha_jobs c where run_id in (${runIds})
          union all select a.reservation_id,to_jsonb(a) from challenge_attempts a join browser_challenges b on b.id=a.challenge_id where b.session_id in (${sessionIds})`);
      await audit(trx,job.accountId,"workflow.financial_archive",{workflowId:id,receipts:receipts.rows});
      await trx.execute(sql`update model_operations set workflow_id=null,run_id=null where workflow_id=${id} or run_id in (${runIds})`);
      await trx.execute(sql`delete from browser_commands where run_id in (${runIds}) or session_id in (${sessionIds})`);
      await trx.execute(sql`delete from captcha_jobs where run_id in (${runIds})`);
      await trx.execute(sql`delete from challenge_attempts where challenge_id in (select id from browser_challenges where session_id in (${sessionIds}))`);
      await trx.execute(sql`delete from browser_challenges where session_id in (${sessionIds})`);
      await trx.execute(sql`delete from browser_billing where session_id in (${sessionIds})`);
      await trx.execute(sql`delete from browser_sessions where id in (${sessionIds})`);
      await trx.execute(sql`delete from destination_records where workflow_id=${id}`);
      await trx.execute(sql`delete from destination_preparations where execution_id in (${executionIds})`);
      await trx.execute(sql`delete from destination_contracts where execution_id in (${executionIds})`);
      await trx.execute(sql`delete from workflow_records where execution_id in (${executionIds})`);
      await trx.execute(sql`delete from workflow_trigger_requests where workflow_id=${id}`);
      await trx.execute(sql`delete from model_selections where account_id=${job.accountId} and scope=${id}`);
      await trx.execute(sql`delete from run_dedupe where task_id in (${taskIds})`);
      await trx.execute(sql`delete from workflow_executions where workflow_id=${id}`);
      await trx.execute(sql`delete from events where source_task_id in (${taskIds}) or source_run_id in (${runIds})`);
      await deprovision(pool,id);
      await trx.delete(workflows).where(eq(workflows.id,id));
      await trx.update(workflowDeletions).set({status:"blobs",blobRefs,error:null,updatedAt:new Date()}).where(eq(workflowDeletions.workflowId,id));
    });
    const [current]=await db.select().from(workflowDeletions).where(eq(workflowDeletions.workflowId,job.workflowId));
    if(current?.status!=="blobs")return;
    if(current.blobRefs.length&&!blobs.remove)throw new Error("Blob storage does not support permanent deletion");
    // Content hashes can be shared. Traverse remaining manifests before removing objects.
    if(current.blobRefs.length){
      const roots=await storedRefs(db,sql`select to_jsonb(t)::text as data from trace_entries t where blob_ref is not null or payload_json::text like '%sha256:%'
        union all select to_jsonb(a)::text from artifacts a union all select to_jsonb(s)::text from task_state s
        union all select to_jsonb(c)::text from compiled_scripts c union all select to_jsonb(p)::text from browser_profiles p
        union all select to_jsonb(r)::text from browser_recording_segments r`);
      const shared=new Set(await expandRefs(blobs,roots));
      for(const ref of current.blobRefs)if(!shared.has(ref))await blobs.remove?.(ref);
    }
    await db.update(workflowDeletions).set({status:"deleted",blobRefs:[],error:null,updatedAt:new Date()}).where(eq(workflowDeletions.workflowId,job.workflowId));
  }catch(error){await db.update(workflowDeletions).set({error:error instanceof Error?error.message:"Deletion failed",updatedAt:new Date()}).where(eq(workflowDeletions.workflowId,job.workflowId));}
}
