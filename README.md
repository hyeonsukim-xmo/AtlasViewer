# EXMO Segmentation Atlas

EXMO case **1001921** as a responsive React / Three.js application. The supplied
HTML's 27 meshes, class names and colors replace the fork's BodyParts3D viewer.
The original HTML is kept intact.

Windows Desktop also runs the supplied CT, MRI Water and X-ray thigh-analysis
models locally, with native measurements, overlays and case comparison.

**Product boundary:** image import and analysis belong to Desktop. Web is a result
viewer; server-backed result retrieval is planned, not implemented. The Web build
contains neither the Desktop analysis UI nor its Python runtime/model files.

## Product direction

[Development readiness and regression requirements](docs/EXMO_DEVELOPMENT_READINESS.md)
is the current implementation guide: the implemented Web/Windows baseline, protected
viewer behavior, data contracts, scoped development stages, and validation gates.

[EXMO Desktop·Web implementation direction](docs/EXMO_PRODUCT_ARCHITECTURE.md)
records the product requirements, current implementation, proposed architecture,
data and measurement rules, follow-up workflow, delivery stages, and open decisions
in Korean. It is a planning document, not a claim that those features are implemented.

[Imaging workflow and three-result comparison review](docs/EXMO_IMAGING_WORKFLOW_REVIEW_2026-09-25.md)
records the requested Series preview, review grid, analysis and comparison interactions.

## Run

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3016. No API key or backend is required.

```sh
npm test
npm run check
npm run build
npm run preview
```

The production preview uses http://127.0.0.1:3017. Static deployment files are
written to `dist/`; the existing Vercel configuration supports this build.
Development and preview servers bind to the local machine by default.

## Windows desktop

Desktop opens a clinical analysis worklist: choose **CT / MRI Water / X-ray thigh
muscle estimation**, import images, review selected series, run segmentation, and
inspect native measurements, overlays and CT/MRI surfaces. The existing viewer is
available separately as **3D demo**; its 27 colors and interactions are unchanged.

- CT: coded-mm NIfTI, self-contained NRRD and conventional DICOM series. DICOM
  rescale is applied once; other inputs require bound HU evidence or explicit user
  confirmation. Original UNETR/MONAI 1.3.2 FP32 CPU recipe, native volume in cm3,
  HU fat-range fraction. This fraction is not PDFF or a validated clinical FI score.
- MRI: Water-only 3D images, with explicit sequence confirmation unless the input
  matches a delivered sample. Original full6 FP32 model and two-pass TTA; raw and
  PP500 variants, native volume, entropy and component QC. A separate **strong review
  candidate** applies PP500 then retains up to two components in muscle labels 1–23.
  Raw remains intact; native volumes, removed volume and entropy are recomputed.
  The editable 1.16% TTA review threshold flags cases without changing their original
  disagreement score. This candidate is not a validated correction. Water alone provides no FI.
- X-ray: automatic original kNN view classification; NRRD AP or LAT-LT/LAT-RT
  segmentation. AP keeps its original recipe; LAT retains all five folds and
  mirroring, with CPU accumulation to fit this 8 GB GPU. Projection area is cm2,
  never an invented volume. DICOM preview/classification is available, but DICOM
  segmentation and nonstandard AP orientations remain blocked pending validation.

CT/MRI DICOM files are grouped by Study/Series UIDs and checked for spatial ordering,
orientation, spacing, duplicate/missing slices and rescale. Enhanced/multiframe,
color, 4D, detached NRRD and unsupported geometry are rejected. CT/MRI protocol
classification has not been supplied; input checks do not claim protocol suitability.
Hover temporarily previews a series; click pins it. Checkboxes select analysis inputs,
right-click excludes them, and wheel/slider or middle-button vertical dragging changes
slices in axial/coronal/sagittal views. Variant switching preserves view and slice.

Completed results persist locally. Up to three results with matching class schemas
can be inspected together, with measurements and QC in adjacent case columns.
Overlay starts with all classes selected; entire metric rows and the left header
checkbox toggle selection. The metrics/QC panel has a draggable divider. Selection and
Explode/Assemble apply to every compared case. Each 3D case has its own camera and structure rotation;
matching structures use semantic IDs, not coincident numeric label IDs. Views fit
independently, without patient registration. CT/MRI retain their original class labels
and derive patient L/R measurements from physical coordinates and paired femur components.
Ambiguous or fused components remain unassigned; L + R + unassigned preserves the native
volume. L/R details appear on hover; both sides remain one structure for selection,
explosion layout and rotation. The table keeps compact totals and QC values.
This is a review heuristic, not validated anatomical truth; real results never borrow
bilateral values from the demo.

### Local engine setup

For a second Windows PC, use the private transfer folder and the
[Desktop transfer guide](docs/EXMO_DESKTOP_TRANSFER.md): `01-Install.cmd` installs
the app and engine; `02-Verify-workflows.cmd` runs all five delivered sample routes.
The complete folder is required. Initial setup needs internet; subsequent local
analysis does not. Weights and sample/reference data remain outside GitHub.

For source development, install uv and Node, then use the supplied private deliveries:

```powershell
npm ci
npm run desktop:engine -- -Source "Y:\김현수\temp\260927"
npm run desktop
```

Setup installs a private managed Python 3.12.8, checks archive and payload SHA-256
values, creates four pinned environments under ignored `work/modality-integration`,
and verifies dependency imports and actual CPU/CUDA execution. The app stores the engine directory in
`%APPDATA%/EXMO Atlas/engine.json`; `EXMO_ENGINE_ROOT` can override it for tests.
Keep that directory, including its `python` folder, installed. GPU MRI/X-ray need a
compatible NVIDIA driver; explicit CPU execution is also exposed. Only one analysis
job runs at a time. Cancellation terminates its owned process tree and does not
publish partial results. CT uses a disk-backed probability inverse with the same
classwise resampling, normalization and native argmax.

The installer contains the UI and private adapter scripts. The multi-GB model/runtime
store is installed separately; the installer alone is not a portable inference package.
No network is required once the local engine is prepared. Private weights, input
snapshots, masks and logs never enter `public/`, Git or the Web build. The renderer
receives opaque IDs, curated measurements, composed PNGs and permitted meshes.
Original input files are not modified. Clearing the worklist retains completed
results and the inputs they need. Local-machine owners can still inspect local assets;
this implementation does not claim DRM against the machine owner.

```sh
npm run desktop:pack
npm run desktop:dist
```

Outputs: `release/win-unpacked/EXMO Atlas.exe` and
`release/EXMO-Atlas-Setup-0.1.0.exe`. This internal development build is unsigned.
Application updates do not replace the private engine store. The web-only build is
still `npm run build` -> `dist/`; Desktop builds to `dist-desktop/`.

### Checks

```powershell
npm run check
npm test
npm run test:classifier
npm run test:imaging
npm run test:desktop
# Populate private integration fixtures after running the sample jobs:
work\modality-integration\envs\ct\Scripts\python.exe -X utf8 scripts/validate-imaging.py --results
npm run test:imaging:desktop
# Check the packaged application using the same local engine:
npx electron scripts/validate-imaging-desktop.cjs release/win-unpacked/resources/app.asar
```

`--results` rebuilds only `outputs/imaging-check/userdata/imaging`, the generated test
fixture. It does not delete real application userData. Model job JSON files use opaque
case IDs and private local input/output paths; run them with the matching environment
and `desktop/model-runner.py --engine-root ... --job ...`.

[Integration plan](docs/EXMO_MODALITY_INTEGRATION_PLAN_2026-09-27.md) and
[validation / remaining limits](docs/EXMO_MODALITY_VALIDATION_2026-09-27.md) record the
actual tested hardware, recipes, numerical differences and unsupported paths.
Rendering remains demand-driven: idle/minimized scenes do not continuously redraw.

## Explore

- Search all 27 structures by display name, source ID, or group. Search also
  resolves corrected names such as **Multifidus** → `mulifidus`.
- In the assembled view, click model parts or library rows to add/remove classes
  from a multiple selection. Selected classes remain visible across group filters,
  so bones and muscles can be inspected together. Background click or Esc clears all.
- Isolate the selected classes, hide individual classes, or adjust surrounding opacity.
- Filter by Lower Body (24 classes), All (27), or one of seven anatomical groups.
- Separate visible classes with the Explode anatomy button in 1.7 seconds;
  Assemble anatomy reverses the transition. In the separated state, the front view
  prevents overlap; drag or use arrow keys to pan the separated inventory.
- In the exploded view, select one class and right-drag to rotate it about its own
  center (or focus the canvas and use Shift + arrow keys). Deselecting, selecting
  another class, Assemble, or Reset restores its orientation over 0.7 seconds.
  Reduced-motion preferences make this return immediate.
- Use Front, Back, Side, and 3/4 camera presets, automatic rotation, and Reset.
- Switch **Colors → Class / Muscle** above the model. Muscle colors use red muscle
  tissue and ivory bones; the library swatches follow the selected preset.
- Open **Measurements · Demo** in the library for fictional left/right volumes
  in **cm³**, fat infiltration in **%**, and bilateral differences. Search and
  group filters apply to both library views; selecting a measurement card uses
  the existing model selection behavior.
- Hover over a model class to see the same demo measurements directly in the viewer.
  The hovered patient's side is named and shown first with larger values; the opposite
  side and absolute differences follow. In Front view, patient Left is on screen right.
  The tooltip follows the pointer, opens toward the center based on its canvas quadrant,
  and stays within the canvas edges. It clears on background hover, pointer exit, or camera movement.
- Drag to orbit, scroll/pinch to zoom, right-drag/two-finger drag to pan.
  Focus the canvas for arrow-key navigation and +/− zoom.
- Press **/** to search and **Esc** to clear selection. Sliders support keyboard
  controls. The library switches to a dedicated panel on small screens.

The optional browser WebMCP tools `find_anatomy` and
`inspect_anatomical_structure` use the same catalogue and selection behavior.

## Source data

### Measurement prototype

`app/demo-measurements.ts` contains deliberately fictional samples, unrelated to
case 1001921. The data uses structure IDs, paired `[left, right]` values in cm³
and percent, and omits unavailable bilateral samples. Bone samples have no fat
infiltration value. The UI always identifies this panel as **Demo**.

Volume difference is `abs(L − R) / ((L + R) / 2) × 100`; two zero volumes have an
undefined relative difference. Fat infiltration difference is `abs(L − R)` in
percentage points, not a relative percent change. These are display conventions
for this prototype, not clinical thresholds or a chosen measurement method.

This legacy demo remains fictional. Desktop real measurements use a separate result path. Replace these demo values only when
available, verify their units and L/R correspondence, and update the demo label
at that point. Color presets are independent of all measurement values.

### Model

`public/models/exmo-1001921.glb` is a **7,660,116-byte**, byte-for-byte extraction
of the supplied HTML model: **212,316 vertices / 424,456 triangles**. It requires
no external textures or model services.

To regenerate it, place the original `EXMO_Segmentation_Atlas.html` at the
repository root and run `npm run extract:model`. Extraction reads the embedded
base64 payload without executing the HTML. The packaged GLB is sufficient for
normal development and builds.

The renderer preserves each node's transform, centers and uniformly scales the
scene, computes the missing normals, and applies EXMO physical materials with
rim lighting. It disposes graphics resources when reloaded or unmounted.

The original `ExportSegmentationGLB.py` and its `exmo-muscles.json` manifest were
found alongside the source NRRD. That export's GLB has the same SHA-256 as the
packaged model (`555dbad58e9642dd5aaf18040b1008cf0f6ac1809bd88d98a0ba925a30306b0c`).
It maps NRRD LPS `(x, y, z)` to `(x, z, -y)`, then centers the scene. Thus +X
retains the patient-left direction. Tests verify that centered GLB X=0 separates
every triangle of the 24 paired classes. Hover uses these source triangle
coordinates, unaffected by camera view, explode translation, or segment rotation.
Iliac, Multifidus, and Rectus abdominis cross the midline and are not assigned a side.

The previous BodyParts3D assets and conversion pipeline are available in Git
history. They are no longer copied into this application's build.

## Validation

`npm test` locks the approved 27-class color mapping and checks GLB headers and
buffers, finite coordinates, valid triangle
indices, transforms, exact class membership, counts, aliases, selection and
visibility transitions, and WebMCP input validation. It also checks exploded
layout overlap at five aspect ratios for all nine filters, camera framing in
all four directions, and tap/drag/multitouch cancellation.

Browser checks cover direct model selection, search, isolation, opacity,
separation, camera presets, and responsive layouts at 1440×900, 390×844,
320×568, and 667×375. Physical mobile GPU performance and hardware multitouch
still require device testing.

## Scope and credits

Web remains the EXMO demo viewer; Desktop now includes local imaging analysis. Authentication,
server synchronization, server-side segmentation, and clinical
interpretation are separate features.

Application code retains the upstream [MIT license](LICENSE).
The supplied model has separate rights; no model license was stated in the
source HTML. Source hashes, adaptation details and historical credits are in
[ATTRIBUTION.md](public/ATTRIBUTION.md).
