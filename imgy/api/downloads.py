"""Saving the video on a web page into the library with yt-dlp, in a background thread.

A download's progress lives in the downloads table rather than in memory, because the
gunicorn worker that started it is rarely the one that answers the next poll.
"""
import logging
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import yt_dlp
from flask import Blueprint, abort

from ..catalog import invalidate_images_cache
from ..config import DOWNLOAD_FOLDER
from ..db import get_db
from ..media import allowed_file
from .common import json_body
from .images import add_to_library
from .tags import request_tags

logger = logging.getLogger(__name__)

bp = Blueprint('downloads', __name__)

ACTIVE = ('starting', 'downloading', 'processing')
# A download that hasn't written progress for this long died with its worker
STALE_SECONDS = 300
# Finished downloads stay listed this long, so every open page sees how they ended
SHOW_FINISHED_SECONDS = 60


@bp.post('/downloads')
def start_download():
    data = json_body()
    url = data.get('url')
    url = url.strip() if isinstance(url, str) else ''
    host = urlsplit(url).hostname if url else None
    if urlsplit(url).scheme not in ('http', 'https') or not host:
        abort(400, 'Paste a link that starts with http:// or https://')
    tags = request_tags(data.get('tags', []))
    download_id = uuid.uuid4().hex[:12]
    with get_db() as conn:
        conn.execute('DELETE FROM downloads WHERE updated_at < ?', (time.time() - 86400,))
        conn.execute('INSERT INTO downloads (id, url, site, status, updated_at) VALUES (?, ?, ?, ?, ?)',
                     (download_id, url, host.removeprefix('www.'), 'starting', time.time()))
        conn.commit()
    threading.Thread(target=_download, args=(download_id, url, tags), daemon=True).start()
    return {'id': download_id}, 202


@bp.get('/downloads')
def list_downloads():
    now = time.time()
    with get_db() as conn:
        conn.execute(f'''UPDATE downloads SET status = 'failed', error = 'The download stopped answering', updated_at = ?
                         WHERE status IN {ACTIVE} AND updated_at < ?''', (now, now - STALE_SECONDS))
        conn.commit()
        rows = conn.execute(f'''SELECT id, site, status, title, part, downloaded, total, filename, error FROM downloads
                                WHERE status IN {ACTIVE} OR updated_at > ? ORDER BY rowid''',
                            (now - SHOW_FINISHED_SECONDS,)).fetchall()
    return {'downloads': [dict(row) for row in rows]}


@bp.delete('/downloads/<download_id>')
def cancel_download(download_id):
    with get_db() as conn:
        conn.execute(f"UPDATE downloads SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN {ACTIVE}",
                     (time.time(), download_id))
        conn.commit()
    return {'success': True}


def _download(download_id, url, tags):
    workdir = DOWNLOAD_FOLDER / download_id
    last_write = 0.0

    def update(**fields):
        """Record progress, or stop the download if it was cancelled from any worker."""
        with get_db() as conn:
            if conn.execute('SELECT status FROM downloads WHERE id = ?', (download_id,)).fetchone()['status'] == 'cancelled':
                raise yt_dlp.utils.DownloadCancelled()
            fields['updated_at'] = time.time()
            assignments = ', '.join(f'{name} = ?' for name in fields)
            conn.execute(f'UPDATE downloads SET {assignments} WHERE id = ?', (*fields.values(), download_id))
            conn.commit()

    def on_progress(progress):
        nonlocal last_write
        if progress['status'] != 'downloading' or time.monotonic() - last_write < 0.5:
            return
        last_write = time.monotonic()
        info = progress['info_dict']
        # Sites like YouTube serve the picture and the sound as two files that ffmpeg joins after
        part = 'video' if info.get('acodec') == 'none' else 'audio' if info.get('vcodec') == 'none' else None
        update(status='downloading', title=info.get('title'), part=part, downloaded=progress.get('downloaded_bytes'),
               total=progress.get('total_bytes') or progress.get('total_bytes_estimate'))

    def on_postprocess(progress):
        if progress['status'] == 'started':
            update(status='processing')

    options = {
        'paths': {'home': str(workdir), 'temp': str(workdir)},
        'outtmpl': '%(title).100B.%(ext)s',
        'noplaylist': True,
        'playlist_items': '1',  # a playlist or a post with several videos gives its first one
        # The best quality the site has (yt-dlp's default choice), joined into MP4 so the file keeps
        # a type Imgy lists. No size cap: a long 4K video can pass the 500 MB upload limit.
        'merge_output_format': 'mp4',
        'match_filter': yt_dlp.utils.match_filter_func('!is_live'),
        'updatetime': False,  # the file's date is when it was added, as for an upload
        'progress_hooks': [on_progress],
        'postprocessor_hooks': [on_postprocess],
        'quiet': True,
        'noprogress': True,
    }
    try:
        workdir.mkdir(parents=True, exist_ok=True)
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url)
        entry = (info.get('entries') or [info])[0] if info else None
        path = Path(entry['requested_downloads'][0]['filepath']) if entry and entry.get('requested_downloads') else None
        if not path or not path.exists():
            raise yt_dlp.utils.DownloadError('Nothing to download. Live streams are skipped.')
        if path.suffix == '.unknown_video':  # yt-dlp's name for a direct link that isn't a video
            raise yt_dlp.utils.DownloadError('No video at that link')
        if not allowed_file(path.name):
            raise yt_dlp.utils.DownloadError(f'The site sent a {path.suffix} file, which Imgy can\'t show')
        update(status='processing')  # last chance to cancel before the file joins the library
        added = add_to_library(path.name, lambda dest: os.replace(path, dest), tags)
        invalidate_images_cache()
        update(status='done', filename=added['filename'])
    except yt_dlp.utils.DownloadCancelled:
        pass
    except yt_dlp.utils.YoutubeDLError as e:
        # "ERROR: [youtube] dQw4w9WgXcQ: Private video (caused by ...)" -> "Private video"
        _fail(download_id, re.sub(r'^(ERROR: )?(\[[^\]]+\] ([^:\s]+: )?)?|\s*\(caused by .*$', '', str(e)))
    except Exception:
        logger.exception(f'Download of {url} failed')
        _fail(download_id, 'Internal error')
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _fail(download_id, message):
    with get_db() as conn:
        conn.execute("UPDATE downloads SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'",
                     (message, time.time(), download_id))
        conn.commit()
