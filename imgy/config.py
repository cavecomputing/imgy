"""Runtime configuration, read once from the environment at import time."""
import os
from pathlib import Path

# Resolved so paths never depend on the working directory (Flask's send_from_directory
# resolves relative paths against the package, not the CWD).
DATA_DIR = Path(os.getenv('DATA_DIR', 'data')).resolve()
UPLOAD_FOLDER = DATA_DIR / 'images'
TRASH_FOLDER = UPLOAD_FOLDER / '.trash'
THUMBNAIL_FOLDER = UPLOAD_FOLDER / '.thumbnails'
DATABASE = DATA_DIR / 'database.db'

# Host names the app answers to besides localhost, comma-separated. Unset, empty, or '*' means any host.
ALLOWED_HOSTS = [h.strip().lower() for h in (os.getenv('ALLOWED_HOSTS') or '*').split(',') if h.strip()]

# The password that signs a device in. Unset or empty means no login, as before.
PASSWORD = os.getenv('IMGY_PASSWORD', '')

MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_BULK_FILES = 500
MAX_BULK_TAGS = 50
MAX_GROUP_SIZE = 100
