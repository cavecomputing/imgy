"""The optional password (IMGY_PASSWORD): the sign-in page, the guard in front of every other route, sign-out.

Ported from Binny. create_app() installs all of it only when the password is set.
"""
import hashlib
import hmac
import secrets
import time
from datetime import timedelta
from urllib.parse import unquote

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for
from flask.sessions import SecureCookieSessionInterface

from .config import PASSWORD
from .db import get_db

bp = Blueprint('auth', __name__)

# "Keep this device signed in" lasts as long as browsers allow a cookie to (Chrome caps it at 400 days).
REMEMBER_FOR = timedelta(days=400)

# Everything else needs a signed-in session, so a new route is protected without opting in. Browsers
# fetch the manifest without cookies, and the worker must load to receive shares.
OPEN_ENDPOINTS = {'auth.login', 'static', 'views.manifest', 'views.service_worker'}

# The Firefox extension can't count on the cookie, so it sends the password with each request,
# percent-encoded because a header value can't carry every character a password can.
PASSWORD_HEADER = 'X-Imgy-Password'

# A wrong password holds off every password check for a second, the right password included, so
# guessing goes at one try a second however many requests run side by side. The time is kept in the
# database because gunicorn runs several worker processes. Signed-in devices aren't affected; while
# someone is guessing, a new device may have to try a few times.
WRONG_PASSWORD_WAIT = 1  # seconds
class SessionInterface(SecureCookieSessionInterface):
    def save_session(self, app, session, response):
        """Leave the cookie and its Vary: Cookie off files the browser keeps for good (views._versioned).

        Every response renews the cookie with a fresh timestamp, so Vary: Cookie would make the browser
        download every thumbnail again on each visit. The file is the same for anyone signed in, and
        it only reached the browser through require_login().
        """
        if not response.cache_control.immutable:
            super().save_session(app, session, response)

    def get_cookie_secure(self, app):
        """Mark the cookie Secure whenever the browser reached Imgy over HTTPS.

        Behind a reverse proxy that comes from X-Forwarded-Proto (ProxyFix in create_app). Over plain
        HTTP on the LAN a Secure cookie would never come back, so it isn't set there.
        """
        return request.is_secure


def signing_key():
    """The key that signs session cookies: a random secret kept in the database, mixed with the password.

    Changing IMGY_PASSWORD signs every device out. So does deleting the `secret_key` setting and
    restarting.
    """
    with get_db() as conn:
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('secret_key', ?)", (secrets.token_hex(32),))
        conn.commit()
        secret = conn.execute("SELECT value FROM settings WHERE key = 'secret_key'").fetchone()['value']
    return hmac.new(bytes.fromhex(secret), PASSWORD.encode(), hashlib.sha256).digest()


def check_password(password):
    """True or False, or None while a recent wrong password holds every check off."""
    with get_db() as conn:
        conn.execute('BEGIN IMMEDIATE')  # one check at a time across workers
        row = conn.execute("SELECT value FROM settings WHERE key = 'next_sign_in'").fetchone()
        if row and time.time() < float(row['value']):
            return None
        # Comparing digests keeps the time taken from telling anything about the password, its length included.
        right = hmac.compare_digest(hashlib.sha256(password.encode()).digest(), hashlib.sha256(PASSWORD.encode()).digest())
        if not right:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('next_sign_in', ?)",
                         (str(time.time() + WRONG_PASSWORD_WAIT),))
        conn.commit()
    if not right:
        time.sleep(WRONG_PASSWORD_WAIT)  # so whoever mistyped can try again as soon as they see this
    return right


def require_login():
    """before_request guard: API calls get a 401, page loads go to the sign-in page."""
    if session.get('signed_in') or request.endpoint in OPEN_ENDPOINTS:
        return None
    sent = request.headers.get(PASSWORD_HEADER)
    if sent is not None:
        right = check_password(unquote(sent))
        if right:
            return None
        message = 'Too many wrong passwords just now. Try again in a moment.' if right is None else 'Wrong password'
        return jsonify({'error': message}), 429 if right is None else 401
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Sign in first'}), 401
    return redirect(url_for('auth.login', next=request.full_path.rstrip('?')))


def local_target(target):
    """target if it is a path on this site, else '/', so ?next= can't send the browser elsewhere.

    Browsers drop tabs and newlines from a URL and read a backslash as a slash, so any of them
    could turn it into "//elsewhere", another site.
    """
    if target and target.startswith('/') and not target.startswith('//') \
            and not any(c == '\\' or c <= ' ' for c in target):
        return target
    return '/'


@bp.route('/login', methods=['GET', 'POST'])
def login():
    if session.get('signed_in'):
        return redirect(local_target(request.args.get('next')))
    if request.method == 'GET':
        return render_template('login.html', error=None)
    right = check_password(request.form.get('password', ''))
    if right is None:
        return render_template('login.html', error='Too many wrong passwords just now. Try again in a moment.'), 429
    if not right:
        return render_template('login.html', error='That password is wrong.'), 401
    session.clear()
    session['signed_in'] = True
    session.permanent = request.form.get('remember') == 'on'
    return redirect(local_target(request.args.get('next')))


@bp.post('/logout')
def logout():
    session.clear()
    return redirect(url_for('auth.login'))
