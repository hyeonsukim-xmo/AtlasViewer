# Windows transfer validation — 2026-09-28

Base source: `4e732d9c43c9678a2321ae443c91e0b15fd7714a` from
`design/marimo-glass`. The installed application comes from the transfer ZIP.

## Machine compatibility correction

The RTX 5070 Ti Laptop GPU (12 GB, compute capability `sm_120`, NVIDIA
driver 592.01) cannot execute the delivered AP/LAT `torch==2.7.0+cu126`
wheel. Both original runtime probes failed with `no kernel image is available
for execution on the device`. CT CPU and MRI CUDA 12.8 probes passed.

Keep Torch at 2.7.0 and torchvision at 0.22.0, but select their CUDA 12.8
wheels for AP/LAT. The installer uses the CUDA 12.8 index for GPU environments;
the runtime verifier still checks every exact dependency pin and executes a
real convolution. No CPU fallback, model, preprocessing, TTA, postprocessing,
palette, or application UI change is introduced.

Official compatibility reference: https://pytorch.org/blog/pytorch-2-7/

The original transfer and all internal model payload checksums passed before
any local adaptation. The original ZIP is unchanged. The extracted copy keeps
`transfer-manifest.original.json`; its working manifest records the local
adaptation and hashes of the edited installation/adapter files. Original runtime
failures are retained as `runtime-check-original-cu126.json` in the engine.

## Windows path correction

The first actual CT run failed before inference while creating its atomic
`transform_ledger.json` temporary file: the default path was 271 characters
and this PC has Windows long paths disabled. The desktop adapter now retains
128 bits (32 hexadecimal characters) of its SHA-256 job identifier, giving a
37-character vendor-safe `case_...` directory. This leaves room for transaction
suffixes without changing image processing. Source, extracted transfer adapter,
and installed app adapter receive the same change. Original installed adapter
is retained as `model-runner.py.original`.
The transfer installer copies its verified adapter into the installed app after
the EXE finishes, so rerunning the local `01-Install.cmd` preserves this fix.

## Portable UI verification

`scripts/validate-imaging-desktop.cjs` accepts `EXMO_ENGINE_ROOT`,
`EXMO_VALIDATION_OUTPUT`, and `EXMO_VALIDATION_USER_DATA` to exercise this PC's
engine and prepared sample store. Defaults preserve the previous development
test locations. Model and patient artifacts remain outside tracked source.

## Actual workflow results

`02-Verify-workflows.cmd` passed all five requested cases. The two additional
MRI comparison cases also passed actual inference, all three postprocessing
variants, overlays, and GLB generation.

| Case | Inference seconds | Differing voxels / total | Generated outputs |
| --- | ---: | ---: | --- |
| CT | 388.62 | 1 / 48,496,640 | 32 classes, cm³, Overlay, GLB |
| MRI sample_01 | 46.50 | 46 / 6,742,848 | 28 classes, Raw/PP500/Strong, cm³, Overlay, GLB |
| X-ray AP | 11.31 | 829 / 19,942,780 | 6 classes, cm², Overlay |
| X-ray LAT-LT | 87.33 | 283 / 22,862,532 | 11 classes, cm², Overlay |
| X-ray LAT-RT | 81.19 | 231 / 22,862,532 | 11 classes, cm², Overlay |
| MRI sample_02 | 52.78 | 68 / 7,477,650 | Raw/PP500/Strong, cm³, Overlay, GLB |
| MRI sample_03 | 51.44 | 48 / 6,742,848 | Raw/PP500/Strong, cm³, Overlay, GLB |

The voxel differences compare this run against delivered reference predictions,
not ground-truth accuracy. X-ray intentionally has no volume or 3D output.

Private reports beneath `%LOCALAPPDATA%\EXMO Atlas\engine`:

- `runtime-check.json`: all four environments passed.
- `validation/transfer-20260928-042706-ce6e26/workflow-check.json`: all five cases passed.
- `validation/comparison-mri-20260928/workflow-check.json`: both additional MRI cases passed.

The actual seven results were copied into the initially empty app library at
`%APPDATA%\EXMO Atlas\imaging` with fresh local imports and publication records.
No reference masks were substituted for inference outputs.

The geometry regression suite passed physical reslicing, left/right volume
conservation, input boundaries, immutable raw postprocessing, exact overlay
composition, and the unchanged CT probability inverse. Type checking, production
and Desktop builds, baseline interaction tests, and the Desktop smoke test passed.

## Packaged application verification

The actual installed `resources/app.asar`, preload, IPC, and imaging workers
passed the Electron interaction suite. Only the native file picker was supplied
with a known local sample selection. The suite used real mouse input for wheel,
middle-button slice scrolling, canvas selection, and right-button rotation.

Passed: physical views, Overlay, measurements/QC, original colors, three-case
MRI comparison, synchronized selection and Explode/Assemble, independent paired
structure rotation, patient-side hover values, Raw/PP500/Strong switching with
unchanged TTA and preserved slice, AP/LAT mixed-comparison rejection, actual AP
cancel/retry/inference, raw artifact hashes, web asset isolation, and zero renderer
errors. Screenshots and `desktop-report.json` are in
`outputs/transfer-desktop-check/` (Git ignored).

A fresh process loaded the saved engine configuration without an environment
override and recovered CT 1, MRI 3, and X-ray 4 results. The fourth X-ray result is
the AP rerun from the UI test. `reopen-report.json` passed. The installed EXMO Atlas
executable was then launched normally and left open.

## Run on this PC

Open the **EXMO Atlas** desktop shortcut. Choose a modality and open saved results;
the MRI result list contains all three comparison samples. The installed executable
is `%LOCALAPPDATA%\Programs\exmo-segmentation-atlas\EXMO Atlas.exe`.

The adapted local transfer folder is
`C:\Users\hyeon\Desktop\EXMO-Transfer\EXMO-Desktop-Transfer-20260928`.
Its `01-Install.cmd` includes the compatibility corrections and its
`02-Verify-workflows.cmd` reruns the five real samples into a new validation folder.
Close the app before reinstalling. Original unadapted ZIP remains in VirtualTwin
and is excluded from Git via that repository's local `.git/info/exclude`.

No execution-blocking issues remain in the tested scope. The delivered model's
existing quality limitations and nonzero cross-hardware numerical differences
remain; the tests do not certify segmentation accuracy. No models, masks, or sample
data were staged, committed, pushed, or uploaded.
