"""Soft delete.

A trashed file moves to TRASH_FOLDER as ``<time_ns>_<name>``. Its tags, favorite, and
metadata rows are kept but re-keyed to ``trash:<trash name>:<original path>`` so a restore
can put everything back. Group memberships are dropped.
"""
import time

from .config import TRASH_FOLDER
from .db import FILENAME_TABLES, TRASH_PREFIX, clear_filename, remove_from_groups, rename_filename
from .media import normalize_active_filename
from .thumbnails import delete_thumbnail


def trash_key(trash_name, original_filename):
    return f'{TRASH_PREFIX}{trash_name}:{original_filename}'


def key_prefix(trash_name):
    """The start of every row key belonging to one trash entry. Names may contain ':'."""
    return trash_key(trash_name, '')


def _where_prefix(prefix):
    return 'substr(filename, 1, ?) = ?', (len(prefix), prefix)


def move_to_trash(conn, filename):
    """Move a media file to the trash and re-key its rows. Raises on invalid or missing files."""
    filename, source_path = normalize_active_filename(filename, require_exists=True)
    trash_name = f'{time.time_ns()}_{source_path.name}'
    source_path.rename(TRASH_FOLDER / trash_name)
    key = trash_key(trash_name, filename)
    rename_filename(conn, filename, key)
    remove_from_groups(conn, [filename])
    delete_thumbnail(filename)
    return key


def find_trash_record(conn, trash_name):
    """Return (key prefix of the entry's rows, original relative path)."""
    prefix = key_prefix(trash_name)
    where, params = _where_prefix(prefix)
    for table in FILENAME_TABLES:
        row = conn.execute(f'SELECT filename FROM {table} WHERE {where} LIMIT 1', params).fetchone()
        if row:
            return prefix, row['filename'][len(prefix):]
    # No rows (e.g. a file dropped into .trash by hand): restore to the top level.
    return prefix, parse_trash_name(trash_name)[0]


def restore_records(conn, prefix, original_filename):
    """Re-key a trash entry's rows back to its original path."""
    clear_filename(conn, original_filename)
    where, params = _where_prefix(prefix)
    for table in FILENAME_TABLES:
        conn.execute(f'UPDATE {table} SET filename = ? WHERE {where}', (original_filename, *params))


def delete_trash_records(conn, prefix=TRASH_PREFIX):
    """Delete the rows of one trash entry, or of every entry with the default prefix."""
    where, params = _where_prefix(prefix)
    for table in FILENAME_TABLES:
        conn.execute(f'DELETE FROM {table} WHERE {where}', params)


def parse_trash_name(trash_name):
    """Split '<time_ns>_<name>' into (name, trashed-at seconds); other names are returned as-is."""
    stamp, sep, name = trash_name.partition('_')
    if sep and stamp.isdigit():
        try:
            return name, int(stamp) / 1e9
        except (ValueError, OverflowError):
            return name, None
    return trash_name, None
