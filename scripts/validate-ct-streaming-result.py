import argparse
import json
from pathlib import Path
import numpy as np
import nibabel as nib
parser=argparse.ArgumentParser()
parser.add_argument("--baseline",type=Path,required=True)
parser.add_argument("--current",type=Path,required=True)
args=parser.parse_args()
def read(p): return json.loads(p.read_text(encoding="utf8"))
a,b=[read(p/"provenance.json") for p in (args.baseline,args.current)]
for key in ("source_ct_sha256","model_sha256","recipe_sha256","ontology_sha256","geometry","precision","tta","pp"):
    assert a[key]==b[key],key
x,y=[nib.load(p/"mask.nii.gz") for p in (args.baseline,args.current)]
assert x.shape==y.shape and np.array_equal(x.affine,y.affine)
diff=int(np.count_nonzero(np.asarray(x.dataobj)!=np.asarray(y.dataobj)))
report={"geometry_recipe_match":True,"different_voxels":diff,"voxels":int(np.prod(x.shape)),"clinical_validation":False}
(args.current/"streaming-comparison.json").write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
assert diff==0, "Native labels differ; do not release without investigating"
assert read(args.baseline/"metrics.json")["classes"]==read(args.current/"metrics.json")["classes"]
