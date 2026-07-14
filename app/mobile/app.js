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
let isLoggingToServer = false;

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
    while (debugContent.children.length > 200) {
      debugContent.removeChild(debugContent.firstChild);
    }
    if (debugLogEl) {
      debugLogEl.scrollTop = debugLogEl.scrollHeight;
    }
  }
  
  if (isLoggingToServer) return;
  
  // Send to server (evitem saturar amb logs de Tesseract de progrés continu)
  const isSpammyLog = msg.includes('[Tesseract]') || 
                      msg.includes('recognizing text') || 
                      msg.includes('loading tesseract') || 
                      msg.includes('initializing tesseract');
  if (!isSpammyLog) {
    isLoggingToServer = true;
    sendToServer('log', `[${type}] ${msg}`).finally(() => {
      isLoggingToServer = false;
    });
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
  if (apiParam) return apiParam;
  return window.location.origin;
}

// Session ID generation and management
let sid = 'default';
function initSessionId() {
  const urlParams = new URLSearchParams(window.location.search);
  let urlSid = urlParams.get('sid');
  if (urlSid) {
    sid = urlSid;
    localStorage.setItem('llibreviu_sid', sid);
  } else {
    let storedSid = localStorage.getItem('llibreviu_sid');
    if (storedSid) {
      sid = storedSid;
    } else {
      sid = Math.random().toString(36).substring(2, 10);
      localStorage.setItem('llibreviu_sid', sid);
    }
    // Append ?sid=YOUR_SID to the URL without reloading
    urlParams.set('sid', sid);
    const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
    window.history.replaceState({ ...history.state }, "", newUrl);
  }
  console.log(`[Session] Active Session ID: ${sid}`);
}

function buildApiUrl(endpoint) {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) return '';
  const separator = endpoint.includes('?') ? '&' : '?';
  return `${baseUrl}${endpoint}${separator}sid=${sid}&client=mobile`;
}

// App Logic
let currentMode = 'isbn'; // 'isbn' or 'portada'
let html5QrCode = null;
let stream = null;
let isTorchOn = false;
let isCoverTorchOn = false;
let currentCoverBase64 = null;
let coverStream = null;
let activeRequiredFields = [];

const fieldLabels = {
  'id_titol': 'Títol del llibre',
  'id_autor': 'Autor(s)',
  'id_traductor': 'Traductor',
  'id_illustrador': 'Il·lustrador',
  'id_editorial': 'Editorial',
  'id_lloc_edicio': 'Lloc edició',
  'id_any': 'Any de publicació',
  'id_tema': 'Tema (*)',
  'id_notes': 'Notes i Observacions',
  'id_isbn': 'ISBN',
  'id_tipus_document': 'Tipus',
  'id_disponible': 'Disponible',
  'id_etiqueta': 'Etiqueta',
  'id_intercanvi': 'Intercanvi'
};
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
  const scale = Math.min(1, 1600 / vw);
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  updateMobileReadability(canvas, ctx);
  
  const quality = 0.82;
    if (relayStreaming && currentMode === 'portada') {
      try {
        const imgData = canvas.toDataURL('image/jpeg', 0.82);
        await fetch(buildApiUrl('/api/camera-frame'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: imgData })
        });
      } catch (err) {
        originalWarn.apply(console, ['Error sending relay frame:', err]);
      }
    }
    if (relayStreaming && currentMode === 'portada') {
      relayTimerId = setTimeout(scheduleRelayFrame, 150); // ~6-7 fps
    }
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
  initSessionId();
  // Inicialitza l'estat d'historial del navegador per poder interceptar el botó de tirar enrere
  if (!history.state || history.state.state !== 'scanning') {
    history.replaceState({ state: 'scanning', depth: 0 }, "");
  }
  historyDepth = 0;

  window.addEventListener('popstate', async (event) => {
    if (isProgrammaticBack) {
      isProgrammaticBack = false;
      console.log("[History] Ignorat popstate programàtic");
      return;
    }
    
    if (event.state && event.state.state) {
      const targetState = event.state.state;
      const targetDepth = typeof event.state.depth === 'number' ? event.state.depth : 0;
      console.log(`[History] Popstate detectat. Target: ${targetState}, depth: ${targetDepth}`);
      
      historyDepth = targetDepth;
      
      const baseUrl = resolveBaseUrl();
      if (targetState === 'scanning') {
        if (baseUrl) {
          try {
            await fetch(buildApiUrl('/api/reset-state'), { method: 'POST' });
          } catch (e) {
            originalError.apply(console, ["[History] Error al resetejar estat:", e]);
          }
        }
      } else {
        if (baseUrl) {
          try {
            await fetch(buildApiUrl('/api/session-state'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ state: targetState, sid })
            });
          } catch (e) {
            console.error("[History] Error al canviar estat a " + targetState + ":", e);
          }
        }
      }
    }
  });

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
    
    setInterval(() => {
      sendToServer('connection', 'connected');
    }, 5000); // Heartbeat cada 5s (connexió local directa)
    
    // Iniciar sincronització d'estats
    startStateSync();
  });
  
  modeIsbn.addEventListener('click', () => switchMode('isbn'));
  modePortada.addEventListener('click', () => switchMode('portada'));
  
  btnTakePhoto.addEventListener('click', () => processPortada());

  const btnToggleCamera = document.getElementById('btn-toggle-camera');
  if (btnToggleCamera) {
    btnToggleCamera.addEventListener('click', () => toggleCamera());
  }

  const chkAutoFlash = document.getElementById('chk-auto-flash');
  if (chkAutoFlash) {
    // Restaurem la preferència desada de l'usuari
    const savedAutoFlash = localStorage.getItem('llibreviu_auto_flash');
    if (savedAutoFlash === 'true') {
      chkAutoFlash.checked = true;
    }
    
    chkAutoFlash.addEventListener('change', async () => {
      localStorage.setItem('llibreviu_auto_flash', chkAutoFlash.checked);
      const track = getActiveTrack();
      if (!track) return;
      try {
        if (typeof track.getCapabilities === 'function') {
          const capabilities = track.getCapabilities();
          if (capabilities.torch) {
            isTorchOn = chkAutoFlash.checked;
            await track.applyConstraints({
              advanced: [{ torch: isTorchOn }]
            });
            updateTorchBtnUI();
          }
        }
      } catch (err) {
        console.warn("No s'ha pogut aplicar el flash immediatament en canviar l'interruptor:", err);
      }
    });
  }

  const btnCancelSelection = document.getElementById('btn-cancel-selection');
  btnCancelSelection?.addEventListener('click', () => resetMobileWorkflow());

  const btnCancelEdit = document.getElementById('btn-cancel-edit');
  btnCancelEdit?.addEventListener('click', () => resetMobileWorkflow());

  const btnSaveForm = document.getElementById('btn-save-form');
  btnSaveForm?.addEventListener('click', () => submitMobileForm());

  const btnTogglePcLock = document.getElementById('btn-toggle-pc-lock');
  btnTogglePcLock?.addEventListener('click', () => togglePcLock());

  const btnTriggerCover = document.getElementById('btn-trigger-cover-capture');
  btnTriggerCover?.addEventListener('click', () => startCoverCamera());

  const btnDoCaptureCover = document.getElementById('btn-do-capture-cover');
  btnDoCaptureCover?.addEventListener('click', () => captureCoverPhoto());

  const btnCancelCover = document.getElementById('btn-cancel-cover-capture');
  btnCancelCover?.addEventListener('click', () => stopCoverCamera());

  const btnToggleCoverFlash = document.getElementById('btn-toggle-cover-flash');
  btnToggleCoverFlash?.addEventListener('click', () => toggleCoverTorch());

  // Listener per al botó de demanar veure a la pantalla de l'ordinador
  const btnShowPc = document.getElementById('btn-show-pc');
  if (btnShowPc) {
    btnShowPc.addEventListener('click', async () => {
      const baseUrl = resolveBaseUrl();
      if (!baseUrl) return;
      try {
        btnShowPc.style.transition = 'transform 0.1s';
        btnShowPc.style.transform = 'scale(0.85)';
        setTimeout(() => { btnShowPc.style.transform = ''; }, 150);
        await fetch(buildApiUrl('/api/show-tab'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requested: true, sid })
        });
      } catch (e) {
        console.error("Error demanant veure a la pantalla:", e);
      }
    });
  }

  // Settings Gear Modal Listeners
  const btnSettingsGear = document.getElementById('btn-settings-gear');
  const settingsOverlay = document.getElementById('settings-overlay');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const selOcrEngine = document.getElementById('sel-ocr-engine');
  const txtGeminiKey = document.getElementById('txt-gemini-key');
  const geminiKeyContainer = document.getElementById('gemini-key-container');

  if (btnSettingsGear && settingsOverlay && btnCloseSettings && btnSaveSettings && selOcrEngine && txtGeminiKey) {
    const savedEngine = localStorage.getItem('ocr-engine') || 'gemini-api';
    let savedKey = localStorage.getItem('gemini-api-key') || '';
    if (savedKey === 'gen-lang-client-0842373978') {
      savedKey = '';
      localStorage.setItem('gemini-api-key', savedKey);
    }

    selOcrEngine.value = savedEngine;
    txtGeminiKey.value = savedKey;

    const toggleOcrFields = () => {
      if (geminiKeyContainer) {
        geminiKeyContainer.style.display = selOcrEngine.value === 'gemini-api' ? 'block' : 'none';
      }
    };

    selOcrEngine.addEventListener('change', toggleOcrFields);
    toggleOcrFields();

    btnSettingsGear.addEventListener('click', () => {
      settingsOverlay.style.display = 'flex';
      toggleOcrFields();
    });

    btnCloseSettings.addEventListener('click', () => {
      settingsOverlay.style.display = 'none';
    });

    btnSaveSettings.addEventListener('click', () => {
      localStorage.setItem('ocr-engine', selOcrEngine.value);
      localStorage.setItem('gemini-api-key', txtGeminiKey.value);
      localStorage.setItem('use-paddle-ocr', selOcrEngine.value === 'local-hybrid' ? 'true' : 'false');
      settingsOverlay.style.display = 'none';
      console.log(`[OCR Settings] Engine saved: ${selOcrEngine.value}`);
    });

    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) {
        settingsOverlay.style.display = 'none';
      }
    });
  }
});

async function switchMode(mode) {
  currentMode = mode;
  document.getElementById('mode-isbn').classList.toggle('active', mode === 'isbn');
  document.getElementById('mode-portada').classList.toggle('active', mode === 'portada');
  
  if (activeState === 'scanning') {
    switchView('scanning');
  } else {
    document.getElementById('scanner-view').classList.toggle('active', mode === 'isbn');
    document.getElementById('ocr-view').classList.toggle('active', mode === 'portada');
  }
  
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
  if (activeState !== 'scanning') {
    console.log("startIsbnScanner: Ignorat perquè l'estat és " + activeState);
    return;
  }
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
  
  let selectedCamera = { facingMode: "environment" }; // fallback
  console.log("startIsbnScanner: Demanant llista de càmeres per evitar doble prompt...");
  try {
    const devices = await Html5Qrcode.getCameras();
    if (devices && devices.length > 0) {
      const backCamera = devices.find(device => {
        const label = device.label.toLowerCase();
        return label.includes('back') || label.includes('rear') || label.includes('posterior') || label.includes('entorn') || label.includes('environment');
      });
      if (backCamera) {
        selectedCamera = backCamera.id;
        console.log(`[Camera] Seleccionada càmera posterior: ${backCamera.label} (${backCamera.id})`);
      } else {
        selectedCamera = devices[0].id;
        console.log(`[Camera] Usant primera càmera disponible: ${devices[0].label} (${devices[0].id})`);
      }
    }
  } catch (camErr) {
    console.warn("[Camera] Error obtenint llista de càmeres, usant fallback facingMode:", camErr);
  }

  console.log("startIsbnScanner: Cridant html5QrCode.start...");
  try {
    await html5QrCode.start(
      selectedCamera,
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
  const wasActive = isScannerActive;
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
      if (wasActive) {
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
  // Marge més llarg per garantir que el navegador alliberi el maquinari de la càmera
  await new Promise(r => setTimeout(r, 600));
}

async function startPortadaCamera() {
  if (activeState !== 'scanning') {
    console.log("startPortadaCamera: Ignorat perquè l'estat és " + activeState);
    return;
  }
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
    try {
      // Intent 1: Càmera posterior amb resolució alta (ideal 4K)
      stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'environment',
          width: { ideal: 3840 },
          height: { ideal: 2160 }
        } 
      });
    } catch (err1) {
      console.warn("[Camera] Error amb restriccions 4K, provant restriccions posteriors estàndard...", err1);
      try {
        // Intent 2: Càmera posterior estàndard
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
      } catch (err2) {
        console.warn("[Camera] Error amb càmera posterior, provant qualsevol càmera disponible...", err2);
        // Intent 3: Qualsevol càmera disponible
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
    }
    
    video.srcObject = stream;
    video.muted = true;
    try {
      await video.play();
      console.log("[Camera] ocr-video plays successfully");
    } catch (e) {
      console.warn("[Camera] ocr-video.play() failed, trying after brief delay:", e);
      setTimeout(() => {
        video.play().catch(pe => console.error("[Camera] Delayed play failed:", pe));
      }, 300);
    }
    setTimeout(updateTorchBtnUI, 600);
    updateCameraToggleBtnUI();
    
    // L'enviament en directe s'ha desactivat. Només s'enviarà foto quan es cliqui el botó.
  } catch (err) {
    console.warn("[Camera] Error inicialitzant la càmera posterior, iniciant reintent en 800ms...", err);
    document.getElementById('status-message').innerText = '⏳ Càmera ocupada, reintentant connectar...';
    await new Promise(r => setTimeout(r, 800));
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      document.getElementById('status-message').innerText = 'Enfoca la portada i fes una foto';
      updateCameraToggleBtnUI();
    } catch (retryErr) {
      console.error("[Camera] Error final en reintent:", retryErr);
      document.getElementById('status-message').innerText = 'Error càmera Portada: ' + retryErr;
      updateCameraToggleBtnUI();
    }
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
    stream.getTracks().forEach(track => {
      try {
        if (typeof track.applyConstraints === 'function') {
          track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
        }
      } catch (e) {}
      track.stop();
    });
    stream = null;
  }
  const video = document.getElementById('ocr-video');
  video.srcObject = null; // Alliberem la referència per complet
  video.style.display = 'none';
  document.getElementById('btn-take-photo').style.display = 'none';
  updateCameraToggleBtnUI();
}

// Helper per descarregar fitxers grans mostrant el progrés a la interfície
async function fetchWithProgress(url, label, statusElement) {
  statusElement.innerText = `⚙️ Connectant per descarregar ${label}...`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error ${response.status} descarregant ${label} des de: ${url}`);
  }
  
  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  
  if (total === 0) {
    statusElement.innerText = `⚙️ Descarregant ${label} (mida desconeguda)...`;
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }
  
  const reader = response.body.getReader();
  let loaded = 0;
  const chunks = [];
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const pct = Math.round((loaded / total) * 100);
    statusElement.innerText = `⚙️ Descarregant ${label}: ${pct}% (${(loaded / 1024 / 1024).toFixed(1)}MB de ${(total / 1024 / 1024).toFixed(1)}MB)...`;
  }
  
  const blob = new Blob(chunks);
  return URL.createObjectURL(blob);
}

async function getOcrInstance(statusMsg) {
  if (ocrInstance) return ocrInstance;
  statusMsg.innerText = '⚙️ Inicialitzant: Carregant llibreria PaddleOCR...';
  
  try {
    console.log("[PaddleOCR] Important la llibreria local ./paddleocr.js...");
    const module = await import('./paddleocr.js?t=' + Date.now());
    const PaddleOCR = module.PaddleOCR;
    console.log("[PaddleOCR] Llibreria importada correctament.");

    const isLocalFile = window.location.protocol === 'file:';
    let detUrl = '';
    let recUrl = '';

    if (!isLocalFile) {
      detUrl = new URL('../models/PP-OCRv5_mobile_det_onnx.tar?t=' + Date.now(), window.location.href).href;
      recUrl = new URL('../models/PP-OCRv5_mobile_rec_onnx.tar?t=' + Date.now(), window.location.href).href;
    } else {
      detUrl = 'https://rogroc.github.io/open_library/models/PP-OCRv5_mobile_det_onnx.tar?t=' + Date.now();
      recUrl = 'https://rogroc.github.io/open_library/models/PP-OCRv5_mobile_rec_onnx.tar?t=' + Date.now();
    }
    
    console.log("[PaddleOCR] Rutes resoltes al mòbil:", { detUrl, recUrl });

    const localDetObjectUrl = await fetchWithProgress(detUrl, 'model de detecció (4.8MB)', statusMsg);
    const localRecObjectUrl = await fetchWithProgress(recUrl, 'model de reconeixement (16.7MB)', statusMsg);

    statusMsg.innerText = '⚙️ Inicialitzant el motor de xarxa neuronal...';
    console.log("[PaddleOCR] Cridant PaddleOCR.create()...");

    ocrInstance = await PaddleOCR.create({
      lang: 'en',
      ocrVersion: 'PP-OCRv5',
      worker: false,
      ensureServedFromHttp: () => {},
      text_detection_model_name: 'PP-OCRv5_mobile_det',
      text_detection_model_dir: { url: localDetObjectUrl },
      text_recognition_model_name: 'PP-OCRv5_mobile_rec',
      text_recognition_model_dir: { url: localRecObjectUrl },
      ortOptions: {
        backend: 'wasm',
        wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/',
        numThreads: 1,
        simd: true,
        proxy: false
      }
    });

    if (ocrInstance) {
      if (ocrInstance.detModel) {
        const originalDetPredict = ocrInstance.detModel.predict;
        ocrInstance.detModel.predict = async function(cv, mats, options) {
          const results = await originalDetPredict.call(ocrInstance.detModel, cv, mats, options);
          const margin = 6;
          results.forEach((res, imgIdx) => {
            if (res && res.boxes) {
              const mat = mats[imgIdx];
              const maxW = mat ? mat.cols : 99999;
              const maxH = mat ? mat.rows : 99999;
              res.boxes.forEach(box => {
                if (box.poly && box.poly.length === 4) {
                  box.poly[0][0] = Math.max(0, box.poly[0][0] - margin);
                  box.poly[0][1] = Math.max(0, box.poly[0][1] - margin);
                  box.poly[1][0] = Math.min(maxW, box.poly[1][0] + margin);
                  box.poly[1][1] = Math.max(0, box.poly[1][1] - margin);
                  box.poly[2][0] = Math.min(maxW, box.poly[2][0] + margin);
                  box.poly[2][1] = Math.min(maxH, box.poly[2][1] + margin);
                  box.poly[3][0] = Math.max(0, box.poly[3][0] - margin);
                  box.poly[3][1] = Math.min(maxH, box.poly[3][1] + margin);
                }
              });
            }
          });
          return results;
        };
      }

      if (ocrInstance.recModel) {
        ocrInstance.recModel.predict = async function(cv, mats, options) {
          return mats.map(() => ({ text: '__MASK_PENDING__', score: 1.0 }));
        };
      }
    }

    return ocrInstance;
  } catch (err) {
    console.error("[PaddleOCR] Error en getOcrInstance:", err);
    statusMsg.innerText = '❌ Error inicialització: ' + err.message;
    throw err;
  }
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

async function extractTextWithGemini(fileOrBlob, apiKey, themeOptions = []) {
  const modelName = "gemini-3.1-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  // Convert and resize image to standard jpeg (maximum width/height 1600px) to prevent API payload errors
  const processedBlob = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX_WIDTH = 1600;
      const MAX_HEIGHT = 1600;
      let width = img.width;
      let height = img.height;

      if (width > MAX_WIDTH || height > MAX_HEIGHT) {
        if (width > height) {
          height = Math.round((height * MAX_WIDTH) / width);
          width = MAX_WIDTH;
        } else {
          width = Math.round((width * MAX_HEIGHT) / height);
          height = MAX_HEIGHT;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        resolve(blob || fileOrBlob);
      }, 'image/jpeg', 0.85);
    };
    img.onerror = () => {
      resolve(fileOrBlob); // Fallback to original
    };
    img.src = URL.createObjectURL(fileOrBlob);
  });

  const base64Data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(processedBlob);
  });
  
  let promptText = "Analitza la portada d'aquest llibre. Extrau i classifica el text en un objecte JSON amb les següents claus obligatòries:\n" +
                   "- \"titol\" (el títol del llibre)\n" +
                   "- \"autor\" (el nom o noms dels autors, si n'hi ha)\n" +
                   "- \"editorial\" (la marca editorial o segell, si n'hi ha)\n";
                   
  if (Array.isArray(themeOptions) && themeOptions.length > 0) {
    const listStr = themeOptions.map(opt => `- "${opt.text}" (valor: "${opt.value}")`).join('\n');
    promptText += "- \"id_tema\" (el valor del tema seleccionat de la llista següent)\n\n" +
                  "Llista de temes de Llibreviu:\n" + listStr + "\n\n" +
                  "Classifica el tema del llibre seleccionant el valor del tema més adient de la llista anterior. ";
  } else {
    promptText += "- \"id_tema\" (sempre una cadena buida \"\")\n\n";
  }
  
  promptText += "Si no es detecta o no s'està segur d'algun dels camps, deixa el seu valor com a cadena buida \"\". Retorna únicament l'objecte JSON pur, sense blocs de codi markdown ni cap altre text explicatiu.";

  const payload = {
    contents: [
      {
        parts: [
          {
            text: promptText
          },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Data
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let text = "";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Error de l'API de Gemini (${response.status}): ${errText}`);
    }

    const result = await response.json();
    text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("No s'ha pogut extreure text de la resposta de Gemini.");
    }
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
  clearTimeout(timeoutId);
  let textClean = text.trim();
  
  // Robust JSON extraction and normalization
  function cleanAndExtractJSON(rawText) {
    let clean = rawText.trim();
    if (clean.includes('```')) {
      const match = clean.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (match) {
        clean = match[1].trim();
      } else {
        const parts = clean.split('```');
        for (const part of parts) {
          const p = part.trim();
          if (p.startsWith('{') && p.endsWith('}')) {
            clean = p;
            break;
          }
        }
      }
    }
    
    if (!clean.startsWith('{') || !clean.endsWith('}')) {
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        clean = clean.substring(start, end + 1);
      }
    }
    
    try {
      const parsed = JSON.parse(clean);
      if (parsed && typeof parsed === 'object') {
        const titol = parsed.titol || parsed.títol || parsed.title || parsed.Titol || parsed.Títol || parsed.Title || '';
        const autor = parsed.autor || parsed.author || parsed.Autor || parsed.Author || '';
        const editorial = parsed.editorial || parsed.publisher || parsed.pub || parsed.Editorial || parsed.Publisher || parsed.Pub || '';
        
        const canonical = {
          titol: String(titol).trim(),
          autor: String(autor).trim(),
          editorial: String(editorial).trim()
        };
        if (parsed.id_tema) {
          canonical.id_tema = parsed.id_tema;
        }
        return JSON.stringify(canonical);
      }
    } catch (e) {
      console.warn("Failed to parse/clean OCR json:", e);
    }
    return null;
  }

  const cleanedJson = cleanAndExtractJSON(textClean);
  if (cleanedJson) {
    return cleanedJson;
  }
  return textClean;
}

async function processPortada() {
  const video = document.getElementById('ocr-video');
  const canvas = document.getElementById('ocr-canvas');
  const ctx = canvas.getContext('2d');
  
  const MAX_DIMENSION = 1600;
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
  const imgDataUrl = canvas.toDataURL('image/jpeg', 0.82);
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
        try {
          const uploadRes = await fetch(buildApiUrl('/api/camera-frame'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imgDataUrl })
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
      return;
    }

    const selectedEngine = latestOcrEngine;
    const apiKey = latestGeminiApiKey;

    if (selectedEngine === 'gemini-api') {
      statusMsg.innerText = '🤖 Extraient text i classificant tema amb Gemini...';
      try {
        let themeOptions = [];
        try {
          const stateRes = await fetch(buildApiUrl(`/api/session-state?t=${Date.now()}`), { cache: 'no-store' });
          if (stateRes.ok) {
            const stateData = await stateRes.json();
            if (stateData && stateData.formData && stateData.formData._selectOptions && stateData.formData._selectOptions.id_tema) {
              themeOptions = stateData.formData._selectOptions.id_tema;
            }
          }
        } catch (themeErr) {
          console.warn("Error fetching theme options in mobile Gemini OCR:", themeErr);
        }

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        const text = await extractTextWithGemini(blob, apiKey, themeOptions);
        console.log(`[Gemini OCR Mòbil] Text extret: "${text}"`);
        
        let displayStatus = '✅ Text extret. Enviant...';
        try {
          if (text.trim().startsWith('{')) {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') {
              const parts = [];
              if (parsed.titol) parts.push(`"${parsed.titol}"`);
              if (parsed.autor) parts.push(parsed.autor);
              if (parts.length > 0) displayStatus = `✅ ${parts.join(' — ')}. Enviant...`;
            }
          }
        } catch (e) { /* ignore */ }
        
        statusMsg.innerText = displayStatus;
        sendToServer('portada', text);
      } catch (err) {
        console.error("Error Gemini OCR Mòbil:", err);
        statusMsg.innerText = `❌ Error Gemini: ${err.message}`;
      }
      setTimeout(() => {
        if (currentMode === 'portada') startPortadaCamera();
      }, 3000);
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
    
    // 3. Decidim si utilitzem PaddleOCR o directament Tesseract
    const usePaddle = localStorage.getItem('use-paddle-ocr') === 'true';
    let ocrInputUrl = normalUrl;
    let detectedPolys = [];

    if (usePaddle) {
      statusMsg.innerText = '🔍 Carregant motor de xarxa neuronal PaddleOCR...';
      try {
        const ocr = await getOcrInstance(statusMsg);
        statusMsg.innerText = '🔍 Detectant zones de text amb PaddleOCR...';
        
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        const ocrRes = await ocr.predict(blob, {
          text_det_limit_side_len: 960,
          text_det_limit_type: 'min',
          text_det_thresh: 0.2,
          text_det_box_thresh: 0.4
        });
        
        const pageResult = ocrRes[0] || {};
        detectedPolys = (pageResult.items || []).map(item => item.poly);
        console.log(`[PaddleOCR Mòbil] Detectades ${detectedPolys.length} regions.`);
        
        if (detectedPolys.length > 0) {
          statusMsg.innerText = '⚙️ Generant màscara de text...';
          const maskCanvas = document.createElement('canvas');
          maskCanvas.width = canvas.width;
          maskCanvas.height = canvas.height;
          const mCtx = maskCanvas.getContext('2d');
          
          mCtx.fillStyle = '#ffffff';
          mCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
          
          mCtx.save();
          mCtx.beginPath();
          detectedPolys.forEach(poly => {
            if (poly && poly.length >= 3) {
              mCtx.moveTo(poly[0][0], poly[0][1]);
              for (let i = 1; i < poly.length; i++) {
                mCtx.lineTo(poly[i][0], poly[i][1]);
              }
              mCtx.closePath();
            }
          });
          mCtx.clip();
          
          mCtx.drawImage(normalCanvas, 0, 0);
          mCtx.restore();
          
          ocrInputUrl = maskCanvas.toDataURL('image/jpeg', 1.0);
        } else {
          console.log("[PaddleOCR Mòbil] No s'ha detectat cap polígon. Fent fallback a Tesseract complet.");
        }
      } catch (err) {
        console.warn("[PaddleOCR Mòbil] Error executant PaddleOCR, fem fallback a Tesseract complet:", err);
      }
    }

    statusMsg.innerText = '⚙️ Inicialitzant motor d\'OCR local (spa+cat)...';
    
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
    const { data: ocrResult } = await tempWorker.recognize(ocrInputUrl);
    
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

async function sendToServer(type, value) {
  const baseUrl = resolveBaseUrl();
  
  let localSuccess = false;
  
  // 1. Envia al servidor local Python si està configurat i tenim baseUrl
  if (baseUrl) {
    try {
      const res = await fetch(buildApiUrl('/api/scan'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, value, sid })
      });
      localSuccess = res.ok;
    } catch (e) {
      originalWarn.apply(console, ['Error enviant al servidor local:', e]);
    }
  }
  
  // 2. Envia a ntfy.sh eliminat (ja no s'usa el canal públic)
  const ntfySuccess = false;
  
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
    // Si ambdues fallen per a tipus crítics (isbn, portada, connection), mostrem l'error genèric
    document.getElementById('status-message').innerText = '❌ Error de connexió amb el servidor.';
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
  const switchContainer = document.getElementById('switch-flash-container');
  if (!switchContainer) return;
  
  const track = getActiveTrack();
  let supported = false;
  
  if (track && typeof track.getCapabilities === 'function') {
    const capabilities = track.getCapabilities();
    if (capabilities.torch) {
      supported = true;
    }
  }
  
  if (supported) {
    switchContainer.style.display = 'inline-flex';
    
    const chkAutoFlash = document.getElementById('chk-auto-flash');
    const shouldTorchBeOn = chkAutoFlash ? chkAutoFlash.checked : false;
    
    if (shouldTorchBeOn) {
      if (!isTorchOn) {
        isTorchOn = true;
        track.applyConstraints({
          advanced: [{ torch: true }]
        }).catch(err => console.warn("No s'ha pogut auto-activar el flash de fons:", err));
      }
    } else {
      if (isTorchOn) {
        isTorchOn = false;
        track.applyConstraints({
          advanced: [{ torch: false }]
        }).catch(err => {});
      }
    }
  } else {
    switchContainer.style.display = 'none';
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
    
    // Si la càmera està apagada, també ocultem l'interruptor de flash
    const switchContainer = document.getElementById('switch-flash-container');
    if (switchContainer) switchContainer.style.display = 'none';
  }
}

function getActiveCoverTrack() {
  if (coverStream) {
    const tracks = coverStream.getVideoTracks();
    if (tracks && tracks.length > 0) {
      return tracks[0];
    }
  }
  const video = document.getElementById('cover-video');
  if (video && video.srcObject) {
    try {
      const tracks = video.srcObject.getVideoTracks();
      if (tracks && tracks.length > 0) {
        return tracks[0];
      }
    } catch (e) {}
  }
  return null;
}

function updateCoverTorchBtnUI() {
  const btn = document.getElementById('btn-toggle-cover-flash');
  if (!btn) return;
  
  const track = getActiveCoverTrack();
  let supported = false;
  
  if (track && typeof track.getCapabilities === 'function') {
    const capabilities = track.getCapabilities();
    if (capabilities.torch) {
      supported = true;
    }
  }
  
  if (supported) {
    btn.style.display = 'inline-flex';
    if (isCoverTorchOn) {
      btn.innerHTML = '⚡';
      btn.style.background = '#f1c40f';
      btn.style.color = '#000';
      btn.style.boxShadow = '0 0 10px #f1c40f';
    } else {
      btn.innerHTML = '⚡';
      btn.style.background = 'rgba(255,255,255,0.2)';
      btn.style.color = '#fff';
      btn.style.boxShadow = 'none';
    }
  } else {
    btn.style.display = 'none';
  }}

async function toggleCoverTorch() {
  const track = getActiveCoverTrack();
  if (!track) return;
  
  try {
    if (typeof track.getCapabilities !== 'function') return;
    
    const capabilities = track.getCapabilities();
    if (!capabilities.torch) return;
    
    isCoverTorchOn = !isCoverTorchOn;
    await track.applyConstraints({
      advanced: [{ torch: isCoverTorchOn }]
    });
    
    updateCoverTorchBtnUI();
  } catch (err) {
    console.error("Error toggling cover torch:", err);
  }
}

async function startCoverCamera() {
  // Aturem proactivament qualsevol càmera principal activa per evitar conflictes de hardware i consum de memòria
  console.log("[Cover Camera] Aturant càmeres principals abans d'iniciar la de la portada...");
  if (html5QrCode) {
    try {
      await stopIsbnScanner();
    } catch (e) {
      console.warn("Error aturant escàner ISBN per al cover:", e);
    }
  }
  try {
    stopPortadaCamera();
  } catch (e) {
    console.warn("Error aturant càmera de portada principal per al cover:", e);
  }

  const video = document.getElementById('cover-video');
  const overlay = document.getElementById('cover-capture-overlay');
  if (!video || !overlay) return;
  overlay.style.display = 'flex';
  
  try {
    try {
      coverStream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } 
      });
    } catch (err1) {
      console.warn("[Cover Camera] Error with ideal specs, trying standard...", err1);
      try {
        coverStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
      } catch (err2) {
        coverStream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
    }
    
    video.srcObject = coverStream;
    video.muted = true;
    await video.play();

    // Sincronitza l'estat inicial del flash de la portada amb la preferència "Flash automàtic"
    const chkAutoFlash = document.getElementById('chk-auto-flash');
    isCoverTorchOn = chkAutoFlash ? chkAutoFlash.checked : false;

    const track = getActiveCoverTrack();
    if (track && typeof track.getCapabilities === 'function') {
      const capabilities = track.getCapabilities();
      if (capabilities.torch) {
        try {
          await track.applyConstraints({
            advanced: [{ torch: isCoverTorchOn }]
          });
        } catch (torchErr) {
          console.warn("No s'ha pogut aplicar el constraint de flash al cover:", torchErr);
        }
      }
    }

    updateCoverTorchBtnUI();
    setTimeout(updateCoverTorchBtnUI, 300);
    setTimeout(updateCoverTorchBtnUI, 800);
  } catch (err) {
    console.error("Error starting cover camera:", err);
    alert("No s'ha pogut accedir a la càmera per fer la foto de la portada.");
    overlay.style.display = 'none';
  }
}

function stopCoverCamera() {
  isCoverTorchOn = false;
  if (coverStream) {
    coverStream.getTracks().forEach(track => {
      try {
        if (typeof track.applyConstraints === 'function') {
          track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
        }
      } catch (e) {}
      track.stop();
    });
    coverStream = null;
  }
  const video = document.getElementById('cover-video');
  if (video) {
    video.srcObject = null;
  }
  const overlay = document.getElementById('cover-capture-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
  const btn = document.getElementById('btn-toggle-cover-flash');
  if (btn) {
    btn.style.display = 'none';
  }
}

async function captureCoverPhoto() {
  const video = document.getElementById('cover-video');
  const canvas = document.getElementById('cover-canvas');
  if (!video || !canvas) return;
  
  const ctx = canvas.getContext('2d');
  const MAX_DIM = 1000;
  let videoW = video.videoWidth || 640;
  let videoH = video.videoHeight || 480;
  // Proporció objectiu 1:1.6 (5:8)
  const targetRatio = 1 / 1.6; // 0.625
  let cropWidth, cropHeight;
  
  if (videoW / videoH > targetRatio) {
    // El video és més ample de la proporció desitjada (retallem horitzontalment)
    cropHeight = videoH;
    cropWidth = videoH * targetRatio;
  } else {
    // El video és més alt de la proporció desitjada (retallem verticalment)
    cropWidth = videoW;
    cropHeight = videoW / targetRatio;
  }
  
  const cropX = (videoW - cropWidth) / 2;
  const cropY = (videoH - cropHeight) / 2;
  
  // Limitem la dimensió de sortida (alçada màxima de 1000px per a rendiment)
  const destHeight = Math.min(cropHeight, MAX_DIM);
  const destWidth = destHeight * targetRatio;
  
  canvas.width = destWidth;
  canvas.height = destHeight;
  
  // Dibuixem només el quadre central de 1:1.6 del flux de vídeo
  ctx.drawImage(
    video, 
    cropX, cropY, cropWidth, cropHeight, // Font (zona central)
    0, 0, destWidth, destHeight         // Destí (canvas)
  );
  
  const imgDataUrl = canvas.toDataURL('image/jpeg', 0.82);
  
  // Set the preview in the form
  const formPreview = document.getElementById('form-cover-preview');
  const formPlaceholder = document.getElementById('form-cover-placeholder');
  if (formPreview && formPlaceholder) {
    formPreview.src = imgDataUrl;
    formPreview.style.display = 'block';
    formPlaceholder.style.display = 'none';
  }
  
  // Store the base64 cover image in a global variable
  currentCoverBase64 = imgDataUrl;
  
  // Enviar immediatament la imatge de portada al servidor de l'ordinador
  const baseUrl = resolveBaseUrl();
  if (baseUrl) {
    fetch(buildApiUrl('/api/update-cover'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cover_image: imgDataUrl, sid })
    }).catch(err => console.error("Error enviant cover-update al servidor:", err));
  }
  
  // Stop camera and close overlay
  stopCoverCamera();
}

// =========================================================
// WIZARD STATE MACHINE FOR MOBILE CATALOGING
// =========================================================
let activeState = 'scanning';
let activeVersion = -1;
let historyDepth = 0;
let isProgrammaticBack = false;
let pcLocked = true;
let latestOcrEngine = 'gemini-api';
let latestGeminiApiKey = '';

function startStateSync() {
  const baseUrl = resolveBaseUrl();
  
  console.log("Iniciant sincronització d'estat local directe via polling...");
  setInterval(async () => {
    try {
      // Polling lleuger de l'estat (només retornem el nom de l'estat i la versió, estalviant amplada de banda)
      const res = await fetch(buildApiUrl(`/api/session-state?state_only=true&t=${Date.now()}`), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data.ocr_engine) latestOcrEngine = data.ocr_engine;
        if (data.gemini_api_key) latestGeminiApiKey = data.gemini_api_key;
        
        if (data.state !== activeState || data.version !== activeVersion) {
          console.log(`[Sync] Canvi d'estat/versió detectat (${activeState}:${activeVersion} -> ${data.state}:${data.version}). Descarregant detalls...`);
          // Obtenim l'estat complet per al canvi de vista (només es crida un cop per canvi d'estat o versió)
          const detailRes = await fetch(buildApiUrl(`/api/session-state?t=${Date.now()}`), { cache: 'no-store' });
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            activeVersion = detailData.version;
            if (detailData.pc_locked !== undefined) {
              pcLocked = detailData.pc_locked;
              updatePcLockUI();
            }
            if (detailData.ocr_engine) latestOcrEngine = detailData.ocr_engine;
            if (detailData.gemini_api_key) latestGeminiApiKey = detailData.gemini_api_key;
            handleStateTransition(detailData);
          }
        }
      }
    } catch (e) {
      originalWarn.apply(console, ["Error sync-polling local state:", e]);
    }
  }, 1000);
}

async function handleStateTransition(data) {
  if (!data || !data.state) return;
  if (data.ocr_engine) latestOcrEngine = data.ocr_engine;
  if (data.gemini_api_key) latestGeminiApiKey = data.gemini_api_key;
  if (data.state === activeState) return;
  
  const previousState = activeState;
  activeState = data.state;
  console.log(`Estat de la sessió: ${previousState} -> ${activeState}`);

  // Gestiona l'historial per interceptar el botó de tirar enrere del mòbil
  if (['scanning', 'selection', 'editing'].includes(activeState)) {
    if (history.state && history.state.state === activeState) {
      console.log(`[History] L'estat ${activeState} ja coincideix amb history.state.`);
      if (history.state.depth !== undefined) {
        historyDepth = history.state.depth;
      }
    } else {
      const currentDepth = (history.state && typeof history.state.depth === 'number') ? history.state.depth : 0;
      const newDepth = activeState === 'scanning' ? 0 : currentDepth + 1;
      historyDepth = newDepth;
      history.pushState({ state: activeState, depth: newDepth }, "");
      console.log(`[History] Pushed state: ${activeState} amb profunditat ${newDepth}`);
    }
  }
  
  // Apaguem la càmera temporalment si no estem en mode escaneig per estalviar bateria i rendiment
  if (previousState === 'scanning' && activeState !== 'scanning') {
    console.log("[Camera] Aturant càmera per interactuar amb el giny...");
    if (currentMode === 'isbn') {
      await stopIsbnScanner();
    } else {
      stopPortadaCamera();
    }
  }
  
  // Canvia la vista visual visible
  switchView(activeState);
  
  if (activeState === 'searching') {
    const h3 = document.querySelector('#searching-view h3');
    const p = document.querySelector('#searching-view p');
    if (h3) h3.innerText = "Cercant als catàlegs...";
    if (p) p.innerText = "L'ordinador de treball està consultant les bases de dades de llibres.";
  } else if (activeState === 'filling') {
    const h3 = document.querySelector('#searching-view h3');
    const p = document.querySelector('#searching-view p');
    if (h3) h3.innerText = "Injectant dades...";
    if (p) p.innerText = "S'estan transferint les dades del llibre al formulari de l'ordinador.";
  } else if (activeState === 'saving') {
    const h3 = document.querySelector('#searching-view h3');
    const p = document.querySelector('#searching-view p');
    if (h3) h3.innerText = "Desant fitxa...";
    if (p) p.innerText = "S'està enviant el formulari i registrant el llibre a la base de dades.";
  } else if (activeState === 'selection') {
    renderCandidates(data.candidates || []);
  } else if (activeState === 'editing') {
    renderFormFields(data.formData || {});
  } else if (activeState === 'done') {
    renderOutcome(data.outcome || {});
    // Auto reset en 3 segons
    setTimeout(() => {
      resetMobileWorkflow();
    }, 3000);
  } else if (activeState === 'scanning') {
    // Si retornem a escanejar, reactivem la càmera si cal
    if (!isCameraActive()) {
      console.log("[Camera] Reactivem càmera per escanejar el següent llibre...");
      if (currentMode === 'isbn') {
        await startIsbnScanner();
      } else {
        await startPortadaCamera();
      }
    }
  }
}

function switchView(state) {
  const views = {
    'scanning': currentMode === 'isbn' ? 'scanner-view' : 'ocr-view',
    'searching': 'searching-view',
    'selection': 'selection-view',
    'filling': 'searching-view',
    'editing': 'editing-view',
    'saving': 'searching-view',
    'done': 'outcome-view'
  };
  
  const allViews = ['scanner-view', 'ocr-view', 'searching-view', 'selection-view', 'editing-view', 'outcome-view'];
  allViews.forEach(v => {
    const el = document.getElementById(v);
    if (el) {
      el.style.display = 'none';
      el.classList.remove('active');
    }
  });
  
  const activeViewId = views[state] || (currentMode === 'isbn' ? 'scanner-view' : 'ocr-view');
  const activeViewEl = document.getElementById(activeViewId);
  if (activeViewEl) {
    activeViewEl.style.display = (activeViewId === 'ocr-view' || activeViewId === 'searching-view' || activeViewId === 'outcome-view') ? 'flex' : 'block';
    activeViewEl.classList.add('active');
  }
  
  const header = document.querySelector('.header');
  const cameraControls = document.getElementById('btn-toggle-camera')?.parentNode;
  const statusMsg = document.getElementById('status-message');
  
  if (state === 'scanning') {
    if (header) header.style.display = 'block';
    if (cameraControls) cameraControls.style.display = 'flex';
    if (statusMsg) statusMsg.style.display = 'block';
  } else {
    if (header) header.style.display = 'none';
    if (cameraControls) cameraControls.style.display = 'none';
    if (statusMsg) statusMsg.style.display = 'none';
  }
}

function renderCandidates(candidates) {
  const container = document.getElementById('candidates-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (candidates.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding: 25px; color:#aaa; font-weight:500;">No s\'ha trobat cap llibre als catàlegs.</div>';
    return;
  }
  
  candidates.forEach((book, index) => {
    const card = document.createElement('div');
    card.className = 'candidate-card';
    
    const coverUrl = book.cover || '';
    const coverHtml = coverUrl ? `<img src="${coverUrl}" alt="Portada">` : `<div style="width: 50px; height: 75px; background: #333; display:flex; align-items:center; justify-content:center; border-radius:4px; font-size:0.55rem; color:#888; flex-shrink:0;">Sense Foto</div>`;
    
    card.innerHTML = `
      ${coverHtml}
      <div class="candidate-info">
        <h4>${escapeHtml(book.title || 'Sense títol')}</h4>
        <p><strong>Autor:</strong> ${escapeHtml(book.author || 'Desconegut')}</p>
        <p><strong>Editorial:</strong> ${escapeHtml(book.publisher || 'Desconeguda')} (${escapeHtml(book.year || '-')})</p>
        <span class="candidate-badge">${escapeHtml(book.source || 'Catàleg')}</span>
      </div>
    `;
    
    card.addEventListener('click', () => {
      selectCandidate(book, index);
    });
    
    container.appendChild(card);
  });
}

async function classifyThemeWithGemini(book, options, apiKey) {
  const modelName = "gemini-3.1-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  const optionsStr = options.map(opt => `- "${opt.text}" (valor: "${opt.value}")`).join('\n');
  
  const prompt = `Classifica el següent llibre en UN dels temes de la llista de classificació de Llibreviu.
CRÍTIC: Per determinar el tema correcte, analitza detingudament no només els temes originals del catàleg, sinó també el títol del llibre i el nom de l'autor. Has de deduir de forma holística el camp acadèmic o professió de l'autor i la intenció real del títol. Per exemple, si l'autor és un reconegut historiador, el llibre s'ha de classificar com a "Història" (i no com a "Economia"), encara que tracti temes d'història econòmica o social.

Dades del llibre:
- Títol: ${book.title || ''}
- Autor: ${book.authors || book.author || ''}
- Editorial: ${book.publisher || book.editorial || ''}
- Any: ${book.year || book.publishYear || ''}
- Temes/Matèries originals: ${book.subjects || ''}

Llista de temes de Llibreviu:
${optionsStr}

Selecciona el tema de Llibreviu més adequat per a aquest llibre. Retorna un objecte JSON amb el següent format:
{
  "value": "el valor de la opció seleccionada",
  "text": "el text de la opció seleccionada"
}
Retorna únicament l'objecte JSON pur, sense blocs de codi markdown ni cap altre text explicatiu.`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Error de l'API de Gemini (${response.status}): ${errText}`);
    }

    const result = await response.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("No s'ha pogut obtenir la resposta de Gemini per al tema.");
    }
    return JSON.parse(text.trim());
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function selectCandidate(book, index) {
  const statusMsg = document.getElementById('status-message');
  console.log("Llibre seleccionat al mòbil:", book.title);
  
  const baseUrl = resolveBaseUrl();
  
  // Mostrem feedback visual de càrrega
  const listContainer = document.getElementById('candidates-list');
  if (listContainer) {
    listContainer.innerHTML = '<div class="spinner"></div><div style="text-align:center; color:#aaa; margin-top:10px;">Classificant el tema amb Gemini i connectant...</div>';
  }

  // 1. Obtenim els temes de l'ordinador si estan disponibles per classificar abans d'enviar
  if (baseUrl) {
    try {
      const stateRes = await fetch(buildApiUrl(`/api/session-state?t=${Date.now()}`), { cache: 'no-store' });
      if (stateRes.ok) {
        const stateData = await stateRes.json();
        if (stateData && stateData.formData && stateData.formData._selectOptions && stateData.formData._selectOptions.id_tema) {
          const themeOptions = stateData.formData._selectOptions.id_tema;
          if (themeOptions.length > 0) {
            console.log("🤖 Classificant el tema amb Gemini des del mòbil...");
            const apiKey = localStorage.getItem('gemini-api-key') || '';
            try {
              const classification = await classifyThemeWithGemini(book, themeOptions, apiKey);
              if (classification && classification.value !== undefined) {
                book.id_tema = classification.value;
                console.log(`✅ Tema seleccionat per Gemini des del mòbil: "${classification.text}" (valor: ${classification.value})`);
              }
            } catch (geminiErr) {
              console.warn("⚠️ Error classificant el tema amb Gemini des del mòbil:", geminiErr);
            }
          }
        }
      }
    } catch (e) {
      console.warn("⚠️ Error recuperant l'estat per obtenir els temes des del mòbil:", e);
    }
  }

  const payload = { index, book };

  if (baseUrl) {
    try {
      await fetch(buildApiUrl('/api/select-book'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      console.error("Error enviant selecció local:", e);
    }
  }
}

function renderFormFields(formData) {
  const container = document.getElementById('form-fields-container');
  if (!container) return;
  container.innerHTML = '';
  
  // Inicialitzem l'estat del botó de bloqueig del PC
  updatePcLockUI();
  
  // Inicialitzem l'estat de la portada
  currentCoverBase64 = formData._cover_image || null;
  const formPreview = document.getElementById('form-cover-preview');
  const formPlaceholder = document.getElementById('form-cover-placeholder');
  if (formPreview && formPlaceholder) {
    if (currentCoverBase64) {
      formPreview.src = currentCoverBase64;
      formPreview.style.display = 'block';
      formPlaceholder.style.display = 'none';
      
      formPreview.onerror = () => {
        formPreview.style.display = 'none';
        formPlaceholder.style.display = 'block';
        formPlaceholder.innerText = "⚡ Portada ja existent al formulari";
        formPlaceholder.style.color = "#27ae60";
        formPlaceholder.style.fontWeight = "bold";
      };
    } else {
      formPreview.src = '';
      formPreview.style.display = 'none';
      formPlaceholder.style.display = 'block';
      formPlaceholder.innerText = "Sense portada";
      formPlaceholder.style.color = "#777";
      formPlaceholder.style.fontWeight = "normal";
    }
  }
  
  activeRequiredFields = formData._requiredFields || ['id_titol', 'id_tema'];
  const selectOptions = formData._selectOptions || {};
  
  for (const [fieldId, val] of Object.entries(formData)) {
    if (fieldId.startsWith('_')) continue;
    
    const group = document.createElement('div');
    group.className = 'form-group';
    
    const labelText = fieldLabels[fieldId] || fieldId.replace('id_', '').toUpperCase();
    const label = document.createElement('label');
    if (activeRequiredFields.includes(fieldId)) {
      label.innerHTML = `${labelText} <span style="color: #e74c3c;">*</span>`;
    } else {
      label.innerText = labelText;
    }
    
    let input;
    if (selectOptions[fieldId]) {
      input = document.createElement('select');
      selectOptions[fieldId].forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.innerText = opt.text;
        if (String(opt.value) === String(val)) {
          option.selected = true;
        }
        input.appendChild(option);
      });
    } else if (fieldId === 'id_notes') {
      input = document.createElement('textarea');
      input.rows = 3;
    } else {
      input = document.createElement('input');
      input.type = 'text';
    }
    input.id = `edit-${fieldId}`;
    if (!selectOptions[fieldId]) {
      input.value = val || '';
    }
    
    group.appendChild(label);
    group.appendChild(input);
    container.appendChild(group);
  }
}

async function submitMobileForm() {
  const container = document.getElementById('form-fields-container');
  if (!container) return;
  
  // Bloquegem el botó de desar per evitar clics duplicats
  const btnSave = document.getElementById('btn-save-form');
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerText = 'Desant...';
  }

  const inputs = container.querySelectorAll('input, textarea, select');
  const updatedData = {};
  const missingFields = [];
  
  inputs.forEach(input => {
    const fieldId = input.id.replace('edit-', '');
    const value = input.value ? input.value.trim() : '';
    updatedData[fieldId] = value;
    
    if (activeRequiredFields.includes(fieldId) && !value) {
      const labelText = fieldLabels[fieldId] || fieldId.replace('id_', '').toUpperCase();
      missingFields.push(labelText.replace(' (*)', ''));
    }
  });
  
  if (missingFields.length > 0) {
    alert(`Falten camps obligatoris per omplir:\n\n• ${missingFields.join('\n• ')}\n\nSi us plau, omple'ls abans de desar.`);
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerText = '💾 Desar a BD';
    }
    return;
  }
  
  updatedData._cover_image = currentCoverBase64;
  
  const baseUrl = resolveBaseUrl();
  
  const payload = { formData: updatedData };
  
  if (baseUrl) {
    try {
      await fetch(buildApiUrl('/api/submit-form'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      originalError.apply(console, ["Error enviant formulari local:", e]);
    }
  }
  
}

async function resetMobileWorkflow() {
  const baseUrl = resolveBaseUrl();
  
  // Restablim els botons de desar
  const btnSave = document.getElementById('btn-save-form');
  if (btnSave) {
    btnSave.disabled = false;
    btnSave.innerText = '💾 Desar a BD';
  }

  if (historyDepth > 0) {
    isProgrammaticBack = true;
    const backSteps = historyDepth;
    historyDepth = 0;
    history.go(-backSteps);
  }

  if (baseUrl) {
    try {
      await fetch(buildApiUrl('/api/reset-state'), { method: 'POST' });
    } catch (e) {
      originalError.apply(console, ["Error resetting state local:", e]);
    }
  }
  
}

function renderOutcome(outcome) {
  const iconEl = document.getElementById('outcome-icon');
  const titleEl = document.getElementById('outcome-title');
  const messageEl = document.getElementById('outcome-message');
  
  if (!iconEl || !titleEl || !messageEl) return;
  
  if (outcome && outcome.success) {
    iconEl.innerText = '✅';
    iconEl.style.color = '#27ae60';
    titleEl.innerText = outcome.title || 'Llibre desat!';
    messageEl.innerText = outcome.message || (outcome && outcome.error) || 'La fitxa s\'ha registrat correctament.';
  } else {
    iconEl.innerText = '❌';
    iconEl.style.color = '#e74c3c';
    titleEl.innerText = outcome.title || 'Error al desar';
    messageEl.innerText = (outcome && outcome.error) ? outcome.error : 'Hi ha hagut un problema en desar la fitxa a la base de dades.';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function togglePcLock() {
  const newLockState = !pcLocked;
  const baseUrl = resolveBaseUrl();
  console.log(`[PC Lock] Toggling PC Lock from ${pcLocked} to ${newLockState}`);
  if (baseUrl) {
    try {
      const res = await fetch(buildApiUrl('/api/set-pc-lock'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: newLockState, sid })
      });
      if (res.ok) {
        pcLocked = newLockState;
        updatePcLockUI();
      }
    } catch (e) {
      console.error("Error setting PC lock:", e);
    }
  }
}

function updatePcLockUI() {
  const btn = document.getElementById('btn-toggle-pc-lock');
  if (!btn) return;
  if (pcLocked) {
    btn.style.border = '1px solid #d35400';
    btn.style.background = 'rgba(211, 84, 0, 0.1)';
    btn.style.color = '#e67e22';
    btn.innerHTML = '🔒 Ordinador Bloquejat';
  } else {
    btn.style.border = '1px solid #27ae60';
    btn.style.background = 'rgba(39, 174, 96, 0.1)';
    btn.style.color = '#2ecc71';
    btn.innerHTML = '🔓 Ordinador Desbloquejat';
  }
}
