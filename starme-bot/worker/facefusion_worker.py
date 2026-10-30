#!/usr/bin/env python3
"""StarMe AI generator worker — FaceFusion face-swap mode (free, offline, no API key).

Swaps the client's face onto the celebrity scene photo. This preserves the
exact pose, clothing, background and lighting of the scene reference. The JSON
design code is stored for reuse but does not steer this mode.

Install:
    pip install facefusion
Run:
    python3 worker/facefusion_worker.py        # listens on 0.0.0.0:8100

Protocol:
    POST /render {"identity_image": "<b64>", "scene_image": "<b64>", "params": {...}}
    -> {"image": "<b64>", "mime": "image/jpeg", "generator": "facefusion"}
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("WORKER_PORT", "8100"))


def _decode(data):
    return base64.b64decode(data or "")


def _run_facefusion(selfie_path, scene_path, out_path):
    cmd = ["facefusion", "run", "--source", selfie_path, "--target", scene_path, "--output", out_path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("facefusion failed: " + (proc.stderr or "").strip()[:300])
    if not os.path.exists(out_path):
        raise RuntimeError("facefusion produced no output file")


_analyzer = None


def _analyze(image_bytes):
    """Detect faces in a selfie — used by the optional abuse-prevention guard."""
    global _analyzer
    if _analyzer is None:
        import cv2
        import numpy as np
        from insightface.app import FaceAnalysis
        models_dir = os.environ.get("FACEFUSION_MODELS_DIR", os.path.expanduser("~/.insightface"))
        _analyzer = FaceAnalysis(
            name="buffalo_l", root=models_dir,
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        _analyzer.prepare(ctx_id=0, det_size=(640, 640))
    import cv2
    import numpy as np
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"faces": 0, "has_face": False, "error": "cannot decode image"}
    faces = _analyzer.get(img)
    return {"faces": len(faces), "has_face": len(faces) > 0}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "generator": "facefusion"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/analyze":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                self._send(200, _analyze(base64.b64decode(payload.get("image", ""))))
            except Exception as error:  # noqa: BLE001
                self._send(500, {"error": str(error)[:500]})
            return
        if self.path != "/render":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            selfie_b64 = payload.get("identity_image")
            scene_b64 = payload.get("scene_image")
            if not selfie_b64 or not scene_b64:
                self._send(400, {"error": "identity_image and scene_image are required"})
                return
            tmpdir = tempfile.mkdtemp(prefix="starme-ff-")
            try:
                selfie_path = os.path.join(tmpdir, "selfie.jpg")
                scene_path = os.path.join(tmpdir, "scene.jpg")
                out_path = os.path.join(tmpdir, "result.jpg")
                with open(selfie_path, "wb") as f:
                    f.write(_decode(selfie_b64))
                with open(scene_path, "wb") as f:
                    f.write(_decode(scene_b64))
                _run_facefusion(selfie_path, scene_path, out_path)
                with open(out_path, "rb") as f:
                    image = base64.b64encode(f.read()).decode()
                self._send(200, {"image": image, "mime": "image/jpeg", "generator": "facefusion"})
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception as error:  # noqa: BLE001 - report any failure to the caller
            self._send(500, {"error": str(error)[:500]})

    def log_message(self, fmt, *args):
        print("[facefusion-worker]", fmt % args)


if __name__ == "__main__":
    print(f"[facefusion-worker] listening on {HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
