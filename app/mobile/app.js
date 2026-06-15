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

function cleanAndValidateISBN(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.replace(/[^0-9X]/gi, '').toUpperCase();
  if (cleaned.length === 13 && isValidISBN13(cleaned)) return cleaned;
  if (cleaned.length === 10 && isValidISBN10(cleaned)) return cleaned;
  return null;
}

// App Logic
let currentMode = 'isbn'; // 'isbn' or 'portada'
let html5QrCode = null;
let stream = null;
let tesseractWorker = null;
let isProcessing = false;

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
    statusMsg.innerText = 'Enfoca un codi de barres de llibre';
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
  
  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 150 } },
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
  } catch (err) {
    document.getElementById('status-message').innerText = 'Error càmera ISBN: ' + err;
  }
}

async function stopIsbnScanner() {
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
  tesseractWorker = await Tesseract.createWorker('cat+spa+eng');
  document.getElementById('status-message').innerText = currentMode === 'isbn' ? 'Enfoca un codi de barres de llibre' : 'Enfoca la portada i fes una foto';
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

async function sendToServer(type, value) {
  try {
    const hostname = window.location.hostname;
    // Call the python server api/scan
    await fetch(`https://${hostname}:8443/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, value })
    });
    
    if (navigator.vibrate) navigator.vibrate(200); // Haptic feedback
  } catch (e) {
    console.error('Error enviant dades', e);
  }
}
