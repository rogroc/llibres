# Guia d'Instal·lació i Dependències de Llibreviu a Windows

Aquesta guia detalla com preparar un entorn Windows des de zero perquè tot el sistema de sincronització, lector de codis QR, càmera mòbil i integració amb la intranet funcioni correctament.

---

## 📋 1. Instal·lació de Python (El Servidor Local)

El servidor de sincronització està escrit en **Python 3**. Està dissenyat utilitzant exclusivament llibreries de la biblioteca estàndard de Python, per la qual cosa **no cal instal·lar paquets addicionals amb pip**.

### Passos per instal·lar Python:
1. Descarregueu el darrer instal·lador de Python 3 des de la pàgina oficial: [python.org/downloads](https://www.python.org/downloads/) (es recomana Python 3.10 o superior).
2. Executeu l'instal·lador descarregat.
3. **MOLT IMPORTANT:** A la part inferior de la primera finestra de l'instal·lador, marqueu la casella que diu **"Add python.exe to PATH"** (o "Afegir python al PATH"). Si no ho feu, la comanda `python` no funcionarà des del terminal.
4. Cliqueu a **"Install Now"** i finalitzeu la instal·lació.
5. Per verificar que s'ha instal·lat correctament, obriu una finestra de la línia d'ordres de Windows (`CMD`) i executeu:
   ```cmd
   python --version
   ```
   Hauria de mostrar la versió instal·lada (ex: `Python 3.12.x`).

---

## 🔌 2. Instal·lació i Configuració de l'Extensió de Chrome

L'extensió és la que rep les dades en temps real del mòbil i les injecta de manera intel·ligent al formulari de registre de la intranet de Llibreviu.

### Passos per carregar l'extensió:
1. Obriu **Google Chrome**.
2. Aneu a l'adreça: `chrome://extensions/`
3. Activeu el **Mode desenvolupador** (Developer mode) commutan el selector de la cantonada superior dreta.
4. Cliqueu al botó **Carrega l'extensió sense empaquetar** (Load unpacked) a la cantonada superior esquerra.
5. Seleccioneu la carpeta anomenada `extension` que es troba dins del directori d'aquest projecte.
6. Un cop carregada, es recomana **fixar** la icona de l'extensió (Llibreviu Sync) a la barra d'eines de Chrome fent clic a la icona del trencaclosques.

### Configuració de la clau de l'API de Gemini (Traducció automàtica):
L'extensió tradueix les matèries del castellà/anglès al català utilitzant IA. Perquè funcioni:
1. Cliqueu sobre la icona de l'extensió a la barra de Chrome.
2. Introduïu la vostra clau de l'API de Gemini (`API Key`).
3. Cliqueu a **Desa**.

---

## 🔐 3. Dependències de Seguretat (Certificats SSL / HTTPS)

Perquè la càmera del telèfon mòbil funcioni, el navegador mòbil exigeix obligatòriament una connexió segura (**HTTPS**). El servidor local ja inclou fitxers de certificats autofirmats (`key.pem` i `cert.pem`).

### A. Acceptar el certificat al mòbil (Pas Obligatori):
Com que el certificat és autofirmat pel vostre ordinador, el telèfon mòbil donarà un avís de seguretat la primera vegada:
1. Trobeu la IP local del vostre ordinador (el lector d'escriptori `http://localhost:8080/desktop/` us la mostrarà en pantalla, ex: `192.168.1.42`).
2. Des del navegador del telèfon mòbil (Safari, Chrome, etc.), visiteu la URL HTTPS de l'API:
   ```text
   https://[IP_DEL_VOSTRE_ORDINADOR]:8443/api/ip
   ```
   *(Exemple real: `https://192.168.1.42:8443/api/ip`)*
3. El mòbil mostrarà un avís de seguretat ("Connexió no segura").
4. Cliqueu a **Configuració avançada** i seleccioneu **Accedir-hi de totes maneres** (o "Permetre excepció").
5. Si veieu un missatge de text que indica la vostra IP, el mòbil ja confia en el servidor local de l'ordinador i la càmera funcionarà perfectament.

### B. Regeneració de certificats (Opcional):
Si mai voleu regenerar els certificats a Windows, necessitareu la utilitat `openssl`. 
La manera més senzilla d'obtenir-la és instal·lant **Git per a Windows**:
1. Descarregueu Git des de [git-scm.com](https://git-scm.com/download/win).
2. Durant la instal·lació, assegureu-vos que s'instal·len les eines de consola (Git Bash).
3. Obriu el terminal de **Git Bash** dins la carpeta `app` i executeu per generar noves claus vàlides per a 10 anys:
   ```bash
   openssl req -new -x509 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=localhost"
   ```

---

## 🚀 4. Com Iniciar l'Aplicació

Un cop fets els passos anteriors, ja ho teniu tot a punt:

1. Obriu la carpeta del projecte i entreu a la subcarpeta `app`.
2. Fes doble clic sobre el fitxer **`start_app.bat`**.
3. S'obrirà la línia d'ordres de Windows (`CMD`) que mantindrà el servidor actiu (no la tanqueu).
4. Automàticament, s'obriran dues pestanyes a Google Chrome:
   - La intranet real de Llibreviu (`https://www.llibreviu.org/admin/registre/`) on s'ompliran les dades.
   - El terminal/lector d'escriptori (`http://localhost:8080/desktop/`) que us mostrarà el codi QR per escanejar des del mòbil i començar a introduir llibres.
