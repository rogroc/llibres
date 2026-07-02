(function() {
    const hostname = window.location.hostname.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    let isTargetPage = path.includes('/admin/registre') || 
                       path.includes('/admin/registres') || 
                       (hostname === 'www.llibreviu.org' && path.startsWith('/admin/registre'));

    const isDesktopPage = (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.')) && 
                          path.startsWith('/desktop/');

    const urlParams = new URLSearchParams(window.location.search);
    let sid = urlParams.get('sid') || sessionStorage.getItem('llibreviu_sid');
    if (isTargetPage && !isDesktopPage) {
        if (urlParams.has('sid')) {
            sid = urlParams.get('sid');
            sessionStorage.setItem('llibreviu_sid', sid);
        } else if (sid && sid !== 'default') {
            urlParams.set('sid', sid);
            window.history.replaceState({ ...history.state }, '', `${window.location.pathname}?${urlParams.toString()}`);
        }
    } else {
        if (!sid) sid = 'default';
    }

    // Evitem que el navegador suspengui o alenteixi (throttle) la pestanya quan estigui en segon pla o minimitzada.
    // Això es fa generant un àudio continu silenciós mitjançant Web Audio API després de la primera interacció de l'usuari.
    let silentAudioCtx = null;
    function startSilentAudio() {
        if (silentAudioCtx) return;
        try {
            silentAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = silentAudioCtx.createOscillator();
            const gainNode = silentAudioCtx.createGain();
            gainNode.gain.value = 0; // Completament silenciós
            oscillator.connect(gainNode);
            gainNode.connect(silentAudioCtx.destination);
            oscillator.start();
            console.log("🔊 Llibreviu Sync: S'ha iniciat l'àudio de fons silenciós per mantenir activa la pestanya en segon pla.");
        } catch (e) {
            console.warn("⚠️ No s'ha pogut iniciar l'àudio silenciós de fons:", e);
        }
    }
    if (isTargetPage) {
        document.addEventListener('click', startSilentAudio, { once: true });
        document.addEventListener('keydown', startSilentAudio, { once: true });
    }

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

    console.log = function(...args) {
        originalLog.apply(console, args);
        logToServer('log', args);
    };
    console.warn = function(...args) {
        originalWarn.apply(console, args);
        logToServer('warn', args);
    };
    console.error = function(...args) {
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
                        console.log("🤖 Classificant el tema amb Gemini des de l'extensió (fallback)...");
                        const apiKey = '';
                        const classification = await classifyThemeWithGemini(book, options, apiKey);
                        if (classification && classification.value !== undefined) {
                            temaEl.value = classification.value;
                            temaEl.dispatchEvent(new Event('change', { bubbles: true }));
                            console.log(`✅ Tema seleccionat per Gemini des de l'extensió: "${classification.text}" (valor: ${classification.value})`);
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
                const apiKey = '';
                console.log("🤖 Traduint els temes al català amb Gemini...");
                const translatedSubjects = await translateSubjectsToCatalan(book.subjects, apiKey);
                obsValue += 'Temes: ' + translatedSubjects;
            }
            notesEl.value = obsValue;
            notesEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Previsualització i pujada de fitxer de portada
        if (book._cover_image) {
            await injectCoverImage(book._cover_image);
        } else if (book.cover) {
            await injectCoverImage(book.cover);
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
            } catch (e) {}
            
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

    async function handleExtensionState(sessionData) {
        const { state, formData, pc_locked } = sessionData;
        
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
        
        if (formData && formData._cover_image && formData._cover_image !== lastInjectedCover) {
            lastInjectedCover = formData._cover_image;
            console.log("📸 Nova portada rebuda des del mòbil. Injectant al formulari immediatament...");
            await injectCoverImage(formData._cover_image);
            if (!isFirstStateCheck) {
                showNotification("📸 Portada actualitzada des del mòbil!");
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
                    // Si tenim una imatge de portada capturada des del mòbil, la injectem al formulari real
                    if (formData._cover_image) {
                        lastInjectedCover = formData._cover_image;
                        await injectCoverImage(formData._cover_image);
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
            const submitBtn = document.querySelector('button[type="submit"]') || 
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

    // Realitzem el polling d'estat a través del background script (Service Worker)
    // per evitar problemes de Mixed Content (peticions HTTP des d'HTTPS) i CORS
    // a la web de producció, mentre mantenim el control a la pestanya per evitar
    // la suspensió automàtica de Manifest V3.
    async function pollSessionState() {
        if (!chrome.runtime || !chrome.runtime.id) {
            console.warn("⚠️ Llibreviu Sync: El context de l'extensió s'ha invalidat.");
            stopPolling();
            return;
        }
        
        const success = safeSendMessage({
            action: 'proxy_fetch',
            url: buildContentApiUrl('/api/session-state?state_only=true&t=' + Date.now()),
            options: { cache: 'no-store' }
        }, async (response) => {
            if (response && response.success && response.data) {
                try {
                    const stateData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                    
                    const eligible = hasEnoughFields();
                    
                    // Registrem aquesta pestanya de destinació com activa si té inputs (eligible) i:
                    // - O bé no hi ha cap pàgina activa registrada al servidor (e.g. reinici o reset).
                    // - O bé aquesta pestanya és la visible i no coincideix amb la registrada (e.g. l'usuari ha canviat de pestanya).
                    // Això soluciona el problema de haver de reiniciar o refrescar manualment la pàgina.
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
                            safeSendMessage({ action: 'open_intranet_tab', sid: sid });
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
                            const isActivePage = stateData.active_page_id === pageId;
                            
                            // Si hi ha una sessió activa a una altra pestanya, ignorem l'estat i assegurem que estem desbloquejats
                            if (stateData.active_page_id && !isActivePage) {
                                unlockForm();
                            } else if (!stateData.active_page_id && stateData.state !== 'filling') {
                                // Si no hi ha cap pestanya activa i no estem en filling, ignorem per evitar errors orfes
                            } else {
                                safeSendMessage({
                                    action: 'proxy_fetch',
                                    url: buildContentApiUrl('/api/session-state?t=' + Date.now()),
                                    options: { cache: 'no-store' }
                                }, async (detailResp) => {
                                    if (detailResp && detailResp.success && detailResp.data) {
                                        try {
                                            const fullData = typeof detailResp.data === 'string' ? JSON.parse(detailResp.data) : detailResp.data;
                                            
                                            // Si cap pestanya no ha reclamat la sessió i estem en 'filling':
                                            if (!fullData.active_page_id && fullData.state === 'filling') {
                                                if (eligible) {
                                                    // Acceptem la sincronització en aquesta pestanya enviant la confirmació al servidor
                                                    console.log(`[Sync] Aquesta pestanya reclama la sincronització per al llibre.`);
                                                    safeSendMessage({
                                                        action: 'proxy_fetch',
                                                        url: buildContentApiUrl('/api/register-active-page'),
                                                        options: {
                                                            method: 'POST',
                                                            headers: { 'Content-Type': 'application/json' },
                                                            body: JSON.stringify({ pageId: pageId, formData: fullData.formData, sid: sid })
                                                        }
                                                    }, (regResponse) => {
                                                        console.log(`[Sync] Resposta registre de reclamació:`, regResponse);
                                                    });
                                                }
                                            }
                                            
                                            // Només processem l'estat si som la pestanya activa registrada pel servidor
                                            if (fullData.active_page_id === pageId) {
                                                lastVersion = fullData.version;
                                                await handleExtensionState(fullData);
                                            }
                                        } catch (errJson) {
                                            console.error("❌ Error parsing session state detail:", errJson);
                                        }
                                    }
                                });
                            }
                        } else if (isDesktopPage) {
                            // Si és la pàgina de l'ordinador, actualitzem les variables d'estat local
                            lastState = stateData.state;
                            lastVersion = stateData.version;
                        }
                    }
                } catch (e) {
                    // ignore
                }
            }
            
            // Programem el següent poll dins de la resposta per evitar col·lisions
            pollingInterval = setTimeout(pollSessionState, 1000);
        });
        
        if (!success) {
            if (chrome.runtime && chrome.runtime.id) {
                pollingInterval = setTimeout(pollSessionState, 3000);
            }
        }
    }

    function startPolling() {
        if (pollingInterval) return;
        pollingInterval = setTimeout(pollSessionState, 1000);
        console.log("🚀 Llibreviu Sync: Polling d'estat iniciat directament al Content Script.");
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
                <span id="widget-minimize-btn" style="cursor:pointer; font-size:1.3rem; color:#888; line-height: 0.5; padding: 5px; user-select: none;" title="Minimitzar">−</span>
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
            </div>
        `;
        
        widget.appendChild(panel);
        widget.appendChild(minIcon);
        document.body.appendChild(widget);
        
        // Accions de minimitzar/restaurar
        const minimizeBtn = panel.querySelector('#widget-minimize-btn');
        if (minimizeBtn) {
            minimizeBtn.onclick = (e) => {
                e.stopPropagation();
                panel.style.display = 'none';
                minIcon.style.display = 'flex';
            };
        }
        
        minIcon.onclick = () => {
            panel.style.display = 'flex';
            minIcon.style.display = 'none';
        };
        
        // Demanem la IP local al servidor a través del background script
        safeSendMessage({ action: 'proxy_fetch', url: 'http://localhost:8080/api/ip' }, (response) => {
            if (response && response.success) {
                try {
                    const ipData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                    const localIp = ipData.ip || 'localhost';
                    
                    const mobileUrl = `https://${localIp}:8443/mobile/?api=https://${localIp}:8443`;
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(mobileUrl)}`;
                    
                    const qrContainer = panel.querySelector('#widget-qr-container');
                    if (qrContainer) {
                        qrContainer.innerHTML = `<img src="${qrUrl}" alt="QR" style="width:150px; height:150px; display:block;" />`;
                    }
                } catch (err) {
                    console.error("Error carregant IP per al widget QR:", err);
                }
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

