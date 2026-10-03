"""The single-page app shell plus the routes that serve media files and thumbnails."""
from flask import Blueprint, current_app, jsonify, render_template, send_from_directory

from .config import THUMBNAIL_FOLDER, UPLOAD_FOLDER
from .media import normalize_active_filename
from .thumbnails import get_or_create_thumbnail

bp = Blueprint('views', __name__)


@bp.get('/')
def index():
    return render_template('index.html')


@bp.get('/sw.js')
def service_worker():
    # A worker only controls pages under its own path, so it can't be served from /static/.
    return send_from_directory(current_app.static_folder, 'sw.js')


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
