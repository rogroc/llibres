#!/bin/bash

# Ens assegurem de canviar al directori on es troba aquest script
cd "$(dirname "$0")"

echo "=========================================="
echo "      Iniciant Llibreviu App (Mixt)       "
echo "=========================================="
echo ""
echo "Aquest script iniciarà el servidor local i obrirà l'aplicació"
echo "i la intranet de Llibreviu al vostre navegador Google Chrome."
echo ""
echo "⚠️  NOTA IMPORTANT LA PRIMERA VEGADA:"
echo "A la pestanya 'localhost' de la finestra del cercador, si us surt"
echo "un avís de seguretat, feu clic a 'Configuració avançada'"
echo "i després a 'Procedir a localhost (no segur)' perquè tot funcioni."
echo ""
echo "💡 CONSELL PER A PANTALLA PARTIDA:"
echo "Per treballar còmodament, poseu el cursor sobre el botó verd de"
echo "maximitzar de Chrome i trieu 'Ajustar ventana a la izquierda'."
echo "Després, seleccioneu la intranet per posar-la a la dreta."
echo ""

# Tancar qualsevol servidor anterior que estigui ocupant els ports 8080 o 8443
echo "Netejant sessions anteriors..."
lsof -t -i :8080 -i :8443 | xargs kill -9 2>/dev/null

echo "S'està iniciant el servidor local de sincronització..."
# Iniciem el servidor python en segon pla
/usr/bin/python3 server.py &
SERVER_PID=$!

# Obtenim la ruta absoluta de la intranet de llibreviu
cd ..
PROJECT_ROOT="$(pwd)"
INTRANET_PATH="${PROJECT_ROOT}/intranet/afegir_registres.html"

# Obrim les pestanyes de Chrome de forma normal passats 2 segons
echo "Obrint aplicacions a Google Chrome..."
(
sleep 2

# Obrim el lector (GitHub) i la validació de localhost en pestanyes
open -a "Google Chrome" "https://rogroc.github.io/llibres/app/desktop/" "https://localhost:8443/api/sync-poll"

# Obrim la intranet en una pestanya del mateix Chrome de l'usuari
open -a "Google Chrome" "file://${INTRANET_PATH}"
) &

# Esperem que el servidor local s'estigui executant per no finalitzar l'script
wait $SERVER_PID
