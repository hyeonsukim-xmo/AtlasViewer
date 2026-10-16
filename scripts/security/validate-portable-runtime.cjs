// Build-host check: no installed Python, venv path, network, GPU inference or patient data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(process.argv[2] || 'work/security-delivery-v2/payload');
const script=`import json, sys
sys.path[:0] = [sys.argv[1], sys.argv[2]]
import cryptography
if sys.argv[3] == 'security':
 import piv_worker
else:
 import numpy, nrrd, torch
 if sys.argv[3] != 'ap':
  import SimpleITK
 if sys.argv[3] == 'lat':
  from nnunetv2.imageio.simpleitk_reader_writer import SimpleITKIO
print(json.dumps({'python':sys.version.split()[0], 'environment':sys.argv[3], 'isolated':bool(sys.flags.isolated)}))`;
const results=[];
for(const env of ['ct','mri','ap','lat','security']){
 const result=spawnSync(path.join(root,'python/python.exe'),['-I','-B','-c',script,path.resolve('desktop'),path.join(root,'envs',env,'Lib/site-packages'),env],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr);results.push(JSON.parse(result.stdout.trim().split('\n').at(-1)));
 assert.equal(results.at(-1).python,'3.12.8');assert.equal(results.at(-1).isolated,true);
}
const roundtrip=spawnSync(path.join(root,'python/python.exe'),['-I','-B','-X','utf8',path.resolve('desktop/runtime_bootstrap.py'),'--site',path.join(root,'envs/ct/Lib/site-packages'),'--',path.resolve('desktop/imaging-worker.py'),'--engine-root',root,'--palette',path.resolve('dist-desktop/imaging-palette.json')],
 {input:JSON.stringify({operation:'unknown',requestId:'한글-경로-검증'})+'\n',encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
assert.equal(roundtrip.status,0,roundtrip.stderr);
assert.deepEqual(JSON.parse(roundtrip.stdout.trim()),{id:'한글-경로-검증',error:'지원하지 않는 작업입니다.'});
const output=path.resolve('outputs/security-portable-runtime.json');fs.writeFileSync(output,JSON.stringify({relocatableImports:results,patientDataUsed:false},null,2));console.log(output);
