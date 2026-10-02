"""The media listing: every file under UPLOAD_FOLDER merged with its DB metadata.

Walking the filesystem is the expensive part, so the serialized listing is cached for a
couple of seconds. Every handler that changes files, tags, favorites, metadata, or groups
must call invalidate_images_cache(). The cache is per process; a generation file under
DATA_DIR tells other gunicorn workers that their copy is stale.
"""
import json
import logging
import threading
import time
from urllib.parse import quote

from .config import DATA_DIR, TRASH_FOLDER
from .db import NOT_TRASHED, STANDALONE_TAG_FILENAME, get_db
from .media import is_video, read_dimensions, walk_active_files

logger = logging.getLogger(__name__)

CACHE_TTL = 2.0
_GENERATION_FILE = DATA_DIR / '.images-cache-generation'
_cache = {'data': None, 'timestamp': 0.0, 'generation': None}
_lock = threading.Lock()


def invalidate_images_cache():
    _cache['data'] = None
    try:
        _GENERATION_FILE.write_text(str(time.time_ns()))
    except OSError as e:
        logger.warning(f'Could not update {_GENERATION_FILE}: {e}')


def _generation():
    try:
        return _GENERATION_FILE.read_text()
    except OSError:
        return None


def _cached(generation):
    return (_cache['data'] is not None
            and _cache['generation'] == generation
            and time.monotonic() - _cache['timestamp'] < CACHE_TTL)


def images_json():
    """The listing as a JSON string: {"images": [...newest first], "groups": {id: [files]}, "trash_count": n}.

    Each image carries its "position" in the custom order, or null until it has been placed.
    """
    generation = _generation()
    if _cached(generation):
        return _cache['data']
    with _lock:
        generation = _generation()
        if not _cached(generation):
            _cache['data'] = _build_listing()
            _cache['timestamp'] = time.monotonic()
            _cache['generation'] = generation
        return _cache['data']


def media_urls(rel_path):
    """Percent-encoded URLs for a media file, so names with '#', '?' or '%' still load."""
    return {'url': f'/images/{quote(rel_path)}', 'thumbnail_url': f'/thumbnails/{quote(rel_path)}'}


def _build_listing():
    # Read -> walk -> write, so no connection is held during the slow filesystem walk.
    with get_db() as conn:
        tags = _load_tags(conn)
        favorites = {row['filename'] for row in conn.execute('SELECT filename FROM favorites')}
        metadata = {row['filename']: row for row in conn.execute('SELECT filename, created_at, width, height, position FROM image_metadata')}
        groups, filename_to_group = _load_groups(conn)

    images = []
    new_metadata = []
    updated_metadata = []
    for path, rel_path in walk_active_files():
        meta = metadata.get(rel_path)
        if meta is None:
            w, h = read_dimensions(path, rel_path)
            created_at = path.stat().st_mtime
            new_metadata.append((rel_path, created_at, w, h))
        elif meta['width'] is None:
            w, h = read_dimensions(path, rel_path)
            updated_metadata.append((w, h, rel_path))
            created_at = meta['created_at']
        else:
            created_at, w, h = meta['created_at'], meta['width'], meta['height']

        try:
            size = path.stat().st_size
        except OSError:
            size = None

        images.append({
            'filename': rel_path,
            **media_urls(rel_path),
            'tags': tags.get(rel_path, []),
            'is_favorite': rel_path in favorites,
            'modified': created_at,
            'position': meta['position'] if meta else None,
            'width': w,
            'height': h,
            'size': size,
            'type': 'video' if is_video(rel_path) else 'image',
            'group_id': filename_to_group.get(rel_path),
        })

    if new_metadata or updated_metadata:
        with get_db() as conn:
            conn.executemany('INSERT OR IGNORE INTO image_metadata (filename, created_at, width, height) VALUES (?, ?, ?, ?)', new_metadata)
            conn.executemany('UPDATE image_metadata SET width = ?, height = ? WHERE filename = ?', updated_metadata)
            conn.commit()

    images.sort(key=lambda img: img['modified'], reverse=True)
    return json.dumps({'images': images, 'groups': groups, 'trash_count': _count_trash()})


def _count_trash():
    try:
        return sum(1 for f in TRASH_FOLDER.iterdir() if f.is_file() and not f.name.startswith('.'))
    except OSError:
        return 0


def _load_tags(conn):
    rows = conn.execute(
        f'SELECT filename, tag FROM tags WHERE {NOT_TRASHED} AND filename != ?',
        (STANDALONE_TAG_FILENAME,),
    )
    tags = {}
    for row in rows:
        tags.setdefault(row['filename'], []).append(row['tag'])
    return tags


def _load_groups(conn):
    """Return ({group_id: [filename, ...]}, {filename: group_id})."""
    groups = {}
    filename_to_group = {}
    for row in conn.execute('SELECT group_id, filename FROM image_groups'):
        groups.setdefault(row['group_id'], []).append(row['filename'])
        filename_to_group[row['filename']] = row['group_id']
    return groups, filename_to_group
