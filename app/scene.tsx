import { useEffect, useRef, useState } from "react";
import * as T from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STRUCTURES, visibleStructures, type SceneState, type StructureId } from "./anatomy";
import {
  createExplosionLayout,
  EXPLOSION_DURATION_MS,
  transitionProgress,
} from "./explosion-layout";
import { fitCamera, viewDirection } from "./camera-fit";
import { PointerTap } from "./pointer-tap";
import { SegmentRotation } from "./segment-rotation";

interface Props {
  state: SceneState;
  onSelect: (id: StructureId | null) => void;
  onProgress: (progress: number) => void;
  onError: (message: string) => void;
  onInteract: () => void;
}
interface Piece {
  mesh: T.Mesh<T.BufferGeometry, T.MeshPhysicalMaterial>;
  pivot: T.Group;
  rotation: SegmentRotation;
  box: T.Box3;
  center: T.Vector3;
  goal: T.Vector3;
  from: T.Vector3;
  rim: { value: number };
}

export default function AnatomyScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const [hover, setHover] = useState("");
  useEffect(() => {
    const container = host.current!;
    const abort = new AbortController();
    let disposed = false,
      ready = false,
      dirty = true,
      frame = 0,
      lastTime = 0;
    let previous: SceneState | null = null,
      width = 1,
      height = 1,
      stageVisible = true,
      movingCamera = false;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let renderer: T.WebGLRenderer;
    try {
      renderer = new T.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      current.current.onError(
        "WebGL is unavailable. Enable hardware acceleration or try another browser.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "Interactive EXMO anatomy. Drag or use arrow keys to orbit, or pan in the fully separated view. In the exploded view, right-drag rotates the selected structure. Scroll, pinch, or use plus and minus to zoom. In the assembled view, click structures to add or remove them from your selection. Click the background to clear selection.",
    );
    container.appendChild(canvas);
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(30, 1, 0.01, 100);
    camera.position.set(0, 0, 5);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.autoRotateSpeed = 0.7;
    controls.minDistance = 0.2;
    controls.maxDistance = 30;
    controls.minPolarAngle = 0.08;
    controls.maxPolarAngle = Math.PI - 0.08;
    controls.addEventListener("change", () => {
      dirty = true;
    });
    controls.addEventListener("start", () => {
      movingCamera = false;
      current.current.onInteract();
      setHover("");
    });
    scene.add(new T.HemisphereLight("#d9f7ff", "#07111a", 1.4));
    const key = new T.DirectionalLight("#dffaff", 3.5);
    key.position.set(1.05, 1.7, 1.77);
    scene.add(key);
    const rimLight = new T.DirectionalLight("#37d6ff", 2);
    rimLight.position.set(-1.38, 0.4, -0.92);
    scene.add(rimLight);
    const pieces = new Map<StructureId, Piece>();
    const targetPosition = new T.Vector3(),
      targetLook = new T.Vector3();
    const cameraFrom = new T.Vector3(),
      lookFrom = new T.Vector3();
    let transitionStarted = 0,
      transitionDuration = 0;
    const bounds = new T.Box3(),
      raycaster = new T.Raycaster(),
      pointer = new T.Vector2();
    const tap = new PointerTap();
    let segmentDrag: { pointerId: number; id: StructureId; x: number; y: number } | null = null;

    function endSegmentDrag() {
      if (!segmentDrag) return;
      const id = segmentDrag.pointerId;
      segmentDrag = null;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      canvas.style.cursor = "grab";
    }

    function applyState(refit = false) {
      if (!ready) return;
      const state = current.current.state;
      const visible = visibleStructures(state);
      const ids = new Set(visible.map((s) => s.id));
      const restoreAll =
        !!previous && (state.reset !== previous.reset || state.explode < previous.explode);
      if (
        segmentDrag &&
        (!state.selected.includes(segmentDrag.id) || !ids.has(segmentDrag.id) || restoreAll)
      )
        endSegmentDrag();
      const layout = createExplosionLayout(
        visible.map((s) => {
          const box = pieces.get(s.id)!.box;
          return {
            id: s.id,
            bounds: [box.min.toArray(), box.max.toArray()] as [number[], number[]],
          };
        }),
        camera.aspect,
      );
      bounds.makeEmpty();
      for (const [id, piece] of pieces) {
        const { mesh, box, center, goal, rim } = piece;
        mesh.visible = ids.has(id);
        const cell = layout.cells.get(id);
        goal
          .set(cell ? cell.x - center.x : 0, cell ? cell.y - center.y : 0, -center.z)
          .multiplyScalar(state.explode);
        if (mesh.visible) bounds.union(box.clone().translate(goal));
        goal.add(center);
        const selected = state.selected.includes(id);
        if (!selected || !mesh.visible || restoreAll)
          piece.rotation.restore(performance.now(), reducedMotion);
        const dimmed = state.selected.length > 0 && !selected;
        const material = mesh.material;
        const transparent = dimmed && state.contextOpacity < 1;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        material.opacity = dimmed ? state.contextOpacity : 1;
        material.depthWrite = !transparent;
        material.emissiveIntensity = selected ? 0.28 : dimmed ? 0.015 : 0.095;
        material.clearcoat = selected ? 0.66 : 0.3;
        rim.value = selected ? 0.62 : dimmed ? 0.02 : 0.18;
        mesh.renderOrder = selected ? 3 : dimmed ? 1 : 2;
      }
      const fitChanged =
        refit ||
        !previous ||
        state.group !== previous.group ||
        state.hidden !== previous.hidden ||
        state.isolate !== previous.isolate ||
        (state.isolate && state.selected !== previous.selected) ||
        (state.selected !== previous.selected &&
          visibleStructures(previous)
            .map((s) => s.id)
            .join() !== visible.map((s) => s.id).join()) ||
        state.explode !== previous.explode ||
        state.view !== previous.view ||
        state.reset !== previous.reset;
      if (fitChanged) {
        const now = performance.now();
        const remaining = Math.max(0, transitionDuration - (now - transitionStarted));
        transitionDuration =
          reducedMotion || !previous
            ? 0
            : state.explode !== previous.explode
              ? EXPLOSION_DURATION_MS
              : remaining || 250;
        transitionStarted = now;
        // Clear residual orbit damping before the camera follows the animation timeline.
        controls.enableDamping = false;
        controls.autoRotate = false;
        controls.update(0);
        controls.enableDamping = true;
        for (const piece of pieces.values()) piece.from.copy(piece.pivot.position);
        cameraFrom.copy(camera.position);
        lookFrom.copy(controls.target);
      }
      controls.enableRotate = state.explode < 0.99;
      controls.mouseButtons.LEFT = controls.enableRotate ? T.MOUSE.ROTATE : T.MOUSE.PAN;
      controls.touches.ONE = controls.enableRotate ? T.TOUCH.ROTATE : T.TOUCH.PAN;
      controls.autoRotate = state.rotate && controls.enableRotate;
      if (fitChanged && !bounds.isEmpty()) {
        const forceView =
          !previous ||
          state.view !== previous.view ||
          state.reset !== previous.reset ||
          state.explode !== previous.explode;
        const direction = forceView
          ? viewDirection(state.view)
          : camera.position.clone().sub(controls.target).normalize();
        const fit = fitCamera(bounds, direction, camera.aspect, camera.fov);
        targetPosition.copy(fit.position);
        targetLook.copy(fit.target);
        controls.maxDistance = Math.max(
          8,
          fit.distance * 3,
          camera.position.distanceTo(controls.target) * 1.1,
        );
        controls.minDistance = Math.max(0.12, fit.distance * 0.12);
        movingCamera = true;
        if (!previous || reducedMotion) {
          camera.position.copy(targetPosition);
          controls.target.copy(targetLook);
        }
      }
      previous = state;
      dirty = true;
    }
    const resize = new ResizeObserver(() => {
      stageVisible = container.clientWidth > 0 && container.clientHeight > 0;
      if (!stageVisible) return;
      if (width === container.clientWidth && height === container.clientHeight) return;
      width = container.clientWidth;
      height = container.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      applyState(true);
      dirty = true;
    });
    resize.observe(container);

    function hit(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const candidates = [...pieces.values()]
        .filter((p) => p.mesh.visible && p.mesh.material.opacity > 0.01)
        .map((p) => p.mesh);
      return raycaster.intersectObjects(candidates, false)[0]?.object.name as
        | StructureId
        | undefined;
    }
    const down = (event: PointerEvent) => {
      const selected = current.current.state.explode
        ? current.current.state.selected[0]
        : undefined;
      if (
        event.button === 2 &&
        selected &&
        pieces.get(selected)?.mesh.visible &&
        event.buttons === 2
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        tap.cancel(event.pointerId);
        segmentDrag = {
          pointerId: event.pointerId,
          id: selected,
          x: event.clientX,
          y: event.clientY,
        };
        canvas.setPointerCapture(event.pointerId);
        controls.autoRotate = false;
        controls.enableDamping = false;
        controls.update(0);
        controls.enableDamping = true;
        movingCamera = false;
        pieces.get(selected)!.rotation.drag(0, 0, camera.quaternion);
        current.current.onInteract();
        setHover("");
        canvas.style.cursor = "grabbing";
        return;
      }
      if (event.button !== 0) return;
      tap.down(
        event.pointerId,
        event.clientX,
        event.clientY,
        event.pointerType === "touch" ? 12 : 5,
      );
    };
    const move = (event: PointerEvent) => {
      if (segmentDrag?.pointerId === event.pointerId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!(event.buttons & 2)) {
          endSegmentDrag();
          return;
        }
        pieces
          .get(segmentDrag.id)!
          .rotation.drag(
            event.clientX - segmentDrag.x,
            event.clientY - segmentDrag.y,
            camera.quaternion,
          );
        segmentDrag.x = event.clientX;
        segmentDrag.y = event.clientY;
        dirty = true;
        return;
      }
      tap.move(event.pointerId, event.clientX, event.clientY);
      if (event.buttons || event.pointerType === "touch" || movingCamera) return;
      const id = hit(event);
      setHover(STRUCTURES.find((s) => s.id === id)?.name ?? "");
      canvas.style.cursor = id ? "pointer" : "grab";
    };
    const up = (event: PointerEvent) => {
      if (segmentDrag?.pointerId === event.pointerId) {
        event.stopImmediatePropagation();
        endSegmentDrag();
        return;
      }
      if (tap.up(event.pointerId, event.clientX, event.clientY))
        current.current.onSelect(hit(event) ?? null);
    };
    const cancel = (event: PointerEvent) => {
      tap.cancel(event.pointerId);
      if (segmentDrag?.pointerId === event.pointerId) endSegmentDrag();
    };
    const leave = () => setHover("");
    const keydown = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-"].includes(event.key))
        return;
      event.preventDefault();
      current.current.onInteract();
      movingCamera = false;
      const selected = current.current.state.explode
        ? current.current.state.selected[0]
        : undefined;
      if (event.shiftKey && event.key.startsWith("Arrow") && selected) {
        const piece = pieces.get(selected);
        if (piece?.mesh.visible) {
          piece.rotation.drag(
            event.key === "ArrowLeft" ? -15 : event.key === "ArrowRight" ? 15 : 0,
            event.key === "ArrowUp" ? -15 : event.key === "ArrowDown" ? 15 : 0,
            camera.quaternion,
          );
          dirty = true;
        }
        return;
      }
      const offset = camera.position.clone().sub(controls.target);
      const spherical = new T.Spherical().setFromVector3(offset);
      if (event.key === "+" || event.key === "=") spherical.radius *= 0.88;
      else if (event.key === "-") spherical.radius *= 1.12;
      else if (controls.enableRotate) {
        if (event.key === "ArrowLeft") spherical.theta -= 0.12;
        if (event.key === "ArrowRight") spherical.theta += 0.12;
        if (event.key === "ArrowUp") spherical.phi -= 0.12;
        if (event.key === "ArrowDown") spherical.phi += 0.12;
      } else {
        const right = new T.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new T.Vector3().setFromMatrixColumn(camera.matrix, 1);
        const pan = new T.Vector3();
        if (event.key === "ArrowLeft") pan.addScaledVector(right, -spherical.radius * 0.04);
        if (event.key === "ArrowRight") pan.addScaledVector(right, spherical.radius * 0.04);
        if (event.key === "ArrowUp") pan.addScaledVector(up, spherical.radius * 0.04);
        if (event.key === "ArrowDown") pan.addScaledVector(up, -spherical.radius * 0.04);
        controls.target.add(pan);
      }
      spherical.phi = T.MathUtils.clamp(spherical.phi, 0.08, Math.PI - 0.08);
      spherical.radius = T.MathUtils.clamp(
        spherical.radius,
        controls.minDistance,
        controls.maxDistance,
      );
      camera.position.copy(controls.target).add(new T.Vector3().setFromSpherical(spherical));
      dirty = true;
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      current.current.onError(
        "The graphics context was interrupted. Reload the model to continue.",
      );
    };
    canvas.addEventListener("pointerdown", down, true);
    canvas.addEventListener("pointermove", move, true);
    canvas.addEventListener("pointerup", up, true);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("lostpointercapture", cancel);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("keydown", keydown);
    canvas.addEventListener("webglcontextlost", contextLost);

    (async () => {
      try {
        current.current.onProgress(0);
        const response = await fetch(import.meta.env.BASE_URL + "models/exmo-1001921.glb", {
          signal: abort.signal,
        });
        if (!response.ok) throw new Error("The EXMO model could not be downloaded.");
        const expectedBytes = 7660116;
        const reader = response.body?.getReader();
        if (!reader) throw new Error("This browser cannot read the model response.");
        const bytes = new Uint8Array(expectedBytes);
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (received + value.byteLength > expectedBytes)
            throw new Error("The model file has an unexpected size.");
          bytes.set(value, received);
          received += value.byteLength;
          if (!disposed) current.current.onProgress(Math.round((received / expectedBytes) * 85));
        }
        if (received !== expectedBytes) throw new Error("The model download was incomplete.");
        if (disposed) return;
        const gltf = await new GLTFLoader().parseAsync(bytes.buffer, "");
        gltf.scene.updateMatrixWorld(true);
        const sourceBounds = new T.Box3().setFromObject(gltf.scene);
        const center = sourceBounds.getCenter(new T.Vector3());
        const scale = 2.4 / sourceBounds.getSize(new T.Vector3()).y;
        const sourceMeshes: T.Mesh[] = [];
        gltf.scene.traverse((object) => {
          if (object instanceof T.Mesh) sourceMeshes.push(object);
        });
        try {
          if (sourceMeshes.length !== STRUCTURES.length)
            throw new Error("The model does not contain all 27 structures.");
          for (const source of sourceMeshes) {
            const structure = STRUCTURES.find((s) => s.id === source.name);
            if (!structure || pieces.has(structure.id))
              throw new Error("The model structure names do not match the catalogue.");
            const geometry = source.geometry.clone();
            geometry.applyMatrix4(source.matrixWorld);
            geometry.translate(-center.x, -center.y, -center.z);
            geometry.scale(scale, scale, scale);
            geometry.computeVertexNormals();
            geometry.computeBoundingBox();
            const rim = { value: 0.18 };
            const material = new T.MeshPhysicalMaterial({
              color: structure.color,
              emissive: structure.color,
              emissiveIntensity: 0.095,
              roughness: 0.56,
              metalness: 0,
              clearcoat: 0.3,
              clearcoatRoughness: 0.28,
              side: T.DoubleSide,
            });
            material.onBeforeCompile = (shader) => {
              shader.uniforms.uRimStrength = rim;
              shader.uniforms.uRimColor = {
                value: new T.Color(structure.color).lerp(new T.Color("#ffffff"), 0.6),
              };
              shader.vertexShader = shader.vertexShader
                .replace(
                  "#include <common>",
                  "#include <common>\nvarying vec3 vExmoNormal;\nvarying vec3 vExmoPosition;",
                )
                .replace(
                  "#include <worldpos_vertex>",
                  "#include <worldpos_vertex>\nvExmoPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvExmoNormal = normalize(mat3(modelMatrix) * objectNormal);",
                );
              shader.fragmentShader = shader.fragmentShader
                .replace(
                  "#include <common>",
                  "#include <common>\nvarying vec3 vExmoNormal;\nvarying vec3 vExmoPosition;\nuniform vec3 uRimColor;\nuniform float uRimStrength;",
                )
                .replace(
                  "#include <emissivemap_fragment>",
                  "#include <emissivemap_fragment>\nfloat exmoRim = pow(1.0 - max(dot(normalize(vExmoNormal), normalize(cameraPosition - vExmoPosition)), 0.0), 2.4);\ntotalEmissiveRadiance += uRimColor * exmoRim * uRimStrength;",
                );
            };
            const mesh = new T.Mesh(geometry, material);
            mesh.name = structure.id;
            const box = geometry.boundingBox!.clone();
            const pivot = new T.Group();
            const pieceCenter = box.getCenter(new T.Vector3());
            pivot.position.copy(pieceCenter);
            mesh.position.copy(pieceCenter).negate();
            pivot.add(mesh);
            pieces.set(structure.id, {
              mesh,
              pivot,
              rotation: new SegmentRotation(pivot.quaternion),
              box,
              center: pieceCenter,
              goal: new T.Vector3(),
              from: new T.Vector3(),
              rim,
            });
            scene.add(pivot);
          }
        } finally {
          for (const source of sourceMeshes) {
            source.geometry.dispose();
            for (const material of Array.isArray(source.material)
              ? source.material
              : [source.material])
              material.dispose();
          }
        }
        if (disposed) {
          for (const piece of pieces.values()) {
            piece.mesh.geometry.dispose();
            piece.mesh.material.dispose();
          }
          return;
        }
        ready = true;
        applyState(true);
        // Prepare both shader variants while loading, before the first selection changes opacity.
        for (const transparent of [false, true]) {
          for (const { mesh } of pieces.values()) {
            mesh.material.transparent = transparent;
            mesh.material.needsUpdate = true;
          }
          await renderer.compileAsync(scene, camera);
          if (disposed) return;
        }
        applyState();
        current.current.onProgress(100);
      } catch (error) {
        if (!disposed)
          current.current.onError(
            error instanceof Error ? error.message : "The EXMO model could not be loaded.",
          );
      }
    })();
    function tick(time: number) {
      frame = requestAnimationFrame(tick);
      if (document.hidden || !stageVisible || disposed) {
        lastTime = time;
        return;
      }
      const delta = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      if (current.current.state !== previous) applyState();
      const progress = transitionProgress(time - transitionStarted, transitionDuration);
      for (const piece of pieces.values()) {
        if (piece.rotation.update(time)) dirty = true;
        if (piece.pivot.position.distanceToSquared(piece.goal) > 0.0000001) {
          piece.pivot.position.lerpVectors(piece.from, piece.goal, progress);
          dirty = true;
        } else if (!piece.pivot.position.equals(piece.goal)) {
          piece.pivot.position.copy(piece.goal);
          dirty = true;
        }
      }
      if (movingCamera) {
        camera.position.lerpVectors(cameraFrom, targetPosition, progress);
        controls.target.lerpVectors(lookFrom, targetLook, progress);
        camera.lookAt(controls.target);
        if (progress === 1) movingCamera = false;
        dirty = true;
      } else controls.update(delta);
      if (dirty) {
        renderer.render(scene, camera);
        dirty = false;
      }
    }
    frame = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      abort.abort();
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      endSegmentDrag();
      canvas.removeEventListener("pointerdown", down, true);
      canvas.removeEventListener("pointermove", move, true);
      canvas.removeEventListener("pointerup", up, true);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("lostpointercapture", cancel);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("keydown", keydown);
      canvas.removeEventListener("webglcontextlost", contextLost);
      for (const piece of pieces.values()) {
        piece.mesh.geometry.dispose();
        piece.mesh.material.dispose();
      }
      renderer.dispose();
      canvas.remove();
    };
  }, []);
  return (
    <div className="scene">
      <div className="canvas-mount" ref={host} />
      {hover && (
        <div className="hover-label" aria-hidden="true">
          {hover}
        </div>
      )}
    </div>
  );
}
