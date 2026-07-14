// ==========================================================================
// BACKGROUND.JS — Cervell de Llibreviu Sync Connector
// Fa: OCR Gemini, cerca catàlegs, gestió clau API via chrome.storage
// ==========================================================================

let lastStates = {};
let lastVersions = {};
let lastIntranetOpenTimes = {};
let processingSearchSids = new Set(); // Evita processar el mateix sid dues vegades

// --------------------------------------------------------------------------
// GESTIÓ DE PESTANYES
// --------------------------------------------------------------------------

function openIntranetTab(sid, shouldFocus = false, callback) {
    if (!sid) sid = 'default';
    const targetUrl = `https://www.llibreviu.org/admin/registre/?sid=${sid}`;
    chrome.tabs.query({}, (allTabs) => {
        const intranetTab = allTabs.find(tab => {
            if (!tab.url) return false;
            const urlStr = tab.url.toLowerCase();
            return (urlStr.includes('llibreviu.org/admin/registre') || urlStr.includes('llibreviu.org/admin/registres')) && urlStr.includes('sid=' + sid.toLowerCase());
        });
        if (intranetTab) {
            if (shouldFocus) {
                chrome.tabs.update(intranetTab.id, { active: true });
                chrome.windows.update(intranetTab.windowId, { drawAttention: true, focused: true });
            }
            if (callback) callback({ success: true, opened: false });
        } else {
            const genericTab = allTabs.find(tab => {
                if (!tab.url) return false;
                const urlStr = tab.url.toLowerCase();
                return (urlStr.includes('llibreviu.org/admin/registre') || urlStr.includes('llibreviu.org/admin/registres')) && !urlStr.includes('sid=');
            });
            if (genericTab) {
                chrome.tabs.update(genericTab.id, { url: targetUrl, active: shouldFocus }, () => {
                    if (shouldFocus) chrome.windows.update(genericTab.windowId, { drawAttention: true, focused: true });
                    if (callback) callback({ success: true, opened: false });
                });
            } else {
                const now = Date.now();
                const lastOpen = lastIntranetOpenTimes[sid] || 0;
                if (now - lastOpen < 4000) {
                    if (callback) callback({ success: false, error: 'Debounced' });
                    return;
                }
                lastIntranetOpenTimes[sid] = now;
                chrome.tabs.create({ url: targetUrl, active: shouldFocus }, () => {
                    if (callback) callback({ success: true, opened: true });
                });
            }
        }
    });
}

function closeIntranetTab(sid) {
    if (!sid) sid = 'default';
    chrome.tabs.query({}, (allTabs) => {
        const intranetTab = allTabs.find(tab => {
            if (!tab.url) return false;
            const urlStr = tab.url.toLowerCase();
            return (urlStr.includes('llibreviu.org/admin/registre') || urlStr.includes('llibreviu.org/admin/registres')) && urlStr.includes('sid=' + sid.toLowerCase());
        });
        if (intranetTab) {
            chrome.tabs.sendMessage(intranetTab.id, { action: 'clear_session_sid' }, () => {
                chrome.runtime.lastError;
                chrome.tabs.update(intranetTab.id, { url: 'https://www.llibreviu.org/admin/registre/' });
            });
        }
    });
}

function notifyIntranetTab(sid, stateData) {
    if (!sid) sid = 'default';
    chrome.tabs.query({}, (allTabs) => {
        const intranetTab = allTabs.find(tab => {
            if (!tab.url) return false;
            const urlStr = tab.url.toLowerCase();
            return (urlStr.includes('llibreviu.org/admin/registre') || urlStr.includes('llibreviu.org/admin/registres')) && urlStr.includes('sid=' + sid.toLowerCase());
        });
        if (intranetTab) {
            chrome.tabs.sendMessage(intranetTab.id, { action: 'state_update', data: stateData }, () => {
                chrome.runtime.lastError;
            });
        }
    });
}

// --------------------------------------------------------------------------
// OCR AMB GEMINI (des del background, sense restriccions CORS)
// --------------------------------------------------------------------------

async function callGeminiOcr(apiKey, base64Image, themeOptions) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

    let prompt = (
        'Analitza la portada d\'aquest llibre. Extrau i classifica el text en un objecte JSON amb les següents claus obligatòries:\n' +
        '- "titol" (el títol del llibre)\n' +
        '- "autor" (el nom o noms dels autors, si n\'hi ha)\n' +
        '- "editorial" (la marca editorial o segell, si n\'hi ha)\n'
    );

    if (Array.isArray(themeOptions) && themeOptions.length > 0) {
        const listStr = themeOptions
            .filter(opt => typeof opt === 'object')
            .map(opt => `- "${opt.text}" (valor: "${opt.value}")`)
            .join('\n');
        prompt += (
            '- "id_tema" (el valor del tema seleccionat de la llista següent)\n\n' +
            'Llista de temes de Llibreviu:\n' + listStr + '\n\n' +
            'Classifica el tema del llibre seleccionant el valor del tema més adient de la llista anterior. ' +
            'CRÍTIC: Has d\'analitzar de forma holística el títol del llibre i el nom de l\'autor. ' +
            'Dedueix el camp de coneixement o la professió de l\'autor i la temàtica real del títol.\n\n'
        );
    } else {
        prompt += '- "id_tema" (sempre una cadena buida "")\n\n';
    }
    prompt += 'Si no es detecta o no s\'està segur d\'algun dels camps, deixa el seu valor com a cadena buida "". Retorna únicament l\'objecte JSON pur, sense blocs de codi markdown ni cap altre text explicatiu.';

    const payload = {
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: base64Image } }] }],
        generationConfig: { responseMimeType: 'application/json' }
    };

    const resp = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Gemini HTTP ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const result = await resp.json();
    const textResponse = result.candidates[0].content.parts[0].text.trim();
    console.log(`[BG OCR] Resposta Gemini: ${textResponse.substring(0, 100)}`);

    // Parse robust del JSON
    let textClean = textResponse.trim();
    if (textClean.includes('```')) {
        const match = textClean.match(/```(?:json)?\s*(\{.*?\})\s*```/s);
        if (match) textClean = match[1].trim();
    }
    if (!(textClean.startsWith('{') && textClean.endsWith('}'))) {
        const start = textClean.indexOf('{');
        const end = textClean.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) textClean = textClean.slice(start, end + 1);
    }

    const parsed = JSON.parse(textClean);
    const titol = (parsed.titol || parsed.títol || parsed.title || parsed.Titol || parsed.Títol || parsed.Title || '').toString().trim();
    const autor = (parsed.autor || parsed.author || parsed.Autor || parsed.Author || '').toString().trim();
    const editorial = (parsed.editorial || parsed.publisher || parsed.Editorial || parsed.Publisher || '').toString().trim();
    const canonical = { titol, autor, editorial };
    if ('id_tema' in parsed) canonical.id_tema = parsed.id_tema;
    return canonical;
}

// --------------------------------------------------------------------------
// CERCA ALS CATÀLEGS
// --------------------------------------------------------------------------

function calcOverlapScore(book, ocrData) {
    const getWords = txt => {
        const clean = txt.toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, ' ');
        return new Set(clean.split(/\s+/).filter(w => w.length > 1));
    };
    const ocrText = [ocrData.titol || '', ocrData.autor || '', ocrData.editorial || ''].join(' ');
    const ocrWords = getWords(ocrText);
    const titleWords = getWords(book.title || '');
    const authorStr = (book.author_name || [])[0] || book.author || '';
    const authorWords = getWords(authorStr);
    const titleMatches = [...titleWords].filter(w => ocrWords.has(w)).length;
    const authorMatches = [...authorWords].filter(w => ocrWords.has(w)).length;
    const titleScore = titleWords.size > 0 ? titleMatches / titleWords.size : 0;
    const authorScore = authorWords.size > 0 ? authorMatches / authorWords.size : 0;
    return (titleScore * 0.6) + (authorScore * 0.4);
}

function parseBneDoc(doc, clean_isbn, isISBNMode) {
    const display = (doc.pnx || {}).display || {};
    const addata = (doc.pnx || {}).addata || {};

    let title = 'Llibre desconegut';
    if (display.title && display.title[0]) title = display.title[0].split('/')[0].trim();

    let author_name = 'Autor desconegut';
    if (display.creator && display.creator[0]) author_name = display.creator[0].split('$$')[0].trim();
    else if (addata.creatorfull && addata.creatorfull[0]) author_name = addata.creatorfull[0].split('$$')[0].trim();
    if (author_name !== 'Autor desconegut') {
        author_name = author_name.replace(/\d/g, '').replace(/-/g, '').trim();
        if (author_name.endsWith(',')) author_name = author_name.slice(0, -1).trim();
        if (author_name.includes(',')) {
            const parts = author_name.split(',');
            author_name = `${parts[1].trim()} ${parts[0].trim()}`;
        }
    }

    let publisher = 'Editorial desconeguda';
    if (display.publisher && display.publisher[0]) {
        const pub = display.publisher[0].includes(':') ? display.publisher[0].split(':')[1] : display.publisher[0];
        publisher = pub.split(',')[0].trim();
    } else if (addata.pub && addata.pub[0]) publisher = addata.pub[0];

    const creationdate = (display.creationdate || ['Any desc.'])[0];
    const key = `/bne/${doc.context || 'L'}/${doc.recordid || 'id'}`;

    const subjectsList = [];
    if (display.genre) display.genre.forEach(g => subjectsList.push(g.split('$$')[0].trim()));
    if (display.subject) display.subject.forEach(s => subjectsList.push(s.split('$$')[0].trim()));
    const uniqueSubjects = [...new Set(subjectsList)];
    const subjects = uniqueSubjects.slice(0, 5).join(', ') || 'No categoritzat';

    let isbn = clean_isbn || '';
    if (addata.isbn && addata.isbn[0]) isbn = addata.isbn[0].replace(/-/g, '').trim();

    const cover = isbn ? `https://proxy-euf.hosted.exlibrisgroup.com/exl_rewrite/syndetics.com/index.php?client=primo&isbn=${isbn}/lc.jpg` : '';

    return { key, title, author_name: [author_name], author: author_name, authors: author_name, publisher: [publisher], editorial: publisher, year: creationdate, any: creationdate, publishYear: creationdate, first_publish_year: creationdate, isbn, cover, matchScore: 1.0, isISBNMode, source: 'BNE', isBNE: true, subjects };
}

async function searchCatalogsByIsbn(isbn) {
    const clean = isbn.replace(/-/g, '').replace(/\s/g, '');
    const candidates = [];

    // 1. Google Books
    try {
        const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${clean}`);
        const d = await r.json();
        if (d.totalItems > 0) {
            const info = d.items[0].volumeInfo || {};
            const authors = (info.authors || []).join(', ') || 'Autor desconegut';
            candidates.push({
                key: `/isbn/${clean}`, title: info.title || 'Sense títol',
                author_name: [authors], author: authors, authors,
                publisher: [info.publisher || ''], editorial: info.publisher || '',
                year: (info.publishedDate || '').substring(0, 4), any: (info.publishedDate || '').substring(0, 4),
                publishYear: (info.publishedDate || '').substring(0, 4), first_publish_year: (info.publishedDate || '').substring(0, 4),
                isbn: clean, cover: (info.imageLinks || {}).thumbnail || '',
                matchScore: 1.0, isISBNMode: true, source: 'Google Books', isBNE: false,
                subjects: (info.categories || []).join(', ') || 'No categoritzat'
            });
        }
    } catch (e) { console.warn('[BG] Google Books error:', e.message); }

    // 2. Open Library
    try {
        const r = await fetch(`https://openlibrary.org/search.json?isbn=${clean}&fields=key,title,author_name,first_publish_year,cover_i,publisher,isbn,subject`);
        const d = await r.json();
        for (const doc of (d.docs || []).slice(0, 2)) {
            const authors = (doc.author_name || []).join(', ') || 'Autor desconegut';
            const pub = (doc.publisher || [])[0] || '';
            const cover = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : '';
            candidates.push({
                key: `/isbn/${clean}`, title: doc.title || 'Sense títol',
                author_name: [authors], author: authors, authors,
                publisher: [pub], editorial: pub,
                year: String(doc.first_publish_year || ''), any: String(doc.first_publish_year || ''),
                publishYear: String(doc.first_publish_year || ''), first_publish_year: String(doc.first_publish_year || ''),
                isbn: clean, cover, matchScore: 1.0, isISBNMode: true, source: 'Open Library', isBNE: false,
                subjects: (doc.subject || []).slice(0, 5).join(', ') || 'No categoritzat'
            });
        }
    } catch (e) { console.warn('[BG] Open Library error:', e.message); }

    // 3. BNE
    try {
        const bneUrl = `https://catalogo.bne.es/primaws/rest/pub/pnxs?blendFacetsSeparately=false&disableCache=false&getMore=0&inst=34BNE_INST&isCDSearch=false&page_lang=es&limit=10&offset=0&pcAvailability=true&q=any,contains,${clean},AND;rtype,exact,books&rtaLinks=true&scope=MyInstitution&searchInFulltextUserSelection=true&skipDelivery=Y&sort=rank&tab=LibraryCatalog&vid=34BNE_INST:CATALOGO`;
        const r = await fetch(bneUrl, { headers: { 'Accept': 'application/json' } });
        const d = await r.json();
        for (const doc of (d.docs || []).slice(0, 3)) {
            candidates.push(parseBneDoc(doc, clean, true));
        }
    } catch (e) { console.warn('[BG] BNE error:', e.message); }

    // 4. BNC si no hi ha candidats
    if (candidates.length === 0) {
        try {
            const bncUrl = `https://bibliografiacatalana.bnc.cat/primaws/rest/pub/pnxs?blendFacetsSeparately=false&disableCache=false&getMore=0&inst=34CSUC_BC&isCDSearch=false&page_lang=ca&limit=10&offset=0&pcAvailability=true&q=any,contains,${clean},AND;rtype,exact,books&rtaLinks=true&scope=bib_cat&searchInFulltextUserSelection=true&skipDelivery=Y&sort=rank&tab=BIB_CAT&vid=34CSUC_BC:BIB_CAT`;
            const r = await fetch(bncUrl, { headers: { 'Accept': 'application/json' } });
            const d = await r.json();
            for (const doc of (d.docs || []).slice(0, 3)) {
                const c = parseBneDoc(doc, clean, true);
                c.source = 'BNC'; c.key = c.key.replace('/bne/', '/bnc/');
                candidates.push(c);
            }
        } catch (e) { console.warn('[BG] BNC error:', e.message); }
    }

    // Deduplica per títol
    const seen = new Set();
    return candidates.filter(c => {
        const k = c.title.toLowerCase().trim();
        if (seen.has(k)) return false;
        seen.add(k); return true;
    });
}

async function searchCatalogsByPortada(ocrData) {
    const { titol = '', autor = '', editorial = '' } = ocrData;
    const candidates = [];

    const stopwords = new Set(['el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for']);
    const combined = [titol, autor, editorial].join(' ').toLowerCase().replace(/[^\w\sàéèíóòúüçñ]/g, ' ');
    const keywords = combined.split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w)).slice(0, 8);

    if (keywords.length === 0) return [];

    // Open Library: primer intent estructurat, segon per paraules clau
    let docs = [];
    try {
        const params = [];
        if (titol) params.push(`title=${encodeURIComponent(titol)}`);
        if (autor) params.push(`author=${encodeURIComponent(autor)}`);
        if (editorial) params.push(`publisher=${encodeURIComponent(editorial)}`);
        const url = `https://openlibrary.org/search.json?${params.join('&')}&fields=key,title,author_name,first_publish_year,cover_i,publisher,isbn,subject&limit=30`;
        const r = await fetch(url);
        const d = await r.json();
        docs = d.docs || [];
    } catch (e) { console.warn('[BG OL]', e.message); }

    if (!docs.length) {
        try {
            const q = keywords.join('+');
            const r = await fetch(`https://openlibrary.org/search.json?q=${q}&fields=key,title,author_name,first_publish_year,cover_i,publisher,isbn,subject&limit=30`);
            const d = await r.json();
            docs = d.docs || [];
        } catch (e) { console.warn('[BG OL fallback]', e.message); }
    }

    for (const doc of docs) {
        const authors = (doc.author_name || []).join(', ') || 'Autor desconegut';
        const pub = (doc.publisher || [])[0] || '';
        const cover = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : '';
        const isbn = (doc.isbn || [])[0] || '';
        const cand = {
            key: doc.key || `/ol/${doc.title}`, title: doc.title || 'Sense títol',
            author_name: doc.author_name || [authors], author: authors, authors,
            publisher: doc.publisher || [pub], editorial: pub,
            year: String(doc.first_publish_year || ''), any: String(doc.first_publish_year || ''),
            publishYear: String(doc.first_publish_year || ''), first_publish_year: String(doc.first_publish_year || ''),
            isbn, cover, isISBNMode: false, source: 'Open Library', isBNE: false,
            subjects: (doc.subject || []).slice(0, 5).join(', ') || 'No categoritzat'
        };
        cand.matchScore = calcOverlapScore(cand, ocrData);
        candidates.push(cand);
    }

    const maxOlScore = candidates.length > 0 ? Math.max(...candidates.map(c => c.matchScore)) : 0;

    // BNE si OL no té bons resultats
    if (maxOlScore < 0.99) {
        try {
            const bneQuery = keywords.join(' OR ');
            const bneUrl = `https://catalogo.bne.es/primaws/rest/pub/pnxs?blendFacetsSeparately=false&disableCache=false&getMore=0&inst=34BNE_INST&isCDSearch=false&page_lang=es&limit=15&offset=0&pcAvailability=true&q=any,contains,${encodeURIComponent(bneQuery)},AND;rtype,exact,books&rtaLinks=true&scope=MyInstitution&searchInFulltextUserSelection=true&skipDelivery=Y&sort=rank&tab=LibraryCatalog&vid=34BNE_INST:CATALOGO`;
            const r = await fetch(bneUrl, { headers: { 'Accept': 'application/json' } });
            const d = await r.json();
            for (const doc of (d.docs || []).slice(0, 10)) {
                const c = parseBneDoc(doc, '', false);
                c.matchScore = calcOverlapScore(c, ocrData);
                candidates.push(c);
            }
        } catch (e) { console.warn('[BG BNE]', e.message); }
    }

    // BNC si els resultats no són bons
    const hasBestScore = candidates.some(c => (c.matchScore || 0) >= 0.55);
    if (!hasBestScore) {
        try {
            const bncQuery = keywords.join(' OR ');
            const bncUrl = `https://bibliografiacatalana.bnc.cat/primaws/rest/pub/pnxs?blendFacetsSeparately=false&disableCache=false&getMore=0&inst=34CSUC_BC&isCDSearch=false&page_lang=ca&limit=15&offset=0&pcAvailability=true&q=any,contains,${encodeURIComponent(bncQuery)},AND;rtype,exact,books&rtaLinks=true&scope=bib_cat&searchInFulltextUserSelection=true&skipDelivery=Y&sort=rank&tab=BIB_CAT&vid=34CSUC_BC:BIB_CAT`;
            const r = await fetch(bncUrl, { headers: { 'Accept': 'application/json' } });
            const d = await r.json();
            for (const doc of (d.docs || []).slice(0, 10)) {
                const c = parseBneDoc(doc, '', false);
                c.source = 'BNC'; c.key = c.key.replace('/bne/', '/bnc/');
                c.matchScore = calcOverlapScore(c, ocrData);
                candidates.push(c);
            }
        } catch (e) { console.warn('[BG BNC]', e.message); }
    }

    // Ordena i deduplica
    candidates.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    const seen = new Set();
    return candidates.filter(c => {
        const k = c.title.toLowerCase().trim();
        if (seen.has(k)) return false;
        seen.add(k); return true;
    }).slice(0, 10);
}

// --------------------------------------------------------------------------
// PROCESSAMENT DEL FLUX COMPLET (portada capturada → candidats)
// --------------------------------------------------------------------------

async function processSearchForSession(sid) {
    if (processingSearchSids.has(sid)) {
        console.log(`[BG] Sessió ${sid} ja s'està processant, ignorant duplicat.`);
        return;
    }
    processingSearchSids.add(sid);
    console.log(`[BG] 🚀 Iniciant processament per a la sessió ${sid}...`);

    try {
        // Obté clau API i motor OCR des de chrome.storage.local
        const cfg = await new Promise(resolve => chrome.storage.local.get(['gemini_api_key', 'ocr_engine'], resolve));
        const apiKey = (cfg.gemini_api_key && cfg.gemini_api_key !== '-') ? cfg.gemini_api_key : '';
        const ocrEngine = cfg.ocr_engine || 'gemini-api';

        // Descarrega l'estat complet de la sessió
        const stateRes = await fetch(`http://localhost:8080/api/session-state?sid=${sid}&t=${Date.now()}`);
        const stateData = await stateRes.json();

        // Comprova si hi ha escaneig d'ISBN pendent
        const latestScan = stateData.latest_scan;

        if (latestScan && latestScan.type === 'isbn' && latestScan.value) {
            // Flux ISBN
            const isbn = latestScan.value;
            console.log(`[BG] 🔍 Cercant ISBN: ${isbn}`);
            const candidates = await searchCatalogsByIsbn(isbn);
            console.log(`[BG] ✅ ${candidates.length} candidats per ISBN ${isbn}`);
            await fetch(`http://localhost:8080/api/candidates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sid, candidates })
            });
            return;
        }

        // Flux portada
        if (!apiKey) {
            console.warn(`[BG] ⚠️ No hi ha clau API de Gemini configurada. Obre la rodeta ⚙️ per configurar-la.`);
            // Notifica a la pestanya de la intranet
            notifyIntranetTab(sid, {
                ...stateData,
                state: 'scanning',
                outcome: { success: false, error: 'No hi ha clau API de Gemini. Obre la rodeta ⚙️ per configurar-la.' }
            });
            // Torna al servidor a scanning
            await fetch(`http://localhost:8080/api/session-state?sid=${sid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sid, state: 'scanning' })
            });
            return;
        }

        // Descarrega el frame de la càmera
        console.log(`[BG] 📷 Descarregant frame de càmera per a ${sid}...`);
        const frameRes = await fetch(`http://localhost:8080/api/camera-frame?sid=${sid}&t=${Date.now()}`);
        if (!frameRes.ok) {
            throw new Error(`No s'ha pogut descarregar el frame: HTTP ${frameRes.status}`);
        }
        const frameBlob = await frameRes.blob();

        // Converteix blob a base64 (sense usar FileReader que no existeix en Service Workers)
        const arrayBuffer = await frameBlob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        const base64Image = btoa(binary);

        // Opcions de tema del formulari
        const themeOptions = (stateData.formData || {})._selectOptions?.id_tema || [];

        // Crida Gemini OCR
        console.log(`[BG] 🤖 Enviant portada a Gemini OCR...`);
        const ocrData = await callGeminiOcr(apiKey, base64Image, themeOptions);
        console.log(`[BG] 🤖 OCR completat:`, ocrData);

        // Cerca als catàlegs amb les dades de la portada
        console.log(`[BG] 🔍 Cercant als catàlegs per a: ${ocrData.titol} / ${ocrData.autor}`);
        const candidates = await searchCatalogsByPortada(ocrData);

        // Afegeix les dades d'OCR als candidats per al formulari
        const enrichedCandidates = candidates.map(c => ({ ...c, _ocr: ocrData }));
        // Si no hi ha candidats, crea un candidat buit amb les dades de l'OCR
        if (enrichedCandidates.length === 0) {
            enrichedCandidates.push({
                key: '/ocr-only',
                title: ocrData.titol || 'Sense títol',
                author: ocrData.autor || '',
                author_name: [ocrData.autor || ''],
                authors: ocrData.autor || '',
                editorial: ocrData.editorial || '',
                publisher: [ocrData.editorial || ''],
                isbn: '',
                cover: '',
                matchScore: 0,
                isISBNMode: false,
                source: 'OCR (Gemini)',
                isBNE: false,
                subjects: '',
                _ocr: ocrData
            });
        }

        console.log(`[BG] ✅ ${enrichedCandidates.length} candidats trobats. Enviant al servidor...`);
        await fetch(`http://localhost:8080/api/candidates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sid, candidates: enrichedCandidates })
        });

    } catch (err) {
        console.error(`[BG] ❌ Error processant sessió ${sid}:`, err.message);
        // Missatge d'error amigable
        let userMsg = `Error del sistema: ${err.message}`;
        if (err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED') || err.message.includes('quota')) {
            userMsg = 'L\'API de Gemini s\'ha quedat sense quota. Prova-ho més tard.';
        } else if (err.message.includes('400') || err.message.includes('API_KEY_INVALID') || err.message.includes('key not valid')) {
            userMsg = 'Clau de l\'API de Gemini incorrecta. Obre la rodeta ⚙️ per revisar-la.';
        }
        try {
            await fetch(`http://localhost:8080/api/session-state?sid=${sid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sid, state: 'done', outcome: { success: false, error: userMsg } })
            });
        } catch (_) {}
    } finally {
        processingSearchSids.delete(sid);
    }
}

// --------------------------------------------------------------------------
// POLLING PRINCIPAL (cada 1.5s)
// --------------------------------------------------------------------------

async function checkServerState() {
    try {
        const activeRes = await fetch('http://localhost:8080/api/active-sessions?t=' + Date.now(), { cache: 'no-store' });
        if (!activeRes.ok) return;
        const activeSids = await activeRes.json();

        for (const sid of activeSids) {
            try {
                const res = await fetch(`http://localhost:8080/api/session-state?sid=${sid}&state_only=true&t=${Date.now()}`, { cache: 'no-store' });
                if (!res.ok) continue;
                const stateData = await res.json();
                const state = stateData.state;
                const version = stateData.version;
                const lastState = lastStates[sid];
                const lastVersion = lastVersions[sid];
                const stateChanged = state !== lastState || version !== lastVersion;

                if (stateChanged) {
                    console.log(`[BG] [Session: ${sid}] ${lastState}→${state} (v${version})`);

                    if (state === 'searching' && !processingSearchSids.has(sid)) {
                        // NOU: background processa la cerca directament
                        processSearchForSession(sid);
                    } else if (state === 'filling') {
                        openIntranetTab(sid, true);
                    }
                    lastStates[sid] = state;
                    lastVersions[sid] = version;
                }

                if (stateData.show_tab_requested) {
                    await fetch(`http://localhost:8080/api/show-tab?sid=${sid}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ requested: false, sid })
                    }).catch(() => {});
                    if (['filling', 'editing', 'saving', 'selection'].includes(state)) {
                        openIntranetTab(sid, true);
                    }
                }

                if (['scanning', 'searching', 'selection', 'filling', 'editing', 'saving', 'done'].includes(state)) {
                    fetch(`http://localhost:8080/api/session-state?sid=${sid}&t=${Date.now()}`, { cache: 'no-store' })
                        .then(r => r.json())
                        .then(fullData => notifyIntranetTab(sid, fullData))
                        .catch(() => {});
                }

            } catch (e) { /* Ignora errors per sessió */ }
        }
    } catch (e) { /* Servidor offline, ignora */ }
}

setInterval(checkServerState, 1500);

// --------------------------------------------------------------------------
// AUTO-RELOAD DE L'EXTENSIÓ (solicitat pel servidor)
// --------------------------------------------------------------------------

async function checkExtensionReload() {
    try {
        const res = await fetch('http://localhost:8080/api/should-reload?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            if (data.reload) {
                console.log('[BG] Servidor sol·licita recàrrega de l\'extensió. Recarregant...');
                chrome.runtime.reload();
            }
        }
    } catch (e) { /* ignora */ }
}
setInterval(checkExtensionReload, 2000);

// --------------------------------------------------------------------------
// AUTO-RELOAD DE PESTANYES DE LLIBREVIU EN ACTUALITZAR L'EXTENSIÓ
// --------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
    chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
            if (tab.url && (tab.url.toLowerCase().includes('llibreviu.org/admin/registre') || tab.url.toLowerCase().includes('llibreviu.org/admin/registres'))) {
                chrome.tabs.reload(tab.id);
            }
        }
    });
});

// --------------------------------------------------------------------------
// LISTENER DE MISSATGES (proxy_fetch + fetch_image_base64 + obertura de pestanyes)
// --------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'proxy_fetch') {
        const { url, options } = request;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        fetch(url, { ...options, signal: controller.signal })
            .then(async res => {
                clearTimeout(timeoutId);
                const ct = res.headers.get('content-type') || '';
                let data;
                try { data = ct.includes('application/json') ? await res.json() : await res.text(); }
                catch (e) { data = {}; }
                sendResponse({ success: true, status: res.status, data });
            })
            .catch(err => {
                clearTimeout(timeoutId);
                sendResponse({ success: false, error: err.name === 'AbortError' ? 'Request timeout' : err.message });
            });
        return true;
    }

    if (request.action === 'fetch_image_base64') {
        fetch(request.url)
            .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); })
            .then(blob => blob.arrayBuffer())
            .then(buffer => {
                const bytes = new Uint8Array(buffer);
                let binary = '';
                for (let i = 0; i < bytes.length; i += 8192) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                }
                sendResponse({ success: true, dataUrl: `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}` });
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === 'open_intranet_tab') {
        openIntranetTab(request.sid || 'default', false, sendResponse);
        return true;
    }

    // Guarda/llegeix la clau API des de chrome.storage.local
    if (request.action === 'save_api_key') {
        chrome.storage.local.set({ gemini_api_key: request.key, ocr_engine: request.engine || 'gemini-api' }, () => {
            console.log(`[BG] Clau API desada a chrome.storage.local (longitud: ${(request.key || '').length})`);
            sendResponse({ success: true });
        });
        return true;
    }

    if (request.action === 'get_api_key') {
        chrome.storage.local.get(['gemini_api_key', 'ocr_engine'], (data) => {
            sendResponse({ key: data.gemini_api_key || '', engine: data.ocr_engine || 'gemini-api' });
        });
        return true;
    }
});
