#!/bin/bash

# Ens assegurem d'estar a la carpeta on és aquest fitxer
cd "$(dirname "$0")"

echo "=========================================="
echo "      Iniciant Llibreviu App Localment    "
echo "=========================================="
echo ""

# Tancar qualsevol servidor anterior que estigui ocupant els ports 8080 o 8443
echo "Netejant sessions anteriors..."
lsof -t -i :8080 -i :8443 | xargs kill -9 2>/dev/null

echo "S'està iniciant el servidor..."

# Obrim el navegador automàticament passats 2 segons
(sleep 2 && open "http://localhost:8080/desktop/") &

# Iniciem el servidor python
python3 server.py
