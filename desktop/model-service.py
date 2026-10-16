"""Batch-lived model service: one GPU lane, bounded CPU handoff, immutable weights.

The desktop owns admission, CPU scheduling and cancellation. A completed GPU phase
does not mark a result complete; the unchanged vendor export/readback still runs.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import threading
import traceback
import faulthandler
import os
from diagnostics import failure

sys.dont_write_bytecode = True
from model_security import ModelGuard, load_policy, model_id, package_file
spec = importlib.util.spec_from_file_location("desktop_runner", Path(__file__).with_name("model-runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class AtomicLines:
    """Prevent vendor print calls in different jobs from corrupting protocol lines."""
    def __init__(self):
        self.local = threading.local()
    def write(self, value):
        text = getattr(self.local, "text", "") + value
        while "\n" in text:
            line, text = text.split("\n", 1)
            with runner._emit_lock:
                runner._stdout.write(line + "\n")
                runner._stdout.flush()
        self.local.text = text
        return len(value)
    def flush(self):
        with runner._emit_lock:
            runner._stdout.flush()
    def __getattr__(self, name):
        return getattr(runner._stdout, name)


class Control:
    def __init__(self, ident, gpu):
        self.ident, self.gpu = ident, gpu
        self.gpu_owned = False
        self.ready = threading.Event()
        self.cancelled = False
        self.handed_off = False
        self.finished = False
    def cpu_phase(self, job, torch):
        if self.handed_off:
            raise RuntimeError("Duplicate GPU handoff")
        self.handed_off = True
        torch.cuda.synchronize()
        job["execution"]["peak_gpu_memory_bytes"] = torch.cuda.max_memory_allocated()
        if job["execution"]["peak_gpu_memory_bytes"] <= 0:
            raise RuntimeError("GPU phase did not allocate CUDA memory")
        job["execution"]["pipeline"] = "gpu_cpu_overlap_v1"
        self.release_gpu()
        runner.emit("cpu_ready", execution=job["execution"])
        self.ready.wait()
        if self.cancelled:
            raise RuntimeError("Analysis cancelled before CPU processing")
        runner.emit("cpu_started")
    def release_gpu(self):
        if self.gpu_owned:
            self.gpu_owned = False
            self.gpu.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", type=Path, required=True)
    args = parser.parse_args()
    model_guard = ModelGuard(load_policy(), args.engine_root)
    faulthandler.enable()
    if os.environ.get("EXMO_DIAGNOSTIC_STACKS") == "1":
        faulthandler.dump_traceback_later(120, repeat=True)
    sys.stdout = AtomicLines()
    gpu, guard = threading.Lock(), threading.Lock()
    active, threads = {}, []
    initialized = False

    def execute(control, job, protection):
        runner._context.control = control
        try:
            gpu.acquire()
            control.gpu_owned = True
            if control.cancelled:
                raise RuntimeError("Analysis cancelled")
            runner.run_job(args.engine_root, job, protection=protection)
        except Exception as error:
            runner.emit("failed", **failure(error, 'run', control.ident))
        finally:
            if protection is not None:
                protection.close()
            control.release_gpu()
            # Each CT/MRI module has per-job hooks; never retain completed closures.
            for prefix in ("exmo_ct_vendor_", "exmo_mri_vendor_"):
                sys.modules.pop(prefix + control.ident, None)
            with guard:
                active.pop(control.ident, None)
            runner._context.control = None

    for line in sys.stdin:
        message = {}
        try:
            parsed = json.loads(line)
            if not isinstance(parsed, dict):
                raise ValueError('Invalid model service request')
            message = parsed
            if message['operation'] == 'storage_init':
                import artifact_store
                artifact_store.initialize(message)
                continue
            ident = str(message["id"])
            if message["operation"] == "model_challenge":
                try:
                    reply = {'id': ident, 'result': model_guard.challenge(message['runId'], message.get('engine', 'mri'))}
                except Exception as error:
                    reply = {'id': ident, **failure(error, 'model_challenge', ident, code='AUTHORIZATION')}
                with runner._emit_lock:
                    runner._stdout.write(json.dumps(reply) + '\n')
                    runner._stdout.flush()
            elif message['operation'] == 'model_discard':
                model_guard.pending.pop(message['runId'], None)
            elif message["operation"] == "resume_cpu":
                with guard:
                    control = active.get(ident)
                if control:
                    control.ready.set()
            elif message["operation"] == "run":
                protection = None
                job = message['job']
                engine = model_id(job)
                if model_guard.policy or (model_guard.model_root(engine) / package_file(engine)).exists():
                    try:
                        import artifact_store
                        if artifact_store.current() is None:
                            raise ValueError('Protected result storage was not initialized')
                        protection = model_guard.admit(ident, job, message.pop('authorization', None))
                    except Exception as error:
                        runner.emit('failed', job_id=ident, **failure(error, 'run', ident, code='AUTHORIZATION'))
                        continue  # Denied new work must not terminate another job's CPU export.
                if not initialized:
                    # Initialize native DLLs before a thread blocks on Windows stdin.
                    # NumPy/OpenBLAS initialization otherwise stalls in create_module.
                    job = message["job"]
                    def load_dependency(name):
                        return runner.observed("startup_" + name,
                            lambda: importlib.import_module(name), job_id=ident)()
                    if job["analysis"] == "ct":
                        runner.observed("startup_torch", runner.ct_torch, job_id=ident)(
                            args.engine_root / "packages/EXMO_CT", job.get("device", "cuda:0"))
                    else:
                        load_dependency("torch")
                    load_dependency("numpy")
                    if job["analysis"] != "xray" or job.get("route") != "AP":
                        load_dependency("SimpleITK")
                    if job["analysis"] in ("ct", "mri"):
                        load_dependency("monai")
                    elif job.get("route") != "AP":
                        # nnUNet imports additional native SciPy/scikit-image modules.
                        # Warm these before the stdin reader and inference thread overlap.
                        load_dependency("nnunetv2.inference.predict_from_raw_data")
                        load_dependency("nnunetv2.imageio.simpleitk_reader_writer")
                    initialized = True
                with guard:
                    if ident in active or sum(not item.finished for item in active.values()) >= 2:
                        raise RuntimeError("Model service admission limit exceeded")
                    control = Control(ident, gpu)
                    active[ident] = control
                thread = threading.Thread(target=execute, args=(control, message["job"], protection), daemon=True)
                threads = [item for item in threads if item.is_alive()]
                threads.append(thread)
                thread.start()
                protection = None  # The admitted job owns cleanup even after expiry/revocation.
            else:
                raise ValueError("Unknown model service operation")
        except Exception as error:
            if locals().get('protection') is not None:
                protection.close()
            runner.emit('failed', job_id=message.get('id'), **failure(error, message.get('operation'), message.get('id'), code='MODEL_LOAD'))
            # Protocol corruption is fatal, never silently wait for an absent result.
            break
    with guard:
        for control in active.values():
            control.cancelled = True
            control.ready.set()
    for thread in threads:
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
