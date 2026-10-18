function installSyncUi({ipcMain,window,sync}){
  const channels=[];
  function handle(name,action){const channel='exmo:sync:'+name;channels.push(channel);ipcMain.handle(channel,async(event,...args)=>{
    const frame=event.senderFrame,url=frame?new URL(frame.url):null;
    if(event.sender!==window.webContents || frame!==window.webContents.mainFrame || url?.protocol!=='atlas:' || url.host!=='app' || !['/','/index.html'].includes(url.pathname))throw Error('Untrusted publication caller');
    try{return {ok:true,value:await action(...args)};}catch(e){return {ok:false,error:/^PUBLICATION_[A-Z_]+$/.test(e.code??e.message)?e.code??e.message:'PUBLICATION_REQUEST_FAILED'};}
  });}
  handle('status',()=>sync.status());handle('enqueue',refs=>sync.enqueue(refs));handle('retry',id=>sync.retry(id));handle('cancel',id=>sync.cancel(id));handle('approve-origin',ref=>sync.approveOrigin(ref));
  return ()=>{channels.forEach(c=>ipcMain.removeHandler(c));return sync.close();};
}
module.exports={installSyncUi};
