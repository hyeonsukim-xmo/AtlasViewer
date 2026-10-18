"""Relocatable, isolated Windows runtime; no venv absolute path or customer pip install."""
import argparse
from pathlib import Path
import runpy
import site as python_site
import sys

def import_path(directory):
    value = str(Path(directory).resolve(strict=True))
    if sys.platform == 'win32' and not value.startswith('\\\\?\\'):
        return '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value
    return value

def runtime_paths(site):
    site = Path(site).resolve(strict=True)
    if site.name != 'site-packages' or site.parent.name != 'Lib' or site.parent.parent.name not in ('reader', 'ct', 'mri', 'ap', 'lat', 'security'):
        raise ValueError('Unapproved runtime environment')
    paths = [import_path(site)]
    shared = site.parents[2] / 'xray-common/Lib/site-packages'
    if site.parent.parent.name in ('ap', 'lat') and shared.is_dir():
        paths.append(import_path(shared))
    return paths


def configure_runtime(site):
    paths = runtime_paths(site)
    sys.path[:0] = paths
    # Signed site-packages still need their normal .pth initialization (e.g. Python 3.12 distutils).
    for directory in paths:
        python_site.addsitedir(directory)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', type=Path, required=True)
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.arguments or args.arguments[0] != '--' or len(args.arguments) < 2:
        raise ValueError('Worker entrypoint required')
    entry = Path(args.arguments[1]).resolve(strict=True)
    if entry.parent != Path(__file__).resolve().parent or entry.name not in ('model-service.py', 'imaging-worker.py', 'piv_worker.py', 'publication-worker.py'):
        raise ValueError('Unapproved worker entrypoint')
    configure_runtime(args.site)
    sys.path.insert(0, import_path(entry.parent))
    sys.dont_write_bytecode = True
    sys.argv = args.arguments[1:]
    runpy.run_path(str(entry), run_name='__main__')


if __name__ == '__main__':
    main()
