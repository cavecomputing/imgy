"""Image groups: sets of files shown together as one stack in the gallery."""
import uuid

from flask import Blueprint, abort

from ..catalog import invalidate_images_cache
from ..config import MAX_GROUP_SIZE
from ..db import dissolve_small_groups, get_db
from .common import active_files, json_body

bp = Blueprint('groups', __name__)

TOO_MANY = f'Maximum {MAX_GROUP_SIZE} files per group'


@bp.post('/groups')
def create_group():
    """Group the given files, absorbing any groups they already belong to."""
    filenames = active_files(json_body().get('filenames', []), MAX_GROUP_SIZE, TOO_MANY)
    if len(filenames) < 2:
        abort(400, 'At least 2 files required')
    with get_db() as conn:
        placeholders = ','.join('?' * len(filenames))
        existing = [row['group_id'] for row in conn.execute(
            f'SELECT DISTINCT group_id FROM image_groups WHERE filename IN ({placeholders})', filenames)]
        members = set(filenames)
        for group_id in existing:
            members.update(row['filename'] for row in conn.execute(
                'SELECT filename FROM image_groups WHERE group_id = ?', (group_id,)))
        conn.executemany('DELETE FROM image_groups WHERE group_id = ?', [(g,) for g in existing])
        conn.executemany('DELETE FROM image_groups WHERE filename = ?', [(f,) for f in members])
        group_id = str(uuid.uuid4())[:8]
        conn.executemany('INSERT INTO image_groups (group_id, filename) VALUES (?, ?)',
                         [(group_id, f) for f in members])
        conn.commit()
    invalidate_images_cache()
    return {'success': True, 'group_id': group_id}


@bp.delete('/groups/<group_id>')
def delete_group(group_id):
    """Ungroup every image in the group."""
    with get_db() as conn:
        conn.execute('DELETE FROM image_groups WHERE group_id = ?', (group_id,))
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.post('/groups/<group_id>/add')
def add_to_group(group_id):
    """Move files into an existing group (out of any group they were in)."""
    filenames = active_files(json_body().get('filenames', []), MAX_GROUP_SIZE, TOO_MANY)
    if not filenames:
        abort(400, 'Filenames required')
    with get_db() as conn:
        if not conn.execute('SELECT 1 FROM image_groups WHERE group_id = ? LIMIT 1', (group_id,)).fetchone():
            abort(404, 'Group not found')
        affected = {group_id} | {row['group_id'] for f in filenames for row in conn.execute(
            'SELECT group_id FROM image_groups WHERE filename = ?', (f,))}
        conn.executemany('DELETE FROM image_groups WHERE filename = ?', [(f,) for f in filenames])
        conn.executemany('INSERT OR IGNORE INTO image_groups (group_id, filename) VALUES (?, ?)',
                         [(group_id, f) for f in filenames])
        dissolve_small_groups(conn, affected)
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.post('/groups/<group_id>/remove')
def remove_from_group(group_id):
    """Take files out of a group, dissolving it if fewer than two remain."""
    filenames = active_files(json_body().get('filenames', []), MAX_GROUP_SIZE, TOO_MANY, must_exist=False)
    with get_db() as conn:
        conn.executemany('DELETE FROM image_groups WHERE group_id = ? AND filename = ?',
                         [(group_id, f) for f in filenames])
        dissolve_small_groups(conn, [group_id])
        conn.commit()
    invalidate_images_cache()
    return {'success': True}
