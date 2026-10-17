# EXMO Segmentation Atlas

EXMO case **1001921** as a responsive React / Three.js application. The supplied
HTML's 27 meshes, class names and colors replace the fork's BodyParts3D viewer.
The original HTML is kept intact.

Windows Desktop also runs the supplied CT, MRI Water and X-ray thigh-analysis
models locally, with native measurements, overlays and case comparison.

The Desktop **DICOM folder** picker supports selecting multiple folders with
Ctrl/Shift in CT, MRI and X-ray workspaces. All selected folders are searched
recursively in one import; overlapping parent/child selections are collected
once. Existing file-count and byte limits apply to the whole selection.

**Product boundary:** image import and analysis belong to Desktop. Web is a result
viewer; server-backed result retrieval is planned, not implemented. The Web build
contains neither the Desktop analysis UI nor its Python runtime/model files.

## Product direction

[Solution productization and result-sharing design](docs/EXMO_SOLUTION_PRODUCTIZATION_DESIGN.md)
specifies one Desktop app with PC/YubiKey-bound solution entitlements, selective installation,
account-based institution result sharing, and read-only Web/tablet access. The first implementation
adds the built-in solution registry and persistent local result identities; account login, selective
installation and server publishing remain planned. See the [P1 implementation record](docs/EXMO_SOLUTION_P1_IMPLEMENTATION.md),
[implementation and acceptance plan](docs/EXMO_SOLUTION_PRODUCTIZATION_PLAN.md)
and the [standalone home-screen prototype](docs/prototypes/solution-home.html).

[Desktop licensing and model protection design](docs/EXMO_DESKTOP_SECURITY_DESIGN.md)
describes online activation and periodic entitlement renewal with YubiKey authentication,
limited offline grace (seven days is a policy candidate), encrypted model and result storage,
safe completion of running analyses, and regression gates against v0.1.24.
Internal Desktop builds now require an EXMO-approved Windows installation key,
without a dongle. Customer packaging is blocked until real YubiKey authentication,
protected worker/model loading and release signing are verified.
The [first-stage PIV verification runbook](docs/EXMO_SECURITY_POC_RUNBOOK.md) covers
isolated development tooling; it is not integrated into the Desktop runtime.
The [internal licensing runbook](docs/EXMO_LICENSE_POC_RUNBOOK.md) covers separate build
profiles, device approval, signed leases, Windows CNG/DPAPI, revocation and packaging.
Run `npm run test:license` to verify renewal, grace, revocation and safe completion.
Use `npm run desktop:pack:internal -- PATH_TO_PUBLIC_BUILD_CONFIG` (or
`desktop:dist:internal`) for internal packages. The normal `desktop:pack`/`desktop:dist`
customer paths currently fail closed. Source development (`npm run desktop`) is unchanged.
Internal results/config live separately under `%APPDATA%/EXMO Atlas Internal`.
Server keys, simulated devices and management scripts are excluded from packages.
Protected builds require signed encrypted CT/MRI/AP/LAT/classifier packages and fresh worker authorization.
New mask artifacts are encrypted; institution recovery keys remain separate from analysis licensing.
Customer builds bind both PC and YubiKey keys and require a signed offline runtime payload.
See the [product security runbook](docs/EXMO_PRODUCT_SECURITY_RUNBOOK.md) for provisioning, packaging,
revocation, recovery and the hardware/server/code-signing checks still required before release.
Version 0.1.26 accepts the USB-C keychain (5C NFC) and Nano PIV form factors with firmware 5.4+;
physical 5C NFC firmware 5.8 verification is still pending. Startup records per-stage times in
the profile's `startup-performance.json`; `npm run performance:startup -- PAYLOAD ISSUER_PUBLIC.pem NEW_REPORT.json`
measures full runtime verification without loading inference models.
Run `npm run test:model-security` for tamper/replay/worker checks and
`node scripts/security/validate-protected-mri.cjs` for the actual MRI strict loader and a
synthetic 128³ FP32 GPU comparison; this does not run patient cases.

[Development readiness and regression requirements](docs/EXMO_DEVELOPMENT_READINESS.md)
is the current implementation guide: the implemented Web/Windows baseline, protected
viewer behavior, data contracts, scoped development stages, and validation gates.

[EXMO Desktop·Web implementation direction](docs/EXMO_PRODUCT_ARCHITECTURE.md)
records the product requirements, current implementation, proposed architecture,
data and measurement rules, follow-up workflow, delivery stages, and open decisions
in Korean. It is a planning document, not a claim that those features are implemented.

[Imaging workflow and three-result comparison review](docs/EXMO_IMAGING_WORKFLOW_REVIEW_2026-09-25.md)
records the requested Series preview, review grid, analysis and comparison interactions.

[Bulk NRRD import and analysis pipeline notes](docs/EXMO_BULK_IMPORT_2026-09-30.md)
document the 0.1.11 implementation, review pagination, bounded GPU/CPU processing,
local NRRD file organization, executed checks and remaining validation limits.

CT/MRI review keeps the review list separate from the analysis selection. Click a
card or its checkbox to select it; selected cards have a highlighted border.
Deselection keeps the card visible, and selections persist across review dates and pages.
Only checked images that pass their input confirmations are sent for analysis;
the run button is disabled when none are eligible. Select-all is limited to the
current review list. `node node_modules/electron/cli.js scripts/validate-review-selection.cjs`
checks this flow with fixture IPC responses and no model inference, after
`npm run build:desktop`.

CT/MRI import and review views organize series as **patient → study date → images**.
Patient and date headers collapse/expand and offer group selection with partial-selection
indicators. Dates are newest first, with unknown dates last. Search includes patient ID,
institution and study date; select-all affects only matching images and keeps selections
outside the search. Review starts with every patient and date expanded, with up to four
image previews per page within each date. Each group can be folded independently;
analysis selection and input confirmations remain independent of the visible dates.
A large undated input group starts collapsed to keep imported studies easy to find.

The input list puts **Previously analyzed studies** at the top, collapsed initially.
Its subtle tinted background distinguishes the header and history rows without side stripes or vertical connector lines. The
explicit **Show list / Hide list** control opens the first patient's branch immediately;
the remaining history patients stay collapsed. A separated heading marks pending studies.
Any published result moves its whole study into that section, including other protocols
that have not yet been analyzed. Matching uses modality and Study UID, or the exact input
ID when a Study UID is absent; a shared patient/date alone never marks a study analyzed.
Only the actual input or matching Study/Series UIDs receives the **Analyzed** marker.
Search retains this classification even if the analyzed sibling is outside the search.
History series remain selectable for review or reanalysis. Patient → date → series uses
progressive indentation. Group backgrounds are neutral until selected;
preview focus underlines the series title without marking its checkbox as selected.

Automatic patient grouping uses patient ID plus issuer/institution. IDs without an issuer
are scoped to Study UID (or input ID), not merged across unrelated studies. Anonymous or
missing IDs go in the **Unassigned patients** organizational bucket; that bucket does not
assert that its images belong to the same person. Names and filenames never establish
patient identity or study dates. Legacy DICOM Study/Series UIDs are exposed from source
proof without rereading or modifying the original scans.

NRRD imports read both standard custom tags (`PatientID`, `StudyDate`, etc.) and
`DICOM_`-prefixed equivalents for all modalities. Legacy records are enriched from retained
private `input.nrrd` headers, including after CT validation converts the working volume to
NIfTI. The input/review list displays the series description; the original filename is
available on hover. Large patient lists initially expand only the first patient. Failed
imports without metadata have a separate **Import failed** group, not an unknown-date group.

For legacy converted DICOMs, run the CT-engine Python with
`scripts/recover-source-metadata.py --storage <userData/imaging>` to preview recovery,
then append `--apply` to save `source-metadata.json`. It uses retained NRRD headers or
an original DICOM frame whose Study/Series/SOP UIDs and SHA256 match the saved source proof.
It does not infer IDs or dates from folder/filenames. Local patient assignments override
recovered metadata; linked result displays and exports receive the same information.
This table is private patient data and must not be committed or uploaded.

In the input list, patient/date text toggles expansion. The right-hand count, blank area,
and **Select case / Deselect** action toggle group selection. Series row space also toggles
selection; its title remains a preview control. Shift-click selects an inclusive range
from the last selection at the same level (patients, dates, or series). Ranges follow the
displayed, filtered order and skip unavailable inputs; collapsed patient/date groups can
still select their eligible series. Review card ranges include intervening pages within
the expanded dates. The actual analysis choices remain separate in review.

Use **Assign patient / date** on a review group, or **Assign selected patient / date** in the input toolbar, to record
a confirmed patient ID and institution/dataset. An optional date overrides the selected
images' dates; leaving it blank preserves each image's existing date, including previous
local date assignments. **Restore original patient information** removes the local override.
Assignments persist in `imaging/patient-assignments.json` under userData and also apply to
linked results and exports. Original DICOM/NRRD/NIfTI files, library records, segmentation
masks and published result JSON stay unchanged. X-ray uses its separate persisted
`xray-studies.json` assignment table to explicitly combine selected images into a study.

X-ray import/review now shares patient/date headers, group hit areas and Shift-range
selection with CT/MRI. Automatic grouping is **patient → date → Study UID → projection**;
different studies on the same day stay separate unless explicitly assigned together.
Imported images start unchecked. Previously analyzed studies are collapsed at the top,
including unfinished sibling projections. Completion matches input ID or Study/SOP UID,
never Series UID alone: a second projection in the same series remains pending.

X-ray review expands all groups on entry, with a vertically scrolling list of studies
and fixed **LT / AP / RT** columns. Repeated projections appear as separate cards;
missing directions have placeholders and do not block partial-study analysis. Previews
load near the viewport. Review membership and run selection are independent; unchecking
keeps cards visible. Only checked, ready images with a classified direction run.
Completed images offer **Open results** and explicit **Select for reanalysis**, preserving
earlier results. Group/select-all actions exclude completed images until reanalysis is
explicitly selected. Existing result comparisons and version selectors remain available.

X-ray checks: `node scripts/validate-xray-studies.cjs` and, after building Desktop,
`node node_modules/electron/cli.js scripts/validate-xray-studies-desktop.cjs` cover study
boundaries, manual assignment persistence, completed/reimported projections, range
selection, expanded review, duplicate directions, exact run IDs and existing results.
These UI checks use synthetic inputs and do not run model inference.

Validation: `node --experimental-strip-types scripts/validate-patient-groups.mjs`,
`node scripts/validate-patient-assignments.cjs`, and (after the Desktop build)
`node node_modules/electron/cli.js scripts/validate-patient-workflow.cjs` cover identity
boundaries, date validity, persisted assignments, restoring originals, group/search
selection, cross-date execution and immediate regrouping. Export-source tests verify
that assignments reach image export identities through trusted backend records.

In Desktop, right-click a 2D image to save the displayed slice (including the
current overlay) as PNG or copy it to the clipboard. All 3D result layouts use
left-drag to rotate, middle-drag to pan, scrolling to zoom and right-click to
copy or save only the clicked viewport. This includes focused exploded muscles.
Copy uses Electron's asynchronous ClipboardItem PNG API and records a successful
export only after the clipboard write completes. Moving more
than five pixels suppresses the menu on release, even if the pointer returns to
its starting position. The Web demo keeps its existing controls.
For a single case, Explode opens assembled anatomy on the left and exploded
anatomy on the right. Hover highlights the same muscle in both views; selection
is shared while the assembled view keeps anatomical context and the exploded
view focuses the selected muscles. Each camera remains independent. Comparison
of multiple cases continues to show one viewport per case. PNG filenames include
the assembled/exploded layout to distinguish views of the same case.
Saved images contain the image/3D viewport, without the surrounding measurement
table or hover tooltip. Saving opens a location dialog; copying writes an image
to the clipboard. No original volume or segmentation file is changed.

Image export names start with the recorded patient ID (including leading zeros),
or a persistent UUID when that ID is missing/anonymous. Patient names and folder
names are never used to infer an ID. Anonymous series with the same Study UID
share a UUID; without a Study UID, the input ID is the stable scope. Different
anonymous studies remain separate. A known patient ID plus issuer/institution
can link studies; conflicting IDs are not silently merged.

The local `imaging/export-identities.json` table under the application's userData
stores UUIDs, patient IDs, study/series/input/result references and export history.
The image context menu's **Export identifier mapping (CSV)** saves this table for
later matching, including actual saved filenames, timestamps and PNG SHA-256.
It exports the complete local mapping table, with blank patient IDs where unknown.
Copy operations are recorded without a filename; cancelled saves create no export
history entry. UUIDs survive app restarts and cover both 2D and 3D exports.
Existing PNG files are not renamed retrospectively. JSON preserves exact IDs;
when importing CSV into Excel, select text columns to retain leading zeros.

`node scripts/validate-export-identities.cjs` checks persistence, matching scopes,
conflicts, concurrent requests and CSV output. The Electron
`scripts/validate-image-menu.cjs` check covers PNG byte parity, proposed names,
native Windows clipboard PNG pixels/dimensions (restoring the previous clipboard),
failed-copy history, mapping export and cancellation with test dialogs.
After building Desktop, `electron scripts/validate-image-actions.cjs <published.json>`
uses a local model with isolated test data to check per-viewport exports, paired
hover/selection, unified mouse controls and independent comparison cameras.

[Desktop performance checks](docs/DESKTOP_PERFORMANCE.md) cover real CT, MRI and
X-ray AP/LAT runs, repeated stage timings and numerical regression checks.
Run `npm run performance:desktop` after preparing the local Desktop engine.

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
  confirmation. UNETR/MONAI 1.3.2 FP32 CPU/GPU execution, native volume in cm3,
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

Desktop **Add images** also accepts ZIP archives (including nested folders of images);
ZIPs found inside a selected folder use the same importer. Extraction keeps original
archives untouched, preserves duplicate filenames, and checks paths, CRC, entry count
and expanded size. Encrypted or nested ZIPs are rejected. ZIP support does not bypass
modality or X-ray DICOM segmentation validation.

CT/MRI DICOM files are grouped by Study/Series UIDs and checked for spatial ordering,
orientation, spacing, duplicate/missing slices and rescale. Enhanced/multiframe,
color, 4D, detached NRRD and unsupported geometry are rejected. CT/MRI protocol
classification has not been supplied; input checks do not claim protocol suitability.
Hover temporarily previews a series; click pins it. Checkboxes select analysis inputs,
right-click excludes them, and wheel/slider or middle-button vertical dragging changes
slices in axial/coronal/sagittal views. Variant switching preserves view and slice.

Completed results persist locally. In the CT/MRI results list, checkboxes select cases
for **Export selected to Excel**, with no three-case limit. The header checkbox selects
all completed cases; partial selection is indicated. **Open results** opens one case,
independently of the export selection. Inside that result, **Add comparison** searches
other results of the same modality by patient, date or series and adds up to two more
cases (three including the base case). Added cases can be removed/replaced; the base
case stays fixed. Returning to the list preserves the export selection. X-ray retains
its study-based workflow. Measurements and QC appear in adjacent comparison columns.

The native save dialog writes a real `.xlsx` workbook with **Cases**, **Measurements**,
**Identifier mapping**, and **Read me** sheets. Each measurement row identifies a case,
structure and scope (total, patient left/right, or unassigned). Values, raw values when
available, units, counts, fat-range %, HU, entropy, side differences and QC fields retain
their stored precision. Unavailable metrics stay blank; numeric zeros remain zero.
The current saved variant is exported without rerunning analysis or postprocessing.
Patient IDs (including leading zeros), UUIDs and UIDs use literal text cells; formula-like
names are never executed. Numeric cells support Excel calculations. Headers are frozen
and filterable. The workbook's mapping sheet includes only selected cases and uses the
same persistent identity registry as image exports; its filename/hash are recorded in
the export history. XLSX creation requires neither installed Excel nor a Python engine.

`node scripts/validate-results-export.cjs` exercises cancellation, multi-case workbook
creation, persistent UUIDs and export history. `node scripts/validate-export-source.cjs`
also checks trusted backend IDs, duplicate IDs, missing results and modality boundaries.
After `npm run build:desktop`, `node node_modules/electron/cli.js scripts/validate-results-workflow.cjs`
checks select-all beyond three cases, exact export IDs, failure feedback, independent
single-result opening, comparison search/add/remove/cap and retained export selection.

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
compatible NVIDIA driver; explicit CPU execution is also exposed. One analysis batch
runs at a time. GPU mode overlaps stages for up to three items, with one GPU inference,
one CPU postprocessing task and one separate result-preparation task at a time;
memory admission can reduce concurrency. CPU mode processes one item at a time.
Cancellation terminates owned analysis processes and does not publish partial results.
CT restores class probabilities in native-grid blocks before normalization and argmax.

The installer contains the UI and private adapter scripts. The multi-GB model/runtime
store is installed separately; the installer alone is not a portable inference package.
Source development runs locally once the engine is prepared. Licensed internal builds
require online activation and periodic renewal, with bounded offline grace. Private weights, input
snapshots, masks and logs never enter `public/`, Git or the Web build. The renderer
receives opaque IDs, curated measurements, composed PNGs and permitted meshes.
Original input files are not modified. Clearing the worklist retains completed
results and the inputs they need. Local-machine owners can still inspect local assets;
this implementation does not claim DRM against the machine owner.

```sh
npm run desktop:pack:internal -- PATH_TO_PUBLIC_BUILD_CONFIG
npm run desktop:dist:internal -- PATH_TO_PUBLIC_BUILD_CONFIG
```

Outputs: `release/internal/win-unpacked/EXMO Atlas Internal.exe` and
`release/internal/EXMO-Atlas-Internal-Setup-<version>.exe` using the version in `package.json`.
This internal development build is unsigned.
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
# Check a local-test internal package with its matching loopback authority:
npx electron scripts/security/validate-internal-electron.cjs release/internal/win-unpacked/resources/app.asar work/security-internal-local/authority
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
