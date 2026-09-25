"use client";
import { createStore, type StoreApi } from "zustand/vanilla";
import { api, asApiError } from "../lib/api.js";
import { usePolling, useStoreBridge } from "../lib/store.js";
type State={started:boolean;busy:boolean;status:string;error:string|null};
const stores=new Map<string,StoreApi<State>>();
function stateFor(id:string,deleting:boolean){let store=stores.get(id);if(!store){store=createStore<State>(()=>({started:deleting,busy:false,status:"stopping",error:null}));stores.set(id,store);}return store;}
export function DeleteWorkflow({workflowId,deleting=false}:{workflowId:string;deleting?:boolean}){
  const store=stateFor(workflowId,deleting),state=useStoreBridge(store);
  usePolling(()=>{if(!store.getState().started)return;void api.workflow.deletionStatus.query({workflowId}).then(job=>{if(!job)return;if(job.status==="deleted"){window.location.assign("/workflows");return;}store.setState({status:job.status,error:job.error});}).catch(error=>store.setState({error:asApiError(error).message}));},3000);
  async function remove(){if(!window.confirm("Permanently delete this workflow and its run history? Active work will stop, charges will settle, and workflow data will be erased. This cannot be undone."))return;store.setState({busy:true,error:null});try{await api.workflow.delete.mutate({workflowId});store.setState({busy:false,started:true});}catch(error){store.setState({busy:false,error:asApiError(error).message});}}
  return <span className="stack">{state.started?<span role="status">Deleting · {state.status}</span>:<button className="btn btn--quiet workflow-delete" disabled={state.busy} onClick={()=>void remove()}>{state.busy?"Starting deletion…":"Delete workflow"}</button>}{state.error?<small role="status">{state.error}</small>:null}</span>;
}
