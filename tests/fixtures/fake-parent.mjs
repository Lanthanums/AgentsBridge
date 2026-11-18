import { launch } from '../../src/bridge/process.mjs';
launch({command:process.execPath,args:[new URL('./fake-cli.mjs',import.meta.url).pathname.slice(process.platform==='win32'?1:0)]},[],{env:{FAKE_MODE:'tree',FAKE_PID_FILE:process.env.FAKE_PID_FILE}});
setInterval(()=>{},10000);
