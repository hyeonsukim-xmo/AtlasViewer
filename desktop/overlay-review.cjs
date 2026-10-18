const crypto=require('node:crypto');
const S=require('./publication-protocol.cjs'),P=require('./security/license-protocol.cjs'),PNG=require('./publication-image.cjs');
function openOverlayReview({account,imaging,enqueue}){
  const drafts=new Map();let stamp='',generation=0;
  function changed(){const next=S.canonical(account.status());if(next!==stamp){stamp=next;drafts.clear();generation++;}}
  const timer=setInterval(changed,500);timer.unref?.();
  function scope(){changed();const a=account.status(),m=a.me?.memberships.find(m=>m.orgId===a.workspace?.orgId&&m.workspaceId===a.workspace?.workspaceId);
    S.check(a.state==='signed-in'&&m?.roles.includes('analyst')&&a.deviceOrgId===a.workspace?.orgId,'PUBLICATION_SIGN_IN');
    return S.scope({...a.workspace,subject:a.me.subject,installationId:a.installationId});}
  function draft(id){P.id(id);const binding=scope(),d=drafts.get(id);S.check(d&&Date.now()-d.created<30*60000&&S.canonical(d.scope)===S.canonical(binding),'PUBLICATION_REVIEW_EXPIRED');return d;}
  const dto=d=>({id:d.id,image:'data:image/png;base64,'+d.final.toString('base64'),sha256:S.hash(d.final),width:d.image.width,height:d.image.height,capture:d.capture,redacted:d.redacted});
  return {
    async create(ref,options){
      P.fields(ref,['id','revision']);P.id(ref.id);P.id(ref.revision);P.fields(options,['view','index','window','opacity','classIds','side']);
      await account.refresh();const binding=scope(),before=++generation;drafts.clear();
      const source=await imaging.publicationSource(ref.id,ref.revision),preview=await imaging.publicationPreview(source,options);
      scope();S.check(before===generation&&S.canonical(binding)===S.canonical(scope()),'PUBLICATION_REVIEW_EXPIRED');
      S.check(typeof preview.image==='string'&&preview.image.startsWith('data:image/png;base64,')&&preview.image.length<=PNG.MAX_IMAGE*1.4);
      const image=PNG.decode(Buffer.from(preview.image.slice(22),'base64')),final=PNG.encode(image),id=crypto.randomUUID();
      const capture={...options,view:source.summary.analysis==='xray'?'projection':preview.view,index:preview.index,count:preview.count,orientation:preview.sides};
      const d={id,ref,source,scope:binding,image,final,capture,redacted:false,created:Date.now()};drafts.set(id,d);return dto(d);
    },
    redact(id,rects){const d=draft(id);d.final=PNG.redact(d.image,rects);d.redacted=rects.length>0;return dto(d);},
    async approve(id,sha256){
      const d=draft(id);P.digest(sha256);S.check(S.hash(d.final)===sha256,'PUBLICATION_REVIEW_CHANGED');
      const overlay=S.overlay({width:d.image.width,height:d.image.height,capture:d.capture,privacyReview:{policy:'exmo-no-identifiers-v1',sha256,permittedIdentifiers:'none',redacted:d.redacted,subject:d.scope.subject,reviewedAt:Math.floor(Date.now()/1000)}});
      const value=await enqueue(d.ref,d.source,d.scope,overlay,d.final);drafts.delete(id);return value;
    },
    discard(id){drafts.delete(id);generation++;},
    close(){clearInterval(timer);drafts.clear();generation++;},
  };
}
module.exports={openOverlayReview};
