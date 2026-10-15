#!/usr/bin/env bash
# Deploy de una versión nueva al VPS (sin sudo: usa la regla acotada de install-root.sh).
#   SSH_HOST=mi-servidor bash deploy/deploy.sh   # desde WSL o Git Bash, en la carpeta del proyecto
# Sube el código a /opt/caudal/app.new, lo cambia por el actual (queda app.prev para volver
# atrás) y reinicia el servicio. Los datos y cachés de /opt/caudal/data no se tocan.
set -euo pipefail
SSH_HOST=${SSH_HOST:?definir SSH_HOST, el alias SSH del servidor}
cd "$(dirname "$0")/.."

FILES="server.mjs analytics.mjs sources public scripts stations.json data/stations.calibrated.json data/umbrales.json deploy README.md"
echo "subiendo a $SSH_HOST…"
tar czf - $FILES | ssh "$SSH_HOST" '
  set -e
  cd /opt/caudal
  rm -rf app.new && mkdir app.new && tar xzf - -C app.new
  rm -rf app.prev && mv app app.prev && mv app.new app
  sudo -n /usr/bin/systemctl restart caudal
  sleep 3
  curl -fsS http://127.0.0.1:8787/health | head -8
'
echo "listo. Para volver atrás: ssh $SSH_HOST \"cd /opt/caudal && mv app app.bad && mv app.prev app && sudo -n /usr/bin/systemctl restart caudal\""
