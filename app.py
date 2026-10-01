"""Imgy entry point.

Development: uv run app.py  (or: uv run flask run)
Production:  uv run gunicorn --bind 127.0.0.1:8000 --workers 4 --timeout 120 app:app

Both listen on localhost only. There is no login, so read the README before exposing it.
"""
from imgy import create_app

app = create_app()

if __name__ == '__main__':
    app.run(debug=False, host='127.0.0.1', port=8000, threaded=True)
