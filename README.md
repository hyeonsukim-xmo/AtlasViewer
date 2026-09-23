# EXMO Segmentation Atlas

EXMO case **1001921** as a responsive React / Three.js application. The supplied
HTML's 27 meshes, class names and colors replace the fork's BodyParts3D viewer.
The original HTML is kept intact.

## Product direction

[EXMO Desktop·Web implementation direction](docs/EXMO_PRODUCT_ARCHITECTURE.md)
records the product requirements, current implementation, proposed architecture,
data and measurement rules, follow-up workflow, delivery stages, and open decisions
in Korean. It is a planning document, not a claim that those features are implemented.

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

Real calculations and NRRD loading are not connected. Replace the demo values with the supplied calculation results when
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

`npm test` checks GLB headers and buffers, finite coordinates, valid triangle
indices, transforms, exact class membership, counts, aliases, selection and
visibility transitions, and WebMCP input validation. It also checks exploded
layout overlap at five aspect ratios for all nine filters, camera framing in
all four directions, and tap/drag/multitouch cancellation.

Browser checks cover direct model selection, search, isolation, opacity,
separation, camera presets, and responsive layouts at 1440×900, 390×844,
320×568, and 667×375. Physical mobile GPU performance and hardware multitouch
still require device testing.

## Scope and credits

This is the EXMO 3D viewer frontend for one supplied case. Authentication,
case storage, file uploads, server-side segmentation, and clinical
interpretation are separate features.

Application code retains the upstream [MIT license](LICENSE).
The supplied model has separate rights; no model license was stated in the
source HTML. Source hashes, adaptation details and historical credits are in
[ATTRIBUTION.md](public/ATTRIBUTION.md).
