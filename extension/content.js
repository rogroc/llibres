(function () {
    let latestGeminiApiKey = '-';
    let latestOcrEngine = 'gemini-api';
    let currentPcLocked = true;

    const hostname = window.location.hostname.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    let isTargetPage = path.includes('/admin/registre') ||
        path.includes('/admin/registres') ||
        path.includes('/admin/buscador') ||
        (hostname === 'www.llibreviu.org' && (path.startsWith('/admin/registre') || path.startsWith('/admin/buscador')));

    const isDesktopPage = (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.')) &&
        path.startsWith('/desktop/');

    const urlParams = new URLSearchParams(window.location.search);
    let sid = null;
    if (isTargetPage && !isDesktopPage) {
        const urlSid = urlParams.get('sid');
        if (urlSid && urlSid !== 'default' && urlSid !== 'null') {
            sid = urlSid;
            sessionStorage.setItem('llibreviu_sid', sid);
        } else {
            const cachedSid = sessionStorage.getItem('llibreviu_sid');
            if (cachedSid && cachedSid !== 'default' && cachedSid !== 'null') {
                sid = cachedSid;
            } else {
                sid = Math.random().toString(36).substring(2, 10);
                sessionStorage.setItem('llibreviu_sid', sid);
            }
        }
        if (urlParams.get('sid') !== sid) {
            urlParams.set('sid', sid);
            window.history.replaceState({ ...history.state }, '', `${window.location.pathname}?${urlParams.toString()}`);
        }
    } else {
        sid = urlParams.get('sid') || 'default';
    }

    // Sincronització en temps real per SSE (Server-Sent Events) i Ports de llarga durada.
    // L'àudio silenciós ja no és necessari ja que la connexió de xarxa persistent de l'extensió
    // evita de forma nativa que Chrome suspengui la pestanya.

    function buildContentApiUrl(endpoint) {
        const separator = endpoint.includes('?') ? '&' : '?';
        return `http://localhost:8080${endpoint}${separator}sid=${sid}`;
    }

    // Redirecció remota de logs per a depurar fàcilment des del servidor
    let isLoggingToServer = false;
    function logToServer(level, args) {
        if (isLoggingToServer) return;
        if (!sid || sid === 'null' || sid === 'default') return;
        isLoggingToServer = true;
        try {
            const msg = Array.from(args).map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
            if (chrome.runtime && chrome.runtime.id) {
                chrome.runtime.sendMessage({
                    action: 'proxy_fetch',
                    url: buildContentApiUrl('/api/scan'),
                    options: {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            type: 'desktop-log',
                            value: `[${window.location.href}] [${level.toUpperCase()}] ${msg}`,
                            sid: sid
                        })
                    }
                });
            }
        } catch (e) {
            // ignore
        } finally {
            isLoggingToServer = false;
        }
    }

    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = function (...args) {
        originalLog.apply(console, args);
        logToServer('log', args);
    };
    console.warn = function (...args) {
        originalWarn.apply(console, args);
        logToServer('warn', args);
    };
    console.error = function (...args) {
        originalError.apply(console, args);
        logToServer('error', args);
    };

    // Mapatge dels ID de formulari de Llibreviu (compatibles amb la intranet i el Django admin)
    const fieldMap = {
        'id_isbn': { el: () => document.getElementById('inputCodigo') || document.getElementById('id_isbn') || document.querySelector('input[name="ISBN"]') || document.querySelector('input[name="isbn"]'), label: 'ISBN' },
        'id_titol': { el: () => document.getElementById('titol') || document.getElementById('id_titol') || document.querySelector('input[name="titol"]') || document.querySelector('input[name="title"]'), label: 'Títol' },
        'id_autor': { el: () => document.getElementById('autor') || document.getElementById('id_autor') || document.querySelector('input[name="autor"]') || document.querySelector('input[name="author"]') || document.querySelector('input[name="autor_principal"]'), label: 'Autor' },
        'id_traductor': { el: () => document.getElementById('id_traductor') || document.querySelector('input[name="traductor"]'), label: 'Traductor' },
        'id_illustrador': { el: () => document.getElementById('id_illustrador') || document.querySelector('input[name="illustrador"]') || document.querySelector('input[name="illustrator"]'), label: 'Il·lustrador' },
        'id_editorial': { el: () => document.getElementById('editorial') || document.getElementById('id_editorial') || document.querySelector('input[name="editorial"]') || document.querySelector('input[name="publisher"]'), label: 'Editorial' },
        'id_lloc_edicio': { el: () => document.getElementById('id_lloc_edicio') || document.querySelector('input[name="lloc_edicio"]') || document.querySelector('input[name="place"]'), label: 'Lloc edició' },
        'id_any': { el: () => document.getElementById('anyEdicio') || document.getElementById('id_any') || document.getElementById('id_any_edicio') || document.querySelector('input[name="any_edicio"]') || document.querySelector('input[name="any"]') || document.querySelector('input[name="year"]'), label: 'Any' },
        'id_tema': { el: () => document.getElementById('id_tema') || document.querySelector('select[name="tema"]'), label: 'Tema' },
        'id_notes': { el: () => document.getElementById('id_notes') || document.getElementById('id_observacions') || document.querySelector('textarea[name="observacions"]') || document.querySelector('textarea[name="notes"]'), label: 'Notes' },
        'id_tipus_document': { el: () => document.getElementById('id_tipus_document') || document.querySelector('select[name="tipus_document"]'), label: 'Tipus' },
        'id_disponible': { el: () => document.getElementById('id_disponible') || document.querySelector('select[name="disponible"]'), label: 'Disponible' },
        'id_etiqueta': { el: () => document.getElementById('id_etiqueta') || document.querySelector('select[name="etiqueta"]'), label: 'Etiqueta' },
        'id_intercanvi': { el: () => document.getElementById('id_intercanvi') || document.querySelector('select[name="intercanvi"]'), label: 'Intercanvi' }
    };

    function hasEnoughFields() {
        if (window.location.pathname.toLowerCase().includes('/admin/buscador')) {
            return true;
        }
        let foundFieldsCount = 0;
        for (const config of Object.values(fieldMap)) {
            try {
                if (config.el()) {
                    foundFieldsCount++;
                }
            } catch (e) {
                // ignore
            }
        }
        return foundFieldsCount >= 2;
    }

    if (!isTargetPage && !isDesktopPage) {
        return;
    }

    if (isTargetPage) {
        console.log("🟢 Llibreviu Sync Connector activa i escoltant en aquesta pàgina de la intranet (URL: " + window.location.href + ").");
    } else if (isDesktopPage) {
        console.log("🟢 Llibreviu Sync Connector activa i escoltant a la pàgina de l'ordinador.");
    }



    const base64ToBlob = (base64, type = 'image/jpeg') => {
        const binStr = atob(base64);
        const len = binStr.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            arr[i] = binStr.charCodeAt(i);
        }
        return new Blob([arr], { type });
    };

    const processBlob = async (blob) => {
        try {
            const file = new File([blob], 'portada.jpg', { type: blob.type || 'image/jpeg' });

            // Trobem tots els inputs de fitxer rellevants (pic, imatge, portada, cover)
            const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(input => {
                const name = input.getAttribute('name') || '';
                return name === 'pic' || name === 'imatge' || name === 'portada' || name === 'cover';
            });

            // Si no en trobem cap de filtrat, usem tots els de tipus file de la pàgina
            const targets = fileInputs.length > 0 ? fileInputs : Array.from(document.querySelectorAll('input[type="file"]'));

            if (targets.length > 0) {
                targets.forEach(fileInput => {
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(file);
                    fileInput.files = dataTransfer.files;
                    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                    console.log(`✅ Portada inserida a l'input de fitxers: ${fileInput.name || 'sense nom'}`);

                    const previewDiv = fileInput.parentElement?.previousElementSibling || fileInput.closest('td')?.querySelector('img') || fileInput.closest('div')?.querySelector('img');
                    let previewImg = null;
                    if (previewDiv) {
                        previewImg = previewDiv.tagName === 'IMG' ? previewDiv : previewDiv.querySelector('img');
                    }

                    if (previewImg) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            previewImg.src = reader.result;
                            previewImg.style.display = 'block';
                        };
                        reader.readAsDataURL(blob);
                    }
                });

                // També actualitzem imgAntigua/filaImg generals per coherència si existeixen
                const imgAntigua = document.getElementById('imgAntigua');
                if (imgAntigua) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        imgAntigua.src = reader.result;
                        const filaImg = document.getElementById('filaImg');
                        if (filaImg) {
                            filaImg.classList.remove('esconderImg');
                        }
                    };
                    reader.readAsDataURL(blob);
                }
            }
        } catch (err) {
            console.warn('Error processing cover image blob:', err);
        }
    };

    function getExistingCoverAsBase64() {
        try {
            const imgAntigua = document.getElementById('imgAntigua');
            const tempPreview = document.getElementById('temp-cover-preview');
            const fileInput = document.querySelector('input[type="file"][name="pic"]') ||
                document.querySelector('input[type="file"][name="imatge"]') ||
                document.querySelector('input[type="file"][name="portada"]') ||
                document.querySelector('input[type="file"][name="cover"]') ||
                document.querySelector('input[type="file"]');

            let imgEl = null;
            if (tempPreview && tempPreview.src && tempPreview.src.startsWith('data:')) {
                return tempPreview.src;
            }

            if (imgAntigua && imgAntigua.src && !imgAntigua.src.includes('blank.gif') && !imgAntigua.src.includes('no_image') && !imgAntigua.src.includes('no-image')) {
                imgEl = imgAntigua;
            } else if (fileInput) {
                const parentImg = fileInput.parentElement?.querySelector('img') || fileInput.closest('td')?.querySelector('img') || fileInput.closest('div')?.querySelector('img');
                if (parentImg && parentImg.src && !parentImg.src.includes('blank.gif') && !parentImg.src.includes('no_image') && !parentImg.src.includes('no-image')) {
                    imgEl = parentImg;
                }
            }

            if (imgEl && imgEl.src) {
                return imgEl.src;
            }
        } catch (e) {
            console.warn("Error obtenint imatge de portada:", e);
        }
        return null;
    }

    let lastState = null;
    let lastInjectedCover = null;
    let lastVersion = -1;
    let pollingInterval = null;
    let isFirstStateCheck = true;

    let pageId = null;
    if (isTargetPage) {
        pageId = sessionStorage.getItem('llibreviu_page_id');
        if (!pageId) {
            pageId = 'page_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
            sessionStorage.setItem('llibreviu_page_id', pageId);
        }
    }

    function stopPolling() {
        if (pollingInterval) {
            clearTimeout(pollingInterval);
            pollingInterval = null;
        }
    }
    function safeSendMessage(message, callback) {
        if (!chrome.runtime || !chrome.runtime.id) {
            console.warn("⚠️ Llibreviu Sync: El context de l'extensió s'ha invalidat.");
            stopPolling();
            return false;
        }
        try {
            chrome.runtime.sendMessage(message, (response) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    if (err.message && err.message.includes('context invalidated')) {
                        console.warn("⚠️ Llibreviu Sync: El context de l'extensió s'ha invalidat (lastError).");
                        stopPolling();
                        return;
                    }
                }
                if (callback) {
                    callback(response);
                }
            });
            return true;
        } catch (e) {
            if (e.message && e.message.includes('context invalidated')) {
                console.warn("⚠️ Llibreviu Sync: El context de l'extensió s'ha invalidat (exception).");
                stopPolling();
            }
            return false;
        }
    }
    // 1. Comprovació de resultat després d'haver enviat i recarregat la pàgina
    if (isTargetPage) {
        const wasSaving = sessionStorage.getItem('llibreviu_sync_saving') === 'true';
        if (wasSaving) {
            sessionStorage.removeItem('llibreviu_sync_saving');

            // Comprovem si el Django admin o la intranet mostren missatge d'èxit
            const isSuccess = document.querySelector('.messagelist .success') ||
                document.querySelector('.alert-success') ||
                document.body.innerText.includes('correctament') ||
                document.body.innerText.includes('correctamente') ||
                document.body.innerText.includes('èxit') ||
                document.body.innerText.includes('éxito') ||
                document.body.innerText.includes('guardado');

            if (isSuccess) {
                showNotification("✅ Fitxa de llibre desada amb èxit!");
                safeSendMessage({
                    action: 'proxy_fetch',
                    url: buildContentApiUrl('/api/save-outcome'),
                    options: {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ success: true, sid: sid })
                    }
                });

                if (!window.location.pathname.toLowerCase().includes('/admin/buscador')) {
                    setTimeout(() => {
                        window.location.href = `https://www.llibreviu.org/admin/registre/?sid=${sid}`;
                    }, 500);
                }
            } else {
                // Busquem qualsevol error mostrat al formulari
                const errorEl = document.querySelector('.messagelist .error') ||
                    document.querySelector('.alert-danger') ||
                    document.querySelector('.errornote') ||
                    document.querySelector('.errorlist');
                const errMsg = errorEl ? errorEl.innerText.trim() : 'Error en desar el registre al formulari de producció.';
                showNotification("❌ Error en desar la fitxa!");
                safeSendMessage({
                    action: 'proxy_fetch',
                    url: buildContentApiUrl('/api/save-outcome'),
                    options: {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ success: false, error: errMsg, sid: sid })
                    }
                });
            }
        }
    }

    async function classifyThemeWithGemini(book, options, apiKey) {
        const modelName = "gemini-3.1-flash-lite";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        const optionsStr = options.map(opt => `- "${opt.text}" (valor: "${opt.value}")`).join('\n');

        const prompt = `Classifica el següent llibre en UN dels temes de la llista de classificació de Llibreviu.
CRÍTIC: Per determinar el tema correcte, analitza detingudament no només els temes originals del catàleg, sinó també el títol del llibre i el nom de l'autor. Has de deduir de forma holística el camp acadèmic o professió de l'autor i la intenció real del títol. Per exemple, si l'autor és un reconegut historiador, el llibre s'ha de classificar com a "Història" (i no com a "Economia"), encara que tracti temes d'història econòmica o social.

Dades del llibre:
- Títol: ${book.title}
- Autor: ${book.authors || book.author}
- Editorial: ${book.publisher || book.editorial}
- Any: ${book.year || book.publishYear}
- Temes/Matèries originals: ${book.subjects}

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

        return new Promise((resolve, reject) => {
            const sent = safeSendMessage({
                action: 'proxy_fetch',
                url: url,
                options: {
                    method: 'POST',
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(payload)
                }
            }, (response) => {
                if (response && response.success) {
                    try {
                        const result = response.data;
                        const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (!text) {
                            reject(new Error("No s'ha pogut obtenir la resposta de Gemini per al tema."));
                            return;
                        }
                        resolve(JSON.parse(text.trim()));
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(response ? response.error : "Error de connexió del background worker"));
                }
            });
            if (!sent) {
                reject(new Error("No s'ha pogut enviar el missatge al background worker"));
            }
        });
    }

    async function translateSubjectsToCatalan(subjects, apiKey) {
        if (!subjects || subjects === 'No categoritzat' || subjects === 'No clasificado' || subjects === 'Uncategorized') {
            return 'No categoritzat';
        }
        const modelName = "gemini-3.1-flash-lite";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
        const prompt = `Tradueix els següents temes o matèries de llibres al català de manera directa i natural (separats per comes). Si hi ha estructures de categories de catàlegs (per exemple "Fiction / Mystery & Detective"), tradueix-ho d'una manera simplificada i neta al català (per exemple, "Ficció / Misteri i detectius"). Retorna només els temes en català en text pla, sense cap comentari, sense introducció ni cometes.

Temes a traduir: ${subjects}`;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }]
        };

        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (resp.ok) {
                const resJson = await resp.json();
                const translated = resJson.candidates[0].content.parts[0].text.trim();
                if (translated) return translated;
            }
        } catch (e) {
            console.warn("⚠️ Error traduint temes amb Gemini:", e);
        }
        return subjects;
    }

    async function injectBookFields(book) {
        // Pausa de seguretat de 1.5 segons per donar temps a la intranet a estabilitzar-se
        console.log("[Sync] Esperant 1.5 segons de seguretat perquè s'inicialitzin els scripts de la intranet...");
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Esperem fins que el formulari i els camps crítics estiguin renderitzats al DOM
        const maxRetries = 20;
        const checkInterval = 250;

        for (let i = 0; i < maxRetries; i++) {
            const isbnEl = fieldMap['id_isbn'].el();
            const titolEl = fieldMap['id_titol'].el();
            if (isbnEl || titolEl) {
                break;
            }
            console.log(`[Sync] Esperant que el formulari es renderitzi al DOM... (intent ${i + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        // Petits mil·lisegons extres de marge post-detecció
        await new Promise(resolve => setTimeout(resolve, 300));

        console.log("📥 Injectant dades:", book);

        const isbnEl = fieldMap['id_isbn'].el();
        if (isbnEl && book.isbn) {
            isbnEl.value = book.isbn;
            isbnEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const titolEl = fieldMap['id_titol'].el();
        if (titolEl && book.title) {
            titolEl.value = book.title;
            titolEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const autorEl = fieldMap['id_autor'].el();
        if (autorEl && (book.authors || book.author)) {
            autorEl.value = book.authors || book.author;
            autorEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const traductorEl = fieldMap['id_traductor']?.el();
        if (traductorEl && book.traductor) {
            traductorEl.value = book.traductor;
            traductorEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const illustradorEl = fieldMap['id_illustrador']?.el();
        if (illustradorEl && book.illustrador) {
            illustradorEl.value = book.illustrador;
            illustradorEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const editorialEl = fieldMap['id_editorial'].el();
        if (editorialEl && (book.publisher || book.editorial)) {
            editorialEl.value = book.publisher || book.editorial;
            editorialEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const llocEl = fieldMap['id_lloc_edicio']?.el();
        if (llocEl && (book.place || book.lloc_edicio)) {
            llocEl.value = book.place || book.lloc_edicio;
            llocEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const anyEl = fieldMap['id_any'].el();
        if (anyEl && (book.year || book.any || book.publishYear)) {
            anyEl.value = book.year || book.any || book.publishYear;
            anyEl.dispatchEvent(new Event('input', { bubbles: true }));
        }

        const temaEl = fieldMap['id_tema'].el();
        if (temaEl) {
            if (book.id_tema !== undefined && book.id_tema !== '') {
                temaEl.value = book.id_tema;
                temaEl.dispatchEvent(new Event('change', { bubbles: true }));
                console.log(`✅ Tema rebut i injectat directament: "${book.id_tema}"`);
            } else {
                try {
                    const options = Array.from(temaEl.options)
                        .map(opt => ({ value: opt.value, text: opt.text }))
                        .filter(opt => opt.value !== ""); // Ignore empty option

                    if (options.length > 0) {
                        const apiKey = (latestGeminiApiKey && latestGeminiApiKey !== '-') ? latestGeminiApiKey : '';
                        if (!apiKey) {
                            console.warn("⚠️ No es pot classificar el tema: Clau de l'API de Gemini no configurada. Prem la rodeta ⚙️ per configurar-la.");
                        } else {
                            console.log("🤖 Classificant el tema amb Gemini des de l'extensió (fallback)...");
                            try {
                                const classification = await classifyThemeWithGemini(book, options, apiKey);
                                if (classification && classification.value !== undefined) {
                                    temaEl.value = classification.value;
                                    temaEl.dispatchEvent(new Event('change', { bubbles: true }));
                                    console.log(`✅ Tema seleccionat per Gemini des de l'extensió: "${classification.text}" (valor: ${classification.value})`);
                                }
                            } catch (classErr) {
                                const errMsg = classErr.message || '';
                                if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("limit")) {
                                    console.error("⚠️ Error de quota a Gemini: S'han superat els límits de peticions de la clau.");
                                } else {
                                    console.error("⚠️ Error en classificar el tema amb Gemini:", classErr);
                                }
                            }
                        }
                    }
                } catch (geminiErr) {
                    console.warn("⚠️ Error classificant el tema amb Gemini des de l'extensió:", geminiErr);
                }
            }
        }
        const notesEl = fieldMap['id_notes'].el();
        if (notesEl) {
            let obsValue = '';
            if (book.subjects && book.subjects !== 'No categoritzat') {
                const apiKey = (latestGeminiApiKey && latestGeminiApiKey !== '-') ? latestGeminiApiKey : '';
                if (!apiKey) {
                    console.warn("⚠️ No es poden traduir els temes: Clau de l'API de Gemini no configurada.");
                    obsValue += 'Temes: ' + book.subjects;
                } else {
                    try {
                        console.log("🤖 Traduint els temes al català amb Gemini...");
                        const translatedSubjects = await translateSubjectsToCatalan(book.subjects, apiKey);
                        obsValue += 'Temes: ' + translatedSubjects;
                    } catch (transErr) {
                        console.error("⚠️ Error traduint temes amb Gemini:", transErr);
                        obsValue += 'Temes: ' + book.subjects;
                    }
                }
            }
            notesEl.value = obsValue;
            notesEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Previsualització i pujada de fitxer de portada
        // Previsualització i pujada de fitxer de portada millorada
        const bestCover = await resolveBestCover(book);
        if (bestCover) {
            await injectCoverImage(bestCover);
        } else {
            clearCoverInput();
        }

        showNotification(`Llibre "${book.title}" carregat al formulari.`);
    }

    function showNotification(msg) {
        let notifEl = document.getElementById('sync-notification');
        if (!notifEl) {
            notifEl = document.createElement('div');
            notifEl.id = 'sync-notification';
            notifEl.style.position = 'fixed';
            notifEl.style.bottom = '20px';
            notifEl.style.right = '20px';
            notifEl.style.background = '#27ae60';
            notifEl.style.color = 'white';
            notifEl.style.padding = '12px 20px';
            notifEl.style.borderRadius = '8px';
            notifEl.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
            notifEl.style.fontFamily = 'system-ui, -apple-system, sans-serif';
            notifEl.style.fontWeight = 'bold';
            notifEl.style.fontSize = '0.9rem';
            notifEl.style.zIndex = '999999';
            notifEl.style.transition = 'opacity 0.3s ease';
            document.body.appendChild(notifEl);
        }
        notifEl.innerText = msg;
        notifEl.style.opacity = '1';
        notifEl.style.display = 'block';
        setTimeout(() => {
            notifEl.style.opacity = '0';
            setTimeout(() => { notifEl.style.display = 'none'; }, 300);
        }, 4000);
    }

    function clearCoverInput() {
        console.log("🧹 Netejant fitxer de portada i previsualitzacions del formulari...");
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(input => {
            const name = input.getAttribute('name') || '';
            return name === 'pic' || name === 'imatge' || name === 'portada' || name === 'cover';
        });
        const targets = fileInputs.length > 0 ? fileInputs : Array.from(document.querySelectorAll('input[type="file"]'));
        targets.forEach(fileInput => {
            try {
                fileInput.value = '';
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) { }

            const previewDiv = fileInput.parentElement?.previousElementSibling || fileInput.closest('td')?.querySelector('img') || fileInput.closest('div')?.querySelector('img');
            let previewImg = null;
            if (previewDiv) {
                previewImg = previewDiv.tagName === 'IMG' ? previewDiv : previewDiv.querySelector('img');
            }
            if (previewImg) {
                previewImg.src = '';
                previewImg.style.display = 'none';
            }
        });

        const imgAntigua = document.getElementById('imgAntigua');
        if (imgAntigua) {
            imgAntigua.src = '';
            const filaImg = document.getElementById('filaImg');
            if (filaImg) {
                filaImg.classList.add('esconderImg');
            }
        }

        const tempPreview = document.getElementById('temp-cover-preview');
        if (tempPreview) {
            tempPreview.src = '';
            tempPreview.style.display = 'none';
        }
    }

    async function resolveBestCover(book) {
        if (!book) return null;

        // 1. Si tenim portada de catàleg (no buida, no syndetics ni altres genèrics buits)
        if (book.cover && !book.cover.includes('blank.gif') && !book.cover.includes('no-image') && !book.cover.includes('no_image') && !book.cover.includes('syndetics.com')) {
            return book.cover;
        }

        // 2. Si tenim ISBN, provem de buscar portada oficial a AbeBooks/BookFinder des de l'extensió (evitant WAF bloquejos de Python)
        if (book.isbn) {
            const cleanIsbn = book.isbn.replace(/\D/g, '');
            if (cleanIsbn) {
                console.log(`🔍 [Extension Cover Resolver] Cercant portada oficial per ISBN: ${cleanIsbn}...`);

                // AbeBooks directe (molt ràpid)
                const abUrl = `https://pictures.abebooks.com/isbn/${cleanIsbn}-us.jpg`;
                try {
                    const res = await fetch(abUrl, { method: 'HEAD' });
                    if (res.ok) {
                        console.log("✅ [Extension Cover Resolver] Portada oficial trobada a AbeBooks:", abUrl);
                        return abUrl;
                    }
                } catch (e) {
                    console.warn("[Extension Cover Resolver] Error provant AbeBooks:", e);
                }

                // BookFinder scrape (des de Chrome té cookies/headers nets)
                const bfUrl = `https://www.bookfinder.com/isbn/${cleanIsbn}`;
                try {
                    const res = await fetch(bfUrl);
                    if (res.ok) {
                        const html = await res.text();
                        let match = html.match(/itemprop="image"\s+src="([^"]+)"/);
                        if (match) {
                            console.log("✅ [Extension Cover Resolver] Portada oficial trobada a BookFinder:", match[1]);
                            return match[1];
                        }
                        match = html.match(/id="coverImage"\s+src="([^"]+)"/);
                        if (match) {
                            console.log("✅ [Extension Cover Resolver] Portada oficial trobada a BookFinder:", match[1]);
                            return match[1];
                        }
                    }
                } catch (e) {
                    console.warn("[Extension Cover Resolver] Error raspant BookFinder:", e);
                }
            }
        }

        // 3. Fallback final: la foto de la portada capturada des del mòbil si existeix
        if (book._cover_image) {
            console.log("📸 [Extension Cover Resolver] Fent servir la foto de la portada capturada pel mòbil.");
            return book._cover_image;
        }

        return null;
    }

    async function injectCoverImage(urlOrBase64) {
        if (!urlOrBase64) return;

        // 1. Si és una data URL (base64)
        if (urlOrBase64.startsWith('data:')) {
            try {
                const parts = urlOrBase64.split(',');
                const base64Data = parts[1];
                const mimeType = parts[0].split(':')[1].split(';')[0];
                const blob = base64ToBlob(base64Data, mimeType);
                await processBlob(blob);
            } catch (err) {
                console.warn('Error processing base64 cover image:', err);
            }
            return;
        }

        // 2. Si és una URL HTTP/HTTPS de catàleg
        const secureUrl = urlOrBase64.replace(/^http:\/\//i, 'https://');

        // Previsualització inicial de la URL
        const imgAntigua = document.getElementById('imgAntigua');
        if (imgAntigua) {
            imgAntigua.src = secureUrl;
            const filaImg = document.getElementById('filaImg');
            if (filaImg) {
                filaImg.classList.remove('esconderImg');
            }
        }

        const tryFetchDirect = async (url) => {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP error ${res.status}`);
                const blob = await res.blob();
                await processBlob(blob);
                return true;
            } catch (e) {
                console.log(`Direct fetch for cover failed (CORS/Network), trying background proxy:`, e.message);
                return false;
            }
        };

        const successDirect = await tryFetchDirect(secureUrl);
        if (successDirect) return;

        safeSendMessage({ action: 'fetch_image_base64', url: secureUrl }, (response) => {
            if (response && response.success && response.dataUrl) {
                try {
                    const parts = response.dataUrl.split(',');
                    const base64Data = parts[1];
                    const mimeType = parts[0].split(':')[1].split(';')[0];
                    const blob = base64ToBlob(base64Data, mimeType);
                    processBlob(blob);
                } catch (err) {
                    console.warn('Error converting background base64 response to blob:', err);
                }
            } else {
                console.warn("⚠️ El background worker no ha pogut descarregar la imatge:", response ? response.error : "sense resposta");
            }
        });
    }

    let beforeUnloadListener = null;

    function lockForm() {
        console.log("🔒 LockForm: Sincronització activa amb el mòbil. Bloquejant entrada de dades a l'ordinador.");

        for (const [key, config] of Object.entries(fieldMap)) {
            const el = config.el();
            if (el) {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    el.readOnly = true;
                } else {
                    el.disabled = true;
                }
                el.style.backgroundColor = '#f5f5f5';
                el.style.cursor = 'not-allowed';
            }
        }

        const fileInputs = document.querySelectorAll('input[type="file"]');
        fileInputs.forEach(el => {
            el.disabled = true;
            el.style.cursor = 'not-allowed';
        });

        if (!beforeUnloadListener) {
            beforeUnloadListener = (e) => {
                e.preventDefault();
                e.returnValue = "Hi ha una sessió de catalogació activa amb el mòbil. Estàs segur que vols sortir?";
                return e.returnValue;
            };
            window.addEventListener('beforeunload', beforeUnloadListener);
        }

        showLockedBanner(true);
    }

    function unlockForm() {
        console.log("🔓 UnlockForm: Sincronització inactiva. Re-activant entrada de dades a l'ordinador.");

        for (const [key, config] of Object.entries(fieldMap)) {
            const el = config.el();
            if (el) {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    el.readOnly = false;
                } else {
                    el.disabled = false;
                }
                el.style.backgroundColor = '';
                el.style.cursor = '';
            }
        }

        const fileInputs = document.querySelectorAll('input[type="file"]');
        fileInputs.forEach(el => {
            el.disabled = false;
            el.style.cursor = '';
        });

        if (beforeUnloadListener) {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            beforeUnloadListener = null;
        }

        showLockedBanner(false);
    }

    function showLockedBanner(show) {
        let banner = document.getElementById('sync-locked-banner');
        if (show) {
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'sync-locked-banner';
                banner.style.position = 'fixed';
                banner.style.top = '0';
                banner.style.left = '0';
                banner.style.width = '100%';
                banner.style.background = '#e67e22';
                banner.style.color = 'white';
                banner.style.textAlign = 'center';
                banner.style.padding = '8px';
                banner.style.fontSize = '0.9rem';
                banner.style.fontWeight = 'bold';
                banner.style.fontFamily = 'system-ui, -apple-system, sans-serif';
                banner.style.zIndex = '999999';
                banner.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
                banner.innerHTML = '🔒 Sincronització amb el mòbil activa. El formulari de l\'ordinador està bloquejat (només lectura).';
                document.body.appendChild(banner);
                document.body.style.marginTop = '35px';
            }
        } else {
            if (banner) {
                banner.remove();
                document.body.style.marginTop = '';
            }
        }
    }

    function registerActivePage() {
        if (!isTargetPage || !pageId || !hasEnoughFields()) return;

        const scraped = {};
        const selectOptions = {};
        const requiredFields = [];
        for (const [key, config] of Object.entries(fieldMap)) {
            const el = config.el();
            if (el) {
                scraped[key] = el.value;
                let isRequired = el.hasAttribute('required') || el.required;
                const rowEl = el.closest('.form-row') || el.closest('tr') || el.closest('.form-group');
                const labelEl = document.querySelector(`label[for="${el.id}"]`) || rowEl?.querySelector('label');
                if (isRequired || (rowEl && rowEl.classList.contains('required')) || (labelEl && (labelEl.classList.contains('required') || labelEl.innerHTML.includes('*') || labelEl.innerText.includes('*')))) {
                    requiredFields.push(key);
                }
                if (el.tagName === 'SELECT') {
                    const opts = [];
                    for (let i = 0; i < el.options.length; i++) {
                        opts.push({ value: el.options[i].value, text: el.options[i].text });
                    }
                    selectOptions[key] = opts;
                }
            } else {
                scraped[key] = '';
            }
        }
        scraped._selectOptions = selectOptions;
        scraped._requiredFields = requiredFields;

        try {
            scraped._cover_image = getExistingCoverAsBase64();
        } catch (coverErr) {
            console.warn("⚠️ Error obtenint la portada existent en registre:", coverErr);
        }

        safeSendMessage({
            action: 'proxy_fetch',
            url: buildContentApiUrl('/api/register-active-page'),
            options: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageId: pageId, formData: scraped, sid: sid })
            }
        });
    }

    async function handleDecommissionState(sessionData) {
        const status = sessionData.decommission_status || "idle";
        const code = sessionData.decommission_code || "";
        const selectedId = sessionData.decommission_selected_id || "";

        console.log(`[Decommission Content] Status: ${status}, code: ${code}, selectedId: ${selectedId}`);

        if (status === 'searching' || status === 'decommissioning') {
            safeSendMessage({ action: 'focus_tab' });
        }

        const statusEl = document.getElementById('widget-status-val');
        if (statusEl) {
            const decomLabels = {
                'idle': 'Llest per donar de baixa 📷',
                'searching': 'Cercant llibre per a baixa... 🔍',
                'found': 'Triant llibre al mòbil 📱',
                'decommissioning': 'Executant baixa... ⏳',
                'done': 'Baixa completada! ✅'
            };
            statusEl.innerText = decomLabels[status] || 'Actiu (Baixa) 📱';
        }

        if (status === 'idle' || status === 'done') {
            sessionStorage.removeItem('llibreviu_last_searched_decommission_code');
        }

        // 1. If status is 'searching', redirect to search results page using the q parameter
        if (status === 'searching' && code) {
            const currentQ = urlParams.get('q');
            if (currentQ !== code) {
                console.log(`[Decommission Content] Redirecting to search URL for code: ${code}`);
                window.location.href = `https://www.llibreviu.org/admin/buscador?q=${code}&type=0&sid=${sid}`;
                return;
            }
        }

        // 2. If results are loaded on the page, extract candidates and send them to the server.
        if (status === 'searching') {
            const candidates = extractDecommissionCandidates();
            console.log(`[Decommission Content] Found ${candidates.length} candidates.`);

            safeSendMessage({
                action: 'proxy_fetch',
                url: `http://localhost:8080/api/decommission/candidates`,
                options: {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sid: sid, candidates: candidates })
                }
            });
            return;
        }

        // 3. If status is 'decommissioning' and we have a selected ID:
        if (status === 'decommissioning' && selectedId) {
            const checkboxes = document.querySelectorAll('input[type="checkbox"], input[type="radio"]');
            let targetCb = null;
            for (const cb of checkboxes) {
                if (cb.value === selectedId) {
                    targetCb = cb;
                    break;
                }
            }

            if (targetCb) {
                console.log(`[Decommission Content] Checking item checkbox with ID: ${selectedId}`);
                targetCb.checked = true;
                targetCb.dispatchEvent(new Event('change', { bubbles: true }));

                const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"], a, div, span');
                let deleteBtn = null;
                for (const btn of buttons) {
                    const txt = (btn.value || btn.innerText || '').toLowerCase();
                    if (txt.includes('baixa') || txt.includes('eliminar') || txt.includes('borrar') || txt.includes('decommission')) {
                        deleteBtn = btn;
                        break;
                    }
                }

                if (deleteBtn) {
                    console.log("[Decommission Content] Clicking decommission button...");
                    deleteBtn.click();

                    // Wait for the confirmation modal to appear and click "Eliminar"
                    let attempts = 0;
                    const confirmInterval = setInterval(() => {
                        attempts++;
                        if (attempts > 40) { // Timeout after 4 seconds
                            clearInterval(confirmInterval);
                            console.warn("[Decommission Content] Timeout waiting for confirmation modal.");
                            return;
                        }

                        const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a'));
                        // Find the confirm button in the modal (usually has text 'Eliminar' or is styled red/danger)
                        const eliminarBtn = buttons.find(btn => {
                            const txt = (btn.value || btn.innerText || '').toLowerCase().trim();

                            // Check for exact "eliminar" or key confirmation strings (avoiding wrapper divs/spans)
                            return txt === 'eliminar' ||
                                txt === 'confirmar' ||
                                txt === 'sí, eliminar' ||
                                txt === 'sí, estic segur' ||
                                txt === 'estic segur';
                        });

                        if (eliminarBtn) {
                            clearInterval(confirmInterval);
                            console.log("[Decommission Content] Found modal confirm button. Clicking 'Eliminar'...");
                            eliminarBtn.click();

                            // Send completion update to the server only after confirming deletion
                            safeSendMessage({
                                action: 'proxy_fetch',
                                url: `http://localhost:8080/api/decommission/done`,
                                options: {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ sid: sid })
                                }
                            });
                        }
                    }, 100);
                } else {
                    console.error("[Decommission Content] Decommission button not found!");
                }
            } else {
                console.error(`[Decommission Content] Checkbox with ID ${selectedId} not found!`);
            }
        }
    }

    function extractDecommissionCandidates() {
        const candidates = [];
        const rows = document.querySelectorAll('table tbody tr') || document.querySelectorAll('tr');
        rows.forEach((row, idx) => {
            if (row.querySelector('th')) return;
            const checkbox = row.querySelector('input[type="checkbox"]') || row.querySelector('input[type="radio"]');
            if (!checkbox) return;

            let title = row.innerText.trim().replace(/\s+/g, ' ');
            candidates.push({
                id: checkbox.value || idx.toString(),
                title: title,
                index: idx
            });
        });

        if (candidates.length === 0) {
            const checkboxes = document.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach((cb, idx) => {
                if (cb.id === 'widget-use-tunnel-checkbox') return;
                const label = cb.closest('label')?.innerText.trim() || cb.nextSibling?.textContent?.trim() || `Element ${idx}`;
                candidates.push({
                    id: cb.value || idx.toString(),
                    title: label,
                    index: idx
                });
            });
        }
        return candidates;
    }

    async function handleExtensionState(sessionData) {
        if (window.location.pathname.toLowerCase().includes('/admin/buscador')) {
            await handleDecommissionState(sessionData);
            return;
        }

        const { state, formData, pc_locked, gemini_api_key, ocr_engine } = sessionData;
        if (gemini_api_key) {
            latestGeminiApiKey = gemini_api_key;
        }
        if (ocr_engine) {
            latestOcrEngine = ocr_engine;
        }
        currentPcLocked = (pc_locked !== false);
        updateWidgetPcLockUI();

        const statusEl = document.getElementById('widget-status-val');
        if (statusEl) {
            const stateLabels = {
                'scanning': 'Llest per escanejar 📷',
                'searching': 'Cercant dades... 🔍',
                'selection': 'Triant llibre al mòbil 📱',
                'filling': 'Emplenant formulari ✍️',
                'editing': 'Formulari llest per desar 💾',
                'saving': 'Desant a la BD... ⏳',
                'done': 'Llibre desat! ✅'
            };
            statusEl.innerText = stateLabels[state] || 'Inactiu 💤';
        }

        if (state === 'filling' || state === 'editing' || state === 'saving') {
            if (pc_locked === false) {
                unlockForm();
            } else {
                lockForm();
            }
        } else {
            unlockForm();
        }

        const coverToInject = await resolveBestCover(formData);
        if (coverToInject && coverToInject !== lastInjectedCover) {
            lastInjectedCover = coverToInject;
            console.log("📸 Nova portada rebuda des del mòbil/catàleg/BookFinder. Injectant al formulari immediatament...");
            await injectCoverImage(coverToInject);
            if (!isFirstStateCheck) {
                showNotification("📸 Portada actualitzada!");
            }
        }
        isFirstStateCheck = false;

        if (state === lastState) {
            return;
        }

        lastState = state;
        console.log(`Estat de la sincronització: ${state}`);

        if (state === 'filling') {
            // El mòbil ha seleccionat un llibre candidiat, que ens arriba en forma de formulari inicial.
            // L'injectem a la pàgina de l'ordinador.
            try {
                if (formData) {
                    await injectBookFields(formData);
                }
            } catch (err) {
                console.error("❌ Error injectant dades del llibre:", err);
            }

            try {
                // Llegim l'estat final de tots els inputs del formulari
                // (incloent text de notes modificat o possibles ID per defecte de Django).
                const scraped = {};
                const selectOptions = {};
                const requiredFields = [];
                for (const [key, config] of Object.entries(fieldMap)) {
                    const el = config.el();
                    if (el) {
                        scraped[key] = el.value;

                        // Determinem si el camp és obligatori a la intranet o Django admin
                        let isRequired = el.hasAttribute('required') || el.required;
                        const rowEl = el.closest('.form-row') || el.closest('tr') || el.closest('.form-group');
                        const labelEl = document.querySelector(`label[for="${el.id}"]`) || rowEl?.querySelector('label');
                        if (isRequired || (rowEl && rowEl.classList.contains('required')) || (labelEl && (labelEl.classList.contains('required') || labelEl.innerHTML.includes('*') || labelEl.innerText.includes('*') || labelEl.innerText.includes('(*)')))) {
                            requiredFields.push(key);
                        }

                        if (el.tagName === 'SELECT') {
                            const opts = [];
                            for (let i = 0; i < el.options.length; i++) {
                                opts.push({
                                    value: el.options[i].value,
                                    text: el.options[i].text
                                });
                            }
                            selectOptions[key] = opts;
                        }
                    } else {
                        scraped[key] = '';
                    }
                }
                scraped._selectOptions = selectOptions;
                scraped._requiredFields = requiredFields;

                try {
                    scraped._cover_image = getExistingCoverAsBase64();
                } catch (coverErr) {
                    console.warn("⚠️ Error obtenint la portada existent:", coverErr);
                }

                // Informem al servidor local que el formulari està preparat per a ser editat des del mòbil
                safeSendMessage({
                    action: 'proxy_fetch',
                    url: buildContentApiUrl('/api/form-ready'),
                    options: {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pageId: pageId, formData: scraped, sid: sid })
                    }
                });
            } catch (err) {
                console.error("❌ Error preparant el formulari de retorn:", err);
                // Fallback: informem al servidor local per no deixar el mòbil penjat
                safeSendMessage({
                    action: 'proxy_fetch',
                    url: buildContentApiUrl('/api/form-ready'),
                    options: {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pageId: pageId, formData: formData || {}, sid: sid })
                    }
                });
            }
        } else if (state === 'saving') {
            // L'usuari ha clicat acceptar des del mòbil, ens arriben els camps finals modificats.
            // Els tornem a escriure sobre el formulari web real.
            try {
                if (formData) {
                    for (const [key, config] of Object.entries(fieldMap)) {
                        try {
                            const el = config.el();
                            if (el && formData[key] !== undefined) {
                                el.value = formData[key];
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                if (el.tagName === 'SELECT') {
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                }
                            }
                        } catch (fieldErr) {
                            console.warn(`⚠️ Error injecting field ${key}:`, fieldErr);
                        }
                    }
                    // Si tenim imatge de portada resolta (preferint catàleg/AbeBooks/BookFinder), la injectem
                    const bestCover = await resolveBestCover(formData);
                    if (bestCover) {
                        lastInjectedCover = bestCover;
                        await injectCoverImage(bestCover);
                    }
                }
            } catch (saveErr) {
                console.error("❌ Error injectant dades final del llibre:", saveErr);
            }

            // Marquem que estem desant a sessionStorage per verificar el resultat després del submit / reload
            sessionStorage.setItem('llibreviu_sync_saving', 'true');

            // Re-activem temporals per permetre que es basin correctament els valors al POST del formulari
            unlockForm();

            console.log("💾 Clicant botó de desar formulari...");
            const addAnotherBtn = document.querySelector('input[name="_addanother"]') ||
                document.querySelector('button[name="_addanother"]');
            const submitBtn = addAnotherBtn ||
                document.querySelector('button[type="submit"]') ||
                document.querySelector('input[type="submit"]') ||
                document.querySelector('input[name="_save"]') ||
                document.querySelector('form[method="post"] button') ||
                document.querySelector('._cta'); // Intranet class

            if (submitBtn) {
                submitBtn.click();
            } else {
                const form = document.querySelector('form');
                if (form) form.submit();
            }
        }
    }

    let sseSource = null;
    let bgPort = null;
    let keepAliveInterval = null;

    async function handleSseStateUpdate(stateData) {
        if (!stateData) return;

        if (stateData.gemini_api_key) {
            latestGeminiApiKey = stateData.gemini_api_key;
        }
        if (stateData.ocr_engine !== undefined) {
            latestOcrEngine = stateData.ocr_engine;
        }

        const eligible = hasEnoughFields();
        const isNotActiveOnServer = stateData.active_page_id !== pageId;
        const isVisible = document.visibilityState === 'visible';
        const shouldRegister = isTargetPage && eligible && (
            (!stateData.active_page_id) ||
            (isVisible && isNotActiveOnServer)
        );

        if (shouldRegister) {
            console.log("[Sync] Registrant aquesta pestanya com activa al servidor (motiu: visible o buida al servidor).");
            registerActivePage();
        }

        if (stateData.state !== lastState || stateData.version !== lastVersion) {
            // Si som a la pàgina de l'ordinador (desktop page) i l'estat passa a ser actiu per catalogar ('filling', 'editing', 'saving'),
            // demanem al background worker que obri o enfoqui la pestanya de la intranet de Llibreviu.
            if (isDesktopPage && (stateData.state === 'filling' || stateData.state === 'editing' || stateData.state === 'saving')) {
                console.log(`[Sync] Estat active detectat (${stateData.state}). Demanant obertura de pestanya de la intranet.`);
                if (bgPort) bgPort.postMessage({ action: 'focus_tab', sid: sid });
            }

            // Si som a la pàgina de la intranet (isTargetPage) i l'estat passa a ser 'searching' o 'scanning',
            // netegem la pestanya de sincronització activa i alliberem el formulari.
            if (isTargetPage && (stateData.state === 'searching' || stateData.state === 'scanning')) {
                console.log(`[Sync] Estat de cerca o escaneig detectat (${stateData.state}). Alliberant el formulari.`);
                unlockForm();
                clearCoverInput();
                lastState = stateData.state;
                lastVersion = stateData.version;
                isFirstStateCheck = true;
                lastInjectedCover = null;
            }

            if (isTargetPage) {
                if (window.location.pathname.toLowerCase().includes('/admin/buscador')) {
                    lastVersion = stateData.version;
                    await handleExtensionState(stateData);
                } else {
                    const isActivePage = stateData.active_page_id === pageId;

                    // Si hi ha una sessió activa a una altra pestanya, ignorem l'estat i assegurem que estem desbloquejats
                    if (stateData.active_page_id && !isActivePage) {
                        unlockForm();
                    } else if (!stateData.active_page_id && stateData.state !== 'filling') {
                        // Si no hi ha cap pestanya activa i no estem en filling, ignorem per evitar errors orfes
                    } else {
                        // Si no som la pestanya activa encara i l'estat és 'filling', registrem-nos!
                        if (!stateData.active_page_id && stateData.state === 'filling') {
                            if (eligible) {
                                console.log(`[Sync] Aquesta pestanya reclama la sincronització per al llibre.`);
                                registerActivePage();
                            }
                        }

                        // Només processem l'estat si som la pestanya activa registrada pel servidor
                        if (stateData.active_page_id === pageId) {
                            lastVersion = stateData.version;
                            await handleExtensionState(stateData);
                        }
                    }
                }
            } else if (isDesktopPage) {
                lastState = stateData.state;
                lastVersion = stateData.version;
            }
        }

        // Si l'estat requereix processament d'OCR o cerca de catàlegs, ho notifiquem al background script
        if (stateData.state === 'searching') {
            if (bgPort) {
                bgPort.postMessage({ action: 'process_search', sid: sid });
            }
        }
    }

    function connectToBackgroundPort() {
        if (bgPort) return;
        try {
            bgPort = chrome.runtime.connect({ name: 'llibreviu-sync' });
            console.log("🔌 [Port] Connectat amb el background script de l'extensió.");

            // Rebre actualitzacions d'estat a través del Port (delegat al background)
            bgPort.onMessage.addListener((msg) => {
                if (msg.action === 'state_update') {
                    handleSseStateUpdate(msg.data);
                }
            });

            bgPort.onDisconnect.addListener(() => {
                console.warn("⚠️ [Port] Desconnectat del background script. Reconnectant en 3s...");
                bgPort = null;
                setTimeout(connectToBackgroundPort, 3000);
            });
        } catch (e) {
            console.error("❌ [Port] Error connectant al background script:", e);
        }
    }

    function startSseAndPort() {
        if (!sid || sid === 'default') return;

        // 1. Connectar Port
        connectToBackgroundPort();

        // 2. Notificar inicialització de sessió al background per obrir SSE
        if (bgPort) {
            bgPort.postMessage({ action: 'init', sid: sid });
        }

        // 3. Heartbeat per mantenir el worker actiu (ping cada 20 segons)
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        keepAliveInterval = setInterval(() => {
            if (bgPort) {
                bgPort.postMessage({ action: 'ping' });
            }
        }, 20000);
    }

    function startPolling() {
        console.log("🚀 Llibreviu Sync: S'ha iniciat la connexió persistent per esdeveniments (SSE).");
        startSseAndPort();
    }

    function stopPolling() {
        if (sseSource) {
            sseSource.close();
            sseSource = null;
        }
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        if (bgPort) {
            bgPort.disconnect();
            bgPort = null;
        }
    }

    function injectFloatingWidget() {
        if (!isTargetPage || isDesktopPage) return;

        // Evitem duplicar-lo
        if (document.getElementById('llibreviu-sync-widget')) return;

        const widget = document.createElement('div');
        widget.id = 'llibreviu-sync-widget';
        widget.style.position = 'fixed';
        widget.style.bottom = '20px';
        widget.style.right = '20px';
        widget.style.zIndex = '999998';
        widget.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        widget.style.fontSize = '0.9rem';
        widget.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';

        // Estils de la icona minimitzada (petit botó rodó flotant)
        const minIcon = document.createElement('button');
        minIcon.innerText = '📱';
        minIcon.title = 'Mostrar codi QR de vinculació';
        minIcon.style.background = '#2980b9';
        minIcon.style.color = 'white';
        minIcon.style.border = 'none';
        minIcon.style.width = '48px';
        minIcon.style.height = '48px';
        minIcon.style.borderRadius = '50%';
        minIcon.style.fontSize = '1.4rem';
        minIcon.style.cursor = 'pointer';
        minIcon.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
        minIcon.style.display = 'none'; // Comença amagat perquè es mostra obert per defecte
        minIcon.style.alignItems = 'center';
        minIcon.style.justifyContent = 'center';
        minIcon.style.transition = 'transform 0.2s';

        minIcon.onmouseover = () => minIcon.style.transform = 'scale(1.1)';
        minIcon.onmouseout = () => minIcon.style.transform = 'scale(1)';

        // Estils del panell flotant (obert per defecte)
        const panel = document.createElement('div');
        panel.style.display = 'flex';
        panel.style.flexDirection = 'column';
        panel.style.alignItems = 'center';
        panel.style.background = '#ffffff';
        panel.style.color = '#333333';
        panel.style.border = '2px solid #2980b9';
        panel.style.borderRadius = '12px';
        panel.style.padding = '15px';
        panel.style.width = '200px';
        panel.style.boxShadow = '0 8px 30px rgba(0,0,0,0.25)';

        panel.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 8px; color: #2c3e50; font-size: 0.95rem; display: flex; justify-content: space-between; width:100%; align-items:center;">
                <span>Vinculació Mòbil</span>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <span id="widget-settings-btn" style="cursor:pointer; font-size:1.1rem; color:#888; padding: 2px;" title="Configuració">⚙️</span>
                    <span id="widget-minimize-btn" style="cursor:pointer; font-size:1.3rem; color:#888; line-height: 0.5; padding: 5px; user-select: none;" title="Minimitzar">−</span>
                </div>
            </div>
            <div id="widget-settings-container" style="display:none; width:100%; padding:8px 0; border-top:1px solid #eee; border-bottom:1px solid #eee; margin-bottom:8px; font-size:0.8rem;">
                <div style="font-weight:bold; margin-bottom:4px; color:#555;">Motor de reconeixement:</div>
                <select id="widget-ocr-engine-select" style="width:100%; padding:4px; border:1px solid #ccc; border-radius:4px; font-size:0.75rem; box-sizing:border-box; margin-bottom:8px; background:white; color:black;">
                    <option value="gemini-api">Gemini 3.1 Flash Lite (Online)</option>
                    <option value="local-hybrid">PaddleOCR + Tesseract (Híbrid local)</option>
                    <option value="local-tesseract">Tesseract local (Offline)</option>
                </select>
                <div style="font-weight:bold; margin-bottom:4px; color:#555;">Clau de l'API de Gemini:</div>
                <textarea id="widget-gemini-key-input" placeholder="AIzaSy..." autocomplete="off" style="width:100%; padding:4px; border:1px solid #ccc; border-radius:4px; font-size:0.75rem; box-sizing:border-box; margin-bottom:8px; height:36px; resize:none; overflow:hidden;"></textarea>
                <div style="font-weight:bold; margin-bottom:8px; color:#555; display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;">
                    <input type="checkbox" id="widget-use-tunnel-checkbox" style="margin:0; cursor:pointer;" />
                    <span>Activar túnel de xarxa (Pinggy)</span>
                </div>
                <button id="widget-save-settings-btn" style="background:#2980b9; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; width:100%; font-weight:bold; font-size:0.75rem;">Desa</button>
            </div>
            <div id="widget-qr-container" style="background:#f9f9f9; padding:8px; border-radius:8px; border:1px solid #eee; display:flex; justify-content:center; align-items:center; min-height:150px; min-width:150px; margin-bottom: 10px;">
                <div style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 25px; height: 25px; animation: spin 2s linear infinite;"></div>
                <style>
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                </style>
            </div>
            <div style="font-size: 0.75rem; text-align: center; color: #666; margin-bottom: 8px; line-height: 1.2;">
                Escaneja aquest codi amb el mòbil per sincronitzar-lo.
            </div>
            <div style="width: 100%; border-top: 1px solid #eee; padding-top: 8px; font-size: 0.8rem; display: flex; flex-direction: column; gap: 4px;">
                <div><strong>Sessió:</strong> <span id="widget-sid-val" style="font-family:monospace; color:#2980b9;">${sid || 'Cap (Esperant mòbil)'}</span></div>
                <div><strong>Estat:</strong> <span id="widget-status-val" style="color:#e67e22; font-weight:bold;">Inactiu</span></div>
                <button id="widget-toggle-lock-btn" style="width: 100%; padding: 6px; font-weight: bold; border-radius: 6px; cursor: pointer; border: none; display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 0.75rem; margin-top: 6px; transition: all 0.2s ease; box-sizing: border-box;">
                    🔓 Desbloquejar ordinador
                </button>
            </div>
        `;

        widget.appendChild(panel);
        widget.appendChild(minIcon);
        document.body.appendChild(widget);

        const toggleLockBtn = panel.querySelector('#widget-toggle-lock-btn');
        if (toggleLockBtn) {
            toggleLockBtn.onclick = (e) => {
                e.stopPropagation();
                togglePcLockDesktop();
            };
        }
        updateWidgetPcLockUI();

        // Accions de minimitzar/restaurar i configuració
        const minimizeBtn = panel.querySelector('#widget-minimize-btn');
        if (minimizeBtn) {
            minimizeBtn.onclick = (e) => {
                e.stopPropagation();
                panel.style.display = 'none';
                minIcon.style.display = 'flex';
            };
        }

        const settingsBtn = panel.querySelector('#widget-settings-btn');
        const settingsContainer = panel.querySelector('#widget-settings-container');
        const keyInput = panel.querySelector('#widget-gemini-key-input');
        const engineSelect = panel.querySelector('#widget-ocr-engine-select');
        const saveSettingsBtn = panel.querySelector('#widget-save-settings-btn');

        if (settingsBtn && settingsContainer && keyInput && engineSelect) {
            settingsBtn.onclick = (e) => {
                e.stopPropagation();
                if (settingsContainer.style.display === 'none') {
                    // Carreguem de nou per assegurar que està sincronitzat amb la darrera recàrrega
                    safeSendMessage({ action: 'get_api_key' }, (response) => {
                        if (response) {
                            latestGeminiApiKey = response.key || '';
                            latestOcrEngine = response.engine || 'gemini-api';
                        }
                        // Demanem l'estat del túnel al servidor
                        safeSendMessage({
                            action: 'proxy_fetch',
                            url: 'http://localhost:8080/api/tunnel'
                        }, (tunnelResp) => {
                            if (tunnelResp && tunnelResp.success) {
                                const tunnelData = typeof tunnelResp.data === 'string' ? JSON.parse(tunnelResp.data) : tunnelResp.data;
                                const tunnelCheckbox = panel.querySelector('#widget-use-tunnel-checkbox');
                                if (tunnelCheckbox) {
                                    tunnelCheckbox.checked = !!tunnelData.enabled;
                                }
                            }
                            keyInput.value = latestGeminiApiKey || '';
                            engineSelect.value = latestOcrEngine || 'gemini-api';
                            settingsContainer.style.display = 'block';
                        });
                    });
                } else {
                    settingsContainer.style.display = 'none';
                }
            };
        }

        if (saveSettingsBtn && keyInput && engineSelect && settingsContainer) {
            saveSettingsBtn.onclick = (e) => {
                e.stopPropagation();
                const newKey = (keyInput.value || '').trim();
                const newEngine = engineSelect.value;
                const useTunnel = panel.querySelector('#widget-use-tunnel-checkbox')?.checked || false;
                console.log(`[Sync Widget] Desant configuració localment: clau="${newKey.substring(0, 10)}...", motor="${newEngine}", tunnel=${useTunnel}`);

                // Guardem a chrome.storage.local a través de background.js
                safeSendMessage({
                    action: 'save_api_key',
                    key: newKey,
                    engine: newEngine
                }, (response) => {
                    if (response && response.success) {
                        console.log("[Sync Widget] ✅ Configuració desada correctament a chrome.storage.local");
                        latestGeminiApiKey = newKey;
                        latestOcrEngine = newEngine;
                        settingsContainer.style.display = 'none';

                        // Notifiquem al servidor sobre el canvi de motor i la clau d'API
                        const currentSid = sid || 'default';
                        safeSendMessage({
                            action: 'proxy_fetch',
                            url: `http://localhost:8080/api/session-state?sid=${currentSid}`,
                            options: {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ sid: currentSid, ocr_engine: newEngine, gemini_api_key: newKey })
                            }
                        });

                        // Cridem al servidor per activar/desactivar el túnel segons la selecció
                        safeSendMessage({
                            action: 'proxy_fetch',
                            url: 'http://localhost:8080/api/tunnel',
                            options: {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ enabled: useTunnel })
                            }
                        }, () => {
                            // Actualitzem el codi QR
                            refreshWidgetQr();
                        });

                    } else {
                        console.error("[Sync Widget] ❌ Error desant la configuració");
                    }
                });
            };
        }

        minIcon.onclick = () => {
            panel.style.display = 'flex';
            minIcon.style.display = 'none';
        };

        // Demanem la configuració desada a chrome.storage.local immediatament en arrencar
        safeSendMessage({ action: 'get_api_key' }, (response) => {
            if (response) {
                if (response.key) latestGeminiApiKey = response.key;
                if (response.engine) latestOcrEngine = response.engine;
            }
        });

        // Funció per demanar la IP o URL del túnel i pintar el QR
        function refreshWidgetQr() {
            const qrContainer = panel.querySelector('#widget-qr-container');
            if (qrContainer) {
                qrContainer.innerHTML = `<div style="border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 25px; height: 25px; animation: spin 2s linear infinite;"></div>`;
            }
            safeSendMessage({ action: 'proxy_fetch', url: 'http://localhost:8080/api/ip' }, (response) => {
                if (response && response.success) {
                    try {
                        const ipData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                        const localIp = ipData.ip || 'localhost';
                        const tunnelUrl = ipData.tunnel_url;

                        let mobileUrl;
                        if (tunnelUrl) {
                            let formattedTunnelUrl = tunnelUrl;
                            try {
                                const urlObj = new URL(tunnelUrl);
                                urlObj.hostname = urlObj.hostname.toUpperCase();
                                formattedTunnelUrl = urlObj.toString().replace(/\/$/, "");
                            } catch (e) {
                                formattedTunnelUrl = tunnelUrl;
                            }
                            mobileUrl = `${formattedTunnelUrl}/mobile/?api=${formattedTunnelUrl}&sid=${sid}`;
                        } else {
                            mobileUrl = `https://${localIp}:8443/mobile/?api=https://${localIp}:8443&sid=${sid}`;
                        }
                        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(mobileUrl)}`;

                        if (qrContainer) {
                            qrContainer.innerHTML = `<img src="${qrUrl}" alt="QR" style="width:150px; height:150px; display:block;" />`;
                        }
                    } catch (err) {
                        console.error("Error carregant IP per al widget QR:", err);
                    }
                }
            });
        }

        // Cridem la funció per primera vegada per pintar el QR en arrencar
        refreshWidgetQr();
    }

    function updateWidgetPcLockUI() {
        const btn = document.getElementById('widget-toggle-lock-btn');
        if (!btn) return;
        if (currentPcLocked) {
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

    function togglePcLockDesktop() {
        if (!sid) {
            console.warn("[Desktop Widget] No active session (sid is missing)");
            return;
        }
        const newLockState = !currentPcLocked;
        console.log(`[Desktop Widget] Toggling PC Lock from ${currentPcLocked} to ${newLockState}`);

        safeSendMessage({
            action: 'proxy_fetch',
            url: buildContentApiUrl('/api/set-pc-lock'),
            options: {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ locked: newLockState, sid: sid })
            }
        });
    }

    if (isDesktopPage) {
        window.addEventListener('llibreviu-state-change', (event) => {
            const stateData = event.detail;
            if (stateData && stateData.state === 'filling') {
                console.log(`[Sync] Estat filling rebut de l'esdeveniment DOM de l'app. Demanant obertura de pestanya de la intranet.`);
                safeSendMessage({ action: 'open_intranet_tab' });
            }
        });
    }

    let pairingInterval = null;
    function pollForActiveSessions() {
        if (sid) {
            if (pairingInterval) {
                clearInterval(pairingInterval);
                pairingInterval = null;
            }
            return;
        }

        safeSendMessage({
            action: 'proxy_fetch',
            url: 'http://localhost:8080/api/active-sessions?t=' + Date.now(),
            options: { cache: 'no-store' }
        }, (response) => {
            if (response && response.success && response.data) {
                try {
                    const activeSids = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                    if (Array.isArray(activeSids) && activeSids.length > 0) {
                        checkNextSid(activeSids, 0);
                    }
                } catch (e) {
                    // ignore
                }
            }
        });
    }

    function checkNextSid(activeSids, index) {
        if (sid || index >= activeSids.length) return;
        const checkSid = activeSids[index];
        safeSendMessage({
            action: 'proxy_fetch',
            url: `http://localhost:8080/api/session-state?sid=${checkSid}&state_only=true&t=${Date.now()}`,
            options: { cache: 'no-store' }
        }, (response) => {
            if (response && response.success && response.data) {
                try {
                    const stateData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                    if (!stateData.active_page_id || stateData.active_page_id === pageId) {
                        console.log(`[Pairing] S'ha trobat una sessió de mòbil lliure: ${checkSid}. Vinculant...`);
                        sid = checkSid;
                        sessionStorage.setItem('llibreviu_sid', sid);
                        safeSendMessage({ action: 'open_desktop_minimized', sid: sid });

                        const urlParams = new URLSearchParams(window.location.search);
                        urlParams.set('sid', sid);
                        window.history.replaceState({ ...history.state }, '', `${window.location.pathname}?${urlParams.toString()}`);

                        const sidValEl = document.getElementById('widget-sid-val');
                        if (sidValEl) sidValEl.innerText = sid;

                        registerActivePage();
                        startPolling();
                        return;
                    }
                } catch (e) {
                    // ignore
                }
            }
            checkNextSid(activeSids, index + 1);
        });
    }

    if (isTargetPage) {
        // Inyectem el widget flotant
        injectFloatingWidget();

        if (sid) {
            if (document.visibilityState === 'visible') {
                console.log("👁️ Inicialització: registrant pàgina com activa...");
                registerActivePage();
            }
            window.addEventListener('focus', () => {
                console.log("🎯 Finestra enfocada: registrant com a pàgina activa...");
                registerActivePage();
            });
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    console.log("👁️ Pàgina visible: registrant com a pàgina activa...");
                    registerActivePage();
                }
            });
            startPolling();
        } else {
            console.log("Waiting for mobile connection to pair...");
            const statusEl = document.getElementById('widget-status-val');
            if (statusEl) {
                statusEl.innerText = 'Esperant mòbil... 📱';
            }
            pairingInterval = setInterval(pollForActiveSessions, 1000);
            pollForActiveSessions();
        }
    }

    if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'clear_session_sid') {
                sessionStorage.removeItem('llibreviu_sid');
                sid = null;
                console.log("🧹 Llibreviu Sync: S'ha netejat el sid de sessionStorage.");
                return;
            }

            if (request.action === 'state_update') {
                const fullData = request.data;
                if (!fullData || fullData.sid !== sid) return;

                if (isTargetPage) {
                    const eligible = hasEnoughFields();

                    // Si l'estat passa a ser 'searching' o 'scanning', alliberem el formulari i netegem estats de cobertura
                    if (fullData.state === 'searching' || fullData.state === 'scanning') {
                        if (fullData.state !== lastState || fullData.version !== lastVersion) {
                            console.log(`[Message-Sync] Estat de cerca o escaneig detectat (${fullData.state}). Alliberant el formulari.`);
                            unlockForm();
                            lastState = fullData.state;
                            lastVersion = fullData.version;
                            isFirstStateCheck = true;
                            lastInjectedCover = null;

                            // Actualitzem també l'estat del widget visualment
                            const statusEl = document.getElementById('widget-status-val');
                            if (statusEl) {
                                const stateLabels = {
                                    'scanning': 'Llest per escanejar 📷',
                                    'searching': 'Cercant dades... 🔍'
                                };
                                statusEl.innerText = stateLabels[fullData.state] || 'Inactiu 💤';
                            }
                        }
                        return;
                    }

                    // Registrem aquesta pestanya de destinació com activa si té inputs (eligible) i:
                    // - O bé no hi ha cap pàgina activa registrada al servidor (e.g. reinici o reset).
                    // - O bé aquesta pestanya és la visible i no coincideix amb la registrada.
                    const isNotActiveOnServer = fullData.active_page_id !== pageId;
                    const isVisible = document.visibilityState === 'visible';
                    const shouldRegister = isTargetPage && eligible && (
                        (!fullData.active_page_id) ||
                        (isVisible && isNotActiveOnServer)
                    );

                    if (shouldRegister) {
                        console.log("[Message-Sync] Registrant aquesta pestanya com activa al servidor (motiu: visible o buida al servidor).");
                        registerActivePage();
                    }

                    const isActivePage = fullData.active_page_id === pageId;

                    // Si hi ha una sessió activa a una altra pestanya, ignorem completament l'estat i assegurem que estem desbloquejats
                    if (fullData.active_page_id && !isActivePage) {
                        unlockForm();
                        return;
                    }

                    // Si no hi ha cap pestanya activa encara i l'estat és diferent de 'filling' (per exemple, s'ha quedat en estat actiu orfe), ignorem
                    if (!fullData.active_page_id && fullData.state !== 'filling') {
                        return;
                    }

                    // Si cap pestanya no ha reclamat la sessió i estem en 'filling':
                    if (!fullData.active_page_id && fullData.state === 'filling') {
                        if (eligible) {
                            // Acceptem la sincronització en aquesta pestanya enviant la confirmació al servidor
                            console.log(`[Message-Sync] Aquesta pestanya reclama la sincronització per al llibre.`);
                            safeSendMessage({
                                action: 'proxy_fetch',
                                url: buildContentApiUrl('/api/register-active-page'),
                                options: {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ pageId: pageId, formData: fullData.formData, sid: sid })
                                }
                            }, (regResponse) => {
                                console.log(`[Message-Sync] Resposta registre de reclamació:`, regResponse);
                            });
                        }
                    }

                    // Només processem l'estat si som la pestanya activa registrada pel servidor
                    if (fullData.active_page_id === pageId) {
                        if (fullData.state !== lastState || fullData.version !== lastVersion) {
                            console.log(`[Message-Sync] Processant estat: ${fullData.state} (v${fullData.version})`);
                            lastVersion = fullData.version;
                            handleExtensionState(fullData);
                        }
                    }
                } else if (isDesktopPage) {
                    if (fullData.state !== lastState || fullData.version !== lastVersion) {
                        console.log(`[Message-Sync-Desktop] Processant estat: ${fullData.state} (v${fullData.version})`);
                        lastState = fullData.state;
                        lastVersion = fullData.version;
                    }
                }
            }
        });
    }
})();

