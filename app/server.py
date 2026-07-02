import http.server
import ssl
import subprocess
import os
import socket
import json
import threading
import time
import queue

PORT = 8080        # Desktop HTTP
PORT_HTTPS = 8443  # Mobile HTTPS

# State to pass between mobile and desktop (stored per session id in `sessions`)
sessions = {}
sessions_lock = threading.Lock()
extension_needs_reload = True

def get_session(sid):
    if not sid:
        sid = 'default'
    with sessions_lock:
        if sid not in sessions:
            sessions[sid] = {
                "state": "scanning",
                "version": 0,
                "candidates": [],
                "formData": None,
                "outcome": None,
                "active_page_id": None,
                "pc_locked": True,
                "latest_scan": None,
                "latest_camera_frame": None,
                "camera_frame_timestamp": 0,
                "latest_synced_book": None,
                "scan_queue": [],
                "queue_lock": threading.Lock(),
                "show_tab_requested": False,
                "last_mobile_seen": 0
            }
        return sessions[sid]

# Backward compatibility globals
latest_scan = None
latest_camera_frame = None
camera_frame_timestamp = 0
latest_synced_book = None
scan_queue = []
queue_lock = threading.Lock()
session_state = 'scanning'
candidate_books = []
current_form_data = None
save_outcome = None
session_id = None
active_page_id = None
pc_locked = True
state_version = 0

# SSE client queues and lock for real-time background synchronization
sse_clients = [] # holds (queue, sid)
sse_lock = threading.Lock()

def add_sse_client(sid, send_pending_scans=True):
    import time
    q = queue.Queue()
    sess = get_session(sid)
    sess["last_mobile_seen"] = time.time()
    # Send the initial state immediately on connection to keep client in sync
    initial_state = {
        "state": sess["state"],
        "version": sess["version"],
        "candidates": sess["candidates"],
        "formData": sess["formData"],
        "outcome": sess["outcome"],
        "active_page_id": sess["active_page_id"],
        "pc_locked": sess["pc_locked"]
    }
    initial_msg = f"event: state\ndata: {json.dumps(initial_state)}\n\n"
    q.put(initial_msg)
    
    if send_pending_scans:
        with sess["queue_lock"]:
            for item in sess["scan_queue"]:
                q.put(f"event: scan\ndata: {json.dumps(item)}\n\n")
                
    with sse_lock:
        sse_clients.append((q, sid))
    return q

def remove_sse_client(q):
    with sse_lock:
        sse_clients[:] = [item for item in sse_clients if item[0] is not q]

def publish_event(sid, event_type, data):
    event_msg = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
    with sse_lock:
        for q, client_sid in sse_clients:
            if client_sid == sid:
                q.put(event_msg)

def broadcast_state(sid):
    sess = get_session(sid)
    sess["version"] += 1
    
    # Broadcast to local SSE clients first (so they don't depend on external internet/ntfy.sh)
    state_payload = {
        "state": sess["state"],
        "version": sess["version"],
        "candidates": sess["candidates"],
        "formData": sess["formData"],
        "outcome": sess["outcome"],
        "active_page_id": sess["active_page_id"],
        "pc_locked": sess["pc_locked"],
        "show_tab_requested": sess.get("show_tab_requested", False)
    }
    publish_event(sid, "state", state_payload)
    
    # ntfy.sh broadcast using the sid as session_id
    try:
        import urllib.request
        url = f"https://ntfy.sh/llibreviu-sync-{sid}"
        payload = {
            "type": "state-broadcast",
            "data": {
                "state": sess["state"],
                "candidates": sess["candidates"],
                "formData": sess["formData"],
                "outcome": sess["outcome"]
            }
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        def do_post():
            try:
                with urllib.request.urlopen(req, timeout=3) as response:
                    response.read()
            except Exception:
                pass
        threading.Thread(target=do_post, daemon=True).start()
    except Exception as e:
        print("Error broadcasting state to ntfy:", e)

def perform_search_and_update(sid, data):
    import urllib.request
    import urllib.parse
    scan_type = data.get('type')
    val = data.get('value', '').strip()
    sess = get_session(sid)
    
    if scan_type == 'portada-captured':
        image_bytes = sess.get("latest_camera_frame")
        if not image_bytes:
             print("⚠️ No s'ha trobat cap captura de càmera per a la sessió.")
             sess["state"] = 'scanning'
             broadcast_state(sid)
             return
        import base64
        base64_image = base64.b64encode(image_bytes).decode('utf-8')
        apiKey = ''
        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key={apiKey}"
        
        themeOptions = sess.get("formData", {}).get("_selectOptions", {}).get("id_tema", []) if sess.get("formData") else []
        prompt = (
            "Analitza la portada d'aquest llibre. Extrau i classifica el text en un objecte JSON amb les següents claus obligatòries:\n"
            "- \"titol\" (el títol del llibre)\n"
            "- \"autor\" (el nom o noms dels autors, si n'hi ha)\n"
            "- \"editorial\" (la marca editorial o segell, si n'hi ha)\n"
        )
        if isinstance(themeOptions, list) and len(themeOptions) > 0:
            list_str = "\n".join([f"- \"{opt.get('text')}\" (valor: \"{opt.get('value')}\")" for opt in themeOptions if isinstance(opt, dict)])
            prompt += (
                "- \"id_tema\" (el valor del tema seleccionat de la llista següent)\n\n"
                "Llista de temes de Llibreviu:\n" + list_str + "\n\n"
                "Classifica el tema del llibre seleccionant el valor del tema més adient de la llista anterior. "
                "CRÍTIC: Per classificar el tema correctament, no et limitis només a les matèries o catàlegs. "
                "Has d'analitzar de forma holística el títol del llibre i el nom de l'autor. Dedueix el camp de coneixement o la professió de l'autor "
                "i la temàtica real del títol: per exemple, si l'autor és un historiador, el llibre s'ha de classificar com a 'Història' encara que "
                "el llibre tracti d'història econòmica o social (i no s'hauria de classificar com a 'Economia' o 'Sociologia').\n\n"
            )
        else:
            prompt += "- \"id_tema\" (sempre una cadena buida \"\")\n\n"
            
        prompt += "Si no es detecta o no s'està segur d'algun dels camps, deixa el seu valor com a cadena buida \"\". Retorna únicament l'objecte JSON pur, sense blocs de codi markdown ni cap altre text explicatiu."
        
        payload = {
            "contents": [
                {
                    "parts": [
                        {
                            "text": prompt
                        },
                        {
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": base64_image
                            }
                        }
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json"
            }
        }
        
        try:
            print(f"🤖 [Python OCR] Enviant captura de portada a Gemini per a la sessió {sid}...")
            req = urllib.request.Request(
                gemini_url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json'}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode('utf-8'))
                text_response = result['candidates'][0]['content']['parts'][0]['text'].strip()
                print(f"🤖 [Python OCR] Resposta de Gemini: {text_response}")
                
                # Robust extraction and normalization of JSON from response
                cleaned_val = None
                try:
                    text_clean = text_response.strip()
                    if '```' in text_clean:
                        import re
                        match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text_clean, re.DOTALL)
                        if match:
                            text_clean = match.group(1).strip()
                        else:
                            parts = text_clean.split('```')
                            for part in parts:
                                part_stripped = part.strip()
                                if part_stripped.startswith('{') and part_stripped.endswith('}'):
                                    text_clean = part_stripped
                                    break
                    
                    if not (text_clean.startswith('{') and text_clean.endswith('}')):
                        start = text_clean.find('{')
                        end = text_clean.rfind('}')
                        if start != -1 and end != -1 and end > start:
                            text_clean = text_clean[start:end+1]
                    
                    parsed = json.loads(text_clean)
                    if parsed and isinstance(parsed, dict):
                        titol = parsed.get('titol') or parsed.get('títol') or parsed.get('title') or parsed.get('Titol') or parsed.get('Títol') or parsed.get('Title') or ''
                        autor = parsed.get('autor') or parsed.get('author') or parsed.get('Autor') or parsed.get('Author') or ''
                        editorial = parsed.get('editorial') or parsed.get('publisher') or parsed.get('pub') or parsed.get('Editorial') or parsed.get('Publisher') or parsed.get('Pub') or ''
                        
                        canonical = {
                            "titol": str(titol).strip(),
                            "autor": str(autor).strip(),
                            "editorial": str(editorial).strip()
                        }
                        if 'id_tema' in parsed:
                            canonical['id_tema'] = parsed['id_tema']
                        
                        cleaned_val = json.dumps(canonical)
                except Exception as clean_err:
                    print(f"⚠️ [Python OCR] Error robust-parsing Gemini response: {clean_err}")
                
                val = cleaned_val if cleaned_val else text_response
                scan_type = 'portada'
        except Exception as e:
            print(f"⚠️ [Python OCR] Error amb l'API de Gemini: {e}")
            sess["state"] = 'scanning'
            broadcast_state(sid)
            return
    
    if scan_type == 'isbn':
        clean_isbn = val.replace('-', '').replace(' ', '')
        if not clean_isbn:
            sess["state"] = 'scanning'
            broadcast_state(sid)
            return
            
        print(f"🔍 [Python Search] Cercant ISBN: {clean_isbn} per a la sessió {sid}")
        candidates = []
        
        # 1. Cerca a Google Books
        try:
            g_url = f"https://www.googleapis.com/books/v1/volumes?q=isbn:{clean_isbn}"
            req = urllib.request.Request(g_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=5) as resp:
                g_data = json.loads(resp.read().decode('utf-8'))
                if g_data.get('totalItems', 0) > 0:
                    info = g_data['items'][0].get('volumeInfo', {})
                    gb_authors = ", ".join(info.get('authors', [])) or 'Autor desconegut'
                    gb_publisher = info.get('publisher', 'Editorial desconeguda')
                    gb_year = info.get('publishedDate', '')[:4]
                    gb_subjects = ", ".join(info.get('categories', [])) if info.get('categories') else 'No categoritzat'
                    candidates.append({
                        "key": f"/isbn/{clean_isbn}",
                        "title": info.get('title', 'Sense títol'),
                        "author_name": [gb_authors],
                        "author": gb_authors,
                        "authors": gb_authors,
                        "publisher": [gb_publisher],
                        "editorial": gb_publisher,
                        "first_publish_year": gb_year,
                        "year": gb_year,
                        "any": gb_year,
                        "publishYear": gb_year,
                        "isbn": clean_isbn,
                        "cover": info.get('imageLinks', {}).get('thumbnail', ''),
                        "matchScore": 1.0,
                        "isISBNMode": True,
                        "source": "Google Books",
                        "isBNE": False,
                        "subjects": gb_subjects
                    })
        except Exception as e:
            print(f"⚠️ [Google Books] Error: {e}")
            
        # 2. Cerca a Open Library
        try:
            ol_url = f"https://openlibrary.org/search.json?isbn={clean_isbn}&fields=key,title,author_name,first_publish_year,cover_i,publisher,isbn,subject"
            req = urllib.request.Request(ol_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=5) as resp:
                ol_data = json.loads(resp.read().decode('utf-8'))
                docs = ol_data.get('docs', [])
                for doc in docs[:2]:
                    title = doc.get('title', 'Sense títol')
                    pub = doc.get('publisher', [])
                    pub_str = pub[0] if pub else 'Editorial desconeguda'
                    cover_i = doc.get('cover_i')
                    cover_url = f"https://covers.openlibrary.org/b/id/{cover_i}-M.jpg" if cover_i else ""
                    ol_authors = ", ".join(doc.get('author_name', [])) or 'Autor desconegut'
                    ol_year = str(doc.get('first_publish_year', ''))
                    ol_subjects_list = doc.get('subject', [])
                    ol_subjects = ", ".join(ol_subjects_list[:5]) if ol_subjects_list else 'No categoritzat'
                    candidates.append({
                        "key": f"/isbn/{clean_isbn}",
                        "title": title,
                        "author_name": [ol_authors],
                        "author": ol_authors,
                        "authors": ol_authors,
                        "publisher": [pub_str],
                        "editorial": pub_str,
                        "first_publish_year": ol_year,
                        "year": ol_year,
                        "any": ol_year,
                        "publishYear": ol_year,
                        "isbn": clean_isbn,
                        "cover": cover_url,
                        "matchScore": 1.0,
                        "isISBNMode": True,
                        "source": "Open Library",
                        "isBNE": False,
                        "subjects": ol_subjects
                    })
        except Exception as e:
            print(f"⚠️ [Open Library] Error: {e}")

        # 3. Cerca a BNE
        try:
            bne_url = (
                f"https://catalogo.bne.es/primaws/rest/pub/pnxs"
                f"?blendFacetsSeparately=false&disableCache=false&getMore=0&inst=34BNE_INST"
                f"&isCDSearch=false&page_lang=es&limit=10&offset=0&pcAvailability=true"
                f"&q=any,contains,{clean_isbn},AND;rtype,exact,books"
                f"&rtaLinks=true&scope=MyInstitution&searchInFulltextUserSelection=true"
                f"&skipDelivery=Y&sort=rank&tab=LibraryCatalog&vid=34BNE_INST:CATALOGO"
            )
            req = urllib.request.Request(bne_url, headers={
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            })
            context = ssl._create_unverified_context()
            with urllib.request.urlopen(req, context=context, timeout=8) as resp:
                bne_data = json.loads(resp.read().decode('utf-8'))
                docs = bne_data.get('docs', [])
                for doc in docs[:3]:
                    display = doc.get('pnx', {}).get('display', {})
                    addata = doc.get('pnx', {}).get('addata', {})
                    
                    title = 'Llibre desconegut'
                    if display.get('title') and display['title'][0]:
                        title = display['title'][0].split('/')[0].strip()
                        
                    author_name = 'Autor desconegut'
                    if display.get('creator') and display['creator'][0]:
                        author_name = display['creator'][0].split('$$')[0].strip()
                    elif addata.get('creatorfull') and addata['creatorfull'][0]:
                        author_name = addata['creatorfull'][0].split('$$')[0].strip()
                    if author_name != 'Autor desconegut':
                        author_name = author_name.replace('1', '').replace('2', '').replace('3', '').replace('4', '').replace('5', '').replace('6', '').replace('7', '').replace('8', '').replace('9', '').replace('0', '').replace('-', '').strip()
                        if author_name.endswith(','):
                            author_name = author_name[:-1].strip()
                        if ',' in author_name:
                            parts = author_name.split(',')
                            author_name = f"{parts[1].strip()} {parts[0].strip()}"
                            
                    publisher = 'Editorial desconeguda'
                    if display.get('publisher') and display['publisher'][0]:
                        pub = display['publisher'][0].split(':')[1] if ':' in display['publisher'][0] else display['publisher'][0]
                        publisher = pub.split(',')[0].strip()
                    elif addata.get('pub') and addata['pub'][0]:
                        publisher = addata['pub'][0]
                        
                    creationdate = display.get('creationdate', ['Any desc.'])[0]
                    key = f"/bne/{doc.get('context', 'L')}/{doc.get('recordid', 'id')}"
                    
                    bne_subjects_list = []
                    if display.get('genre'):
                        for g in display['genre']:
                            bne_subjects_list.append(g.split('$$')[0].strip())
                    if display.get('subject'):
                        for s in display['subject']:
                            bne_subjects_list.append(s.split('$$')[0].strip())
                    unique_bne_subjects = []
                    for s in bne_subjects_list:
                        if s not in unique_bne_subjects:
                            unique_bne_subjects.append(s)
                    bne_subjects = ", ".join(unique_bne_subjects[:5]) if unique_bne_subjects else 'No categoritzat'

                    candidates.append({
                        "key": key,
                        "title": title,
                        "author_name": [author_name],
                        "author": author_name,
                        "authors": author_name,
                        "publisher": [publisher],
                        "editorial": publisher,
                        "year": creationdate,
                        "any": creationdate,
                        "publishYear": creationdate,
                        "isbn": clean_isbn,
                        "cover": f"https://proxy-euf.hosted.exlibrisgroup.com/exl_rewrite/syndetics.com/index.php?client=primo&isbn={clean_isbn}/lc.jpg",
                        "matchScore": 1.0,
                        "isISBNMode": True,
                        "source": "BNE",
                        "isBNE": True,
                        "subjects": bne_subjects
                    })
        except Exception as e:
            print(f"⚠️ [BNE] Error: {e}")
            
        # 4. Cerca a BNC (Biblioteca de Catalunya) si no hi ha candidats suficients
        if not candidates:
            try:
                bnc_url = (
                    f"https://bibliografiacatalana.bnc.cat/primaws/rest/pub/pnxs"
                    f"?blendFacetsSeparately=false&disableCache=false&getMore=0&inst=34CSUC_BC"
                    f"&isCDSearch=false&page_lang=ca&limit=10&offset=0&pcAvailability=true"
                    f"&q=any,contains,{clean_isbn},AND;rtype,exact,books"
                    f"&rtaLinks=true&scope=bib_cat&searchInFulltextUserSelection=true"
                    f"&skipDelivery=Y&sort=rank&tab=BIB_CAT&vid=34CSUC_BC:BIB_CAT"
                )
                req = urllib.request.Request(bnc_url, headers={
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json'
                })
                context = ssl._create_unverified_context()
                with urllib.request.urlopen(req, context=context, timeout=8) as resp:
                    bnc_data = json.loads(resp.read().decode('utf-8'))
                    docs = bnc_data.get('docs', [])
                    for doc in docs[:3]:
                        display = doc.get('pnx', {}).get('display', {})
                        addata = doc.get('pnx', {}).get('addata', {})
                        
                        title = 'Llibre desconegut'
                        if display.get('title') and display['title'][0]:
                            title = display['title'][0].split('/')[0].strip()
                            
                        author_name = 'Autor desconegut'
                        if display.get('creator') and display['creator'][0]:
                            author_name = display['creator'][0].split('$$')[0].strip()
                        elif addata.get('creatorfull') and addata['creatorfull'][0]:
                            author_name = addata['creatorfull'][0].split('$$')[0].strip()
                        if author_name != 'Autor desconegut':
                            author_name = author_name.replace('1', '').replace('2', '').replace('3', '').replace('4', '').replace('5', '').replace('6', '').replace('7', '').replace('8', '').replace('9', '').replace('0', '').replace('-', '').strip()
                            if author_name.endswith(','):
                                author_name = author_name[:-1].strip()
                            if ',' in author_name:
                                parts = author_name.split(',')
                                author_name = f"{parts[1].strip()} {parts[0].strip()}"
                                
                        publisher = 'Editorial desconeguda'
                        if display.get('publisher') and display['publisher'][0]:
                            pub = display['publisher'][0].split(':')[1] if ':' in display['publisher'][0] else display['publisher'][0]
                            publisher = pub.split(',')[0].strip()
                        elif addata.get('pub') and addata['pub'][0]:
                            publisher = addata['pub'][0]
                            
                        creationdate = display.get('creationdate', ['Any desc.'])[0]
                        key = f"/bnc/{doc.get('context', 'L')}/{doc.get('recordid', 'id')}"
                        
                        bnc_subjects_list = []
                        if display.get('genre'):
                            for g in display['genre']:
                                bnc_subjects_list.append(g.split('$$')[0].strip())
                        if display.get('subject'):
                            for s in display['subject']:
                                bnc_subjects_list.append(s.split('$$')[0].strip())
                        unique_bnc_subjects = []
                        for s in bnc_subjects_list:
                            if s not in unique_bnc_subjects:
                                unique_bnc_subjects.append(s)
                        bnc_subjects = ", ".join(unique_bnc_subjects[:5]) if unique_bnc_subjects else 'No categoritzat'

                        bnc_isbn = ""
                        if addata.get('isbn') and addata['isbn'][0]:
                            bnc_isbn = addata['isbn'][0].replace('-', '').strip()
                        if not bnc_isbn:
                            bnc_isbn = clean_isbn

                        candidates.append({
                            "key": key,
                            "title": title,
                            "author_name": [author_name],
                            "author": author_name,
                            "authors": author_name,
                            "publisher": [publisher],
                            "editorial": publisher,
                            "first_publish_year": creationdate,
                            "year": creationdate,
                            "any": creationdate,
                            "publishYear": creationdate,
                            "isbn": bnc_isbn,
                            "cover": f"https://proxy-euf.hosted.exlibrisgroup.com/exl_rewrite/syndetics.com/index.php?client=primo&isbn={bnc_isbn}/lc.jpg",
                            "matchScore": 1.0,
                            "isISBNMode": True,
                            "source": "BNC",
                            "isBNE": True,  # Tractat com BNE/BNC
                            "subjects": bnc_subjects
                        })
            except Exception as e:
                print(f"⚠️ [BNC] Error: {e}")

        seen_titles = set()
        unique_candidates = []
        for c in candidates:
            t_norm = c["title"].lower().strip()
            if t_norm not in seen_titles:
                seen_titles.add(t_norm)
                unique_candidates.append(c)
                
        sess["candidates"] = unique_candidates
        sess["state"] = 'selection'
        print(f"✅ [Python Search] S'han trobat {len(unique_candidates)} candidats per al sid {sid}")
        broadcast_state(sid)
        
    elif scan_type == 'portada':
        def calculate_overlap_score(book, ocr_text_raw):
            text_to_match = ocr_text_raw
            try:
                if ocr_text_raw.strip().startswith('{'):
                    parsed = json.loads(ocr_text_raw)
                    if parsed and isinstance(parsed, dict):
                        t = parsed.get('titol') or parsed.get('títol') or parsed.get('title') or ''
                        a = parsed.get('autor') or parsed.get('author') or ''
                        e = parsed.get('editorial') or parsed.get('publisher') or ''
                        text_to_match = " ".join([x for x in [t, a, e] if x])
            except Exception:
                pass
                
            import re
            def get_clean_words(txt):
                txt_clean = txt.lower()
                txt_clean = re.sub(r'[^\w\sàéèíóòúüçñ]', ' ', txt_clean)
                return set([w for w in txt_clean.split() if len(w) > 1])
                
            ocr_words = get_clean_words(text_to_match)
            
            title_words = get_clean_words(book.get('title', ''))
            title_matches = sum(1 for w in title_words if w in ocr_words)
            title_score = title_matches / len(title_words) if title_words else 0.0
            
            author_name_list = book.get('author_name', [])
            author_str = author_name_list[0] if author_name_list else (book.get('author') or book.get('authors') or '')
            author_words = get_clean_words(author_str)
            author_matches = sum(1 for w in author_words if w in ocr_words)
            author_score = author_matches / len(author_words) if author_words else 0.0
            
            return (title_score * 0.6) + (author_score * 0.4)

        query_title = ''
        query_author = ''
        query_pub = ''
        is_structured = False
        
        try:
            val_clean = val.strip()
            if '```' in val_clean:
                import re
                match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', val_clean, re.DOTALL)
                if match:
                    val_clean = match.group(1).strip()
                else:
                    parts = val_clean.split('```')
                    for part in parts:
                        part_stripped = part.strip()
                        if part_stripped.startswith('{') and part_stripped.endswith('}'):
                            val_clean = part_stripped
                            break
            
            if not (val_clean.startswith('{') and val_clean.endswith('}')):
                start = val_clean.find('{')
                end = val_clean.rfind('}')
                if start != -1 and end != -1 and end > start:
                    val_clean = val_clean[start:end+1]
                    
            if val_clean.startswith('{'):
                parsed = json.loads(val_clean)
                query_title = (parsed.get('titol') or parsed.get('títol') or parsed.get('title') or parsed.get('Titol') or parsed.get('Títol') or parsed.get('Title') or '').strip()
                query_author = (parsed.get('autor') or parsed.get('author') or parsed.get('Autor') or parsed.get('Author') or '').strip()
                query_pub = (parsed.get('editorial') or parsed.get('publisher') or parsed.get('pub') or parsed.get('Editorial') or parsed.get('Publisher') or parsed.get('Pub') or '').strip()
                if query_title or query_author or query_pub:
                    is_structured = True
        except Exception as e:
            print(f"⚠️ Error parsing scan_type 'portada' json: {e}")
            
        print(f"🔍 [Python Search] Cercant text/portada: {val[:80]}... per a la sessió {sid}")
        
        # Normalització d'artefactes
        normalized_text = val
        if is_structured:
            combined = " ".join([x for x in [query_title, query_author, query_pub] if x])
            normalized_text = combined
        else:
            import re
            normalized_text = val.replace('ufia', 'uña').replace('fio', 'ño').replace('fia', 'ña').replace('iriba', 'i riba').replace('rba', 'riba')
            normalized_text = re.sub(r"ll['’]?imperí?", "i l'imperi", normalized_text)
            normalized_text = re.sub(r"il['’]?imperí?", "i l'imperi", normalized_text)
            normalized_text = re.sub(r"l['’]?imperí?", "l'imperi", normalized_text)
            
        import re
        clean_text = normalized_text.lower()
        clean_text = re.sub(r'[^\w\sàéèíóòúüçñ]', ' ', clean_text)
        ocr_words_list = clean_text.split()
        stopwords = {'el', 'la', 'els', 'les', 'un', 'una', 'de', 'del', 'i', 'a', 'en', 'per', 'amb', 'y', 'los', 'las', 'para', 'con', 'the', 'of', 'and', 'in', 'for'}
        keywords = [w for w in ocr_words_list if w not in stopwords and len(w) > 2]
        
        api_keywords = keywords[:8]
        candidates = []
        
        if len(keywords) > 0:
            docs = []
            
            def fetch_json(url):
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
                try:
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        return json.loads(resp.read().decode('utf-8'))
                except Exception as e:
                    print(f"⚠️ [Python Search] Error fetching {url}: {e}")
                    return None

            if is_structured:
                params = []
                if query_title:
                    params.append(f"title={urllib.parse.quote(query_title)}")
                if query_author:
                    params.append(f"author={urllib.parse.quote(query_author)}")
                if query_pub:
                    params.append(f"publisher={urllib.parse.quote(query_pub)}")
                url = f"https://openlibrary.org/search.json?{('&').join(params)}&fields=key,title,author_name,first_publish_year,cover_i,publisher,isbn,subject&limit=30"
                res = fetch_json(url)
                if res:
                    docs = res.get('docs', [])
                    
                if not docs:
                    and_query = "+".join(api_keywords)
                    url = f"https://openlibrary.org/search.json?q={and_query}&fields=key,title,author_name,first_publish_year,cover_i,publisher,isbn,subject&limit=30"
                    res = fetch_json(url)
                    if res:
                        docs = res.get('docs', [])
            else:
                and_query = "+".join(api_keywords)
                url = f"https://openlibrary.org/search.json?q={and_query}&fields=key,title,author_name,first_publish_year,cover_i,publisher,isbn,subject&limit=30"
                res = fetch_json(url)
                if res:
                    docs = res.get('docs', [])
                    
            if not docs:
                or_query = "+OR+".join(api_keywords)
                url = f"https://openlibrary.org/search.json?q={or_query}&fields=key,title,author_name,first_publish_year,cover_i,publisher,isbn,subject&limit=30"
                res = fetch_json(url)
                if res:
                    docs = res.get('docs', [])
            
            for doc in docs:
                title = doc.get('title', 'Sense títol')
                pub = doc.get('publisher', [])
                pub_str = pub[0] if pub else 'Editorial desconeguda'
                cover_i = doc.get('cover_i')
                cover_url = f"https://covers.openlibrary.org/b/id/{cover_i}-M.jpg" if cover_i else ""
                isbn_list = doc.get('isbn', [])
                clean_isbn = isbn_list[0] if isbn_list else ''
                ol_authors = ", ".join(doc.get('author_name', [])) or 'Autor desconegut'
                ol_year = str(doc.get('first_publish_year', ''))
                ol_subjects_list = doc.get('subject', [])
                ol_subjects = ", ".join(ol_subjects_list[:5]) if ol_subjects_list else 'No categoritzat'
                
                cand = {
                    "key": doc.get('key', f"/ol/{title}"),
                    "title": title,
                    "author_name": doc.get('author_name', [ol_authors]),
                    "author": ol_authors,
                    "authors": ol_authors,
                    "publisher": doc.get('publisher', [pub_str]),
                    "editorial": pub_str,
                    "first_publish_year": ol_year,
                    "year": ol_year,
                    "any": ol_year,
                    "publishYear": ol_year,
                    "isbn": clean_isbn,
                    "cover": cover_url,
                    "isISBNMode": False,
                    "source": "Open Library",
                    "isBNE": False,
                    "subjects": ol_subjects
                }
                cand["matchScore"] = calculate_overlap_score(cand, val)
                candidates.append(cand)
                
            max_ol_score = max([c["matchScore"] for c in candidates]) if candidates else 0.0
            
            if max_ol_score < 0.99:
                try:
                    bne_query = " OR ".join(api_keywords)
                    bne_url = (
                        f"https://catalogo.bne.es/primaws/rest/pub/pnxs"
                        f"?blendFacetsSeparately=false&disableCache=false&getMore=0&inst=34BNE_INST"
                        f"&isCDSearch=false&page_lang=es&limit=15&offset=0&pcAvailability=true"
                        f"&q=any,contains,{urllib.parse.quote(bne_query)},AND;rtype,exact,books"
                        f"&rtaLinks=true&scope=MyInstitution&searchInFulltextUserSelection=true"
                        f"&skipDelivery=Y&sort=rank&tab=LibraryCatalog&vid=34BNE_INST:CATALOGO"
                    )
                    req = urllib.request.Request(bne_url, headers={
                        'User-Agent': 'Mozilla/5.0',
                        'Accept': 'application/json'
                    })
                    context = ssl._create_unverified_context()
                    with urllib.request.urlopen(req, context=context, timeout=8) as resp:
                        bne_data = json.loads(resp.read().decode('utf-8'))
                        docs_bne = bne_data.get('docs', [])
                        for doc in docs_bne[:10]:
                            display = doc.get('pnx', {}).get('display', {})
                            addata = doc.get('pnx', {}).get('addata', {})
                            
                            title = 'Llibre desconegut'
                            if display.get('title') and display['title'][0]:
                                title = display['title'][0].split('/')[0].strip()
                                
                            author_name = 'Autor desconegut'
                            if display.get('creator') and display['creator'][0]:
                                author_name = display['creator'][0].split('$$')[0].strip()
                            elif addata.get('creatorfull') and addata['creatorfull'][0]:
                                author_name = addata['creatorfull'][0].split('$$')[0].strip()
                            if author_name != 'Autor desconegut':
                                author_name = author_name.replace('1', '').replace('2', '').replace('3', '').replace('4', '').replace('5', '').replace('6', '').replace('7', '').replace('8', '').replace('9', '').replace('0', '').replace('-', '').strip()
                                if author_name.endswith(','):
                                    author_name = author_name[:-1].strip()
                                if ',' in author_name:
                                    parts = author_name.split(',')
                                    author_name = f"{parts[1].strip()} {parts[0].strip()}"
                                    
                            publisher = 'Editorial desconeguda'
                            if display.get('publisher') and display['publisher'][0]:
                                pub = display['publisher'][0].split(':')[1] if ':' in display['publisher'][0] else display['publisher'][0]
                                publisher = pub.split(',')[0].strip()
                            elif addata.get('pub') and addata['pub'][0]:
                                publisher = addata['pub'][0]
                                
                            creationdate = display.get('creationdate', ['Any desc.'])[0]
                            key = f"/bne/{doc.get('context', 'L')}/{doc.get('recordid', 'id')}"
                            
                            bne_subjects_list = []
                            if display.get('genre'):
                                for g in display['genre']:
                                    bne_subjects_list.append(g.split('$$')[0].strip())
                            if display.get('subject'):
                                for s in display['subject']:
                                    bne_subjects_list.append(s.split('$$')[0].strip())
                            unique_bne_subjects = []
                            for s in bne_subjects_list:
                                if s not in unique_bne_subjects:
                                    unique_bne_subjects.append(s)
                            bne_subjects = ", ".join(unique_bne_subjects[:5]) if unique_bne_subjects else 'No categoritzat'
                            bne_isbn = ""
                            if addata.get('isbn') and addata['isbn'][0]:
                                bne_isbn = addata['isbn'][0].replace('-', '').strip()
                            
                            cover_url = ""
                            if bne_isbn:
                                cover_url = f"https://proxy-euf.hosted.exlibrisgroup.com/exl_rewrite/syndetics.com/index.php?client=primo&isbn={bne_isbn}/lc.jpg"
                            
                            cand_bne = {
                                "key": key,
                                "title": title,
                                "author_name": [author_name],
                                "author": author_name,
                                "authors": author_name,
                                "publisher": [publisher],
                                "editorial": publisher,
                                "first_publish_year": creationdate,
                                "year": creationdate,
                                "any": creationdate,
                                "publishYear": creationdate,
                                "isbn": bne_isbn,
                                "cover": cover_url,
                                "isISBNMode": False,
                                "source": "BNE",
                                "isBNE": True,
                                "subjects": bne_subjects
                            }
                            cand_bne["matchScore"] = calculate_overlap_score(cand_bne, val)
                            candidates.append(cand_bne)
                except Exception as e_bne:
                    print(f"⚠️ [BNE Fallback Search] Error: {e_bne}")

        # 4. Cerca a BNC (Biblioteca de Catalunya) si els resultats de BNE i OL no són suficients o són dolents
        has_good_results = False
        if candidates:
            best_score = max(c.get("matchScore", 0.0) for c in candidates)
            if best_score >= 0.55:
                has_good_results = True
                
        if not has_good_results:
            print("[BNC Fallback Search] Els resultats de BNE/OL no són bons o no hi ha candidats. Buscant a BNC...")
            try:
                bnc_query = " OR ".join(api_keywords)
                bnc_url = (
                    f"https://bibliografiacatalana.bnc.cat/primaws/rest/pub/pnxs"
                    f"?blendFacetsSeparately=false&disableCache=false&getMore=0&inst=34CSUC_BC"
                    f"&isCDSearch=false&page_lang=ca&limit=15&offset=0&pcAvailability=true"
                    f"&q=any,contains,{urllib.parse.quote(bnc_query)},AND;rtype,exact,books"
                    f"&rtaLinks=true&scope=bib_cat&searchInFulltextUserSelection=true"
                    f"&skipDelivery=Y&sort=rank&tab=BIB_CAT&vid=34CSUC_BC:BIB_CAT"
                )
                req = urllib.request.Request(bnc_url, headers={
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json'
                })
                context = ssl._create_unverified_context()
                with urllib.request.urlopen(req, context=context, timeout=8) as resp:
                    bnc_data = json.loads(resp.read().decode('utf-8'))
                    docs_bnc = bnc_data.get('docs', [])
                    for doc in docs_bnc[:10]:
                        display = doc.get('pnx', {}).get('display', {})
                        addata = doc.get('pnx', {}).get('addata', {})
                        
                        title = 'Llibre desconegut'
                        if display.get('title') and display['title'][0]:
                            title = display['title'][0].split('/')[0].strip()
                            
                        author_name = 'Autor desconegut'
                        if display.get('creator') and display['creator'][0]:
                            author_name = display['creator'][0].split('$$')[0].strip()
                        elif addata.get('creatorfull') and addata['creatorfull'][0]:
                            author_name = addata['creatorfull'][0].split('$$')[0].strip()
                        if author_name != 'Autor desconegut':
                            author_name = author_name.replace('1', '').replace('2', '').replace('3', '').replace('4', '').replace('5', '').replace('6', '').replace('7', '').replace('8', '').replace('9', '').replace('0', '').replace('-', '').strip()
                            if author_name.endswith(','):
                                author_name = author_name[:-1].strip()
                            if ',' in author_name:
                                parts = author_name.split(',')
                                author_name = f"{parts[1].strip()} {parts[0].strip()}"
                                
                        publisher = 'Editorial desconeguda'
                        if display.get('publisher') and display['publisher'][0]:
                            pub = display['publisher'][0].split(':')[1] if ':' in display['publisher'][0] else display['publisher'][0]
                            publisher = pub.split(',')[0].strip()
                        elif addata.get('pub') and addata['pub'][0]:
                            publisher = addata['pub'][0]
                            
                        creationdate = display.get('creationdate', ['Any desc.'])[0]
                        key = f"/bnc/{doc.get('context', 'L')}/{doc.get('recordid', 'id')}"
                        
                        bnc_subjects_list = []
                        if display.get('genre'):
                            for g in display['genre']:
                                bnc_subjects_list.append(g.split('$$')[0].strip())
                        if display.get('subject'):
                            for s in display['subject']:
                                bnc_subjects_list.append(s.split('$$')[0].strip())
                        unique_bnc_subjects = []
                        for s in bnc_subjects_list:
                            if s not in unique_bnc_subjects:
                                unique_bnc_subjects.append(s)
                        bnc_subjects = ", ".join(unique_bnc_subjects[:5]) if unique_bnc_subjects else 'No categoritzat'
                        
                        bnc_isbn = ""
                        if addata.get('isbn') and addata['isbn'][0]:
                            bnc_isbn = addata['isbn'][0].replace('-', '').strip()
                        
                        cover_url = ""
                        if bnc_isbn:
                            cover_url = f"https://proxy-euf.hosted.exlibrisgroup.com/exl_rewrite/syndetics.com/index.php?client=primo&isbn={bnc_isbn}/lc.jpg"
                        
                        cand_bnc = {
                            "key": key,
                            "title": title,
                            "author_name": [author_name],
                            "author": author_name,
                            "authors": author_name,
                            "publisher": [publisher],
                            "editorial": publisher,
                            "first_publish_year": creationdate,
                            "year": creationdate,
                            "any": creationdate,
                            "publishYear": creationdate,
                            "isbn": bnc_isbn,
                            "cover": cover_url,
                            "isISBNMode": False,
                            "source": "BNC",
                            "isBNE": True,  # Tractat com BNE/BNC per a la interfície
                            "subjects": bnc_subjects
                        }
                        cand_bnc["matchScore"] = calculate_overlap_score(cand_bnc, val)
                        candidates.append(cand_bnc)
            except Exception as e_bnc:
                print(f"⚠️ [BNC Fallback Search] Error: {e_bnc}")

        seen_titles = set()
        unique_candidates = []
        candidates.sort(key=lambda x: x.get("matchScore", 0.0), reverse=True)
        for c in candidates:
            t_norm = c["title"].lower().strip()
            if t_norm not in seen_titles:
                seen_titles.add(t_norm)
                unique_candidates.append(c)
                
        top_candidates = unique_candidates[:10]
        
        sess["candidates"] = top_candidates
        sess["state"] = 'selection'
        print(f"✅ [Python Search] S'han trobat {len(top_candidates)} candidats per al text/portada.")
        broadcast_state(sid)

def generate_ssl_certs():
    if not os.path.exists('key.pem') or not os.path.exists('cert.pem'):
        print("Generant certificat SSL auto-signat per al mòbil...")
        openssl_cmd = 'openssl'
        if os.path.exists('/usr/bin/openssl'):
            openssl_cmd = '/usr/bin/openssl'
        cmd = [
            openssl_cmd, 'req', '-new', '-x509',
            '-keyout', 'key.pem', '-out', 'cert.pem',
            '-days', '365', '-nodes',
            '-subj', '/C=ES/ST=Catalonia/L=Barcelona/O=BiblioScan/OU=Dev/CN=localhost'
        ]
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print("Certificats SSL generats correctament.")
        except Exception as e:
            print(f"Error generant certificats SSL: {e}")

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = '127.0.0.1'
    finally:
        s.close()
    return local_ip

class ThreadSecureHTTPServer(http.server.ThreadingHTTPServer):
    def __init__(self, server_address, RequestHandlerClass, ssl_context):
        super().__init__(server_address, RequestHandlerClass)
        self.ssl_context = ssl_context

def run_server():
    server_address_http  = ('0.0.0.0', PORT)
    server_address_https = ('0.0.0.0', PORT_HTTPS)
    
    class APIRequestHandler(http.server.SimpleHTTPRequestHandler):
        def setup(self):
            self.ssl_failed = False
            if hasattr(self.server, 'ssl_context') and self.server.ssl_context:
                try:
                    self.request = self.server.ssl_context.wrap_socket(self.request, server_side=True)
                except Exception as e:
                    self.ssl_failed = True
                    # Silenciem els errors de certificat no acceptat o desconnexions prematures per evitar inundar la terminal
                    err_msg = str(e).lower()
                    silent_terms = ["certificate unknown", "handshake", "violation of protocol", "eof occurred", "invalid argument", "errno 22"]
                    if not any(term in err_msg for term in silent_terms):
                        print(f"⚠️ SSL Wrap Error: {type(e).__name__} - {e}")
                    try:
                        self.request.close()
                    except Exception:
                        pass
                    return
            super().setup()

        def handle(self):
            if getattr(self, 'ssl_failed', False):
                return
            try:
                super().handle()
            except BrokenPipeError:
                pass  # Client ha tancat la connexió abans de rebre la resposta
            except ConnectionResetError:
                pass

        def finish(self):
            if hasattr(self, 'wfile') and self.wfile:
                try:
                    super().finish()
                except Exception:
                    pass
            else:
                try:
                    self.request.close()
                except Exception:
                    pass

        def log_message(self, format, *args):
            # Silenciem els logs HTTP per reduir soroll (BrokenPipe, polls, etc.)
            # Descomenta la línia següent si vols veure tots els accessos:
            # super().log_message(format, *args)
            pass

        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            super().end_headers()

        def do_OPTIONS(self):
            self.send_response(200)
            self.end_headers()

        def do_POST(self):
            from urllib.parse import parse_qs, urlparse
            query_components = parse_qs(urlparse(self.path).query)
            sid = query_components.get('sid', [None])[0]
            client = query_components.get('client', [None])[0]
            clean_path = self.path.split('?')[0]
            
            if client == 'mobile' and sid:
                sess = get_session(sid)
                sess["last_mobile_seen"] = time.time()
            
            if clean_path == '/api/camera-frame':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    payload = json.loads(post_data.decode('utf-8'))
                    img_data = payload.get('image', '')
                    if img_data.startswith('data:image'):
                        import base64
                        header, encoded = img_data.split(",", 1)
                        frame_data = base64.b64decode(encoded)
                        sess = get_session(sid)
                        sess["latest_camera_frame"] = frame_data
                        sess["camera_frame_timestamp"] = int(time.time() * 1000)
                except Exception as e:
                    print("⚠️ Error processant camera-frame base64:", e)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"ok": true}')
                return

            if clean_path == '/api/sync':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    sync_data = json.loads(post_data.decode('utf-8'))
                    req_sid = sync_data.get('sid') or sid
                    sess = get_session(req_sid)
                    sess["latest_synced_book"] = post_data
                    
                    book_data = sync_data.get('value', {})
                    sess["formData"] = book_data
                    sess["state"] = 'filling'
                    broadcast_state(req_sid)
                    
                    event_data = {
                        "type": "book-selected",
                        "book": book_data
                    }
                    with sess["queue_lock"]:
                        sess["scan_queue"].append(event_data)
                    publish_event(req_sid, "scan", event_data)
                    
                    print(f"\n  ✅ [Session: {req_sid}] Llibre sincronitzat i llest per injectar: {book_data.get('title','?')} ({book_data.get('source','?')})")
                except Exception as e:
                     print(f"❌ Error al processar /api/sync: {e}")
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"status": "success"}')
                return
            
            if clean_path == '/api/scan':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    if data.get('type') != 'desktop-log':
                        sess["last_mobile_seen"] = time.time()
                    sess["latest_scan"] = data
                    
                    # Sincronització de l'estat per al flux mòbil
                    scan_type = data.get('type')
                    if scan_type in ('isbn', 'portada', 'portada-captured'):
                        sess["state"] = 'searching'
                        sess["candidates"] = []
                        sess["formData"] = None
                        sess["outcome"] = None
                        broadcast_state(req_sid)
                        if scan_type in ('isbn', 'portada', 'portada-captured'):
                            threading.Thread(target=perform_search_and_update, args=(req_sid, data), daemon=True).start()
                    elif scan_type == 'reset':
                        sess["state"] = 'scanning'
                        sess["candidates"] = []
                        sess["formData"] = None
                        sess["outcome"] = None
                        broadcast_state(req_sid)
                        
                    if scan_type in ('isbn', 'portada', 'portada-captured', 'connection', 'reset'):
                        with sess["queue_lock"]:
                            sess["scan_queue"].append(data)
                        publish_event(req_sid, "scan", data)
                    if data['type'] != 'connection':
                        print(f"\n✅ [Session: {req_sid}] Rebut des del mòbil: {data['type']} - {str(data.get('value',''))[:50]}...")
                    
                    # Rotació del log: mantenim màxim 500 línies
                    log_path = 'mobile_logs.txt'
                    log_line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [Session: {req_sid}] {data['type']}: {data.get('value','')}\n"
                    try:
                        with open(log_path, 'a', encoding='utf-8') as f:
                            f.write(log_line)
                        with open(log_path, 'r', encoding='utf-8') as f:
                            lines = f.readlines()
                        if len(lines) > 500:
                            with open(log_path, 'w', encoding='utf-8') as f:
                                f.writelines(lines[-500:])
                    except Exception:
                        pass
                except Exception as e:
                    print("Error parsing /api/scan POST data:", e)
                    
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"status": "success"}')
                return

            if clean_path == '/api/session-state':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    if 'state' in data:
                        sess["state"] = data['state']
                        if sess["state"] == 'scanning':
                            sess["candidates"] = []
                            sess["formData"] = None
                            sess["outcome"] = None
                    broadcast_state(req_sid)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/candidates':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    sess["candidates"] = data.get('candidates', [])
                    sess["state"] = 'selection'
                    broadcast_state(req_sid)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/select-book':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    # Conservem la foto de portada capturada si existia prèviament a sess["formData"]
                    old_cover = None
                    if sess.get("formData") and isinstance(sess["formData"], dict):
                        old_cover = sess["formData"].get("_cover_image")
                    
                    # Emmagatzemem el llibre triat per passar-lo a l'extensió
                    selected_book = data.get('book', {})
                    isbn = selected_book.get('isbn')
                    cover = selected_book.get('cover')
                    
                    def is_cover_url_valid(url):
                        if not url:
                            return False
                        try:
                            import urllib.request
                            import ssl
                            req_urllib = urllib.request.Request(url, method='GET', headers={'User-Agent': 'Mozilla/5.0'})
                            context_ssl = ssl._create_unverified_context()
                            with urllib.request.urlopen(req_urllib, context=context_ssl, timeout=3) as resp:
                                if resp.status == 200:
                                    return len(resp.read()) > 1000
                                return False
                        except Exception:
                            return False

                    is_syndetics = cover and "syndetics.com" in cover
                    if isbn and (not cover or is_syndetics):
                        # Si no té portada, o si és de la BNE/BNC (té proxy de syndetics) i no és vàlida
                        if not cover or not is_cover_url_valid(cover):
                            print(f"ℹ️ [Cover Fallback] La portada de la BNE no és vàlida o no existeix per al llibre amb ISBN: {isbn}")
                            # Provem de demanar la portada a Open Library
                            ol_cover = f"https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg"
                            if is_cover_url_valid(ol_cover):
                                selected_book["cover"] = ol_cover
                                print(f"✅ [Cover Fallback] Portada recuperada d'Open Library correctament.")
                            else:
                                selected_book["cover"] = ""
                                print(f"⚠️ [Cover Fallback] Open Library tampoc té la portada.")
                                
                    sess["formData"] = selected_book
                    if old_cover:
                        sess["formData"]["_cover_image"] = old_cover
                        
                    sess["state"] = 'filling'
                    broadcast_state(req_sid)
                    
                    event_data = {
                        "type": "book-selected",
                        "book": sess["formData"]
                    }
                    # També l'afegim a la cua per a l'ordinador local en segon pla
                    with sess["queue_lock"]:
                        sess["scan_queue"].append(event_data)
                    publish_event(req_sid, "scan", event_data)
                    
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/form-ready':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    sess["formData"] = data.get('formData', {})
                    sess["state"] = 'editing'
                    if 'pageId' in data:
                        sess["active_page_id"] = data['pageId']
                    broadcast_state(req_sid)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/update-cover':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    cover_image = data.get('cover_image')
                    print(f"📸 Rebut cover-update des del mòbil (mida: {len(cover_image) if cover_image else 0} bytes)")
                    if sess["formData"] is not None:
                        sess["formData"]['_cover_image'] = cover_image
                        broadcast_state(req_sid)
                    else:
                        print("⚠️ sess['formData'] és None, s'inicialitza per desar la portada.")
                        sess["formData"] = {'_cover_image': cover_image}
                        broadcast_state(req_sid)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    print(f"❌ Error al guardar la portada actualitzada: {e}")
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/submit-form':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    sess["formData"] = data.get('formData', {})
                    sess["state"] = 'saving'
                    broadcast_state(req_sid)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/save-outcome':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    sess["outcome"] = data
                    sess["state"] = 'done'
                    broadcast_state(req_sid)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/register-active-page':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    page_id = data.get('pageId')
                    form_data = data.get('formData', {})
                    
                    # Safety Hijack Protection:
                    if sess["state"] in ('filling', 'editing', 'saving', 'done') and sess["active_page_id"] is not None and sess["active_page_id"] != page_id:
                        self.send_response(409) # Conflict
                        self.send_header('Content-Type', 'application/json; charset=utf-8')
                        self.end_headers()
                        self.wfile.write(b'{"error": "another tab is actively syncing"}')
                        return
                        
                    sess["active_page_id"] = page_id
                    sess["pc_locked"] = True # Default lock
                    
                    if sess["state"] in ('scanning', 'searching'):
                        sess["formData"] = form_data
                        # Set the state based on whether the form is empty
                        is_empty = not form_data.get('id_isbn') and not form_data.get('id_titol') and not form_data.get('id_autor')
                        if is_empty:
                            sess["state"] = 'scanning'
                        else:
                            sess["state"] = 'editing'
                        
                    broadcast_state(req_sid)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/set-pc-lock':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    req_sid = data.get('sid') or sid
                    sess = get_session(req_sid)
                    sess["pc_locked"] = data.get('locked', True)
                    print(f"🔒 [Session: {req_sid}] PC Lock toggled to: {sess['pc_locked']}")
                    broadcast_state(req_sid)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"ok": true}')
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return

            if clean_path == '/api/reset-state':
                content_length = int(self.headers.get('Content-Length', 0))
                try:
                    data = json.loads(self.rfile.read(content_length).decode('utf-8')) if content_length > 0 else {}
                except Exception:
                    data = {}
                req_sid = data.get('sid') or sid
                sess = get_session(req_sid)
                sess["state"] = 'scanning'
                sess["candidates"] = []
                sess["formData"] = None
                sess["outcome"] = None
                sess["pc_locked"] = True
                broadcast_state(req_sid)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"ok": true}')
                return

            if clean_path == '/api/show-tab':
                content_length = int(self.headers.get('Content-Length', 0))
                try:
                    data = json.loads(self.rfile.read(content_length).decode('utf-8')) if content_length > 0 else {}
                except Exception:
                    data = {}
                req_sid = data.get('sid') or sid
                sess = get_session(req_sid)
                sess["show_tab_requested"] = data.get('requested', True)
                broadcast_state(req_sid)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"ok": true}')
                return
            
            self.send_response(404)
            self.end_headers()

        def do_GET(self):
            from urllib.parse import parse_qs, urlparse
            query_components = parse_qs(urlparse(self.path).query)
            sid = query_components.get('sid', [None])[0]
            client = query_components.get('client', [None])[0]
            clean_path = self.path.split('?')[0]

            if client == 'mobile' and sid:
                sess = get_session(sid)
                sess["last_mobile_seen"] = time.time()

            if clean_path == '/api/should-reload':
                global extension_needs_reload
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                self.wfile.write(json.dumps({"reload": extension_needs_reload}).encode('utf-8'))
                extension_needs_reload = False
                return

            if clean_path == '/api/active-sessions':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                with sessions_lock:
                    active_sids = [
                        s_id for s_id, s_data in sessions.items()
                        if time.time() - s_data.get("last_mobile_seen", 0) < 10
                    ]
                self.wfile.write(json.dumps(active_sids).encode('utf-8'))
                return

            if clean_path == '/api/sse':
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
                self.send_header('Connection', 'keep-alive')
                self.end_headers()
                
                q = add_sse_client(sid)
                try:
                    while True:
                        try:
                            msg = q.get(timeout=15)
                            self.wfile.write(msg.encode('utf-8'))
                            self.wfile.flush()
                        except queue.Empty:
                            # Send a ping event to keep connection alive and update client's lastSseMessageTime
                            self.wfile.write(b"event: ping\ndata: {}\n\n")
                            self.wfile.flush()
                except (ConnectionResetError, BrokenPipeError, Exception):
                    pass
                finally:
                    remove_sse_client(q)
                return

            if clean_path == '/api/session-state':
                sess = get_session(sid)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                
                actual_sid = sid if sid else 'default'
                if 'state_only=true' in self.path:
                    self.wfile.write(json.dumps({
                        "state": sess["state"],
                        "version": sess["version"],
                        "sid": actual_sid,
                        "active_page_id": sess["active_page_id"],
                        "pc_locked": sess["pc_locked"],
                        "show_tab_requested": sess.get("show_tab_requested", False)
                    }).encode('utf-8'))
                else:
                    self.wfile.write(json.dumps({
                        "state": sess["state"],
                        "version": sess["version"],
                        "candidates": sess["candidates"],
                        "formData": sess["formData"],
                        "outcome": sess["outcome"],
                        "sid": actual_sid,
                        "active_page_id": sess["active_page_id"],
                        "pc_locked": sess["pc_locked"],
                        "show_tab_requested": sess.get("show_tab_requested", False)
                    }).encode('utf-8'))
                return

            if clean_path == '/api/camera-frame':
                sess = get_session(sid)
                if sess["latest_camera_frame"]:
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/jpeg')
                    self.send_header('Content-Length', str(len(sess["latest_camera_frame"])))
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('X-Frame-Timestamp', str(sess["camera_frame_timestamp"]))
                    self.end_headers()
                    self.wfile.write(sess["latest_camera_frame"])
                else:
                    self.send_response(204)  # No Content yet
                    self.end_headers()
                return

            if clean_path == '/api/camera-status':
                sess = get_session(sid)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                is_active = (time.time() * 1000 - sess["camera_frame_timestamp"]) < 3000  # active if frame < 3s
                self.wfile.write(json.dumps({
                    'active': is_active and sess["latest_camera_frame"] is not None,
                    'timestamp': sess["camera_frame_timestamp"]
                }).encode('utf-8'))
                return

            if clean_path == '/api/sync-poll':
                sess = get_session(sid)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                if sess["latest_synced_book"]:
                    self.wfile.write(sess["latest_synced_book"])
                    sess["latest_synced_book"] = None
                else:
                    self.wfile.write(b'{}')
                return

            if clean_path == '/api/poll':
                sess = get_session(sid)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                with sess["queue_lock"]:
                    to_send = list(sess["scan_queue"])
                    sess["scan_queue"].clear()
                    sess["latest_scan"] = None
                self.wfile.write(json.dumps(to_send).encode('utf-8'))
                return

            if clean_path == '/api/ip':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                self.wfile.write(json.dumps({"ip": get_local_ip()}).encode('utf-8'))
                return

            if clean_path.startswith('/api/bne'):
                from urllib.parse import urlparse, parse_qs
                query = parse_qs(urlparse(self.path).query)
                isbn = query.get('isbn', [''])[0]
                
                if not isbn:
                    self.send_response(400)
                    self.end_headers()
                    return
                
                try:
                    import urllib.request
                    from urllib.parse import quote
                    context = ssl._create_unverified_context()
                    isbn_encoded = quote(isbn, safe='')
                    
                    url = (
                        f"https://catalogo.bne.es/primaws/rest/pub/pnxs"
                        f"?blendFacetsSeparately=false"
                        f"&disableCache=false"
                        f"&getMore=0"
                        f"&inst=34BNE_INST"
                        f"&isCDSearch=false"
                        f"&lang=es"
                        f"&limit=30"
                        f"&newspapersActive=false"
                        f"&newspapersSearch=false"
                        f"&offset=0"
                        f"&pcAvailability=true"
                        f"&q=any,contains,{isbn_encoded},AND;rtype,exact,books"
                        f"&rtaLinks=true"
                        f"&scope=MyInstitution"
                        f"&searchInFulltextUserSelection=true"
                        f"&skipDelivery=Y"
                        f"&sort=rank"
                        f"&tab=LibraryCatalog"
                        f"&vid=34BNE_INST:CATALOGO"
                    )
                    
                    req = urllib.request.Request(url, headers={
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json'
                    })
                    resp = urllib.request.urlopen(req, context=context, timeout=15)
                    data = resp.read()
                    
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(data)
                except Exception as e:
                    self.send_response(500)
                    self.send_header('Content-Type', 'text/plain; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
                return
                
            # Allow directory redirection for cleaner URLs
            if clean_path == '/':
                self.send_response(301)
                self.send_header('Location', '/desktop/')
                self.end_headers()
                return

            super().do_GET()

        def log_message(self, format, *args):
            try:
                msg = format % args
            except Exception:
                msg = str(format)
            SILENT = (
                '/api/poll', '/api/camera-frame', '/api/camera-status', '/api/sync-poll',
                '/api/session-state', '/api/scan', '/api/register-active-page',
                '/api/form-ready', '/api/submit-form', '/api/save-outcome',
                '/api/reset-state', '/api/candidates', '/api/select-book',
                '/api/update-cover', '/api/set-pc-lock',
                'Bad request version', 'Bad HTTP/0.9 request', 'Bad request syntax',
                '\x16\x03',  # TLS ClientHello (Chrome intentant HTTPS al port HTTP)
            )
            if any(p in msg for p in SILENT):
                return
            super().log_message(format, *args)

    httpd_http = http.server.ThreadingHTTPServer(server_address_http, APIRequestHandler)
    local_ip = get_local_ip()
    generate_ssl_certs()
    httpd_https = None
    is_https = False
    
    if os.path.exists('key.pem') and os.path.exists('cert.pem'):
        try:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certfile='cert.pem', keyfile='key.pem')
            httpd_https = ThreadSecureHTTPServer(server_address_https, APIRequestHandler, context)
            is_https = True
        except Exception as e:
            print(f"No s'ha pogut iniciar el servidor HTTPS per al mòbil: {e}")
    
    print("\\n" + "="*50)
    print(" Llibreviu App — Servidor Local")
    print("="*50)
    print(f"  💻 Ordinador: http://localhost:{PORT}/desktop/")
    if is_https and local_ip != '127.0.0.1':
        print(f"  📱 Mòbil:     https://{local_ip}:{PORT_HTTPS}/mobile/")
    print("="*50)

    if httpd_https:
        t = threading.Thread(target=httpd_https.serve_forever, daemon=True)
        t.start()

    try:
        httpd_http.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if httpd_https:
            httpd_https.shutdown()

if __name__ == '__main__':
    run_server()
