"""Authorized result mutation and immutable, model-independent result reading."""
import hashlib
import hmac
import inspect
import json
from pathlib import Path
import re
import secrets
import time
from model_security import require, fields, canonical, digest, exact_json, signed, public, fingerprint, decode, LICENSE_HEADER
import artifact_store


def anchored(file):
    file = Path(file).absolute()
    store = artifact_store.current()
    if store:
        store.anchor(file)
    else:
        for p in (file, *file.parents):
            if p.exists(): require(not p.is_symlink() and not (getattr(p.lstat(), 'st_file_attributes', 0) & 0x400))
    return file


def file_hash(file):
    h = hashlib.sha256()
    # Bind stored ciphertext bytes; no need to decrypt masks merely to verify their identity.
    with artifact_store._open(anchored(file), 'rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 ** 2), b''): h.update(block)
    return h.hexdigest()


def tag(domain, text):
    store = artifact_store.current()
    data = (domain + text).encode()
    return hmac.new(store.key, data, hashlib.sha256).hexdigest() if store else digest(data)


def save(file, domain, value):
    file = anchored(file); text = canonical(value)
    document = canonical({'message': text, 'tag': tag(domain, text)})
    temporary = file.with_name(file.name + '.' + secrets.token_hex(8) + '.tmp')
    try:
        with temporary.open('x', encoding='utf8') as stream:
            stream.write(document); stream.flush()
            import os
            os.fsync(stream.fileno())
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def load(file, domain):
    file = anchored(file); require(file.stat().st_size <= 8 * 1024 ** 2)
    v = json.loads(file.read_text(encoding='utf8')); fields(v, 'message tag')
    require(isinstance(v['message'], str) and isinstance(v['tag'], str) and hmac.compare_digest(v['tag'], tag(domain, v['message'])))
    value = json.loads(v['message']); require(canonical(value) == v['message'])
    return value


def mask_file(result, analysis, route, variant='raw'):
    folder = result / variant if analysis == 'mri' else result
    return folder / ('mask.nii.gz' if analysis == 'ct' else 'mask.seg.nrrd' if analysis == 'xray' and route == 'AP' else 'mask.nrrd')


def complete(result, job, run_id):
    if not artifact_store.current(): return
    result = anchored(result)
    names = ['desktop-complete.json']
    mask = mask_file(result, job['analysis'], job.get('route'))
    names.append(str(mask.relative_to(result)))
    for name in ('metrics.json', 'qc.json', 'raw/metrics.json', 'pp500/metrics.json', 'pp500/mask.nrrd'):
        if (result / name).is_file(): names.append(name)
    value = {'schema': 'exmo-completed-run-v1', 'runId': run_id, 'result': str(result),
             'input': job['input'], 'inputId': job['id'], 'analysis': job['analysis'], 'route': job.get('route'),
             'solutionId': job.get('solutionId'), 'workflowId': job.get('workflowId'),
             'files': {name: file_hash(result / name) for name in names}}
    save(result / 'desktop-completion-auth.json', 'EXMO/COMPLETION/v1/', value)


def admit_completion(message):
    result = anchored(message['result']); v = load(result / 'desktop-completion-auth.json', 'EXMO/COMPLETION/v1/')
    record = message['record']
    require(v['runId'] == message['id'] and v['result'] == str(result) and v['input'] == record['input'] and
            v['inputId'] == record['id'] and v['analysis'] == record['analysis'] and message.get('variant', 'raw') == 'raw')
    require(v['route'] == record.get('classification', {}).get('route_to_segmentation'))
    for k in ('solutionId', 'workflowId'): require(v[k] == record.get(k))
    require(all(file_hash(result / name) == expected for name, expected in v['files'].items()))
    # A completed run authorizes exactly one initial result calculation, even across worker restarts.
    with anchored(result / 'desktop-completion-consumed').open('x', encoding='utf8') as stream: stream.write(v['runId'])


def snapshot_file(result, variant):
    require(variant in ('raw', 'pp500', 'strong'))
    return anchored(Path(result) / ('desktop-snapshot-' + variant + '.json'))


def seal_snapshot(publication, mesh_function):
    publication = {k: v for k, v in publication.items() if k != '_snapshot'}
    result = anchored(publication['result'])
    for key in ('mask', 'sideMask'):
        if publication.get(key): require(result in anchored(publication[key]).parents)
    value = {'schema': 'exmo-fixed-result-v1', 'publication': publication,
             'maskDigest': file_hash(publication['mask']), 'sideMaskDigest': file_hash(publication['sideMask']) if publication.get('sideMask') else None,
             'displayRecipe': digest(inspect.getsource(mesh_function).replace('\r\n', '\n').encode())}
    save(snapshot_file(result, publication['summary']['variant']), 'EXMO/SNAPSHOT/v1/', value)
    return read_snapshot(result, publication['summary']['variant'], mesh_function)


def read_snapshot(result, variant, mesh_function, adopt=False, verify_recipe=True):
    result = anchored(result); file = snapshot_file(result, variant)
    if not file.exists():
        if not adopt: return None
        # Only an already published legacy result may be adopted; never compute missing measurements here.
        published = next((p / 'published.json' for p in result.parents if (p / 'published.json').is_file()), None)
        candidates = [p for p in (published, result / ('desktop-result-' + variant + '.json')) if p and p.is_file()]
        v = None
        for candidate in candidates:
            require(anchored(candidate).stat().st_size <= 8 * 1024 ** 2)
            saved = json.loads(candidate.read_text(encoding='utf8'))
            if Path(saved['result']).absolute() == result and saved['summary']['variant'] == variant:
                v = saved; break
        if v is None: return None
        return seal_snapshot(v, mesh_function)
    v = load(file, 'EXMO/SNAPSHOT/v1/'); fields(v, 'schema publication maskDigest sideMaskDigest displayRecipe')
    p = v['publication']
    require(v['schema'] == 'exmo-fixed-result-v1' and Path(p['result']).absolute() == result and p['summary']['variant'] == variant)
    require(v['maskDigest'] == file_hash(p['mask']) and v['sideMaskDigest'] == (file_hash(p['sideMask']) if p.get('sideMask') else None))
    if verify_recipe:
        require(v['displayRecipe'] == digest(inspect.getsource(mesh_function).replace('\r\n', '\n').encode()))
    p['_snapshot'] = {'maskDigest': v['maskDigest'], 'sideMaskDigest': v['sideMaskDigest'], 'snapshotDigest': digest(canonical(v).encode()), 'variant': variant}
    return p


class MutationGuard:
    def __init__(self, guard, mesh_function):
        self.guard, self.mesh_function, self.pending = guard, mesh_function, {}

    def source(self, job):
        from solution_security import scope
        scope(job); require(job['record']['analysis'] == job['analysis'])
        source = job['source']
        fields(source, 'originStoreId originResultId analysisRevision maskDigest sideMaskDigest snapshotDigest variant')
        prior = read_snapshot(job['result'], source['variant'], self.mesh_function, adopt=True, verify_recipe=False)
        require(prior is not None)
        require(all(source[k] == v for k, v in prior['_snapshot'].items()))
        require(prior['summary']['id'] == job['id'] and prior['record']['input'] == job['record']['input'] and prior['record']['id'] == job['record']['id'])
        identity_file = next((p / 'identity.json' for p in Path(job['result']).parents if (p / 'identity.json').is_file()), None)
        require(identity_file is not None and anchored(identity_file).stat().st_size <= 8 * 1024 ** 2)
        identity = json.loads(identity_file.read_text(encoding='utf8'))
        require(identity['originStoreId'] == source['originStoreId'] and identity['originResultId'] == source['originResultId'] and source['analysisRevision'] in identity['revisions'].values())
        require(identity.get('snapshots', {}).get(source['analysisRevision']) == source['snapshotDigest'])
        require(identity['solutionId'] == job['solutionId'] and identity['workflowId'] == job['workflowId'])

    def challenge(self, run_id, job):
        require(self.guard.policy and re.fullmatch(r'[0-9a-f-]{36}', run_id))
        self.source(job)
        self.pending = {k: v for k, v in self.pending.items() if v[2] > time.monotonic()}
        require(run_id not in self.pending and len(self.pending) < 2)
        nonce = secrets.token_urlsafe(32)
        self.pending[run_id] = nonce, digest(canonical(job).encode()), time.monotonic() + 60
        return {'nonce': nonce}

    def admit(self, run_id, job, authorization):
        pending = self.pending.pop(run_id, None)
        require(pending and time.monotonic() < pending[2]); self.source(job)
        policy = self.guard.policy; customer = policy['profile'] == 'customer'; v3 = policy.get('licenseVersion', 2) == 3
        fields(authorization, 'lease installationPublicKey message signature' + (' donglePublicKey dongleSignature' if customer else ''))
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        signing = public(authorization['installationPublicKey'], 'p256')
        signing.verify(decode(authorization['signature']), ('EXMO/RESULT-MUTATION/v1/' + authorization['message']).encode(), ec.ECDSA(hashes.SHA256()))
        claims = exact_json(authorization['message'])
        fields(claims, 'schema runId solutionId workflowId capability engine source nonce jobDigest leaseDigest iat exp' + (' modelDigest recipeDigest packageSetDigest' if v3 else ''))
        require(claims['schema'] == 'exmo-result-mutation-v1' and claims['runId'] == run_id and claims['nonce'] == pending[0] and claims['jobDigest'] == pending[1] == digest(canonical(job).encode()))
        require(claims['source'] == job['source'] and claims['leaseDigest'] == digest(authorization['lease'].encode()))
        lease = signed(authorization['lease'], self.guard.issuer, LICENSE_HEADER)
        binding = lease['binding']; fields(binding, 'profile licenseId installationId installationKey' + (' dongleKey agreementKey' if customer else ''))
        require(binding['profile'] == policy['profile'] and binding['installationKey'] == fingerprint(signing))
        if customer:
            dongle = public(authorization['donglePublicKey'], 'p256'); require(binding['dongleKey'] == fingerprint(dongle))
            dongle.verify(decode(authorization['dongleSignature']), ('EXMO/RESULT-MUTATION/v1/dongle/' + authorization['message']).encode(), ec.ECDSA(hashes.SHA256()))
        from solution_security import execution, allowed, scope
        if v3:
            require(len(authorization['lease']) <= 128 * 1024)
            expected = execution(job, self.guard.engine_root, self.guard.issuer, 'result-mutation')
            require(all(claims[k] == v for k, v in expected.items()))
            require(claims['exp'] <= allowed(lease, expected, time.time()))
        else:
            from model_security import legacy_lease
            legacy_lease(lease)
            require(len(authorization['lease']) <= 16384)
            require(job['analysis'] in ('ct', 'mri') and job['analysis'] in lease['engines'] and all(claims[k] == v for k, v in scope(job).items()))
            require(claims['engine'] == job['analysis'] and claims['capability'] == 'result-mutation')
        require(type(claims['iat']) is int and type(claims['exp']) is int and lease['iat'] <= claims['iat'] < claims['exp'] <= min(claims['iat'] + 60, lease['exp']))
        require(claims['iat'] - 2 <= time.time() < claims['exp'])
