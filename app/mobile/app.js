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
let currentFacingMode = 'environment'; // 'environment' or 'user'
let decommissionActive = sessionStorage.getItem('llibreviu_decommission_active') === 'true';
let decommissionHtml5QrCode = null;
let isDecommissionScannerActive = false;
let previousHasKey = null;
let html5QrCode = null;
let stream = null;
let isTorchOn = false;
let isCoverTorchOn = false;
let isDecommissionTorchOn = false;
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
    try {
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
      if (decommissionActive) {
        startDecommissionWorkflow();
      }
    } catch (err) {
      console.error("[btnStart Click Error]", err);
    }
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
          if (capabilities && capabilities.torch) {
            if (decommissionActive) {
              isDecommissionTorchOn = chkAutoFlash.checked;
            } else {
              isTorchOn = chkAutoFlash.checked;
            }
            await track.applyConstraints({
              advanced: [{ torch: chkAutoFlash.checked }]
            });
            if (!decommissionActive) {
              updateTorchBtnUI();
            }
          }
        }
      } catch (err) {
        console.warn("No s'ha pogut aplicar el flash immediatament en canviar l'interruptor:", err);
      }
    });
  }
  const btnDecommissionNav = document.getElementById('btn-decommission-nav');
  btnDecommissionNav?.addEventListener('click', () => {
    if (decommissionActive) {
      stopDecommissionWorkflow();
    } else {
      startDecommissionWorkflow();
    }
  });

  const btnDecommissionScanTrigger = document.getElementById('btn-decommission-scan-trigger');
  btnDecommissionScanTrigger?.addEventListener('click', () => triggerDecommissionOcr());

  const btnDecommissionCancelSearch = document.getElementById('btn-decommission-cancel-search');
  btnDecommissionCancelSearch?.addEventListener('click', async () => {
    try {
      await fetch(buildApiUrl('/api/decommission/reset'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: sid })
      });
    } catch (e) {
      console.error(e);
    }
    await startDecommissionWorkflow();
  });



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

  // Cover capture mode switch (full vs quadrant)
  const switchCoverMode = document.getElementById('switch-cover-mode');
  const labelCoverFull = document.getElementById('label-cover-full');
  const labelCoverQuadrant = document.getElementById('label-cover-quadrant');
  const coverQuadrantsOverlay = document.getElementById('cover-quadrants-overlay');
  const coverNormalBorder = document.getElementById('cover-normal-border');



  function updateCoverCaptureModeUI(isQuadrant) {
    updateVideoQuadrantStyle(isQuadrant);
    if (isQuadrant) {
      if (labelCoverFull) labelCoverFull.style.color = '#888';
      if (labelCoverQuadrant) labelCoverQuadrant.style.color = '#2ecc71';
      if (coverQuadrantsOverlay) coverQuadrantsOverlay.style.display = 'block';
      if (coverNormalBorder) coverNormalBorder.style.display = 'none';
    } else {
      if (labelCoverFull) labelCoverFull.style.color = '#2ecc71';
      if (labelCoverQuadrant) labelCoverQuadrant.style.color = '#888';
      if (coverQuadrantsOverlay) coverQuadrantsOverlay.style.display = 'none';
      if (coverNormalBorder) coverNormalBorder.style.display = 'block';
    }
  }

  if (switchCoverMode) {
    const isQuadrant = localStorage.getItem('llibreviu_cover_capture_mode') === 'quadrant';
    switchCoverMode.checked = isQuadrant;
    updateCoverCaptureModeUI(isQuadrant);

    switchCoverMode.addEventListener('change', (e) => {
      const checked = e.target.checked;
      localStorage.setItem('llibreviu_cover_capture_mode', checked ? 'quadrant' : 'full');
      updateCoverCaptureModeUI(checked);
      applyCoverCameraZoom(checked);
    });

    labelCoverFull?.addEventListener('click', () => {
      switchCoverMode.checked = false;
      localStorage.setItem('llibreviu_cover_capture_mode', 'full');
      updateCoverCaptureModeUI(false);
      applyCoverCameraZoom(false);
    });

    labelCoverQuadrant?.addEventListener('click', () => {
      switchCoverMode.checked = true;
      localStorage.setItem('llibreviu_cover_capture_mode', 'quadrant');
      updateCoverCaptureModeUI(true);
      applyCoverCameraZoom(true);
    });
  }
  const btnSwitchCamera = document.getElementById('btn-switch-camera');
  if (btnSwitchCamera) {
    btnSwitchCamera.addEventListener('click', () => switchCameraFacingMode());
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

    latestOcrEngine = savedEngine;
    latestGeminiApiKey = savedKey;
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
      const newEngine = selOcrEngine.value;
      const newKey = txtGeminiKey.value;
      
      localStorage.setItem('use-paddle-ocr', newEngine === 'local-hybrid' ? 'true' : 'false');
      settingsOverlay.style.display = 'none';
      console.log(`[OCR Settings] Saving and syncing settings: engine=${newEngine}`);
      
      syncOcrSettings(newEngine, newKey);
      checkApiKeyWarning();
      
      // Envia la configuració al servidor per sincronitzar amb l'ordinador!
      fetch(buildApiUrl('/api/session-state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: sid, ocr_engine: newEngine, gemini_api_key: newKey })
      }).catch(err => console.error("Error enviant configuració al servidor:", err));
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
  checkApiKeyWarning();
  
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
  if (decommissionActive) return;
  switchMode('isbn');
}

async function startIsbnScanner() {
  if (decommissionActive) {
    console.log("startIsbnScanner: Ignorat perquè decommissionActive és true");
    return;
  }
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
  
  const selectedCamera = { facingMode: currentFacingMode };
  console.log(`startIsbnScanner: Cridant html5QrCode.start amb mode ${currentFacingMode}...`);
  try {
    await html5QrCode.start(
      selectedCamera,
      { 
        fps: 10, 
        qrbox: (width, height) => {
          console.log(`qrbox callback: width=${width}, height=${height}`);
          const w = width || 300;
          const h = height || 200;
          return {
            width: Math.max(100, Math.round(w * 0.75)),
            height: Math.max(50, Math.round(h * 0.35))
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
    
    if (decommissionActive) {
      console.log("startIsbnScanner: decommissionActive is true, stopping scanner immediately.");
      isScannerActive = false;
      try { await html5QrCode.stop(); } catch(e) {}
      return;
    }
    
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
  if (decommissionActive) {
    console.log("startPortadaCamera: Ignorat perquè decommissionActive és true");
    return;
  }
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
      // Intent 1: Càmera seleccionada amb resolució alta (ideal 4K)
      stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: currentFacingMode,
          width: { ideal: 3840 },
          height: { ideal: 2160 }
        } 
      });
    } catch (err1) {
      console.warn(`[Camera] Error amb restriccions 4K (${currentFacingMode}), provant restriccions estàndard...`, err1);
      try {
        // Intent 2: Càmera estàndard
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: currentFacingMode }
        });
      } catch (err2) {
        console.warn(`[Camera] Error amb càmera (${currentFacingMode}), provant qualsevol càmera disponible...`, err2);
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
  if (decommissionActive) return;
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
      if (decommissionActive) {
        statusMsg.innerText = "Donar de baixa: Escanejar Codi";
      } else {
        statusMsg.innerText = currentMode === 'isbn' ? "Enfoca un codi de barres o el text de l'ISBN" : 'Enfoca la portada i fes una foto';
      }
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
  if (decommissionActive) {
    return getActiveDecommissionTrack();
  }
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
    try {
      const capabilities = track.getCapabilities();
      if (capabilities && capabilities.torch) {
        supported = true;
      }
    } catch (e) {}
  }
  
  if (supported) {
    switchContainer.style.display = 'inline-flex';
    
    const chkAutoFlash = document.getElementById('chk-auto-flash');
    const shouldTorchBeOn = chkAutoFlash ? chkAutoFlash.checked : false;
    
    if (shouldTorchBeOn) {
      if (!isTorchOn) {
        isTorchOn = true;
        try {
          track.applyConstraints({
            advanced: [{ torch: true }]
          }).catch(err => console.warn("No s'ha pogut auto-activar el flash de fons:", err));
        } catch (e) {
          console.warn("[Camera] Error aplicant constraints de flash:", e);
        }
      }
    } else {
      if (isTorchOn) {
        isTorchOn = false;
        try {
          track.applyConstraints({
            advanced: [{ torch: false }]
          }).catch(err => {});
        } catch (e) {
          console.warn("[Camera] Error aplicant constraints de flash:", e);
        }
      }
    }
  } else {
    switchContainer.style.display = 'none';
  }
}

// Helpers per activar / desactivar la càmera
function isCameraActive() {
  if (decommissionActive) {
    return isDecommissionScannerActive;
  }
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
    if (decommissionActive) {
      await stopDecommissionScanner();
    } else if (currentMode === 'isbn') {
      await stopIsbnScanner();
    } else {
      stopPortadaCamera();
    }
    statusMsg.innerText = "📷 Càmera desactivada. Clica per activar-la de nou.";
  } else {
    console.log("[Camera] Re-activant càmera...");
    if (decommissionActive) {
      await startDecommissionScanner();
      statusMsg.innerText = "Enquadra el número ID de la casella";
    } else if (currentMode === 'isbn') {
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
    btnToggleCamera.innerText = "📷 Apagar càmera";
    btnToggleCamera.style.border = "1px solid #3498db";
    btnToggleCamera.style.background = "#ebf5fb";
    btnToggleCamera.style.color = "#2980b9";
    if (decommissionActive) {
      updateDecommissionTorchBtnUI();
    } else {
      updateTorchBtnUI();
    }
  } else {
    btnToggleCamera.style.display = 'inline-flex';
    btnToggleCamera.innerText = "📷 Encendre càmera";
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

function updateVideoQuadrantStyle(isQuadrant) {
  const video = document.getElementById('cover-video');
  if (!video) return;
  // Sempre utilitzem el 100% de la mida del visor, evitant reducció de zoom per software a la previsualització de vídeo
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.position = 'relative';
  video.style.top = 'auto';
  video.style.left = 'auto';
}

async function applyCoverCameraZoom(isQuadrant) {
  const track = getActiveCoverTrack();
  if (!track || typeof track.getCapabilities !== 'function') return;
  try {
    const capabilities = track.getCapabilities();
    if (capabilities.zoom) {
      // Foto normal: zoom 1.0 (sense cap augment)
      // Foto quadrant: reduïm el zoom al mínim possible del sensor (p.ex. 0.5x o 0.6x en gran angular si està disponible, o 1.0x)
      const targetZoom = isQuadrant ? capabilities.zoom.min : 1.0;
      await track.applyConstraints({
        advanced: [{ zoom: targetZoom }]
      });
      console.log(`[Cover Camera] Applied zoom: ${targetZoom}x (isQuadrant=${isQuadrant}, minZoom=${capabilities.zoom.min})`);
    }
  } catch (err) {
    console.warn("[Cover Camera] Failed to apply zoom:", err);
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
          facingMode: currentFacingMode,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } 
      });
    } catch (err1) {
      console.warn(`[Cover Camera] Error with ideal specs (${currentFacingMode}), trying standard...`, err1);
      try {
        coverStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: currentFacingMode }
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
    
    // Apliquem el zoom inicial correcte segons la preferència de mode de captura
    const isQuadrant = localStorage.getItem('llibreviu_cover_capture_mode') === 'quadrant';
    updateVideoQuadrantStyle(isQuadrant);
    await applyCoverCameraZoom(isQuadrant);
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
  
  let finalCropX = (videoW - cropWidth) / 2;
  let finalCropY = (videoH - cropHeight) / 2;
  let finalCropW = cropWidth;
  let finalCropH = cropHeight;
  
  // Si és mode quadrant, no fem zoom per software a la previsualització, sinó que retallem el quadrant superior esquerre (1/4 de la mida) de la imatge útil
  const isQuadrant = localStorage.getItem('llibreviu_cover_capture_mode') === 'quadrant';
  if (isQuadrant) {
    finalCropW = finalCropW / 2;
    finalCropH = finalCropH / 2;
  }
  
  // Limitem la dimensió de sortida (alçada màxima de 1000px per a rendiment)
  const destHeight = Math.min(finalCropH, MAX_DIM);
  const destWidth = destHeight * targetRatio;
  
  canvas.width = destWidth;
  canvas.height = destHeight;
  
  // Dibuixem només la part corresponent de la imatge
  ctx.drawImage(
    video, 
    finalCropX, finalCropY, finalCropW, finalCropH, // Font (zona central o quadrant nord-oest)
    0, 0, destWidth, destHeight                    // Destí (canvas)
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
        syncOcrSettings(data.ocr_engine, data.gemini_api_key);
        checkApiKeyWarning();
        
        if (decommissionActive) {
          handleDecommissionStateSync(data);
        } else {
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
              syncOcrSettings(detailData.ocr_engine, detailData.gemini_api_key);
              handleStateTransition(detailData);
            }
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
  syncOcrSettings(data.ocr_engine, data.gemini_api_key);
  checkApiKeyWarning();
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
  if (decommissionActive) {
    const allViews = ['scanner-view', 'ocr-view', 'searching-view', 'selection-view', 'editing-view', 'outcome-view', 'decommission-view', 'decommission-results-view'];
    allViews.forEach(v => {
      const el = document.getElementById(v);
      if (el) {
        el.style.display = 'none';
        el.classList.remove('active');
      }
    });
    
    let activeViewId = 'decommission-view';
    if (state === 'searching') {
      activeViewId = 'searching-view';
    } else if (state === 'selection') {
      activeViewId = 'decommission-results-view';
    }
    
    const activeViewEl = document.getElementById(activeViewId);
    if (activeViewEl) {
      activeViewEl.style.display = 'flex';
      activeViewEl.classList.add('active');
    }
    
    // Gestió de controls de capçalera i càmera en mode baixa
    const cameraControls = document.getElementById('btn-toggle-camera')?.parentNode;
    const statusMsg = document.getElementById('status-message');
    if (state === 'scanning') {
      if (cameraControls) cameraControls.style.display = 'flex';
      if (statusMsg) statusMsg.style.display = 'block';
    } else {
      if (cameraControls) cameraControls.style.display = 'none';
      if (statusMsg) statusMsg.style.display = 'none';
    }
    updateCameraToggleBtnUI();
    return;
  }

  const views = {
    'scanning': currentMode === 'isbn' ? 'scanner-view' : 'ocr-view',
    'searching': 'searching-view',
    'selection': 'selection-view',
    'filling': 'searching-view',
    'editing': 'editing-view',
    'saving': 'searching-view',
    'done': 'outcome-view'
  };
  
  const allViews = ['scanner-view', 'ocr-view', 'searching-view', 'selection-view', 'editing-view', 'outcome-view', 'decommission-view', 'decommission-results-view'];
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
    activeViewEl.style.display = (activeViewId === 'ocr-view' || activeViewId === 'searching-view' || activeViewId === 'outcome-view' || activeViewId === 'decommission-view' || activeViewId === 'decommission-results-view') ? 'flex' : 'block';
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
  updateCameraToggleBtnUI();
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
    btn.innerHTML = '🔓 Desbloquejar ordinador';
  } else {
    btn.style.border = '1px solid #27ae60';
    btn.style.background = 'rgba(39, 174, 96, 0.1)';
    btn.style.color = '#2ecc71';
    btn.innerHTML = '🔒 Bloquejar ordinador';
  }
}

function syncOcrSettings(ocrEngine, geminiApiKey) {
  if (ocrEngine !== undefined) {
    latestOcrEngine = ocrEngine;
    const sel = document.getElementById('sel-ocr-engine');
    if (sel) sel.value = ocrEngine;
    localStorage.setItem('ocr-engine', ocrEngine);
  }
  if (geminiApiKey !== undefined) {
    latestGeminiApiKey = geminiApiKey;
    const txt = document.getElementById('txt-gemini-key');
    if (txt) txt.value = geminiApiKey;
    localStorage.setItem('gemini-api-key', geminiApiKey);
  }
}

function checkApiKeyWarning() {
  const warningEl = document.getElementById('api-key-warning');
  if (!warningEl) return;
  
  if (currentMode !== 'portada') {
    warningEl.style.display = 'none';
    return;
  }
  
  const checkKeyVal = (val) => {
    if (!val) return false;
    const clean = val.trim();
    return clean !== '' && clean !== '-' && clean !== 'null' && clean !== 'undefined';
  };
  
  const hasKey = checkKeyVal(latestGeminiApiKey) || checkKeyVal(localStorage.getItem('gemini-api-key')) || checkKeyVal(document.getElementById('txt-gemini-key')?.value);
  
  if (!hasKey) {
    warningEl.style.display = 'block';
    warningEl.style.backgroundColor = '#7f1d1d';
    warningEl.style.borderColor = '#ef4444';
    warningEl.style.color = '#fecaca';
    warningEl.innerHTML = `⚠️ No hi ha clau de IA introduïda. Cal introduir-la per utilitzar el mode de reconeixement de portades.`;
  } else {
    // Només mostrem el missatge verd de canvi en el moment precís de la transició (de false a true)
    if (previousHasKey === false) {
      warningEl.style.display = 'block';
      warningEl.style.backgroundColor = '#14532d';
      warningEl.style.borderColor = '#22c55e';
      warningEl.style.color = '#dcfce7';
      warningEl.innerHTML = '✅ Clau introduïda';
    } else {
      warningEl.style.display = 'none';
    }
  }
  
  previousHasKey = hasKey;
}

async function switchCameraFacingMode() {
  const oldMode = currentFacingMode;
  currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
  console.log(`[Camera] Switch camera requested. Mode: ${oldMode} -> ${currentFacingMode}`);
  
  // 1. Si l'escàner d'ISBN està actiu
  if (html5QrCode && html5QrCode.isScanning) {
    console.log("[Camera] Reiniciant escàner d'ISBN amb el nou facingMode...");
    try {
      await stopIsbnScanner();
      await startIsbnScanner();
    } catch (e) {
      console.error("[Camera] Error reiniciant escàner d'ISBN:", e);
    }
  }
  
  // 2. Si la càmera de Portada està activa
  const ocrVideo = document.getElementById('ocr-video');
  if (ocrVideo && ocrVideo.style.display !== 'none' && stream) {
    console.log("[Camera] Reiniciant càmera de Portada amb el nou facingMode...");
    try {
      stopPortadaCamera();
      await startPortadaCamera();
    } catch (e) {
      console.error("[Camera] Error reiniciant càmera de Portada:", e);
    }
  }
  
  // 3. Si la càmera de captura de portada (formulari d'edició) està activa
  const coverOverlay = document.getElementById('cover-capture-overlay');
  if (coverOverlay && coverOverlay.style.display !== 'none' && coverStream) {
    console.log("[Camera] Reiniciant càmera de captura de Portada amb el nou facingMode...");
    try {
      stopCoverCamera();
      await startCoverCamera();
    } catch (e) {
      console.error("[Camera] Error reiniciant càmera de captura de Portada:", e);
    }
  }

  // 4. Si l'escàner de baixa està actiu
  if (decommissionActive && decommissionHtml5QrCode && decommissionHtml5QrCode.isScanning) {
    console.log("[Camera] Reiniciant escàner de baixa amb el nou facingMode...");
    try {
      await stopDecommissionScanner();
      await startDecommissionScanner();
    } catch (e) {
      console.error("[Camera] Error reiniciant escàner de baixa:", e);
    }
  }
}

async function startDecommissionWorkflow() {
  decommissionActive = true;
  sessionStorage.setItem('llibreviu_decommission_active', 'true');
  // Stop normal scanner/camera
  if (currentMode === 'isbn') {
    await stopIsbnScanner();
  } else {
    stopPortadaCamera();
  }
  
  // Hide header toggle container and settings gear when decommissioning
  const toggleContainer = document.querySelector('.toggle-container');
  if (toggleContainer) toggleContainer.style.display = 'none';
  const btnSettingsGear = document.getElementById('btn-settings-gear');
  if (btnSettingsGear) btnSettingsGear.style.display = 'none';
  
  // Change header title
  const headerTitle = document.querySelector('.header h2');
  if (headerTitle) headerTitle.innerText = "Donar de baixa";
  
  // Transform decommissioning nav button into "Afegir registres"
  const btnDecommissionNav = document.getElementById('btn-decommission-nav');
  if (btnDecommissionNav) {
    btnDecommissionNav.innerText = "Afegir registres";
    btnDecommissionNav.style.background = "#2ecc71";
    btnDecommissionNav.style.color = "#000";
    btnDecommissionNav.style.display = "block";
  }
  
  // Update header status message for decommissioning
  const statusMsg = document.getElementById('status-message');
  if (statusMsg) statusMsg.innerText = "Enquadra l'ID de la targeta Llibreviu";
  
  // Switch to the decommission scanning view
  switchView('scanning');
  
  // Clear any old error message
  const errEl = document.getElementById('decommission-error-message');
  if (errEl) errEl.style.display = 'none';
  
  // Start the decommission scanner
  await startDecommissionScanner();
}

async function stopDecommissionWorkflow() {
  decommissionActive = false;
  sessionStorage.removeItem('llibreviu_decommission_active');
  await stopDecommissionScanner();
  
  const errEl = document.getElementById('decommission-error-message');
  if (errEl) errEl.style.display = 'none';
  
  // Restore header and settings gear
  const toggleContainer = document.querySelector('.toggle-container');
  if (toggleContainer) toggleContainer.style.display = 'block';
  const headerTitle = document.querySelector('.header h2');
  if (headerTitle) headerTitle.innerText = "Llibreviu Scanner";
  
  // Restore decommissioning nav button back to "Donar de baixa"
  const btnDecommissionNav = document.getElementById('btn-decommission-nav');
  if (btnDecommissionNav) {
    btnDecommissionNav.innerText = "Donar de baixa";
    btnDecommissionNav.style.background = "#e74c3c";
    btnDecommissionNav.style.color = "#fff";
    btnDecommissionNav.style.display = "block";
  }
  
  // Restore original header status message
  const statusMsg = document.getElementById('status-message');
  if (statusMsg) {
    statusMsg.innerText = currentMode === 'isbn' ? "Enfoca un codi de barres o el text de l'ISBN" : "Enfoca la portada i fes una foto";
  }
  
  // Reset the server's decommissioning state
  try {
    await fetch(buildApiUrl('/api/decommission/reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sid })
    });
  } catch (e) {
    console.error("Error resetting decommission state on server:", e);
  }
  
  // Restart regular scanner
  switchView('scanning');
  if (currentMode === 'isbn') {
    await startIsbnScanner();
  } else {
    await startPortadaCamera();
  }
}

let decommissionOcrTimeoutId = null;
let decommissionIsOcrProcessing = false;

async function startDecommissionScanner() {
  if (decommissionHtml5QrCode && decommissionHtml5QrCode.isScanning) {
    return;
  }
  
  console.log("[Decommission] Starting Html5Qrcode camera scanner...");
  
  if (!decommissionHtml5QrCode) {
    decommissionHtml5QrCode = new Html5Qrcode("decommission-reader");
  }
  
  const formats = window.Html5QrcodeSupportedFormats ? [
    window.Html5QrcodeSupportedFormats.EAN_13,
    window.Html5QrcodeSupportedFormats.EAN_8
  ] : undefined;
  
  try {
    await decommissionHtml5QrCode.start(
      { facingMode: currentFacingMode },
      {
        fps: 10,
        qrbox: (width, height) => {
          const w = width || 300;
          const h = height || 200;
          return {
            width: Math.max(100, Math.round(w * 0.75)),
            height: Math.max(50, Math.round(h * 0.45))
          };
        },
        formatsToSupport: formats
      },
      async (decodedText) => {
        console.log("[Decommission] Barcode decoded:", decodedText);
      },
      (errorMessage) => {
        // ignore
      }
    );
    
    isDecommissionScannerActive = true;
    
    // Zoom factor if supported
    try {
      const track = decommissionHtml5QrCode.getActiveCameraTrack();
      if (track && typeof track.getCapabilities === 'function') {
        const capabilities = track.getCapabilities();
        if (capabilities.zoom) {
          const targetZoom = Math.min(2.0, capabilities.zoom.max);
          await track.applyConstraints({ advanced: [{ zoom: targetZoom }] });
          console.log(`[Decommission] Zoom 2x aplicat (${targetZoom})`);
        }
      }
    } catch (e) {
      console.warn("[Decommission] Zoom apply failed:", e);
    }
    
    const chkAutoFlash = document.getElementById('chk-auto-flash');
    isDecommissionTorchOn = chkAutoFlash ? chkAutoFlash.checked : false;
    
    updateDecommissionTorchBtnUI();
    // Crides en diferit per si els dispositius més lents triguen a carregar les capacitats de la pista de vídeo
    setTimeout(() => updateDecommissionTorchBtnUI(), 500);
    setTimeout(() => updateDecommissionTorchBtnUI(), 1000);
    
    decommissionIsOcrProcessing = false;
    // L'escàner s'inicia sense bucle OCR automàtic. Ara espera a que l'usuari premi el botó manual.
    updateCameraToggleBtnUI();
  } catch (err) {
    console.error("[Decommission] Error starting Html5Qrcode:", err);
    isDecommissionScannerActive = false;
    updateCameraToggleBtnUI();
  }
}

async function stopDecommissionScanner() {
  if (decommissionOcrTimeoutId) {
    clearTimeout(decommissionOcrTimeoutId);
    decommissionOcrTimeoutId = null;
  }
  isDecommissionTorchOn = false;
  isDecommissionScannerActive = false;
  const container = document.getElementById('switch-flash-container');
  if (container) container.style.display = 'none';
  
  if (decommissionHtml5QrCode) {
    try {
      if (decommissionHtml5QrCode.isScanning) {
        const track = getActiveDecommissionTrack();
        if (track && typeof track.getCapabilities === 'function') {
          const capabilities = track.getCapabilities();
          if (capabilities.torch) {
            await track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
          }
        }
        await decommissionHtml5QrCode.stop();
      }
      decommissionHtml5QrCode.clear();
      decommissionHtml5QrCode = null;
      console.log("[Decommission] Html5Qrcode stopped and cleared.");
    } catch (e) {
      console.error("[Decommission] Error stopping decommission scanner:", e);
    }
  }
  updateCameraToggleBtnUI();
}

function getActiveDecommissionTrack() {
  if (decommissionHtml5QrCode && decommissionHtml5QrCode.isScanning) {
    try {
      const track = decommissionHtml5QrCode.getActiveCameraTrack();
      if (track) return track;
    } catch (e) {}
  }
  try {
    const video = document.querySelector('#decommission-reader video');
    if (video && video.srcObject) {
      const tracks = video.srcObject.getVideoTracks();
      if (tracks && tracks.length > 0) return tracks[0];
    }
  } catch (e) {}
  return null;
}

function updateDecommissionTorchBtnUI() {
  const container = document.getElementById('switch-flash-container');
  if (!container) return;
  
  let supported = false;
  const track = getActiveDecommissionTrack();
  if (track && typeof track.getCapabilities === 'function') {
    try {
      const capabilities = track.getCapabilities();
      if (capabilities.torch) {
        supported = true;
      }
    } catch (e) {}
  }
  
  if (supported) {
    container.style.display = 'inline-flex';
    // Apliquem la configuració en calent si està actiu l'escaner
    if (decommissionHtml5QrCode && isDecommissionScannerActive && track) {
      try {
        track.applyConstraints({
          advanced: [{ torch: isDecommissionTorchOn }]
        }).catch(() => {});
      } catch (e) {
        console.warn("[Camera] Error aplicant constraints de flash de baixa:", e);
      }
    }
  } else {
    container.style.display = 'none';
  }
}

async function runDecommissionOcrTick() {
  if (decommissionOcrTimeoutId) {
    clearTimeout(decommissionOcrTimeoutId);
    decommissionOcrTimeoutId = null;
  }
  
  if (!decommissionActive || decommissionIsOcrProcessing) {
    if (decommissionActive) {
      decommissionOcrTimeoutId = setTimeout(() => runDecommissionOcrTick(), 600);
    }
    return;
  }
  
  if (!tesseractWorker) {
    decommissionOcrTimeoutId = setTimeout(() => runDecommissionOcrTick(), 1000);
    return;
  }
  
  const videoEl = document.querySelector('#decommission-reader video');
  if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
    decommissionOcrTimeoutId = setTimeout(() => runDecommissionOcrTick(), 500);
    return;
  }
  
  decommissionIsOcrProcessing = true;
  console.log("[Decommission] OCR Tick: processing frame...");
  
  try {
    const vWidth = videoEl.videoWidth;
    const vHeight = videoEl.videoHeight;
    
    // Crop area - wide and short (85% width, 25% height) to prevent left/right digit cutoff
    const cropWidth = Math.round(vWidth * 0.85);
    const cropHeight = Math.round(vHeight * 0.25);
    const cropX = Math.round((vWidth - cropWidth) / 2);
    const cropY = Math.round((vHeight - cropHeight) / 2);
    
    const canvas = document.getElementById('ocr-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 750;
    canvas.height = 220;
    ctx.drawImage(videoEl, cropX, cropY, cropWidth, cropHeight, 0, 0, 750, 220);
    
    await tesseractWorker.setParameters({
      tessedit_pageseg_mode: '7'
    });
    
    const { data: { text } } = await tesseractWorker.recognize(canvas);
    console.log("[Decommission] OCR Text read:", text.trim());
    
    // Normalize and search for: [longer number] [separator/spaces] [shorter number]
    let textCleaned = text.replace(/[\r\n]+/g, ' ').trim();
    let code = null;
    
    let leftNum = null;
    let rightNum = null;
    
    // 1. Intentem cercar basant-nos en el separador/divisió vertical detectat
    const dividerMatch = textCleaned.match(/[|/\\lI!\[\]\-=:]/);
    if (dividerMatch) {
      const dividerIndex = dividerMatch.index;
      const leftSub = textCleaned.substring(0, dividerIndex);
      const rightSub = textCleaned.substring(dividerIndex + 1);
      
      const leftNums = leftSub.match(/\d+/g);
      const rightNums = rightSub.match(/\d+/g);
      
      if (leftNums && rightNums) {
        leftNum = leftNums[leftNums.length - 1]; // El número més proper al separador per l'esquerra
        rightNum = rightNums[0]; // El número més proper al separador per la dreta
      }
    }
    
    // 2. Si no hi ha separador, o no s'ha pogut extreure per separador, busquem els dos darrers números del text
    if (!leftNum || !rightNum) {
      const allNums = textCleaned.match(/\d+/g);
      if (allNums && allNums.length >= 2) {
        leftNum = allNums[allNums.length - 2];
        rightNum = allNums[allNums.length - 1];
      }
    }
    
    // Validacions geomètriques de baixa: 
    // - El de l'esquerra (ID) ha de ser més llarg que el de la dreta (Exemplar)
    // - L'esquerra ha de ser d'almenys 3 xifres per evitar confusions amb exemplar
    if (leftNum && rightNum && leftNum.length > rightNum.length && leftNum.length >= 3) {
      code = leftNum;
      console.log(`[Decommission] OCR Layout matched! ID: ${code} (length ${leftNum.length}) > Copy: ${rightNum} (length ${rightNum.length})`);
    }
    
    if (code) {
      if (decommissionActive) {
        if (navigator.vibrate) navigator.vibrate(100);
        
        await stopDecommissionScanner();
        await sendDecommissionSearch(code);
        return;
      }
    }
  } catch (err) {
    console.warn("[Decommission] OCR worker error:", err);
  }
  
  decommissionIsOcrProcessing = false;
  decommissionOcrTimeoutId = setTimeout(() => runDecommissionOcrTick(), 50);
}

async function decommissionOcrWithGemini(fileOrBlob, apiKey) {
  const modelName = "gemini-3.1-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  const base64Data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(fileOrBlob);
  });
  
  const promptText = "Aquesta imatge és un tall de retall horizontal que conté una casella o cel·les amb números identificadors de biblioteca de Llibreviu. " +
                     "A la targeta es troben normalment dos números adjacents separats per espais o una línia vertical '|'. " +
                     "El número de l'esquerra és el codi ID del llibre (de 3 a 6 dígits), i el número de la dreta (més curt, 1 o 2 dígits) és la còpia. " +
                     "Llegeix-los i identifica'ls. Retorna un objecte JSON amb el següent format obligatori:\n" +
                     "{\n" +
                     "  \"id\": \"número de l'esquerra detectat (només dígits)\",\n" +
                     "  \"copia\": \"número de la dreta detectat (només dígits)\"\n" +
                     "}\n" +
                     "Retorna exclusivament el JSON pur, sense blocs de codi markdown ni explicacions.";

  const payload = {
    contents: [
      {
        parts: [
          { text: promptText },
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

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textResponse) throw new Error("Resposta buida de Gemini");

  console.log("[Decommission Gemini] Response text:", textResponse.trim());
  const parsed = JSON.parse(textResponse.trim());
  return parsed;
}

async function triggerDecommissionOcr() {
  const btn = document.getElementById('btn-decommission-scan-trigger');
  const errEl = document.getElementById('decommission-error-message');
  if (!btn || decommissionIsOcrProcessing) return;
  
  if (errEl) errEl.style.display = 'none';
  btn.disabled = true;
  btn.innerText = "Llegint codi... ⏳";
  
  // Efecte visual de flaix/captura sobre el contenidor del lector
  const readerEl = document.getElementById('decommission-reader');
  if (readerEl) {
    readerEl.style.opacity = '0.3';
    setTimeout(() => readerEl.style.opacity = '1', 150);
  }

  decommissionIsOcrProcessing = true;
  try {
    const videoEl = document.querySelector('#decommission-reader video');
    if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth || !videoEl.videoHeight) {
      throw new Error("La càmera encara no està a punt.");
    }
    
    const vWidth = videoEl.videoWidth;
    const vHeight = videoEl.videoHeight;
    
    // Crop area - wide and short (85% width, 25% height) to prevent left/right digit cutoff
    const cropWidth = Math.round(vWidth * 0.85);
    const cropHeight = Math.round(vHeight * 0.25);
    const cropX = Math.round((vWidth - cropWidth) / 2);
    const cropY = Math.round((vHeight - cropHeight) / 2);
    
    const canvas = document.getElementById('ocr-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 750;
    canvas.height = 220;
    ctx.drawImage(videoEl, cropX, cropY, cropWidth, cropHeight, 0, 0, 750, 220);

    let matchedCode = null;
    let textCleaned = "";

    // 1. Sempre provem de llegir localment a l'ordinador amb PaddleOCR (a través del servidor de Python)
    btn.innerText = "Enviant a l'ordinador... 🖥️";
    try {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.90);
      const ocrRes = await fetch(buildApiUrl('/api/decommission/ocr-local'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, sid: sid })
      });
      if (ocrRes.ok) {
        const ocrData = await ocrRes.json();
        if (ocrData && ocrData.id) {
          matchedCode = ocrData.id;
          console.log(`[Decommission Local PC] Matched ID: ${matchedCode}`);
        }
        textCleaned = ocrData.text || "";
      } else {
        throw new Error(`HTTP error ${ocrRes.status}`);
      }
    } catch (pcOcrErr) {
      console.warn("[Decommission] Error ocr local ordinador, provem Tesseract local mòbil:", pcOcrErr);
    }

    // 2. Fallback a Tesseract local si la crida a l'ordinador ha donat error o no ha retornat cap ID
    if (!matchedCode) {
      btn.innerText = "Llegint localment... ⏳";
      if (!tesseractWorker) {
        console.log("[Decommission] Re-inicialitzant Tesseract worker...");
        tesseractWorker = await Tesseract.createWorker('eng', 1);
      }
      await tesseractWorker.setParameters({
        tessedit_pageseg_mode: '7'
      });
      
      const { data: { text } } = await tesseractWorker.recognize(canvas);
      textCleaned = text.replace(/[\r\n]+/g, ' ').trim();
      console.log("[Decommission] Manual Tesseract OCR read:", textCleaned);
      
      let leftNum = null;
      let rightNum = null;
      
      // Intentem cercar basant-nos en el separador/divisió vertical detectat
      const dividerMatch = textCleaned.match(/[|/\\lI!\[\]\-=:]/);
      if (dividerMatch) {
        const dividerIndex = dividerMatch.index;
        const leftSub = textCleaned.substring(0, dividerIndex);
        const rightSub = textCleaned.substring(dividerIndex + 1);
        
        const leftNums = leftSub.match(/\d+/g);
        const rightNums = rightSub.match(/\d+/g);
        
        if (leftNums && rightNums) {
          leftNum = leftNums[leftNums.length - 1]; // El número més proper al separador per l'esquerra
          rightNum = rightNums[0]; // El número més proper al separador per la dreta
        }
      }
      
      // Si no hi ha separador, busquem els dos darrers números del text
      if (!leftNum || !rightNum) {
        const allNums = textCleaned.match(/\d+/g);
        if (allNums && allNums.length >= 2) {
          leftNum = allNums[allNums.length - 2];
          rightNum = allNums[allNums.length - 1];
        }
      }
      
      // Validacions geomètriques de baixa: 
      // - El de l'esquerra (ID) ha de ser més llarg que el de la dreta (Exemplar)
      // - L'esquerra ha de ser d'almenys 3 xifres per evitar confusions amb exemplar
      if (leftNum && rightNum && leftNum.length > rightNum.length && leftNum.length >= 3) {
        matchedCode = leftNum;
        console.log(`[Decommission] Tesseract Layout matched! ID: ${matchedCode} (length ${leftNum.length}) > Copy: ${rightNum} (length ${rightNum.length})`);
      }
    }
    
    if (matchedCode) {
      if (navigator.vibrate) navigator.vibrate(100);
      await stopDecommissionScanner();
      await sendDecommissionSearch(matchedCode);
    } else {
      // Error de lectura (cap coincidència coherent)
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      if (errEl) {
        errEl.innerText = textCleaned ? `Codi no detectat. Llegit: "${textCleaned.substring(0, 35)}"` : "No s'ha detectat cap número. Centra bé la targeta i torna a provar.";
        errEl.style.display = 'block';
      }
    }
  } catch (err) {
    console.error("Error manual OCR:", err);
    if (errEl) {
      errEl.innerText = "Error en el lector: " + err.message;
      errEl.style.display = 'block';
    }
  } finally {
    decommissionIsOcrProcessing = false;
    btn.disabled = false;
    btn.innerText = "📸 Fer foto i llegir codi";
  }
}

async function sendDecommissionSearch(code) {
  switchView('searching');
  
  try {
    const res = await fetch(buildApiUrl('/api/decommission/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sid, code: code })
    });
    if (!res.ok) {
      showCustomAlert("Error", "Error en iniciar la cerca de donar de baixa.", false);
      await startDecommissionWorkflow();
    }
  } catch (e) {
    console.error("Error sending decommission search:", e);
    showCustomAlert("Error de connexió", "No s'ha pogut contactar amb el servidor.", false);
    await startDecommissionWorkflow();
  }
}

let lastDecommissionStatus = "";

async function handleDecommissionStateSync(data) {
  const status = data.decommission_status || "idle";
  if (status === lastDecommissionStatus) return;
  
  console.log(`[Decommission] Status changed: ${lastDecommissionStatus} -> ${status}`);
  lastDecommissionStatus = status;
  
  if (status === 'searching') {
    await stopDecommissionScanner();
    switchView('searching');
  } else if (status === 'found') {
    await stopDecommissionScanner();
    const detailRes = await fetch(buildApiUrl(`/api/session-state?t=${Date.now()}`), { cache: 'no-store' });
    if (detailRes.ok) {
      const detailData = await detailRes.json();
      renderDecommissionCandidates(detailData.decommission_candidates || []);
      switchView('selection');
    }
  } else if (status === 'decommissioning') {
    await stopDecommissionScanner();
    switchView('searching');
    const h3 = document.querySelector('#searching-view h3');
    const p = document.querySelector('#searching-view p');
    if (h3) h3.innerText = "Donant de baixa...";
    if (p) p.innerText = "L'ordinador està executant la baixa a la intranet de Llibreviu.";
  } else if (status === 'done') {
    await showCustomAlert("Llibre donat de baixa", "Llibre donat de baixa correctament!", true);
    await fetch(buildApiUrl('/api/decommission/reset'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sid })
    });
    decommissionActive = true;
    switchView('scanning');
    await startDecommissionScanner();
  } else if (status === 'idle') {
    switchView('scanning');
    await startDecommissionScanner();
  }
}

function showCustomConfirm(title, details) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    const titleEl = document.getElementById('confirm-modal-book-title');
    const detailsEl = document.getElementById('confirm-modal-book-id');
    const btnCancel = document.getElementById('btn-confirm-modal-cancel');
    const btnOk = document.getElementById('btn-confirm-modal-ok');
    
    if (!modal || !titleEl || !detailsEl || !btnCancel || !btnOk) {
      resolve(confirm(`Confirmar baixa:\n${title}\n${details}`));
      return;
    }
    
    titleEl.innerText = title;
    detailsEl.innerText = details;
    
    // Show modal with animation
    modal.style.display = 'flex';
    modal.offsetHeight; // Force reflow
    modal.style.opacity = '1';
    modal.firstElementChild.style.transform = 'scale(1)';
    
    const cleanup = (result) => {
      modal.style.opacity = '0';
      modal.firstElementChild.style.transform = 'scale(0.9)';
      setTimeout(() => {
        modal.style.display = 'none';
      }, 300);
      
      btnCancel.onclick = null;
      btnOk.onclick = null;
      resolve(result);
    };
    
    btnCancel.onclick = () => cleanup(false);
    btnOk.onclick = () => cleanup(true);
  });
}

function showCustomAlert(title, message, isSuccess = true) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-alert-modal');
    const titleEl = document.getElementById('alert-modal-title');
    const messageEl = document.getElementById('alert-modal-message');
    const iconEl = document.getElementById('alert-modal-icon');
    const btnOk = document.getElementById('btn-alert-modal-ok');
    
    if (!modal || !titleEl || !messageEl || !iconEl || !btnOk) {
      alert(`${title}:\n${message}`);
      resolve();
      return;
    }
    
    titleEl.innerText = title;
    messageEl.innerText = message;
    
    if (isSuccess) {
      iconEl.innerText = "✅";
      iconEl.style.color = "#2ecc71";
      btnOk.style.background = "#2ecc71";
      btnOk.style.color = "#000";
      btnOk.style.boxShadow = "0 4px 10px rgba(46,204,113,0.3)";
    } else {
      iconEl.innerText = "❌";
      iconEl.style.color = "#e74c3c";
      btnOk.style.background = "#e74c3c";
      btnOk.style.color = "#fff";
      btnOk.style.boxShadow = "0 4px 10px rgba(231,76,60,0.3)";
    }
    
    modal.style.display = 'flex';
    modal.offsetHeight; // Force reflow
    modal.style.opacity = '1';
    modal.firstElementChild.style.transform = 'scale(1)';
    
    btnOk.onclick = () => {
      modal.style.opacity = '0';
      modal.firstElementChild.style.transform = 'scale(0.9)';
      setTimeout(() => {
        modal.style.display = 'none';
        resolve();
      }, 300);
      btnOk.onclick = null;
    };
  });
}

function renderDecommissionCandidates(candidates) {
  const listEl = document.getElementById('decommission-results-list');
  if (!listEl) return;
  
  listEl.innerHTML = '';
  
  if (candidates.length === 0) {
    listEl.innerHTML = '<div style="color: #fff; text-align: center; padding: 20px;">No s\'ha trobat cap llibre amb aquest codi.</div>';
    return;
  }
  
  candidates.forEach(cand => {
    const card = document.createElement('div');
    card.style.background = '#2c3e50';
    card.style.border = '1px solid #34495e';
    card.style.borderRadius = '8px';
    card.style.padding = '12px';
    card.style.color = '#fff';
    card.style.cursor = 'pointer';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '4px';
    card.style.transition = 'background 0.2s';
    
    card.innerHTML = `
      <div style="font-weight: bold; font-size: 1rem;">${cand.title || 'Sense títol'}</div>
      <div style="font-size: 0.85rem; color: #bdc3c7;">ID: ${cand.id}</div>
    `;
    
    card.addEventListener('click', async () => {
      const confirmed = await showCustomConfirm(cand.title || 'Sense títol', `ID: ${cand.id}`);
      if (confirmed) {
        selectAndConfirmDecommission(cand.id);
      }
    });
    
    listEl.appendChild(card);
  });
}

async function selectAndConfirmDecommission(candId) {
  switchView('searching');
  const h3 = document.querySelector('#searching-view h3');
  const p = document.querySelector('#searching-view p');
  if (h3) h3.innerText = "Processant la baixa...";
  if (p) p.innerText = "Enviant petició a l'ordinador.";
  
  try {
    let res = await fetch(buildApiUrl('/api/decommission/select'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sid, id: candId })
    });
    if (!res.ok) throw new Error("Error seleccionant llibre.");
    
    res = await fetch(buildApiUrl('/api/decommission/confirm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sid })
    });
    if (!res.ok) throw new Error("Error confirmant la baixa.");
  } catch (e) {
    await showCustomAlert("Error durant la baixa", e.message, false);
    switchView('selection');
  }
}
