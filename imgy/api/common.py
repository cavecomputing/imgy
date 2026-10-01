"""Request helpers shared by the API blueprints.

They validate input and abort() with the JSON error the frontend expects, so route
handlers can stay on the happy path. Anything unexpected becomes a 500 in api/__init__.py.
"""
from flask import abort, request

from ..media import InvalidPath, normalize_active_filename, normalize_active_filenames, normalize_trash_filename


def json_body():
    """The request's JSON object, or {} when there is no body. Anything else is a 400."""
    if not request.get_data(cache=True):
        return {}
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, 'Expected a JSON object')
    return data


def active_file(filename, must_exist=True):
    """Validate one media path from the request. Returns (relative path, absolute path)."""
    try:
        return normalize_active_filename(filename, require_exists=must_exist)
    except ValueError:
        abort(400, 'Invalid path')
    except FileNotFoundError:
        abort(404, 'File not found')


def active_files(filenames, limit, too_many, must_exist=True):
    """Validate a list of media paths from the request, de-duplicated in order."""
    try:
        return normalize_active_filenames(filenames, limit, require_exists=must_exist)
    except OverflowError:
        abort(400, too_many)
    except InvalidPath:
        abort(400, 'Invalid path')
    except ValueError as e:
        abort(400, str(e))
    except FileNotFoundError:
        abort(404, 'File not found')


def trash_file(filename, must_exist=True):
    """Validate a trash entry name from the request. Returns (name, absolute path)."""
    try:
        return normalize_trash_filename(filename, require_exists=must_exist)
    except ValueError:
        abort(400, 'Invalid path')
    except FileNotFoundError:
        abort(404, 'File not found')
