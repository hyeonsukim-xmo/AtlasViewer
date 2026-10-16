const fs=require('node:fs/promises');
const {read}=require('./storage.cjs');
function installLicenseUi({ipcMain,dialog,window,licensing,profile,restart}) {
  let busy=false;
  const status=()=>licensing?.status() ?? {profile,state:'DEVELOPMENT',expiresAt:null};
  const allowed=event=>event.sender===window.webContents && event.senderFrame===window.webContents.mainFrame &&
    event.senderFrame.url.startsWith('atlas://app/');
  ipcMain.handle('exmo:license:status',event=>{
    if(!allowed(event))throw Error('Untrusted licensing caller');return status();
  });
  ipcMain.handle('exmo:license:manage',async event=>{
    if(!allowed(event))throw Error('Untrusted licensing caller');
    if(busy)return status();busy=true;
    try {
      if(!licensing)return status();
      const current=status();
      const {response}=await dialog.showMessageBox(window,{type:'info',title:'EXMO 라이선스',
        message:`${profile==='internal'?'내부 개발용':'고객용 · YubiKey 인증'} · ${current.state}`,
        detail:`EXMO 서버에서 승인한 장비만 신규 분석을 실행합니다.${profile==='customer'?' 오프라인 유예 중에도 등록된 YubiKey가 필요합니다.':' Windows 관리자 권한은 분석 권한을 부여하지 않습니다.'}${current.expiresAt?'\n현재 권한 기한: '+new Date(current.expiresAt*1000).toLocaleString():''}\n완료된 결과는 권한 상태와 관계없이 열람할 수 있습니다.`,
        buttons:['닫기','등록 요청 저장','승인 파일 적용','지금 갱신','결과 키 복구'],defaultId:0,cancelId:0});
      if(response===1){
        const request=await licensing.enrollment();
        const result=await dialog.showSaveDialog(window,{title:'장비 등록 요청 저장',defaultPath:`EXMO-${profile}-enrollment.json`,filters:[{name:'EXMO enrollment',extensions:['json']}]});
        if(!result.canceled && result.filePath)await fs.writeFile(result.filePath,JSON.stringify(request,null,2));
      } else if(response===2){
        const result=await dialog.showOpenDialog(window,{title:'EXMO 승인 파일 적용',properties:['openFile'],filters:[{name:'EXMO activation',extensions:['json']}]});
        if(!result.canceled && result.filePaths.length===1)await licensing.activate(JSON.parse(read(result.filePaths[0])));
      } else if(response===3)await licensing.refresh();
      else if(response===4){
        const result=await dialog.showOpenDialog(window,{title:'EXMO 결과 키 복구 파일',properties:['openFile'],filters:[{name:'EXMO result recovery',extensions:['json']} ]});
        if(!result.canceled && result.filePaths.length===1){
          const document=JSON.parse(read(result.filePaths[0]));await licensing.restoreResults(document.token);
          await dialog.showMessageBox(window,{type:'info',title:'EXMO 결과 복구',message:'결과 키가 복구되었습니다. 앱을 다시 시작합니다.'});restart?.();
        }
      }
    } catch(error){await dialog.showMessageBox(window,{type:'error',title:'EXMO 라이선스',message:error.message});}
    finally {busy=false;}
    return status();
  });
  return ()=>{ipcMain.removeHandler('exmo:license:status');ipcMain.removeHandler('exmo:license:manage');};
}
module.exports={installLicenseUi};
