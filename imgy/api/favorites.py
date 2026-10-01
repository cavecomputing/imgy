"""Favorite toggling for one or many images."""
from flask import Blueprint, abort

from ..catalog import invalidate_images_cache
from ..config import MAX_BULK_FILES
from ..db import get_db
from .common import active_file, active_files, json_body

bp = Blueprint('favorites', __name__)


def _toggle(conn, filename):
    """Flip one file's favorite flag. Returns True if it is now a favorite."""
    if conn.execute('SELECT 1 FROM favorites WHERE filename = ?', (filename,)).fetchone():
        conn.execute('DELETE FROM favorites WHERE filename = ?', (filename,))
        return False
    conn.execute('INSERT INTO favorites (filename) VALUES (?)', (filename,))
    return True


@bp.post('/favorites/toggle')
def toggle_favorite():
    filename = json_body().get('filename')
    if not filename:
        abort(400, 'Filename required')
    filename, _path = active_file(filename)
    with get_db() as conn:
        is_favorite = _toggle(conn, filename)
        conn.commit()
    invalidate_images_cache()
    return {'success': True, 'is_favorite': is_favorite}


@bp.post('/favorites/bulk-toggle')
def bulk_toggle_favorite():
    """Flip each file's favorite flag independently."""
    filenames = active_files(json_body().get('filenames', []), MAX_BULK_FILES, f'Too many items (max {MAX_BULK_FILES} files)')
    if not filenames:
        abort(400, 'Filenames required')
    with get_db() as conn:
        results = {filename: _toggle(conn, filename) for filename in filenames}
        conn.commit()
    invalidate_images_cache()
    return {'success': True, 'results': results}
