"""No patient data. Exercise disk bytes, tampering, seeking, native geometry and vendor readback."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import secrets
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'desktop'))
import artifact_store as A


class Artifacts(unittest.TestCase):
    def test_blocks(self):
        key = secrets.token_bytes(32)
        payload = secrets.token_bytes(A.CHUNK * 2 + 3127)
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'mask.nrrd'
            with A.Writer(open(file, 'xb'), key) as stream:
                for start in range(0, len(payload), 733): stream.write(payload[start:start + 733])
            ciphertext = file.read_bytes()
            self.assertTrue(ciphertext.startswith(A.MAGIC)); self.assertNotIn(payload[:128], ciphertext)
            with io.BufferedReader(A.Reader(open(file, 'rb'), key)) as stream:
                self.assertEqual(hashlib.file_digest(stream, 'sha256').digest(), hashlib.sha256(payload).digest())
                for offset in (A.CHUNK - 10, 1, len(payload) - 5, 0):
                    stream.seek(offset); self.assertEqual(stream.read(43), payload[offset:offset + 43])
            for changed in (ciphertext[:-1], ciphertext + b'0', ciphertext[:30] + bytes([ciphertext[30] ^ 1]) + ciphertext[31:],
                            ciphertext[:A.HEADER] + ciphertext[A.HEADER + A.CHUNK + 16:A.HEADER + 2 * (A.CHUNK + 16)] + ciphertext[A.HEADER:A.HEADER + A.CHUNK + 16] + ciphertext[A.HEADER + 2 * (A.CHUNK + 16):]):
                file.write_bytes(changed)
                with self.assertRaises(Exception):
                    with A.Reader(open(file, 'rb'), key) as stream: stream.read()
            file.write_bytes(ciphertext)
            with self.assertRaises(Exception): A.Reader(open(file, 'rb'), secrets.token_bytes(32))

    def test_image_adapters_and_vendor_writers(self):
        import numpy as np
        import nrrd
        import nibabel as nib
        import SimpleITK as sitk
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = A.install(root, secrets.token_bytes(32)); A.install_image_io(store)
            array = np.arange(11 * 13 * 17, dtype=np.uint16).reshape(11, 13, 17) % 29
            image = sitk.GetImageFromArray(array)
            image.SetSpacing((.8, 1.2, 3.)); image.SetOrigin((-72., 34., 56.)); image.SetDirection((0., -1., 0., 1., 0., 0., 0., 0., 1.))
            file = root / 'mask.nrrd'
            sitk.WriteImage(image, str(file), True)
            with A._open(file, 'rb') as stream: self.assertEqual(stream.read(8), A.MAGIC)
            restored = sitk.ReadImage(str(file))
            self.assertTrue(np.array_equal(array, sitk.GetArrayFromImage(restored)))
            self.assertEqual(image.GetDirection(), restored.GetDirection()); self.assertEqual(image.GetOrigin(), restored.GetOrigin())
            for encoding in ('gzip', 'raw'):
                output = root / ('side-' + encoding + '.nrrd')
                nrrd.write(str(output), array, {'encoding':encoding}, index_order='C')
                self.assertTrue(np.array_equal(nrrd.read(str(output), index_order='C')[0], array))
            ni = nib.Nifti1Image(array.transpose(2, 1, 0), np.diag([.8, 1.2, 3., 1.]))
            ni.header.set_xyzt_units('mm'); ni.set_sform(ni.affine, 1); ni.set_qform(ni.affine, 1)
            nib.save(ni, root / 'mask.nii.gz')
            self.assertTrue(np.array_equal(nib.load(root / 'mask.nii.gz').dataobj, ni.dataobj))
            np.save(root / 'array.npy', array, allow_pickle=False)
            self.assertTrue(np.array_equal(np.load(root / 'array.npy', allow_pickle=False), array))
            with self.assertRaises(io.UnsupportedOperation):
                np.load(root / 'array.npy', allow_pickle=False, mmap_mode='r')
            np.savez_compressed(root / 'array.npz', mask=array)
            with np.load(root / 'array.npz', allow_pickle=False) as archive:
                self.assertTrue(np.array_equal(archive['mask'], array))
            # CT uses atomic os.open/fdopen, then nibabel and pynrrd strict readback.
            sys.path.insert(0, str(ROOT / 'work/modality-integration/packages/EXMO_CT/src'))
            from thigh_muscle_seg_ct.data import image_io
            from thigh_muscle_seg_ct.spatial import LabelVolume
            from thigh_muscle_seg_ct.data.ontology import ONTOLOGY_ID
            from thigh_muscle_seg_ct.core import atomic
            atomic._fsync_directory = lambda path: None
            geometry = image_io.geometry_from_affine(tuple(reversed(array.shape)), np.diag([.8, 1.2, 3., 1.]))
            volume = LabelVolume(array.astype(np.uint8), geometry, ONTOLOGY_ID)
            image_io.save_nifti(root / 'ct.nii.gz', volume)
            self.assertTrue(np.array_equal(image_io.load_label(root / 'ct.nii.gz').data_zyx, array))
            # MRI scalar writer keeps its original geometry and voxel readback checks.
            sys.path[:0] = [str(ROOT / 'work/modality-integration/packages/EXMO_MRI/src')]
            from thigh_muscle_seg.data import image_io as mri_io
            from thigh_muscle_seg.spatial import SpatialVolume
            spec = importlib.util.spec_from_file_location('runner', ROOT / 'desktop/model-runner.py')
            runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
            runner.windows_nrrd_reader(mri_io)
            mri_geometry = mri_io._geometry_from_nrrd(array.transpose(2, 1, 0), {'space':'LPS', 'space directions':np.diag([.8, 1.2, 3.]), 'space origin':[0., 0., 0.]})
            mri_io.write_scalar_image(SpatialVolume(array, mri_geometry), root / 'mri.nrrd')
            self.assertTrue(np.array_equal(mri_io.load_scalar_image(root / 'mri.nrrd').data_zyx, array))
            from thigh_muscle_seg.core import atomic as mri_atomic
            from thigh_muscle_seg.integrations import slicer_export
            from thigh_muscle_seg.data.ontology import load_ontology
            from thigh_muscle_seg.spatial import LabelVolume as MRILabelVolume
            runner.windows_transactions(mri_atomic)
            exporter = runner.windows_slicer_export(slicer_export, mri_atomic)
            bundle = ROOT / 'work/modality-integration/packages/EXMO_MRI'
            ontology = load_ontology(bundle / 'configs/dataset/mri_thigh_29class_v001.json')
            contract = slicer_export.load_slicer_export_contract(bundle / 'configs/export/slicer_segmentation_v001.json')
            report = exporter(MRILabelVolume(array.astype(np.uint8), mri_geometry, ontology.ontology_id), ontology,
                slicer_export.SlicerProvenance('synthetic', 'synthetic', 'synthetic', '1' * 64), root / 'complete.seg.nrrd', contract=contract)
            self.assertTrue(np.array_equal(nrrd.read(str(root / 'complete.seg.nrrd'), index_order='C')[0], array))
            for output in root.iterdir():
                with A._open(output, 'rb') as stream: self.assertEqual(stream.read(8), A.MAGIC, output.name)


if __name__ == '__main__': unittest.main()
