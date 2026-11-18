import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
export async function testFilteredMcp(){
 const env={};for(const key of ['PATH','USERPROFILE','LOCALAPPDATA','APPDATA','SYSTEMROOT','TEMP'])if(process.env[key])env[key]=process.env[key];
 env.AGENTSBRIDGE_HOME=process.env.FAKE_BIND_HOME;env.AGENTSBRIDGE_AGENT='dsh';
 const child=spawn(process.execPath,[process.env.FAKE_BRIDGE_SCRIPT],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=new Map();let next=0,stderr='';const rl=readline.createInterface({input:child.stdout});
 rl.on('line',line=>{const m=JSON.parse(line);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
 child.stderr.on('data',c=>stderr+=c);child.on('close',code=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(`MCP exited ${code}: ${stderr}`));}});
 const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>reject(new Error(`MCP_TIMEOUT ${method}: ${stderr}`)),20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try {
   await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'filtered-env-test',version:'1'}});
   const list = await request('tools/list');
   const call = async (name, args = {}) => {
     const result = await request('tools/call', {name, arguments: args});
     if (result.isError) throw new Error(result.content[0].text);
     return JSON.parse(result.content[0].text);
   };
   const status = await call('mesh_status');
   const initial = await call('mesh_budget');
   const updated = await call('mesh_budget', {
     collab_id: 'ignored-for-scoped-worker',
     budget: {max_rounds: initial.budget.max_rounds + 1},
     reason: 'Verify process-bound coordinator budget update',
   });
   await call('mesh_progress', {text:'FILTERED_ENV_BOUND'});
   writeFileSync(process.env.FAKE_BIND_RESULT, JSON.stringify({
     parent_pid: process.pid,
     mesh: status.mesh,
     create_exposed: list.tools.some(tool => tool.name === 'mesh_create'),
     routing_exposed: list.tools.find(tool => tool.name === 'mesh_send')?.inputSchema.properties.to.enum.includes('auto'),
     budget: updated,
   }));
 }
 finally{child.kill();rl.close();}
}
