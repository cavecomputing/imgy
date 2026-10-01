# Imgy

A local-first image and video organizer. Tag, search, favorite, group, and rename your media from the browser, with optional auto-tagging by a vision LLM. Built with Flask, SQLite, and plain JavaScript (no build step).

- Fast tag editing with a small expression syntax (`+new`, `-remove`, `old>new`, ...)
- Filter by tags, exclusions, favorites, or untagged files
- Lightbox with zoom, pan, pinch, and swipe; plays common video formats
- Bulk selection: tag, favorite, group, download as ZIP, or move to trash
- Trash with restore, inline rename, drag-and-drop upload
- Keyboard-driven: press `?` in the app for every shortcut
- Optional LLM auto-tagger (Ollama, OpenRouter, or any OpenAI-compatible endpoint)

> **There is no authentication.** Anyone who can reach the server can view, change, and delete your files, and can read the LLM API key from the settings. Keep it on `localhost` or a trusted network, or put it behind an authenticating reverse proxy.

## Quick start

### Docker

```bash
cd docker
docker compose up --build -d
```

Open http://localhost:8000. Media and the database live in `data/` at the root of the repo. The container runs as UID/GID 1000 by default; to match your host user:

```bash
PUID=$(id -u) PGID=$(id -g) docker compose up --build -d
```

Run compose commands from `docker/`, or from the repo root with `-f docker/docker-compose.yml`. A `.env` file for these variables goes in `docker/` too.

The compose file publishes on `127.0.0.1` only. To reach it another way, change `ports` in `docker/docker-compose.yml` and set `ALLOWED_HOSTS` to the name or address you'll use.

### Without Docker

Requires [uv](https://docs.astral.sh/uv/) and `ffmpeg` (for video thumbnails). On first run, uv sets up Python 3.11+ and the locked dependencies in `.venv`.

```bash
uv run app.py                                                             # development server
uv run gunicorn --bind 127.0.0.1:8000 --workers 4 --timeout 120 app:app   # production
```

Both serve http://localhost:8000 and only accept connections from the same machine. Binding gunicorn to `0.0.0.0` exposes the app to your whole network, and you'll also need `ALLOWED_HOSTS`.

## Your data

```
data/
├── images/            # your media; subfolders are fine
│   ├── .thumbnails/   # generated thumbnails
│   └── .trash/        # files moved to trash
└── database.db        # tags, favorites, groups, settings
```

The folder is the source of truth: files you copy into `data/images/` show up on the next refresh, and the database only holds metadata about them. Supported types are PNG, JPEG, GIF, WebP, and BMP images and MP4, WebM, MOV, MKV, AVI, and M4V videos. Hidden folders (names starting with `.`), symlinks, and top-level files whose names start with `trash:` are skipped.

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `./data` | Where media and the database are stored |
| `PUID` / `PGID` | `1000` | File owner inside the Docker container |
| `ALLOWED_HOSTS` | | Host names or IPv4 addresses the app answers to besides `localhost`, comma-separated (for example `photos.lan,192.168.1.20`). A leading dot allows subdomains |

Set `ALLOWED_HOSTS` whenever you reach the app by anything other than `localhost`. Requests for other host names are refused, so a website can't point its own domain at your machine and read your library and API key through your browser (DNS rebinding). `*` turns that check off.

Behind a reverse proxy, pass the browser's Host header through unchanged, including the port, and list that name. Caddy and Traefik do this by default; for nginx add `proxy_set_header Host $http_host;`. A proxy that replaces the Host header hides the name from the app, so the DNS rebinding check can't work, and over plain HTTP every change is refused as cross-site.

Uploads are limited to 500 MB per request.

## Tag expressions

Type expressions in the tag editor (`T` on an image), the bulk tag editor (`T` with files selected), or the search bar. Separate several with spaces.

| Expression | Tag editor | Bulk tag editor | Search bar |
|---|---|---|---|
| `tag` | Add an existing tag | Add to every selected file | Show files with the tag |
| `+tag` | Create and add | Create and add to every selected file | Create the tag |
| `-tag` | Remove | Remove from selected files | Hide files with the tag |
| `--tag` | | | Delete the tag everywhere |
| `old>new` | Rename on this file | Rename on selected files | Rename everywhere |
| `--` | Remove all tags | Remove all tags from selected files | Delete unused tags |
| `=` | | Give every selected file all their tags | |
| `++` | | Group the selected files | |
| `?` | Auto-tag with the LLM | Auto-tag selected files with the LLM | |

`Tab` completes the tag you are typing. Destructive search-bar actions ask for confirmation.

## LLM auto-tagging

Imgy can suggest a filename and tags for an image using any OpenAI-compatible chat completions API with vision support. Videos are not supported.

1. Run a vision model, for example with [Ollama](https://ollama.com/): `ollama pull gemma3`.
2. Open settings with `?`, choose the provider, endpoint, and model, and click **Test Connection**. OpenRouter needs an API key.
3. Type `?` in a tag editor, or click the cloud button in the lightbox. Suggestions are applied right away; the **Rename** and **Tag** checkboxes control which.

Once your library has tags, the model may only pick from existing tags. **Exclusive tag groups** limit it to one tag from a set (for example `day`, `night`).

With Docker, `localhost` in the endpoint means the container, not your computer. To reach Ollama on the host, use `http://host.docker.internal:11434/v1/chat/completions`, start Ollama with `OLLAMA_HOST=0.0.0.0`, and on Linux add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service in `docker/docker-compose.yml`.

## Development

```
app.py                # entry point (creates the Flask app)
pyproject.toml        # dependencies, locked in uv.lock
docker/               # Dockerfile, compose file, and entrypoint
imgy/
├── __init__.py       # create_app()
├── config.py         # paths and limits
├── db.py             # SQLite schema and helpers
├── media.py          # path safety, file walking, dimensions
├── thumbnails.py     # thumbnail generation
├── trash.py          # soft delete and restore
├── catalog.py        # cached /api/images listing
├── llm.py            # LLM client and prompt
├── views.py          # page, media, and thumbnail routes
├── api/              # one Flask blueprint per resource, mounted at /api
├── templates/        # index.html
└── static/
    ├── style.css
    └── js/           # ES modules, entry point main.js
```

There is no test suite or build step. After a change, check syntax and then try the affected workflow in the browser:

```bash
uv run python -m compileall -q app.py imgy
for f in imgy/static/js/*.js; do node --input-type=module --check < "$f" || echo "$f"; done
```

Change dependencies with `uv add` or `uv remove` and commit the updated `uv.lock`; the Docker build installs from it.

See [CLAUDE.md](CLAUDE.md) for the conventions that are easy to miss.
