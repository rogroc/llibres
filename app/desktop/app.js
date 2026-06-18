let isPolling = true;
const sessionID = Math.random().toString(36).substring(2, 10);
let eventSource = null;
let isMobileConnected = false;

let allScoredBooks = [];
let lastSearchStrategy = 'AND';
let lastUsedBNE = false;

// Deduplicació: evita processar el mateix scan dues vegades (poll local + ntfy)
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

    if (connectionMode === 'local' && isLocal) {
      if (tabLocal) {
        tabLocal.style.border = '2px solid #3498db';
        tabLocal.style.background = '#3498db';
        tabLocal.style.color = 'white';
      }
      if (tabPublic) {
        tabPublic.style.border = '2px solid #bdc3c7';
        tabPublic.style.background = '#f8f9f9';
        tabPublic.style.color = '#7f8c8d';
      }
      
      // Carreguem l'app del mòbil des de GitHub Pages per evitar el bloqueig inicial de certificat SSL auto-signat al telèfon
      const localUrl = `https://rogroc.github.io/llibres/app/mobile/?api=https://${localIp}:8443&sid=${sessionID}`;
      renderQrCode(localUrl);
      if (instructions) instructions.innerText = 'Escaneja aquest codi QR per obrir l\'escàner local directe. Requereix que el mòbil estigui connectat al mateix Wi-Fi i que el tallafocs de l\'ordinador no bloquegi els ports (8080/8443).';
      if (certHelp) certHelp.style.display = 'block';
      if (cameraRelayPanel) cameraRelayPanel.style.display = 'block';
    } else {
      if (tabLocal) {
        tabLocal.style.border = '2px solid #bdc3c7';
        tabLocal.style.background = '#f8f9f9';
        tabLocal.style.color = '#7f8c8d';
      }
      if (tabPublic) {
        tabPublic.style.border = '2px solid #27ae60';
        tabPublic.style.background = '#27ae60';
        tabPublic.style.color = 'white';
      }
      
      const defaultUrl = 'https://rogroc.github.io/llibres/app/mobile/';
      renderQrCode(`${defaultUrl}?sid=${sessionID}`);
      if (instructions) instructions.innerText = 'Escaneja aquest codi QR per obrir l\'escàner de canal públic. No transmetrà imatges de càmera en directe, però farà el processament a la càmera del mòbil i sincronitzarà els resultats en segon pla (supera tallafocs o aïllament de xarxa).';
      if (certHelp) certHelp.style.display = 'none';
      if (cameraRelayPanel) cameraRelayPanel.style.display = 'none';
    }
  };

  // Inicialitzem QR i controls segons el mode
  if (isLocal) {
    updateConnectionQr();
    
    const tabLocal = document.getElementById('tab-local');
    const tabPublic = document.getElementById('tab-public');
    if (tabLocal) {
      tabLocal.addEventListener('click', () => {
        connectionMode = 'local';
        updateConnectionQr();
      });
    }
    if (tabPublic) {
      tabPublic.addEventListener('click', () => {
        connectionMode = 'public';
        updateConnectionQr();
      });
    }

    // Comença a fer polling de scans i de càmera relay
    pollServer();
    initCameraRelay();
  } else {
    const tabsContainer = document.getElementById('connection-tabs');
    if (tabsContainer) tabsContainer.style.display = 'none';
    connectionMode = 'public';
    updateConnectionQr();
  }
  
  // La subscripció a ntfy.sh la fem sempre com a canal universal de seguretat
  setupNtfy();
  initBookmarklet();
  initFileDropZone();



  // Escoltador per tancar el modal de detalls
  document.getElementById('close-details')?.addEventListener('click', () => {
    document.getElementById('book-details-modal').style.display = 'none';
  });
});

function initBookmarklet() {
  const bookmarkletLink = document.getElementById('bookmarklet-link');
  if (bookmarkletLink) {
    const bookmarkletCode = `javascript:(async () => {
      console.log("Iniciant sincronització BiblioScan estàtica...");
      let active = true;
      const statusDiv = document.createElement('div');
      statusDiv.style.position = 'fixed';
      statusDiv.style.top = '10px';
      statusDiv.style.right = '10px';
      statusDiv.style.background = '#2ecc71';
      statusDiv.style.color = 'white';
      statusDiv.style.padding = '10px 15px';
      statusDiv.style.borderRadius = '5px';
      statusDiv.style.zIndex = '999999';
      statusDiv.style.fontFamily = 'sans-serif';
      statusDiv.style.fontSize = '12px';
      statusDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
      statusDiv.innerHTML = '🔄 Escoltant canal BiblioScan local... <button id="stop-sync-btn" style="background:none;border:none;color:white;font-weight:bold;cursor:pointer;margin-left:10px;">[X]</button>';
      document.body.appendChild(statusDiv);
      
      const pollInterval = setInterval(async () => {
        if (!active) { clearInterval(pollInterval); return; }
        try {
          const targetUrl = window.location.protocol === 'https:'
            ? 'https://localhost:8443/api/sync-poll'
            : 'http://localhost:8080/api/sync-poll';
          const response = await fetch(targetUrl);
          if (response.ok) {
            const data = await response.json();
            if (data && data.type === 'sync_book' && data.value) {
              statusDiv.style.background = '#3498db';
              statusDiv.innerHTML = '📥 Rebut: ' + data.value.title + '...';
              
              /* Injeccio directa especifica pels camps de la intranet llibreviu */
              const isbnInput = document.getElementById('inputCodigo');
              if (isbnInput && data.value.isbn) {
                isbnInput.value = data.value.isbn;
                isbnInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const titolInput = document.getElementById('titol');
              if (titolInput && data.value.title) {
                titolInput.value = data.value.title;
                titolInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const autorInput = document.getElementById('autor');
              if (autorInput && data.value.authors) {
                autorInput.value = data.value.authors;
                autorInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const editorialInput = document.getElementById('editorial');
              if (editorialInput && data.value.publisher) {
                editorialInput.value = data.value.publisher;
                editorialInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const llocInput = document.querySelector('input[name="lloc_edicio"]');
              if (llocInput && data.value.place) {
                llocInput.value = data.value.place;
                llocInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const anyInput = document.getElementById('anyEdicio');
              if (anyInput && data.value.year) {
                anyInput.value = data.value.year;
                anyInput.dispatchEvent(new Event('input', { bubbles: true }));
              }
              const obsTextarea = document.querySelector('textarea[name="observacions"]');
              if (obsTextarea) {
                let obsVal = '';
                if (data.value.subjects && data.value.subjects !== 'No categoritzat') {
                  obsVal += 'Temes: ' + data.value.subjects + '\\\\n';
                }
                obsVal += data.value.source ? 'Sincronitzat des de: ' + data.value.source : 'Sincronitzat des del catàleg';
                obsTextarea.value = obsVal;
                obsTextarea.dispatchEvent(new Event('input', { bubbles: true }));
              }
              if (data.value.cover) {
                const imgAntigua = document.getElementById('imgAntigua');
                if (imgAntigua) {
                  imgAntigua.src = data.value.cover;
                  const filaImg = document.getElementById('filaImg');
                  if (filaImg) {
                    filaImg.classList.remove('esconderImg');
                  }
                }
                try {
                  const imgRes = await fetch(data.value.cover);
                  const blob = await imgRes.blob();
                  const file = new File([blob], 'portada.jpg', { type: blob.type || 'image/jpeg' });
                  const dataTransfer = new DataTransfer();
                  dataTransfer.items.add(file);
                  const fileInput = document.querySelector('input[type="file"][name="pic"]');
                  if (fileInput) {
                    fileInput.files = dataTransfer.files;
                    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                    const previewDiv = fileInput.parentElement.previousElementSibling;
                    if (previewDiv) {
                      const mainPreviewImg = previewDiv.querySelector('img');
                      if (mainPreviewImg) {
                        mainPreviewImg.src = URL.createObjectURL(blob);
                      }
                    }
                  }
                } catch (corsErr) {
                  console.warn('CORS/Fetch error loading cover image:', corsErr);
                }
              }

              /* Mostrar notificacio visual a la intranet */
              const showToast = (msgText) => {
                let notifEl = document.getElementById('sync-bookmarklet-notification');
                if (!notifEl) {
                  notifEl = document.createElement('div');
                  notifEl.id = 'sync-bookmarklet-notification';
                  notifEl.style.position = 'fixed';
                  notifEl.style.bottom = '20px';
                  notifEl.style.right = '20px';
                  notifEl.style.background = '#27ae60';
                  notifEl.style.color = 'white';
                  notifEl.style.padding = '12px 20px';
                  notifEl.style.borderRadius = '8px';
                  notifEl.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
                  notifEl.style.fontFamily = 'sans-serif';
                  notifEl.style.fontWeight = 'bold';
                  notifEl.style.fontSize = '12px';
                  notifEl.style.zIndex = '999999';
                  notifEl.style.transition = 'opacity 0.3s ease';
                  document.body.appendChild(notifEl);
                }
                notifEl.innerText = msgText;
                notifEl.style.opacity = '1';
                notifEl.style.display = 'block';
                setTimeout(() => {
                  notifEl.style.opacity = '0';
                  setTimeout(() => { notifEl.style.display = 'none'; }, 300);
                }, 4000);
              };
              showToast('Llibre "' + data.value.title.replace(/"/g, '\\\\"') + '" injectat correctament!');

              setTimeout(() => {
                statusDiv.style.background = '#2ecc71';
                statusDiv.innerHTML = '🔄 Escoltant canal BiblioScan local... <button id="stop-sync-btn" style="background:none;border:none;color:white;font-weight:bold;cursor:pointer;margin-left:10px;">[X]</button>';
                const stopBtn = document.getElementById('stop-sync-btn');
                if (stopBtn) {
                  stopBtn.onclick = () => {
                    active = false;
                    clearInterval(pollInterval);
                    statusDiv.remove();
                  };
                }
              }, 3000);
            }
          }
        } catch (e) {
          /* fail silently to reduce console noise */
        }
      }, 1500);

      document.getElementById('stop-sync-btn').onclick = () => {
        active = false;
        clearInterval(pollInterval);
        statusDiv.remove();
        alert("Sincronització aturada.");
      };
    })();`;
    bookmarkletLink.href = bookmarkletCode.replace(/\s+/g, ' ');
  }
}

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

function setupNtfy() {
  if (eventSource) return;
  eventSource = new EventSource(`https://ntfy.sh/llibreviu-sync-${sessionID}/sse`);
  
  eventSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg && msg.message) {
        const data = JSON.parse(msg.message);
        if (data && data.type) {
          handleScan(data);
        }
      }
    } catch (e) {
      // Ignorar errors de parseig de missatges de control no-json
    }
  };
  
  eventSource.onerror = (e) => {
    console.warn("Connexió SSE de ntfy.sh perduda, intentant reconnectar...", e);
  };
}

function renderQrCode(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  document.getElementById('qr-container').innerHTML = qr.createImgTag(5);
  const qrUrlEl = document.getElementById('qr-url');
  if (qrUrlEl) {
    qrUrlEl.innerText = url;
  }
}

async function pollServer() {
  if (!isPolling) return;
  try {
    const res = await fetch(`${getBaseUrl()}/api/poll?t=${Date.now()}`, { cache: 'no-store' });
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

  // Deduplicació: ignorem si és el mateix scan rebut en menys de 10 segons (poll + ntfy dupliquen)
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
    searchByIsbn(data.value).finally(() => { isSearchInProgress = false; });
  } else if (data.type === 'portada') {
    isSearchInProgress = true;
    queryEl.innerText = `Text Portada: "${data.value.substring(0, 50)}..."`;
    statusEl.innerText = `Cercant per text als catàlegs...`;
    searchCatalogsWithText(data.value, true);
    // searchCatalogsWithText no és async-awaitable aquí, però el flag es reseteja en 30s
    setTimeout(() => { isSearchInProgress = false; }, 30000);
  } else if (data.type === 'portada-captured') {
    isSearchInProgress = true;
    queryEl.innerText = `Processant Portada des del mòbil...`;
    statusEl.innerText = `Rebuda captura del mòbil. Descarregant i analitzant...`;
    (async () => {
      try {
        const response = await fetch(`${getBaseUrl()}/api/camera-frame?t=${Date.now()}`);
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
      relayOpenMobile.href = `https://${localIp}:8443${path}../mobile/?api=https://${localIp}:8443&sid=${sessionID}`;
    }).catch(() => {
      relayOpenMobile.href = `https://localhost:8443${path}../mobile/?api=https://localhost:8443&sid=${sessionID}`;
    });
  }

  async function pollFrame() {
    try {
      const res = await fetch(`${getBaseUrl()}/api/camera-frame?t=${Date.now()}`, { cache: 'no-store' });
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
      const res = await fetch(`${getBaseUrl()}/api/camera-status`);
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

    await runOcrOnCanvas(srcCanvas, searchStatusEl, queryEl, overlayCanvas, preview);

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
async function runOcrOnCanvas(srcCanvas, searchStatusEl, queryEl, overlayCanvas, preview) {
  try {
    // Detecció de polígons de text amb PaddleOCR sobre el canvas actual
    const ocr = await getOcrInstance();
    searchStatusEl.innerText = '🔍 Detectant àrees de text amb PaddleOCR...';
    let detectedPolys = await detectPolysOnCanvas(srcCanvas, ocr);
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

    for (let polyIdx = 0; polyIdx < detectedPolys.length; polyIdx++) {
      const poly = detectedPolys[polyIdx];
      if (!poly || poly.length < 4) continue;

      const pt0 = poly[0];
      const pt1 = poly[1];
      const pt2 = poly[2];
      const pt3 = poly[3];

      const w = Math.sqrt(Math.pow(pt1[0] - pt0[0], 2) + Math.pow(pt1[1] - pt0[1], 2));
      const h = Math.sqrt(Math.pow(pt3[0] - pt0[0], 2) + Math.pow(pt3[1] - pt0[1], 2));
      if (w < 10 || h < 10) continue;

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

      // 2. Mapagem a escala de grisos i invertim si cal, mantenint la suavitat i els marges blancs
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const j = (y * bw + x) * 4;
          if (x < PAD || x >= bw - PAD || y < PAD || y >= bh - PAD) {
            // Tot el que sigui marge artificial ho mantenim en blanc pur
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

      // Passem a reconeixement de text
      try {
        const [resCat, resSpa] = await Promise.all([
          tesseractWorkerCat.recognize(boxCanvas),
          tesseractWorkerSpa.recognize(boxCanvas)
        ]);

        const catConf = resCat.data.confidence;
        const spaConf = resSpa.data.confidence;
        const bestRes = catConf >= spaConf ? resCat : resSpa;

        const tesseractWords = bestRes.data.words || [];
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const lineWords = [];

        tesseractWords.forEach(w => {
          if (w.confidence > 30 && w.text.trim().length > 0) {
            // Rotem de tornada les cantonades de la paraula al pla original del llibre
            const rotatePoint = (lx, ly) => {
              const rx = lx * cosA - ly * sinA;
              const ry = lx * sinA + ly * cosA;
              return [rx + pt0[0], ry + pt0[1]];
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
              source: `box_${polyIdx}_tesseract`
            };

            wordsNormal.push(wordObj);
            lineWords.push(wordObj);
          }
        });

        if (lineWords.length > 0) {
          const cx = (pt0[0] + pt1[0] + pt2[0] + pt3[0]) / 4;
          const cy = (pt0[1] + pt1[1] + pt2[1] + pt3[1]) / 4;
          lines.push({
            cx: cx,
            cy: cy,
            angle: angle,
            poly: poly,
            words: lineWords
          });
        }
      } catch (err) {
        console.error(`Error de Tesseract en la caixa index ${polyIdx}:`, err);
      }
    }

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
    await searchCatalogsWithText(text, false, mergedWords);

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
  
  // 1. NORMALITZACIÓ D'ARTEFACTES D'OCR
  let normalizedText = text.replace(/ufia/gi, 'uña')
                           .replace(/fio/gi, 'ño')
                           .replace(/fia/gi, 'ña')
                           .replace(/iriba/gi, 'i riba')
                           .replace(/\brba\b/gi, 'riba')
                           .replace(/ll['’]?imperí?/gi, "i l'imperi")
                           .replace(/il['’]?imperí?/gi, "i l'imperi")
                           .replace(/l['’]?imperí?/gi, "l'imperi");

  // Mostrar debugs bruts
  const rawOcrEl = document.getElementById('raw-ocr');
  if (rawOcrEl) {
    if (mergedWords) {
      rawOcrEl.innerHTML = `<strong>Text normalitzat:</strong> ${normalizedText}\n\n` +
                           `<strong>Paraules detectades:</strong>\n` +
                           mergedWords.map(w => `- "${w.text}" (${w.confidence}%, y: ${w.bbox.y0}px)`).join('\n');
    } else {
      rawOcrEl.innerText = normalizedText;
    }
  }

  statusEl.innerText = '🧹 Netejant i cercant paraules clau...';
  
  const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
  const cleanText = normalizedText.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
  const ocrWordsList = cleanText.split(/\s+/);
  const keywords = ocrWordsList.filter(w => !stopwords.has(w) && w.length > 2);

  const cleanOcrEl = document.getElementById('clean-ocr');
  if (cleanOcrEl) {
    cleanOcrEl.innerText = keywords.join(', ');
  }
  
  if (keywords.length === 0) {
    statusEl.innerText = '❌ El text llegit era massa curt o invàlid.';
    return;
  }

  const apiKeywords = keywords.slice(0, 8);
  statusEl.innerText = '🌐 Cercant a Open Library (Cerca estricta AND)...';
  let andQuery = apiKeywords.join('+');
  let url = `https://openlibrary.org/search.json?q=${andQuery}&fields=key,title,author_name,first_publish_year,cover_i,publisher&limit=30`;
  
  try {
    let response = await fetch(url);
    let data = await response.json();
    let searchStrategy = 'AND (Totes les paraules principals)';

    if (data.numFound === 0 || data.docs.length === 0) {
      statusEl.innerText = '🌐 Cap resultat exacte. Cercant amb Cerca laxada OR...';
      searchStrategy = 'OR (Major nombre de coincidències)';
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
        book.matchScore = calculateOverlapScore(book, normalizedText);
        return book;
      });
    }

    lastSearchStrategy = searchStrategy;
    lastUsedBNE = false;

    // Calcular overlap score inicial
    const maxOLScore = allScoredBooks.length > 0 ? Math.max(...allScoredBooks.map(b => b.matchScore)) : 0;

    // Fallback a la BNE si no tenim una coincidència gairebé perfecta (>= 99%)
    const isStaticGitHubPages = window.location.hostname.endsWith('github.io');
    if (maxOLScore < 0.99 && !isStaticGitHubPages) {
      statusEl.innerText = '🌐 Coincidència Open Library parcial. Consultant la BNE...';
      try {
        const bneQuery = apiKeywords.join(' OR ');
        const bneUrl = getBneApiUrl(bneQuery);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 segons d'espera per a la BNE (sovint és lenta)

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
            book.matchScore = calculateOverlapScore(book, normalizedText);
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
    }
    
  } catch (err) {
    console.error(err);
    statusEl.innerText = 'Error en la cerca: ' + err.message;
    fetch(`${getBaseUrl()}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'log', value: '[Desktop Error] ' + err.stack })
    }).catch(() => {});
  }
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
  const ocrWords = new Set(ocrTextRaw.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '').split(/\s+/));
  
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
  let topBooks = filtered.slice(0, 5);

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

window.syncSelectedBook = function(book, silent = false) {
  if (!silent) {
    document.getElementById('book-details-modal').style.display = 'none';

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
        authors: book.authors,
        publisher: book.publisher,
        year: book.publishYear || book.year,
        isbn: book.isbn,
        place: book.place,
        subjects: book.subjects,
        source: book.source
      }
    }, null, 2);
  }

  const syncPayload = {
    type: 'sync_book',
    value: {
      title: book.title,
      authors: book.authors,
      publisher: book.publisher,
      year: book.publishYear || book.year,
      place: book.place,
      subjects: book.subjects,
      isbn: book.isbn,
      cover: book.cover || '',
      source: book.source
    }
  };

  // Per si hi ha la intranet local escoltant sync-poll
  fetch(`${getBaseUrl()}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(syncPayload)
  }).catch(() => {});

  // Per al bookmarklet connectat via ntfy.sh (evita problemes de CORS/Mixed-Content)
  fetch(`https://ntfy.sh/llibreviu-sync-${sessionID}`, {
    method: 'POST',
    body: JSON.stringify(syncPayload)
  }).catch(() => {});
};

window.resetState = function() {
  const qrContainer = document.getElementById('qr-container');
  const descText = document.getElementById('connection-instructions');
  const certHelp = document.getElementById('cert-help');
  const pollStatus = document.getElementById('poll-status');
  
  document.getElementById('connection-card').style.display = 'block';
  document.getElementById('search-card').style.display = 'none';
  document.getElementById('results-card').style.display = 'none';
  document.getElementById('db-card').style.display = 'none';
  document.getElementById('preview-container').style.display = 'none';
  document.getElementById('status').innerText = '';
  
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
  } else {
    if (qrContainer) qrContainer.style.display = 'block';
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.');
    if (certHelp) certHelp.style.display = isLocal ? 'block' : 'none';
    if (descText) descText.innerText = "Escaneja aquest codi QR per obrir l'escàner al teu mòbil.";
    if (pollStatus) pollStatus.innerText = 'Esperant connexió...';
  }
};
