"""Shared torch lookup stays inside the chosen payload; other dependencies stay isolated."""
from pathlib import Path
import importlib.util
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'desktop'))
from runtime_bootstrap import runtime_paths, configure_runtime


class RuntimePaths(unittest.TestCase):
    def test_signed_site_initialization_runs_with_existing_search_path(self):
        before = list(sys.path)
        try:
            with tempfile.TemporaryDirectory() as directory:
                site = Path(directory) / 'envs/ct/Lib/site-packages'
                extra = site / 'extra'
                extra.mkdir(parents=True)
                (site / 'test.pth').write_text('extra\n', encoding='utf8')
                (extra / 'runtime_fixture.py').write_text('value = 37\n', encoding='utf8')
                configure_runtime(site)
                import runtime_fixture
                self.assertEqual(runtime_fixture.value, 37)
        finally:
            sys.path[:] = before
            sys.modules.pop('runtime_fixture', None)

    def test_legacy_and_shared_environments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sites = {env: root / f'envs/{env}/Lib/site-packages' for env in ('reader', 'ct', 'mri', 'ap', 'lat', 'security')}
            for site in sites.values():
                site.mkdir(parents=True)
                self.assertEqual(len(runtime_paths(site)), 1)
                self.assertTrue(Path(runtime_paths(site)[0]).samefile(site))
            common = root / 'envs/xray-common/Lib/site-packages'
            common.mkdir(parents=True)
            for env, site in sites.items():
                expected = [str(site.resolve())] + ([str(common.resolve())] if env in ('ap', 'lat') else [])
                self.assertEqual(len(runtime_paths(site)), len(expected))
                self.assertTrue(all(Path(actual).samefile(wanted) for actual, wanted in zip(runtime_paths(site), expected)))
            with self.assertRaises(ValueError):
                runtime_paths(common)
            with self.assertRaises(FileNotFoundError):
                runtime_paths(root / 'missing')

    def test_ct_cuda_retains_explicit_missing_runtime_failure(self):
        spec = importlib.util.spec_from_file_location('runner', Path(__file__).resolve().parents[2] / 'desktop/model-runner.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'envs/ap/Lib/site-packages').mkdir(parents=True)
            before = list(sys.path)
            with self.assertRaisesRegex(RuntimeError, 'CUDA runtime is missing'):
                runner.ct_torch(root / 'packages/EXMO_CT', 'cuda:0')
            self.assertEqual(sys.path, before)

    def test_long_installed_site_imports_nested_modules(self):
        before = list(sys.path)
        try:
            with tempfile.TemporaryDirectory() as directory:
                site = Path(directory) / ('nested-' * 20) / ('nested-' * 14) / 'envs/reader/Lib/site-packages'
                package = site / 'long_runtime_fixture'
                package.mkdir(parents=True)
                (package / '__init__.py').write_text('from .child import value\n', encoding='utf8')
                (package / 'child.py').write_text('value = 41\n', encoding='utf8')
                self.assertGreater(len(str(package / 'child.py')), 260)
                configure_runtime(site)
                import long_runtime_fixture
                self.assertEqual(long_runtime_fixture.value, 41)
        finally:
            sys.path[:] = before
            for name in ('long_runtime_fixture', 'long_runtime_fixture.child'):
                sys.modules.pop(name, None)


if __name__ == '__main__':
    unittest.main()
