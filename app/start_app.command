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
echo "⚠️  NOTA IMPORTANT PER AL MÒBIL (només per al mode local directe):"
echo "Si feu servir la connexió local per Wi-Fi directe, el navegador del mòbil"
echo "pot bloquejar la càmera o donar error de connexió fins que entreu un cop"
echo "a la URL HTTPS de l'ordinador (ex: https://192.168.1.XX:8443/api/ip) des del"
echo "telèfon i accepteu/ignoreu l'avís de seguretat (Configuració avançada)."
echo ""
echo "💡 ALTERNATIVA MÉS SENZILLA (Públic ntfy.sh):"
echo "Si no voleu configurar certificats al mòbil, canvieu a la pestanya"
echo "'Públic' al catàleg desktop. Funcionarà a l'instant a través d'Internet!"
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
# Iniciem el servidor python en segon pla buscant python3 al PATH de l'usuari
python3 server.py &
SERVER_PID=$!

# Obtenim la ruta absoluta de la intranet de llibreviu
cd ..
PROJECT_ROOT="$(pwd)"
INTRANET_PATH="${PROJECT_ROOT}/intranet/afegir_registres.html"
cd app # Retornem al directori d'execució original

# Obrim les pestanyes de Chrome de forma normal passats 2 segons
echo "Obrint aplicacions a Google Chrome..."
(
sleep 2

# Obrim el lector (GitHub)
open -a "Google Chrome" "https://rogroc.github.io/llibres/app/desktop/"

# Esperem 1 segon per evitar col·lisions si Chrome s'inicia de zero
sleep 1

# Obrim la intranet en una pestanya del mateix Chrome de l'usuari
open -a "Google Chrome" "file://${INTRANET_PATH}"
) &

# Esperem que el servidor local s'estigui executant per no finalitzar l'script
wait $SERVER_PID
