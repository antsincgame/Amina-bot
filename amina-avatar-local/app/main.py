"""Локальный сервис: аудио + лицо → MP4. Режим ffmpeg (CPU) или Wav2Lip (GPU)."""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from dotenv import load_dotenv
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent.parent
load_dotenv(APP_DIR / ".env", override=False)
STATIC_DIR = Path(__file__).resolve().parent / "static"
ASSETS = APP_DIR / "assets"
FACE = ASSETS / "face.png"

WAV2LIP_ROOT = Path(os.environ.get("WAV2LIP_ROOT", "/opt/Wav2Lip")).resolve()
AVATAR_ENGINE = os.environ.get("AVATAR_ENGINE", "ffmpeg").strip().lower()

security = HTTPBearer(auto_error=False)
app = FastAPI(title="Amina Avatar Local", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StillVideoRequest(BaseModel):
    audio_base64: str = Field(..., min_length=8)
    audio_mime: str = Field(default="audio/mpeg")


def require_secret(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> None:
    secret = os.environ.get("AMINA_AVATAR_SECRET", "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="AMINA_AVATAR_SECRET is not set")
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Bearer token required")
    if credentials.credentials != secret:
        raise HTTPException(status_code=403, detail="Invalid secret")


def health_cuda_hint() -> str:
    try:
        import torch

        return "yes" if torch.cuda.is_available() else "no"
    except Exception:
        return "unavailable"


@app.get("/health")
def health() -> dict[str, str]:
    body: dict[str, str] = {"status": "ok", "engine": AVATAR_ENGINE}
    if AVATAR_ENGINE == "wav2lip":
        body["cuda"] = health_cuda_hint()
    return body


@app.get("/api/ui-status")
def ui_status() -> dict[str, object]:
    """Данные для локальной веб-панели (без раскрытия секрета)."""
    secret_configured = len(os.environ.get("AMINA_AVATAR_SECRET", "").strip()) > 8
    face_ready = FACE.is_file() and FACE.stat().st_size > 500
    mini = os.environ.get("MINI_APP_URL", "https://amina.vibecoding.by/mini-app/index.html").strip()
    return {
        "secret_configured": secret_configured,
        "face_ready": face_ready,
        "mini_app_url": mini,
        "engine": AVATAR_ENGINE,
        "cuda": health_cuda_hint() if AVATAR_ENGINE == "wav2lip" else None,
    }


@app.get("/")
def serve_control_panel() -> FileResponse:
    index = STATIC_DIR / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=503, detail="Web UI missing")
    return FileResponse(index, media_type="text/html; charset=utf-8")


def audio_path_suffix(ext: str) -> str:
    if ext.startswith("."):
        return ext
    return ext if ext else ".mp3"


def build_ffmpeg_video(audio_path: Path, out_mp4: Path) -> None:
    if FACE.is_file():
        cmd = [
            "ffmpeg",
            "-y",
            "-loop",
            "1",
            "-i",
            str(FACE),
            "-i",
            str(audio_path),
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ]
    else:
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x1a1520:s=512x512:r=30",
            "-i",
            str(audio_path),
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0 or not out_mp4.is_file():
        raise HTTPException(
            status_code=500,
            detail=(proc.stderr or proc.stdout or "ffmpeg failed")[-800:],
        )


def build_wav2lip_video(audio_path: Path, out_mp4: Path) -> None:
    if not FACE.is_file():
        raise HTTPException(
            status_code=400,
            detail="Для wav2lip нужен портрет assets/face.png (референс «Амины», в т.ч. из Civitai).",
        )
    if not WAV2LIP_ROOT.is_dir() or not (WAV2LIP_ROOT / "inference.py").is_file():
        raise HTTPException(status_code=503, detail="Wav2Lip не установлен (нет WAV2LIP_ROOT)")

    ck = os.environ.get("WAV2LIP_CHECKPOINT", "checkpoints/wav2lip_gan.pth")
    ck_path = WAV2LIP_ROOT / ck if not Path(ck).is_absolute() else Path(ck)
    if not ck_path.is_file():
        raise HTTPException(status_code=503, detail=f"checkpoint не найден: {ck_path}")

    pads = os.environ.get("WAV2LIP_PADS", "0 20 0 0").split()
    if len(pads) != 4:
        pads = ["0", "20", "0", "0"]
    resize = os.environ.get("WAV2LIP_RESIZE_FACTOR", "1").strip() or "1"
    wav2lip_py = WAV2LIP_ROOT / "inference.py"

    extra = []
    if os.environ.get("WAV2LIP_NOSMOOTH", "").lower() in ("1", "true", "yes"):
        extra.append("--nosmooth")

    cmd = [
        sys.executable,
        str(wav2lip_py),
        "--checkpoint_path",
        str(ck_path),
        "--face",
        str(FACE.resolve()),
        "--audio",
        str(audio_path.resolve()),
        "--outfile",
        str(out_mp4.resolve()),
        "--pads",
        *pads,
        "--resize_factor",
        resize,
        *extra,
    ]

    env = os.environ.copy()
    env["PYTHONPATH"] = str(WAV2LIP_ROOT)

    (WAV2LIP_ROOT / "temp").mkdir(parents=True, exist_ok=True)
    (WAV2LIP_ROOT / "results").mkdir(parents=True, exist_ok=True)

    proc = subprocess.run(
        cmd,
        cwd=str(WAV2LIP_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if proc.returncode != 0 or not out_mp4.is_file():
        tail = (proc.stderr or proc.stdout or "wav2lip failed")[-1200:]
        raise HTTPException(status_code=500, detail=tail)


@app.post("/v1/still-video")
def still_video(body: StillVideoRequest, _: None = Depends(require_secret)) -> dict[str, str]:
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=503, detail="ffmpeg not installed in container")

    try:
        audio_bytes = base64.b64decode(body.audio_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid audio_base64: {exc}") from exc

    ext = ".mp3" if "mpeg" in body.audio_mime or "mp3" in body.audio_mime else ".m4a"
    with tempfile.TemporaryDirectory() as tmp:
        tdir = Path(tmp)
        audio_path = tdir / f"in{audio_path_suffix(ext)}"
        audio_path.write_bytes(audio_bytes)
        out_mp4 = tdir / "out.mp4"

        if AVATAR_ENGINE == "wav2lip":
            build_wav2lip_video(audio_path, out_mp4)
        else:
            build_ffmpeg_video(audio_path, out_mp4)

        video_b64 = base64.b64encode(out_mp4.read_bytes()).decode("ascii")
        return {"video_base64": video_b64, "video_mime": "video/mp4"}
