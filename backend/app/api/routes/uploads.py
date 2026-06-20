"""
backend/app/api/routes/uploads.py
Generic media upload (photos / videos) — saved under UPLOAD_DIR and served at /api/media/<file>.
"""
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File

from app.core.config import settings
from app.core.security import get_current_user
from app.models.models import User

router = APIRouter(prefix="/api/uploads", tags=["Uploads"])

_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"}
_VIDEO_EXT = {".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".ogv"}
_MODEL_EXT = {".glb", ".gltf"}
_CHUNK = 1024 * 1024  # 1 MB


@router.post("")
async def upload_file(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    ext = os.path.splitext(file.filename or "")[1].lower()
    ctype = (file.content_type or "").lower()
    is_image = ctype.startswith("image/") or ext in _IMAGE_EXT
    is_video = ctype.startswith("video/") or ext in _VIDEO_EXT
    is_model = ext in _MODEL_EXT
    if not (is_image or is_video or is_model):
        raise HTTPException(400, "Only image, video and 3D model (.glb/.gltf) files are allowed")

    media_type = "image" if is_image else ("video" if is_video else "model")
    safe_ext = ext or (".jpg" if is_image else ".mp4")
    fname = f"{uuid.uuid4().hex}{safe_ext}"

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    dest = os.path.join(settings.UPLOAD_DIR, fname)
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024

    size = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = await file.read(_CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(413, f"File too large (max {settings.MAX_UPLOAD_MB} MB)")
                out.write(chunk)
    except HTTPException:
        if os.path.exists(dest):
            os.remove(dest)
        raise
    finally:
        await file.close()

    return {
        "url": f"/api/media/{fname}",
        "filename": fname,
        "media_type": media_type,
        "content_type": ctype,
        "size": size,
    }
