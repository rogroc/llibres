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

document.addEventListener('DOMContentLoaded', () => {
  const btnStart = document.getElementById('btn-start');
  const overlay = document.getElementById('start-overlay');
  
  const modeIsbn = document.getElementById('mode-isbn');
  const modePortada = document.getElementById('mode-portada');
  const btnTakePhoto = document.getElementById('btn-take-photo');
  
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
  stopPortadaCamera();
  
  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode("reader");
  }
  
  if (html5QrCode.isScanning) return;
  
  const formats = window.Html5QrcodeSupportedFormats ? [
    window.Html5QrcodeSupportedFormats.EAN_13,
    window.Html5QrcodeSupportedFormats.EAN_8
  ] : undefined;
  
  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      { 
        fps: 10, 
        qrbox: { width: 250, height: 150 },
        formatsToSupport: formats
      },
      (decodedText) => {
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
    
    // Iniciar el bucle de reconeixement OCR en segon pla
    runOcrTick();
  } catch (err) {
    document.getElementById('status-message').innerText = 'Error càmera ISBN: ' + err;
  }
}

async function stopIsbnScanner() {
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
  tesseractWorker = await Tesseract.createWorker('eng');
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
  
  // Enhance contrast & convert to grayscale to help Tesseract
  const imgData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
  const data = imgData.data;
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i+1];
    const b = data[i+2];
    
    // Grayscale
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    
    // Stretch contrast (removes shadow gray tones, darkens text, whitens paper)
    gray = (gray - 65) * (255 / 120); 
    gray = Math.max(0, Math.min(255, gray));
    
    data[i] = gray;
    data[i+1] = gray;
    data[i+2] = gray;
  }
  
  ctx.putImageData(imgData, 0, 0);
}

// OCR processing loop ticker
async function runOcrTick() {
  const diagnosticVideo = document.querySelector('#reader video');
  console.log("runOcrTick check: isScanning =", !!(html5QrCode && html5QrCode.isScanning), "mode =", currentMode, "worker =", !!tesseractWorker, "video =", !!diagnosticVideo, "readyState =", diagnosticVideo ? diagnosticVideo.readyState : "none");

  if (!html5QrCode || !html5QrCode.isScanning || currentMode !== 'isbn' || isOcrProcessing || isProcessing) {
    if (html5QrCode && html5QrCode.isScanning && currentMode === 'isbn') {
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
    console.log("OCR Text read:", text);
    
    // Inspect for valid ISBN checksums
    const isbn = cleanAndValidateISBN(text);
    if (isbn && html5QrCode && html5QrCode.isScanning && !isProcessing) {
      isProcessing = true;
      document.getElementById('status-message').innerText = 'ISBN Detectat (OCR): ' + isbn;
      sendToServer('isbn', isbn);
      setTimeout(() => { isProcessing = false; }, 3000); // Debounce
      isOcrProcessing = false;
      return; // Break OCR cycle since we found one
    }
  } catch (err) {
    console.warn("OCR worker error during frame recognition:", err);
  }
  
  isOcrProcessing = false;
  ocrTimeoutId = setTimeout(() => runOcrTick(), 600);
}
