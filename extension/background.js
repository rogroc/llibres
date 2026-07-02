let lastStates = {};
let lastIntranetOpenTimes = {};
let lastDesktopOpenTimes = {};

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
            // Busquem si hi ha alguna pestanya de llibreviu genèrica (sense sid=) per reutilitzar-la
            const genericTab = allTabs.find(tab => {
                if (!tab.url) return false;
                const urlStr = tab.url.toLowerCase();
                return (urlStr.includes('llibreviu.org/admin/registre') || urlStr.includes('llibreviu.org/admin/registres')) && !urlStr.includes('sid=');
            });

            if (genericTab) {
                console.log(`[Background Sync] Reutilitzant pestanya genèrica per al sid ${sid}`);
                chrome.tabs.update(genericTab.id, { url: targetUrl, active: shouldFocus }, (tab) => {
                    chrome.tabs.reload(genericTab.id);
                    if (shouldFocus) {
                        chrome.windows.update(genericTab.windowId, { drawAttention: true, focused: true });
                    }
                    if (callback) callback({ success: true, opened: false });
                });
            } else {
                // Evitem obrir múltiples pestanyes en paral·lel
                const now = Date.now();
                const lastOpen = lastIntranetOpenTimes[sid] || 0;
                if (now - lastOpen < 4000) {
                    console.log(`[Background Sync] Ignorant petició d'obertura duplicada per al sid ${sid} per debounce.`);
                    if (callback) callback({ success: false, error: "Debounced" });
                    return;
                }
                lastIntranetOpenTimes[sid] = now;
                // Open new tab in the background unless shouldFocus is true
                chrome.tabs.create({ url: targetUrl, active: shouldFocus }, (tab) => {
                    if (callback) callback({ success: true, opened: true });
                });
            }
        }
    });
}

function openDesktopTab(sid, shouldFocus = false, callback) {
    if (!sid) sid = 'default';
    const targetUrl = `http://localhost:8080/desktop/?sid=${sid}`;
    chrome.tabs.query({}, (allTabs) => {
        const desktopTab = allTabs.find(tab => {
            if (!tab.url) return false;
            try {
                const u = new URL(tab.url);
                return (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.startsWith('192.168.')) &&
                       u.port === '8080' &&
                       u.pathname.startsWith('/desktop') &&
                       u.searchParams.get('sid') === sid;
            } catch (e) {
                return false;
            }
        });
        if (desktopTab) {
            if (shouldFocus) {
                chrome.tabs.update(desktopTab.id, { active: true });
                chrome.windows.update(desktopTab.windowId, { drawAttention: true, focused: true });
            }
            if (callback) callback({ success: true, opened: false });
        } else {
            const now = Date.now();
            const lastOpen = lastDesktopOpenTimes[sid] || 0;
            if (now - lastOpen < 4000) {
                if (callback) callback({ success: false, error: "Debounced" });
                return;
            }
            lastDesktopOpenTimes[sid] = now;
            // Open new tab in the background unless shouldFocus is true
            chrome.tabs.create({ url: targetUrl, active: shouldFocus }, (tab) => {
                if (callback) callback({ success: true, opened: true });
            });
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
                const err = chrome.runtime.lastError;
                chrome.tabs.update(intranetTab.id, { url: 'https://www.llibreviu.org/admin/registre/' });
            });
            console.log(`[Background Sync] [Session: ${sid}] Redirigida pestanya de la intranet a vista genèrica.`);
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
            chrome.tabs.sendMessage(intranetTab.id, { action: 'state_update', data: stateData }, (response) => {
                const err = chrome.runtime.lastError;
                if (err) {
                    // Ignore
                }
            });
        }
    });
}

async function checkServerState() {
    try {
        const activeRes = await fetch('http://localhost:8080/api/active-sessions?t=' + Date.now(), { cache: 'no-store' });
        if (activeRes.ok) {
            const activeSids = await activeRes.json();
            for (const sid of activeSids) {
                try {
                    const res = await fetch(`http://localhost:8080/api/session-state?sid=${sid}&state_only=true&t=${Date.now()}`, { cache: 'no-store' });
                    if (res.ok) {
                        const stateData = await res.json();
                        const state = stateData.state;
                        const lastState = lastStates[sid];
                        const showRequested = stateData.show_tab_requested;
                        
                        let stateChanged = (state !== lastState);
                        
                        if (stateChanged) {
                            console.log(`[Background Sync] [Session: ${sid}] State transitioned from ${lastState} to ${state}`);
                            if (state === 'done') {
                                closeIntranetTab(sid);
                            } else if (state === 'filling') {
                                console.log(`[Background Sync] [Session: ${sid}] Estat 'filling' detectat. Obrint formulari de la intranet.`);
                                openIntranetTab(sid, true);
                            }
                            lastStates[sid] = state;
                        }
                        
                        if (state === 'filling' || state === 'editing' || state === 'saving') {
                            fetch(`http://localhost:8080/api/session-state?sid=${sid}&t=${Date.now()}`, { cache: 'no-store' })
                                .then(res => res.json())
                                .then(fullData => {
                                    notifyIntranetTab(sid, fullData);
                                }).catch(err => {});
                        }
                        
                        if (showRequested) {
                            console.log(`[Background Sync] [Session: ${sid}] Show/focus requested for tab`);
                            // Reset the request flag on the server first
                            fetch(`http://localhost:8080/api/show-tab?sid=${sid}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ requested: false, sid })
                            }).catch(() => {});
                            
                            // Now focus the correct tab
                            if (state === 'filling' || state === 'editing' || state === 'saving') {
                                openIntranetTab(sid, true);
                            } else {
                                openDesktopTab(sid, true);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore per-session errors
                }
            }
        }
    } catch (e) {
        // Server might be offline, ignore
    }
}

let isAuthCheckRunning = false;
async function checkLlibreviuAuth() {
    if (isAuthCheckRunning) return;
    isAuthCheckRunning = true;
    try {
        const res = await fetch('https://www.llibreviu.org/admin/registre/', { method: 'GET', cache: 'no-store' });
        const finalUrl = res.url.toLowerCase();
        let authenticated = true;
        
        if (finalUrl.includes('/login') || res.status === 401 || res.status === 403) {
            authenticated = false;
        } else {
            const html = await res.text();
            if (html.includes('name="username"') && html.includes('name="password"')) {
                authenticated = false;
            }
        }
        
        if (!authenticated) {
            // No està autenticat. Busquem si ja tenim la pestanya de login oberta.
            chrome.tabs.query({}, (allTabs) => {
                const hasLoginTab = allTabs.some(tab => {
                    if (!tab.url) return false;
                    const urlStr = tab.url.toLowerCase();
                    return urlStr.includes('llibreviu.org/admin/registre') || urlStr.includes('llibreviu.org/admin/login');
                });
                
                // Si no hi ha cap pestanya de login oberta, l'obrim en segon pla
                if (!hasLoginTab) {
                    console.log("[Auth Check] L'usuari no està autenticat. Obrint pantalla de login de Llibreviu en segon pla.");
                    chrome.tabs.create({ url: 'https://www.llibreviu.org/admin/registre/', active: false });
                }
            });
        }
    } catch (e) {
        console.warn("[Auth Check] Error comprovant autenticació a Llibreviu:", e);
    } finally {
        isAuthCheckRunning = false;
    }
}

// Active polling every 1.5s
setInterval(checkServerState, 1500);

// Active polling for auto-reload
async function checkExtensionReload() {
    try {
        const res = await fetch('http://localhost:8080/api/should-reload?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            if (data.reload) {
                console.log("[Background Sync] Server requested extension reload. Reloading now...");
                chrome.runtime.reload();
            }
        }
    } catch (e) {
        // ignore
    }
}
setInterval(checkExtensionReload, 2000);

// Auto-reload matching tabs when the extension is updated or reloaded
chrome.runtime.onInstalled.addListener((details) => {
    console.log("[Background Sync] Extension installed/updated. Reloading Llibreviu tabs to inject updated content script...");
    chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
            if (tab.url) {
                const urlStr = tab.url.toLowerCase();
                if (urlStr.includes('llibreviu.org/admin/registre') || urlStr.includes('llibreviu.org/admin/registres')) {
                    console.log(`[Background Sync] Reloading Llibreviu tab: ${tab.id}`);
                    chrome.tabs.reload(tab.id);
                }
            }
        }
    });
});

// Comprova l'autenticació de Llibreviu deshabilitada (l'administrador l'obre manualment)
// setInterval(checkLlibreviuAuth, 10000);
// setTimeout(checkLlibreviuAuth, 2000);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'proxy_fetch') {
        const { url, options } = request;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const fetchOptions = { ...options, signal: controller.signal };
        
        fetch(url, fetchOptions)
            .then(async res => {
                clearTimeout(timeoutId);
                const contentType = res.headers.get('content-type') || '';
                let data;
                if (contentType.includes('application/json')) {
                    try {
                        data = await res.json();
                    } catch (e) {
                        data = {};
                    }
                } else {
                    data = await res.text();
                }
                sendResponse({ success: true, status: res.status, data });
            })
            .catch(err => {
                clearTimeout(timeoutId);
                sendResponse({ success: false, error: err.name === 'AbortError' ? 'Request timeout' : err.message });
            });
        return true; // Keep message channel open for async response
    }

    if (request.action === 'fetch_sync_poll') {
        const sid = request.sid || 'default';
        fetch(`http://localhost:8080/api/sync-poll?sid=${sid}`)
            .then(res => res.json())
            .then(data => sendResponse({ success: true, data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep message channel open for async response
    }
    
    if (request.action === 'fetch_image_base64') {
        fetch(request.url)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP error ${res.status} fetching cover`);
                return res.blob();
            })
            .then(blob => blob.arrayBuffer().then(buffer => {
                const bytes = new Uint8Array(buffer);
                let binary = '';
                const chunk = 8192;
                for (let i = 0; i < bytes.length; i += chunk) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
                }
                const base64 = btoa(binary);
                sendResponse({ success: true, dataUrl: `data:${blob.type || 'image/jpeg'};base64,${base64}` });
            }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep message channel open for async response
    }

    if (request.action === 'open_intranet_tab') {
        const sid = request.sid || 'default';
        openIntranetTab(sid, false, sendResponse);
        return true;
    }

    if (request.action === 'open_desktop_tab') {
        const sid = request.sid || 'default';
        openDesktopTab(sid, false, sendResponse);
        return true;
    }
});
