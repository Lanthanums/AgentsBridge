import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { testFilteredMcp } from './mcp-env-client.mjs';
const mode=process.env.FAKE_MODE||'normal';let session=process.env.FAKE_SESSION||'fake-session-001';
const emit=m=>process.stdout.write(JSON.stringify(m)+'\n');
const reply=(id,result)=>emit({jsonrpc:'2.0',id,result});
const update=update=>emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:mode==='mismatch'?'wrong-session':session,update}});
if(mode==='tree'){
  const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{detached:true,stdio:'ignore'});writeFileSync(process.env.FAKE_PID_FILE,String(c.pid));setInterval(()=>{},10000);
}else{
  const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);
    if(m.method==='initialize')reply(m.id,{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{},list:{}}}});
    else if(m.method==='initialized'){}
    else if(m.method==='thread/start')reply(m.id,{thread:{id:session}});
    else if(m.method==='thread/resume')reply(m.id,{thread:{id:mode==='mismatch'?'wrong-session':m.params.threadId}});
    else if(m.method==='session/new')reply(m.id,{sessionId:session,configOptions:[{id:'thinking',currentValue:'high'}]});
    else if(m.method==='session/list')reply(m.id,{sessions:[{sessionId:session}]});
    else if(m.method==='session/resume')reply(m.id,{configOptions:[{id:'thinking',currentValue:'high'}]});
    else if(m.method==='session/set_config_option'){update({sessionUpdate:'config_option_update',configOptions:[]});reply(m.id,{});}
    else if(m.method==='session/set_mode')reply(m.id,{});
    else if(m.method==='session/prompt'){
      if(mode==='mcp_bind'){void testFilteredMcp().then(()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'BINDING_OK'}});reply(m.id,{stopReason:'end_turn'});}).catch(error=>emit({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:error.message}}));return;}
      if(mode==='exit')process.exit(9);
      if(['silent','freeze','freeze_tree','approval_block'].includes(mode)){if(mode==='freeze_tree'){const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{detached:true,stdio:'ignore'});writeFileSync(process.env.FAKE_PID_FILE,String(c.pid));}if(mode==='approval_block')emit({id:900,method:'session/request_permission',params:{sessionId:session,options:[{kind:'allow_once',optionId:'yes'}]}});if(mode.startsWith('freeze'))update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'partial'}});return;}
      update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'node --version',status:'in_progress',rawInput:{command:'node --version'}});
      update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',rawOutput:'v24.0.0'});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:process.env.FAKE_RESULT_TEXT || 'FAKE_RESULT'}});reply(m.id,{stopReason:'end_turn'});
    }else if(m.method==='session/cancel')reply(m.id,{});
  });
}
