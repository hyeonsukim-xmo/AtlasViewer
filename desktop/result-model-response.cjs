const fs = require('node:fs');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { diagnose } = require('./diagnostics.cjs');

function resultModelResponse(file, logRoot, caseId) {
  const reference = randomUUID();
  const report = error => diagnose(Object.assign(error, {reference}), {stage:'3D 파일 읽기',code:'MESH_READ',caseId,logRoot});
  try {
    if (!file) throw Object.assign(new Error('Result model is not registered'), {code:'ENOENT'});
    const size = fs.statSync(file).size;
    const stream = fs.createReadStream(file);
    stream.on('error', report);
    return new Response(Readable.toWeb(stream), {headers:{
      'Content-Type':'model/gltf-binary', 'Content-Length':String(size), 'X-EXMO-Reference':reference,
    }});
  } catch (error) {
    const diagnostic = report(error);
    return Response.json({diagnostic}, {status:error.code === 'ENOENT' ? 404 : 500});
  }
}
module.exports = { resultModelResponse };
