"""Imgy: a local-first image and video organizer."""
import logging
import mimetypes
from urllib.parse import urlsplit

from flask import Flask, abort, request

from . import api, views
from .config import ALLOWED_HOSTS, MAX_UPLOAD_BYTES, THUMBNAIL_FOLDER, TRASH_FOLDER, UPLOAD_FOLDER
from .db import init_db


def create_app():
    logging.basicConfig(level=logging.INFO)
    # Browsers refuse module scripts not served as JavaScript, and some Windows registries
    # map .js to text/plain.
    mimetypes.add_type('text/javascript', '.js')
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_BYTES
    # With ALLOWED_HOSTS set, answer 400 to other Host headers, so a web page can't point its own
    # hostname at this machine (DNS rebinding) and read the library and the API key as same-origin.
    if '*' not in ALLOWED_HOSTS:
        app.config['TRUSTED_HOSTS'] = ['localhost', '127.0.0.1', *ALLOWED_HOSTS]

    for folder in (UPLOAD_FOLDER, TRASH_FOLDER, THUMBNAIL_FOLDER):
        folder.mkdir(parents=True, exist_ok=True)
    init_db()

    app.register_blueprint(views.bp)
    app.register_blueprint(api.bp)

    @app.before_request
    def reject_cross_site_requests():
        """There is no login, so refuse changes sent by another site's page in the same browser.

        Browsers send Sec-Fetch-Site to localhost and HTTPS servers. Over plain HTTP elsewhere they
        send only Origin, which must then match the host and port exactly (another port on the
        same machine is another site). Scripts like curl send neither.

        Firefox extension pages (the Imgy extension's upload window) send a moz-extension:// Origin,
        which no web page can forge, so those writes pass whatever Sec-Fetch-Site says.
        """
        if request.method in ('GET', 'HEAD', 'OPTIONS'):
            return
        site = request.headers.get('Sec-Fetch-Site')
        origin = request.headers.get('Origin')
        if origin and origin.startswith('moz-extension://'):
            return
        if site in ('cross-site', 'same-site') \
                or (site is None and origin is not None and urlsplit(origin).netloc != request.host):
            abort(403, 'Cross-site request blocked')

    return app
