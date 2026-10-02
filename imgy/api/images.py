"""Listing, renaming, reordering, trashing, uploading, and exporting media files."""
import contextlib
import logging
import math
import os
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

from flask import Blueprint, Response, abort, request
from PIL import ExifTags, Image
from werkzeug.utils import secure_filename

from ..catalog import images_json, invalidate_images_cache, media_urls
from ..config import MAX_BULK_FILES, UPLOAD_FOLDER
from ..db import TRASH_PREFIX, clear_filename, get_db, rename_filename
from ..media import ALLOWED_EXTENSIONS, allowed_file, is_video, normalize_active_filename, read_dimensions
from ..thumbnails import delete_thumbnail
from ..trash import move_to_trash
from .common import active_file, active_files, json_body

logger = logging.getLogger(__name__)

bp = Blueprint('images', __name__)


@bp.get('/images')
def list_images():
    return Response(images_json(), mimetype='application/json')


@bp.delete('/images/<path:filename>')
def trash_image(filename):
    filename, _path = active_file(filename)
    with get_db() as conn:
        try:
            move_to_trash(conn, filename)
        except FileNotFoundError:  # trashed by another request in the meantime
            abort(404, 'File not found')
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.post('/images/bulk-trash')
def bulk_trash():
    filenames = json_body().get('filenames', [])
    if not isinstance(filenames, list):
        abort(400, 'Filenames must be a list')
    if len(filenames) > MAX_BULK_FILES:
        abort(400, f'Too many files (max {MAX_BULK_FILES})')
    count = 0
    errors = []
    with get_db() as conn:
        for filename in filenames:
            try:
                move_to_trash(conn, filename)
                count += 1
            except ValueError:
                errors.append({'filename': filename, 'error': 'Invalid path'})
            except FileNotFoundError:
                errors.append({'filename': filename, 'error': 'File not found'})
            except Exception as e:
                logger.error(f'Failed to trash {filename}: {e}')
                errors.append({'filename': filename, 'error': 'Internal error'})
        conn.commit()
    invalidate_images_cache()
    return {'success': not errors, 'count': count, 'errors': errors}, (207 if errors else 200)


@bp.post('/images/rename')
def rename_image():
    """Rename a file in place. Only the name changes; the directory and extension are kept."""
    data = json_body()
    old_filename, new_name = data.get('old_filename'), data.get('new_name')
    if not isinstance(old_filename, str) or not isinstance(new_name, str) or not old_filename or not new_name:
        abort(400, 'old_filename and new_name required')
    stem = Path(new_name).name
    if Path(stem).suffix.lower() in ALLOWED_EXTENSIONS:  # "photo.jpg" -> "photo", but keep "v1.2"
        stem = stem.removesuffix(Path(stem).suffix)
    if not stem.strip():
        abort(400, 'Invalid filename')
    old_filename, old_path = active_file(old_filename)
    new_filename = str(Path(old_filename).parent / f'{stem}{old_path.suffix}')
    if new_filename.startswith(TRASH_PREFIX):
        abort(400, f'Names starting with "{TRASH_PREFIX}" are reserved')
    try:
        new_filename, new_path = normalize_active_filename(new_filename)
    except ValueError:
        abort(400, 'Invalid destination path')
    if new_path.exists():
        abort(409, 'A file with that name already exists')

    old_path.rename(new_path)
    with get_db() as conn:
        clear_filename(conn, new_filename)
        rename_filename(conn, old_filename, new_filename, include_groups=True)
        conn.commit()
    delete_thumbnail(old_filename)
    invalidate_images_cache()
    return {'success': True, 'new_filename': new_filename, **media_urls(new_filename)}


@bp.post('/images/reorder')
def reorder_images():
    """Store the custom gallery order: the files the client lists, in the order they should appear.

    The client lists every file it shows, so there is no limit. A file left out keeps its old
    position, or none, and then shows first until it is placed.
    """
    filenames = active_files(json_body().get('filenames', []), None, '', must_exist=False)
    with get_db() as conn:
        conn.executemany('UPDATE image_metadata SET position = ? WHERE filename = ?', enumerate(filenames))
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.post('/upload')
def upload():
    files = request.files.getlist('images')
    if not files:
        abort(400, 'No files uploaded')

    uploaded = []
    skipped = []
    rows = []
    for file in files:
        original_filename = file.filename or ''
        if not file:
            skipped.append({'filename': original_filename, 'reason': 'Empty upload'})
            continue
        if not allowed_file(original_filename):
            skipped.append({'filename': original_filename, 'reason': 'Unsupported file type'})
            continue
        # secure_filename drops non-ASCII characters, which can leave nothing of the name.
        stem = secure_filename(Path(original_filename).stem) or f'upload_{uuid.uuid4().hex[:8]}'
        filepath = _reserve_upload_path(f'{stem}{Path(original_filename).suffix}')
        # Drop rows left by a deleted file with this name now, before the new file shows up in
        # listings, so nothing added to it while the upload runs is lost.
        with get_db() as conn:
            clear_filename(conn, filepath.name)
            conn.commit()
        file.save(filepath)
        created_at = time.time()
        w, h = read_dimensions(filepath, filepath.name)
        rows.append((filepath.name, created_at, w, h))
        uploaded.append({'filename': filepath.name, 'modified': created_at})

    if not uploaded:
        return {
            'success': False,
            'error': 'No supported files uploaded',
            'count': 0,
            'uploaded': [],
            'skipped': skipped,
        }, 400

    with get_db() as conn:
        # A listing that ran during the upload may already have added a row for the file.
        conn.executemany('''
            INSERT INTO image_metadata (filename, created_at, width, height) VALUES (?, ?, ?, ?)
            ON CONFLICT(filename) DO UPDATE SET
                created_at = excluded.created_at, width = excluded.width, height = excluded.height
        ''', rows)
        conn.commit()
    invalidate_images_cache()
    return {'success': True, 'count': len(uploaded), 'uploaded': uploaded, 'skipped': skipped}


def _reserve_upload_path(filename):
    """Atomically claim UPLOAD_FOLDER/filename, appending _1, _2, ... if it is taken."""
    stem, suffix = Path(filename).stem, Path(filename).suffix
    path = UPLOAD_FOLDER / filename
    counter = 1
    while True:
        try:
            os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return path
        except FileExistsError:
            path = UPLOAD_FOLDER / f'{stem}_{counter}{suffix}'
            counter += 1


def _number(value):
    """An EXIF number as a float, or None when missing or unusable (cameras write 0/0 for unknown)."""
    try:
        number = float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return number if math.isfinite(number) else None


@bp.get('/exif/<path:filename>')
def get_exif(filename):
    """A few display-ready EXIF fields. Returns {} for videos, missing files, or unreadable EXIF."""
    filename, path = active_file(filename, must_exist=False)
    if not path.exists() or is_video(filename):
        return {}
    try:
        with Image.open(path) as img:
            raw = img.getexif()
            # Camera settings and the capture date live in the Exif sub-IFD, not IFD0.
            exif = {**raw, **raw.get_ifd(ExifTags.IFD.Exif)}
        if not exif:
            return {}
        tag = ExifTags.Base
        result = {}
        taken = exif.get(tag.DateTimeOriginal) or exif.get(tag.DateTime)
        if taken:
            result['date'] = str(taken)
        make = str(exif.get(tag.Make, '')).strip()
        model = str(exif.get(tag.Model, '')).strip()
        if model:
            # Many cameras already include the make in the model name
            result['camera'] = model if make and make in model else f'{make} {model}'.strip()
        focal_length = _number(exif.get(tag.FocalLength))
        if focal_length is not None:
            result['focal_length'] = f'{focal_length:.0f}mm'
        f_number = _number(exif.get(tag.FNumber))
        if f_number is not None:
            result['aperture'] = f'f/{f_number:.1f}'
        exposure = _number(exif.get(tag.ExposureTime))
        if exposure is not None:
            result['shutter'] = f'1/{round(1 / exposure)}s' if 0 < exposure < 1 else f'{exposure:.1f}s'
        iso = exif.get(tag.ISOSpeedRatings)
        if isinstance(iso, tuple):
            iso = iso[0] if iso else None
        if iso is not None:
            result['iso'] = f'ISO {iso}'
        return result
    except Exception as e:
        logger.error(f'EXIF read error for {filename}: {e}')
        return {}


@bp.post('/download-zip')
def download_zip():
    filenames = active_files(json_body().get('filenames', []), MAX_BULK_FILES, f'Too many files (max {MAX_BULK_FILES})')
    if not filenames:
        abort(400, 'No files specified')

    tmp = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
    tmp.close()
    try:
        # Media is already compressed, so deflating it only costs time.
        with zipfile.ZipFile(tmp.name, 'w', zipfile.ZIP_STORED) as zf:
            for filename in filenames:
                zf.write(UPLOAD_FOLDER / filename, filename)
    except Exception as e:
        logger.error(f'ZIP creation failed: {e}')
        with contextlib.suppress(FileNotFoundError):
            os.unlink(tmp.name)
        return {'error': 'Failed to create ZIP'}, 500

    def stream():
        try:
            with open(tmp.name, 'rb') as f:
                while chunk := f.read(65536):
                    yield chunk
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(tmp.name)

    return Response(stream(), mimetype='application/zip',
                    headers={'Content-Disposition': 'attachment; filename="imgy_export.zip"'})
