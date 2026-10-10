"""The single-page app shell plus the routes that serve media files and thumbnails."""
import json
from pathlib import Path

from flask import Blueprint, current_app, jsonify, render_template, request, send_from_directory

from .config import PASSWORD, THUMBNAIL_FOLDER, UPLOAD_FOLDER
from .media import normalize_active_filename
from .thumbnails import get_or_create_thumbnail

bp = Blueprint('views', __name__)


@bp.get('/')
def index():
    return render_template('index.html', has_password=bool(PASSWORD))


@bp.get('/sw.js')
def service_worker():
    # A worker only controls pages under its own path, so it can't be served from /static/.
    return send_from_directory(current_app.static_folder, 'sw.js')


@bp.get('/manifest.webmanifest')
def manifest():
    app_manifest = json.loads((Path(current_app.root_path) / 'manifest.json').read_text())
    # Phones go fullscreen. A desktop app with its title bar hidden gets Chrome's address flashed
    # over it at every launch, so desktop keeps the standalone window.
    if request.headers.get('Sec-CH-UA-Mobile') == '?1':
        app_manifest['display_override'] = ['fullscreen']
    response = jsonify(app_manifest)
    response.mimetype = 'application/manifest+json'
    response.vary.add('Sec-CH-UA-Mobile')
    return response


@bp.get('/images/<path:filename>')
def serve_image(filename):
    try:
        filename, _path = normalize_active_filename(filename, require_exists=True)
    except (ValueError, FileNotFoundError):
        return jsonify({'error': 'File not found'}), 404
    return send_from_directory(UPLOAD_FOLDER, filename)


@bp.get('/thumbnails/<path:filename>')
def serve_thumbnail(filename):
    t_rel = get_or_create_thumbnail(filename)
    if not t_rel:
        return jsonify({'error': 'Thumbnail not available'}), 404
    return send_from_directory(THUMBNAIL_FOLDER, t_rel, mimetype='image/jpeg')
