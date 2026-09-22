import { Euler, Quaternion } from "three";
import { transitionProgress } from "./explosion-layout.ts";

export const ROTATION_RETURN_MS = 700;
const identity = new Quaternion();

export class SegmentRotation {
  private from = new Quaternion();
  private delta = new Quaternion();
  private inverseCamera = new Quaternion();
  private angles = new Euler(0, 0, 0, "YXZ");
  private started: number | null = null;
  readonly quaternion: Quaternion;

  constructor(quaternion: Quaternion) {
    this.quaternion = quaternion;
  }

  drag(dx: number, dy: number, camera: Quaternion) {
    this.started = null;
    this.angles.set(dy * 0.008, dx * 0.008, 0);
    this.delta.setFromEuler(this.angles);
    this.inverseCamera.copy(camera).invert();
    this.delta.premultiply(camera).multiply(this.inverseCamera);
    this.quaternion.premultiply(this.delta).normalize();
  }

  restore(time: number, immediate = false) {
    if (immediate) {
      this.quaternion.identity();
      this.started = null;
    } else if (this.started === null && this.quaternion.angleTo(identity) > 1e-8) {
      this.from.copy(this.quaternion);
      this.started = time;
    }
  }

  update(time: number) {
    if (this.started === null) return false;
    const progress = transitionProgress(time - this.started, ROTATION_RETURN_MS);
    this.quaternion.slerpQuaternions(this.from, identity, progress);
    if (progress === 1) this.started = null;
    return true;
  }
}
