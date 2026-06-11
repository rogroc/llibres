# BiblioScan - Lector de Codi ISBN i Codis de Barres en Temps Real

BiblioScan és una aplicació web dissenyada per escanejar codis de barres (EAN-13) o el text imprès de l'ISBN d'un llibre directament des de la càmera del mòbil o ordinador, sense haver de fer fotos ni enviar dades. Detecta automàticament el codi i recupera instantàniament tota la informació del llibre (títol, autors, editorial, any, sinopsi i portada) des de les bases de dades de Google Books i Open Library.

## Característiques principals

- **Escaneig Dual:** Detecció instantània de codis de barres EAN-13 i lectura de text imprès de l'ISBN via OCR (Tesseract.js).
- **Processament Local:** Tot l'anàlisi d'imatges es fa directament al dispositiu, sense enviar fluxos de vídeo a cap servidor.
- **Multicanal de Cerca:** Consulta paral·lela a Google Books i Open Library per oferir la millor informació disponible.
- **Historial de cerques:** Guarda automàticament els llibres escanejats localment (`localStorage`) perquè puguis revisar-los quan vulguis.
- **Interfície Premium:** Disseny modern de tipus *glassmorphism*, apte per a mòbils, amb indicadors visuals de càrrega, so de confirmació ("beep") i vibració hàptica.
- **Soport de Llanterneta (Torch):** Permet activar la llum del mòbil directament des de l'app si el dispositiu ho admet.

## Com executar l'aplicació localment

Necessitaràs tenir instal·lat **Node.js** al teu sistema.

1. **Instal·lar les dependències:**
   Obre la terminal a la carpeta del projecte i executa:
   ```bash
   npm install
   ```

2. **Iniciar el servidor de desenvolupament:**
   Executa la següent comanda:
   ```bash
   npm run dev
   ```

3. **Accedir des de l'ordinador:**
   Obre el teu navegador a:
   [https://localhost:5173](https://localhost:5173)

4. **Accedir des del mòbil (Molt important per provar la càmera):**
   Perquè la càmera del mòbil funcioni, els navegadors mòbils exigeixen una connexió segura (HTTPS). Per aquest motiu, el projecte ve configurat amb un connector de certificats SSL auto-signats.
   
   A la terminal on has iniciat el servidor, veuràs una adreça de xarxa local (per exemple, `https://192.168.1.42:5173`).
   - Obre aquesta adreça `https` al teu mòbil (ambdós dispositius han d'estar connectats a la mateixa xarxa Wi-Fi).
   - El teu navegador mòbil mostrarà un avís de seguretat ("La connexió no és privada" o similar) perquè el certificat SSL és auto-signat.
   - Prem a **"Avançat"** i després selecciona **"Accedir a... (no segur)"** o **"Continuar"**.
   - Accepta el permís per utilitzar la càmera.

## Com utilitzar l'aplicació

1. **Selecció del Mode:**
   - **Auto (recomanat):** Cerca tant codis de barres com text imprès de l'ISBN simultàniament.
   - **Codi de Barres:** Es focalitza únicament en el codi de barres del llibre (EAN-13), el qual és extremadament ràpid.
   - **Llegir ISBN (OCR):** Ideal per a llibres vells o llocs del llibre on només hi ha el text imprès com "ISBN 978-84-..." sense codi de barres.

2. **Detecció:**
   - Col·loca el codi o el text dins del rectangle de detecció verd del centre.
   - En el moment que es detecti un codi vàlid (validat pel dígit de control/checksum de l'ISBN), el mòbil vibrarà, sonarà un "beep", aturarà l'escaneig i mostrarà la fitxa del llibre.

3. **Accions sobre la fitxa del llibre:**
   - Pots copiar els codis ISBN-10 o ISBN-13 al portapapers fent clic a la icona de còpia.
   - Fes clic a les bases de dades externes (Google Books o Open Library) per veure la seva pàgina de referència original.
   - Prem "Escanejar un altre llibre" per tornar a obrir el visor.

4. **Historial:**
   - A la part inferior es llisten les teves cerques anteriors. Pots tornar-les a obrir fent-hi clic, o esborrar-les si ho desitges.
