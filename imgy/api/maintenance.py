"""Storage stats and housekeeping: orphan cleanup and thumbnail regeneration."""
from pathlib import Path

from flask import Blueprint

from ..catalog import invalidate_images_cache
from ..config import DATABASE, THUMBNAIL_FOLDER, TRASH_FOLDER, UPLOAD_FOLDER
from ..db import FILENAME_TABLES, NOT_TRASHED, STANDALONE_TAG_FILENAME, TRASH_PREFIX, dissolve_small_groups, get_db
from ..media import walk_active_files
from ..thumbnails import thumb_rel_path_for
from ..trash import key_prefix

bp = Blueprint('maintenance', __name__)


def _dir_size(path, skip_hidden=True):
    if not path.exists():
        return 0
    total = 0
    for f in path.rglob('*'):
        if not f.is_file():
            continue
        if skip_hidden and any(part.startswith('.') for part in f.relative_to(path).parts):
            continue
        total += f.stat().st_size
    return total


@bp.get('/storage')
def storage_stats():
    sizes = {
        'images': _dir_size(UPLOAD_FOLDER),
        'thumbnails': _dir_size(THUMBNAIL_FOLDER, skip_hidden=False),
        'trash': _dir_size(TRASH_FOLDER, skip_hidden=False),
        'database': DATABASE.stat().st_size if DATABASE.exists() else 0,
    }
    return {**sizes, 'total': sum(sizes.values())}


@bp.post('/maintenance/reset-thumbnails')
def reset_thumbnails():
    """Delete every thumbnail and forget stored dimensions so both are regenerated."""
    purged = 0
    if THUMBNAIL_FOLDER.exists():
        for p in THUMBNAIL_FOLDER.rglob('*'):
            if p.is_file() and not p.name.startswith('.'):
                p.unlink()
                purged += 1
    with get_db() as conn:
        conn.execute(f'UPDATE image_metadata SET width = NULL, height = NULL WHERE {NOT_TRASHED}')
        conn.commit()
    invalidate_images_cache()
    return {'success': True, 'thumbnails_purged': purged}


@bp.post('/maintenance/cleanup')
def cleanup_orphans():
    """Remove DB rows and thumbnails whose media file (active or trashed) no longer exists."""
    active_files = {rel for _path, rel, _st in walk_active_files()}
    active_thumbs = {thumb_rel_path_for(rel) for rel in active_files}
    trash_files = {f.name for f in TRASH_FOLDER.iterdir() if f.is_file() and not f.name.startswith('.')} if TRASH_FOLDER.exists() else set()
    trash_thumbs = {thumb_rel_path_for(str(Path('.trash') / name)) for name in trash_files}

    trash_prefixes = {key_prefix(name) for name in trash_files}

    def is_valid(filename, table):
        if table == 'tags' and filename == STANDALONE_TAG_FILENAME:
            return True
        if filename.startswith(TRASH_PREFIX):
            # Trash names may contain ':', so try every ':' as the end of the prefix.
            return any(filename[:i + 1] in trash_prefixes for i, c in enumerate(filename) if c == ':')
        return filename in active_files

    orphaned_rows = {}
    with get_db() as conn:
        for table in FILENAME_TABLES:
            rows = conn.execute(f'SELECT DISTINCT filename FROM {table}').fetchall()
            orphans = [row['filename'] for row in rows if not is_valid(row['filename'], table)]
            conn.executemany(f'DELETE FROM {table} WHERE filename = ?', [(o,) for o in orphans])
            orphaned_rows[table] = len(orphans)
        rows = conn.execute('SELECT group_id, filename FROM image_groups').fetchall()
        orphans = [row for row in rows if row['filename'] not in active_files]
        conn.executemany('DELETE FROM image_groups WHERE filename = ?', [(row['filename'],) for row in orphans])
        dissolve_small_groups(conn, {row['group_id'] for row in rows})
        orphaned_rows['image_groups'] = len(orphans)
        conn.commit()

    orphaned_thumbs = 0
    if THUMBNAIL_FOLDER.exists():
        for p in THUMBNAIL_FOLDER.rglob('*'):
            if not p.is_file() or p.name.startswith('.'):
                continue
            rel = str(p.relative_to(THUMBNAIL_FOLDER))
            if rel not in active_thumbs and rel not in trash_thumbs:
                p.unlink(missing_ok=True)
                orphaned_thumbs += 1

    invalidate_images_cache()
    return {'success': True, 'orphaned_db_entries': orphaned_rows, 'orphaned_thumbnails': orphaned_thumbs}
