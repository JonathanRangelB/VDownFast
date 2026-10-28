#!/bin/sh
yt-dlp -U >/dev/null 2>&1 || true
exec node dist/server.js
