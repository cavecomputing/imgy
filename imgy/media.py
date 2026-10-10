"""Media file rules: supported types, safe path resolution, and dimension probing."""
import functools
import logging
import os
import stat
import subprocess
from pathlib import Path

from PIL import ExifTags, Image

from .config import TRASH_FOLDER, UPLOAD_FOLDER
from .db import TRASH_PREFIX

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
VIDEO_EXTENSIONS = {'.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'}
ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
# The only decoders Pillow may use, whatever a file's name says (JPEG also opens camera MPO
# files). Without the limit a renamed PSD, EPS or PDF reaches Pillow's riskier parsers.
IMAGE_FORMATS = ('PNG', 'JPEG', 'GIF', 'WEBP', 'BMP')


class InvalidPath(ValueError):
    """A user-supplied path that escapes its root or does not name a media file."""


# os.path rather than Path: the listing asks both of every file on each rebuild, and building
# 20,000 Path objects was a third of a 10,000-file rebuild.
def allowed_file(filename):
    return os.path.splitext(filename)[1].lower() in ALLOWED_EXTENSIONS


def is_video(filename):
    return os.path.splitext(filename)[1].lower() in VIDEO_EXTENSIONS


@functools.cache
def resolved_base(base: Path) -> Path:
    """base with symlinks resolved, cached (bases are fixed for the process lifetime)."""
    return base.resolve()


def safe_path(base: Path, user_path: str) -> Path:
    """Resolve a user-supplied path under base, raising InvalidPath on traversal."""
    try:
        resolved = (base / user_path).resolve()
    except (OSError, RuntimeError, ValueError) as e:  # e.g. a NUL byte or a symlink loop
        raise InvalidPath(f'Invalid path: {user_path!r}') from e
    if not resolved.is_relative_to(resolved_base(base)):
        raise InvalidPath(f'Path traversal attempt blocked: {user_path!r}')
    return resolved


def relative_to_base(base: Path, path: Path) -> str:
    """Normalized relative path of a path that safe_path() already resolved."""
    return str(path.relative_to(resolved_base(base)))


def normalize_active_filename(filename, require_exists=False):
    """Validate a media path under UPLOAD_FOLDER. Returns (relative path, absolute path)."""
    if not isinstance(filename, str) or not filename.strip():
        raise InvalidPath('Filename required')
    path = safe_path(UPLOAD_FOLDER, filename)
    rel_path = relative_to_base(UPLOAD_FOLDER, path)
    if not _is_media_path(rel_path):
        raise InvalidPath(f'Invalid active media path: {filename!r}')
    if require_exists and not path.is_file():
        raise FileNotFoundError(f'File not found: {filename}')
    return rel_path, path


def normalize_active_filenames(filenames, max_count=None, require_exists=False):
    """Validate a list of media paths, de-duplicated in input order."""
    if not isinstance(filenames, list):
        raise ValueError('Filenames must be a list')
    if max_count is not None and len(filenames) > max_count:
        raise OverflowError('Too many filenames')
    return list(dict.fromkeys(normalize_active_filename(f, require_exists)[0] for f in filenames))


def normalize_trash_filename(filename, require_exists=False):
    """Validate a trash entry name. Trash is flat, so the name has no directories."""
    if not isinstance(filename, str) or not filename.strip():
        raise InvalidPath('Trash filename required')
    path = safe_path(TRASH_FOLDER, filename)
    rel_path = relative_to_base(TRASH_FOLDER, path)
    if Path(rel_path).name != rel_path or rel_path.startswith('.'):
        raise InvalidPath(f'Invalid trash path: {filename!r}')
    if require_exists and not path.is_file():
        raise FileNotFoundError(f'Trash file not found: {filename}')
    return rel_path, path


def _is_media_path(rel_path):
    """A supported file outside hidden folders, not named like a trash key ('trash:...')."""
    return (allowed_file(rel_path) and not rel_path.startswith(TRASH_PREFIX)
            and not any(part.startswith('.') for part in Path(rel_path).parts[:-1]))


def walk_active_files():
    """Yield (path, relative path, stat result) for every media file, skipping hidden directories and symlinks.

    One lstat per file does for the symlink check, the regular-file check and the size, and plain
    strings stand in for Path objects until a file is known to count: the listing walks every
    file on each rebuild.
    """
    for root, dirs, files in os.walk(UPLOAD_FOLDER):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        folder = os.path.relpath(root, UPLOAD_FOLDER)
        for name in files:
            rel_path = name if folder == '.' else os.path.join(folder, name)
            if not allowed_file(name) or rel_path.startswith(TRASH_PREFIX):
                continue
            path = os.path.join(root, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                yield path, rel_path, st


def video_dimensions(path):
    """Width and height of a video's first stream via ffprobe, or (None, None)."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', str(path)],
            capture_output=True, text=True, timeout=10,
        )
        w, h = result.stdout.strip().split('x')
        return int(w), int(h)
    except Exception:
        return None, None


def read_dimensions(path, rel_path):
    """Display width and height of an image (EXIF rotation applied) or video, or (None, None).

    Only the image header is read; decoding every pixel would make the first listing of a
    large library very slow.
    """
    try:
        if is_video(rel_path):
            return video_dimensions(path)
        with Image.open(path, formats=IMAGE_FORMATS) as img:
            w, h = img.size
            # PNG's getexif() decodes the image unless the EXIF chunk precedes the pixel data.
            exif = img.getexif() if img.format != 'PNG' or 'exif' in img.info else {}
            if exif.get(ExifTags.Base.Orientation) in (5, 6, 7, 8):  # rotated 90 or 270 degrees
                w, h = h, w
            return w, h
    except Exception as e:
        logger.error(f'Failed to read dimensions for {rel_path}: {e}')
        return None, None
