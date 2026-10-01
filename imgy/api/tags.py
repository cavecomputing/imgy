"""Tag CRUD for single images, many images, and the global tag list."""
from flask import Blueprint, abort, request

from ..catalog import invalidate_images_cache
from ..config import MAX_BULK_FILES, MAX_BULK_TAGS
from ..db import NOT_TRASHED, STANDALONE_TAG_FILENAME, active_tag_names, get_db
from .common import active_file, active_files, json_body
from .settings import rename_tag_in_groups

bp = Blueprint('tags', __name__)

TOO_MANY = f'Too many items (max {MAX_BULK_FILES} files, {MAX_BULK_TAGS} tags)'


def validate_tag(tag):
    """A tag is 1-100 characters with no control characters."""
    return bool(tag) and len(tag) <= 100 and not any(ord(c) < 32 or ord(c) == 127 for c in tag)


def request_tags(tags):
    """Validate a list of tag names from the request: lowercased, stripped, de-duplicated."""
    if not isinstance(tags, list):
        abort(400, 'Tags must be a list')
    if len(tags) > MAX_BULK_TAGS:
        abort(400, TOO_MANY)
    normalized = []
    for tag in tags:
        tag = tag.strip().lower() if isinstance(tag, str) else None
        if not validate_tag(tag):
            abort(400, 'Invalid tag name')
        normalized.append(tag)
    return list(dict.fromkeys(normalized))


@bp.get('/tags')
def list_tags():
    with get_db() as conn:
        return active_tag_names(conn)


@bp.get('/tags/<path:filename>')
def image_tags(filename):
    filename, _path = active_file(filename, must_exist=False)
    with get_db() as conn:
        return [row['tag'] for row in conn.execute('SELECT tag FROM tags WHERE filename = ?', (filename,))]


@bp.post('/tags')
def add_tag():
    data = json_body()
    filename, tag = data.get('filename'), data.get('tag', '').strip().lower()
    if not filename or not tag:
        abort(400, 'Filename and tag required')
    filename, _path = active_file(filename)
    if not validate_tag(tag):
        abort(400, 'Invalid tag name')
    with get_db() as conn:
        conn.execute('INSERT OR IGNORE INTO tags (filename, tag) VALUES (?, ?)', (filename, tag))
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.post('/tags/create')
def create_tag():
    """Create a tag that is not attached to any image yet."""
    tag = json_body().get('tag', '').strip().lower()
    if not validate_tag(tag):
        abort(400, 'Tag name required')
    with get_db() as conn:
        if conn.execute(f'SELECT 1 FROM tags WHERE tag = ? AND {NOT_TRASHED} LIMIT 1', (tag,)).fetchone():
            abort(409, 'Tag already exists')
        conn.execute('INSERT INTO tags (filename, tag) VALUES (?, ?)', (STANDALONE_TAG_FILENAME, tag))
        conn.commit()
    invalidate_images_cache()
    return {'success': True, 'tag': tag}


@bp.delete('/tags/<path:filename>/<tag>')
def remove_tag(filename, tag):
    filename, _path = active_file(filename, must_exist=False)
    with get_db() as conn:
        conn.execute('DELETE FROM tags WHERE filename = ? AND tag = ?', (filename, tag))
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.delete('/tags/remove-all')
def delete_tag():
    """Delete a tag (?tag=...) from every image and the standalone tag list.

    The tag is a query parameter because tags may contain '/'.
    """
    tag = request.args.get('tag', '').strip().lower()
    if not tag:
        abort(400, 'Tag required')
    with get_db() as conn:
        conn.execute('DELETE FROM tags WHERE tag = ?', (tag,))
        rename_tag_in_groups(conn, tag, None)
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.post('/tags/rename')
def rename_tag():
    """Rename a tag everywhere, merging into the new name where an image already has it."""
    data = json_body()
    old_tag = data.get('old_tag', '').strip().lower()
    new_tag = data.get('new_tag', '').strip().lower()
    if not old_tag or not new_tag or old_tag == new_tag:
        abort(400, 'Invalid tag names')
    if not validate_tag(new_tag):
        abort(400, 'Invalid tag name')
    with get_db() as conn:
        conn.execute('DELETE FROM tags WHERE tag = ? AND filename IN (SELECT filename FROM tags WHERE tag = ?)',
                     (old_tag, new_tag))
        conn.execute('UPDATE tags SET tag = ? WHERE tag = ?', (new_tag, old_tag))
        rename_tag_in_groups(conn, old_tag, new_tag)
        conn.commit()
    invalidate_images_cache()
    return {'success': True}


@bp.post('/tags/bulk')
def add_tags_bulk():
    data = json_body()
    filenames = active_files(data.get('filenames', []), MAX_BULK_FILES, TOO_MANY)
    tags = request_tags(data.get('tags', []))
    if filenames and tags:
        with get_db() as conn:
            conn.executemany('INSERT OR IGNORE INTO tags (filename, tag) VALUES (?, ?)',
                             [(f, t) for f in filenames for t in tags])
            conn.commit()
        invalidate_images_cache()
    return {'success': True}


@bp.post('/tags/bulk-remove')
def remove_tags_bulk():
    data = json_body()
    filenames = active_files(data.get('filenames', []), MAX_BULK_FILES, TOO_MANY, must_exist=False)
    tags = request_tags(data.get('tags', []))
    if filenames and tags:
        with get_db() as conn:
            conn.executemany('DELETE FROM tags WHERE filename = ? AND tag = ?',
                             [(f, t) for f in filenames for t in tags])
            conn.commit()
        invalidate_images_cache()
    return {'success': True}
