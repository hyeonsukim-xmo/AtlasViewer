# Clinical workspace refinement

> **For agentic workers:** Use executing-plans for inline implementation and one final independent review.

**Goal:** Apply the accepted Taste review to the working clinical interface, preserving analysis behavior and dark anatomy colors.
**Architecture:** Refine existing shared result components, Desktop navigation and CSS. Keep backend APIs, image processing, model settings, metrics and class identities unchanged.
**Tech stack:** Existing React, TypeScript, CSS, Electron and localization dictionary; no dependencies.
**Spec:** The user accepted the eight findings in the preceding UI review and requested a pushed checkpoint before implementation.

## Restore point

- `d44fc3f` on `origin/feat/solution-productization` contains the pre-refinement product code.
- Work on `ui/clinical-workspace-refinement` in the existing checkout so local engines and review data remain available.
- Per-case research documents remain local under the existing repository privacy instructions.

## Constraints and review focus

- Preserve modality-first analysis, row hit areas, adjustable measurement width and read-only server viewing.
- Preserve data, all-label initial Overlay visibility, per-muscle colors, bilateral geometry and 3D focus behavior.
- Keep CT fat-range and MRI uncertainty meanings; never relabel them as clinical FI or calibrated confidence.
- At 1440×900, three-case measurements should expose at least eight complete rows with compact secondary values.
- At 1024×768, comparison labels must wrap/read without ambiguous truncation; canvases may scroll horizontally with minimum usable widths.
- QC summaries must not be displaced by long unassigned-structure lists. Full details remain accessible.
- Every dialog has a visible keyboard-operable close action; focus returns to the invoking control.
- Signed-out accounts must not offer logout. Production authorization behavior remains unchanged.
- Korean and English UI remain complete; no raw license enum in the catalog.

## Tasks

- [x] Add a synthetic, read-only Electron UI regression harness for density, QC details, comparison dialog placement, modal close, narrow widths and focus/visibility wording. Run against baseline to record failures.
- [x] Compact catalog and workspace headings; remove duplicate healthy-status blocks; retain actionable errors and readiness checks.
- [x] Compact measurements; summarize QC and expose full detail in a readable dialog; distinguish Overlay visibility from 3D focus.
- [x] Flatten Desktop surface effects; support readable narrow comparisons; standardize modal closing and presentation language.
- [x] Run type/language checks, Desktop and server-viewer builds, UI regression and existing interaction checks. Inspect screenshots with saved QA examples at 1440, 1280 and 1024 widths.
- [x] Independent diff review; fix material findings and verify.
- [ ] Commit/push the UI branch and provide exact user review locations and rollback commit.

## Verification ledger

- Baseline: typecheck and Desktop build passed; 43 license/installation tests passed; diagnostics, worker lifecycle, atlas geometry and CT finite-check tests passed. No inference rerun.
- UI regression: `npm run test:clinical-ui` builds Desktop and runs a synthetic, read-only Electron fixture. Baseline exposed 13 failed checks; final 17 checks pass. A timed focus assertion was changed to await focus restoration. Hidden-window screenshots were removed because captures could be stale; visual evidence comes from a separate CDP run.
- Added a fixture with processing timings: TTA disagreement was initially below the viewport (RED); moving timing rows below clinical QC passed (GREEN).
- Final independent review found two material issues, both fixed: unavailable engines incorrectly labeled ready; duplicate About close controls. Added regression assertions, observed both fail, then pass after fixes.
- `npm run check`, `npm run test:language` (778 translations), `npm test`, `npm run test:solutions`, `npm run build:viewer` and `npm run test:desktop` passed. Desktop verified real IPC/sandbox, offline assets, single instance, GPU rendering, idle/minimized behavior and selection; no inference rerun.
- Read-only saved QA examples: CT input/Overlay/3D, MRI input/three-case measurements/QC/3D, X-ray input/results, account/installation/publication dialogs, comparison chooser and demo inspected. 20 screenshots at 1440, 1280 and 1024 widths; no page overflow or browser console errors. Private images stay outside Git.
- C: ran out of space during screenshots. Only this task's temporary test profiles were moved to D:, and subsequent test profiles/screenshots used D:. No source image, mask or patient record moved.

## User review route

Run `npm run desktop` from this checkout. Inspect the analysis catalog, open an MRI result and add two comparison cases, switch between measurements and QC, open QC details, and switch to 3D. Resize the measurement panel and narrow the window. Open account, solution management and transfers to check closing and keyboard focus. The shared server result viewer uses the same measurement/QC components.
