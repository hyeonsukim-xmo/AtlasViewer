const errors={
  'Recent EXMO operator MFA sign-in required':'키 정책을 승인하려면 MFA로 다시 로그인하세요. 인증 후 10분 이내에 승인할 수 있습니다.',
  'EXMO operator permission required':'키 정책 변경은 EXMO 운영 관리자만 가능합니다.',
  'Device administrator membership required':'선택한 기관의 장비 관리자 권한이 필요합니다.',
  'Device belongs to another organization':'이 PC는 다른 기관에 귀속되어 있습니다. EXMO 운영 관리자에게 이전을 요청하세요.',
  'Enrollment changed; refresh before approval':'등록 요청이 변경되었습니다. 갱신 후 다시 검토하세요.',
  'License changed; refresh before updating solutions':'라이선스가 변경되었습니다. 갱신 후 솔루션 권한을 다시 확인하세요.',
  'Prepare the selected solution model approval first':'해당 솔루션의 암호화 모델 승인을 먼저 준비해야 합니다.',
  'Operator must prepare the signed device and model approvals first':'서버에 장비·모델의 서명 승인이 아직 준비되지 않았습니다.',
  'Key policy requires the matching installation and encrypted model package; it cannot be switched in this build':'이 키 정책은 다른 설치본과 암호화 모델이 필요합니다. 현재 설치본에서 바로 전환할 수 없습니다.',
  'Select a workspace on a protected installation first':'장비 등록이 가능한 설치본에서 기관·작업공간을 먼저 선택하세요.',
  'Sign-in timed out':'로그인 시간이 초과되었습니다. 다시 로그인하세요.',
  'Sign-in cancelled':'로그인이 취소되었습니다.',
  'Account operation cancelled':'계정 작업이 취소되었습니다.',
};
function installAccountUi({ipcMain,window,account}){
  const channels=[];
  const handle=(name,action)=>{
    const channel='exmo:account:'+name;channels.push(channel);
    ipcMain.handle(channel,async(event,...args)=>{
      const frame=event.senderFrame,url=frame?new URL(frame.url):null;
      if(event.sender!==window.webContents || frame!==window.webContents.mainFrame || url?.protocol!=='atlas:' || url.host!=='app' || !['/','/index.html'].includes(url.pathname))throw Error('Untrusted account caller');
      try{return {ok:true,value:await action(...args)};}catch(error){return {ok:false,error:errors[error.message]??(error.accountStatus===401?'로그인이 만료되었습니다. 다시 로그인하세요.':error.accountStatus===403?'해당 기관·작업공간의 권한이 없습니다. 관리자에게 확인하세요.':name==='login'?'로그인을 확인하지 못했습니다. 브라우저 인증과 계정 서버 설정을 확인하세요.':'계정 요청을 완료하지 못했습니다. 로그인·기관 권한·서버 연결·장비 승인 상태를 확인하세요.')};}
    });
  };
  handle('status',()=>account.status());handle('login',()=>account.login());handle('logout',()=>account.logout());handle('refresh',()=>account.refresh());
  handle('workspace',(org,id)=>account.workspace(org,id));handle('enroll',()=>account.enroll());handle('enrollments',()=>account.enrollments());
  handle('decide',(id,revision,policy,decision)=>account.decide(id,revision,policy,decision));handle('activate',id=>account.activate(id));
  handle('solution',(id,revision,solutionId,state)=>account.solution(id,revision,solutionId,state));
  return ()=>{channels.forEach(c=>ipcMain.removeHandler(c));account.close();};
}
module.exports={installAccountUi};
