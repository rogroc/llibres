#!/bin/bash
cd "$(dirname "$0")"
echo "========================================="
echo "   Iniciant servidor públic a Internet   "
echo "========================================="
echo "📱 Aquest mode enganyarà al mòbil fent-li creure"
echo "que és una App oficial en un domini segur!"
echo ""
echo "1. S'està arrencant l'aplicació..."
python3 -m http.server 8080 > /dev/null 2>&1 &
SERVER_PID=$!

sleep 1

echo "2. Obrint el túnel a Internet..."
echo ""
echo "👉 PREN NOTA: Quan aparegui un text que digui 'your url is: https://...'"
echo "Obre aquesta URL exacta al teu mòbil!"
echo "--------------------------------------------------------"
npx localtunnel --port 8080

kill $SERVER_PID
