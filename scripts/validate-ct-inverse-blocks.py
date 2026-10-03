"""Exercise the real CT inverse adapter against original slice-wise normalization."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace as NS
import tempfile
import sys
import os
sys.dont_write_bytecode = True
import numpy as np
sys.path.insert(0, str(Path(os.environ["LOCALAPPDATA"]) / "EXMO Atlas/engine/packages/EXMO_CT/src"))
from thigh_muscle_seg_ct.spatial.geometry import SpatialGeometry
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("adapter", root / "desktop/model-runner.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
events = []
adapter.emit = lambda stage, **kw: events.append((stage, kw))

def require(ok, message):
    if not ok:
        raise ValueError(message)

rng = np.random.default_rng(941)
for depth in (1, 7, 8, 9, 17):
    source = rng.random((33, depth, 20, 21), dtype=np.float32)
    source /= source.sum(0, dtype=np.float64)[None]
    # Equal maxima and nearby float32 values exercise argmax tie order.
    source[:, :, 0, 0] = np.float32(1 / 33)
    source[0, :, 0, 1] = np.nextafter(source[1, :, 0, 1], np.float32(1))
    source[:, :, 0, 1] /= source[:, :, 0, 1].sum(0, dtype=np.float64)[None]
    expected = np.empty((depth, 20, 21), dtype=np.uint8)
    reference_error = 0.
    for z in range(depth):
        slab = source[:, z].copy()
        np.clip(slab, 0, 1, out=slab)
        sums = slab.sum(0, dtype=np.float64)
        reference_error = max(reference_error, float(np.max(np.abs(sums - 1))))
        slab /= sums[None]
        expected[z] = slab.argmax(0).astype(np.uint8)
    geometry = SpatialGeometry(shape_xyz=(21,20,depth), spacing_xyz_mm=(1.,1.,1.),
        origin_lps_mm=(0.,0.,0.), direction_lps_3x3=((1.,0.,0.),(0.,1.,0.),(0.,0.,1.)))
    runtime = NS(require=require, ONTOLOGY_ID="test", anti_alias_parameters=lambda a,b:NS(to_dict=lambda:{}),
        gaussian_prefilter_zyx=lambda a,b,**kw:a,
        resample_array_zyx=lambda a,b,c,**kw:a,
        LabelVolume=lambda data,geometry,ontology:NS(data_zyx=data))
    probability = NS(data_czyx=source, geometry=geometry, require_ct_thigh_ontology=lambda:None)
    native = NS(data_zyx=expected, geometry=geometry)
    with tempfile.TemporaryDirectory(dir=root / "outputs") as directory:
        actual, qc = adapter.ct_inverse(runtime, Path(directory))(probability, native)
        assert np.array_equal(actual.data_zyx, expected), depth
        assert qc["simplex_max_error_before_renormalization"] == reference_error
        assert not (Path(directory) / "native-probabilities.tmp").exists()
    assert events[-1][0] == "result_export_start"
    assert any(stage == "native_blocks" and value["current"] == depth for stage, value in events)
print("PASS: exact labels and float64 QC for 1/7/8/9/17 slices, ties, block boundaries, cleanup and progress")
