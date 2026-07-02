@echo off
:: Ens assegurem de canviar al directori on es troba aquest script
cd /d "%~dp0"

echo ==========================================
echo       Iniciant Llibreviu App (Windows)   
echo ==========================================
echo.
echo Aquest script iniciarà el servidor local i obrirà l'aplicació
echo i la intranet de Llibreviu al vostre navegador Google Chrome.
echo.
echo ⚠️  NOTA IMPORTANT PER AL MÒBIL (només per al mode local directe):
echo Si feu servir la connexió local per Wi-Fi directe, el navegador del mòbil
echo pot bloquejar la càmera o donar error de connexió fins que entreu un cop
echo a la URL HTTPS de l'ordinador (ex: https://192.168.1.XX:8443/api/ip) des del
echo telèfon i accepteu/ignoreu l'avís de seguretat (Configuració avançada).
echo.

:: Tancar qualsevol servidor anterior que estigui ocupant els ports 8080 o 8443
echo Netejant sessions anteriors...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 2^>nul') do taskkill /F /PID %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8443 2^>nul') do taskkill /F /PID %%a 2>nul

echo S'està iniciant el servidor local de sincronització...
:: Iniciem el servidor python en segon pla
start /b python server.py

:: Obrim les pestanyes de Chrome de forma normal passats 2 segons
echo Obrint aplicacions a Google Chrome...
timeout /t 2 /nobreak >nul

:: Obrim la pàgina de registre de la intranet real
start chrome "https://www.llibreviu.org/admin/registre/"

