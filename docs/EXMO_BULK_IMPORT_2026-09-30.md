# CT NRRD bulk import fix — 0.1.3

## Cause

The previous importer sent every selected image in one worker request with a
five-minute deadline. CT NRRD import decoded all voxels, validated all values,
converted and compressed each volume as NIfTI, then hashed it. The catalog was
saved only after the entire request finished. A timeout discarded that import.

## Changes

- CT NRRD registration reads headers and checks dimensions, channel count,
  spacing and physical orientation without decoding the full payload.
- The app still takes a private snapshot. Its NRRD bytes remain unchanged; the
  snapshot is moved into storage instead of copied and recompressed again.
- Full intensity/payload validation, HU confirmation and NIfTI conversion remain
  mandatory before CT inference. Hash evidence binds to the converted input.
- Standalone image requests have separate deadlines. Each completed item is
  saved immediately; a failed item is shown as failed while later items continue.
- DICOM files are kept together for series grouping; their import path is not
  converted to header-only registration by this change.
- The UI shows registration progress and distinguishes header verification from
  full input verification. Korean and English strings are included.
- Clearing inputs preserves directories referenced by completed results, including
  the deferred conversion file used by CT results.

## Verification

- scripts/validate-bulk-import.py: actual CT sample (512 × 512 × 185) exported as
  a 72,133,361-byte compressed NRRD; header registration approximately 0.094 s.
  Checks unchanged bytes, exact voxel parity and physical geometry after deferred
  conversion, mandatory HU confirmation, evidence hashes, and rejection of
  constant/corrupt data before inference.
- scripts/validate-bulk-import.cjs: actual backend and Python worker; only the
  Electron file picker and IPC shell are replaced. Imports the representative
  sample 118 times, including actual private file copies (~8.51 GB total).
  Packaged backend: 118 registered in 9.20 s. Intermediate catalog saves and
  restart persistence pass. A deliberately forced timeout affects one item only;
  the preceding and following items remain registered.
- This repeated-sample benchmark is not a timing guarantee for 118 distinct user
  files. The original failing selection was not available for a direct replay.
- TypeScript, 244-entry language validation, atlas integrity, existing interaction
  tests and production desktop build pass.
- A first packaged test attempt reported a filesystem-access error; the diagnostic
  rerun passed. The underlying transient cause was not established.
- Real Electron GUI revalidation was blocked in this restricted session by GPU
  process startup failures. No full segmentation inference was rerun for this fix.

Reports: outputs/bulk-import-check (ignored). Tests use workspace-only temporary
libraries and do not alter the installed application's results or configuration.

## Apply update

Close EXMO Atlas, run:

release/bulk-import-0.1.3-verified/EXMO-Atlas-Setup-0.1.3.exe

Then reopen the desktop shortcut and add the images again. Existing engine and
library paths are unchanged. This session can create the installer in the
workspace but cannot update the installation under AppData; installation is a
separate user action. Source changes have not been committed or pushed yet.
