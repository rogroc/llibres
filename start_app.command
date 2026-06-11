#!/bin/bash

# Ens assegurem d'estar a la carpeta on és aquest fitxer
cd "$(dirname "$0")"

echo "=========================================="
echo "      Iniciant BiblioScan Localment       "
echo "=========================================="
echo ""

# Tancar qualsevol servidor anterior que estigui ocupant el port 8000
echo "Netejant sessions anteriors..."
lsof -ti:8000 | xargs kill -9 2>/dev/null

echo "S'està iniciant el servidor..."

# Obrim el navegador automàticament passats 2 segons
(sleep 2 && open "http://localhost:8000") &

# Iniciem el servidor python
python3 server.py
