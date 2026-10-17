"""Build-host dependency closure of the existing CT reader; never installs or upgrades packages."""
import importlib.metadata as metadata
import json
from pathlib import Path
import sys
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

site = Path(sys.argv[1]).resolve(strict=True)
installed = {canonicalize_name(d.metadata['Name']): d for d in metadata.distributions(path=[str(site)])}
pending = ['numpy', 'nibabel', 'pynrrd', 'pydicom', 'SimpleITK', 'Pillow', 'scipy', 'scikit-image', 'trimesh', 'fast-simplification', 'cryptography', 'psutil']
selected, files = {}, set()
while pending:
    name = canonicalize_name(pending.pop())
    if name in selected:
        continue
    distribution = installed[name]
    dependencies = []
    for text in distribution.requires or []:
        requirement = Requirement(text)
        if requirement.marker and not requirement.marker.evaluate({'extra': ''}):
            continue
        dependency = canonicalize_name(requirement.name)
        assert installed[dependency].version in requirement.specifier, text
        dependencies.append(dependency)
    selected[name] = {'version': distribution.version, 'dependencies': sorted(dependencies)}
    pending.extend(dependencies)
    for item in distribution.files or []:
        absolute = (site / str(item)).resolve()
        if absolute.is_relative_to(site) and absolute.is_file() and '__pycache__' not in absolute.parts:
            files.add(absolute.relative_to(site).as_posix())
assert 'torch' not in selected and 'monai' not in selected
print(json.dumps({'packages': selected, 'files': sorted(files)}))
