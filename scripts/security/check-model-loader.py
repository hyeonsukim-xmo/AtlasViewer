"""Test-only pipe driver. Never packaged; no keys or images are written by this driver."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'desktop'))
from model_security import ModelGuard, read, digest


def compare_loaders(source, protection):
    import gc
    import hashlib
    import torch
    spec = importlib.util.spec_from_file_location('checked_runner', ROOT / 'desktop/model-runner.py')
    runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
    engine = protection.engine
    def state_hash(states):
        h = hashlib.sha256(); count = 0
        for state in states:
            for name, tensor in sorted(state.items()):
                h.update(name.encode()); h.update(str(tensor.dtype).encode()); h.update(str(tuple(tensor.shape)).encode())
                h.update(tensor.detach().cpu().contiguous().numpy().tobytes()); count += 1
        return h.hexdigest(), count
    def load(root, protected):
        api = runner.protected_torch(torch, protection) if protected else torch
        if engine == 'ct':
            runtime = runner.load_module('ct_validation_' + str(protected), root / 'run.py')
            loader = runtime.model_for
            if protected:
                loader = runner.with_globals(loader, torch=api, sha256_file=lambda file:protection.assets[Path(file).relative_to(root).as_posix()]['sha256'])
            model, _ = loader(json.loads((root / 'configs/inference.json').read_text()), 'cpu')
            return state_hash([model.state_dict()])
        if engine == 'ap':
            sys.path.insert(0, str(root / 'code'))
            import InferenceLOWEX_slicer_nrrd as legacy
            names, size = legacy.get_class_names('AP'), legacy.get_target_size('AP')
            model = legacy.build_model('vnet', len(names), size, 'AP')
            loader = runner.with_globals(legacy.load_checkpoint_to_model, torch=api)
            model, _ = loader(model, root / 'models/AP/model.pth', torch.device('cpu'))
            return state_hash([model.state_dict()])
        if engine.startswith('lat_'):
            from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
            predictor = nnUNetPredictor(device=torch.device('cpu'), perform_everything_on_device=False, allow_tqdm=False)
            loader = runner.with_globals(predictor.initialize_from_trained_model_folder, torch=api)
            loader(str(root / 'models' / engine.upper()), (0, 1, 2, 3, 4), checkpoint_name='checkpoint_final.pth')
            return state_hash(predictor.list_of_parameters)
        raise ValueError('Unexpected loader')
    if engine == 'xray-classifier':
        spec = importlib.util.spec_from_file_location('checked_classifier', ROOT / 'desktop/classifier-worker.py')
        classifier = importlib.util.module_from_spec(spec); spec.loader.exec_module(classifier)
        before, after = {}, {}
        for root, target, access in [(source, before, None), (protection.root, after, protection)]:
            pipeline = classifier.load_vendor(root / 'classification', access)
            for suffix in ('nrrd', 'dcm'):
                result = classifier.process({'operation':'classify', 'path':str(ROOT / 'outputs/xray-check' / ('synthetic-integration-check.' + suffix))}, pipeline)
                target[suffix] = {key:result[key] for key in ('predicted_label', 'segmentation_view', 'confidence', 'probabilities')}
            pipeline.models.clear(); del pipeline; gc.collect()
        assert before == after
        return {'predictionsIdentical':True, 'syntheticInputTypes':['NRRD', 'DICOM']}
    before = load(source, False); gc.collect()
    after = load(protection.root, True); gc.collect()
    assert before == after
    return {'weightsIdentical':True, 'stateSha256':after[0], 'tensors':after[1], 'folds':5 if engine.startswith('lat_') else 1}


def compare(source, protected, protection, device):
    import torch
    import numpy as np
    spec = importlib.util.spec_from_file_location('checked_runner', ROOT / 'desktop/model-runner.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    load_module = runner.load_module
    class Captured(Exception):
        def __init__(self, model):
            self.model = model
    class Predictor:
        def __init__(self, name, model, strategy):
            raise Captured(model)
    def load(name, file):
        module = load_module(name, file)
        module.TorchModelPredictor = Predictor
        return module
    runner.load_module = load
    def capture(root, access):
        runner._context.protection = access
        try:
            runner.run_mri(root, {'id': 'synthetic', 'input': str(root / 'unused.nrrd'),
                                 'output': str(protected.parent / 'never-created'), 'device': device})
            raise AssertionError('Capture did not reach the strict loader')
        except Captured as result:
            return result.model.eval()
        finally:
            runner._context.protection = None
    original = capture(source, None)
    original_state = {name: value.clone() for name, value in original.state_dict().items()}
    torch.manual_seed(734)
    test_input = torch.randn(1, 1, 128, 128, 128, device=device)
    with torch.inference_mode():
        before = original.to(device)(test_input).cpu()
    del original
    if device != 'cpu':
        torch.cuda.empty_cache()
    encrypted = capture(protected, protection)
    equal = all(torch.equal(original_state[name], value.cpu()) for name, value in encrypted.state_dict().items())
    assert equal and len(original_state) == len(encrypted.state_dict())
    with torch.inference_mode():
        after = encrypted.to(device)(test_input).cpu()
    assert torch.equal(before, after)
    assert torch.equal(before.argmax(1), after.argmax(1))
    return {'weightsIdentical': equal, 'tensors': len(original_state), 'logitsIdentical': True,
            'maskIdentical': True, 'input': [1, 1, 128, 128, 128], 'classes': int(before.shape[1]),
            'device': device, 'logitsSha256': digest(np.ascontiguousarray(before.numpy()).tobytes())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', type=Path, required=True)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--device', default='cpu', choices=['cpu', 'cuda:0'])
    args = parser.parse_args()
    guard = ModelGuard(json.loads(args.policy.read_text()), args.engine)
    for line in sys.stdin:
        request = json.loads(line)
        protection = None
        try:
            if request['operation'] == 'challenge':
                value = guard.challenge(request['runId'], request.get('engine', 'mri'))
            else:
                start = time.perf_counter()
                protection = guard.admit(request['runId'], request['job'], request['authorization'])
                plain = protection.weights(protection.root / next(iter(protection.assets)))
                value = {'sha256': digest(plain.value), 'bytes': len(plain.value), 'decryptSeconds': time.perf_counter() - start}
                if request['operation'] == 'assets':
                    value['assets'] = {name: digest(protection.weights(protection.root / name).value) for name in protection.assets}
                if request['operation'] == 'compare':
                    assert plain.value == read(args.source / 'weights/final.safetensors', 1024 ** 3)
                    value.update(compare(args.source, protection.root, protection, args.device))
                if request['operation'] == 'compare-loaders':
                    del plain
                    value.update(compare_loaders(args.source, protection))
                    plain = None
                del plain
            print(json.dumps({'id': request['id'], 'result': value}), flush=True)
        except Exception as error:
            if request['operation'] in ('compare', 'compare-loaders'):
                import traceback
                traceback.print_exc(file=sys.stderr)
            # Never echo the authorization body or exception locals.
            print(json.dumps({'id': request['id'], 'error': type(error).__name__ + ': protected model rejected'}), flush=True)
        finally:
            if protection is not None:
                protection.close()


if __name__ == '__main__':
    main()
