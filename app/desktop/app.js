let isPolling = true;
const sessionID = Math.random().toString(36).substring(2, 10);
let eventSource = null;

document.addEventListener('DOMContentLoaded', () => {
  const defaultUrl = 'https://rogroc.github.io/llibres/app/mobile/';
  
  // 1. Genera el QR per defecte immediatament perquè la pàgina no quedi bloquejada
  renderQrCode(`${defaultUrl}?sid=${sessionID}`);
  
  // 2. Comença a fer polling i subscriu-te al relay de ntfy.sh immediatament
  pollServer();
  setupNtfy();
  
  // 3. Consulta la IP local de forma asíncrona per afegir el paràmetre de l'API local
  fetch('/api/ip?t=' + Date.now())
    .then(res => {
      if (res.ok) return res.json();
    })
    .then(data => {
      if (data && data.ip) {
        // En ambdós casos, usem l'app de GitHub Pages (té certificat vàlid) i passem els paràmetres sid i api
        const mobileUrl = `${defaultUrl}?sid=${sessionID}&api=https://${data.ip}:8443`;
        renderQrCode(mobileUrl);
      }
    })
    .catch(e => {
      console.warn("No s'ha pogut obtenir la IP local per al QR:", e);
    });
});

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
    const res = await fetch(`/api/poll?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.type) {
        handleScan(data);
      }
    }
  } catch (e) {
    // console.warn("Poll error", e);
  }
  setTimeout(pollServer, 1000);
}

function handleScan(data) {
  if (data.type === 'connection') {
    const qrContainer = document.getElementById('qr-container');
    if (qrContainer) qrContainer.style.display = 'none';
    
    const descText = document.getElementById('connection-card').querySelector('p');
    if (descText) descText.innerText = "L'escàner està actiu al teu mòbil. Enfoca un codi de barres o la portada d'un llibre.";
    
    document.getElementById('poll-status').innerHTML = '<span style="color: #27ae60; font-size: 1.15rem; font-weight: bold;">🟢 Mòbil connectat i actiu</span>';
    return;
  }

  document.getElementById('connection-card').style.display = 'none';
  document.getElementById('search-card').style.display = 'block';
  document.getElementById('results-card').style.display = 'none';
  document.getElementById('db-card').style.display = 'none';
  
  const queryEl = document.getElementById('search-query');
  const statusEl = document.getElementById('search-status');
  
  if (data.type === 'isbn') {
    queryEl.innerText = `ISBN: ${data.value}`;
    statusEl.innerText = `Cercant ISBN als catàlegs...`;
    searchByIsbn(data.value);
  } else if (data.type === 'portada') {
    queryEl.innerText = `Text Portada: "${data.value.substring(0, 50)}..."`;
    statusEl.innerText = `Cercant per text als catàlegs...`;
    searchByText(data.value);
  }
}

// ==========================================
// CATALOG SEARCH LOGIC
// ==========================================

async function searchByIsbn(isbn) {
  const cleanIsbn = isbn.replace(/[^0-9X]/gi, '');
  const googleApiUrl = `https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanIsbn}`;
  const openLibraryUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`;
  
  try {
    const [googleRes, olRes] = await Promise.allSettled([
      fetch(googleApiUrl).then(r => r.ok ? r.json() : null),
      fetch(openLibraryUrl).then(r => r.ok ? r.json() : null)
    ]);
    
    let googleData = googleRes.status === 'fulfilled' ? googleRes.value : null;
    let olData = olRes.status === 'fulfilled' ? olRes.value : null;
    
    let booksFound = [];
    
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
    
    if (olData) {
      const key = `ISBN:${cleanIsbn}`;
      const info = olData[key];
      if (info) {
        booksFound.push({
          source: 'Open Library',
          title: info.title || 'Sense títol',
          authors: info.authors ? info.authors.map(a => a.name).join(', ') : 'Autor desconegut',
          publisher: info.publishers ? info.publishers.map(p => p.name).join(', ') : 'Editorial desconeguda',
          year: info.publish_date || '',
          isbn: cleanIsbn,
          cover: info.cover ? (info.cover.medium || info.cover.small || '') : ''
        });
      }
    }
    
    if (booksFound.length === 0) {
      document.getElementById('search-status').innerText = 'No s\'ha trobat cap llibre amb aquest ISBN.';
    } else {
      document.getElementById('search-card').style.display = 'none';
      renderResults(booksFound);
    }
    
  } catch (err) {
    document.getElementById('search-status').innerText = 'Error en la cerca: ' + err.message;
  }
}

async function searchByText(text) {
  // Simplified text search logic
  const cleanText = text.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, '');
  const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
  const keywords = cleanText.split(/\s+/).filter(w => !stopwords.has(w) && w.length > 2).slice(0, 6);
  
  if (keywords.length === 0) {
    document.getElementById('search-status').innerText = 'El text llegit és massa curt o invàlid.';
    return;
  }
  
  const query = keywords.join('+');
  const url = `https://openlibrary.org/search.json?q=${query}&limit=10`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.numFound === 0 || data.docs.length === 0) {
      document.getElementById('search-status').innerText = 'No s\'ha trobat cap llibre amb aquest text.';
      return;
    }
    
    let booksFound = data.docs.map(doc => ({
      source: 'Open Library (Text)',
      title: doc.title || 'Sense títol',
      authors: doc.author_name ? doc.author_name.join(', ') : 'Autor desconegut',
      publisher: doc.publisher ? doc.publisher[0] : 'Editorial desconeguda',
      year: doc.first_publish_year || '',
      isbn: doc.isbn ? doc.isbn[0] : '',
      cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : ''
    }));
    
    document.getElementById('search-card').style.display = 'none';
    renderResults(booksFound);
    
  } catch (err) {
    document.getElementById('search-status').innerText = 'Error en la cerca per text: ' + err.message;
  }
}

function renderResults(books) {
  const container = document.getElementById('results');
  container.innerHTML = '';
  document.getElementById('results-card').style.display = 'block';
  
  books.forEach((book, idx) => {
    const item = document.createElement('div');
    item.className = 'book-item';
    
    const coverImg = book.cover ? `<img src="${book.cover}" alt="Portada">` : `<div style="width:60px;height:90px;background:#eee;display:flex;align-items:center;justify-content:center;font-size:10px;text-align:center;border-radius:4px;">Sense imatge</div>`;
    
    item.innerHTML = `
      ${coverImg}
      <div class="book-info">
        <h4>${book.title}</h4>
        <p><strong>Autor:</strong> ${book.authors}</p>
        <p><strong>Editorial:</strong> ${book.publisher} (${book.year})</p>
        <p><span class="badge">${book.source}</span> ISBN: ${book.isbn || 'N/A'}</p>
      </div>
      <button class="btn-select" onclick="selectBook(${idx})">Seleccionar</button>
    `;
    
    // Store book data safely
    item.dataset.bookStr = JSON.stringify(book);
    container.appendChild(item);
  });
}

function selectBook(index) {
  const item = document.querySelectorAll('.book-item')[index];
  const book = JSON.parse(item.dataset.bookStr);
  
  // Show Notification
  const notif = document.getElementById('notification');
  notif.innerText = `✅ S'ha enviat a la base de dades de Llibreviu!`;
  notif.style.display = 'block';
  setTimeout(() => { notif.style.display = 'none'; }, 4000);
  
  // Show Mock DB
  document.getElementById('results-card').style.display = 'none';
  document.getElementById('db-card').style.display = 'block';
  document.getElementById('db-json').innerText = JSON.stringify({
    action: "SAVE_TO_LLIBREVIU_DB",
    timestamp: new Date().toISOString(),
    data: book
  }, null, 2);
}

window.resetState = function() {
  const qrContainer = document.getElementById('qr-container');
  if (qrContainer) qrContainer.style.display = 'block';
  
  const descText = document.getElementById('connection-card').querySelector('p');
  if (descText) descText.innerText = "Escaneja aquest codi QR per obrir l'escàner al teu mòbil.";
  
  document.getElementById('connection-card').style.display = 'block';
  document.getElementById('search-card').style.display = 'none';
  document.getElementById('results-card').style.display = 'none';
  document.getElementById('db-card').style.display = 'none';
  document.getElementById('poll-status').innerText = 'Esperant nova connexió / escaneig...';
};
