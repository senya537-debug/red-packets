#!/usr/bin/env python3
"""StarMe AI generator worker — InstantID mode (free, offline, no API key).

This is the "design-code driven" mode: the JSON design code is turned into a
text prompt, the client selfie supplies identity (ArcFace embedding) and the
celebrity photo supplies the pose (IdentityNet keypoints). The scene is
regenerated rather than swapped.

Requires a CUDA GPU for practical speed.

Install:
    pip install torch diffusers transformers accelerate insightface opencv-python
    # 1) download antelopev2 face model into ./models (see InstantID README)
    # 2) download InstantID weights (ControlNetModel + ip-adapter.bin) into
    #    ./checkpoints
    # 3) copy pipeline_stable_diffusion_xl_instantid.py next to this file
Run:
    python3 worker/instantid_worker.py        # listens on 0.0.0.0:8101

Protocol:
    POST /render {"prompt": "...", "negative_prompt": "...", "identity_image": "<b64>",
                  "scene_image": "<b64>", "params": {...}}
    -> {"image": "<b64>", "mime": "image/jpeg", "generator": "instantid"}
"""
import base64
import json
import os
import shutil
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("WORKER_PORT", "8101"))
MODELS_DIR = os.environ.get("INSTANTID_MODELS_DIR", ".")
BASE_MODEL = os.environ.get("INSTANTID_BASE_MODEL", "wangqixun/YamerMIX_v8")

_app = None
_pipe = None


def _load():
    global _app, _pipe
    if _pipe is not None:
        return
    import torch
    from insightface.app import FaceAnalysis
    from diffusers import ControlNetModel
    from pipeline_stable_diffusion_xl_instantid import StableDiffusionXLInstantIDPipeline

    _app = FaceAnalysis(
        name="antelopev2", root=MODELS_DIR,
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    _app.prepare(ctx_id=0, det_size=(640, 640))

    controlnet = ControlNetModel.from_pretrained(
        os.path.join(MODELS_DIR, "checkpoints", "ControlNetModel"), torch_dtype=torch.float16
    )
    _pipe = StableDiffusionXLInstantIDPipeline.from_pretrained(
        BASE_MODEL, controlnet=controlnet, torch_dtype=torch.float16
    )
    _pipe.load_ip_adapter_instantid(os.path.join(MODELS_DIR, "checkpoints", "ip-adapter.bin"))
    _pipe.cuda()


def _analyze(image_bytes):
    """Detect faces in a selfie — used by the optional abuse-prevention guard."""
    import cv2
    import numpy as np
    _load()
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"faces": 0, "has_face": False, "error": "cannot decode image"}
    faces = _app.get(img)
    return {"faces": len(faces), "has_face": len(faces) > 0}


def _infer(selfie_path, scene_path, out_path, prompt, negative_prompt, params):
    import cv2
    import numpy as np
    import torch
    from PIL import Image
    from pipeline_stable_diffusion_xl_instantid import draw_kps

    _load()

    selfie_img = Image.open(selfie_path).convert("RGB")
    selfie_bgr = cv2.cvtColor(np.array(selfie_img), cv2.COLOR_RGB2BGR)
    faces = _app.get(selfie_bgr)
    if not faces:
        raise RuntimeError("no face detected in the client selfie")
    face_info = max(faces, key=lambda f: (f["bbox"][2] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][1]))
    face_emb = face_info["embedding"]

    scene_img = Image.open(scene_path).convert("RGB")
    scene_faces = _app.get(cv2.cvtColor(np.array(scene_img), cv2.COLOR_RGB2BGR))
    if scene_faces:
        pose_kps = draw_kps(scene_img, max(scene_faces, key=lambda f: (f["bbox"][2] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][1]))["kps"])
    else:
        pose_kps = draw_kps(selfie_img, face_info["kps"])

    image = _pipe(
        prompt,
        negative_prompt=negative_prompt or None,
        image_embeds=face_emb,
        image=pose_kps,
        controlnet_conditioning_scale=float(params.get("controlnet_conditioning_scale", 0.8)),
        ip_adapter_scale=float(params.get("ip_adapter_scale", 0.8)),
        num_inference_steps=int(params.get("steps", 30)),
        guidance_scale=float(params.get("guidance_scale", 7.0)),
        generator=torch.Generator("cuda").manual_seed(int(params.get("seed", 42))),
    ).images[0]
    image.save(out_path)


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
            self._send(200, {"ok": True, "generator": "instantid"})
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
            tmpdir = tempfile.mkdtemp(prefix="starme-ii-")
            try:
                selfie_path = os.path.join(tmpdir, "selfie.jpg")
                scene_path = os.path.join(tmpdir, "scene.jpg")
                out_path = os.path.join(tmpdir, "result.png")
                with open(selfie_path, "wb") as f:
                    f.write(base64.b64decode(selfie_b64))
                with open(scene_path, "wb") as f:
                    f.write(base64.b64decode(scene_b64))
                _infer(selfie_path, scene_path, out_path,
                       payload.get("prompt", ""), payload.get("negative_prompt", ""),
                       payload.get("params", {}))
                with open(out_path, "rb") as f:
                    image = base64.b64encode(f.read()).decode()
                self._send(200, {"image": image, "mime": "image/png", "generator": "instantid"})
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception as error:  # noqa: BLE001
            self._send(500, {"error": str(error)[:500]})

    def log_message(self, fmt, *args):
        print("[instantid-worker]", fmt % args)


if __name__ == "__main__":
    print(f"[instantid-worker] listening on {HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
