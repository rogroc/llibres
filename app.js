// Checksum Validation Functions
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
  if (last === 'X') {
    sum += 10;
  } else {
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

function convertIsbn10To13(isbn10) {
  isbn10 = isbn10.replace(/[- ]/g, "");
  if (isbn10.length !== 10) return "";
  let base = "978" + isbn10.substring(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(base[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  let check = (10 - (sum % 10)) % 10;
  return base + check;
}

function convertIsbn13To10(isbn13) {
  isbn13 = isbn13.replace(/[- ]/g, "");
  if (isbn13.length !== 13 || !isbn13.startsWith("978")) return "";
  let base = isbn13.substring(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(base[i], 10) * (10 - i);
  }
  let check = (11 - (sum % 11)) % 11;
  let checkChar = check === 10 ? 'X' : check.toString();
  return base + checkChar;
}

function getLanguageName(code) {
  if (!code) return '';
  const clean = code.toLowerCase().trim();
  const map = {
    'spa': 'Español',
    'es': 'Español',
    'cat': 'Catalán',
    'ca': 'Catalán',
    'glg': 'Gallego',
    'gl': 'Gallego',
    'baq': 'Vasco',
    'eu': 'Vasco',
    'eng': 'Inglés',
    'en': 'Inglés',
    'fre': 'Francés',
    'fr': 'Francés',
    'ger': 'Alemán',
    'de': 'Alemán',
    'ita': 'Italiano',
    'it': 'Italiano',
    'por': 'Portugués',
    'pt': 'Portugués'
  };
  return map[clean] || code.toUpperCase();
}

function formatIsbn13FromHyphenated10(isbn10) {
  const clean13 = convertIsbn10To13(isbn10.replace(/[- ]/g, ""));
  if (!clean13) return "";
  const basePart = isbn10.substring(0, isbn10.length - 1);
  const lastChar = clean13[12];
  return "978-" + basePart + lastChar;
}

// Regex ISBN parsing and checksum validation
function cleanAndValidateISBN(rawText) {
  if (!rawText) return null;
  
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

// Web Audio API Beep Generator
function playBeep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1000, audioCtx.currentTime); // 1kHz beep
    gainNode.gain.setValueAtTime(0.12, audioCtx.currentTime);
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.12);
  } catch (e) {
    console.warn("Could not play scan sound: ", e);
  }
}

// Haptic feedback
function triggerHaptic() {
  if (navigator.vibrate) {
    navigator.vibrate(150);
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

// API Book Fetcher
async function fetchBookInfo(isbn) {
  // Use the exact ISBN (which may include dashes) for the API queries
  const googleApiUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
  const openLibraryUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  
  // Create a clean version without dashes to check if it's 10 or 13 digits
  const cleanIsbn = isbn.replace(/[^0-9X]/gi, '');
  
  let bookData = {
    isbn13: cleanIsbn.length === 13 ? isbn : '',
    isbn10: cleanIsbn.length === 10 ? isbn : '',
    title: 'Llibre desconegut',
    subtitle: '',
    authors: ['Autor desconegut'],
    publisher: 'Editorial desconeguda',
    publishedDate: '',
    description: 'No hi ha cap descripció disponible per a aquest llibre a les bases de dades de Google Books o Open Library.',
    pageCount: null,
    categories: [],
    language: '',
    coverUrl: '',
    googleBooksLink: `https://books.google.com/books?vid=ISBN${cleanIsbn}`,
    openLibraryLink: `https://openlibrary.org/isbn/${cleanIsbn}`
  };
  
  const [googleRes, olRes] = await Promise.allSettled([
    fetch(googleApiUrl).then(r => r.ok ? r.json() : null),
    fetch(openLibraryUrl).then(r => r.ok ? r.json() : null)
  ]);
  
  let googleData = googleRes.status === 'fulfilled' ? googleRes.value : null;
  let olData = olRes.status === 'fulfilled' ? olRes.value : null;
  
  let found = false;
  
  // 1. Parse Google Books API
  if (googleData && googleData.totalItems > 0) {
    found = true;
    const info = googleData.items[0].volumeInfo;
    
    bookData.title = info.title || bookData.title;
    bookData.subtitle = info.subtitle || '';
    bookData.authors = info.authors || bookData.authors;
    bookData.publisher = info.publisher || bookData.publisher;
    bookData.publishedDate = info.publishedDate || '';
    bookData.description = info.description || bookData.description;
    bookData.pageCount = info.pageCount || null;
    bookData.categories = info.categories || [];
    bookData.language = info.language || '';
    
    if (info.imageLinks) {
      bookData.coverUrl = info.imageLinks.extraLarge || 
                          info.imageLinks.large || 
                          info.imageLinks.medium || 
                          info.imageLinks.small || 
                          info.imageLinks.thumbnail || '';
    }
    
    if (info.infoLink) {
      bookData.googleBooksLink = info.infoLink;
    }
    
    if (info.industryIdentifiers) {
      for (let id of info.industryIdentifiers) {
        // Only fill if we don't already have one, to prevent Google from overwriting our scanned ISBN with a different edition's ISBN or removing dashes!
        if (id.type === 'ISBN_13' && !bookData.isbn13) bookData.isbn13 = id.identifier;
        if (id.type === 'ISBN_10' && !bookData.isbn10) bookData.isbn10 = id.identifier;
      }
    }
  }
  
  // 2. Parse Open Library API (Merge / Fallback)
  if (olData) {
    const key = `ISBN:${isbn}`;
    const cleanKey = `ISBN:${cleanIsbn}`;
    const info = olData[key] || olData[cleanKey];
    if (info) {
      found = true;
      
      if (bookData.title === 'Llibre desconegut') {
        bookData.title = info.title || bookData.title;
        bookData.subtitle = info.subtitle || '';
      }
      
      if (bookData.authors[0] === 'Autor desconegut' && info.authors) {
        bookData.authors = info.authors.map(a => a.name);
      }
      
      if (bookData.publisher === 'Editorial desconeguda' && info.publishers) {
        bookData.publisher = info.publishers.map(p => p.name).join(', ');
      }
      
      if (!bookData.publishedDate && info.publish_date) {
        bookData.publishedDate = info.publish_date;
      }
      
      if (!bookData.coverUrl && info.cover) {
        bookData.coverUrl = info.cover.large || info.cover.medium || info.cover.small || '';
      }
      
      if (!bookData.pageCount && info.number_of_pages) {
        bookData.pageCount = info.number_of_pages;
      }
      
      if (info.url) {
        bookData.openLibraryLink = info.url;
      }
    }
  }
  
  // 3. Fallback to BNE (Biblioteca Nacional de España) via user-discovered delivery API
  if (bookData.title === 'Llibre desconegut') {
    try {
      const bneUrl = `/api/bne?isbn=${cleanIsbn}`;
      const bneRes = await fetch(bneUrl).then(r => r.ok ? r.json() : null);
      if (bneRes && bneRes.docs && bneRes.docs.length > 0 && bneRes.docs[0].pnx && bneRes.docs[0].pnx.display) {
        found = true;
        const display = bneRes.docs[0].pnx.display;
        const addata = bneRes.docs[0].pnx.addata || {};
        
        if (display.title && display.title[0]) {
          bookData.title = display.title[0].split('/')[0].trim();
          bookData.specTitle = display.title[0].split('/')[0].trim();
        }
        
        let authorRaw = '';
        if (display.creator && display.creator[0]) {
          authorRaw = display.creator[0].split('$$')[0].trim();
        } else if (addata.creatorfull && addata.creatorfull[0]) {
          authorRaw = addata.creatorfull[0].split('$$')[0].trim();
        }
        
        if (authorRaw) {
          bookData.specAuthors = authorRaw;
          let cleanAuthor = authorRaw.replace(/[\d-]/g, '').trim();
          if (cleanAuthor.endsWith(',')) cleanAuthor = cleanAuthor.slice(0, -1).trim();
          if (cleanAuthor.includes(',')) {
            cleanAuthor = cleanAuthor.split(',').reverse().join(' ').trim();
          }
          bookData.authors = [cleanAuthor];
        }
        
        if (display.publisher && display.publisher[0]) {
          bookData.specPublisher = display.publisher[0].trim();
          let pub = display.publisher[0].split(':')[1];
          if (pub) pub = pub.split(',')[0].trim();
          else pub = display.publisher[0];
          bookData.publisher = pub;
        } else if (addata.pub && addata.pub[0]) {
          bookData.specPublisher = addata.pub[0];
          bookData.publisher = addata.pub[0];
        }
        
        if (display.creationdate && display.creationdate[0]) {
          bookData.publishedDate = display.creationdate[0];
          bookData.specDate = display.creationdate[0];
        }
        
        if (display.language && display.language[0]) {
          bookData.language = display.language[0];
          bookData.specLang = getLanguageName(display.language[0]);
        }
        
        if (display.format && display.format[0]) {
          bookData.specFormat = display.format[0].trim();
          const match = display.format[0].match(/(\d+)\s*p/i);
          if (match) bookData.pageCount = parseInt(match[1], 10);
        }
        
        if (display.series && display.series[0]) {
          bookData.specCollection = display.series[0].split('$$')[0].trim();
        }
        
        if (display.genre && display.genre[0]) {
          bookData.specSubjects = display.genre.map(g => g.split('$$')[0].trim()).join(', ');
        }
        
        bookData.specBinding = 'rúst.';
        if (bookData.specFormat && bookData.specFormat.toLowerCase().includes('carton')) {
          bookData.specBinding = 'cartoné (tapa dura)';
        }
        
        bookData.specPrice = '[NO DISPONIBLE]';
        
        if (addata.isbn && addata.isbn[0]) {
          const rawIsbn = addata.isbn[0];
          if (rawIsbn.replace(/[^0-9X]/gi, '').length === 10) {
            bookData.isbn10 = rawIsbn;
            bookData.isbn13 = formatIsbn13FromHyphenated10(rawIsbn);
          } else if (rawIsbn.replace(/[^0-9X]/gi, '').length === 13) {
            bookData.isbn13 = rawIsbn;
          }
        }
      }
    } catch (err) {
      console.warn("Error consultant la nova API BNE:", err);
    }
  }
  
  // Fix missing matching ISBNs
  if (cleanIsbn.length === 13) {
    if (!bookData.isbn13) bookData.isbn13 = isbn;
    if (!bookData.isbn10) bookData.isbn10 = convertIsbn13To10(cleanIsbn);
  } else {
    if (!bookData.isbn10) bookData.isbn10 = isbn;
    if (!bookData.isbn13) bookData.isbn13 = convertIsbn10To13(cleanIsbn);
  }
  
  return { found, data: bookData };
}

// App Controller Class
class ISBNApp {
  constructor() {
    this.html5QrCode = null;
    this.tesseractWorker = null;
    this.isScanning = false;
    this.scanMode = 'auto'; // 'auto', 'barcode', 'ocr'
    this.activeCameraId = null;
    this.cameras = [];
    this.torchEnabled = false;
    
    this.ocrTimeoutId = null;
    this.isOcrProcessing = false;
    this.isOcrLoading = false;
    
    // Bind UI Nodes
    this.initDOMElements();
    this.bindEvents();
    
    // Load local storage history
    this.history = JSON.parse(localStorage.getItem('isbn_scan_history') || '[]');
    this.renderHistory();
  }
  
  initDOMElements() {
    this.scannerCard = document.getElementById('scanner-section');
    this.resultsCard = document.getElementById('results-section');
    
    this.badge = document.getElementById('scanner-badge');
    this.badgeText = document.getElementById('badge-text');
    this.instructionsText = document.getElementById('scan-instructions-text');
    
    this.btnToggleCamera = document.getElementById('btn-toggle-camera');
    this.btnToggleTorch = document.getElementById('btn-toggle-torch');
    this.btnModeToggle = document.getElementById('btn-mode-toggle');
    this.btnManualInput = document.getElementById('btn-manual-input');
    this.btnPermissionHelp = document.getElementById('btn-permission-help');
    
    this.manualModal = document.getElementById('manual-modal');
    this.permissionModal = document.getElementById('permission-modal');
    this.btnClosePermissionModal = document.getElementById('btn-close-permission-modal');
    this.btnRetryPermission = document.getElementById('btn-retry-permission');
    this.btnCloseModal = document.getElementById('btn-close-modal');
    this.manualSearchForm = document.getElementById('manual-search-form');
    this.inputIsbn = document.getElementById('input-isbn');
    this.manualError = document.getElementById('manual-error');
    
    this.bookCoverContainer = document.getElementById('book-cover-container');
    this.bookTitle = document.getElementById('book-title');
    this.bookSubtitle = document.getElementById('book-subtitle');
    this.bookAuthors = document.getElementById('book-authors');
    this.metaPublisher = document.getElementById('meta-publisher');
    this.metaYear = document.getElementById('meta-year');
    this.metaPages = document.getElementById('meta-pages');
    this.metaLang = document.getElementById('meta-lang');
    this.bookDescription = document.getElementById('book-description');
    this.btnToggleDesc = document.getElementById('btn-toggle-desc');
    
    this.isbn13Value = document.getElementById('isbn13-value');
    this.isbn10Value = document.getElementById('isbn10-value');
    
    this.linkGoogleBooks = document.getElementById('link-google-books');
    this.linkOpenLibrary = document.getElementById('link-open-library');
    
    this.btnScanAgain = document.getElementById('btn-scan-again');
    this.historyList = document.getElementById('history-list');
    this.btnClearHistory = document.getElementById('btn-clear-history');
  }
  
  bindEvents() {
    // Control Buttons
    this.btnToggleCamera.addEventListener('click', () => this.switchCamera());
    this.btnToggleTorch.addEventListener('click', () => this.toggleTorch());
    this.btnModeToggle.addEventListener('click', () => this.cycleScanMode());
    this.btnManualInput.addEventListener('click', () => this.showManualModal());
    if (this.btnPermissionHelp) {
      this.btnPermissionHelp.addEventListener('click', () => this.showPermissionModal());
    }
    
    // Modal
    this.btnCloseModal.addEventListener('click', () => this.hideManualModal());
    if (this.btnClosePermissionModal) {
      this.btnClosePermissionModal.addEventListener('click', () => this.hidePermissionModal());
    }
    if (this.permissionModal) {
      this.permissionModal.addEventListener('click', (e) => {
        if (e.target === this.permissionModal) this.hidePermissionModal();
      });
    }
    if (this.btnRetryPermission) {
      this.btnRetryPermission.addEventListener('click', () => {
        this.hidePermissionModal();
        this.restartScanning();
      });
    }
    this.manualModal.addEventListener('click', (e) => {
      if (e.target === this.manualModal) this.hideManualModal();
    });
    this.manualSearchForm.addEventListener('submit', (e) => this.handleManualSubmit(e));
    
    // Copy Buttons
    document.querySelectorAll('.btn-copy').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = btn.getAttribute('data-target');
        const text = document.getElementById(targetId).innerText;
        this.copyToClipboard(text, btn);
      });
    });
    
    // Expandable description
    this.btnToggleDesc.addEventListener('click', () => {
      this.bookDescription.classList.toggle('expanded');
      this.btnToggleDesc.innerText = this.bookDescription.classList.contains('expanded') 
        ? 'Llegir menys' 
        : 'Llegir més';
    });
    
    // Action buttons
    this.btnScanAgain.addEventListener('click', () => this.restartScanning());
    this.btnClearHistory.addEventListener('click', () => this.clearHistory());
  }
  
  async start() {
    this.updateScannerStatus('Llest per començar', false);
    
    // Set up click listener on the start overlay for user gesture requirement
    const startOverlay = document.getElementById('start-camera-overlay');
    if (startOverlay) {
      startOverlay.addEventListener('click', () => {
        startOverlay.style.opacity = '0';
        setTimeout(() => {
          startOverlay.style.display = 'none';
        }, 300);
        this.initializeCamera();
      });
    } else {
      // Fallback if overlay is somehow missing
      this.initializeCamera();
    }
    
    // Lazy-load Tesseract in the background
    this.initOCRWorker();
  }
  
  async initializeCamera() {
    this.updateScannerStatus('Carregant dispositius de vídeo...', true);
    
    try {
      // Initialize html5QrCode
      this.html5QrCode = new Html5Qrcode("reader");
      
      // Request camera permissions and get cameras list
      this.cameras = await Html5Qrcode.getCameras();
      
      if (!this.cameras || this.cameras.length === 0) {
        throw new Error("No s'han trobat càmeres al dispositiu.");
      }
      
      // Auto-select back camera or the first camera
      const backCamera = this.cameras.find(cam => 
        cam.label.toLowerCase().includes('back') || 
        cam.label.toLowerCase().includes('environment') ||
        cam.label.toLowerCase().includes('darrere') ||
        cam.label.toLowerCase().includes('rear')
      );
      
      this.activeCameraId = backCamera ? backCamera.id : this.cameras[0].id;
      
      // If we only have 1 camera, hide the switch camera button
      if (this.cameras.length <= 1) {
        this.btnToggleCamera.classList.add('disabled');
        this.btnToggleCamera.setAttribute('disabled', 'true');
      }
      
      // Start the scan loop
      await this.startScanLoop();
      
    } catch (error) {
      console.error("Error starting app:", error);
      this.updateScannerStatus(`Error: ${error.message || 'Sense accés a la càmera'}`, false);
      this.instructionsText.innerHTML = "Càmera no disponible. Prem el botó <strong>🔒 Permisos</strong> a sota per a instruccions, o utilitza la cerca manual.";
      
      // Disable camera controls
      this.btnToggleCamera.classList.add('disabled');
      this.btnToggleTorch.classList.add('disabled');
      
      // Auto-open permission instructions on error
      this.showPermissionModal();
    }
  }
  
  async startScanLoop() {
    if (this.isScanning) return;
    
    this.updateScannerStatus('Iniciant càmera...', true);
    this.scannerCard.classList.add('active-scanning');
    
    const formats = window.Html5QrcodeSupportedFormats ? [
      window.Html5QrcodeSupportedFormats.EAN_13
    ] : undefined;
    
    const config = {
      fps: 15,
      qrbox: (width, height) => {
        // Match our CSS reticle size roughly (75% x 35%)
        return { 
          width: Math.round(width * 0.75), 
          height: Math.round(height * 0.35) 
        };
      },
      formatsToSupport: formats,
      aspectRatio: 1.333333 // 4:3
    };
    
    try {
      this.isScanning = true;
      
      // Start Barcode Reader
      await this.html5QrCode.start(
        this.activeCameraId,
        config,
        (decodedText, decodedResult) => {
          // Barcode success callback
          if (this.scanMode === 'ocr') return; // Ignore barcodes completely if we are in OCR text mode
          
          const isbn = cleanAndValidateISBN(decodedText);
          if (isbn && this.isScanning) {
            this.handleIsbnDetected(isbn, 'Codi de barres');
          }
        },
        (errorMessage) => {
          // Ignore verbose debug logs from html5-qrcode
        }
      );
      
      this.updateScannerStatus('', false); // Hide badge when camera runs
      
      // Enable torch if camera supports it
      this.checkTorchSupport();
      
      // Start OCR loop
      this.runOcrTick();
      
    } catch (err) {
      this.isScanning = false;
      this.scannerCard.classList.remove('active-scanning');
      this.updateScannerStatus('Error al connectar la càmera.', false);
      console.error("Camera start failed:", err);
    }
  }
  
  async stopScanLoop() {
    this.isScanning = false;
    this.scannerCard.classList.remove('active-scanning');
    
    if (this.ocrTimeoutId) {
      clearTimeout(this.ocrTimeoutId);
      this.ocrTimeoutId = null;
    }
    
    if (this.html5QrCode && this.html5QrCode.isScanning) {
      try {
        await this.html5QrCode.stop();
      } catch (err) {
        console.error("Error stopping barcode scan:", err);
      }
    }
    
    // Reset torch
    this.torchEnabled = false;
    this.btnToggleTorch.classList.remove('active');
    this.btnToggleTorch.classList.add('disabled');
    this.btnToggleTorch.setAttribute('disabled', 'true');
  }
  
  async switchCamera() {
    if (this.cameras.length <= 1) return;
    
    await this.stopScanLoop();
    
    // Toggle active camera index
    const currentIndex = this.cameras.findIndex(cam => cam.id === this.activeCameraId);
    const nextIndex = (currentIndex + 1) % this.cameras.length;
    this.activeCameraId = this.cameras[nextIndex].id;
    
    await this.startScanLoop();
  }
  
  checkTorchSupport() {
    try {
      const track = this.html5QrCode.getActiveCameraTrack();
      if (track && typeof track.getCapabilities === 'function') {
        const capabilities = track.getCapabilities();
        if (capabilities.torch) {
          this.btnToggleTorch.classList.remove('disabled');
          this.btnToggleTorch.removeAttribute('disabled');
          return;
        }
      }
    } catch (e) {
      console.warn("Could not inspect torch capabilities", e);
    }
    
    // If not supported, make sure it is disabled
    this.btnToggleTorch.classList.add('disabled');
    this.btnToggleTorch.setAttribute('disabled', 'true');
  }
  
  async toggleTorch() {
    if (this.btnToggleTorch.classList.contains('disabled')) return;
    
    try {
      const track = this.html5QrCode.getActiveCameraTrack();
      if (track) {
        this.torchEnabled = !this.torchEnabled;
        await track.applyConstraints({
          advanced: [{ torch: this.torchEnabled }]
        });
        this.btnToggleTorch.classList.toggle('active', this.torchEnabled);
      }
    } catch (e) {
      console.error("Failed to toggle torch:", e);
      this.torchEnabled = false;
      this.btnToggleTorch.classList.remove('active');
    }
  }
  
  cycleScanMode() {
    const modes = [
      { id: 'auto', label: 'Mode: Auto', instructions: 'Enfoca un codi de barres o el text de l\'ISBN' },
      { id: 'barcode', label: 'Mode: Codi Barres', instructions: 'Enfoca un codi de barres de llibre (EAN-13)' },
      { id: 'ocr', label: 'Mode: Llegir ISBN', instructions: 'Enfoca el text imprès de l\'ISBN' }
    ];
    
    const currentIndex = modes.findIndex(m => m.id === this.scanMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    
    this.scanMode = nextMode.id;
    this.btnModeToggle.querySelector('#scan-mode-label').innerText = nextMode.label;
    this.instructionsText.innerText = nextMode.instructions;
    
    // Update badge styling
    const modeEmoji = nextMode.id === 'barcode' ? '🏷️' : (nextMode.id === 'ocr' ? '👁️' : '📚');
    this.btnModeToggle.querySelector('.mode-icon').innerText = modeEmoji;
    
    // Trigger OCR loop if changed to OCR/Auto and running
    if (this.isScanning && (this.scanMode === 'ocr' || this.scanMode === 'auto')) {
      if (!this.ocrTimeoutId) {
        this.runOcrTick();
      }
    }
  }
  
  // OCR processing loop ticker
  async runOcrTick() {
    if (!this.isScanning || this.scanMode === 'barcode' || this.isOcrProcessing) {
      // Schedule next check
      if (this.isScanning && this.scanMode !== 'barcode') {
        this.ocrTimeoutId = setTimeout(() => this.runOcrTick(), 600);
      }
      return;
    }
    
    // Initialize OCR worker if not ready
    if (!this.tesseractWorker) {
      await this.initOCRWorker();
      if (!this.tesseractWorker) { // Fail-safe if OCR worker cannot load
        this.ocrTimeoutId = setTimeout(() => this.runOcrTick(), 1000);
        return;
      }
    }
    
    const videoEl = document.querySelector('#reader video');
    if (!videoEl || videoEl.readyState < 2) {
      this.ocrTimeoutId = setTimeout(() => this.runOcrTick(), 500);
      return;
    }
    
    this.isOcrProcessing = true;
    
    try {
      const vWidth = videoEl.videoWidth;
      const vHeight = videoEl.videoHeight;
      
      // Crop area equivalent to the visual reticle (75% x 35%)
      const cropWidth = Math.round(vWidth * 0.75);
      const cropHeight = Math.round(vHeight * 0.35);
      const cropX = Math.round((vWidth - cropWidth) / 2);
      const cropY = Math.round((vHeight - cropHeight) / 2);
      
      const canvas = document.getElementById('ocr-canvas');
      preprocessImage(videoEl, canvas, { x: cropX, y: cropY, width: cropWidth, height: cropHeight });
      
      // Perform OCR
      const { data: { text } } = await this.tesseractWorker.recognize(canvas);
      
      // Inspect for valid ISBN checksums
      const isbn = cleanAndValidateISBN(text);
      if (isbn && this.isScanning) {
        this.handleIsbnDetected(isbn, 'Lector de text (OCR)');
        this.isOcrProcessing = false;
        return; // Break OCR cycle since we found one
      }
      
    } catch (err) {
      console.warn("OCR worker error during frame recognition:", err);
    }
    
    this.isOcrProcessing = false;
    this.ocrTimeoutId = setTimeout(() => this.runOcrTick(), 600);
  }
  
  async initOCRWorker() {
    if (this.tesseractWorker || this.isOcrLoading) return;
    
    this.isOcrLoading = true;
    this.updateScannerStatus('Inicialitzant OCR...', true);
    
    try {
      if (!window.Tesseract) {
        throw new Error("Tesseract library not loaded yet.");
      }
      
      // Create and configure worker
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: m => {
          if (m.status === 'recognizing text' && this.isScanning) {
            // Keep updating scanner info but don't show full badge if running
            this.instructionsText.innerText = `Llegint text: ${Math.round(m.progress * 100)}%`;
          }
        }
      });
      
      // Limit charlist to speed up recognition
      await worker.setParameters({
        tesseract_char_whitelist: '0123456789-ISBNisbnXx '
      });
      
      this.tesseractWorker = worker;
      this.updateScannerStatus('OCR a punt', false);
      
      // Restore scanner instructions
      this.restoreInstructions();
      
    } catch (e) {
      console.error("Failed to initialize Tesseract OCR:", e);
      this.updateScannerStatus('OCR no disponible (només codi de barres)', false);
      setTimeout(() => this.restoreInstructions(), 2000);
    } finally {
      this.isOcrLoading = false;
    }
  }
  
  restoreInstructions() {
    const modes = {
      auto: 'Enfoca un codi de barres o el text de l\'ISBN',
      barcode: 'Enfoca un codi de barres de llibre (EAN-13)',
      ocr: 'Enfoca el text imprès de l\'ISBN'
    };
    this.instructionsText.innerText = modes[this.scanMode] || modes.auto;
  }
  
  updateScannerStatus(text, showLoader = false) {
    if (!text) {
      this.badge.classList.add('hide');
      return;
    }
    
    this.badge.classList.remove('hide');
    this.badgeText.innerText = text;
    
    const spinner = this.badge.querySelector('.spinner-inline');
    if (showLoader) {
      spinner.classList.remove('hide');
    } else {
      spinner.classList.add('hide');
    }
  }
  
  // Scanned / Manual ISBN entry entrypoint
  async handleIsbnDetected(isbn, source) {
    playBeep();
    triggerHaptic();
    
    await this.stopScanLoop();
    
    this.updateScannerStatus(`Codi detectat: ${isbn}...`, true);
    this.instructionsText.innerText = `Cercant informació de l'ISBN (${source})...`;
    
    try {
      const { found, data } = await fetchBookInfo(isbn);
      this.displayBook(data);
      this.addToHistory(data);
    } catch (e) {
      console.error("Lookup error:", e);
      alert("Error al cercar informació a la base de dades. Si us plau, comprova la teva connexió a internet.");
      this.restartScanning();
    }
  }
  
  // UI Display rendering
  displayBook(book) {
    this.updateScannerStatus('', false); // Hide loader badge
    
    // Hide scanner, show details
    this.scannerCard.classList.add('hide');
    this.resultsCard.classList.remove('hide');
    
    // Set text elements
    if (book.title === 'Llibre desconegut') {
      const targetIsbn = book.isbn13 || book.isbn10 || '';
      this.bookTitle.innerHTML = `Llibre desconegut <br><br>
        <div style="font-size: 14px; font-weight: normal; margin-top: 10px; line-height: 1.6; text-align: left;">
          No s'ha trobat informació d'aquest ISBN automàticament als catàlegs de base. Pots intentar buscar-lo als grans catàlegs manuals aquí:<br><br>
          <a href="https://catalogo.bne.es/discovery/search?query=any,contains,${targetIsbn}&tab=LibraryCatalog&search_scope=MyInstitution&vid=34BNE_INST:CATALOGO" target="_blank" style="color: #4facfe; text-decoration: underline; display: block; padding: 4px 0;">🔍 Buscar a la Biblioteca Nacional (BNE)</a>
          <a href="https://ccuc.csuc.cat/discovery/search?query=any,contains,${targetIsbn}&tab=LibraryCatalog&search_scope=MyInstitution&vid=34CSUC_NETWORK:CSUC_CCUC" target="_blank" style="color: #4facfe; text-decoration: underline; display: block; padding: 4px 0;">🔍 Buscar al Catàleg de Catalunya (CCUC)</a>
        </div>
      `;
    } else {
      this.bookTitle.innerText = book.title;
    }
    if (book.subtitle) {
      this.bookSubtitle.innerText = book.subtitle;
      this.bookSubtitle.classList.remove('hide');
    } else {
      this.bookSubtitle.classList.add('hide');
    }
    
    this.bookAuthors.innerText = book.authors.join(', ');
    
    // Meta values
    this.metaPublisher.innerText = book.publisher;
    this.metaYear.innerText = book.publishedDate ? book.publishedDate.substring(0, 4) : 'Any desconegut';
    this.metaPages.innerText = book.pageCount ? `${book.pageCount} pàg.` : 'Pàgines desc.';
    this.metaLang.innerText = book.language ? book.language.toUpperCase() : 'Idioma desc.';
    
    // Set cover or fallback
    this.bookCoverContainer.innerHTML = '';
    if (book.coverUrl) {
      const img = document.createElement('img');
      img.src = book.coverUrl;
      img.alt = `Portada de ${book.title}`;
      img.className = 'book-cover-img';
      // Handle image load error
      img.onerror = () => this.showCoverPlaceholder(book);
      this.bookCoverContainer.appendChild(img);
    } else {
      this.showCoverPlaceholder(book);
    }
    
    // Description formatting
    const descText = book.description;
    this.bookDescription.innerHTML = descText;
    this.bookDescription.classList.remove('expanded');
    this.btnToggleDesc.innerText = 'Llegir més';
    
    // Check if description is long enough to warrant a read-more button
    // (Rough check: if text is over 250 characters, show button)
    if (descText && descText.length > 250) {
      this.btnToggleDesc.classList.remove('hide');
    } else {
      this.btnToggleDesc.classList.add('hide');
    }
    
    // ISBN codes
    this.isbn13Value.innerText = book.isbn13 || '-';
    this.isbn10Value.innerText = book.isbn10 || '-';
    
    // External Links
    if (book.isbn13 || book.isbn10) {
      const targetIsbn = book.isbn13 || book.isbn10;
      this.linkGoogleBooks.href = book.googleBooksLink || `https://books.google.com/books?vid=ISBN${targetIsbn}`;
      this.linkGoogleBooks.classList.remove('disabled');
      
      this.linkOpenLibrary.href = book.openLibraryLink || `https://openlibrary.org/isbn/${targetIsbn}`;
      this.linkOpenLibrary.classList.remove('disabled');
    } else {
      this.linkGoogleBooks.classList.add('disabled');
      this.linkOpenLibrary.classList.add('disabled');
    }
    
    // Render Ficha Técnica (Catàleg BNE / ISBN)
    const tbody = document.getElementById('ficha-tecnica-tbody');
    const section = document.getElementById('ficha-tecnica-section');
    if (tbody && section) {
      const isbn13 = book.isbn13 || book.specIsbn13 || '-';
      const isbn10 = book.isbn10 || book.specIsbn10 || '-';
      const title = book.specTitle || book.title || '-';
      const authors = book.specAuthors || book.authors.join(', ') || '-';
      const lang = book.specLang || getLanguageName(book.language) || '-';
      const date = book.specDate || book.publishedDate || '-';
      const publisher = book.specPublisher || book.publisher || '-';
      const format = book.specFormat || (book.pageCount ? `${book.pageCount} p.` : '-');
      const binding = book.specBinding || '[NO DISPONIBLE]';
      const collection = book.specCollection || '[NO DISPONIBLE]';
      const subjects = book.specSubjects || (book.categories && book.categories.length > 0 ? book.categories.join(', ') : '[NO DISPONIBLE]');
      const price = book.specPrice || '[NO DISPONIBLE]';
      
      tbody.innerHTML = `
        <tr>
          <th>ISBN 13:</th>
          <td style="color: var(--danger); font-weight: 600;">${isbn13}</td>
        </tr>
        <tr>
          <th>ISBN 10:</th>
          <td style="color: var(--danger); font-weight: 600;">${isbn10}</td>
        </tr>
        <tr>
          <th>[DISPONIBILITAT]</th>
          <td style="color: var(--text-muted); font-style: italic;">[NO DISPONIBLE]</td>
        </tr>
        <tr>
          <th>Título:</th>
          <td>${title}</td>
        </tr>
        <tr>
          <th>Autor/es:</th>
          <td style="color: var(--accent-cyan); font-weight: 500;">${authors}</td>
        </tr>
        <tr>
          <th>Lengua de publicación:</th>
          <td style="color: var(--accent-cyan);">${lang}</td>
        </tr>
        <tr>
          <th>Fecha Edición:</th>
          <td>${date}</td>
        </tr>
        <tr>
          <th>Publicación:</th>
          <td>${publisher}</td>
        </tr>
        <tr>
          <th>Descripción:</th>
          <td>${format}</td>
        </tr>
        <tr>
          <th>Encuadernación:</th>
          <td>${binding}</td>
        </tr>
        <tr>
          <th>Colección:</th>
          <td>${collection}</td>
        </tr>
        <tr>
          <th>Materia/s:</th>
          <td>${subjects}</td>
        </tr>
        <tr>
          <th>Precio:</th>
          <td>${price}</td>
        </tr>
      `;
      if (book.title === 'Llibre desconegut') {
        section.classList.add('hide');
      } else {
        section.classList.remove('hide');
      }
    }
    
    // Scroll to results card
    this.resultsCard.scrollIntoView({ behavior: 'smooth' });
  }
  
  showCoverPlaceholder(book) {
    const placeholder = document.createElement('div');
    placeholder.className = 'book-cover-placeholder';
    placeholder.innerHTML = `
      <svg class="placeholder-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
      </svg>
      <div class="placeholder-title">${book.title}</div>
      <div class="placeholder-footer">Sense Portada</div>
    `;
    this.bookCoverContainer.innerHTML = '';
    this.bookCoverContainer.appendChild(placeholder);
  }
  
  restartScanning() {
    this.resultsCard.classList.add('hide');
    this.scannerCard.classList.remove('hide');
    this.restoreInstructions();
    this.startScanLoop();
  }
  
  // Clipboard copy action
  async copyToClipboard(text, btnNode) {
    if (!text || text === '-') return;
    try {
      await navigator.clipboard.writeText(text);
      btnNode.classList.add('copied');
      
      // Success checkmark icon toggle
      const originalSvg = btnNode.innerHTML;
      btnNode.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><polyline points="20 6 9 17 4 12"/></svg>`;
      
      setTimeout(() => {
        btnNode.classList.remove('copied');
        btnNode.innerHTML = originalSvg;
      }, 1500);
    } catch (e) {
      console.warn("Clipboard copy failed:", e);
    }
  }
  
  // Manual Input Dialog handlers
  showManualModal() {
    // Pause scanner if running
    if (this.isScanning) {
      this.stopScanLoop();
    }
    this.manualModal.classList.remove('hide');
    this.inputIsbn.value = '';
    this.manualError.classList.add('hide');
    setTimeout(() => this.inputIsbn.focus(), 150);
  }
  
  hideManualModal() {
    this.manualModal.classList.add('hide');
    // Resume scanner if was active before
    if (!this.resultsCard.classList.contains('hide')) {
      // Book details are currently displayed, do not resume
      return;
    }
    this.startScanLoop();
  }

  showPermissionModal() {
    if (this.permissionModal) {
      this.permissionModal.classList.remove('hide');
    }
  }

  hidePermissionModal() {
    if (this.permissionModal) {
      this.permissionModal.classList.add('hide');
    }
  }
  
  handleManualSubmit(e) {
    e.preventDefault();
    const rawVal = this.inputIsbn.value.trim();
    const cleanIsbn = rawVal.replace(/[^0-9Xx]/g, '').toUpperCase();
    
    if (isValidISBN13(cleanIsbn) || isValidISBN10(cleanIsbn)) {
      this.manualModal.classList.add('hide');
      this.handleIsbnDetected(cleanIsbn, 'Cerca manual');
    } else {
      this.manualError.innerText = "Format ISBN no vàlid (ha de tenir 10 o 13 digits)";
      this.manualError.classList.remove('hide');
    }
  }
  
  // Search History Local Storage logic
  addToHistory(book) {
    // Prevent duplicate entries
    const id = book.isbn13 || book.isbn10;
    this.history = this.history.filter(item => {
      const itemId = item.isbn13 || item.isbn10;
      return itemId !== id;
    });
    
    // Add to top of list
    this.history.unshift(book);
    
    // Limit history count to 20 items
    if (this.history.length > 20) {
      this.history.pop();
    }
    
    localStorage.setItem('isbn_scan_history', JSON.stringify(this.history));
    this.renderHistory();
  }
  
  clearHistory() {
    if (confirm("Segur que vols esborrar tot l'historial?")) {
      this.history = [];
      localStorage.setItem('isbn_scan_history', '[]');
      this.renderHistory();
    }
  }
  
  deleteHistoryItem(index, event) {
    event.stopPropagation(); // Prevent loading item details
    this.history.splice(index, 1);
    localStorage.setItem('isbn_scan_history', JSON.stringify(this.history));
    this.renderHistory();
  }
  
  renderHistory() {
    if (this.history.length === 0) {
      this.historyList.innerHTML = `
        <div class="empty-state">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          <p>Encara no has escanejat cap llibre. Escaneja un codi per desar-lo aquí.</p>
        </div>
      `;
      this.historyList.classList.add('empty');
      this.btnClearHistory.classList.add('hide');
      return;
    }
    
    this.historyList.classList.remove('empty');
    this.btnClearHistory.classList.remove('hide');
    this.historyList.innerHTML = '';
    
    this.history.forEach((book, index) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.addEventListener('click', () => {
        // Stop scanning if active and display selected book
        this.stopScanLoop();
        this.displayBook(book);
      });
      
      // Cover HTML
      let coverHtml = '';
      if (book.coverUrl) {
        coverHtml = `<img src="${book.coverUrl}" class="history-item-cover-img" alt="Portada">`;
      } else {
        coverHtml = `
          <div class="history-item-placeholder">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
            </svg>
          </div>
        `;
      }
      
      const targetIsbn = book.isbn13 || book.isbn10 || 'Sense ISBN';
      
      item.innerHTML = `
        <div class="history-item-cover">
          ${coverHtml}
        </div>
        <div class="history-item-info">
          <h4 class="history-item-title">${book.title}</h4>
          <p class="history-item-author">${book.authors.join(', ')}</p>
          <span class="history-item-isbn">${targetIsbn}</span>
        </div>
        <button class="btn-delete-history-item" title="Esborrar de l'historial" aria-label="Esborrar de l'historial">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <line x1="10" y1="11" x2="10" y2="17"/>
            <line x1="14" y1="11" x2="14" y2="17"/>
          </svg>
        </button>
      `;
      
      // Bind delete button
      item.querySelector('.btn-delete-history-item').addEventListener('click', (e) => {
        this.deleteHistoryItem(index, e);
      });
      
      this.historyList.appendChild(item);
    });
  }
}

// Start app once content loaded
window.addEventListener('DOMContentLoaded', () => {
  const app = new ISBNApp();
  app.start();
});

// --- PWA Installation Logic & Fallback ---
let deferredPrompt = null;
const installContainer = document.getElementById('pwa-install-container');
const btnInstallPwa = document.getElementById('btn-install-pwa');
const installModal = document.getElementById('install-instructions-modal');
const btnCloseInstallModal = document.getElementById('btn-close-install-modal');
const btnOkInstall = document.getElementById('btn-ok-install');

// 1. Show the banner always on mobile after 3 seconds
setTimeout(() => {
  // Simple check if it's mobile and not already installed/standalone
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  
  if (isMobile && !isStandalone && installContainer) {
    installContainer.style.display = 'flex';
  }
}, 3000);

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent Chrome from showing the mini-infobar
  e.preventDefault();
  // Stash the event so it can be triggered later.
  deferredPrompt = e;
  // Make sure banner is visible
  if (installContainer) {
    installContainer.style.display = 'flex';
  }
});

if (btnInstallPwa) {
  btnInstallPwa.addEventListener('click', async () => {
    // Hide the app provided install promotion
    installContainer.style.display = 'none';
    
    // Show the install prompt if available (Chrome allowed it)
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`User response to the install prompt: ${outcome}`);
      deferredPrompt = null;
    } else {
      // Fallback: Browser blocked it or it's Safari iOS
      if (installModal) {
        installModal.classList.remove('hide');
      }
    }
  });
}

// Close fallback modal handlers
if (btnCloseInstallModal && installModal) {
  btnCloseInstallModal.addEventListener('click', () => installModal.classList.add('hide'));
}
if (btnOkInstall && installModal) {
  btnOkInstall.addEventListener('click', () => installModal.classList.add('hide'));
}
installModal?.addEventListener('click', (e) => {
  if (e.target === installModal) installModal.classList.add('hide');
});

window.addEventListener('appinstalled', () => {
  if (installContainer) installContainer.style.display = 'none';
  if (installModal) installModal.classList.add('hide');
  deferredPrompt = null;
  console.log('PWA was installed successfully');
});
