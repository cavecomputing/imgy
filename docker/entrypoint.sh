#!/bin/sh

mkdir -p /data/images/.thumbnails /data/images/.trash

# If running as root, fix /data ownership and re-exec as the target user
if [ "$(id -u)" = "0" ]; then
    TARGET_UID="${PUID:-1000}"
    TARGET_GID="${PGID:-1000}"
    chown -R "${TARGET_UID}:${TARGET_GID}" /data
    exec gosu "${TARGET_UID}:${TARGET_GID}" "$@"
fi

exec "$@"
