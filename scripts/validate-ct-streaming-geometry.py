"""Physical interpolation regression: oblique/reflected grids and anti-aliasing."""
import importlib.util, os, sys, tempfile
from pathlib import Path
from types import SimpleNamespace as NS
import numpy as np
sys.dont_write_bytecode=True
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(Path(os.environ["LOCALAPPDATA"])/"EXMO Atlas/engine/packages/EXMO_CT/src"))
from thigh_muscle_seg_ct.spatial.geometry import SpatialGeometry
from thigh_muscle_seg_ct.spatial.resampling import anti_alias_parameters,gaussian_prefilter_zyx,resample_array_zyx
spec=importlib.util.spec_from_file_location("adapter",root/"desktop/model-runner.py")
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter);adapter.emit=lambda *a,**k:None
def require(ok,message):
    if not ok: raise ValueError(message)
runtime=NS(require=require,ONTOLOGY_ID="test",anti_alias_parameters=anti_alias_parameters,
    gaussian_prefilter_zyx=gaussian_prefilter_zyx,LabelVolume=lambda data,*_:NS(data_zyx=data))
rng=np.random.default_rng(720)
for case in range(4):
    angle=.23 if case==1 else 0.
    direction=np.array([[np.cos(angle),-np.sin(angle),0],[np.sin(angle),np.cos(angle),0],[0,0,1.]])
    if case==2: direction[:,0]*=-1
    source_geometry=SpatialGeometry((32,32,48),(1.,1.,1.),(101.13,-29.7,304.25),tuple(map(tuple,direction)))
    scale=1.5 if case==3 else .7
    origin=tuple(source_geometry.index_center_xyz_to_lps([3.1,4.2,2.3]))
    destination=SpatialGeometry((17,16,29),(scale,scale,scale),origin,tuple(map(tuple,direction)))
    source=rng.random((33,48,32,32),dtype=np.float32)
    if case==2:
        source[0]=source[1]=np.maximum(source[0],source[1])+1
    source/=source.sum(0,dtype=np.float64)[None]
    parameters=anti_alias_parameters(source_geometry,destination)
    restored=np.stack([resample_array_zyx(gaussian_prefilter_zyx(source[i],parameters,outside_value=float(i==0)),source_geometry,destination,interpolation="linear",outside_value=float(i==0)) for i in range(33)])
    np.clip(restored,0,1,out=restored)
    sums=restored.sum(0,dtype=np.float64)
    reference=adapter.ct_normalized_argmax(restored,sums)
    with tempfile.TemporaryDirectory(dir=root/"outputs") as directory:
        result,qc=adapter.ct_inverse(runtime,Path(directory))(
            NS(data_czyx=source,geometry=source_geometry,require_ct_thigh_ontology=lambda:None),
            NS(data_zyx=np.empty(tuple(reversed(destination.shape_xyz)),dtype=np.float32),geometry=destination))
        assert np.array_equal(reference,result.data_zyx),case
        assert not list(Path(directory).iterdir())
    print(f"PASS: geometry case {case}, exact labels, no temporary probability file",flush=True)
