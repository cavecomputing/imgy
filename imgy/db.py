"""SQLite access. The database only holds metadata; the filesystem is the source of truth."""
import logging
import sqlite3
from contextlib import contextmanager

from .config import DATABASE

logger = logging.getLogger(__name__)

# Tables keyed by an image's relative path (or its trash: key while trashed).
FILENAME_TABLES = ('tags', 'image_metadata', 'favorites')

# Pseudo-filename that holds tags created without an image ("+tag" in the filter bar).
STANDALONE_TAG_FILENAME = '__standalone__'

# Rows of a trashed file are keyed 'trash:<trash name>:<original path>' (see trash.py).
# Compared with substr() rather than LIKE, which ignores case and treats '_' as a wildcard.
TRASH_PREFIX = 'trash:'
NOT_TRASHED = f"substr(filename, 1, {len(TRASH_PREFIX)}) != '{TRASH_PREFIX}'"

SCHEMA = '''
    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        tag TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
        filename TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS image_metadata (
        filename TEXT PRIMARY KEY,
        created_at REAL NOT NULL,
        width INTEGER,
        height INTEGER,
        position INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_filename_tag ON tags(filename, tag);
    DROP INDEX IF EXISTS idx_filename;
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
    CREATE INDEX IF NOT EXISTS idx_favorites_filename ON favorites(filename);
    CREATE INDEX IF NOT EXISTS idx_metadata_filename ON image_metadata(filename);
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS image_groups (
        group_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        PRIMARY KEY (group_id, filename)
    );
    CREATE INDEX IF NOT EXISTS idx_groups_group_id ON image_groups(group_id);
    CREATE INDEX IF NOT EXISTS idx_groups_filename ON image_groups(filename);
'''


@contextmanager
def get_db():
    """Open a short-lived connection. WAL + busy_timeout keep multiple gunicorn workers safe."""
    conn = sqlite3.connect(str(DATABASE))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=5000')
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    """Create the schema if needed. Safe to run on every start."""
    logger.info('Initializing database...')
    with get_db() as conn:
        conn.executescript(SCHEMA)
        # Databases created before dimensions or the custom order were tracked lack these columns.
        columns = {row['name'] for row in conn.execute('PRAGMA table_info(image_metadata)')}
        for column in ('width', 'height', 'position'):
            if column not in columns:
                try:
                    conn.execute(f'ALTER TABLE image_metadata ADD COLUMN {column} INTEGER')
                except sqlite3.OperationalError as e:
                    # Another gunicorn worker added it first.
                    if 'duplicate column' not in str(e):
                        raise
        conn.commit()


def rename_filename(conn, old, new, *, include_groups=False):
    """Re-key rows in every filename table from old to new."""
    for table in FILENAME_TABLES:
        conn.execute(f'UPDATE {table} SET filename = ? WHERE filename = ?', (new, old))
    if include_groups:
        conn.execute('UPDATE image_groups SET filename = ? WHERE filename = ?', (new, old))


def clear_filename(conn, filename):
    """Delete leftover rows for a path whose file is gone, before a new file takes that path."""
    for table in FILENAME_TABLES:
        conn.execute(f'DELETE FROM {table} WHERE filename = ?', (filename,))
    remove_from_groups(conn, [filename])


def remove_from_groups(conn, filenames):
    """Take files out of their groups, dissolving any group left with fewer than two members."""
    affected = {row['group_id'] for filename in filenames
                for row in conn.execute('SELECT group_id FROM image_groups WHERE filename = ?', (filename,))}
    conn.executemany('DELETE FROM image_groups WHERE filename = ?', [(f,) for f in filenames])
    dissolve_small_groups(conn, affected)


def dissolve_small_groups(conn, group_ids):
    for group_id in group_ids:
        if conn.execute('SELECT COUNT(*) FROM image_groups WHERE group_id = ?', (group_id,)).fetchone()[0] < 2:
            conn.execute('DELETE FROM image_groups WHERE group_id = ?', (group_id,))


def active_tag_names(conn):
    """All distinct tag names, excluding tags that only exist on trashed files."""
    rows = conn.execute(f'SELECT DISTINCT tag FROM tags WHERE {NOT_TRASHED} ORDER BY tag')
    return [row['tag'] for row in rows]
