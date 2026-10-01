"""App settings (a flat key/value store) and exclusive tag groups for the LLM tagger."""
import json

from flask import Blueprint, abort, request

from ..db import get_db
from .common import json_body

bp = Blueprint('settings', __name__)

# PUT /api/settings silently drops keys that are not listed here. Tag groups have their own
# endpoint so they are always validated.
ALLOWED_SETTINGS_KEYS = {
    'llmProvider', 'llmApiUrl', 'llmModel', 'llmDoRename', 'llmDoTags', 'llmApiSecret', 'theme',
}


def load_tag_groups(conn):
    """Exclusive tag groups: [{"name": str, "tags": [str, ...]}, ...].

    Groups are stored as the settings dialog edits them, so some may be unnamed or have fewer
    than two tags; the LLM prompt skips those.
    """
    row = conn.execute("SELECT value FROM settings WHERE key = 'tagGroups'").fetchone()
    try:
        groups = json.loads(row['value']) if row else []
    except ValueError:
        groups = []
    if not isinstance(groups, list):  # older versions accepted anything through PUT /api/settings
        return []
    return [{'name': str(g.get('name') or ''), 'tags': [t for t in g['tags'] if isinstance(t, str)]}
            for g in groups if isinstance(g, dict) and isinstance(g.get('tags'), list)]


def _save_tag_groups(conn, groups):
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('tagGroups', ?)", (json.dumps(groups),))


def rename_tag_in_groups(conn, old_tag, new_tag):
    """Follow a global tag rename (or deletion, when new_tag is None) in the tag groups."""
    groups = load_tag_groups(conn)
    if not any(old_tag in group['tags'] for group in groups):
        return
    # If new_tag is already in a group, the old tag merges into it and just disappears.
    drop = new_tag is None or any(new_tag in group['tags'] for group in groups)
    for group in groups:
        group['tags'] = [new_tag if tag == old_tag else tag for tag in group['tags'] if tag != old_tag or not drop]
    _save_tag_groups(conn, groups)


@bp.get('/settings')
def get_settings():
    with get_db() as conn:
        return {row['key']: row['value'] for row in conn.execute('SELECT key, value FROM settings')}


@bp.put('/settings')
def put_settings():
    """Upsert any allowed keys. Values are stored as text; the frontend coerces types."""
    updates = [(k, str(v)) for k, v in json_body().items() if k in ALLOWED_SETTINGS_KEYS]
    if updates:
        with get_db() as conn:
            conn.executemany('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', updates)
            conn.commit()
    return {'status': 'ok'}


@bp.get('/tag-groups')
def get_tag_groups():
    with get_db() as conn:
        return load_tag_groups(conn)


@bp.put('/tag-groups')
def put_tag_groups():
    """Replace all groups. Each has a name and a list of tags; a tag can be in one group only."""
    groups = request.get_json(silent=True)
    if not isinstance(groups, list):
        abort(400, 'Expected a JSON array')
    cleaned = []
    seen = set()
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('name', ''), str) \
                or not isinstance(group.get('tags', []), list) \
                or not all(isinstance(tag, str) for tag in group.get('tags', [])):
            abort(400, 'Each group needs a name and a list of tags')
        tags = list(dict.fromkeys(tag.strip().lower() for tag in group.get('tags', []) if tag.strip()))
        for tag in tags:
            if tag in seen:
                abort(400, f'Tag "{tag}" appears in multiple groups')
            seen.add(tag)
        cleaned.append({'name': group.get('name', '').strip(), 'tags': tags})
    with get_db() as conn:
        _save_tag_groups(conn, cleaned)
        conn.commit()
    return {'status': 'ok'}
