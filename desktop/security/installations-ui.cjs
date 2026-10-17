const {randomUUID}=require('node:crypto');
const {diagnose}=require('../diagnostics.cjs');
function installInstallationUi({ipcMain,dialog,window,installations,licensing,logRoot}){
  const channels=[];let selected;
  const authorize=async value=>{try{return await licensing.authorizeInstallation(value);}catch(error){error.diagnosticCode='AUTHORIZATION';throw error;}};
  const handle=(name,action)=>{
    const channel='exmo:installations:'+name;channels.push(channel);
    ipcMain.handle(channel,async(event,...args)=>{
      const frame=event.senderFrame,url=frame?new URL(frame.url):null;
      if(event.sender!==window.webContents || frame!==window.webContents.mainFrame || url?.protocol!=='atlas:' || url.host!=='app' || !['/','/index.html'].includes(url.pathname))throw Error('Untrusted installation caller');
      try{return {ok:true,value:await action(...args)};}catch(error){const diagnostic=diagnose(error,{stage:'설치 관리',code:name==='choose'?'INSTALL_INVALID':'INSTALL_FAILED',logRoot});return {ok:false,error:diagnostic.message,diagnostic};}
    });
  };
  handle('status',()=>installations?.status()??{supported:false,busy:false,solutions:[]});
  handle('choose',async()=>{
    if(!installations)throw Error('A selected-runtime installer is required');
    const selection=await dialog.showOpenDialog(window,{title:'EXMO 설치 패키지 폴더',properties:['openDirectory']});
    if(selection.canceled)return null;
    const bundle=selection.filePaths[0],review=await installations.inspect(bundle),id=randomUUID();selected={id,bundle};
    return {id,version:review.version,choices:Object.entries(review.choices).filter(([name])=>name!=='reader').map(([analysis,value])=>({analysis,bytes:value.bytes,
      authorized:licensing?.status().solutions?.some(e=>e.solutionId===require('../solutions.cjs').resolveSolution(analysis).id && e.state==='active')??false}))};
  });
  handle('install',async(id,names)=>{
    if(!selected || selected.id!==id || !licensing?.authorizeInstallation)throw Error('Select an approved package and activate this device first');
    return installations.install(selected.bundle,names,authorize);
  });
  handle('remove',analysis=>{if(!installations)throw Error('Selected runtime unavailable');return installations.remove(analysis);});
  handle('rollback',analysis=>{if(!installations || !licensing?.authorizeInstallation)throw Error('Selected runtime unavailable');return installations.rollback(analysis,authorize);});
  return ()=>channels.forEach(channel=>ipcMain.removeHandler(channel));
}
module.exports={installInstallationUi};
