# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git workflow

The repository is **public**, so anything that lands on `main` is something a stranger may run.

Commit directly to `main`: this project uses no feature branches or PRs. Only include files belonging
to the task, and leave unrelated pre-existing changes and stray untracked files alone.

**One commit, one concern.** A commit has to be reviewable on its own and safe to revert on its own,
so split unrelated work rather than bundling it: a bug fix and a docs correction that happened to
land in the same session are two commits. Size is not the test: a change that genuinely touches
twenty files is still one commit if it is one concern. Say in the message what broke and why the fix
works, not just what you typed.

This file is the only agent doc. Don't add an `AGENTS.md` or a second copy of these rules.

## Least code that does the job

Aim for the smallest diff that completes the task in full. This is a plain-JavaScript, no-build,
Flask-and-SQLite app, and it stays approachable only while changes stay small.

- Prefer editing existing code over adding new code, and a few lines at the right call site over a
  new helper, module or class. Add a file only when something forces it.
- Reuse what is already here: `db.get_db()`, `api/common.py`, `catalog.media_urls()`, `api.js`, the
  CSS custom properties, the vendored `cc-*` components. A second implementation of something the
  repo already does is the most expensive kind of code.
- **No new dependency without asking first**, Python or JavaScript. That includes a framework or a
  bundler for the frontend.
- Leave out what nothing needs yet: config knobs, feature flags, an abstraction with one caller,
  `try`/`except` around code that doesn't raise, re-validation of data the route already validated.
- Deleting code is a legitimate way to finish a task. Say so when the fix turns out to be a removal.

This governs the amount of code, not the amount of work. Deliver everything that was asked and run
the verification the change calls for.

## Naming

A name is the cheapest documentation in the file. Make it a concise nameplate for what the thing is
or does: long enough to be unambiguous where it is *used*, short enough to read at a glance.

- Prefer the specific noun to the category: `trash_name`, `visibleFiles`, `tagCounts` over `value`,
  `data`, `items`.
- Name a function for what it returns or does, not how it works.
- Don't encode the type or the scope in the name (`tagListArr`, `tmpDict`), and don't abbreviate
  past recognition.
- Follow the module you are editing, `snake_case` in Python and `camelCase` in JS, over any
  preference of your own.

Renaming existing code is its own task. Don't fold a rename into an unrelated change, where it
buries the real diff under noise.

## Run / verify

```bash
uv sync                                               # install the locked dependencies into .venv
uv run app.py                                         # dev server on 127.0.0.1:5000 (DATA_DIR defaults to ./data)
uv run gunicorn --bind 127.0.0.1:5000 --workers 4 --worker-class gthread --threads 8 --timeout 120 app:app
docker compose -f docker/compose.yml up --build -d    # serves 127.0.0.1:5000

uv run python -m compileall -q app.py imgy            # backend syntax check
node --input-type=module --check < imgy/static/js/<file>.js   # frontend syntax check
```

There is no test suite and no build step. `ffmpeg`/`ffprobe` must be on PATH for video thumbnails
and dimensions.

Dependencies are declared in `pyproject.toml` and pinned in `uv.lock`. Change them with
`uv add`/`uv remove` (or edit `pyproject.toml` and run `uv lock`) and commit both files: the Docker
build runs `uv sync --locked`, which fails on a stale lock.

### How much verification a change needs

Match the effort to the change; a public repo makes a broken `main` everyone's problem, but it does
not make every edit worth a full boot-and-click cycle.

Always run the syntax checks for the files you touched. **Booting the dev server is not required after
every change.** Start it when the change can only be confirmed in a browser (layout, theming, the
phone layout, the lightbox, hover and focus behaviour, upload and drag-and-drop) or when asked. For
backend logic you can exercise with `curl` against the dev server, a docs-only edit or a comment,
skip the browser and say so. Never claim a change was verified in the app when it wasn't.

Browser-testing gotchas:

- `uv run app.py` runs Flask with debug off, so templates are cached: restart the server after
  editing `index.html`.
- Playwright's `fill('')` presses Delete, and Delete in the filter bar deletes the top suggestion
  everywhere (after a confirm). Clear the filter with Ctrl+A and Backspace instead.
- Playwright's Chromium can't play the H.264 sample video, so the "format may not be supported" toast
  there is expected.

## Architecture

Single-process Flask app, plain-JS frontend, no build step. Read the module you are touching: what
follows is the map, plus the rules the code cannot tell you on its own.

| Module | Owns |
|---|---|
| [app.py](app.py) | Entry point, and the only Python file at the repo root: `app = create_app()`, which `gunicorn app:app` names. Keep it there. |
| [imgy/\_\_init\_\_.py](imgy/__init__.py) | `create_app()`: host check, cross-site write guard, `init_db()`, blueprints. |
| [imgy/config.py](imgy/config.py) | Paths and limits, read once from the environment. |
| [imgy/db.py](imgy/db.py) | Schema (`init_db()`), `get_db()`, and the trash-key helpers (`NOT_TRASHED`, `clear_filename()`). |
| [imgy/media.py](imgy/media.py) | `safe_path()`, file walking, dimensions. |
| [imgy/thumbnails.py](imgy/thumbnails.py) | Thumbnail generation. Pure cache, safe to delete wholesale. |
| [imgy/trash.py](imgy/trash.py) | Soft delete and restore. |
| [imgy/catalog.py](imgy/catalog.py) | The cached `/api/images` listing and `media_urls()`. |
| [imgy/llm.py](imgy/llm.py) | LLM client and prompt. |
| [imgy/views.py](imgy/views.py) | Page, media file and thumbnail routes. |
| [imgy/api/](imgy/api/) | One blueprint per resource, all mounted under `/api`. |
| [imgy/templates/index.html](imgy/templates/index.html) | The entire page. JS modules are in [imgy/static/js/](imgy/static/js/), entry [main.js](imgy/static/js/main.js). |
| [imgy/static/](imgy/static/) | `cavecomputing.css` (vendored design system) and `style.css` (Imgy's layout and theme tokens). |
| [docker/](docker/) | Dockerfile, `compose.yml`, `entrypoint.sh`, `Dockerfile.dockerignore`. |

### Data lives in two places

**The filesystem is the source of truth.** Media lives under `DATA_DIR/images/`; the database
(`DATA_DIR/database.db`) only holds metadata (tags, favorites, dimensions, custom order, groups, settings). Files
copied in by hand appear on the next listing. When a handler moves or deletes files, it updates the
rows that reference them in the same request.

### Backend rules that are easy to miss

- **Invalidate the listing cache.** `catalog.images_json()` caches `/api/images` for 2 seconds. Every handler that changes files, tags, favorites, metadata, or groups must call `invalidate_images_cache()`.
- **Validate paths.** User-supplied paths go through `media.safe_path()` or, in routes, `api/common.py` (`active_file`, `active_files`, `trash_file`), which abort with a 400/404 JSON error. Never join user input onto a path directly.
- **Errors are JSON.** In API routes, `abort(status, message)` becomes `{"error": message}`, and unexpected exceptions become a logged 500. The frontend shows `error` to the user. Read request bodies with `api/common.py:json_body()`, which rejects anything but a JSON object.
- **No login.** `create_app()` answers to any host unless `ALLOWED_HOSTS` is set, and then only to `localhost`, `127.0.0.1`, and those names (Flask's `TRUSTED_HOSTS`, against DNS rebinding). It always refuses state-changing requests that browsers mark as cross-site (`Sec-Fetch-Site`, or, when that header is absent, an `Origin` that doesn't match the request's host and port); keep new write routes on POST/PUT/DELETE so they stay covered. Build media URLs with `catalog.media_urls()`, which percent-encodes names.
- **Trash keeps metadata.** Moving a file to trash renames its `tags`, `favorites`, and `image_metadata` rows to `trash:<trash name>:<original path>`, and restore renames them back. Names can contain `:` and `_`, so use the helpers in `trash.py` and `db.NOT_TRASHED` (exact prefix match) instead of splitting keys or using `LIKE`. Group memberships are dropped on trash, and groups left with one member are dissolved. Top-level media names starting with `trash:` are reserved (`media._is_media_path()` skips them).
- **New names start clean.** Rows can outlive their file (files deleted outside the app). Before a file takes a path through upload, rename, or restore, call `db.clear_filename()` so it doesn't inherit them.
- **Database access.** Use `db.get_db()` (WAL mode and a 5 s busy timeout, so several gunicorn workers can share the file) and keep transactions short. Each worker runs 8 threads (`gthread`), so module-level state needs a lock or a single read, as in `catalog._cached()`. `catalog._build_listing()` reads, walks the filesystem with no connection open, then writes; keep that shape for handlers that mix filesystem and database work. The schema is created idempotently by `init_db()`.
- **Custom order.** `image_metadata.position` is 0..n-1 for the files in the last `POST /api/images/reorder` and null for files never placed, which the frontend shows first. It sits on `image_metadata` so rename, trash, and restore carry it with the rest of the row. The `galleryOrder` setting (`newest` or `custom`) decides whether it is used.
- **Settings allowlist.** `PUT /api/settings` drops keys missing from `ALLOWED_SETTINGS_KEYS` in `api/settings.py`. Values are stored as text and the frontend converts types.
- **LLM.** `POST /api/llm/analyze/<path>` sends the image as a base64 data URL to the OpenAI-compatible endpoint, model, and key that the browser passes from its settings. The prompt is built in `llm.py`. Videos are not supported.

### Frontend conventions

- Shared state lives on `State` (`state.js`), cached DOM lookups on `Elements` (`dom.js`), and timing constants in `CONFIG` (`config.js`). `ActiveFlyup` points at whichever tag editor (gallery or lightbox) is open.
- Call the server through `api.get/post/delete` in `api.js`, which throws on errors and shows them in the error banner.
- Modules that bind event listeners export an `initX()`; `main.js` calls them in order, then loads settings and data. Imported bindings are read-only, so keep reassigned module state (timers, controllers) inside the module that owns it.
- The tag expression syntax is shared by the filter bar, the tag editor, and the bulk tag editor, but each interprets tokens differently. Check the table in `README.md` before changing `tags.js`, `filters.js`, `flyup.js`, or `selection.js`.
- Colors come from CSS custom properties on `:root` and `[data-theme="dark"]` in `style.css`; don't hardcode them. The look follows the cavecomputing design system: its components (`cc-btn`, `cc-badge`, `cc-callout`, `cc-table`, ...) are vendored in `cavecomputing.css`, so reuse them before adding new ones, and keep each accent to one meaning (yellow focus and selection, green brand and done, blue links and paths, orange destructive).
- The grid draws only the first part of `State.filteredImages`: `renderImageGrid()` draws `BATCH` files, and an observer on `#gridEnd` draws the next batch whenever the end of the grid comes within `PRELOAD_PX` of the window (both in `grid.js`). A file can therefore have no card, so look files up in `State`, not the DOM, and expect a missing card from a selector. A redraw reaches down to the current scroll position, so `applyFilters()` can scroll back to it. Files not drawn yet keep their places when the user drags (`saveImageOrder`).
- `applyFilters()` does not rebuild the grid when the files shown are the same ones, or the same minus some top-level cards (`updateInPlace()` in `grid.js`); it only redraws a card's tags, and `updateLocalState()` patches the favorite star. Anything else a card shows has to be patched by whoever changes it, or the rebuild forced by changing the list.
- Dragging to reorder (`reorder.js`) moves the real cards in the DOM and renumbers `card.dataset.idx` instead of re-rendering, so a handler must read a card's index when it runs, not from a closure made at render time. The grid fills columns by height, so the slot is placed by where the dragged copy is alone (`placeSlot`); choosing by where the slot is now makes a copy held still bounce it between two spots.
- Buttons that appear on hover (the card actions) follow the pointer only, plus `:focus-visible` for Tab. Never tie them to `:focus-within` or to arrow-key focus, and blur a button after a mouse click, or the next key press makes it match `:focus-visible` and the buttons come back.

### Deployment

Everything Docker lives in `docker/`, so mind which folder a relative path starts from:

- `docker/compose.yml` builds with the repo root as the context (`context: ..`), so COPY paths in `docker/Dockerfile` start at the repo root (`docker build -f docker/Dockerfile .` by hand).
- Relative paths in the compose file start at `docker/`: the data volume is `../data`, the same `data/` the dev server uses. Compose also reads `.env` and `compose.override.yml` from `docker/` (the override only when run from inside `docker/`, not with `-f`).
- The build's ignore file is `docker/Dockerfile.dockerignore` (BuildKit reads it beside the Dockerfile, in place of a root `.dockerignore`), and its patterns are relative to the repo root.
- The top-level `name: imgy` keeps the Compose project name from becoming `docker`.

The image installs the locked dependencies into `/app/.venv` (on `PATH`) with uv, which is mounted for that step and not kept. It starts as root; `docker/entrypoint.sh` chowns `/data` to `PUID:PGID` and drops privileges with `gosu` before starting gunicorn. The compose file publishes port 5000 on `127.0.0.1`.

## Things that must change together

- **Tag expressions.** The table in [README.md](README.md) describes what each token does in the tag
  editor, the bulk tag editor, and the filter bar. Changing how `tags.js`, `filters.js`, `flyup.js`,
  or `selection.js` read a token means updating that table.
- **Settings.** A new setting needs its key in `ALLOWED_SETTINGS_KEYS` (`api/settings.py`) and its
  control in `settings.js` and `index.html`. A new environment variable goes in the README table.
- **Screenshots.** [README.md](README.md) shows two screenshots from [assets/](assets/). A redesign
  of the gallery or the lightbox means retaking them.
- **The README feature list and layout.** A user-visible feature means checking the README's feature
  list; a new module or folder means checking the Architecture table above.
