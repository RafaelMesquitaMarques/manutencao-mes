"""
backend/app/api/routes/uploads.py
Generic media upload (photos / videos) — saved under UPLOAD_DIR and served,
authenticated, at /api/media/<file>.
"""
import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import FileResponse
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.db.session import get_db
from app.models.models import MediaAsset, User, UserPlant

router = APIRouter(prefix="/api/uploads", tags=["Uploads"])

# Served media lives behind auth (see media_router below) — the old open
# StaticFiles mount let anyone with the URL fetch any file over the tunnel.
media_router = APIRouter(prefix="/api/media", tags=["Media"])

_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"}
_VIDEO_EXT = {".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".ogv"}
_MODEL_EXT = {".glb", ".gltf"}
_CHUNK = 1024 * 1024  # 1 MB

_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".heic": "image/heic",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".m4v": "video/x-m4v", ".ogv": "video/ogg",
    ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
}


def _auth_claims(request: Request) -> Optional[dict]:
    """The JWT claims for a media request, or None. `<img>`/`<video>`/3D-loader
    requests can't send an Authorization header, so a same-origin httpOnly cookie
    (`media_auth`, set at login) carries the token; direct API/download callers may
    use the Authorization header instead."""
    token = request.cookies.get("media_auth")
    if not token:
        auth = request.headers.get("authorization", "")
        if auth[:7].lower() == "bearer ":
            token = auth[7:]
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload if payload.get("sub") else None
    except JWTError:
        return None


@media_router.get("/{filename}")
async def serve_media(filename: str, request: Request, db: AsyncSession = Depends(get_db)):
    claims = _auth_claims(request)
    if claims is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    # Path-traversal guard: only a bare filename inside UPLOAD_DIR is servable.
    safe = os.path.basename(filename)
    if not safe or safe != filename or safe.startswith("."):
        raise HTTPException(status_code=404, detail="Not found")
    path = os.path.join(settings.UPLOAD_DIR, safe)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")

    # Per-file plant scope: a file with a known owner is served only to that plant's
    # members (admin passes). Legacy/un-owned files (no row or plant_id NULL) fall
    # through to any authenticated user — phase 1 already closed public access.
    asset = (await db.execute(
        select(MediaAsset).where(MediaAsset.filename == safe)
    )).scalar_one_or_none()
    if asset is not None and asset.plant_id is not None and claims.get("role") != "admin":
        try:
            uid = uuid.UUID(str(claims["sub"]))
        except (ValueError, TypeError, KeyError):
            raise HTTPException(status_code=404, detail="Not found")
        member = (await db.execute(
            select(UserPlant.id).where(UserPlant.user_id == uid, UserPlant.plant_id == asset.plant_id)
        )).first()
        if member is None:
            raise HTTPException(status_code=404, detail="Not found")

    ext = os.path.splitext(safe)[1].lower()
    return FileResponse(path, media_type=(asset.content_type if asset and asset.content_type else _MIME.get(ext)))


@router.post("")
async def upload_file(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
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

    # Record ownership so the serving endpoint can scope this file to its plant.
    db.add(MediaAsset(
        filename=fname, plant_id=ctx.plant_id, uploaded_by_id=current_user.id,
        media_type=media_type, content_type=ctype or None, size=size,
    ))
    await db.commit()

    return {
        "url": f"/api/media/{fname}",
        "filename": fname,
        "media_type": media_type,
        "content_type": ctype,
        "size": size,
    }
