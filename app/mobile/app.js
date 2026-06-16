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
  // Send to server
  sendToServer('log', `[${type}] ${msg}`);
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

// Regex ISBN parsing and checksum validation
function cleanAndValidateISBN(rawText) {
  if (!rawText) return null;
  
  // 0. Comprovar si el text conté les sigles "ISBN" seguit de xifres (amb guions/espais)
  const isbnPrefixMatch = rawText.match(/isbn\s*:?\s*([0-9Xx -]{10,25})/i);
  if (isbnPrefixMatch) {
    const candidate = isbnPrefixMatch[1].replace(/[^0-9X]/gi, '').toUpperCase();
    if (candidate.length === 13 && isValidISBN13(candidate)) return candidate;
    if (candidate.length === 10 && isValidISBN10(candidate)) return candidate;
  }
  
  // 1. Remove obvious punctuation but keep digits and X. This merges all numbers on the page into a single string.
  let cleaned = rawText.replace(/[^0-9X]/gi, '').toUpperCase();
  
  // 2. Direct exact match (if the entire page is exactly one code)
  if (cleaned.length === 13 && isValidISBN13(cleaned)) return cleaned;
  if (cleaned.length === 10 && isValidISBN10(cleaned)) return cleaned;

  // 3. Search inside the raw text with standard hyphens/spaces (Preserves word boundaries to avoid false positives)
  let matches13 = rawText.match(/\b(?:97[89][ -]*)(?:\d[ -]*){9}\d\b/gi) || [];
  for (let m of matches13) {
    let d = m.replace(/[^0-9]/g, '');
    if (isValidISBN13(d)) return m.replace(/\s+/g, ''); // Preserve dashes, remove spaces!
  }
  
  let matches10 = rawText.match(/\b(?:\d[ -]*){9}[\dX]\b/gi) || [];
  for (let m of matches10) {
    let d = m.replace(/[^0-9X]/gi, '').toUpperCase();
    if (isValidISBN10(d)) return m.replace(/\s+/g, ''); // Preserve dashes, remove spaces!
  }
  
  // 4. SUPER ROBUST FALLBACK (La solució definitiva): 
  // Look for any 13-digit sequence starting with 978 or 979
  let clean13 = cleaned.match(/97[89]\d{10}/g) || [];
  for (let d of clean13) {
    if (isValidISBN13(d)) return d;
  }
  
  // Look for any 10-digit sequence
  let clean10 = cleaned.match(/\d{9}[\dX]/g) || [];
  for (let d of clean10) {
    if (isValidISBN10(d)) return d;
  }

  return null;
}

// App Logic
let currentMode = 'isbn'; // 'isbn' or 'portada'
let html5QrCode = null;
let stream = null;
let tesseractWorker = null;
let isProcessing = false;
let ocrTimeoutId = null;
let isOcrProcessing = false;
let isScannerActive = false;

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
    
    // Envia un ping de connexió immediat i un de periòdic cada 3 segons (heartbeat)
    sendToServer('connection', 'connected');
    setInterval(() => {
      sendToServer('connection', 'connected');
    }, 3000);
  });
  
  modeIsbn.addEventListener('click', () => switchMode('isbn'));
  modePortada.addEventListener('click', () => switchMode('portada'));
  
  btnTakePhoto.addEventListener('click', () => processPortada());
});

function switchMode(mode) {
  currentMode = mode;
  document.getElementById('mode-isbn').classList.toggle('active', mode === 'isbn');
  document.getElementById('mode-portada').classList.toggle('active', mode === 'portada');
  
  document.getElementById('scanner-view').classList.toggle('active', mode === 'isbn');
  document.getElementById('ocr-view').classList.toggle('active', mode === 'portada');
  
  const statusMsg = document.getElementById('status-message');
  
  if (mode === 'isbn') {
    statusMsg.innerText = "Enfoca un codi de barres o el text de l'ISBN";
    startIsbnScanner();
  } else {
    statusMsg.innerText = 'Enfoca la portada i fes una foto';
    startPortadaCamera();
  }
}

async function initCamera() {
  switchMode('isbn');
}

async function startIsbnScanner() {
  console.log("startIsbnScanner: Iniciant...");
  stopPortadaCamera();
  
  if (!html5QrCode) {
    console.log("startIsbnScanner: Creant instància Html5Qrcode...");
    html5QrCode = new Html5Qrcode("reader");
  }
  
  console.log("startIsbnScanner: Estat isScannerActive =", isScannerActive);
  if (isScannerActive) {
    console.log("startIsbnScanner: Ja està escanejant. Ignorant start.");
    return;
  }
  
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
      (decodedText) => {
        console.log("Barcode detectat:", decodedText);
        if (isProcessing) return;
        const isbn = cleanAndValidateISBN(decodedText);
        if (isbn) {
          isProcessing = true;
          document.getElementById('status-message').innerText = 'ISBN Detectat: ' + isbn;
          sendToServer('isbn', isbn);
          setTimeout(() => { isProcessing = false; }, 3000); // Debounce
        }
      },
      (errorMessage) => {}
    );
    
    isScannerActive = true;
    console.log("startIsbnScanner: html5QrCode.start iniciat amb èxit. Cridant runOcrTick...");
    runOcrTick();
  } catch (err) {
    console.error("Error startIsbnScanner:", err);
    document.getElementById('status-message').innerText = 'Error càmera ISBN: ' + err;
  }
}

async function stopIsbnScanner() {
  isScannerActive = false;
  if (ocrTimeoutId) {
    clearTimeout(ocrTimeoutId);
    ocrTimeoutId = null;
  }
  if (html5QrCode && html5QrCode.isScanning) {
    await html5QrCode.stop();
  }
}

async function startPortadaCamera() {
  await stopIsbnScanner();
  
  const video = document.getElementById('ocr-video');
  const btnTakePhoto = document.getElementById('btn-take-photo');
  const previewContainer = document.getElementById('ocr-preview-container');
  
  video.style.display = 'block';
  previewContainer.style.display = 'none';
  btnTakePhoto.style.display = 'block';
  
  try {
    stream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: 'environment' } 
    });
    video.srcObject = stream;
  } catch (err) {
    document.getElementById('status-message').innerText = 'Error càmera Portada: ' + err;
  }
}

function stopPortadaCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  const video = document.getElementById('ocr-video');
  video.style.display = 'none';
  document.getElementById('btn-take-photo').style.display = 'none';
}

async function initTesseract() {
  document.getElementById('status-message').innerText += ' (Carregant OCR...)';
  try {
    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status) {
          console.log(`[Tesseract] ${m.status}: ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`);
        }
      }
    });
    console.log("Tesseract Worker inicialitzat correctament.");
  } catch (err) {
    console.error("Error inicialitzant Tesseract:", err);
  }
  document.getElementById('status-message').innerText = currentMode === 'isbn' ? "Enfoca un codi de barres o el text de l'ISBN" : 'Enfoca la portada i fes una foto';
}

async function processPortada() {
  if (!tesseractWorker) {
    alert("L'OCR encara s'està carregant. Espera uns segons.");
    return;
  }
  
  const video = document.getElementById('ocr-video');
  const canvas = document.getElementById('ocr-canvas');
  const ctx = canvas.getContext('2d');
  
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  // Convert to image for preview
  const imgDataUrl = canvas.toDataURL('image/jpeg');
  document.getElementById('ocr-preview').src = imgDataUrl;
  document.getElementById('ocr-preview-container').style.display = 'block';
  video.style.display = 'none';
  document.getElementById('btn-take-photo').style.display = 'none';
  
  document.getElementById('status-message').innerText = '⏳ Extreient text...';
  
  try {
    // Restablir el whitelist de caràcters per extreure text lliure a la portada
    await tesseractWorker.setParameters({
      tesseract_char_whitelist: ''
    });
    
    const { data: { text } } = await tesseractWorker.recognize(imgDataUrl);
    document.getElementById('status-message').innerText = '✅ Text extret. Enviant...';
    sendToServer('portada', text);
    
    // Reset view after 3 seconds
    setTimeout(() => {
      if (currentMode === 'portada') startPortadaCamera();
    }, 3000);
  } catch (err) {
    document.getElementById('status-message').innerText = '❌ Error OCR: ' + err.message;
  }
}

function showCertWarning(apiUrl) {
  const statusMsg = document.getElementById('status-message');
  statusMsg.innerHTML = `
    <div style="background: #ffebeb; border: 1px solid #ffccd0; padding: 12px; border-radius: 8px; margin: 10px 0; color: #d32f2f; font-size: 0.95rem; text-align: left; line-height: 1.4;">
      <strong>⚠️ Error de certificat SSL:</strong><br>
      El mòbil està bloquejant la connexió segura provisional amb l'ordinador.<br><br>
      <a href="${apiUrl}/api/ip" target="_blank" style="display: block; text-align: center; background: #d32f2f; color: white; padding: 10px; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 5px;">
        Clica aquí per autoritzar el certificat
      </a>
      <span style="font-size: 0.85rem; color: #555; display: block; margin-top: 8px;">
        (Fes clic a <strong>"Avançat"</strong> i després a <strong>"Accedir a..."</strong> o <strong>"Continuar"</strong>. Després torna a aquesta pestanya i torna a escanejar.)
      </span>
    </div>
  `;
}

async function sendToServer(type, value) {
  const urlParams = new URLSearchParams(window.location.search);
  const apiParam = urlParams.get('api');
  const sid = urlParams.get('sid');
  const baseUrl = apiParam ? apiParam : '';
  
  let localSuccess = false;
  let ntfySuccess = false;
  
  // 1. Envia al servidor local Python si està configurat
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
  
  // 2. Envia a ntfy.sh com a canal de comunicació universal
  if (sid) {
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
  
  // Si qualsevol de les dues vies té èxit, considerem que és correcte
  if (localSuccess || ntfySuccess) {
    const statusMsg = document.getElementById('status-message');
    if (statusMsg.querySelector('div') && type === 'connection') {
      statusMsg.innerText = currentMode === 'isbn' ? "Enfoca un codi de barres o el text de l'ISBN" : 'Enfoca la portada i fes una foto';
    }
    
    if (navigator.vibrate && type !== 'connection') {
      navigator.vibrate(200);
    }
  } else {
    // Si ambdues fallen, mostrem l'error
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
    
    // Limit charlist to speed up recognition
    await tesseractWorker.setParameters({
      tesseract_char_whitelist: '0123456789-ISBNisbnXx '
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
        document.getElementById('status-message').innerText = 'ISBN Detectat (OCR): ' + isbn;
        sendToServer('isbn', isbn);
        setTimeout(() => { isProcessing = false; }, 3000); // Debounce
        isOcrProcessing = false;
        return; // Break OCR cycle since we found one
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
