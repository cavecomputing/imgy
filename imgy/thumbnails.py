"""400x400 JPEG thumbnails, generated on first request and refreshed when the source changes."""
import contextlib
import logging
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

from .config import THUMBNAIL_FOLDER
from .media import (IMAGE_FORMATS, allowed_file, is_video, normalize_active_filename,
                    normalize_trash_filename, relative_to_base, resolved_base, safe_path)

logger = logging.getLogger(__name__)

THUMBNAIL_SIZE = (400, 400)
VIDEO_THUMBNAILS = '.video'  # subfolder of THUMBNAIL_FOLDER


def thumb_rel_path_for(rel_path):
    """Thumbnail path for a media path. Every thumbnail is a JPEG, whatever its name says.

    Video thumbnails go under '.video/'. No media file can live in a hidden folder, so they
    never collide with an image's thumbnail.
    """
    if is_video(rel_path):
        return f'{VIDEO_THUMBNAILS}/{rel_path}'
    return rel_path


def _source(rel_path):
    """(normalized path, absolute path) of an active media file or a '.trash/<name>' entry."""
    if rel_path.startswith('.trash/'):
        name, path = normalize_trash_filename(rel_path.removeprefix('.trash/'), require_exists=True)
        if not allowed_file(name):
            raise FileNotFoundError(rel_path)
        return f'.trash/{name}', path
    return normalize_active_filename(rel_path, require_exists=True)


def get_or_create_thumbnail(rel_path):
    """Return the thumbnail's path relative to THUMBNAIL_FOLDER, or None if it can't be made."""
    try:
        rel_path, source_path = _source(rel_path)
        thumb_path = safe_path(THUMBNAIL_FOLDER, thumb_rel_path_for(rel_path))
        t_rel = relative_to_base(THUMBNAIL_FOLDER, thumb_path)
    except (ValueError, FileNotFoundError):
        return None
    if thumb_path.exists() and thumb_path.stat().st_mtime >= source_path.stat().st_mtime:
        return t_rel

    tmp_path = None
    try:
        thumb_path.parent.mkdir(parents=True, exist_ok=True)
        # Unique per request so concurrent requests don't clobber each other, and short so long
        # filenames still fit. The .jpg suffix tells ffmpeg what to write.
        fd, tmp_name = tempfile.mkstemp(dir=thumb_path.parent, prefix='tmp', suffix='.jpg')
        os.fchmod(fd, 0o644)
        os.close(fd)
        tmp_path = Path(tmp_name)
        if is_video(rel_path):
            _video_frame(source_path, tmp_path)
        else:
            _image_thumbnail(source_path, tmp_path)
        os.replace(tmp_path, thumb_path)
        return t_rel
    except Exception as e:
        logger.error(f'Thumbnail generation FAILED for {rel_path}: {e}')
        if tmp_path:
            with contextlib.suppress(OSError):
                tmp_path.unlink(missing_ok=True)
        return None


def _image_thumbnail(source_path, dest):
    with Image.open(source_path, formats=IMAGE_FORMATS) as img:
        # Lets a big JPEG decode at 1/2 to 1/8 scale, as thumbnail() would on its own if
        # exif_transpose() didn't decode it first: 280 ms to 90 ms for a 24-megapixel photo.
        img.draft(None, (THUMBNAIL_SIZE[0] * 2, THUMBNAIL_SIZE[1] * 2))
        img = ImageOps.exif_transpose(img)
        if img.mode.startswith('I'):  # 16/32-bit grayscale, which JPEG can't store
            img = img.convert('I').point(lambda v: v / 256).convert('L')
        elif img.mode == 'CMYK':
            img = img.convert('RGB')
        img.thumbnail(THUMBNAIL_SIZE)
        if img.mode not in ('RGB', 'L'):
            img = img.convert('RGB')
        img.save(dest, 'JPEG', quality=80, optimize=True)


def _video_frame(source_path, dest):
    """Grab a frame 2% into the video (or at 1s if the duration is unknown)."""
    seek = '1'
    try:
        probe = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', str(source_path)],
            capture_output=True, text=True, timeout=10,
        )
        seek = str(float(probe.stdout.strip()) * 0.02)
    except Exception:
        pass
    subprocess.run(
        ['ffmpeg', '-y', '-ss', seek, '-i', str(source_path), '-vframes', '1',
         '-vf', f'scale={THUMBNAIL_SIZE[0]}:-1', str(dest)],
        capture_output=True, timeout=30, check=True,
    )


def delete_thumbnail(rel_path):
    """Delete a media file's thumbnail and any directories that leaves empty."""
    try:
        thumb_path = safe_path(THUMBNAIL_FOLDER, thumb_rel_path_for(rel_path))
    except ValueError:
        return
    if not thumb_path.exists():
        return
    root = resolved_base(THUMBNAIL_FOLDER)
    try:
        thumb_path.unlink()
        parent = thumb_path.parent
        while parent != root and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
    except Exception as e:
        logger.error(f'Failed to delete thumbnail {rel_path}: {e}')
