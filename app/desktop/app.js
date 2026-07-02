let isPolling = true;
let sessionID = null;
let isMobileConnected = false;
window.detectedThemeId = '';

let allScoredBooks = [];
let lastSearchStrategy = 'AND';
let lastUsedBNE = false;

// Deduplicació: evita processar el mateix scan dues vegades
let lastProcessedScanKey = null;
let lastProcessedScanTime = 0;
let isSearchInProgress = false;

// Canvas actual de portada per poder-lo rotar manualment
let currentCoverCanvas = null;

// Tesseract & PaddleOCR variables
let tesseractParallelWorkersInitialized = false;
let tesseractWorkerCat = null;
let tesseractWorkerSpa = null;
let ocrInstance = null;




document.addEventListener('DOMContentLoaded', async () => {
  let isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.');
  let localIp = 'localhost';
  let connectionMode = 'local'; // 'local' o 'public'

  // Si estem en una web remota (ex: GitHub Pages), comprovem si respon el servidor local HTTP a localhost
  if (!isLocal) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);
      const testRes = await fetch('http://localhost:8080/api/ip', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (testRes.ok) {
        isLocal = true;
        console.log("🟢 Servidor local HTTP detectat a http://localhost:8080.");
      }
    } catch (e) {
      console.log("ℹ️ No s'ha detectat servidor local HTTP a http://localhost:8080.");
    }
  }

  if (isLocal) {
    try {
      const res = await fetch(`${getBaseUrl()}/api/ip?t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        localIp = data.ip || 'localhost';
      }
    } catch (e) {
      console.warn("No s'ha pogut obtenir la IP local per al QR:", e);
    }
  }

  const updateConnectionQr = () => {
    const certHelp = document.getElementById('cert-help');
    const cameraRelayPanel = document.getElementById('camera-relay-panel');
    const instructions = document.getElementById('connection-instructions');
    const tabLocal = document.getElementById('tab-local');
    const tabPublic = document.getElementById('tab-public');
    const floatMode = document.getElementById('floating-qr-mode');

    if (connectionMode === 'local' && isLocal) {
      if (tabLocal) {
        tabLocal.style.border = '2px solid #3498db';
        tabLocal.style.background = '#3498db';
        tabLocal.style.color = 'white';
      }
      if (tabPublic) {
        tabPublic.style.border = '2px solid #bdc3c7';
        tabPublic.style.background = '#f8f9f9';
        tabPublic.style.color = '#444';
      }
      if (floatMode) {
        floatMode.innerText = "⚡ Local";
        floatMode.className = "floating-qr-mode-indicator local";
      }
      
      // Carreguem l'app del mòbil directament des del servidor HTTPS local de l'ordinador.
      // Això força la confirmació de seguretat SSL immediatament al mòbil en entrar,
      // facilitant que l'usuari l'accepti sense bloquejos silenciosos ni necessitat de pujar a GitHub.
      const localUrl = `https://${localIp}:8443/mobile/?sid=${sessionID}`;
      renderQrCode(localUrl);
      if (instructions) instructions.innerText = 'Escaneja aquest codi QR per obrir l\'escàner local directe. Requereix que el mòbil estigui connectat al mateix Wi-Fi i que el tallafocs de l\'ordinador no bloquegi els ports (8080/8443).';
      if (certHelp) certHelp.style.display = 'block';
      if (cameraRelayPanel) cameraRelayPanel.style.display = 'block';
    } else {
      if (tabLocal) {
        tabLocal.style.border = '2px solid #bdc3c7';
        tabLocal.style.background = '#f8f9f9';
        tabLocal.style.color = '#444';
      }
      if (tabPublic) {
        tabPublic.style.border = '2px solid #27ae60';
        tabPublic.style.background = '#27ae60';
        tabPublic.style.color = 'white';
      }
      if (floatMode) {
        floatMode.innerText = "📡 Públic";
        floatMode.className = "floating-qr-mode-indicator public";
      }
      
      const defaultUrl = 'https://rogroc.github.io/llibres/app/mobile/';
      renderQrCode(`${defaultUrl}?sid=${sessionID}`);
      if (instructions) instructions.innerText = 'Escaneja aquest codi QR per obrir l\'escàner de canal públic. No transmetrà imatges de càmera en directe, però farà el processament a la càmera del mòbil i sincronitzarà els resultats en segon pla (supera tallafocs o aïllament de xarxa).';
      if (certHelp) certHelp.style.display = 'none';
      if (cameraRelayPanel) cameraRelayPanel.style.display = 'none';
    }
  };

  // 1. Llegim el sid dels paràmetres de la URL
  const urlParams = new URLSearchParams(window.location.search);
  let urlSid = urlParams.get('sid');
  if (urlSid) {
    sessionID = urlSid;
    console.log(`[Session] ID de sessió des de URL: ${sessionID}`);
  } else {
    // Si no n'hi ha a la URL, intentem recuperar de localStorage o en generem un de nou
    let storedSid = localStorage.getItem('llibreviu_desktop_sid');
    if (storedSid) {
      sessionID = storedSid;
      console.log(`[Session] ID de sessió des de localStorage: ${sessionID}`);
    } else {
      sessionID = Math.random().toString(36).substring(2, 10);
      console.log(`[Session] S'ha generat un nou ID de sessió: ${sessionID}`);
    }
    // Guardem a localStorage i afegim a la URL sense recarregar
    localStorage.setItem('llibreviu_desktop_sid', sessionID);
    urlParams.set('sid', sessionID);
    const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
    window.history.replaceState({}, "", newUrl);
  }

  // Intentem recuperar una sessió activa existent per no tallar el flux en recarregar / obrir el Desktop
  let currentSessionState = null;
  if (isLocal) {
    try {
      const stateRes = await fetch(`${getBaseUrl()}/api/session-state?sid=${sessionID}&t=${Date.now()}`, { cache: 'no-store' });
      if (stateRes.ok) {
        const stateData = await stateRes.json();
        if (stateData.sid) {
          sessionID = stateData.sid;
          currentSessionState = stateData.state;
          console.log(`[Session] Sessió activa existent detectada (ID: ${sessionID}, estat: ${currentSessionState})`);
        }
      }
    } catch (e) {
      console.warn("No s'ha pogut obtenir l'estat de sessió actiu:", e);
    }
  }

  // Inicialitzem QR i controls (sempre mode local)
  if (isLocal) {
    updateConnectionQr();

    // Comença a fer polling de scans i de càmera relay (usant Web Worker per evitar suspensions en segon pla)
    initPollWorker();
    initCameraRelay();
  }
  initFileDropZone();

  // Només registrem / restablim l'estat a 'scanning' si no hi havia cap sessió prèvia activa
  if (!currentSessionState) {
    fetch(`${getBaseUrl()}/api/session-state?sid=${sessionID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'scanning', sid: sessionID })
    }).catch(err => console.error("Error registering session state:", err));
  }



  // Escoltador per tancar el modal de detalls
  document.getElementById('close-details')?.addEventListener('click', () => {
    document.getElementById('book-details-modal').style.display = 'none';
  });

  // Control de minimització/ampliació del giny de QR flotant
  const qrWidget = document.getElementById('floating-qr-widget');
  const btnToggleQr = document.getElementById('btn-toggle-qr-widget');
  
  const toggleQrWidget = (e) => {
    if (e) e.stopPropagation();
    if (!qrWidget) return;
    qrWidget.classList.toggle('minimized');
    if (qrWidget.classList.contains('minimized')) {
      if (btnToggleQr) btnToggleQr.innerText = '+';
      if (btnToggleQr) btnToggleQr.title = 'Ampliar';
    } else {
      if (btnToggleQr) btnToggleQr.innerText = '−';
      if (btnToggleQr) btnToggleQr.title = 'Minimitzar';
    }
  };

  btnToggleQr?.addEventListener('click', toggleQrWidget);
  
  // Si cliquem sobre el giny minimitzat (el cercle), s'amplia
  qrWidget?.addEventListener('click', (e) => {
    if (qrWidget && qrWidget.classList.contains('minimized')) {
      toggleQrWidget(e);
    }
  });

  // Inicialitzem el selector de motor d'OCR i clau API de Gemini
  const selOcrEngine = document.getElementById('sel-ocr-engine');
  const txtGeminiKey = document.getElementById('txt-gemini-key');
  const geminiKeyContainer = document.getElementById('gemini-key-container');
  const rotateControls = document.getElementById('rotate-controls');

  if (selOcrEngine && txtGeminiKey) {
    const savedEngine = localStorage.getItem('ocr-engine') || 'gemini-api';
    let savedKey = localStorage.getItem('gemini-api-key') || '';
    if (savedKey === 'gen-lang-client-0842373978') {
      savedKey = '';
      localStorage.setItem('gemini-api-key', savedKey);
    }

    selOcrEngine.value = savedEngine;
    txtGeminiKey.value = savedKey;

    const toggleOcrFields = () => {
      const isGemini = selOcrEngine.value === 'gemini-api';
      if (geminiKeyContainer) {
        geminiKeyContainer.style.display = isGemini ? 'block' : 'none';
      }
      if (rotateControls) {
        if (isGemini) {
          rotateControls.style.display = 'none';
        } else if (currentCoverCanvas) {
          rotateControls.style.display = 'block';
        }
      }
    };

    selOcrEngine.addEventListener('change', () => {
      localStorage.setItem('ocr-engine', selOcrEngine.value);
      toggleOcrFields();
    });

    txtGeminiKey.addEventListener('input', () => {
      localStorage.setItem('gemini-api-key', txtGeminiKey.value);
    });

    toggleOcrFields();
  }


});



function initFileDropZone() {
  const dropArea = document.getElementById('drop-area');
  const fileInput = document.getElementById('file-input');

  if (!dropArea || !fileInput) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropArea.style.background = '#d6eaf8';
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropArea.style.background = '#ebf5fb';
    }, false);
  });

  dropArea.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  }, false);

  fileInput.addEventListener('change', (e) => {
    if (fileInput.files.length > 0) {
      handleFile(fileInput.files[0]);
    }
  });
}



function renderQrCode(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  
  // Renderització al contenidor de la targeta principal d'inici
  const mainQrEl = document.getElementById('qr-container');
  if (mainQrEl) {
    mainQrEl.innerHTML = qr.createImgTag(5);
  }
  
  // Renderització al contenidor del giny flotant persistent
  const floatQrEl = document.getElementById('floating-qr-container');
  if (floatQrEl) {
    floatQrEl.innerHTML = qr.createImgTag(4); // Use slightly smaller module size (4 instead of 5) for the compact floating widget
  }

  const qrUrlEl = document.getElementById('qr-url');
  if (qrUrlEl) {
    qrUrlEl.innerText = url;
  }
}

let pollWorker = null;

function initPollWorker() {
  const workerCode = `
    let isPolling = true;
    let baseUrl = '';
    let es = null;
    let lastSseMessageTime = 0;
    let sid = 'default';

    function startSSE() {
      if (es) return;
      try {
        es = new EventSource(baseUrl + '/api/sse?sid=' + sid);
        
        es.addEventListener('ping', () => {
          lastSseMessageTime = Date.now();
        });
        
        es.addEventListener('state', () => {
          lastSseMessageTime = Date.now();
        });

        es.addEventListener('scan', async (e) => {
          lastSseMessageTime = Date.now();
          if (!isPolling) return;
          try {
            const item = JSON.parse(e.data);
            if (item && item.type) {
              if (item.type === 'isbn' || item.type === 'portada') {
                self.postMessage({ action: 'scan_started', data: item });
                if (item.type === 'isbn') {
                  await searchByIsbn(item.value);
                } else {
                  await searchCatalogsWithText(item.value);
                }
              } else {
                self.postMessage({ action: 'scan', data: item });
              }
            }
          } catch (err) {
            // ignore
          }
        });

        es.onerror = () => {
          if (es) es.close();
          es = null;
          setTimeout(startSSE, 5000);
        };
      } catch (err) {
        setTimeout(startSSE, 5000);
      }
    }

    self.onmessage = function(e) {
      if (e.data.action === 'init') {
        baseUrl = e.data.baseUrl;
        sid = e.data.sid || 'default';
        startSSE();
      } else if (e.data.action === 'stop') {
        isPolling = false;
        if (es) {
          es.close();
          es = null;
        }
      } else if (e.data.action === 'start') {
        isPolling = true;
        startSSE();
      } else if (e.data.action === 'search_isbn') {
        searchByIsbn(e.data.value);
      } else if (e.data.action === 'search_text') {
        searchCatalogsWithText(e.data.value);
      }
    };

    function calculateOverlapScore(book, ocrTextRaw) {
      let textToMatch = ocrTextRaw;
      try {
        if (ocrTextRaw.trim().startsWith('{')) {
          const parsed = JSON.parse(ocrTextRaw);
          if (parsed && typeof parsed === 'object') {
            textToMatch = [parsed.titol || '', parsed.autor || '', parsed.editorial || ''].filter(Boolean).join(' ');
          }
        }
      } catch (e) {
        // ignore
      }
      const ocrWords = new Set(textToMatch.toLowerCase().replace(/[^\\w\\sàéèíóòúüçñ]/g, '').split(/\\s+/));
      const titleWords = (book.title || '').toLowerCase().replace(/[^\\w\\sàéèíóòúüçñ]/g, '').split(/\\s+/).filter(w => w.length > 1);
      let titleMatches = 0;
      for (let w of titleWords) {
        if (ocrWords.has(w)) titleMatches++;
      }
      const titleScore = titleWords.length > 0 ? (titleMatches / titleWords.length) : 0;

      let authorScore = 0;
      if (book.author_name && book.author_name.length > 0) {
        const authorWords = book.author_name[0].toLowerCase().replace(/[^\\w\\sàéèíóòúüçñ]/g, '').split(/\\s+/).filter(w => w.length > 1);
        let authorMatches = 0;
        for (let w of authorWords) {
          if (ocrWords.has(w)) authorMatches++;
        }
        authorScore = authorWords.length > 0 ? (authorMatches / authorWords.length) : 0;
      }
      return (titleScore * 0.6) + (authorScore * 0.4);
    }

    async function uploadCandidates(books) {
      const sorted = [...books].sort((a, b) => b.matchScore - a.matchScore).slice(0, 10);
      const placeholderSvg = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2260%22%20height%3D%2290%22%20viewBox%3D%220%200%2060%2090%22%3E%3Crect%20fill%3D%22%23ecf0f1%22%20width%3D%2260%22%20height%3D%2290%22%20%2F%3E%3Ctext%20fill%3D%22%2395a5a6%22%20font-family%3D%22sans-serif%22%20font-size%3D%229%22%20font-weight%3D%22bold%22%20x%3D%2250%25%22%20y%3D%2250%25%22%20text-anchor%3D%22middle%22%3ESense%20Port.%3C%2Ftext%3E%3C%2Fsvg%3E";
      
      const mappedPromises = sorted.map(async (book) => {
        let coverUrl = placeholderSvg;
        if (book.isBNE && book.isbn && book.isbn.length > 0) {
          coverUrl = "https://covers.openlibrary.org/b/isbn/" + book.isbn[0] + "-M.jpg";
        } else if (book.cover) {
          coverUrl = book.cover;
        }
        const authors = book.author_name ? (Array.isArray(book.author_name) ? book.author_name.join(', ') : book.author_name) : (book.authors || 'Autor desconegut');
        const publishers = book.publisher ? (Array.isArray(book.publisher) ? book.publisher.slice(0, 2).join(', ') : book.publisher) : 'Editorial desconeguda';
        const publishYear = book.first_publish_year || book.year || 'Desconegut';
        let isbnVal = '';
        if (book.isbn) {
          isbnVal = Array.isArray(book.isbn) ? book.isbn[0] : book.isbn;
        }
        
        let finalSubjects = book.subjects || 'No categoritzat';
        if (finalSubjects !== 'No categoritzat') {
          try {
            const translateResponse = await fetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(finalSubjects) + "&langpair=en|ca");
            const translateData = await translateResponse.json();
            if (translateData && translateData.responseData && translateData.responseData.translatedText) {
              finalSubjects = translateData.responseData.translatedText;
            }
          } catch (e) {
            // ignore
          }
        }
        
        return {
          key: book.key,
          title: book.title,
          author: authors,
          authors: authors,
          publisher: publishers,
          year: publishYear,
          isbn: isbnVal,
          cover: coverUrl,
          source: book.isBNE ? 'BNE' : (book.source || 'Open Library'),
          subjects: finalSubjects
        };
      });
      
      const mapped = await Promise.all(mappedPromises);

      try {
        await fetch(baseUrl + '/api/candidates?sid=' + sid, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidates: mapped, sid })
        });
      } catch (err) {
        // ignore
      }
    }

    async function searchByIsbn(isbn) {
      const cleanIsbn = isbn.replace(/[^0-9X]/gi, '');
      const googleApiUrl = "https://www.googleapis.com/books/v1/volumes?q=isbn:" + cleanIsbn;
      const openLibrarySearchUrl = "https://openlibrary.org/search.json?isbn=" + cleanIsbn + "&fields=key,title,author_name,first_publish_year,cover_i,publisher,subject&limit=5";
      const bneUrl = baseUrl + '/api/bne?isbn=' + encodeURIComponent(cleanIsbn);
      
      const fetchWithTimeout = (url, ms = 8000) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ms);
        return fetch(url, { signal: ctrl.signal })
          .then(r => { clearTimeout(timer); return r; })
          .catch(err => { clearTimeout(timer); throw err; });
      };

      try {
        const results = await Promise.allSettled([
          fetchWithTimeout(googleApiUrl, 5000).then(r => r.status === 429 ? null : (r.ok ? r.json() : null)).catch(() => null),
          fetchWithTimeout(openLibrarySearchUrl, 10000).then(r => r.ok ? r.json() : null).catch(() => null),
          fetchWithTimeout(bneUrl, 12000).then(r => r.ok ? r.json() : null).catch(() => null)
        ]);
        
        const googleData = results[0].status === 'fulfilled' ? results[0].value : null;
        const olSearchData = results[1].status === 'fulfilled' ? results[1].value : null;
        const bneData = results[2].status === 'fulfilled' ? results[2].value : null;
        
        let booksFound = [];
        const normalizeTitle = t => (t || '').toLowerCase().replace(/[^\\w]/g, ' ').replace(/\\s+/g, ' ').trim();
        
        if (googleData && googleData.totalItems > 0) {
          const info = googleData.items[0].volumeInfo;
          booksFound.push({
            source: 'Google Books',
            title: info.title || 'Sense títol',
            authors: info.authors ? info.authors.join(', ') : 'Autor desconegut',
            publisher: info.publisher || 'Editorial desconeguda',
            year: info.publishedDate || '',
            isbn: cleanIsbn,
            cover: info.imageLinks ? (info.imageLinks.thumbnail || '') : '',
            subjects: info.categories ? info.categories.slice(0, 5).join(', ') : 'No categoritzat'
          });
        }
        
        if (olSearchData && olSearchData.docs && olSearchData.docs.length > 0) {
          olSearchData.docs.forEach(doc => {
            const docTitle = doc.title || 'Sense títol';
            const alreadyAdded = booksFound.some(b => normalizeTitle(b.title) === normalizeTitle(docTitle));
            if (!alreadyAdded) {
              const pubArr = Array.isArray(doc.publisher) ? doc.publisher : (doc.publisher ? [doc.publisher] : []);
              booksFound.push({
                source: 'Open Library',
                title: docTitle,
                authors: doc.author_name ? doc.author_name.join(', ') : 'Autor desconegut',
                publisher: pubArr.slice(0, 2).join(', ') || 'Editorial desconeguda',
                year: doc.first_publish_year || '',
                isbn: cleanIsbn,
                cover: doc.cover_i ? "https://covers.openlibrary.org/b/id/" + doc.cover_i + "-M.jpg" : '',
                subjects: doc.subject ? doc.subject.slice(0, 5).join(', ') : 'No categoritzat'
              });
            }
          });
        }
        
        if (bneData && bneData.docs && bneData.docs.length > 0) {
          bneData.docs.forEach(doc => {
            const display = doc.pnx.display || {};
            const addata = doc.pnx.addata || {};
            
            let title = 'Llibre desconegut';
            if (display.title && display.title[0]) {
              title = display.title[0].split('/')[0].trim();
            }
            
            let author_name = [];
            if (display.creator && display.creator[0]) {
              author_name = [display.creator[0].split('$$')[0].trim()];
            } else if (addata.creatorfull && addata.creatorfull[0]) {
              author_name = [addata.creatorfull[0].split('$$')[0].trim()];
            }
            if (author_name.length > 0) {
              let cleanAuthor = author_name[0].replace(/[\\d-]/g, '').trim();
              if (cleanAuthor.endsWith(',')) cleanAuthor = cleanAuthor.slice(0, -1).trim();
              if (cleanAuthor.includes(',')) {
                cleanAuthor = cleanAuthor.split(',').reverse().join(' ').trim();
              }
              author_name = [cleanAuthor];
            }
            
            let publisher = [];
            if (display.publisher && display.publisher[0]) {
              let pub = display.publisher[0].split(':')[1];
              if (pub) pub = pub.split(',')[0].trim();
              else pub = display.publisher[0].trim();
              publisher = [pub];
            } else if (addata.pub && addata.pub[0]) {
              publisher = [addata.pub[0]];
            }
            
            let first_publish_year = display.creationdate ? display.creationdate[0] : 'Any desc.';
            const key = "/bne/" + (doc.context || 'L') + "/" + (doc.recordid || (doc.pnx.control && doc.pnx.control.sourcrecordid ? doc.pnx.control.sourcrecordid[0] : Math.random()));
            
            const alreadyAdded = booksFound.some(b => normalizeTitle(b.title) === normalizeTitle(title));
            if (!alreadyAdded) {
              let subjects = [];
              if (display.genre) display.genre.forEach(g => subjects.push(g.split('$$')[0].trim()));
              if (display.subject) display.subject.forEach(s => subjects.push(s.split('$$')[0].trim()));
              let finalSubjects = subjects.length > 0 ? Array.from(new Set(subjects)).slice(0, 5).join(', ') : 'No categoritzat';

              booksFound.push({
                source: 'BNE',
                key: key,
                title: title,
                authors: author_name.join(', ') || 'Autor desconegut',
                publisher: publisher.join(', ') || 'Editorial desconeguda',
                year: first_publish_year,
                isbn: cleanIsbn,
                cover: "https://covers.openlibrary.org/b/isbn/" + cleanIsbn + "-M.jpg",
                isBNE: true,
                rawDoc: doc,
                subjects: finalSubjects
              });
            }
          });
        }
        
        if (booksFound.length > 0) {
          const mapped = booksFound.map(b => ({
            key: b.key || ("/isbn/" + b.isbn),
            title: b.title,
            author_name: [b.authors],
            publisher: [b.publisher],
            first_publish_year: b.year,
            isbn: [b.isbn],
            cover: b.cover,
            matchScore: 1.0,
            isISBNMode: true,
            source: b.source,
            isBNE: b.isBNE || false,
            bneDoc: b.rawDoc || null,
            subjects: b.subjects || 'No categoritzat'
          }));
          
          await uploadCandidates(mapped);
          self.postMessage({ action: 'search_results', results: mapped, query: "ISBN: " + isbn, strategy: 'ISBN Exact Match', fromBNE: booksFound.some(b => b.source === 'BNE') });
        } else {
          self.postMessage({ action: 'search_results', results: [], query: "ISBN: " + isbn, error: 'No s\\'ha trobat cap llibre coincidents als catàlegs.' });
        }
      } catch (err) {
        self.postMessage({ action: 'search_results', results: [], query: "ISBN: " + isbn, error: err.message });
      }
    }

    async function searchCatalogsWithText(text) {
      let isStructured = false;
      let queryTitol = '';
      let queryAutor = '';
      let queryEditorial = '';
      
      try {
        if (text.trim().startsWith('{')) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            queryTitol = (parsed.titol || '').trim();
            queryAutor = (parsed.autor || '').trim();
            queryEditorial = (parsed.editorial || '').trim();
            if (queryTitol || queryAutor || queryEditorial) {
              isStructured = true;
            }
          }
        }
      } catch (e) {
        // ignore
      }
      
      let normalizedText = text;
      let keywords = [];
      
      if (isStructured) {
        const combined = [queryTitol, queryAutor, queryEditorial].filter(Boolean).join(' ');
        normalizedText = combined;
        const cleanText = combined.toLowerCase().replace(/[^\\w\\sàéèíóòúüçñ]/g, '');
        const ocrWordsList = cleanText.split(/\\s+/);
        const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
        keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
      } else {
        let normalizedTextVal = text.replace(/ufia/gi, 'uña')
                                 .replace(/fio/gi, 'ño')
                                 .replace(/fia/gi, 'ña')
                                 .replace(/iriba/gi, 'i riba')
                                 .replace(/\\brba\\b/gi, 'riba')
                                 .replace(/ll['’]?imperí?/gi, "i l'imperi")
                                 .replace(/il['’]?imperí?/gi, "i l'imperi")
                                 .replace(/l['’]?imperí?/gi, "l'imperi");
        normalizedText = normalizedTextVal;
        const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
        const cleanText = normalizedText.toLowerCase().replace(/[^\\w\\sàéèíóòúüçñ]/g, '');
        const ocrWordsList = cleanText.split(/\\s+/);
        keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
      }
      
      if (keywords.length === 0) {
        self.postMessage({ action: 'search_results', results: [], query: text, error: 'El text llegit era massa curt o invàlid.' });
        return;
      }
      
      const apiKeywords = keywords.slice(0, 8);
      let url = "";
      let strategy = "";
      
      if (isStructured) {
        strategy = 'Structured Gemini Query';
        let params = [];
        if (queryTitol) params.push("title=" + encodeURIComponent(queryTitol));
        if (queryAutor) params.push("author=" + encodeURIComponent(queryAutor));
        if (queryEditorial) params.push("publisher=" + encodeURIComponent(queryEditorial));
        url = "https://openlibrary.org/search.json?" + params.join('&') + "&fields=key,title,author_name,first_publish_year,cover_i,publisher,subject&limit=30";
      } else {
        strategy = 'AND (Totes les paraules principals)';
        let andQuery = apiKeywords.join('+');
        url = "https://openlibrary.org/search.json?q=" + andQuery + "&fields=key,title,author_name,first_publish_year,cover_i,publisher,subject&limit=30";
      }
      
      try {
        let res = await fetch(url);
        let data = await res.json();
        
        if (isStructured && (data.numFound === 0 || data.docs.length === 0)) {
          strategy = 'Structured Fallback AND';
          let andQuery = apiKeywords.join('+');
          url = "https://openlibrary.org/search.json?q=" + andQuery + "&fields=key,title,author_name,first_publish_year,cover_i,publisher,subject&limit=30";
          res = await fetch(url);
          data = await res.json();
        }
        
        if (data.numFound === 0 || data.docs.length === 0) {
          strategy = isStructured ? 'Structured Fallback OR' : 'OR (Major nombre de coincidències)';
          let orQuery = apiKeywords.join('+OR+');
          url = "https://openlibrary.org/search.json?q=" + orQuery + "&fields=key,title,author_name,first_publish_year,cover_i,publisher,subject&limit=30";
          res = await fetch(url);
          data = await res.json();
        }
        
        let allScoredBooks = [];
        if (data.numFound > 0 && data.docs.length > 0) {
          allScoredBooks = data.docs.map(book => {
            book.matchScore = calculateOverlapScore(book, text);
            book.subjects = book.subject ? book.subject.slice(0, 5).join(', ') : 'No categoritzat';
            return book;
          });
        }
        
        const maxOLScore = allScoredBooks.length > 0 ? Math.max(...allScoredBooks.map(b => b.matchScore)) : 0;
        let fromBNE = false;
        
        if (maxOLScore < 0.99) {
          try {
            const bneQuery = apiKeywords.join(' OR ');
            const bneUrl = baseUrl + '/api/bne?isbn=' + encodeURIComponent(bneQuery);
            const bneRes = await fetch(bneUrl);
            if (bneRes.ok) {
              const bneResData = await bneRes.json();
              if (bneResData && bneResData.docs && bneResData.docs.length > 0) {
                fromBNE = true;
                bneResData.docs.forEach(doc => {
                  const display = doc.pnx.display || {};
                  const addata = doc.pnx.addata || {};
                  
                  let title = 'Llibre desconegut';
                  if (display.title && display.title[0]) {
                    title = display.title[0].split('/')[0].trim();
                  }
                  
                  let author_name = [];
                  if (display.creator && display.creator[0]) {
                    author_name = [display.creator[0].split('$$')[0].trim()];
                  } else if (addata.creatorfull && addata.creatorfull[0]) {
                    author_name = [addata.creatorfull[0].split('$$')[0].trim()];
                  }
                  if (author_name.length > 0) {
                    let cleanAuthor = author_name[0].replace(/[\\d-]/g, '').trim();
                    if (cleanAuthor.endsWith(',')) cleanAuthor = cleanAuthor.slice(0, -1).trim();
                    if (cleanAuthor.includes(',')) {
                      cleanAuthor = cleanAuthor.split(',').reverse().join(' ').trim();
                    }
                    author_name = [cleanAuthor];
                  }
                  
                  let publisher = [];
                  if (display.publisher && display.publisher[0]) {
                    let pub = display.publisher[0].split(':')[1];
                    if (pub) pub = pub.split(',')[0].trim();
                    else pub = display.publisher[0].trim();
                    publisher = [pub];
                  } else if (addata.pub && addata.pub[0]) {
                    publisher = [addata.pub[0]];
                  }
                  
                  let first_publish_year = display.creationdate ? display.creationdate[0] : 'Any desc.';
                  const key = "/bne/" + (doc.context || 'L') + "/" + (doc.recordid || (doc.pnx.control && doc.pnx.control.sourcrecordid ? doc.pnx.control.sourcrecordid[0] : Math.random()));
                  
                  const normalizeTitle = t => (t || '').toLowerCase().replace(/[^\\w]/g, ' ').replace(/\\s+/g, ' ').trim();
                  const alreadyAdded = allScoredBooks.some(b => normalizeTitle(b.title) === normalizeTitle(title));
                  if (!alreadyAdded) {
                    let subjects = [];
                    if (display.genre) display.genre.forEach(g => subjects.push(g.split('$$')[0].trim()));
                    if (display.subject) display.subject.forEach(s => subjects.push(s.split('$$')[0].trim()));
                    let finalSubjects = subjects.length > 0 ? Array.from(new Set(subjects)).slice(0, 5).join(', ') : 'No categoritzat';

                    const bneBook = {
                      isBNE: true,
                      key: key,
                      title: title,
                      author_name: author_name,
                      publisher: publisher,
                      first_publish_year: first_publish_year,
                      isbn: [],
                      cover: '',
                      rawDoc: doc,
                      subjects: finalSubjects
                    };
                    bneBook.matchScore = calculateOverlapScore(bneBook, text);
                    allScoredBooks.push(bneBook);
                  }
                });
              }
            }
          } catch (eBne) {
            // ignore
          }
        }
        
        if (allScoredBooks.length > 0) {
          allScoredBooks.sort((a, b) => b.matchScore - a.matchScore);
          
          const mapped = allScoredBooks.map(b => ({
            key: b.key || ("/text/" + Math.random()),
            title: b.title,
            author_name: b.author_name || ['Autor desconegut'],
            publisher: b.publisher || ['Editorial desconeguda'],
            first_publish_year: b.first_publish_year,
            isbn: b.isbn || [],
            cover: b.cover || (b.cover_i ? "https://covers.openlibrary.org/b/id/" + b.cover_i + "-M.jpg" : ''),
            matchScore: b.matchScore,
            isBNE: b.isBNE || false,
            bneDoc: b.rawDoc || null,
            subjects: b.subjects || 'No categoritzat'
          }));
          
          await uploadCandidates(mapped);
          
          let displayQuery = text;
          if (isStructured) {
            const parts = [];
            if (queryTitol) parts.push('Títol: "' + queryTitol + '"');
            if (queryAutor) parts.push('Autor: "' + queryAutor + '"');
            if (queryEditorial) parts.push('Editorial: "' + queryEditorial + '"');
            displayQuery = parts.join(' | ') || 'Buida';
          } else {
            displayQuery = text.substring(0, 30) + "...";
          }
          
          self.postMessage({ action: 'search_results', results: mapped, query: (isStructured ? "Cerca estructurada: " : "Text: ") + displayQuery, strategy: strategy, fromBNE: fromBNE });
        } else {
          self.postMessage({ action: 'search_results', results: [], query: text, error: 'No s\\'ha trobat cap llibre coincidents als catàlegs.' });
        }
      } catch (err) {
        self.postMessage({ action: 'search_results', results: [], query: text, error: err.message });
      }
    }

    async function poll() {
      if (isPolling && baseUrl) {
        // Fallback to HTTP poll only if SSE connection has been inactive or offline for > 20s
        if (Date.now() - lastSseMessageTime > 20000) {
          try {
            const res = await fetch(baseUrl + '/api/poll?t=' + Date.now() + '&sid=' + sid, { cache: 'no-store' });
            if (res.ok) {
              const data = await res.json();
              const items = Array.isArray(data) ? data : (data ? [data] : []);
              for (const item of items) {
                if (item && item.type) {
                  if (item.type === 'isbn' || item.type === 'portada') {
                    self.postMessage({ action: 'scan_started', data: item });
                    if (item.type === 'isbn') {
                      await searchByIsbn(item.value);
                    } else {
                      await searchCatalogsWithText(item.value);
                    }
                  } else {
                    self.postMessage({ action: 'scan', data: item });
                  }
                }
              }
            }
          } catch (e) {
            // silenci
          }
        }
      }
      setTimeout(poll, 2000);
    }

    setTimeout(poll, 2000);
  `;

  try {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    pollWorker = new Worker(URL.createObjectURL(blob));
    pollWorker.postMessage({ action: 'init', baseUrl: getBaseUrl(), sid: sessionID });
    
    pollWorker.onmessage = function(e) {
      if (e.data.action === 'scan_started') {
        const item = e.data.data;
        isSearchInProgress = true;
        
        document.getElementById('connection-card').style.display = 'none';
        document.getElementById('search-card').style.display = 'block';
        document.getElementById('results-card').style.display = 'none';
        document.getElementById('db-card').style.display = 'none';
        
        const queryEl = document.getElementById('search-query');
        const statusEl = document.getElementById('search-status');
        
        if (item.type === 'isbn') {
          queryEl.innerText = `ISBN: ${item.value}`;
          statusEl.innerText = `Cercant ISBN als catàlegs de fons...`;
        } else if (item.type === 'portada') {
          let displayQuery = item.value;
          let displayRaw = item.value;
          let textForClean = item.value;
          try {
            if (item.value.trim().startsWith('{')) {
              const parsed = JSON.parse(item.value);
              if (parsed && typeof parsed === 'object') {
                const parts = [];
                if (parsed.titol) parts.push(`Títol: "${parsed.titol}"`);
                if (parsed.autor) parts.push(`Autor: "${parsed.autor}"`);
                if (parsed.editorial) parts.push(`Editorial: "${parsed.editorial}"`);
                if (parsed.id_tema) {
                  window.detectedThemeId = String(parsed.id_tema);
                } else {
                  window.detectedThemeId = '';
                }
                displayQuery = parts.join(' | ') || 'Cerca buida';
                displayRaw = JSON.stringify(parsed, null, 2);
                textForClean = [parsed.titol || '', parsed.autor || '', parsed.editorial || ''].filter(Boolean).join(' ');
              }
            }
          } catch (e) {
            // ignore
          }

          queryEl.innerText = item.value.trim().startsWith('{') ? `Cerca estructurada (Gemini): ${displayQuery}` : `Text Portada: "${item.value.substring(0, 50)}..."`;
          statusEl.innerText = `Cercant per text als catàlegs de fons...`;
          
          const rawOcrEl = document.getElementById('raw-ocr');
          if (rawOcrEl) {
            rawOcrEl.innerText = displayRaw;
          }
          const cleanOcrEl = document.getElementById('clean-ocr');
          if (cleanOcrEl) {
            const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
            const cleanText = textForClean.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
            const ocrWordsList = cleanText.split(/\s+/);
            const keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
            cleanOcrEl.innerText = keywords.join(', ');
          }
        }
      } else if (e.data.action === 'search_results') {
        const { results, query, strategy, fromBNE, error } = e.data;
        isSearchInProgress = false;
        
        const statusEl = document.getElementById('search-status');
        if (error) {
          if (statusEl) statusEl.innerText = 'Error en la cerca: ' + error;
        } else {
          allScoredBooks = results;
          lastSearchStrategy = strategy;
          lastUsedBNE = fromBNE;
          
          if (results) {
            window.bneCache = window.bneCache || {};
            results.forEach(b => {
              if (b.isBNE && b.bneDoc) {
                window.bneCache[b.key] = b.bneDoc;
              }
            });
          }
          
          document.getElementById('search-card').style.display = 'none';
          renderResults();
        }
      } else if (e.data.action === 'scan') {
        const data = e.data.data;
        if (data && data.type) {
          handleScan(data);
        }
      }
    };
    console.log("🟢 Web Worker de Polling inicialitzat correctament per evitar suspensions en segon pla.");
  } catch (err) {
    console.warn("⚠️ No s'ha pogut iniciar el Web Worker per al polling, usant fallback de main thread...", err);
    pollServer();
  }
}

async function pollServer() {
  if (!isPolling) return;
  try {
    const res = await fetch(`${getBaseUrl()}/api/poll?t=${Date.now()}&sid=${sessionID}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && item.type) {
            handleScan(item);
          }
        }
      } else if (data && data.type) {
        handleScan(data);
      }
    }
  } catch (e) {
    // console.warn("Poll error", e);
  }
  setTimeout(pollServer, 1000);
}

function handleScan(data) {
  isMobileConnected = true;
  if (data.type === 'connection') {
    const qrContainer = document.getElementById('qr-container');
    if (qrContainer) qrContainer.style.display = 'none';
    
    const descText = document.getElementById('connection-instructions');
    if (descText) descText.innerText = "L'escàner està actiu al teu mòbil. Enfoca un codi de barres, el text de l'ISBN o la portada d'un llibre.";
    
    const certHelp = document.getElementById('cert-help');
    if (certHelp) certHelp.style.display = 'none';
    
    document.getElementById('poll-status').innerHTML = '<span style="color: #27ae60; font-size: 1.15rem; font-weight: bold;">🟢 Mòbil connectat i actiu</span>';
    
    const floatStatusEl = document.getElementById('floating-qr-status');
    if (floatStatusEl) {
      floatStatusEl.innerHTML = '<span style="color: #27ae60; font-weight: bold;">🟢 Mòbil connectat</span>';
    }
    return;
  }

  if (data.type === 'book-selected') {
    console.log('[handleScan] Selecció de llibre rebuda:', data.book?.title);
    window.dispatchEvent(new CustomEvent('llibreviu-state-change', {
      detail: { state: 'filling', book: data.book }
    }));
    return;
  }

  // Quan el mòbil engega la càmera per escanejar un nou llibre, resetem l'estat de l'ordinador
  if (data.type === 'reset') {
    console.log('[handleScan] Reset rebut des del mòbil — tornant a l\'estat inicial.');
    isSearchInProgress = false;
    lastProcessedScanKey = null;  // Permet que el proper ISBN passi la deduplicació
    lastProcessedScanTime = 0;
    allScoredBooks = [];
    resetState();
    return;
  }

  // Deduplicació: ignorem si és el mateix scan rebut en menys de 10 segons
  const scanKey = `${data.type}:${data.type === 'portada-captured' ? 'captured' : (data.value || '').substring(0, 30)}`;
  const now = Date.now();
  if (scanKey === lastProcessedScanKey && (now - lastProcessedScanTime) < 10000) {
    console.log('[handleScan] Scan duplicat ignorat:', scanKey);
    return;
  }
  // Ignorem si ja hi ha una cerca en curs (evitem solapament)
  if (isSearchInProgress && data.type !== 'portada-captured') {
    console.log('[handleScan] Cerca en curs, scan ignorat:', scanKey);
    return;
  }
  lastProcessedScanKey = scanKey;
  lastProcessedScanTime = now;

  document.getElementById('connection-card').style.display = 'none';
  document.getElementById('search-card').style.display = 'block';
  document.getElementById('results-card').style.display = 'none';
  document.getElementById('db-card').style.display = 'none';
  
  const queryEl = document.getElementById('search-query');
  const statusEl = document.getElementById('search-status');
  
  if (data.type === 'isbn') {
    isSearchInProgress = true;
    queryEl.innerText = `ISBN: ${data.value}`;
    statusEl.innerText = `Cercant ISBN als catàlegs...`;
    if (pollWorker) {
      pollWorker.postMessage({ action: 'search_isbn', value: data.value });
    } else {
      searchByIsbn(data.value).finally(() => { isSearchInProgress = false; });
    }
  } else if (data.type === 'portada') {
    isSearchInProgress = true;
    let displayQuery = data.value;
    let displayRaw = data.value;
    let textForClean = data.value;
    try {
      if (data.value.trim().startsWith('{')) {
        const parsed = JSON.parse(data.value);
        if (parsed && typeof parsed === 'object') {
          const parts = [];
          if (parsed.titol) parts.push(`Títol: "${parsed.titol}"`);
          if (parsed.autor) parts.push(`Autor: "${parsed.autor}"`);
          if (parsed.editorial) parts.push(`Editorial: "${parsed.editorial}"`);
          displayQuery = parts.join(' | ') || 'Cerca buida';
          displayRaw = JSON.stringify(parsed, null, 2);
          textForClean = [parsed.titol || '', parsed.autor || '', parsed.editorial || ''].filter(Boolean).join(' ');
        }
      }
    } catch (e) {
      // ignore
    }

    queryEl.innerText = data.value.trim().startsWith('{') ? `Cerca estructurada (Gemini): ${displayQuery}` : `Text Portada: "${data.value.substring(0, 50)}..."`;
    statusEl.innerText = `Cercant per text als catàlegs...`;
    
    const rawOcrEl = document.getElementById('raw-ocr');
    if (rawOcrEl) {
      rawOcrEl.innerText = displayRaw;
    }
    const cleanOcrEl = document.getElementById('clean-ocr');
    if (cleanOcrEl) {
      const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
      const cleanText = textForClean.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
      const ocrWordsList = cleanText.split(/\s+/);
      const keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
      cleanOcrEl.innerText = keywords.join(', ');
    }

    if (pollWorker) {
      pollWorker.postMessage({ action: 'search_text', value: data.value });
    } else {
      searchCatalogsWithText(data.value, true);
      setTimeout(() => { isSearchInProgress = false; }, 30000);
    }
  } else if (data.type === 'portada-captured') {
    isSearchInProgress = true;
    queryEl.innerText = `Processant Portada des del mòbil...`;
    statusEl.innerText = `Rebuda captura del mòbil. Descarregant i analitzant...`;
    (async () => {
      try {
        const response = await fetch(`${getBaseUrl()}/api/camera-frame?t=${Date.now()}&sid=${sessionID}`);
        if (response.ok) {
          const blob = await response.blob();
          const file = new File([blob], 'captured-cover.jpg', { type: 'image/jpeg' });
          await handleFile(file);
        } else {
          statusEl.innerText = `Error en descarregar la imatge de portada del servidor.`;
        }
      } catch (err) {
        console.error("Error analitzant captura:", err);
        statusEl.innerText = `Error en processar la captura: ${err.message}`;
      } finally {
        isSearchInProgress = false;
      }
    })();
  }
}

// ==========================================
// CAMERA RELAY POLLING
// ==========================================

function initCameraRelay() {
  const POLL_MS = 250; 
  let lastTimestamp = 0;
  let relayActive = false;
  let pollTimer = null;

  const relayImg        = document.getElementById('relay-img');
  const relayPlaceholder = document.getElementById('relay-placeholder');
  const relayBadge      = document.getElementById('relay-badge');
  const relayStatusText = document.getElementById('relay-status-text');
  const btnRelayOcr     = document.getElementById('btn-relay-ocr');
  const relayPanel      = document.getElementById('camera-relay-panel');
  const relayOpenMobile = document.getElementById('relay-open-mobile');

  if (!relayImg) return;

  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.');
  if (isLocal) {
    relayPanel.style.display = 'block';
  } else {
    relayPanel.style.display = 'none';
    return;
  }

  if (relayOpenMobile) {
    let path = window.location.pathname;
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash !== -1) {
      path = path.substring(0, lastSlash + 1);
    } else {
      path = '/';
    }
    let localIp = 'localhost';
    fetch(`${getBaseUrl()}/api/ip?t=${Date.now()}`).then(res => res.json()).then(data => {
      localIp = data.ip || 'localhost';
      relayOpenMobile.href = `https://${localIp}:8443/mobile/?sid=${sessionID}`;
    }).catch(() => {
      relayOpenMobile.href = `https://localhost:8443/mobile/?sid=${sessionID}`;
    });
  }

  async function pollFrame() {
    try {
      const res = await fetch(`${getBaseUrl()}/api/camera-frame?t=${Date.now()}&sid=${sessionID}`, { cache: 'no-store' });
      if (res.status === 204) {
        setInactive();
      } else if (res.ok) {
        const ts = res.headers.get('X-Frame-Timestamp') || Date.now();
        if (ts !== lastTimestamp) {
          lastTimestamp = ts;
          const blob = await res.blob();
          const url  = URL.createObjectURL(blob);
          const old  = relayImg.src;
          relayImg.src = url;
          relayImg.style.display = 'block';
          relayPlaceholder.style.display = 'none';
          if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
          setActive();
        }
      }
    } catch (e) {
      // Silenci
    }
    if (pollTimer !== null) {
      pollTimer = setTimeout(pollFrame, POLL_MS);
    }
  }

  function setActive() {
    if (!relayActive) {
      relayActive = true;
      relayBadge.className = 'live';
      btnRelayOcr.disabled = false;
      relayStatusText.textContent = 'Càmera mòbil connectada i transmetent fotogrames.';
    }
  }

  function setInactive() {
    if (relayActive) {
      relayActive = false;
      relayBadge.className = '';
      btnRelayOcr.disabled = true;
      relayStatusText.textContent = 'Esperant connexió del mòbil en mode Portada...';
    }
  }

  // Comprovem estat del relay cada 2 segons
  setInterval(async () => {
    try {
      const res = await fetch(`${getBaseUrl()}/api/camera-status?sid=${sessionID}`);
      if (res.ok) {
        const data = await res.json();
        if (!data.active) setInactive();
      }
    } catch(e) {}
  }, 2000);

  // Botó de capturar fotograma i fer OCR a l'ordinador
  btnRelayOcr.addEventListener('click', async () => {
    if (!relayImg.src || relayImg.style.display === 'none') return;

    btnRelayOcr.disabled = true;
    btnRelayOcr.textContent = '⏳ Processant…';
    relayStatusText.textContent = 'Executant OCR sobre el fotograma a l\'ordinador…';

    try {
      const cvs = document.createElement('canvas');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = relayImg.src;
      await img.decode();
      cvs.width  = img.naturalWidth;
      cvs.height = img.naturalHeight;
      cvs.getContext('2d').drawImage(img, 0, 0);

      cvs.toBlob(async (blob) => {
        const file = new File([blob], 'relay-frame.jpg', { type: 'image/jpeg' });
        await handleFile(file);
      }, 'image/jpeg', 0.92);
    } catch (err) {
      relayStatusText.textContent = 'Error en processar fotograma: ' + err.message;
    } finally {
      setTimeout(() => {
        btnRelayOcr.disabled = false;
        btnRelayOcr.textContent = '🔍 Analitzar fotograma actual';
        relayStatusText.textContent = relayActive
          ? 'Càmera mòbil connectada i transmetent fotogrames.'
          : 'Esperant connexió del mòbil...';
      }, 2000);
    }
  });

  pollTimer = setTimeout(pollFrame, 500);
}

// ==========================================
// PREPROCESSAMENT D'IMATGES (ORDINADOR)
// ==========================================

function preprocessImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Redimensionem si és necessari (màx 1600px), mantenint proporcions
      const MAX_WIDTH = 1600;
      let width = img.width;
      let height = img.height;
      if (width > MAX_WIDTH) {
        height = Math.round(height * (MAX_WIDTH / width));
        width = MAX_WIDTH;
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      
      // Passem la imatge original sense alterar (PaddleOCR treballa millor en color)
      const previewUrl = canvas.toDataURL('image/jpeg', 0.95);

      // --- Càlcul de la nitidesa sobre la imatge original ---
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;
      const numPixels = width * height;
      const grays = new Uint8Array(numPixels);
      for (let i = 0; i < numPixels; i++) {
        grays[i] = Math.round((data[i*4] + data[i*4+1] + data[i*4+2]) / 3);
      }

      let minGrayVal = 255, maxGrayVal = 0, edgeSumVal = 0, edgeCountVal = 0;
      const step = Math.max(1, Math.round(numPixels / 40000));
      for (let i = 0; i < numPixels; i += step) {
        const g = grays[i];
        if (g < minGrayVal) minGrayVal = g;
        if (g > maxGrayVal) maxGrayVal = g;
      }
      const contrastVal = maxGrayVal - minGrayVal;
      const skip = step * 2 + 1;
      for (let y = 1; y < height - 1; y += skip) {
        for (let x = 1; x < width - 1; x += skip) {
          const idx = y * width + x;
          const val = grays[idx];
          const diffX = Math.abs(val - grays[idx + 1]);
          const diffY = Math.abs(val - grays[idx + width]);
          if (diffX > 15 || diffY > 15) { edgeSumVal += (diffX + diffY); edgeCountVal++; }
        }
      }
      const edgeDensityVal = edgeCountVal / ((width * height) / (skip * skip));
      const avgEdgeStrengthVal = edgeCountVal > 0 ? (edgeSumVal / edgeCountVal) : 0;
      let readabilityScore = Math.round((Math.min(100, Math.round((avgEdgeStrengthVal/50)*100)) * 0.6) +
                                        (Math.min(100, Math.round((edgeDensityVal/0.16)*100)) * 0.4));
      if (contrastVal < 90) readabilityScore = Math.round(readabilityScore * (contrastVal / 90));
      readabilityScore = Math.max(5, Math.min(99, readabilityScore));

      let readabilityLabel = '', readabilityColor = '';
      if (readabilityScore < 40)      { readabilityLabel = '⚠️ Desenfocada o amb poc text'; readabilityColor = '#e74c3c'; }
      else if (readabilityScore < 75) { readabilityLabel = '⚡ Nitidesa mitjana';            readabilityColor = '#f39c12'; }
      else                            { readabilityLabel = '✨ Nitidesa excel·lent';          readabilityColor = '#2ecc71'; }

      resolve({ previewUrl, readabilityScore, readabilityLabel, readabilityColor });
    };
    img.onerror = reject;
    
    const reader = new FileReader();
    reader.onload = (e) => { img.src = e.target.result; };
    reader.readAsDataURL(file);
  });
}

async function fetchWithProgress(url, label, statusElement) {
  statusElement.innerHTML = `⚙️ Connectant per descarregar ${label}...`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error ${response.status} descarregant ${label}`);
  }
  
  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  
  if (total === 0) {
    statusElement.innerHTML = `⚙️ Descarregant ${label} (mida desconeguda)...`;
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
    statusElement.innerHTML = `⚙️ Descarregant ${label}: <strong>${pct}%</strong> (${(loaded / 1024 / 1024).toFixed(1)}MB)...`;
  }
  
  const blob = new Blob(chunks);
  return URL.createObjectURL(blob);
}

// ==========================================
// DESKTOP PADDLEOCR + TESSERACT HYBRID OCR
// ==========================================

async function getOcrInstance() {
  if (ocrInstance) return ocrInstance;
  const statusEl = document.getElementById('status');
  statusEl.innerHTML = `⚙️ Inicialitzant: Carregant llibreria PaddleOCR...`;
  
  try {
    const module = await import('./paddleocr.js');
    const PaddleOCR = module.PaddleOCR;

    // Resoldre les adreces dels models des del servidor propi o CDN fallback
    const isLocalFile = window.location.protocol === 'file:';
    let detUrl = '';
    let recUrl = '';

    if (!isLocalFile) {
      detUrl = window.location.origin + '/models/PP-OCRv5_mobile_det_onnx.tar';
      recUrl = window.location.origin + '/models/PP-OCRv5_mobile_rec_onnx.tar';
    } else {
      detUrl = 'https://rogroc.github.io/open_library/models/PP-OCRv5_mobile_det_onnx.tar';
      recUrl = 'https://rogroc.github.io/open_library/models/PP-OCRv5_mobile_rec_onnx.tar';
    }
    
    const localDetObjectUrl = await fetchWithProgress(detUrl, 'model de detecció (4.8MB)', statusEl);
    const localRecObjectUrl = await fetchWithProgress(recUrl, 'model de reconeixement (9.0MB)', statusEl);

    statusEl.innerHTML = `⚙️ Inicialitzant el motor de xarxa neuronal d'intel·ligència artificial...`;

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
    statusEl.innerHTML = `<span style="color: #e74c3c">❌ Error inicialització: ${err.message}</span>`;
    throw err;
  }
}

// Funció per calcular el llindar d'Otsu en escala de grisos per a un bloc de text
function computeOtsuThreshold(grays) {
  const hist = new Array(256).fill(0);
  const total = grays.length;
  for (let i = 0; i < total; i++) {
    hist[grays[i]]++;
  }

  let sum = 0;
  for (let t = 0; t < 256; t++) {
    sum += t * hist[t];
  }

  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let varMax = 0;
  let threshold = 128; // Fallback per defecte

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) {
      varMax = varBetween;
      threshold = t;
    }
  }

  // Mantenim el llindar en un rang raonable per evitar text extremadament gruixut o prim
  if (threshold < 40) return 40;
  if (threshold > 200) return 200;
  return threshold;
}

// Funció per rotar un canvas determinats graus (90, 180, 270)
function rotateCanvas(canvas, degrees) {
  const rotatedCanvas = document.createElement('canvas');
  const ctx = rotatedCanvas.getContext('2d');
  
  if (degrees === 90 || degrees === 270) {
    rotatedCanvas.width = canvas.height;
    rotatedCanvas.height = canvas.width;
  } else {
    rotatedCanvas.width = canvas.width;
    rotatedCanvas.height = canvas.height;
  }
  
  ctx.translate(rotatedCanvas.width / 2, rotatedCanvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  
  return rotatedCanvas;
}

// Funció per executar la detecció de polígons de text de PaddleOCR sobre un canvas específic
async function detectPolysOnCanvas(canvas, ocrInstance) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  const ocrRes = await ocrInstance.predict(blob, {
    text_det_limit_side_len: 960,
    text_det_limit_type: 'min',
    text_det_thresh: 0.2,
    text_det_box_thresh: 0.4
  });
  const pageResult = ocrRes[0] || {};
  return (pageResult.items || []).map(item => item.poly);
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error de l'API de Gemini (${response.status}): ${errText}`);
  }

  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("No s'ha pogut extreure text de la resposta de Gemini.");
  }
  
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

async function handleFile(file) {
  const preview = document.getElementById('preview');
  const previewContainer = document.getElementById('preview-container');
  const overlayCanvas = document.getElementById('overlay-canvas');
  const statusEl = document.getElementById('status');

  document.getElementById('connection-card').style.display = 'none';
  document.getElementById('search-card').style.display = 'block';
  document.getElementById('results-card').style.display = 'none';
  document.getElementById('db-card').style.display = 'none';

  const queryEl = document.getElementById('search-query');
  const searchStatusEl = document.getElementById('search-status');

  queryEl.innerText = `Processant Portada: ${file.name}`;
  searchStatusEl.innerText = '⚙️ Inicialitzant motor OCR i aplicant filtres de visió...';

  // Mostrar preview provisional
  const reader = new FileReader();
  reader.onload = (event) => {
    preview.src = event.target.result;
    previewContainer.style.display = 'block';
  };
  reader.readAsDataURL(file);

  const selectedEngine = localStorage.getItem('ocr-engine') || 'gemini-api';
  const apiKey = localStorage.getItem('gemini-api-key') || '';

  if (selectedEngine === 'gemini-api') {
    try {
      const ctxOverlay = overlayCanvas.getContext('2d');
      overlayCanvas.width = 600;
      overlayCanvas.height = 800;
      ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

      let themeOptions = [];
      try {
        const stateRes = await fetch(`${getBaseUrl()}/api/session-state?sid=${sessionID}&t=${Date.now()}`, { cache: 'no-store' });
        if (stateRes.ok) {
          const stateData = await stateRes.json();
          if (stateData && stateData.formData && stateData.formData._selectOptions && stateData.formData._selectOptions.id_tema) {
            themeOptions = stateData.formData._selectOptions.id_tema;
          }
        }
      } catch (themeErr) {
        console.warn("Error fetching theme options in handleFile:", themeErr);
      }

      searchStatusEl.innerText = '🤖 Extraient text i classificant tema amb Gemini...';
      const text = await extractTextWithGemini(file, apiKey, themeOptions);
      console.log(`[Gemini OCR] Text extret: "${text}"`);
      
      let displayQuery = text;
      let displayRaw = text;
      let textForClean = text;
      try {
        if (text.trim().startsWith('{')) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            const parts = [];
            if (parsed.titol) parts.push(`Títol: "${parsed.titol}"`);
            if (parsed.autor) parts.push(`Autor: "${parsed.autor}"`);
            if (parsed.editorial) parts.push(`Editorial: "${parsed.editorial}"`);
            if (parsed.id_tema) {
              window.detectedThemeId = String(parsed.id_tema);
            } else {
              window.detectedThemeId = '';
            }
            displayQuery = parts.join(' | ') || 'Cerca buida';
            displayRaw = JSON.stringify(parsed, null, 2);
            textForClean = [parsed.titol || '', parsed.autor || '', parsed.editorial || ''].filter(Boolean).join(' ');
          }
        }
      } catch (e) {
        // ignore
      }

      queryEl.innerText = text.trim().startsWith('{') ? `Cerca estructurada (Gemini): ${displayQuery}` : `OCR Extret: "${text}"`;
      
      preview.onload = () => {
        overlayCanvas.width = preview.naturalWidth || preview.width || 600;
        overlayCanvas.height = preview.naturalHeight || preview.height || 800;
        ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        
        ctxOverlay.strokeStyle = 'rgba(46, 204, 113, 0.9)';
        ctxOverlay.fillStyle   = 'rgba(46, 204, 113, 0.05)';
        ctxOverlay.lineWidth = 5;
        ctxOverlay.strokeRect(10, 10, overlayCanvas.width - 20, overlayCanvas.height - 20);
        ctxOverlay.fillRect(10, 10, overlayCanvas.width - 20, overlayCanvas.height - 20);
      };
      if (preview.complete) {
        preview.onload();
      }

      const rawOcrEl = document.getElementById('raw-ocr');
      if (rawOcrEl) {
        rawOcrEl.innerText = displayRaw;
      }
      const cleanOcrEl = document.getElementById('clean-ocr');
      if (cleanOcrEl) {
        const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
        const cleanText = textForClean.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
        const ocrWordsList = cleanText.split(/\s+/);
        const keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
        cleanOcrEl.innerText = keywords.join(', ');
      }

      if (pollWorker) {
        pollWorker.postMessage({ action: 'search_text', value: text });
      } else {
        await searchCatalogsWithText(text, false);
      }
    } catch (err) {
      console.error("Gemini OCR Error:", err);
      searchStatusEl.innerText = `❌ Error Gemini: ${err.message}`;
    }
    return;
  }

  try {
    const { 
      previewUrl, readabilityScore, readabilityLabel, readabilityColor
    } = await preprocessImage(file);
    
    preview.src = previewUrl;
    searchStatusEl.innerHTML = `⚙️ Nitidesa de la foto: <strong style="color: ${readabilityColor}">${readabilityScore}% (${readabilityLabel})</strong>.<br>Inicialitzant PaddleOCR...`;
    
    const ocr = await getOcrInstance();
    
    searchStatusEl.innerText = '🔍 Detectant àrees de text amb PaddleOCR...';
    const colorBlob = await fetch(previewUrl).then(r => r.blob());
    const ocrRes = await ocr.predict(colorBlob, {
      text_det_limit_side_len: 960,
      text_det_limit_type: 'min',
      text_det_thresh: 0.2,
      text_det_box_thresh: 0.4
    });

    const pageResult = ocrRes[0] || {};
    let detectedPolys = (pageResult.items || []).map(item => item.poly);
    console.log(`[HybridOCR] PaddleOCR inicial ha detectat ${detectedPolys.length} regions de text.`);

    // --- CARREGUEM IMATGE D'ORIGEN EN CANVAS ---
    const sourceImg = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = previewUrl;
    });

    let srcCanvas = document.createElement('canvas');
    srcCanvas.width = sourceImg.naturalWidth;
    srcCanvas.height = sourceImg.naturalHeight;
    let srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(sourceImg, 0, 0);

    let rotationUsed = 0;

    // Si no s'ha detectat cap bloc de text, provem amb orientacions alternatives (90, 270, 180 graus)
    if (detectedPolys.length === 0) {
      console.log("[HybridOCR] No es detecta text en horitzontal. Provant de rotar la imatge...");
      const rotations = [90, 270, 180];
      for (const deg of rotations) {
        searchStatusEl.innerText = `🔄 Provant orientació de la foto a ${deg}º...`;
        const rotatedCanvas = rotateCanvas(srcCanvas, deg);
        const polys = await detectPolysOnCanvas(rotatedCanvas, ocr);
        console.log(`[HybridOCR] Prova ${deg}º: detectades ${polys.length} regions.`);
        if (polys.length > 0) {
          detectedPolys = polys;
          srcCanvas = rotatedCanvas;
          srcCtx = srcCanvas.getContext('2d');
          rotationUsed = deg;
          break;
        }
      }
    }

    // Guardem el canvas per poder-lo rotar manualment
    currentCoverCanvas = srcCanvas;
    window.currentCoverCanvas = srcCanvas;

    // Mostrem els controls de rotació
    const rotateControls = document.getElementById('rotate-controls');
    if (rotateControls) rotateControls.style.display = 'block';

    // Si hem rotat la imatge automàticament, actualitzem el preview
    if (rotationUsed > 0) {
      const rotatedUrl = srcCanvas.toDataURL('image/jpeg', 1.0);
      preview.src = rotatedUrl;
      await new Promise(r => setTimeout(r, 150));
    }

    await runOcrOnCanvas(srcCanvas, searchStatusEl, queryEl, overlayCanvas, preview, detectedPolys);

  } catch (err) {
    console.error("Error durant el processament OCR al desktop:", err);
    const searchStatusEl2 = document.getElementById('search-status');
    if (searchStatusEl2) searchStatusEl2.innerText = `❌ Error en el procés: ${err.message}`;
  }
}

// Funció de rotació manual de la imatge de portada
window.rotateCurrentImage = async function(degrees) {
  if (!currentCoverCanvas) return;
  const preview = document.getElementById('preview');
  const overlayCanvas = document.getElementById('overlay-canvas');
  const searchStatusEl = document.getElementById('search-status');
  const queryEl = document.getElementById('search-query');

  // Normalitzem degrees: -90 → 270
  const deg = ((degrees % 360) + 360) % 360;
  const rotated = rotateCanvas(currentCoverCanvas, deg);
  currentCoverCanvas = rotated;
  window.currentCoverCanvas = rotated;

  // Actualitzem el preview
  preview.src = rotated.toDataURL('image/jpeg', 1.0);
  await new Promise(r => setTimeout(r, 100));

  // Re-executem OCR sobre el canvas rotat
  document.getElementById('results-card').style.display = 'none';
  document.getElementById('search-card').style.display = 'block';
  const overlayCtx = overlayCanvas.getContext('2d');
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  await runOcrOnCanvas(rotated, searchStatusEl, queryEl, overlayCanvas, preview);
};

// Extracció de la lògica OCR en funció reutilitzable
async function runOcrOnCanvas(srcCanvas, searchStatusEl, queryEl, overlayCanvas, preview, predetectedPolys = null) {
  const selectedEngine = localStorage.getItem('ocr-engine') || 'gemini-api';
  const apiKey = localStorage.getItem('gemini-api-key') || '';

  if (selectedEngine === 'gemini-api') {
    let themeOptions = [];
    try {
      const stateRes = await fetch(`${getBaseUrl()}/api/session-state?sid=${sessionID}&t=${Date.now()}`, { cache: 'no-store' });
      if (stateRes.ok) {
        const stateData = await stateRes.json();
        if (stateData && stateData.formData && stateData.formData._selectOptions && stateData.formData._selectOptions.id_tema) {
          themeOptions = stateData.formData._selectOptions.id_tema;
        }
      }
    } catch (themeErr) {
      console.warn("Error fetching theme options in runOcrOnCanvas:", themeErr);
    }

    searchStatusEl.innerText = '🤖 Extraient text de la portada rotada amb Gemini 3.1 Flash Lite...';
    try {
      const blob = await new Promise(resolve => srcCanvas.toBlob(resolve, 'image/jpeg', 0.95));
      const text = await extractTextWithGemini(blob, apiKey, themeOptions);
      console.log(`[Gemini OCR] Text extret (rotat): "${text}"`);
      
      let displayQuery = text;
      let displayRaw = text;
      let textForClean = text;
      try {
        if (text.trim().startsWith('{')) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            const parts = [];
            if (parsed.titol) parts.push(`Títol: "${parsed.titol}"`);
            if (parsed.autor) parts.push(`Autor: "${parsed.autor}"`);
            if (parsed.editorial) parts.push(`Editorial: "${parsed.editorial}"`);
            displayQuery = parts.join(' | ') || 'Cerca buida';
            displayRaw = JSON.stringify(parsed, null, 2);
            textForClean = [parsed.titol || '', parsed.autor || '', parsed.editorial || ''].filter(Boolean).join(' ');
          }
        }
      } catch (e) {
        // ignore
      }

      queryEl.innerText = text.trim().startsWith('{') ? `Cerca estructurada (Gemini): ${displayQuery}` : `OCR Extret: "${text}"`;
      
      const ctxOverlay = overlayCanvas.getContext('2d');
      overlayCanvas.width = preview.naturalWidth || preview.width || 600;
      overlayCanvas.height = preview.naturalHeight || preview.height || 800;
      ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      ctxOverlay.strokeStyle = 'rgba(46, 204, 113, 0.9)';
      ctxOverlay.fillStyle   = 'rgba(46, 204, 113, 0.05)';
      ctxOverlay.lineWidth = 5;
      ctxOverlay.strokeRect(10, 10, overlayCanvas.width - 20, overlayCanvas.height - 20);
      ctxOverlay.fillRect(10, 10, overlayCanvas.width - 20, overlayCanvas.height - 20);
      
      const rawOcrEl = document.getElementById('raw-ocr');
      if (rawOcrEl) {
        rawOcrEl.innerText = displayRaw;
      }
      const cleanOcrEl = document.getElementById('clean-ocr');
      if (cleanOcrEl) {
        const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
        const cleanText = textForClean.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
        const ocrWordsList = cleanText.split(/\s+/);
        const keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
        cleanOcrEl.innerText = keywords.join(', ');
      }
      
      if (pollWorker) {
        pollWorker.postMessage({ action: 'search_text', value: text });
      } else {
        await searchCatalogsWithText(text, false);
      }
    } catch (err) {
      console.error("Gemini OCR (rotat) Error:", err);
      searchStatusEl.innerText = `❌ Error Gemini: ${err.message}`;
    }
    return;
  }

  try {
    // Detecció de polígons de text amb PaddleOCR sobre el canvas actual
    const ocr = await getOcrInstance();
    let detectedPolys = predetectedPolys;
    if (detectedPolys === null) {
      searchStatusEl.innerText = '🔍 Detectant àrees de text amb PaddleOCR...';
      detectedPolys = await detectPolysOnCanvas(srcCanvas, ocr);
    }
    console.log(`[runOcrOnCanvas] PaddleOCR ha detectat ${detectedPolys.length} regions de text.`);

    if (detectedPolys.length === 0) {
      searchStatusEl.innerText = '❌ PaddleOCR no ha detectat cap àrea de text en aquesta orientació. Prova de girar la imatge.';
      return;
    }

    if (!tesseractParallelWorkersInitialized) {
      searchStatusEl.innerText = '⚙️ Inicialitzant motors de Tesseract de l\'ordinador (cat + spa)...';
      const [wCat, wSpa] = await Promise.all([
        Tesseract.createWorker('cat'),
        Tesseract.createWorker('spa')
      ]);
      tesseractWorkerCat = wCat;
      tesseractWorkerSpa = wSpa;
      tesseractParallelWorkersInitialized = true;
    }

    // Configurem el mode PSM 7 (llegir una línia de text única) per a cada caixa de text
    await Promise.all([
      tesseractWorkerCat.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' }),
      tesseractWorkerSpa.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' })
    ]);

    const wordsNormal = [];
    const lines = [];
    const PAD = 8;

    searchStatusEl.innerText = `📖 Llegint ${detectedPolys.length} zones de text...`;

    const candidatePolys = [];
    for (let polyIdx = 0; polyIdx < detectedPolys.length; polyIdx++) {
      const poly = detectedPolys[polyIdx];
      if (!poly || poly.length < 4) continue;

      const pt0 = poly[0];
      const pt1 = poly[1];
      const pt2 = poly[2];
      const pt3 = poly[3];

      const w = Math.sqrt(Math.pow(pt1[0] - pt0[0], 2) + Math.pow(pt1[1] - pt0[1], 2));
      const h = Math.sqrt(Math.pow(pt3[0] - pt0[0], 2) + Math.pow(pt3[1] - pt0[1], 2));
      if (w < 15 || h < 12) continue; // Descartem regions massa petites (soroll)

      const area = w * h;
      candidatePolys.push({ polyIdx, poly, w, h, area, pt0, pt1, pt2, pt3 });
    }

    // Ordenem per àrea de text i agafem com a molt les 18 caixes principals per evitar cues eternes
    candidatePolys.sort((a, b) => b.area - a.area);
    const selectedPolys = candidatePolys.slice(0, 18);

    searchStatusEl.innerText = `📖 Llegint ${selectedPolys.length} zones de text...`;

    // Preparem totes les caixes de text
    const preparedBoxes = selectedPolys.map((item) => {
      const { polyIdx, poly, w, h, pt0, pt1, pt2, pt3 } = item;
      
      // Creem canvas per a la caixa de-skewed (redreçada) amb marge
      const bw = Math.round(w) + PAD * 2;
      const bh = Math.round(h) + PAD * 2;
      const boxCanvas = document.createElement('canvas');
      boxCanvas.width = bw;
      boxCanvas.height = bh;
      const boxCtx = boxCanvas.getContext('2d');
      boxCtx.fillStyle = '#ffffff';
      boxCtx.fillRect(0, 0, bw, bh);

      // Calculem l'angle d'inclinació de la línia de text
      const angle = Math.atan2(pt1[1] - pt0[1], pt1[0] - pt0[0]);

      boxCtx.save();
      // Retallem només l'interior de la caixa
      boxCtx.beginPath();
      boxCtx.moveTo(PAD, PAD);
      boxCtx.lineTo(PAD + w, PAD);
      boxCtx.lineTo(PAD + w, PAD + h);
      boxCtx.lineTo(PAD, PAD + h);
      boxCtx.closePath();
      boxCtx.clip();

      // Apliquem transformació afí per redreçar el text a horitzontal
      boxCtx.translate(PAD, PAD);
      boxCtx.rotate(-angle);
      boxCtx.translate(-pt0[0], -pt0[1]);
      boxCtx.drawImage(srcCanvas, 0, 0);
      boxCtx.restore();

      // Converteix la regió a escala de grisos i inverteix-la només si el fons és fosc
      const regionData = boxCtx.getImageData(0, 0, bw, bh);
      const d = regionData.data;

      // 1. Calculem la brillantor mitjana de la vora (fons) per detectar text negatiu
      let borderSum = 0;
      let borderCount = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          if (x < PAD || x >= bw - PAD || y < PAD || y >= bh - PAD) {
            const j = (y * bw + x) * 4;
            const gray = 0.299 * d[j] + 0.587 * d[j+1] + 0.114 * d[j+2];
            borderSum += gray;
            borderCount++;
          }
        }
      }
      const avgBackground = borderCount > 0 ? (borderSum / borderCount) : 255;
      const backgroundIsDark = avgBackground < 120; // Llindar per detectar fons fosc

      // 2. Mapagem a escala de grisos i invertim si cal
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const j = (y * bw + x) * 4;
          if (x < PAD || x >= bw - PAD || y < PAD || y >= bh - PAD) {
            d[j] = 255; d[j+1] = 255; d[j+2] = 255; d[j+3] = 255;
          } else {
            let gray = 0.299 * d[j] + 0.587 * d[j+1] + 0.114 * d[j+2];
            if (backgroundIsDark) {
              gray = 255 - gray; // Invertim perquè quedi text fosc sobre fons clar
            }
            d[j] = gray; d[j+1] = gray; d[j+2] = gray; d[j+3] = 255;
          }
        }
      }
      boxCtx.putImageData(regionData, 0, 0);
      
      return { polyIdx, poly, w, h, pt0, pt1, pt2, pt3, angle, boxCanvas };
    });

    const catMap = {};
    const spaMap = {};

    // Executem en paral·lel dues línies de processament (una per idioma).
    // Cada línia processa les caixes una per una seqüencialment per no col·lapsar la memòria
    // de WebAssembly de cadascun dels Web Workers.
    const runCatChain = async () => {
      for (const box of preparedBoxes) {
        try {
          const res = await tesseractWorkerCat.recognize(box.boxCanvas);
          catMap[box.polyIdx] = res;
        } catch (err) {
          console.error(`Error de Tesseract (cat) en la caixa index ${box.polyIdx}:`, err);
        }
      }
    };

    const runSpaChain = async () => {
      for (const box of preparedBoxes) {
        try {
          const res = await tesseractWorkerSpa.recognize(box.boxCanvas);
          spaMap[box.polyIdx] = res;
        } catch (err) {
          console.error(`Error de Tesseract (spa) en la caixa index ${box.polyIdx}:`, err);
        }
      }
    };

    // Esperem que s'hagin processat de forma independent ambdós idiomes
    await Promise.all([runCatChain(), runSpaChain()]);

    // Ara processem i agrupem els resultats obtinguts
    preparedBoxes.forEach((box) => {
      const resCat = catMap[box.polyIdx];
      const resSpa = spaMap[box.polyIdx];
      if (!resCat || !resSpa) return;

      const catConf = resCat.data.confidence;
      const spaConf = resSpa.data.confidence;
      const bestRes = catConf >= spaConf ? resCat : resSpa;

      const tesseractWords = bestRes.data.words || [];
      const cosA = Math.cos(box.angle);
      const sinA = Math.sin(box.angle);
      const lineWords = [];

      tesseractWords.forEach(w => {
        if (w.confidence > 30 && w.text.trim().length > 0) {
          // Rotem de tornada les cantonades de la paraula al pla original del llibre
          const rotatePoint = (lx, ly) => {
            const rx = lx * cosA - ly * sinA;
            const ry = lx * sinA + ly * cosA;
            return [rx + box.pt0[0], ry + box.pt0[1]];
          };
          const c1 = rotatePoint(w.bbox.x0 - PAD, w.bbox.y0 - PAD);
          const c2 = rotatePoint(w.bbox.x1 - PAD, w.bbox.y0 - PAD);
          const c3 = rotatePoint(w.bbox.x1 - PAD, w.bbox.y1 - PAD);
          const c4 = rotatePoint(w.bbox.x0 - PAD, w.bbox.y1 - PAD);

          const xs = [c1[0], c2[0], c3[0], c4[0]];
          const ys = [c1[1], c2[1], c3[1], c4[1]];

          const wordObj = {
            text: w.text.trim(),
            confidence: w.confidence,
            bbox: {
              x0: Math.min(...xs),
              y0: Math.min(...ys),
              x1: Math.max(...xs),
              y1: Math.max(...ys)
            },
            source: `box_${box.polyIdx}_tesseract`
          };

          wordsNormal.push(wordObj);
          lineWords.push(wordObj);
        }
      });

      if (lineWords.length > 0) {
        const cx = (box.pt0[0] + box.pt1[0] + box.pt2[0] + box.pt3[0]) / 4;
        const cy = (box.pt0[1] + box.pt1[1] + box.pt2[1] + box.pt3[1]) / 4;
        lines.push({
          cx: cx,
          cy: cy,
          angle: box.angle,
          poly: box.poly,
          words: lineWords
        });
      }
    });

    if (wordsNormal.length === 0) {
      searchStatusEl.innerText = '❌ No s\'ha detectat cap paraula a la portada.';
      return;
    }

    const allHeights = wordsNormal.map(w => w.bbox.y1 - w.bbox.y0);
    const maxWordHeight = allHeights.length > 0 ? Math.max(...allHeights) : 0;
    const heightThreshold = maxWordHeight * 0.20;
    const mergedWords = wordsNormal.filter(w =>
      (w.bbox.y1 - w.bbox.y0) >= heightThreshold && w.confidence > 40
    );

    // Dibuixem les caixes sobre l'overlay canvas
    const ctxOverlay = overlayCanvas.getContext('2d');
    overlayCanvas.width = preview.naturalWidth || preview.width || 600;
    overlayCanvas.height = preview.naturalHeight || preview.height || 800;
    ctxOverlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    ctxOverlay.lineWidth = Math.max(2, Math.round(overlayCanvas.width / 400));

    // Descartades en vermell
    wordsNormal.filter(w => !mergedWords.includes(w)).forEach(w => {
      ctxOverlay.strokeStyle = 'rgba(231, 76, 60, 0.3)';
      ctxOverlay.fillStyle   = 'rgba(231, 76, 60, 0.03)';
      ctxOverlay.fillRect(w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0);
      ctxOverlay.strokeRect(w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0);
    });
    // Vàlides en verd
    mergedWords.forEach(w => {
      ctxOverlay.strokeStyle = 'rgba(46, 204, 113, 0.9)';
      ctxOverlay.fillStyle   = 'rgba(46, 204, 113, 0.15)';
      ctxOverlay.fillRect(w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0);
      ctxOverlay.strokeRect(w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0);
    });

    if (mergedWords.length === 0) {
      searchStatusEl.innerText = '❌ No s\'ha trobat cap bloc de text principal a la portada.';
      return;
    }

    // Filtrem i processem les línies vàlides
    const validLines = [];
    lines.forEach(l => {
      const lineMergedWords = l.words.filter(w => mergedWords.includes(w));
      if (lineMergedWords.length > 0) {
        validLines.push({
          cx: l.cx,
          cy: l.cy,
          angle: l.angle,
          words: lineMergedWords
        });
      }
    });

    // Calculem l'angle d'inclinació predominant de la portada (mitjana)
    let avgAngle = 0;
    if (validLines.length > 0) {
      avgAngle = validLines.reduce((sum, l) => sum + l.angle, 0) / validLines.length;
    }

    // Ordenem les línies de dalt a baix en el pla de rotació local
    validLines.forEach(l => {
      l.localY = -l.cx * Math.sin(avgAngle) + l.cy * Math.cos(avgAngle);
    });
    validLines.sort((a, b) => a.localY - b.localY);

    // Dins de cada línia, ordenem les paraules d'esquerra a dreta en el pla de rotació local
    const sortedLinesText = validLines.map(l => {
      l.words.sort((a, b) => {
        const cxA = (a.bbox.x0 + a.bbox.x1) / 2;
        const cyA = (a.bbox.y0 + a.bbox.y1) / 2;
        const cxB = (b.bbox.x0 + b.bbox.x1) / 2;
        const cyB = (b.bbox.y0 + b.bbox.y1) / 2;

        const localXA = cxA * Math.cos(avgAngle) + cyA * Math.sin(avgAngle);
        const localXB = cxB * Math.cos(avgAngle) + cyB * Math.sin(avgAngle);
        return localXA - localXB;
      });
      return l.words.map(w => w.text).join(' ');
    });

    let text = sortedLinesText.join(' ');
    queryEl.innerText = `OCR Extret: "${text}"`;
    
    // Mostrem el text OCR brut i net a la interfície de depuració (el Worker no pot fer-ho)
    const rawOcrEl = document.getElementById('raw-ocr');
    if (rawOcrEl) {
      let normalizedText = text.replace(/ufia/gi, 'uña')
                               .replace(/fio/gi, 'ño')
                               .replace(/fia/gi, 'ña')
                               .replace(/iriba/gi, 'i riba')
                               .replace(/\brba\b/gi, 'riba')
                               .replace(/ll['’]?imperí?/gi, "i l'imperi")
                               .replace(/il['’]?imperí?/gi, "i l'imperi")
                               .replace(/l['’]?imperí?/gi, "l'imperi");
      if (mergedWords) {
        rawOcrEl.innerHTML = `<strong>Text normalitzat:</strong> ${normalizedText}\n\n` +
                             `<strong>Paraules detectades:</strong>\n` +
                             mergedWords.map(w => `- "${w.text}" (${w.confidence}%, y: ${w.bbox.y0}px)`).join('\n');
      } else {
        rawOcrEl.innerText = normalizedText;
      }
    }
    const cleanOcrEl = document.getElementById('clean-ocr');
    if (cleanOcrEl) {
      const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
      const cleanText = text.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
      const ocrWordsList = cleanText.split(/\s+/);
      const keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
      cleanOcrEl.innerText = keywords.join(', ');
    }

    if (pollWorker) {
      window.lastMergedWords = mergedWords;
      pollWorker.postMessage({ action: 'search_text', value: text });
    } else {
      await searchCatalogsWithText(text, false, mergedWords);
    }

  } catch (err) {
    console.error("Error durant el processament OCR al desktop:", err);
    if (searchStatusEl) searchStatusEl.innerText = `❌ Error en el procés: ${err.message}`;
  }
}

// ==========================================
// UNIFIED SEARCH LOGIC WITH SCORING & BNE FALLBACK
// ==========================================

async function searchCatalogsWithText(text, fromMobile = false, mergedWords = null) {
  const statusEl = document.getElementById('search-status');
  
  let isStructured = false;
  let queryTitol = '';
  let queryAutor = '';
  let queryEditorial = '';
  
  try {
    if (text.trim().startsWith('{')) {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        queryTitol = (parsed.titol || '').trim();
        queryAutor = (parsed.autor || '').trim();
        queryEditorial = (parsed.editorial || '').trim();
        if (queryTitol || queryAutor || queryEditorial) {
          isStructured = true;
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // 1. NORMALITZACIÓ D'ARTEFACTES D'OCR
  let normalizedText = text;
  let keywords = [];

  if (isStructured) {
    const combined = [queryTitol, queryAutor, queryEditorial].filter(Boolean).join(' ');
    normalizedText = combined;
    const cleanText = combined.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
    const ocrWordsList = cleanText.split(/\s+/);
    const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
    keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
  } else {
    let normalizedTextVal = text.replace(/ufia/gi, 'uña')
                             .replace(/fio/gi, 'ño')
                             .replace(/fia/gi, 'ña')
                             .replace(/iriba/gi, 'i riba')
                             .replace(/\brba\b/gi, 'riba')
                             .replace(/ll['’]?imperí?/gi, "i l'imperi")
                             .replace(/il['’]?imperí?/gi, "i l'imperi")
                             .replace(/l['’]?imperí?/gi, "l'imperi");
    normalizedText = normalizedTextVal;
    const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
    const cleanText = normalizedText.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
    const ocrWordsList = cleanText.split(/\s+/);
    keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);
  }

  // Mostrar debugs bruts
  const rawOcrEl = document.getElementById('raw-ocr');
  if (rawOcrEl) {
    if (mergedWords) {
      rawOcrEl.innerHTML = `<strong>Text normalitzat:</strong> ${normalizedText}\n\n` +
                           `<strong>Paraules detectades:</strong>\n` +
                           mergedWords.map(w => `- "${w.text}" (${w.confidence}%, y: ${w.bbox.y0}px)`).join('\n');
    } else {
      let displayRaw = text;
      try {
        if (text.trim().startsWith('{')) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            displayRaw = JSON.stringify(parsed, null, 2);
          }
        }
      } catch (e) {
        // ignore
      }
      rawOcrEl.innerText = displayRaw;
    }
  }

  statusEl.innerText = '🧹 Netejant i cercant paraules clau...';
  
  const cleanOcrEl = document.getElementById('clean-ocr');
  if (cleanOcrEl) {
    cleanOcrEl.innerText = keywords.join(', ');
  }
  
  if (keywords.length === 0) {
    statusEl.innerText = '❌ El text llegit era massa curt o invàlid.';
    return;
  }

  const apiKeywords = keywords.slice(0, 8);
  
  let url = "";
  let searchStrategy = "";
  
  if (isStructured) {
    statusEl.innerText = '🌐 Cercant a Open Library (Cerca estructurada Gemini)...';
    searchStrategy = 'Structured Gemini Query';
    let params = [];
    if (queryTitol) params.push("title=" + encodeURIComponent(queryTitol));
    if (queryAutor) params.push("author=" + encodeURIComponent(queryAutor));
    if (queryEditorial) params.push("publisher=" + encodeURIComponent(queryEditorial));
    url = `https://openlibrary.org/search.json?${params.join('&')}&fields=key,title,author_name,first_publish_year,cover_i,publisher&limit=30`;
  } else {
    statusEl.innerText = '🌐 Cercant a Open Library (Cerca estricta AND)...';
    searchStrategy = 'AND (Totes les paraules principals)';
    let andQuery = apiKeywords.join('+');
    url = `https://openlibrary.org/search.json?q=${andQuery}&fields=key,title,author_name,first_publish_year,cover_i,publisher&limit=30`;
  }
  
  try {
    let response = await fetch(url);
    let data = await response.json();

    if (isStructured && (data.numFound === 0 || data.docs.length === 0)) {
      statusEl.innerText = '🌐 Cerca estructurada buida. Cercant amb AND...';
      searchStrategy = 'Structured Fallback AND';
      let andQuery = apiKeywords.join('+');
      url = `https://openlibrary.org/search.json?q=${andQuery}&fields=key,title,author_name,first_publish_year,cover_i,publisher&limit=30`;
      response = await fetch(url);
      data = await response.json();
    }

    if (data.numFound === 0 || data.docs.length === 0) {
      statusEl.innerText = '🌐 Cap resultat exacte. Cercant amb Cerca laxada OR...';
      searchStrategy = isStructured ? 'Structured Fallback OR' : 'OR (Major nombre de coincidències)';
      let orQuery = apiKeywords.join('+OR+');
      url = `https://openlibrary.org/search.json?q=${orQuery}&fields=key,title,author_name,first_publish_year,cover_i,publisher&limit=30`;
      response = await fetch(url);
      data = await response.json();
    }

    statusEl.innerText = '✅ Analitzant les probabilitats...';
    
    if (data.numFound === 0 || data.docs.length === 0) {
      statusEl.innerText = '❌ No s\'ha trobat cap llibre a Open Library. Consultant BNE...';
      allScoredBooks = [];
    } else {
      allScoredBooks = data.docs.map(book => {
        book.matchScore = calculateOverlapScore(book, text);
        return book;
      });
    }

    lastSearchStrategy = searchStrategy;
    lastUsedBNE = false;

    const maxOLScore = allScoredBooks.length > 0 ? Math.max(...allScoredBooks.map(b => b.matchScore)) : 0;

    const isStaticGitHubPages = window.location.hostname.endsWith('github.io');
    if (maxOLScore < 0.99 && !isStaticGitHubPages) {
      statusEl.innerText = '🌐 Coincidència Open Library parcial. Consultant la BNE...';
      try {
        const bneQuery = apiKeywords.join(' OR ');
        const bneUrl = getBneApiUrl(bneQuery);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        let bneResData = null;
        try {
          const bneRes = await fetch(bneUrl, { signal: controller.signal });
          if (bneRes.ok) {
            bneResData = await bneRes.json();
          }
        } catch (err) {
          console.warn("La crida a la BNE ha fallat o expirat:", err);
        } finally {
          clearTimeout(timeoutId);
        }
        
        if (bneResData && bneResData.docs && bneResData.docs.length > 0) {
          window.bneCache = window.bneCache || {};
          
          const bneBooks = bneResData.docs.map(doc => {
            const display = doc.pnx.display || {};
            const addata = doc.pnx.addata || {};
            
            let title = 'Llibre desconegut';
            if (display.title && display.title[0]) {
              title = display.title[0].split('/')[0].trim();
            }
            
            let author_name = [];
            if (display.creator && display.creator[0]) {
              author_name = [display.creator[0].split('$$')[0].trim()];
            } else if (addata.creatorfull && addata.creatorfull[0]) {
              author_name = [addata.creatorfull[0].split('$$')[0].trim()];
            }
            if (author_name.length > 0) {
              let cleanAuthor = author_name[0].replace(/[\d-]/g, '').trim();
              if (cleanAuthor.endsWith(',')) cleanAuthor = cleanAuthor.slice(0, -1).trim();
              if (cleanAuthor.includes(',')) {
                cleanAuthor = cleanAuthor.split(',').reverse().join(' ').trim();
              }
              author_name = [cleanAuthor];
            }

            let publisher = [];
            if (display.publisher && display.publisher[0]) {
              let pub = display.publisher[0].split(':')[1];
              if (pub) pub = pub.split(',')[0].trim();
              else pub = display.publisher[0].trim();
              publisher = [pub];
            } else if (addata.pub && addata.pub[0]) {
              publisher = [addata.pub[0]];
            }

            let first_publish_year = display.creationdate ? display.creationdate[0] : 'Any desc.';
            let isbn = '';
            if (addata.isbn && addata.isbn[0]) {
              isbn = addata.isbn[0].replace(/[^0-9X]/gi, '');
            }

            const key = `/bne/${doc.context || 'L'}/${doc.recordid || (doc.pnx.control && doc.pnx.control.sourcrecordid ? doc.pnx.control.sourcrecordid[0] : Math.random())}`;
            window.bneCache[key] = doc;

            return {
              key: key,
              title: title,
              author_name: author_name,
              first_publish_year: first_publish_year,
              publisher: publisher,
              cover_i: null,
              isBNE: true,
              isbn: isbn
            };
          });

          let scoredBne = bneBooks.map(book => {
            book.matchScore = calculateOverlapScore(book, text);
            return book;
          });

          allScoredBooks = [...allScoredBooks, ...scoredBne];
          if (scoredBne.length > 0) {
            lastUsedBNE = true;
          }
        }
      } catch (e) {
        console.warn("Error consultant BNE:", e);
      }
    }

    document.getElementById('search-card').style.display = 'none';
    renderResults();
    uploadCandidates();
  } catch (err) {
    console.error(err);
    statusEl.innerText = `❌ Error en la cerca: ${err.message}`;
  }
}

// ==========================================
// SEARCH BY ISBN (SIMPLE FLOW)
// ==========================================

async function searchByIsbn(isbn) {
  const cleanIsbn = isbn.replace(/[^0-9X]/gi, '');
  const googleApiUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`;
  // Usem la Search API (isbn=ISBN) en lloc de /api/books que dona 500 sovint
  const openLibrarySearchUrl = `https://openlibrary.org/search.json?isbn=${cleanIsbn}&fields=key,title,author_name,first_publish_year,cover_i,publisher&limit=5`;
  const bneUrl = getBneApiUrl(cleanIsbn);
  
  const statusEl = document.getElementById('search-status');
  statusEl.innerText = 'Cercant ISBN als catàlegs de Google, Open Library i BNE...';
  
  // Funció helper amb timeout per evitar blocatge
  const fetchWithTimeout = (url, ms = 8000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal })
      .then(r => { clearTimeout(timer); return r; })
      .catch(err => { clearTimeout(timer); throw err; });
  };

  try {
    const [googleRes, olSearchRes, bneRes] = await Promise.allSettled([
      fetchWithTimeout(googleApiUrl, 5000).then(r => {
        if (r.status === 429) {
          console.warn("Google Books API ha retornat 429 (Too Many Requests). Usant fallbacks...");
          return null;
        }
        return r.ok ? r.json() : null;
      }).catch(err => {
        console.warn("Error al connectar amb Google Books:", err);
        return null;
      }),
      fetchWithTimeout(openLibrarySearchUrl, 10000).then(r => r.ok ? r.json() : null).catch(() => null),
      fetchWithTimeout(bneUrl, 12000).then(r => r.ok ? r.json() : null).catch(() => null)
    ]);
    
    let googleData = googleRes.status === 'fulfilled' ? googleRes.value : null;
    let olSearchData = olSearchRes.status === 'fulfilled' ? olSearchRes.value : null;
    let bneData = bneRes.status === 'fulfilled' ? bneRes.value : null;
    
    console.log('[searchByIsbn] Google:', googleData ? 'OK' : 'null/429',
                '| OL Search:', olSearchData ? `${olSearchData.numFound || 0} docs` : 'null',
                '| BNE:', bneData ? `${(bneData.docs||[]).length} docs` : 'null');
    statusEl.innerText = 'Processant resultats...';
    
    let booksFound = [];
    const normalizeTitle = t => (t || '').toLowerCase().replace(/[^\w]/g, ' ').replace(/\s+/g, ' ').trim();
    
    // 1. Google Books
    if (googleData && googleData.totalItems > 0) {
      const info = googleData.items[0].volumeInfo;
      booksFound.push({
        source: 'Google Books',
        title: info.title || 'Sense títol',
        authors: info.authors ? info.authors.join(', ') : 'Autor desconegut',
        publisher: info.publisher || 'Editorial desconeguda',
        year: info.publishedDate || '',
        isbn: cleanIsbn,
        cover: info.imageLinks ? (info.imageLinks.thumbnail || '') : ''
      });
    }
    
    // 2. Open Library (Search API per ISBN)
    if (olSearchData && olSearchData.docs && olSearchData.docs.length > 0) {
      olSearchData.docs.forEach(doc => {
        const docTitle = doc.title || 'Sense títol';
        const alreadyAdded = booksFound.some(b => normalizeTitle(b.title) === normalizeTitle(docTitle));
        if (!alreadyAdded) {
          // publisher pot ser array o undefined
          const pubArr = Array.isArray(doc.publisher) ? doc.publisher : (doc.publisher ? [doc.publisher] : []);
          booksFound.push({
            source: 'Open Library',
            title: docTitle,
            authors: doc.author_name ? doc.author_name.join(', ') : 'Autor desconegut',
            publisher: pubArr.slice(0, 2).join(', ') || 'Editorial desconeguda',
            year: doc.first_publish_year || '',
            isbn: cleanIsbn,
            cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : ''
          });
        }
      });
    }
    
    // 3. BNE
    if (bneData && bneData.docs && bneData.docs.length > 0) {
      window.bneCache = window.bneCache || {};
      bneData.docs.forEach(doc => {
        const display = doc.pnx.display || {};
        const addata = doc.pnx.addata || {};
        
        let title = 'Llibre desconegut';
        if (display.title && display.title[0]) {
          title = display.title[0].split('/')[0].trim();
        }
        
        let author_name = [];
        if (display.creator && display.creator[0]) {
          author_name = [display.creator[0].split('$$')[0].trim()];
        } else if (addata.creatorfull && addata.creatorfull[0]) {
          author_name = [addata.creatorfull[0].split('$$')[0].trim()];
        }
        if (author_name.length > 0) {
          let cleanAuthor = author_name[0].replace(/[\d-]/g, '').trim();
          if (cleanAuthor.endsWith(',')) cleanAuthor = cleanAuthor.slice(0, -1).trim();
          if (cleanAuthor.includes(',')) {
            cleanAuthor = cleanAuthor.split(',').reverse().join(' ').trim();
          }
          author_name = [cleanAuthor];
        }

        let publisher = [];
        if (display.publisher && display.publisher[0]) {
          let pub = display.publisher[0].split(':')[1];
          if (pub) pub = pub.split(',')[0].trim();
          else pub = display.publisher[0].trim();
          publisher = [pub];
        } else if (addata.pub && addata.pub[0]) {
          publisher = [addata.pub[0]];
        }

        let first_publish_year = display.creationdate ? display.creationdate[0] : 'Any desc.';
        
        const key = `/bne/${doc.context || 'L'}/${doc.recordid || (doc.pnx.control && doc.pnx.control.sourcrecordid ? doc.pnx.control.sourcrecordid[0] : Math.random())}`;
        window.bneCache[key] = doc;

        const alreadyAdded = booksFound.some(b => normalizeTitle(b.title) === normalizeTitle(title));
        if (!alreadyAdded) {
          booksFound.push({
            source: 'BNE',
            key: key,
            title: title,
            authors: author_name.join(', ') || 'Autor desconegut',
            publisher: publisher.join(', ') || 'Editorial desconeguda',
            year: first_publish_year,
            isbn: cleanIsbn,
            cover: `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-M.jpg`
          });
        }
      });
    }
    
    if (booksFound.length === 0) {
      statusEl.innerText = 'No s\'ha trobat cap llibre amb aquest ISBN als catàlegs de Google Books, Open Library o BNE.';
    } else {
      // Mapegem per resultats simplificats
      allScoredBooks = booksFound.map(b => ({
        key: b.key || `/isbn/${b.isbn}`,
        title: b.title,
        author_name: [b.authors],
        publisher: [b.publisher],
        first_publish_year: b.year,
        isbn: [b.isbn],
        cover: b.cover,
        matchScore: 1.0,
        isISBNMode: true,
        source: b.source,
        isBNE: b.source === 'BNE'
      }));
      lastSearchStrategy = 'ISBN Exact Match';
      lastUsedBNE = booksFound.some(b => b.source === 'BNE');
      document.getElementById('search-card').style.display = 'none';
      renderResults();
      uploadCandidates();
    }
    
  } catch (err) {
    console.error(err);
    statusEl.innerText = 'Error en la cerca: ' + err.message;
    fetch(`${getBaseUrl()}/api/scan?sid=${sessionID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'log', value: '[Desktop Error] ' + err.stack, sid: sessionID })
    }).catch(() => {});
  }
}


function uploadCandidates() {
  const sorted = [...allScoredBooks].sort((a, b) => b.matchScore - a.matchScore).slice(0, 10);
  const placeholderSvg = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2260%22%20height%3D%2290%22%20viewBox%3D%220%200%2060%2090%22%3E%3Crect%20fill%3D%22%23ecf0f1%22%20width%3D%2260%22%20height%3D%2290%22%20%2F%3E%3Ctext%20fill%3D%22%2395a5a6%22%20font-family%3D%22sans-serif%22%20font-size%3D%229%22%20font-weight%3D%22bold%22%20x%3D%2250%25%22%20y%3D%2250%25%22%20text-anchor%3D%22middle%22%3ESense%20Port.%3C%2Ftext%3E%3C%2Fsvg%3E";
  const mapped = sorted.map(book => {
    let coverUrl = placeholderSvg;
    if (book.isBNE && book.isbn) {
      coverUrl = `https://covers.openlibrary.org/b/isbn/${book.isbn}-M.jpg`;
    } else if (book.cover_i) {
      coverUrl = `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`;
    } else if (book.cover) {
      coverUrl = book.cover;
    }
    const authors = book.author_name ? book.author_name.join(', ') : 'Autor desconegut';
    const publishers = book.publisher ? (Array.isArray(book.publisher) ? book.publisher.slice(0, 2).join(', ') : book.publisher) : 'Editorial desconeguda';
    const publishYear = book.first_publish_year || 'Desconegut';
    let isbnVal = '';
    if (book.isbn) {
      isbnVal = Array.isArray(book.isbn) ? book.isbn[0] : book.isbn;
    }
    return {
      key: book.key,
      title: book.title,
      author: authors,
      authors: authors,
      publisher: publishers,
      year: publishYear,
      isbn: isbnVal,
      cover: coverUrl,
      source: book.isBNE ? 'BNE' : (book.source || 'Open Library'),
      id_tema: window.detectedThemeId || ''
    };
  });

  fetch(`${getBaseUrl()}/api/candidates?sid=${sessionID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidates: mapped, sid: sessionID })
  }).catch(err => console.error("Error uploading candidates:", err));
}

// ==========================================
// RENDER AND UTILITY FUNCTIONS
// ==========================================

function getBaseUrl() {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.')) {
    return window.location.origin;
  }
  // Si estem a GitHub Pages o un altre entorn remoti, demanem al servidor local HTTP al port 8080
  // ja que els navegadors permeten peticions HTTP a localhost de forma segura des d'HTTPS.
  return 'http://localhost:8080';
}

function getBneApiUrl(keywords) {
  return `${getBaseUrl()}/api/bne?isbn=${encodeURIComponent(keywords)}`;
}

function calculateOverlapScore(book, ocrTextRaw) {
  let textToMatch = ocrTextRaw;
  try {
    if (ocrTextRaw.trim().startsWith('{')) {
      const parsed = JSON.parse(ocrTextRaw);
      if (parsed && typeof parsed === 'object') {
        textToMatch = [parsed.titol || '', parsed.autor || '', parsed.editorial || ''].filter(Boolean).join(' ');
      }
    }
  } catch (e) {
    // ignore
  }
  const ocrWords = new Set(textToMatch.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '').split(/\s+/));
  
  const titleWords = (book.title || '').toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '').split(/\s+/).filter(w => w.length > 1);
  let titleMatches = 0;
  for (let w of titleWords) {
    if (ocrWords.has(w)) titleMatches++;
  }
  const titleScore = titleWords.length > 0 ? (titleMatches / titleWords.length) : 0;

  let authorScore = 0;
  if (book.author_name && book.author_name.length > 0) {
    const authorWords = book.author_name[0].toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '').split(/\s+/).filter(w => w.length > 1);
    let authorMatches = 0;
    for (let w of authorWords) {
      if (ocrWords.has(w)) authorMatches++;
    }
    authorScore = authorWords.length > 0 ? (authorMatches / authorWords.length) : 0;
  }

  return (titleScore * 0.6) + (authorScore * 0.4);
}

function renderResults() {
  const container = document.getElementById('results');
  container.innerHTML = '';
  document.getElementById('results-card').style.display = 'block';

  let filtered = [...allScoredBooks];
  filtered.sort((a, b) => b.matchScore - a.matchScore);
  let topBooks = filtered.slice(0, 10);

  if (topBooks.length === 0) {
    container.innerHTML = `<p style="color: #e74c3c;">❌ No s'ha trobat cap llibre coincident.</p>`;
    return;
  }

  let htmlContent = `<p style="font-size: 0.9rem; color: #555;">Resultats unificats (OL / BNE) via: <span class="badge" style="background:${lastSearchStrategy.includes('OR') ? '#f39c12' : '#27ae60'};">${lastSearchStrategy}</span>${lastUsedBNE ? ' + <span class="badge" style="background:#e74c3c;">BNE Fallback</span>' : ''}</p><p style="font-size: 0.85rem; color: #7f8c8d; margin-bottom: 15px;">💡 Clica sobre qualsevol llibre de la llista per veure'n els detalls i desar-lo.</p>`;
  
  topBooks.forEach((book, index) => {
    const placeholderSvg = "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2260%22%20height%3D%2290%22%20viewBox%3D%220%200%2060%2090%22%3E%3Crect%20fill%3D%22%23ecf0f1%22%20width%3D%2260%22%20height%3D%2290%22%20%2F%3E%3Ctext%20fill%3D%22%2395a5a6%22%20font-family%3D%22sans-serif%22%20font-size%3D%229%22%20font-weight%3D%22bold%22%20x%3D%2250%25%22%20y%3D%2250%25%22%20text-anchor%3D%22middle%22%3ESense%20Port.%3C%2Ftext%3E%3C%2Fsvg%3E";
    
    let coverUrl = placeholderSvg;
    if (book.isBNE && book.isbn) {
      coverUrl = `https://covers.openlibrary.org/b/isbn/${book.isbn}-M.jpg`;
    } else if (book.cover_i) {
      coverUrl = `https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`;
    } else if (book.cover) {
      coverUrl = book.cover;
    }

    const authors = book.author_name ? book.author_name.join(', ') : 'Autor desconegut';
    const apiTitle = book.title;
    const publishers = book.publisher ? (Array.isArray(book.publisher) ? book.publisher.slice(0, 2).join(', ') : book.publisher) : 'Editorial desconeguda';
    const scorePercent = (book.matchScore * 100).toFixed(1);
    const scoreNum = parseFloat(scorePercent);
    
    let color = scoreNum > 70 ? '#27ae60' : (scoreNum > 40 ? '#f39c12' : '#c0392b');

    const safeTitle = apiTitle.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeAuthors = authors.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const publishYear = book.first_publish_year || 'Desconegut';

    let sourceBadge = `<span class="badge" style="background: #3498db;">OL</span>`;
    if (book.isBNE) {
      sourceBadge = `<span class="badge" style="background: #e74c3c;">BNE</span>`;
    } else if (book.isISBNMode) {
      sourceBadge = `<span class="badge" style="background: #9b59b6;">${book.source}</span>`;
    }

    const item = document.createElement('div');
    item.className = 'book-item';
    item.style.cursor = 'pointer';
    item.style.transition = 'background 0.2s';
    item.setAttribute('onclick', `window.fetchBookDetails('${book.key}', '${safeTitle}', '${coverUrl}', '${safeAuthors}', '${publishYear}')`);
    item.addEventListener('mouseover', function() { this.style.background = '#f0f8ff'; });
    item.addEventListener('mouseout', function() { this.style.background = 'transparent'; });
    
    item.innerHTML = `
      <img src="${coverUrl}" alt="Cover" onerror="this.src='${placeholderSvg}'">
      <div class="book-info">
        <h4>${index + 1}. ${apiTitle} (${publishYear}) ${sourceBadge}</h4>
        <p>👤 Autor: ${authors}</p>
        <p>🏢 Editorial: ${publishers}</p>
        <p style="margin-top: 5px;">📊 Probabilitat: <strong style="color: ${color};">${scorePercent}%</strong></p>
      </div>
    `;
    
    container.appendChild(item);
  });
}

window.fetchBookDetails = async function(key, title, coverUrl, authors, publishYear) {
  const modal = document.getElementById('book-details-modal');
  const detailsContent = document.getElementById('details-content');
  
  modal.style.display = 'flex';
  detailsContent.innerHTML = `<div style="text-align: center; color: #3498db; margin: 20px 0;">⏳ Obtenint dades de catàleg per a "${title}"...</div>`;

  try {
    if (key.startsWith('/isbn/')) {
      const book = allScoredBooks.find(b => b.key === key);
      detailsContent.innerHTML = `
        <div style="display: flex; gap: 30px; margin-bottom: 20px; flex-wrap: wrap; text-align: left;">
          <img src="${coverUrl}" style="width: 180px; object-fit: contain; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" alt="Cover" onerror="this.style.display='none'">
          <div style="flex: 1; min-width: 250px;">
            <h2 style="margin: 0 0 10px 0; font-size: 1.5rem; color: #2c3e50; line-height: 1.3;">${title}</h2>
            <span style="background: #9b59b6; color: white; padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; display: inline-block; margin-bottom: 20px;">Llibre (${book.source})</span>
            <div style="margin-top: 10px;">
              <h3 style="background: #f2f2f2; padding: 8px 12px; margin: 0 0 12px 0; font-size: 1rem; color: #444; font-weight: normal; border-radius: 4px;">Informació general</h3>
              <div style="font-size: 0.9rem; color: #666; line-height: 1.8; padding-left: 5px;">
                <div>Autor: <strong style="color: #27ae60;">${authors}</strong></div>
                <div>Editorial: <span>${book.publisher}</span></div>
                <div>Any d'edició: <span>${publishYear}</span></div>
                <div>ISBN: <span>${book.isbn[0]}</span></div>
              </div>
              <button id="sync-desktop-btn" onclick="window.syncSelectedBook({ title: '${title.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', authors: '${authors.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', publisher: '${String(book.publisher).replace(/'/g, "\\'").replace(/"/g, '&quot;')}', publishYear: '${publishYear}', place: 'Desconegut', subjects: 'No categoritzat', isbn: '${book.isbn[0]}', source: '${book.source}', cover: '${coverUrl}' })" style="margin-top: 20px; width: 100%; padding: 12px; background: #27ae60; color: white; border: none; border-radius: 6px; font-weight: bold; font-size: 1rem; cursor: pointer; transition: background 0.2s;">
                📥 Desar a la base de dades Llibreviu
              </button>
            </div>
          </div>
        </div>
      `;
      // Auto-sync on selection
      window.syncSelectedBook({
        title: title,
        authors: authors,
        publisher: Array.isArray(book.publisher) ? book.publisher.join(', ') : book.publisher,
        publishYear: publishYear,
        place: 'Desconegut',
        subjects: 'No categoritzat',
        isbn: book.isbn ? book.isbn[0] : '',
        source: book.source,
        cover: coverUrl
      }, true);
      return;
    }

    if (key.startsWith('/bne/')) {
      const doc = window.bneCache ? window.bneCache[key] : null;
      if (!doc) throw new Error("No s'han trobat dades locals per aquest llibre de la BNE.");
      
      const display = doc.pnx.display || {};
      const addata = doc.pnx.addata || {};

      let finalPublishers = 'Desconeguda';
      if (display.publisher && display.publisher[0]) {
        let pub = display.publisher[0].split(':')[1];
        if (pub) finalPublishers = pub.split(',')[0].trim();
        else finalPublishers = display.publisher[0].trim();
      } else if (addata.pub && addata.pub[0]) {
        finalPublishers = addata.pub[0];
      }

      let finalPlaces = 'Desconegut';
      if (display.publisher && display.publisher[0]) {
        finalPlaces = display.publisher[0].split(':')[0].trim();
      }

      let subjects = [];
      if (display.genre) display.genre.forEach(g => subjects.push(g.split('$$')[0].trim()));
      if (display.subject) display.subject.forEach(s => subjects.push(s.split('$$')[0].trim()));
      let finalSubjects = subjects.length > 0 ? Array.from(new Set(subjects)).slice(0, 5).join(', ') : 'No categoritzat';

      if (finalSubjects !== 'No categoritzat') {
        try {
          const translateResponse = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(finalSubjects)}&langpair=en|ca`);
          const translateData = await translateResponse.json();
          if (translateData && translateData.responseData && translateData.responseData.translatedText) {
            finalSubjects = translateData.responseData.translatedText;
          }
        } catch (e) {}
      }

      const book = allScoredBooks.find(b => b.key === key);
      const isbnVal = book ? (book.isbn || "") : "";

      detailsContent.innerHTML = `
        <div style="display: flex; gap: 30px; margin-bottom: 20px; flex-wrap: wrap; text-align: left;">
          <img src="${coverUrl}" style="width: 180px; object-fit: contain; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" alt="Cover" onerror="this.style.display='none'">
          
          <div style="flex: 1; min-width: 250px;">
            <h2 style="margin: 0 0 10px 0; font-size: 1.5rem; color: #2c3e50; line-height: 1.3;">${title}</h2>
            <span style="background: #e74c3c; color: white; padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; display: inline-block; margin-bottom: 20px;">Llibre (BNE)</span>
            
            <div style="margin-top: 10px;">
              <h3 style="background: #f2f2f2; padding: 8px 12px; margin: 0 0 12px 0; font-size: 1rem; color: #444; font-weight: normal; border-radius: 4px;">Informació general</h3>
              
              <div style="font-size: 0.9rem; color: #666; line-height: 1.8; padding-left: 5px;">
                <div>Autor: <strong style="color: #27ae60;">${authors}</strong></div>
                <div>Editorial: <span>${finalPublishers}</span></div>
                <div>Any d'edició: <span>${publishYear}</span></div>
                <div>Lloc d'edició: <span>${finalPlaces}</span></div>
                <div>Categoria: <strong style="color: #27ae60;">${finalSubjects}</strong></div>
              </div>
              
              <button id="sync-desktop-btn" onclick="window.syncSelectedBook({ title: '${title.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', authors: '${authors.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', publisher: '${finalPublishers.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', publishYear: '${publishYear}', place: '${finalPlaces.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', subjects: '${finalSubjects.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', isbn: '${isbnVal}', source: 'BNE', cover: '${coverUrl}' })" style="margin-top: 20px; width: 100%; padding: 12px; background: #27ae60; color: white; border: none; border-radius: 6px; font-weight: bold; font-size: 1rem; cursor: pointer; transition: background 0.2s;">
                📥 Desar a la base de dades Llibreviu
              </button>
            </div>
          </div>
        </div>
      `;
      // Auto-sync on selection
      window.syncSelectedBook({
        title: title,
        authors: authors,
        publisher: finalPublishers,
        publishYear: publishYear,
        place: finalPlaces,
        subjects: finalSubjects,
        isbn: isbnVal,
        source: 'BNE',
        cover: coverUrl
      }, true);
      return;
    }

    const workResponse = await fetch(`https://openlibrary.org${key}.json`);
    const workData = await workResponse.json();
    
    const editionsResponse = await fetch(`https://openlibrary.org${key}/editions.json?limit=50`);
    const editionsData = await editionsResponse.json();

    let subjectsSet = new Set();
    if (workData.subjects) workData.subjects.forEach(s => subjectsSet.add(s));

    let placesSet = new Set();
    let publishersSet = new Set();
    let firstValidIsbn = null;
    let subtitle = '';
    
    if (editionsData.entries && editionsData.entries.length > 0) {
      editionsData.entries.forEach(ed => {
        if (ed.subjects) ed.subjects.forEach(s => subjectsSet.add(s));
        if (ed.publish_places) ed.publish_places.forEach(p => placesSet.add(p));
        if (ed.publishers) ed.publishers.forEach(p => publishersSet.add(p));
        if (ed.subtitle && !subtitle) subtitle = ed.subtitle;

        if (ed.isbn_13 && !firstValidIsbn) firstValidIsbn = ed.isbn_13[0];
        else if (ed.isbn_10 && !firstValidIsbn) firstValidIsbn = ed.isbn_10[0];
      });
    }

    let finalSubjects = subjectsSet.size > 0 ? Array.from(subjectsSet).slice(0, 5).join(', ') : 'No categoritzat';
    let finalPlaces = placesSet.size > 0 ? Array.from(placesSet).slice(0, 3).join(', ') : 'Desconegut';
    let finalPublishers = publishersSet.size > 0 ? Array.from(publishersSet).slice(0, 2).join(', ') : 'Desconeguda';
    
    if (finalSubjects !== 'No categoritzat') {
      try {
        const translateResponse = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(finalSubjects)}&langpair=en|ca`);
        const translateData = await translateResponse.json();
        if (translateData && translateData.responseData && translateData.responseData.translatedText) {
          finalSubjects = translateData.responseData.translatedText;
        }
      } catch (e) {}
    }
    
    let displayTitle = subtitle ? `${title}. ${subtitle}` : title;

    detailsContent.innerHTML = `
      <div style="display: flex; gap: 30px; margin-bottom: 20px; flex-wrap: wrap; text-align: left;">
        <img src="${coverUrl}" style="width: 180px; object-fit: contain; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" alt="Cover">
        
        <div style="flex: 1; min-width: 250px;">
          <h2 style="margin: 0 0 10px 0; font-size: 1.5rem; color: #2c3e50; line-height: 1.3;">${displayTitle}</h2>
          <span style="background: #3498db; color: white; padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; display: inline-block; margin-bottom: 20px;">Llibre (Open Library)</span>
          
          <div style="margin-top: 10px;">
            <h3 style="background: #f2f2f2; padding: 8px 12px; margin: 0 0 12px 0; font-size: 1rem; color: #444; font-weight: normal; border-radius: 4px;">Informació general</h3>
            
            <div style="font-size: 0.9rem; color: #666; line-height: 1.8; padding-left: 5px;">
              <div>Autor: <strong style="color: #27ae60;">${authors}</strong></div>
              <div>Editorial: <span>${finalPublishers}</span></div>
              <div>Any d'edició: <span>${publishYear}</span></div>
              <div>Lloc d'edició: <span>${finalPlaces}</span></div>
              <div>Categoria: <strong style="color: #27ae60;">${finalSubjects}</strong></div>
            </div>
            
            <button id="sync-desktop-btn" onclick="window.syncSelectedBook({ title: '${displayTitle.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', authors: '${authors.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', publisher: '${finalPublishers.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', publishYear: '${publishYear}', place: '${finalPlaces.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', subjects: '${finalSubjects.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', isbn: '${firstValidIsbn || ""}', source: 'Open Library', cover: '${coverUrl}' })" style="margin-top: 20px; width: 100%; padding: 12px; background: #27ae60; color: white; border: none; border-radius: 6px; font-weight: bold; font-size: 1rem; cursor: pointer; transition: background 0.2s;">
              📥 Desar a la base de dades Llibreviu
            </button>
          </div>
        </div>
      </div>
    `;
    // Auto-sync on selection
    window.syncSelectedBook({
      title: displayTitle,
      authors: authors,
      publisher: finalPublishers,
      publishYear: publishYear,
      place: finalPlaces,
      subjects: finalSubjects,
      isbn: firstValidIsbn || "",
      source: 'Open Library',
      cover: coverUrl
    }, true);
  } catch (err) {
    detailsContent.innerHTML = `<div style="text-align: center; color: #e74c3c; padding: 20px;">❌ Error de connexió amb els catàlegs: ${err.message}</div>`;
  }
};

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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

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
}

window.syncSelectedBook = async function(book, silent = false) {
  if (!silent) {
    document.getElementById('book-details-modal').style.display = 'none';
  }

  const baseUrl = getBaseUrl();

  // 1. Obtenim els temes de la sessió si estan disponibles des de l'ordinador per classificar abans de sincronitzar
  try {
    const stateRes = await fetch(`${baseUrl}/api/session-state?sid=${sessionID}&t=${Date.now()}`, { cache: 'no-store' });
    if (stateRes.ok) {
      const stateData = await stateRes.json();
      if (stateData && stateData.formData && stateData.formData._selectOptions && stateData.formData._selectOptions.id_tema) {
        const themeOptions = stateData.formData._selectOptions.id_tema;
        if (themeOptions.length > 0) {
          console.log("🤖 Classificant el tema amb Gemini des del Desktop...");
          const apiKey = localStorage.getItem('gemini-api-key') || '';
          try {
            const classification = await classifyThemeWithGemini(book, themeOptions, apiKey);
            if (classification && classification.value !== undefined) {
              book.id_tema = classification.value;
              console.log(`✅ Tema seleccionat per Gemini des del Desktop: "${classification.text}" (valor: ${classification.value})`);
            }
          } catch (geminiErr) {
            console.warn("⚠️ Error classificant el tema amb Gemini des del Desktop:", geminiErr);
          }
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ Error recuperant l'estat per obtenir els temes des del Desktop:", e);
  }

  if (!silent) {
    // Mostrar notificació
    const notif = document.getElementById('notification');
    notif.innerText = `✅ S'ha guardat a la base de dades de Llibreviu!`;
    notif.style.display = 'block';
    setTimeout(() => { notif.style.display = 'none'; }, 4000);
    
    // Mostrar formulari BD
    document.getElementById('results-card').style.display = 'none';
    document.getElementById('db-card').style.display = 'block';
    document.getElementById('db-json').innerText = JSON.stringify({
      action: "SAVE_TO_LLIBREVIU_DB",
      timestamp: new Date().toISOString(),
      data: {
        title: book.title,
        authors: book.authors || book.author,
        publisher: book.publisher,
        year: book.publishYear || book.year,
        isbn: book.isbn,
        place: book.place || 'Desconegut',
        subjects: book.subjects || 'No categoritzat',
        source: book.source,
        id_tema: book.id_tema || ''
      }
    }, null, 2);
  }

  const syncPayload = {
    type: 'sync_book',
    value: {
      title: book.title,
      authors: book.authors || book.author,
      publisher: book.publisher,
      year: book.publishYear || book.year,
      place: book.place || 'Desconegut',
      subjects: book.subjects || 'No categoritzat',
      isbn: book.isbn,
      cover: book.cover || '',
      source: book.source,
      id_tema: book.id_tema || ''
    }
  };

  // Informem al servidor local de la selecció
  fetch(`${baseUrl}/api/sync?sid=${sessionID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...syncPayload, sid: sessionID })
  }).then(() => {
    // Dispatch custom event to notify content.js to open/focus intranet tab
    window.dispatchEvent(new CustomEvent('llibreviu-state-change', {
      detail: { state: 'filling', book: { ...book, id_tema: book.id_tema } }
    }));
  }).catch(() => {});
};

window.resetState = function() {
  window.detectedThemeId = '';
  const qrContainer = document.getElementById('qr-container');
  const descText = document.getElementById('connection-instructions');
  const certHelp = document.getElementById('cert-help');
  const pollStatus = document.getElementById('poll-status');
  const floatStatusEl = document.getElementById('floating-qr-status');
  
  document.getElementById('connection-card').style.display = 'block';
  document.getElementById('search-card').style.display = 'none';
  document.getElementById('results-card').style.display = 'none';
  document.getElementById('db-card').style.display = 'none';
  document.getElementById('preview-container').style.display = 'none';
  document.getElementById('status').innerText = '';
  
  const rawOcr = document.getElementById('raw-ocr');
  if (rawOcr) rawOcr.innerText = '';
  const cleanOcr = document.getElementById('clean-ocr');
  if (cleanOcr) cleanOcr.innerText = '';
  
  // Amaguem els controls de rotació i netegem el canvas de portada
  const rotateControls = document.getElementById('rotate-controls');
  if (rotateControls) rotateControls.style.display = 'none';
  currentCoverCanvas = null;
  window.currentCoverCanvas = null;
  
  if (isMobileConnected) {
    if (qrContainer) qrContainer.style.display = 'none';
    if (certHelp) certHelp.style.display = 'none';
    if (descText) descText.innerText = "L'escàner està actiu al teu mòbil. Enfoca un codi de barres, el text de l'ISBN o la portada d'un llibre.";
    if (pollStatus) pollStatus.innerHTML = '<span style="color: #27ae60; font-size: 1.15rem; font-weight: bold;">🟢 Mòbil connectat i actiu</span>';
    if (floatStatusEl) floatStatusEl.innerHTML = '<span style="color: #27ae60; font-weight: bold;">🟢 Mòbil actiu</span>';
  } else {
    if (qrContainer) qrContainer.style.display = 'block';
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.');
    if (certHelp) certHelp.style.display = isLocal ? 'block' : 'none';
    if (descText) descText.innerText = "Escaneja aquest codi QR per obrir l'escàner al teu mòbil.";
    if (pollStatus) pollStatus.innerText = 'Esperant connexió...';
    if (floatStatusEl) floatStatusEl.innerText = 'Esperant connexió...';
  }
};
