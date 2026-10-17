"""Strict v3 execution policy, independently checked by Python before accepting a job."""
from pathlib import Path
import json
import re
from model_security import require, fields, digest, canonical, signed, MODEL_HEADER

CAPABILITIES = ('analyze', 'classify', 'result-mutation')
SOLUTIONS = {'ct': ('exmo.thigh.ct', 'thigh-ct-v1'), 'mri': ('exmo.thigh.mri', 'thigh-mri-water-v1'),
             'xray': ('exmo.lower-extremity.xray', 'lower-extremity-projection-v1')}


def scope(job):
    analysis = 'xray' if job['analysis'] == 'xray-classifier' else job['analysis']
    require(analysis in SOLUTIONS)
    solution, workflow = SOLUTIONS[analysis]
    require(job.get('solutionId') == solution and job.get('workflowId') == workflow)
    return {'solutionId': solution, 'workflowId': workflow}


def execution(job, root, issuer, capability, model_digest=None):
    from model_security import model_id, read
    identity, engine = scope(job), model_id(job)
    require(capability in CAPABILITIES and ((engine == 'xray-classifier') == (capability == 'classify')))
    variant = job.get('variant') if capability == 'result-mutation' else None
    if capability == 'result-mutation':
        require(variant in (('raw', 'pp500', 'strong') if engine == 'mri' else ('raw',) if engine == 'ct' else ()))
    package = json.loads(read(Path(root) / 'payload.json', 512 * 1024))
    fields(package, 'token')
    policy = signed(package['token'], issuer, MODEL_HEADER)
    require(policy['schema'] in ('exmo-runtime-payload-v1', 'exmo-selected-payload-v1'))
    if policy['schema'] == 'exmo-selected-payload-v1':
        fields(policy, 'schema version profile python selection components models')
        require(policy['selection'] == ('xray' if job['analysis'] == 'xray-classifier' else job['analysis']))
        if model_digest is not None:
            require(policy['models'].get(engine) == model_digest)
    files = [{'name': p.name, 'sha256': digest(read(p, 16 * 1024 ** 2))} for p in sorted(Path(__file__).parent.glob('*.py'))]
    recipe = {'schema': 'exmo-execution-recipe-v1', 'engine': engine, 'capability': capability, 'variant': variant, 'files': files}
    return {**identity, 'capability': capability, 'engine': engine, 'modelDigest': model_digest,
            'recipeDigest': digest(canonical(recipe).encode()), 'packageSetDigest': digest(package['token'].encode())}


def name(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', value))


def integer(value):
    require(type(value) is int and 0 <= value <= 9007199254740991)


def check_execution(value):
    fields(value, 'solutionId workflowId capability engine modelDigest recipeDigest packageSetDigest')
    name(value['solutionId']); name(value['workflowId'])
    require(value['capability'] in CAPABILITIES and value['engine'] in ('ct', 'mri', 'ap', 'lat_lt', 'lat_rt', 'xray-classifier'))
    if value['capability'] == 'result-mutation':
        require(value['modelDigest'] is None and value['engine'] in ('ct', 'mri'))
    else:
        require(isinstance(value['modelDigest'], str) and re.fullmatch('[a-f0-9]{64}', value['modelDigest']))
    for key in ('recipeDigest', 'packageSetDigest'):
        require(isinstance(value[key], str) and re.fullmatch('[a-f0-9]{64}', value[key]))


def validate(lease):
    fields(lease, 'iss aud kind schema orgId binding nonce iat exp renewAfter revision sequence decision entitlements')
    require(lease['iss'] == 'exmo-license-v3' and lease['aud'] == 'exmo-desktop-v3' and lease['kind'] == 'lease' and lease['schema'] == 'exmo-device-lease-v3')
    require(isinstance(lease['orgId'], str) and re.fullmatch('[a-zA-Z0-9_-]{1,80}', lease['orgId']))
    binding = lease['binding']; require(binding.get('profile') in ('internal', 'customer'))
    fields(binding, 'profile licenseId installationId installationKey' + (' dongleKey agreementKey' if binding['profile'] == 'customer' else ''))
    for key in ('licenseId', 'installationId'):
        require(isinstance(binding[key], str) and re.fullmatch('[a-zA-Z0-9_-]{1,80}', binding[key]))
    keys = [binding[k] for k in ('installationKey', 'dongleKey', 'agreementKey') if k in binding]
    require(all(isinstance(k, str) and re.fullmatch('[a-f0-9]{64}', k) for k in keys) and len(set(keys)) == len(keys))
    require(isinstance(lease['nonce'], str) and re.fullmatch('[A-Za-z0-9_-]{43}', lease['nonce']))
    from model_security import decode
    decode(lease['nonce'], 32)
    for key in ('iat', 'exp', 'renewAfter', 'revision', 'sequence'): integer(lease[key])
    require(lease['revision'] > 0 and lease['sequence'] > 0)
    values = lease['entitlements']
    require(isinstance(values, list) and len(values) <= 64)
    ids, solutions, count = set(), set(), 0
    for e in values:
        fields(e, 'entitlementId solutionId validFrom validUntil state revision capabilities executions')
        require(isinstance(e['entitlementId'], str) and re.fullmatch('[a-zA-Z0-9_-]{1,80}', e['entitlementId']))
        name(e['solutionId']); integer(e['validFrom']); integer(e['revision']); require(e['revision'] > 0)
        if e['validUntil'] is not None:
            integer(e['validUntil']); require(e['validUntil'] > e['validFrom'])
        require(e['state'] in ('active', 'revoked', 'suspended') and e['entitlementId'] not in ids and e['solutionId'] not in solutions)
        ids.add(e['entitlementId']); solutions.add(e['solutionId'])
        require(isinstance(e['capabilities'], list) and len(e['capabilities']) > 0 and all(c in CAPABILITIES for c in e['capabilities']) and len(set(e['capabilities'])) == len(e['capabilities']))
        require(isinstance(e['executions'], list)); seen = set()
        for x in e['executions']:
            check_execution(x)
            require(x['solutionId'] == e['solutionId'] and x['capability'] in e['capabilities'])
            key = canonical(sorted(x.items())); require(key not in seen); seen.add(key)
        count += len(e['executions']); require(count <= 256)
    if lease['decision'] == 'allow':
        require(lease['iat'] < lease['renewAfter'] <= lease['exp'] <= lease['iat'] + 7 * 86400)
    else:
        require(lease['decision'] in ('revoked', 'suspended', 'expired') and lease['iat'] == lease['exp'] == lease['renewAfter'] and not values)


def allowed(lease, request, now):
    validate(lease); check_execution(request)
    require(lease['decision'] == 'allow' and lease['iat'] <= now < lease['exp'])
    e = next((e for e in lease['entitlements'] if e['solutionId'] == request['solutionId']), None)
    require(e and e['state'] == 'active' and e['validFrom'] <= now and (e['validUntil'] is None or now < e['validUntil']) and
            request['capability'] in e['capabilities'] and request in e['executions'])
    return min(lease['exp'], e['validUntil'] if e['validUntil'] is not None else lease['exp'])
