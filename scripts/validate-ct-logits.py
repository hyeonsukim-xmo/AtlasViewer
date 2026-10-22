"""The CT validation adapter must preserve every finite/non-finite decision."""
import argparse
import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'desktop'))
spec = importlib.util.spec_from_file_location('runner', ROOT / 'desktop/model-runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def check(large=False):
    import torch
    import numpy as np
    torch.set_num_threads(4)
    values = torch.tensor([0., -0., 1., -1., torch.finfo(torch.float32).max,
                           torch.finfo(torch.float32).tiny, float('nan'),
                           float('inf'), float('-inf')], dtype=torch.float32)
    for tensor in (values, values.repeat(12).reshape(3, 6, 6).transpose(0, 2),
                   torch.empty((0, 33)), values.requires_grad_()):
        before = tensor.detach().numpy().copy()
        expected = torch.isfinite(tensor)
        # This CPU route must not call the crashing, large-tensor PyTorch operation.
        with patch.object(torch, 'isfinite', side_effect=AssertionError('Full tensor check')):
            actual = runner.ct_isfinite(tensor)
        assert actual.shape == expected.shape and actual.dtype == torch.bool
        assert torch.equal(actual, expected)
        assert actual.all().item() == expected.all().item()
        np.testing.assert_array_equal(tensor.detach().numpy(), before)
    for dtype in (torch.float64, torch.int64):
        tensor = torch.tensor([0, 1, -1], dtype=dtype)
        assert torch.equal(runner.ct_isfinite(tensor), torch.isfinite(tensor))
    if large:
        # Exact logits dimensions of the failed CT; this is a synthetic resource check.
        with torch.inference_mode():
            tensor = torch.zeros((1, 33, 294, 294, 308), dtype=torch.float32)
            assert runner.ct_isfinite(tensor).all().item()
            tensor[0, -1, -1, -1, -1] = float('nan')
            assert not runner.ct_isfinite(tensor).all().item()
    print('PASS: CT finite check, NaN/Inf, strided/empty inputs, unchanged values' +
          ('; 3.51 GB logits including non-finite last voxel' if large else ''))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--large', action='store_true')
    args = parser.parse_args()
    check(args.large)
