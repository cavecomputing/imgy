# Imgy agent guide

## Commands

```bash
pip install -r requirements.txt
python app.py                                         # dev server on 127.0.0.1:8000 (DATA_DIR defaults to ./data)
gunicorn --bind 127.0.0.1:8000 --workers 4 --timeout 120 app:app
docker compose up --build -d                          # serves 127.0.0.1:8000
python -m compileall -q app.py imgy                   # backend syntax check
node --input-type=module --check < imgy/static/js/<file>.js   # frontend syntax check
```

There is no test suite and no build step. After a change, run the syntax checks and exercise the affected workflow in the browser. `ffmpeg`/`ffprobe` must be on PATH for video thumbnails and dimensions.

## Layout

- `app.py` at the root is the entry point (`app = create_app()`); keep it there. `imgy/__init__.py` has `create_app()`. Shared logic lives in modules beside it (`db`, `media`, `thumbnails`, `trash`, `catalog`, `llm`); routes live in `views.py` (page, media files, thumbnails) and `api/` (one blueprint per resource, all mounted under `/api`).
- `imgy/static/js/` is plain ES modules loaded straight from `main.js`, with no framework or bundler. Don't add one without discussing it first.

## Backend rules that are easy to miss

- **The filesystem is the source of truth.** Media lives under `DATA_DIR/images/`; the database only holds metadata (tags, favorites, dimensions, groups, settings). Files copied in by hand appear on the next listing. When a handler moves or deletes files, it updates the rows that reference them in the same request.
- **Invalidate the listing cache.** `catalog.images_json()` caches `/api/images` for 2 seconds. Every handler that changes files, tags, favorites, metadata, or groups must call `invalidate_images_cache()`.
- **Validate paths.** User-supplied paths go through `media.safe_path()` or, in routes, `api/common.py` (`active_file`, `active_files`, `trash_file`), which abort with a 400/404 JSON error. Never join user input onto a path directly.
- **Errors are JSON.** In API routes, `abort(status, message)` becomes `{"error": message}`, and unexpected exceptions become a logged 500. The frontend shows `error` to the user. Read request bodies with `api/common.py:json_body()`, which rejects anything but a JSON object.
- **No login.** `create_app()` answers only to `localhost`, `127.0.0.1`, and `ALLOWED_HOSTS` (Flask's `TRUSTED_HOSTS`, against DNS rebinding), and refuses state-changing requests that browsers mark as cross-site (`Sec-Fetch-Site`, or, when that header is absent, an `Origin` that doesn't match the request's host and port); keep new write routes on POST/PUT/DELETE so they stay covered. Build media URLs with `catalog.media_urls()`, which percent-encodes names.
- **Trash keeps metadata.** Moving a file to trash renames its `tags`, `favorites`, and `image_metadata` rows to `trash:<trash name>:<original path>`, and restore renames them back. Names can contain `:` and `_`, so use the helpers in `trash.py` and `db.NOT_TRASHED` (exact prefix match) instead of splitting keys or using `LIKE`. Group memberships are dropped on trash, and groups left with one member are dissolved. Top-level media names starting with `trash:` are reserved (`media._is_media_path()` skips them).
- **New names start clean.** Rows can outlive their file (files deleted outside the app). Before a file takes a path through upload, rename, or restore, call `db.clear_filename()` so it doesn't inherit them.
- **Database access.** Use `db.get_db()` (WAL mode and a 5 s busy timeout, so several gunicorn workers can share the file) and keep transactions short. `catalog._build_listing()` reads, walks the filesystem with no connection open, then writes; keep that shape for handlers that mix filesystem and database work. The schema is created idempotently by `init_db()`.
- **Settings allowlist.** `PUT /api/settings` drops keys missing from `ALLOWED_SETTINGS_KEYS` in `api/settings.py`. Values are stored as text and the frontend converts types.
- **LLM.** `POST /api/llm/analyze/<path>` sends the image as a base64 data URL to the OpenAI-compatible endpoint, model, and key that the browser passes from its settings. The prompt is built in `llm.py`. Videos are not supported.

## Frontend conventions

- Shared state lives on `State` (`state.js`), cached DOM lookups on `Elements` (`dom.js`), and timing constants in `CONFIG` (`config.js`). `ActiveFlyup` points at whichever tag editor (gallery or lightbox) is open.
- Call the server through `api.get/post/delete` in `api.js`, which throws on errors and shows them in the error banner.
- Modules that bind event listeners export an `initX()`; `main.js` calls them in order, then loads settings and data. Imported bindings are read-only, so keep reassigned module state (timers, controllers) inside the module that owns it.
- The tag expression syntax is shared by the search bar, the tag editor, and the bulk tag editor, but each interprets tokens differently. Check the table in `README.md` before changing `tags.js`, `filters.js`, `flyup.js`, or `selection.js`.
- Colors come from CSS custom properties on `:root` and `[data-theme="dark"]` in `style.css`; don't hardcode them.

## Deployment

The Docker image starts as root; `entrypoint.sh` chowns `/data` to `PUID:PGID` and drops privileges with `gosu` before starting gunicorn. `docker-compose.yml` publishes port 8000 on `127.0.0.1`.
