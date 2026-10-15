#!/usr/bin/env bash
# Instalación de Caudal en el VPS. Se corre UNA vez, con sudo, después de subir la semilla:
#   sudo DOMAIN=caudal.ejemplo.org bash ~/caudal-seed/app/deploy/install-root.sh
#
# Qué hace (y nada más):
#   1. instala Node.js desde apt si falta (Ubuntu 24.04 trae 18.x, alcanza)
#   2. crea el usuario de sistema "caudal", sin shell ni login
#   3. /opt/caudal/app  → el código, del usuario de deploy (se actualiza sin sudo)
#      /opt/caudal/data → datos y cachés, solo del servicio
#   4. servicio systemd endurecido, escuchando solo en 127.0.0.1:8787
#   5. regla de sudo ACOTADA: el usuario de deploy puede reiniciar caudal y ver su estado, nada más
#   6. agrega el sitio a Caddy (con respaldo; si la config no valida, la restaura) y lo recarga.
#      Si Caddy corre sin API de administración ("admin off"), la recarga falla y se reinicia.
set -euo pipefail

DOMAIN=${DOMAIN:?definir DOMAIN, el dominio del sitio (p. ej. DOMAIN=caudal.ejemplo.org)}
PORT=8787
DEPLOY_USER=${SUDO_USER:?correrlo con sudo desde el usuario de deploy}
SEED=/home/$DEPLOY_USER/caudal-seed
BASE=/opt/caudal
CF=/etc/caddy/Caddyfile

[ "$(id -u)" = 0 ] || { echo "Hay que correrlo con sudo."; exit 1; }
[ -d "$SEED/app" ] || { echo "No encuentro $SEED/app: primero hay que subir la semilla."; exit 1; }

echo "── 1/6 Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "   node $(node --version)"

echo "── 2/6 usuario de servicio"
id caudal >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin caudal
echo "   $(id caudal)"

echo "── 3/6 directorios"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$BASE"
if [ ! -d "$BASE/app" ]; then
  cp -a "$SEED/app" "$BASE/app"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$BASE/app"
fi
install -d -o caudal -g caudal -m 750 "$BASE/data"
if [ -d "$SEED/data" ]; then
  # cachés ya calculadas (climatología, mosaicos, imágenes): evitan volver a pedirlas a las APIs
  cp -a --update=none "$SEED/data/." "$BASE/data/"
  chown -R caudal:caudal "$BASE/data"
fi
du -sh "$BASE/app" "$BASE/data" | sed 's/^/   /'

echo "── 4/6 servicio systemd"
cat > /etc/systemd/system/caudal.service <<EOF
[Unit]
Description=Caudal: monitor de los ríos Paraná y Uruguay ($DOMAIN)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=caudal
Group=caudal
WorkingDirectory=$BASE/app
ExecStart=/usr/bin/node $BASE/app/server.mjs
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$BASE/data
Environment=TRUST_PROXY=1
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=$BASE/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now caudal
systemctl restart caudal
sleep 3
systemctl is-active caudal | sed 's/^/   servicio: /'

echo "── 5/6 permiso acotado para deploys"
cat > /etc/sudoers.d/caudal <<EOF
# $DEPLOY_USER puede reiniciar Caudal y ver su estado sin contraseña. Comandos exactos, sin comodines
# (un paginador abierto como root permitiría escapar a una shell: por eso --no-pager).
$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart caudal, /usr/bin/systemctl status caudal --no-pager, /usr/bin/journalctl -u caudal --no-pager -n 100
EOF
chmod 440 /etc/sudoers.d/caudal
visudo -cf /etc/sudoers.d/caudal

echo "── 6/6 Caddy"
if grep -qE "^$DOMAIN[[:space:]]*\{" "$CF"; then
  echo "   $DOMAIN ya estaba en $CF: no lo toco"
else
  BAK="$CF.bak-caudal-$(date +%Y%m%d-%H%M%S)"
  cp -a "$CF" "$BAK"
  cat >> "$CF" <<EOF

# Caudal: monitor de los ríos Paraná y Uruguay (la app escucha solo en localhost).
# Node ya comprime (brotli/gzip) y maneja caché/ETag: acá solo encabezados de seguridad y proxy.
$DOMAIN {
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		X-Frame-Options DENY
		Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()"
		Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
		-Server
	}
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  if caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    echo "   sitio agregado; respaldo en $BAK"
  else
    cp -a "$BAK" "$CF"
    echo "   ¡la config nueva no validó! restauré $BAK y no reinicié Caddy"
    exit 1
  fi
fi

echo "── listo"
curl -fsS "http://127.0.0.1:$PORT/health" | head -12 || echo "   (el servicio todavía está arrancando; probá en un minuto)"
echo "   Si el DNS de $DOMAIN ya apunta a este servidor, Caddy obtiene el certificado solo."
