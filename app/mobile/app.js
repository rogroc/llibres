// Send errors to python server for debugging
window.onerror = function(message, source, lineno, colno, error) {
  const errInfo = `${message} at ${source}:${lineno}:${colno}`;
  sendToServer('error', errInfo);
  return false;
};

window.addEventListener('unhandledrejection', function(event) {
  const errInfo = `Unhandled Promise Rejection: ${event.reason}`;
  sendToServer('error', errInfo);
});

// Setup console logging redirection to debug panel and python server
let debugContent = null;
let debugLogEl = null;

function addDebugLog(msg, type = 'log') {
  if (!debugContent) {
    debugContent = document.getElementById('debug-log-content');
    debugLogEl = document.getElementById('debug-log');
  }
  const color = type === 'error' ? '#ff3333' : type === 'warn' ? '#ffcc00' : '#00ffcc';
  if (debugContent) {
    const line = document.createElement('div');
    line.style.color = color;
    line.style.borderBottom = '1px solid #222';
    line.style.padding = '2px 0';
    line.style.whiteSpace = 'pre-wrap';
    line.style.wordBreak = 'break-all';
    line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    debugContent.appendChild(line);
    if (debugLogEl) {
      debugLogEl.scrollTop = debugLogEl.scrollHeight;
    }
  }
  // Send to server (evitem saturar amb logs de Tesseract de progrés continu)
  const isSpammyLog = msg.includes('[Tesseract]') || 
                      msg.includes('recognizing text') || 
                      msg.includes('loading tesseract') || 
                      msg.includes('initializing tesseract');
  if (!isSpammyLog) {
    sendToServer('log', `[${type}] ${msg}`);
  }
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = function(...args) {
  originalLog.apply(console, args);
  addDebugLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'log');
};
console.warn = function(...args) {
  originalWarn.apply(console, args);
  addDebugLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'warn');
};
console.error = function(...args) {
  originalError.apply(console, args);
  addDebugLog(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), 'error');
};

// ISBN Validation Functions
function isValidISBN10(isbn) {
  isbn = isbn.replace(/[- ]/g, "").toUpperCase();
  if (isbn.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = parseInt(isbn[i], 10);
    if (isNaN(digit)) return false;
    sum += digit * (10 - i);
  }
  let last = isbn[9];
  if (last === 'X') sum += 10;
  else {
    let digit = parseInt(last, 10);
    if (isNaN(digit)) return false;
    sum += digit;
  }
  return sum % 11 === 0;
}

function isValidISBN13(isbn) {
  isbn = isbn.replace(/[- ]/g, "");
  if (isbn.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let digit = parseInt(isbn[i], 10);
    if (isNaN(digit)) return false;
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }
  let last = parseInt(isbn[12], 10);
  if (isNaN(last)) return false;
  let check = (10 - (sum % 10)) % 10;
  return check === last;
}

// Substituïm caràcters visuals que l'OCR confon sovint per dígits
function fixOcrDigits(s) {
  return s
    .replace(/[oO]/g, '0')
    .replace(/[lI|!]/g, '1')
    .replace(/[sS]/g, '5')  // només en contextos de dígits, es fa net posteriorment
    .replace(/[gq]/g, '9')
    .replace(/[bB]/g, '8');
}

// Intenta trobar un ISBN-13 vàlid dins una seqüència de dígits (finestra lliscant)
function findISBN13InDigits(digits) {
  for (let i = 0; i <= digits.length - 13; i++) {
    const candidate = digits.substring(i, i + 13);
    if (/^97[89]/.test(candidate) && isValidISBN13(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Intenta trobar un ISBN-10 vàlid dins una seqüència (finestra lliscant)
function findISBN10InDigits(digits) {
  for (let i = 0; i <= digits.length - 10; i++) {
    const candidate = digits.substring(i, i + 10);
    if (isValidISBN10(candidate)) {
      return candidate;
    }
  }
  // Versió que permet X com a darrer caràcter
  for (let i = 0; i <= digits.length - 10; i++) {
    const candidate = digits.substring(i, i + 9) + 'X';
    if (/^\d{9}X$/.test(candidate) && isValidISBN10(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Extreu tots els dígits i X d'una cadena, corregint errors d'OCR habituals
function extractDigitsAggressive(rawPart) {
  // Primer passada: netegem separadors visuals (guions, punts, espais, barres, cometes)
  let cleaned = rawPart.replace(/[\s\-–—._,;:'"\/\\|()[\]{}]/g, '');
  // Segon: corregim caràcters OCR comuns
  // O→0, l/I/!→1, S→5 SOLO si ja estem en context numèric
  let result = '';
  for (let ch of cleaned.toUpperCase()) {
    if ('0123456789X'.includes(ch)) {
      result += ch;
    } else if (ch === 'O') {
      result += '0';
    } else if (ch === 'L' || ch === 'I' || ch === '!' || ch === '|') {
      result += '1';
    } else if (ch === 'G' || ch === 'Q') {
      result += '9';
    } else if (ch === 'B') {
      result += '8';
      // No corregim S→5 automàticament perquè és massa ambigua fora de context
    }
    // Ignorem qualsevol altra lletra
  }
  return result;
}

// Regex ISBN parsing and checksum validation
function cleanAndValidateISBN(rawText) {
  if (!rawText) return null;
  
  // =========================================================
  // ESTRATÈGIA 0: detecció forçada per prefix ISBN
  // Si el text conté "ISBN" (o errors OCR típics), extreiem
  // de forma molt agressiva tot el que vingui a continuació
  // =========================================================
  const isbnPrefixPat = /(?:isbn|1sbn|is8n|1s8n|isb1n|lsrn|isbln|isbn|lsbn|l5bn|i5bn|15bn|isb|lsb)\s*[:\.\-]?\s*(.{6,40})/i;
  const prefixMatch = rawText.match(isbnPrefixPat);
  if (prefixMatch) {
    const rawAfterPrefix = prefixMatch[1];
    // Extracció agressiva: dígits + correccions d'OCR comunes
    const digits = extractDigitsAggressive(rawAfterPrefix);
    
    if (digits.length >= 10) {
      // Primer intentem ISBN-13 (finestra lliscant)
      const found13 = findISBN13InDigits(digits);
      if (found13) return found13;
      
      // Ara intentem ISBN-10 (finestra lliscant)
      const found10 = findISBN10InDigits(digits);
      if (found10) return found10;
      
      // Si tenim exactament 10 o 13 caràcters, validem directament
      if (digits.length === 13 && isValidISBN13(digits)) return digits;
      if (digits.length === 10 && isValidISBN10(digits)) return digits;
    }
  }
  
  // =========================================================
  // ESTRATÈGIA 1: patrons clàssics amb guions/espais i límits
  // =========================================================
  let matches13 = rawText.match(/\b(?:97[89][\s\-]*)(?:\d[\s\-]*){9}\d\b/gi) || [];
  for (let m of matches13) {
    let d = m.replace(/[^0-9]/g, '');
    if (isValidISBN13(d)) return m.replace(/\s+/g, '');
  }
  
  let matches10 = rawText.match(/\b(?:\d[\s\-]*){9}[\dX]\b/gi) || [];
  for (let m of matches10) {
    let d = m.replace(/[^0-9X]/gi, '').toUpperCase();
    if (isValidISBN10(d)) return m.replace(/\s+/g, '');
  }

  return null;
}

function resolveBaseUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const apiParam = urlParams.get('api');
  let baseUrl = apiParam ? apiParam : '';
  if (!baseUrl && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.'))) {
    baseUrl = window.location.origin;
  }
  return baseUrl;
}

// App Logic
let currentMode = 'isbn'; // 'isbn' or 'portada'
let html5QrCode = null;
let stream = null;
let isTorchOn = false;
let tesseractWorker = null;
let ocrInstance = null;
let isProcessing = false;
let ocrTimeoutId = null;
let isOcrProcessing = false;
let isScannerActive = false;

let relayStreaming = false;
let relayTimerId = null;

async function scheduleRelayFrame() {
  if (!relayStreaming || currentMode !== 'portada') return;
  
  const video = document.getElementById('ocr-video');
  const canvas = document.getElementById('ocr-canvas');
  if (!video || !canvas || video.readyState < 2) {
    relayTimerId = setTimeout(scheduleRelayFrame, 500);
    return;
  }
  
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return; // No local server to stream to
  }
  
  const ctx = canvas.getContext('2d');
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.min(1, 1024 / vw);
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  updateMobileReadability(canvas, ctx);
  
  const quality = 0.85;
  canvas.toBlob(async (blob) => {
    if (blob && relayStreaming && currentMode === 'portada') {
      try {
        await fetch(`${baseUrl}/api/camera-frame`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': blob.size },
          body: blob
        });
      } catch (err) {
        console.warn('Error sending relay frame:', err);
      }
    }
    if (relayStreaming && currentMode === 'portada') {
      relayTimerId = setTimeout(scheduleRelayFrame, 150); // ~6-7 fps
    }
  }, 'image/jpeg', quality);
}

function updateMobileReadability(canvas, ctx) {
  const checkWidth = Math.min(120, canvas.width);
  const checkHeight = Math.min(120, canvas.height);
  const checkX = Math.round((canvas.width - checkWidth) / 2);
  const checkY = Math.round((canvas.height - checkHeight) / 2);
  if (checkX < 0 || checkY < 0) return;
  
  try {
    const imgData = ctx.getImageData(checkX, checkY, checkWidth, checkHeight);
    const data = imgData.data;
    const w = imgData.width;
    const h = imgData.height;
    
    let minGray = 255;
    let maxGray = 0;
    let edgeSum = 0;
    let count = 0;
    
    const grays = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round((data[i] + data[i+1] + data[i+2]) / 3);
      grays[i / 4] = gray;
      if (gray < minGray) minGray = gray;
      if (gray > maxGray) maxGray = gray;
    }
    
    const contrast = maxGray - minGray;
    const statusMsg = document.getElementById('status-message');
    if (contrast < 40) {
      statusMsg.innerHTML = '<span style="color: #ff3333;">⚠️ Sense text o massa fosc (Busca bona llum)</span>';
      return;
    }
    
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        const idx = y * w + x;
        const val = grays[idx];
        const diffX = Math.abs(val - grays[idx + 1]);
        const diffY = Math.abs(val - grays[idx + w]);
        if (diffX > 15 || diffY > 15) {
          edgeSum += (diffX + diffY);
          count++;
        }
      }
    }
    
    const edgeDensity = count / ((w * h) / 4);
    const avgEdgeStrength = count > 0 ? (edgeSum / count) : 0;
    let focusScore = Math.min(100, Math.round((avgEdgeStrength / 50) * 100));
    let densityScore = Math.min(100, Math.round((edgeDensity / 0.16) * 100));
    let score = Math.round((focusScore * 0.6) + (densityScore * 0.4));
    
    if (contrast < 90) {
      score = Math.round(score * (contrast / 90));
    }
    score = Math.max(5, Math.min(99, score));
    
    if (score < 40) {
      statusMsg.innerHTML = `<span style="color: #ff3333;">⚠️ Desenfocat (${score}%) - Mou el mòbil</span>`;
    } else if (score < 75) {
      statusMsg.innerHTML = `<span style="color: #ffcc00;">⚡ Enfocant (${score}%) - Busca bon angle</span>`;
    } else {
      statusMsg.innerHTML = `<span style="color: #00ffcc;">✨ Nitidesa excel·lent (${score}%)! Fes la foto!</span>`;
    }
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', () => {
  const btnStart = document.getElementById('btn-start');
  const overlay = document.getElementById('start-overlay');
  
  const modeIsbn = document.getElementById('mode-isbn');
  const modePortada = document.getElementById('mode-portada');
  const btnTakePhoto = document.getElementById('btn-take-photo');
  
  const btnToggleDebug = document.getElementById('btn-toggle-debug');
  if (btnToggleDebug) {
    btnToggleDebug.addEventListener('click', () => {
      const dbg = document.getElementById('debug-log');
      if (dbg) {
        dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none';
      }
    });
  }

  btnStart.addEventListener('click', async () => {
    overlay.style.display = 'none';
    await initCamera();
    initTesseract();
    
    // Mostrem el botó d'activar/desactivar càmera un cop s'ha iniciat el flux
    const btnToggleCamera = document.getElementById('btn-toggle-camera');
    if (btnToggleCamera) {
      btnToggleCamera.style.display = 'inline-flex';
    }
    updateCameraToggleBtnUI();

    // Envia un ping de connexió immediat
    sendToServer('connection', 'connected');
    
    // Heartbeat molt més espaiat per evitar la limitació de taxa de ntfy.sh (429 Too Many Requests)
    const hasApi = !!(new URLSearchParams(window.location.search).get('api'));
    setInterval(() => {
      sendToServer('connection', 'connected');
    }, hasApi ? 5000 : 45000); // 5s per a local, 45s per a GitHub Pages / ntfy
  });
  
  modeIsbn.addEventListener('click', () => switchMode('isbn'));
  modePortada.addEventListener('click', () => switchMode('portada'));
  
  btnTakePhoto.addEventListener('click', () => processPortada());

  const btnToggleCamera = document.getElementById('btn-toggle-camera');
  if (btnToggleCamera) {
    btnToggleCamera.addEventListener('click', () => toggleCamera());
  }

  const btnFlash = document.getElementById('btn-flash');
  if (btnFlash) {
    btnFlash.addEventListener('click', () => toggleTorch());
  }
});

async function switchMode(mode) {
  currentMode = mode;
  document.getElementById('mode-isbn').classList.toggle('active', mode === 'isbn');
  document.getElementById('mode-portada').classList.toggle('active', mode === 'portada');
  
  document.getElementById('scanner-view').classList.toggle('active', mode === 'isbn');
  document.getElementById('ocr-view').classList.toggle('active', mode === 'portada');
  
  const statusMsg = document.getElementById('status-message');
  
  if (mode === 'isbn') {
    statusMsg.innerText = "Enfoca un codi de barres o el text de l'ISBN";
    await startIsbnScanner();
    if (!tesseractWorker) {
      await initTesseract();
    }
  } else {
    statusMsg.innerText = 'Enfoca la portada i fes una foto';
    await startPortadaCamera();
    // Alliberem el worker de Tesseract d'ISBN per estalviar memòria al mòbil
    if (tesseractWorker) {
      console.log("[Tesseract] Alliberant worker de Tesseract d'ISBN per estalviar memòria...");
      try {
        await tesseractWorker.terminate();
        // Donem un petit respir de 300ms al mòbil perquè es reculli el garbage collection
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.warn("Error alliberant Tesseract:", e);
      }
      tesseractWorker = null;
    }
  }
}

async function initCamera() {
  switchMode('isbn');
}

async function startIsbnScanner() {
  console.log("startIsbnScanner: Iniciant...");
  stopPortadaCamera();
  
  // Resetem el flag de processament perquè el nou escaneig pugui detectar ISBNs
  isProcessing = false;
  isOcrProcessing = false;

  // Avisem l'ordinador que estem a punt per escanejar un nou llibre (ell es reseteja sol)
  sendToServer('reset', '');

  // Sempre creem una instància nova per evitar errors d'estat intern de Html5Qrcode
  if (html5QrCode) {
    try { if (html5QrCode.isScanning) await html5QrCode.stop(); } catch(e) {}
    try { html5QrCode.clear(); } catch(e) {}
    html5QrCode = null;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log("startIsbnScanner: Creant instància Html5Qrcode nova...");
  html5QrCode = new Html5Qrcode("reader");
  
  const formats = window.Html5QrcodeSupportedFormats ? [
    window.Html5QrcodeSupportedFormats.EAN_13,
    window.Html5QrcodeSupportedFormats.EAN_8
  ] : undefined;
  
  console.log("startIsbnScanner: Cridant html5QrCode.start...");
  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      { 
        fps: 10, 
        qrbox: (width, height) => {
          console.log(`qrbox callback: width=${width}, height=${height}`);
          return {
            width: Math.round(width * 0.75),
            height: Math.round(height * 0.35)
          };
        },
        formatsToSupport: formats
      },
      async (decodedText) => {
        console.log("Barcode detectat:", decodedText);
        if (isProcessing) return;
        const isbn = cleanAndValidateISBN(decodedText);
        if (isbn) {
          isProcessing = true;
          document.getElementById('status-message').innerText = '✅ ISBN enviat: ' + isbn + ' — Clica «Encendre Càmera» per llegir un altre.';
          sendToServer('isbn', isbn);
          // Aturem la càmera: l'usuari ha d'engegar-la manualment per llegir el següent
          await stopIsbnScanner();
        }
      },
      (errorMessage) => {}
    );
    
    isScannerActive = true;
    console.log("startIsbnScanner: html5QrCode.start iniciat amb èxit. Cridant runOcrTick...");
    
    setTimeout(updateTorchBtnUI, 200);
    setTimeout(updateTorchBtnUI, 600);
    setTimeout(updateTorchBtnUI, 1200);
    setTimeout(updateTorchBtnUI, 2500);
    updateCameraToggleBtnUI();
    
    // Aplicar zoom de x2 si és compatible amb la càmera del dispositiu
    try {
      const track = html5QrCode.getActiveCameraTrack();
      if (track && typeof track.getCapabilities === 'function') {
        const capabilities = track.getCapabilities();
        if (capabilities.zoom) {
          const targetZoom = Math.min(2, capabilities.zoom.max);
          await track.applyConstraints({
            advanced: [{ zoom: targetZoom }]
          });
          console.log(`Zoom x2 aplicat correctament (valor: ${targetZoom})`);
        } else {
          console.log("El zoom no és compatible amb aquest dispositiu.");
        }
      }
    } catch (zoomErr) {
      console.warn("No s'ha pogut aplicar el zoom:", zoomErr);
    }
    
    runOcrTick();
  } catch (err) {
    console.error("Error startIsbnScanner:", err);
    document.getElementById('status-message').innerText = 'Error càmera ISBN: ' + err;
    updateCameraToggleBtnUI();
  }
}

async function stopIsbnScanner() {
  isScannerActive = false;
  if (ocrTimeoutId) {
    clearTimeout(ocrTimeoutId);
    ocrTimeoutId = null;
  }
  isOcrProcessing = false;
  isTorchOn = false;
  updateTorchBtnUI();
  updateCameraToggleBtnUI();
  if (html5QrCode) {
    try {
      if (html5QrCode.isScanning) {
        await html5QrCode.stop();
      }
    } catch (e) {
      console.warn("stopIsbnScanner: error en aturar:", e);
    }
    try {
      html5QrCode.clear();
    } catch (e) { /* ignorat */ }
    html5QrCode = null;  // Destruïm la instància per evitar "Cannot clear while..."
  }
  // Petit marge perquè el navegador alliberi la càmera completament
  await new Promise(r => setTimeout(r, 300));
}

async function startPortadaCamera() {
  await stopIsbnScanner();
  
  const video = document.getElementById('ocr-video');
  const btnTakePhoto = document.getElementById('btn-take-photo');
  const previewContainer = document.getElementById('ocr-preview-container');
  
  video.style.display = 'block';
  previewContainer.style.display = 'none';
  btnTakePhoto.style.display = 'block';
  btnTakePhoto.disabled = false;
  btnTakePhoto.innerText = "📷 Enviar Portada a l'Ordinador";
  
  try {
    stream = await navigator.mediaDevices.getUserMedia({ 
      video: { 
        facingMode: 'environment',
        width: { ideal: 3840 },
        height: { ideal: 2160 }
      } 
    });
    video.srcObject = stream;
    setTimeout(updateTorchBtnUI, 600);
    updateCameraToggleBtnUI();
    
    // L'enviament en directe s'ha desactivat. Només s'enviarà foto quan es cliqui el botó.
  } catch (err) {
    document.getElementById('status-message').innerText = 'Error càmera Portada: ' + err;
    updateCameraToggleBtnUI();
  }
}

function stopPortadaCamera() {
  relayStreaming = false;
  if (relayTimerId) {
    clearTimeout(relayTimerId);
    relayTimerId = null;
  }
  isTorchOn = false;
  updateTorchBtnUI();
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  const video = document.getElementById('ocr-video');
  video.style.display = 'none';
  document.getElementById('btn-take-photo').style.display = 'none';
  updateCameraToggleBtnUI();
}

async function initTesseract() {
  document.getElementById('status-message').innerText += ' (Carregant OCR...)';
  try {
    // Per a l'ISBN només necessitem anglès ('eng') per llegir dígits, la qual cosa consumeix molt pocs recursos
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status) {
          console.log(`[Tesseract] ${m.status}: ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`);
        }
      }
    });
    console.log("Tesseract Worker (eng) inicialitzat correctament per a ISBN.");
  } catch (err) {
    console.error("Error inicialitzant Tesseract:", err);
  }
  document.getElementById('status-message').innerText = currentMode === 'isbn' ? "Enfoca un codi de barres o el text de l'ISBN" : 'Enfoca la portada i fes una foto';
}

async function processPortada() {
  const video = document.getElementById('ocr-video');
  const canvas = document.getElementById('ocr-canvas');
  const ctx = canvas.getContext('2d');
  
  const MAX_DIMENSION = 3840;
  let w = video.videoWidth || 640;
  let h = video.videoHeight || 480;
  
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
    if (w > h) {
      h = Math.round((h * MAX_DIMENSION) / w);
      w = MAX_DIMENSION;
    } else {
      w = Math.round((w * MAX_DIMENSION) / h);
      h = MAX_DIMENSION;
    }
  }
  
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  
  // Convert to image for preview
  const imgDataUrl = canvas.toDataURL('image/jpeg');
  document.getElementById('ocr-preview').src = imgDataUrl;
  document.getElementById('ocr-preview-container').style.display = 'block';
  video.style.display = 'none';
  
  const btn = document.getElementById('btn-take-photo');
  btn.disabled = true;
  btn.innerText = '📤 Enviant imatge...';
  
  const statusMsg = document.getElementById('status-message');
  statusMsg.innerText = '⚙️ Aplicant filtres de visió artificial...';
  
  try {
    const baseUrl = resolveBaseUrl();
    const isPublicChannel = !baseUrl;

    if (!isPublicChannel) {
      statusMsg.innerText = '📤 Enviant imatge a l\'ordinador...';
      canvas.toBlob(async (blob) => {
        if (!blob) {
          statusMsg.innerText = '❌ Error al processar la imatge.';
          setTimeout(() => { if (currentMode === 'portada') startPortadaCamera(); }, 3000);
          return;
        }
        try {
          const uploadRes = await fetch(`${baseUrl}/api/camera-frame`, {
            method: 'POST',
            headers: { 'Content-Type': 'image/jpeg', 'Content-Length': blob.size },
            body: blob
          });
          if (uploadRes.ok) {
            statusMsg.innerText = '✅ Imatge enviada. Processant a l\'ordinador...';
            await sendToServer('portada-captured', '');
          } else {
            statusMsg.innerText = '❌ Error al pujar la imatge.';
          }
        } catch (err) {
          console.error('Error enviant captura de portada:', err);
          statusMsg.innerText = '❌ Error de connexió: ' + err.message;
        }
        setTimeout(() => {
          if (currentMode === 'portada') startPortadaCamera();
        }, 3000);
      }, 'image/jpeg', 0.95);
      return;
    }

    // 1. Capturem el canvas en escala de grisos per aplicar el filtre local Bradley-Roth
    const numPixels = canvas.width * canvas.height;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    const normalGrays = new Uint8Array(numPixels);
    for (let i = 0; i < numPixels; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      normalGrays[i] = Math.round((r + g + b) / 3);
    }
    
    // 2. Filtre de binarització local d'alt contrast (Bradley-Roth)
    const integralNormal = new Float64Array(numPixels);
    for (let y = 0; y < canvas.height; y++) {
      let sumNormal = 0;
      for (let x = 0; x < canvas.width; x++) {
        const idx = y * canvas.width + x;
        sumNormal += normalGrays[idx];
        if (y === 0) {
          integralNormal[idx] = sumNormal;
        } else {
          integralNormal[idx] = integralNormal[(y - 1) * canvas.width + x] + sumNormal;
        }
      }
    }
    
    const windowSize = Math.max(30, Math.round(canvas.width / 8));
    const halfWin = Math.floor(windowSize / 2);
    const C = 10;
    
    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = canvas.width;
    normalCanvas.height = canvas.height;
    const nCtx = normalCanvas.getContext('2d');
    const nImgData = nCtx.createImageData(canvas.width, canvas.height);
    const nData = nImgData.data;
    
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const idx = y * canvas.width + x;
        const x0 = Math.max(0, x - halfWin);
        const x1 = Math.min(canvas.width - 1, x + halfWin);
        const y0 = Math.max(0, y - halfWin);
        const y1 = Math.min(canvas.height - 1, y + halfWin);
        
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        let sumN = integralNormal[y1 * canvas.width + x1];
        if (y0 > 0) sumN -= integralNormal[(y0 - 1) * canvas.width + x1];
        if (x0 > 0) sumN -= integralNormal[y1 * canvas.width + (x0 - 1)];
        if (x0 > 0 && y0 > 0) sumN += integralNormal[(y0 - 1) * canvas.width + (x0 - 1)];
        
        const avgN = sumN / count;
        const val = (normalGrays[idx] < (avgN - C)) ? 0 : 255;
        const outIdx = idx * 4;
        nData[outIdx] = val;
        nData[outIdx+1] = val;
        nData[outIdx+2] = val;
        nData[outIdx+3] = 255;
      }
    }
    nCtx.putImageData(nImgData, 0, 0);
    const normalUrl = normalCanvas.toDataURL('image/jpeg', 1.0);
    
    statusMsg.innerText = '⚙️ Inicialitzant motor d\'OCR local (spa+cat)...';
    
    // 3. Executem Tesseract al mòbil (spa+cat per a portades)
    const tempWorker = await Tesseract.createWorker('spa+cat', 1, {
      logger: m => {
        if (m && m.status === 'recognizing text') {
          statusMsg.innerText = `🔍 Processant OCR: ${Math.round(m.progress * 100)}%`;
        }
      }
    });
    
    await tempWorker.setParameters({
      tessedit_pageseg_mode: '3',
      preserve_interword_spaces: '1'
    });
    
    statusMsg.innerText = '🔍 Reconeixent lletres de la portada...';
    const { data: ocrResult } = await tempWorker.recognize(normalUrl);
    
    console.log("[Tesseract] Alliberant worker temporal...");
    try {
      await tempWorker.terminate();
    } catch(e) {
      console.warn("Error alliberant worker temporal:", e);
    }
    
    const words = ocrResult.words || [];
    console.log("OCR completat al mòbil. Paraules detectades:", words.map(w => w.text).join(' '));
    
    if (words.length === 0) {
      statusMsg.innerText = '⚠️ No s\'ha trobat cap text a la portada. Enfoca millor.';
      setTimeout(() => {
        if (currentMode === 'portada') startPortadaCamera();
      }, 3000);
      return;
    }

    const allHeights = words.map(w => w.bbox.y1 - w.bbox.y0);
    const maxWordHeight = allHeights.length > 0 ? Math.max(...allHeights) : 0;
    const heightThreshold = maxWordHeight * 0.20;

    const validWords = words.filter(w => 
      (w.bbox.y1 - w.bbox.y0) >= heightThreshold && 
      w.confidence > 40
    );

    if (validWords.length === 0) {
      statusMsg.innerText = '⚠️ Text detectat de baixa qualitat o massa petit.';
      setTimeout(() => {
        if (currentMode === 'portada') startPortadaCamera();
      }, 3000);
      return;
    }

    // Ordenem les paraules de dalt a baix i d'esquerra a dreta per tenir coherència de lectura
    validWords.sort((a, b) => {
      if (Math.abs(a.bbox.y0 - b.bbox.y0) < 15) {
        return a.bbox.x0 - b.bbox.x0;
      }
      return a.bbox.y0 - b.bbox.y0;
    });

    let text = validWords.map(w => w.text).join(' ');

    // Normalització d'artefactes d'OCR
    text = text.replace(/ufia/gi, 'uña')
               .replace(/fio/gi, 'ño')
               .replace(/fia/gi, 'ña')
               .replace(/iriba/gi, 'i riba')
               .replace(/\brba\b/gi, 'riba')
               .replace(/ll['’]?imperí?/gi, "i l'imperi")
               .replace(/il['’]?imperí?/gi, "i l'imperi")
               .replace(/l['’]?imperí?/gi, "l'imperi");
    
    statusMsg.innerText = '✅ Text extret. Enviant...';
    sendToServer('portada', text);
    
    setTimeout(() => {
      if (currentMode === 'portada') startPortadaCamera();
    }, 3000);
    
  } catch (err) {
    console.error("Error OCR local mòbil:", err);
    statusMsg.innerText = '❌ Error OCR: ' + err.message;
    setTimeout(() => {
      if (currentMode === 'portada') startPortadaCamera();
    }, 3000);
  }
}

function showCertWarning(apiUrl) {
  const statusMsg = document.getElementById('status-message');
  statusMsg.innerHTML = `
    <div style="background: #ffebeb; border: 1px solid #ffccd0; padding: 12px; border-radius: 8px; margin: 10px 0; color: #d32f2f; font-size: 0.95rem; text-align: left; line-height: 1.4;">
      <strong>⚠️ Error de certificat SSL:</strong><br>
      El mòbil està bloquejant la connexió segura provisional amb l'ordinador.<br><br>
      <a href="${apiUrl}/api/ip" style="display: block; text-align: center; background: #d32f2f; color: white; padding: 10px; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 5px;">
        Clica aquí per autoritzar el certificat
      </a>
      <span style="font-size: 0.85rem; color: #555; display: block; margin-top: 8px;">
        (Fes clic a <strong>"Configuració avançada"</strong> i després a <strong>"Procedir a..."</strong> o <strong>"Continuar"</strong>. Un cop vegis la IP en pantalla, clica el botó <strong>"Enrere"</strong> del teu navegador per tornar a l'escàner.)
      </span>
    </div>
  `;
}

async function sendToServer(type, value) {
  const urlParams = new URLSearchParams(window.location.search);
  const apiParam = urlParams.get('api');
  const sid = urlParams.get('sid');
  let baseUrl = apiParam ? apiParam : '';
  
  // Si estem en local, usem automàticament l'origen actual per evitar errors de connexió en proves locals
  if (!baseUrl && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.'))) {
    baseUrl = window.location.origin;
  }
  
  let localSuccess = false;
  let ntfySuccess = false;
  
  // 1. Envia al servidor local Python si està configurat i tenim baseUrl
  if (baseUrl) {
    try {
      const res = await fetch(`${baseUrl}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, value })
      });
      localSuccess = res.ok;
    } catch (e) {
      console.warn('Error enviant al servidor local:', e);
    }
  }
  
  // 2. Envia a ntfy.sh com a canal de comunicació universal (NOMÉS per a missatges crítics de control o resultats, no per a logs)
  if (sid && type !== 'log' && type !== 'error') {
    try {
      const res = await fetch(`https://ntfy.sh/llibreviu-sync-${sid}`, {
        method: 'POST',
        body: JSON.stringify({ type, value })
      });
      ntfySuccess = res.ok;
    } catch (e) {
      console.warn('Error enviant a ntfy.sh:', e);
    }
  }
  
  // Si qualsevol de les dues vies té èxit, o si és un tipus no crític (log, error)
  if (localSuccess || ntfySuccess || type === 'log' || type === 'error') {
    const statusMsg = document.getElementById('status-message');
    // Si teníem un missatge d'error o de certificat bloquejat, el netegem quan la connexió funcioni correctament
    if (type === 'connection' && (statusMsg.innerText.includes('Error') || statusMsg.querySelector('div'))) {
      statusMsg.innerText = currentMode === 'isbn' ? "Enfoca un codi de barres o el text de l'ISBN" : 'Enfoca la portada i fes una foto';
    }
    
    if (navigator.vibrate && type !== 'connection' && type !== 'log' && type !== 'error') {
      navigator.vibrate(200);
    }
  } else {
    // Si ambdues fallen per a tipus crítics (isbn, portada, connection), mostrem l'error
    if (apiParam) {
      showCertWarning(apiParam);
    } else {
      document.getElementById('status-message').innerText = '❌ Error de connexió amb el servidor.';
    }
  }
}

// Preprocess video frame for OCR
function preprocessImage(videoEl, canvasEl, cropRect) {
  const ctx = canvasEl.getContext('2d');
  canvasEl.width = cropRect.width;
  canvasEl.height = cropRect.height;
  
  // Draw the cropped portion of the video feed
  ctx.drawImage(
    videoEl,
    cropRect.x, cropRect.y, cropRect.width, cropRect.height,
    0, 0, cropRect.width, cropRect.height
  );
  
  const imgData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
  const data = imgData.data;
  
  let minG = 255;
  let maxG = 0;
  let avgG = 0;
  
  // First pass: calculate grayscale and find min/max
  const grays = new Uint8Array(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    grays[j] = gray;
    avgG += gray;
    if (gray < minG) minG = gray;
    if (gray > maxG) maxG = gray;
  }
  avgG = avgG / grays.length;
  
  // Use adaptive values if we have reasonable contrast, otherwise fallback
  let lowThreshold = 65;
  let highThreshold = 185;
  const range = maxG - minG;
  
  if (range > 20) {
    // Set threshold relative to the actual range of the image (adaptive binarization)
    lowThreshold = minG + range * 0.15;
    highThreshold = minG + range * 0.85;
  }
  
  const stretchRange = highThreshold - lowThreshold || 1;
  
  let blackCount = 0;
  let whiteCount = 0;
  
  // Second pass: apply stretch and update data
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    let gray = grays[j];
    gray = ((gray - lowThreshold) / stretchRange) * 255;
    gray = Math.max(0, Math.min(255, gray));
    
    if (gray === 0) blackCount++;
    if (gray === 255) whiteCount++;
    
    data[i] = gray;
    data[i+1] = gray;
    data[i+2] = gray;
  }
  
  ctx.putImageData(imgData, 0, 0);
  
  console.log(`Preprocess: Min=${minG}, Max=${maxG}, Avg=${Math.round(avgG)}. Thresholds: [${Math.round(lowThreshold)}-${Math.round(highThreshold)}]. Blacks=${Math.round(blackCount/grays.length*100)}%, Whites=${Math.round(whiteCount/grays.length*100)}%`);
}

async function runOcrTick() {
  // Actualitzem l'estat del botó de flash a cada tick per assegurar-nos que es mostra quan la càmera està a punt
  updateTorchBtnUI();

  const videoElDiagnostic = document.querySelector('#reader video');
  console.log(`runOcrTick: isActive=${isScannerActive}, mode=${currentMode}, isOcrProcessing=${isOcrProcessing}, isProcessing=${isProcessing}, video=${!!videoElDiagnostic}`);

  if (!isScannerActive || currentMode !== 'isbn' || isOcrProcessing || isProcessing) {
    if (isScannerActive && currentMode === 'isbn') {
      ocrTimeoutId = setTimeout(() => runOcrTick(), 600);
    }
    return;
  }
  
  if (!tesseractWorker) {
    ocrTimeoutId = setTimeout(() => runOcrTick(), 1000);
    return;
  }
  
  const videoEl = document.querySelector('#reader video');
  if (!videoEl || videoEl.readyState < 2) {
    ocrTimeoutId = setTimeout(() => runOcrTick(), 500);
    return;
  }
  
  isOcrProcessing = true;
  console.log("OCR Tick: processant fotograma...");
  
  try {
    const vWidth = videoEl.videoWidth;
    const vHeight = videoEl.videoHeight;
    
    // Crop area equivalent to the visual reticle
    const cropWidth = Math.round(vWidth * 0.75);
    const cropHeight = Math.round(vHeight * 0.35);
    const cropX = Math.round((vWidth - cropWidth) / 2);
    const cropY = Math.round((vHeight - cropHeight) / 2);
    
    const canvas = document.getElementById('ocr-canvas');
    preprocessImage(videoEl, canvas, { x: cropX, y: cropY, width: cropWidth, height: cropHeight });
    
    // Whitelist inclou lletres que l'OCR confon amb dígits (O→0, l/I→1, B→8, etc.)
    await tesseractWorker.setParameters({
      tesseract_char_whitelist: '0123456789-ISBNisbnXxOolLIiGgBbSsQq:. '
    });
    
    // Perform OCR
    const { data: { text } } = await tesseractWorker.recognize(canvas);
    console.log("OCR Text read:", text.trim());
    
    // Restore default instructions after recognition finishes
    if (currentMode === 'isbn' && !isProcessing) {
      document.getElementById('status-message').innerText = "Enfoca un codi de barres o el text de l'ISBN";
    }
    
    // Inspect for valid ISBN checksums
    const isbn = cleanAndValidateISBN(text);
    if (isbn) {
      if (isScannerActive && !isProcessing) {
        isProcessing = true;
        document.getElementById('status-message').innerText = '✅ ISBN enviat: ' + isbn + ' — Clica «Encendre Càmera» per llegir un altre.';
        sendToServer('isbn', isbn);
        // Aturem la càmera: l'usuari ha d'engegar-la manualment per llegir el següent
        isOcrProcessing = false;
        await stopIsbnScanner();
        return; // Trenquem el cicle OCR
      }
    } else if (text.trim().length > 0) {
      console.log("OCR: Text detectat, però cap ISBN vàlid.");
    }
  } catch (err) {
    console.warn("OCR worker error during frame recognition:", err);
  }
  
  isOcrProcessing = false;
  ocrTimeoutId = setTimeout(() => runOcrTick(), 600);
}

// Helpers per controlar el Flash/Torch des de la WebApp
function getActiveTrack() {
  if (currentMode === 'isbn') {
    if (html5QrCode && html5QrCode.isScanning) {
      try {
        const track = html5QrCode.getActiveCameraTrack();
        if (track) return track;
      } catch (e) {
        // Fallback silenciós si encara no s'ha iniciat completament
      }
    }
    // Fallback: buscar element video de html5-qrcode
    const video = document.querySelector('#reader video');
    if (video && video.srcObject) {
      try {
        const tracks = video.srcObject.getVideoTracks();
        if (tracks && tracks.length > 0) {
          return tracks[0];
        }
      } catch (e) {
        console.warn("Error obtenint pistes del video fallback en mode ISBN:", e);
      }
    }
  } else if (currentMode === 'portada') {
    if (stream) {
      const tracks = stream.getVideoTracks();
      if (tracks && tracks.length > 0) {
        return tracks[0];
      }
    }
    const video = document.getElementById('ocr-video');
    if (video && video.srcObject) {
      try {
        const tracks = video.srcObject.getVideoTracks();
        if (tracks && tracks.length > 0) {
          return tracks[0];
        }
      } catch (e) {}
    }
  }
  return null;
}

async function toggleTorch() {
  const track = getActiveTrack();
  if (!track) return;
  
  try {
    if (typeof track.getCapabilities !== 'function') return;
    
    const capabilities = track.getCapabilities();
    if (!capabilities.torch) return;
    
    isTorchOn = !isTorchOn;
    await track.applyConstraints({
      advanced: [{ torch: isTorchOn }]
    });
    
    updateTorchBtnUI();
  } catch (err) {
    console.error("Error toggling torch:", err);
  }
}

function updateTorchBtnUI() {
  const btn = document.getElementById('btn-flash');
  if (!btn) return;
  
  const track = getActiveTrack();
  let supported = false;
  
  if (track && typeof track.getCapabilities === 'function') {
    const capabilities = track.getCapabilities();
    if (capabilities.torch) {
      supported = true;
    }
  }
  
  if (supported) {
    btn.style.display = 'inline-flex';
    if (isTorchOn) {
      btn.innerHTML = '⚡ Apagar Flash';
      btn.style.background = '#fcf3cf';
      btn.style.color = '#b7950b';
      btn.style.borderColor = '#b7950b';
    } else {
      btn.innerHTML = '💡 Encendre Flash';
      btn.style.background = '#fffbeb';
      btn.style.color = '#d35400';
      btn.style.borderColor = '#f1c40f';
    }
  } else {
    btn.style.display = 'none';
  }
}

// Helpers per activar / desactivar la càmera
function isCameraActive() {
  if (currentMode === 'isbn') {
    return isScannerActive;
  } else {
    return stream !== null;
  }
}

async function toggleCamera() {
  const statusMsg = document.getElementById('status-message');
  if (isCameraActive()) {
    console.log("[Camera] Desactivant càmera per petició de l'usuari...");
    if (currentMode === 'isbn') {
      await stopIsbnScanner();
    } else {
      stopPortadaCamera();
    }
    statusMsg.innerText = "📷 Càmera desactivada. Clica per activar-la de nou.";
  } else {
    console.log("[Camera] Re-activant càmera...");
    if (currentMode === 'isbn') {
      await startIsbnScanner();
      statusMsg.innerText = "Enfoca un codi de barres o el text de l'ISBN";
    } else {
      await startPortadaCamera();
      statusMsg.innerText = "Enfoca la portada i fes una foto";
    }
  }
  updateCameraToggleBtnUI();
}

function updateCameraToggleBtnUI() {
  const btnToggleCamera = document.getElementById('btn-toggle-camera');
  if (!btnToggleCamera) return;
  
  if (isCameraActive()) {
    btnToggleCamera.style.display = 'inline-flex';
    btnToggleCamera.innerText = "📷 Apagar Càmera";
    btnToggleCamera.style.border = "1px solid #3498db";
    btnToggleCamera.style.background = "#ebf5fb";
    btnToggleCamera.style.color = "#2980b9";
  } else {
    btnToggleCamera.style.display = 'inline-flex';
    btnToggleCamera.innerText = "📷 Encendre Càmera";
    btnToggleCamera.style.border = "1px solid #27ae60";
    btnToggleCamera.style.background = "#e8f8f5";
    btnToggleCamera.style.color = "#27ae60";
    
    // Si la càmera està apagada, també ocultem el flash
    const btnFlash = document.getElementById('btn-flash');
    if (btnFlash) btnFlash.style.display = 'none';
  }
}
