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
# Iniciem el servidor python en segon pla buscant python3 al PATH de l'usuari (fem servir /usr/bin/python3 que està al tallafocs)
/usr/bin/python3 server.py &
SERVER_PID=$!

# Obrim la pàgina de Llibreviu a Google Chrome passats 2 segons
echo "Obrint la intranet de Llibreviu a Google Chrome..."
(
sleep 2
open -a "Google Chrome" "https://www.llibreviu.org/admin/registre/"
) &

# Esperem que el servidor local s'estigui executant per no finalitzar l'script
wait $SERVER_PID
