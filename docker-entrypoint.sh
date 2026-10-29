#!/bin/sh
set -u

printf '[yt-dlp] Versión antes de actualizar: %s\n' "$(yt-dlp --version 2>/dev/null || printf 'desconocida')"
if ! yt-dlp -U; then
  printf '%s\n' '[yt-dlp] No se pudo actualizar; se utilizará la versión incluida en la imagen.' >&2
fi
printf '[yt-dlp] Versión activa: %s\n' "$(yt-dlp --version 2>/dev/null || printf 'desconocida')"

exec node dist/server.js
