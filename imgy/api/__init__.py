"""JSON API, mounted at /api. Each resource lives in its own child blueprint."""
import logging

from flask import Blueprint, jsonify, request
from werkzeug.exceptions import HTTPException

from . import favorites, groups, images, llm, maintenance, settings, tags, trash

logger = logging.getLogger(__name__)

bp = Blueprint('api', __name__, url_prefix='/api')
for module in (images, tags, favorites, groups, trash, settings, maintenance, llm):
    bp.register_blueprint(module.bp)


@bp.errorhandler(HTTPException)
def http_error(e):
    """abort(status, message) -> {"error": message} with that status."""
    return jsonify({'error': e.description}), e.code


@bp.errorhandler(Exception)
def unexpected_error(e):
    logger.exception(f'Unhandled error in {request.endpoint}')
    return jsonify({'error': 'Internal server error'}), 500
