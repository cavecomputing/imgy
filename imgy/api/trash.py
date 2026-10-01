"""Listing, restoring, and permanently deleting trashed files."""
from pathlib import Path

from flask import Blueprint, abort

from ..catalog import invalidate_images_cache
from ..config import THUMBNAIL_FOLDER, TRASH_FOLDER
from ..db import get_db
from ..media import normalize_active_filename
from ..thumbnails import VIDEO_THUMBNAILS, delete_thumbnail
from ..trash import delete_trash_records, find_trash_record, parse_trash_name, restore_records
from .common import trash_file

bp = Blueprint('trash', __name__)


def _visible_files(folder):
    if not folder.exists():
        return []
    return [f for f in folder.iterdir() if f.is_file() and not f.name.startswith('.')]


@bp.get('/trash')
def list_trash():
    items = []
    for f in _visible_files(TRASH_FOLDER):
        original_name, trash_date = parse_trash_name(f.name)
        items.append({'trash_name': f.name, 'original_name': original_name, 'trash_date': trash_date})
    items.sort(key=lambda item: item['trash_date'] or 0, reverse=True)
    return items


@bp.post('/trash/restore/<filename>')
def restore(filename):
    """Move a file back to its original path, along with its tags, favorite, and metadata."""
    filename, trash_path = trash_file(filename)
    with get_db() as conn:
        prefix, original = find_trash_record(conn, filename)
        try:
            original, dest = normalize_active_filename(original)
        except ValueError:
            abort(400, 'Invalid path')
        if dest.exists():
            abort(409, f'A file named "{Path(original).name}" already exists')
        dest.parent.mkdir(parents=True, exist_ok=True)
        trash_path.rename(dest)
        restore_records(conn, prefix, original)
        conn.commit()
    delete_thumbnail(original)
    delete_thumbnail(f'.trash/{filename}')
    invalidate_images_cache()
    return {'success': True}


@bp.delete('/trash/empty')
def empty_trash():
    for folder in (TRASH_FOLDER, THUMBNAIL_FOLDER / '.trash', THUMBNAIL_FOLDER / VIDEO_THUMBNAILS / '.trash'):
        for f in _visible_files(folder):
            f.unlink()
    with get_db() as conn:
        delete_trash_records(conn)
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.delete('/trash/<filename>')
def delete_permanently(filename):
    filename, trash_path = trash_file(filename, must_exist=False)
    with get_db() as conn:
        prefix, _original = find_trash_record(conn, filename)
        trash_path.unlink(missing_ok=True)
        delete_thumbnail(f'.trash/{filename}')
        delete_trash_records(conn, prefix)
        conn.commit()
    invalidate_images_cache()
    return {'success': True}
