#!/bin/sh

mkdir -p /data/images/.thumbnails /data/images/.trash

# If running as root, fix /data ownership and re-exec as the target user
if [ "$(id -u)" = "0" ]; then
    TARGET_UID="${PUID:-1000}"
    TARGET_GID="${PGID:-1000}"
    # Only what isn't owned right already, so a restart doesn't walk and rewrite a whole library
    find /data \( \! -user "$TARGET_UID" -o \! -group "$TARGET_GID" \) -exec chown "${TARGET_UID}:${TARGET_GID}" {} +
    exec gosu "${TARGET_UID}:${TARGET_GID}" "$@"
fi

exec "$@"
