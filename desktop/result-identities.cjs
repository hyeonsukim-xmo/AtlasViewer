const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {atomicWrite, read} = require('./security/storage.cjs');
const {solutionFields} = require('./solutions.cjs');

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function check(value) {if (!value) throw new Error('Result identity metadata is invalid; retain the original identity files.');}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])]));
  return value;
}
async function fileDigest(file) {
  if (!file) return null;
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function createResultIdentities(root, protectedStoreId) {
  const cache = new WeakMap();
  const marker = path.join(root, 'result-origin.json');
  function storeId() {
    if (fs.existsSync(marker)) {
      const saved = JSON.parse(read(marker));
      check(saved.schema === 1 && uuid(saved.originStoreId));
      if (protectedStoreId) check(saved.originStoreId === protectedStoreId);
      return saved.originStoreId;
    }
    // A missing store marker must not silently reassign already migrated results.
    const runs = path.join(root,'runs');
    check(!fs.existsSync(runs) || !fs.readdirSync(runs,{withFileTypes:true}).some(entry =>
      entry.isDirectory() && fs.existsSync(path.join(runs,entry.name,'identity.json'))));
    const id = protectedStoreId || randomUUID(); check(uuid(id));
    atomicWrite(marker, JSON.stringify({schema:1, originStoreId:id}));
    return id;
  }
  async function identify(publication) {
    const summary = publication.summary, fields = solutionFields(summary);
    check(typeof summary.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(summary.id));
    const folder = path.join(root,'runs',summary.id), filename = path.join(folder,'identity.json');
    const originStoreId = storeId();
    // Local artifact fingerprints detect replacement; these are NOT the future plaintext publication contentDigest.
    // Upload re-encryption must carry these IDs, never derive IDs from transport ciphertext.
    const snapshot = { ...fields, variant:summary.variant, route:summary.route ?? null, unit:summary.unit,
      geometry:{size:summary.metadata?.size,spacing:summary.metadata?.spacing},
      rows:summary.rows.map(({color,group,name,...measurement}) => measurement),
      laterality:summary.laterality, qc:summary.qc,
      mask:await fileDigest(publication.mask), sideMask:await fileDigest(publication.sideMask)};
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex');
    // Read after asynchronous hashing so concurrent readers retain each other's mappings.
    const saved = fs.existsSync(filename) ? JSON.parse(read(filename)) : {
      schema:1, originStoreId, originResultId:randomUUID(), ...fields, revisions:{},
      provenance:{adapter:'desktop-imaging-v1', source:summary.solutionId ? 'solution-registry' : 'legacy-analysis'},
    };
    check(saved.schema === 1 && saved.originStoreId === originStoreId && uuid(saved.originResultId) &&
      saved.solutionId === fields.solutionId && saved.workflowId === fields.workflowId &&
      saved.revisions && typeof saved.revisions === 'object' && !Array.isArray(saved.revisions) &&
      Object.entries(saved.revisions).every(([key,value]) => /^[a-f0-9]{64}$/.test(key) && uuid(value)) &&
      saved.provenance?.adapter === 'desktop-imaging-v1' && ['legacy-analysis','solution-registry'].includes(saved.provenance.source));
    if (!saved.revisions[fingerprint]) {
      saved.revisions[fingerprint] = randomUUID();
      fs.mkdirSync(folder,{recursive:true});
      atomicWrite(filename,JSON.stringify(saved));
    }
    return {...fields, resultSchema:'exmo.analysis-result.v1', originStoreId,
      originResultId:saved.originResultId, analysisRevision:saved.revisions[fingerprint], provenance:saved.provenance};
  }
  return {get(publication) {
    if (!cache.has(publication)) {
      const pending = identify(publication);
      cache.set(publication,pending);
    }
    return cache.get(publication);
  }};
}
module.exports = {createResultIdentities};
