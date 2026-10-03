// The worker is serial. Discard obsolete viewport requests before sending IPC,
// so quickly changing review pages cannot leave dozens of volumes to decode.
let tail: Promise<void> = Promise.resolve();
export function schedulePreview<T>(request: () => Promise<T>, wanted: () => boolean): Promise<T | null> {
  const task = tail.then(() => wanted() ? request() : null);
  tail = task.then(() => {}, () => {});
  return task;
}
