"""Relocatable, isolated Windows runtime; no venv absolute path or customer pip install."""
import argparse
import os
from pathlib import Path
import runpy
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--site', type=Path, required=True)
parser.add_argument('arguments', nargs=argparse.REMAINDER)
args = parser.parse_args()
site = args.site.resolve(strict=True)
if site.name != 'site-packages' or site.parent.name != 'Lib' or site.parent.parent.name not in ('ct', 'mri', 'ap', 'lat', 'security'):
    raise ValueError('Unapproved runtime environment')
if not args.arguments or args.arguments[0] != '--' or len(args.arguments) < 2:
    raise ValueError('Worker entrypoint required')
entry = Path(args.arguments[1]).resolve(strict=True)
if entry.parent != Path(__file__).resolve().parent or entry.name not in ('model-service.py', 'imaging-worker.py', 'piv_worker.py'):
    raise ValueError('Unapproved worker entrypoint')
sys.path[:0] = [str(entry.parent), str(site)]
sys.dont_write_bytecode = True
sys.argv = args.arguments[1:]
runpy.run_path(str(entry), run_name='__main__')
