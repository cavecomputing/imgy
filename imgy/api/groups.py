"""Image groups: sets of files shown together as one stack in the gallery."""
import uuid

from flask import Blueprint, abort

from ..catalog import invalidate_images_cache
from ..config import MAX_GROUP_SIZE
from ..db import get_db
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
