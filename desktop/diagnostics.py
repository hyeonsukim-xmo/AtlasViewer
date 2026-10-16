"""Public error categories only; exception details stay in the private worker log."""
import errno
import json
import sys
import traceback
import uuid


def failure(error, operation, ident=None, *, input_error=False, code=None):
    reference = str(uuid.uuid4())
    if code is None:
        code = {errno.ENOENT:'FILE_MISSING', errno.ENOSPC:'DISK_FULL', errno.EACCES:'ACCESS_DENIED',
                errno.EPERM:'ACCESS_DENIED', errno.ENAMETOOLONG:'PATH_TOO_LONG', errno.ENOMEM:'MEMORY'}.get(getattr(error, 'errno', None))
        text = str(error).lower()
        if not code and ('cuda out of memory' in text or ('outofmemory' in type(error).__name__.lower() and 'torch.cuda' in type(error).__module__)):
            code = 'GPU_MEMORY'
        if not code and (isinstance(error, MemoryError) or 'defaultcpuallocator' in text or 'unable to allocate' in text):
            code = 'MEMORY'
        if not code and ('cuda is unavailable' in text or 'cuda runtime is missing' in text):
            code = 'GPU_UNAVAILABLE'
        if not code and type(error).__name__ == 'InvalidTag':
            code = 'RESULT_INVALID'
        code = code or (('RESULT_INVALID' if operation in ('finalize', 'mesh') else 'INPUT_INVALID') if input_error else {
            'inspect':'INPUT_READ', 'classify':'CLASSIFICATION', 'extract':'INPUT_READ', 'prepare':'INPUT_READ',
            'preview':'OVERLAY', 'finalize':'RESULT_PROCESS', 'mesh':'MESH_BUILD', 'run':'INFERENCE',
            'model_challenge':'AUTHORIZATION'}.get(operation, 'INTERNAL'))
    print(json.dumps({'diagnostic':reference, 'code':code, 'operation':operation, 'id':ident}), file=sys.stderr, flush=True)
    if code != 'AUTHORIZATION':
        traceback.print_exception(type(error), error, error.__traceback__, file=sys.stderr)
    return {'error':str(error) if input_error else 'Analysis operation failed', 'errorPublic':input_error, 'errorCode':code, 'reference':reference}
