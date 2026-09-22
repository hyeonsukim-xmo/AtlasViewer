# EXMO Segmentation Atlas attribution

## Current model

The current application displays the 27 meshes embedded in the supplied
`EXMO_Segmentation_Atlas.html`, case 1001921. Class names, grouping, and colors
are preserved from that file. The GLB is extracted byte-for-byte without
geometry simplification: 212,316 vertices and 424,456 triangles.

- HTML SHA256: `2debc9432350dc17ea79d7d2fe20ff9777b76ffe155c535d58e36917456969e0`
- GLB SHA256: `555dbad58e9642dd5aaf18040b1008cf0f6ac1809bd88d98a0ba925a30306b0c`
- Runtime display changes: node transforms are applied, the scene is centered
  and uniformly scaled, vertex normals are computed, and EXMO colors are
  rendered with physical materials and a rim highlight. Source geometry is
  retained. Display scale does not imply a physical measurement unit.
- A segmentation class may contain both sides and disconnected components.
  Source identifiers such as `mulifidus` are retained; the visible label is
  corrected to `Multifidus`.

The supplied HTML does not state the model's author or redistribution license.
The application MIT license does not grant rights to this model. EXMO model
rights and distribution terms must be supplied by its owner before external
distribution.

## Application

This application is adapted from [ashemag/human-atlas](https://github.com/ashemag/human-atlas)
through [hyeonsukim-xmo/AtlasViewer](https://github.com/hyeonsukim-xmo/AtlasViewer).
The original MIT copyright notice is retained in `LICENSE`. Third-party
dependencies retain their respective licenses.

## Historical BodyParts3D data (not shipped in this version)

The following credits apply to earlier repository revisions. Those assets
have been replaced by the EXMO model in the current public directory.

BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International.

- License: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html (updated 2025-02-27)
- Dataset: https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html
- License terms: https://creativecommons.org/licenses/by/4.0/
- Source geometry: `isa_BP3D_4.0_obj_99.zip`, BodyParts3D 4.0.
- English names and relationships: IS-A and PART-OF concept, element, and inclusion tables from the same archive.
- Publication: Mitsuhashi et al. (2009), BodyParts3D: 3D structure database for anatomical concepts. https://doi.org/10.1093/nar/gkn613

Adaptations: axes and units converted from millimeters/Z-up to meters/Y-up; translated to rest at the stage; geometry simplified using meshoptimizer with 0.2% relative error limit per structure; normals quantized to signed 16-bit; packed into binary chunks; curated display system groupings and colors. The source contains 2,234 individual OBJ meshes; all remain represented. The combined hierarchy contains 3,432 named FMA concepts, which may reference multiple meshes. Original source identity is preserved in the manifest.

Source OBJ comments mention an older CC BY-SA 2.1 Japan license. The official current database license linked above supersedes that legacy text and explicitly permits redistribution and adaptation under CC BY 4.0.

BodyParts3D represents an adult male reference anatomy based on TARO MRI and anatomical illustration refinements. It is not a complete model of every possible human anatomical structure or variation. This interface is educational and is not a clinical tool.

## Historical assets (not included in the current release)

Earlier repository revisions included female reference anatomy: Kristen Browne and Heidi Schlehlein, Human Reference Atlas / HuBMAP, _3D Reference Organ Set for Female v1.5_ (2023). CC BY 4.0. Geometry adapted for this viewer.

- Source DOI: https://doi.org/10.48539/HBM352.BTSQ.586
- Dataset: https://lod.humanatlas.io/ref-organ/united-female/v1.5
- Original GLB: https://cdn.humanatlas.io/digital-objects/ref-organ/united-female/v1.5/assets/3d-vh-f-united.glb
- License: https://creativecommons.org/licenses/by/4.0/

Adaptations: translated native meter/Y-up coordinates onto the stage, coincident vertices welded and source normals averaged, geometry simplified with a 0.2% per-structure relative error bound, and normals quantized. Colors and display systems are curated for this interface. All 888 source meshes are represented, with 1,073 source nodes available as selectable individual or compound concepts.

This is a reference assembly with whole-body surface and selected organs, including female reproductive anatomy. Its skeleton and muscle coverage is partial. It is not a complete model of every human structure or a single-person scan. Eight placenta/umbilical structures are classified under Pregnancy reference and hidden by default.
