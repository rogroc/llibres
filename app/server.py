import http.server
import ssl
import subprocess
import os
import socket
import json
import threading
import time
import queue
import re

# Try importing RapidOCR for local PC-side PaddleOCR
try:
    from rapidocr_onnxruntime import RapidOCR
    rapid_ocr_engine = RapidOCR()
    print("✅ RapidOCR (PaddleOCR local) inicialitzat correctament a l'ordinador.")
except Exception as ocr_err:
    rapid_ocr_engine = None
    print(f"⚠️ No s'ha pogut carregar RapidOCR localment: {ocr_err}")

PORT = 8080        # Desktop HTTP
PORT_HTTPS = 8443  # Mobile HTTPS

# State to pass between mobile and desktop (stored per session id in `sessions`)
sessions = {}
sessions_lock = threading.Lock()
extension_needs_reload = True

def load_config():
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ Error loading config: {e}")
    return {}

def save_config(config):
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
    try:
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=4)
    except Exception as e:
        print(f"⚠️ Error saving config: {e}")

def get_session(sid):
    if not sid:
        sid = 'default'
    with sessions_lock:
        if sid not in sessions:
            config = load_config()
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
                "last_mobile_seen": 0,
                "gemini_api_key": config.get("gemini_api_key", os.environ.get("GEMINI_API_KEY", "")),
                "ocr_engine": config.get("ocr_engine", "gemini-api"),
                "decommission_code": "",
                "decommission_candidates": [],
                "decommission_selected_id": "",
                "decommission_status": "idle"
            }
        else:
            # Si la sessio existeix pero no te clau, la recarreguem del config
            if not sessions[sid].get("gemini_api_key"):
                config = load_config()
                saved_key = config.get("gemini_api_key", os.environ.get("GEMINI_API_KEY", ""))
                if saved_key:
                    sessions[sid]["gemini_api_key"] = saved_key
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

# Pinggy Tunnel configuration and state
global_tunnel_url = None
global_tunnel_process = None
tunnel_lock = threading.Lock()

def start_tunnel():
    global global_tunnel_url, global_tunnel_process
    with tunnel_lock:
        if global_tunnel_process is not None:
            return global_tunnel_url
        try:
            print("🚀 [Túnel] S'està iniciant el túnel Pinggy (ssh)...")
            null_device = "NUL" if os.name == 'nt' else "/dev/null"
            cmd = [
                "ssh", 
                "-o", "StrictHostKeyChecking=no", 
                "-o", f"UserKnownHostsFile={null_device}", 
                "-p", "443", 
                "-R", "0:localhost:8080", 
                "a.pinggy.io"
            ]
            global_tunnel_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.PIPE,
                text=True,
                bufsize=1
            )
            
            def read_output():
                global global_tunnel_url
                url_pattern = re.compile(r'https://[a-zA-Z0-9.-]+\.pinggy(?:-free)?\.(?:link|io|online|me|net)')
                for line in iter(global_tunnel_process.stdout.readline, ''):
                    match = url_pattern.search(line)
                    if match:
                        url = match.group(0)
                        if "dashboard.pinggy.io" in url:
                            continue
                        global_tunnel_url = url
                        print(f"🚀 [Túnel] Túnel obert amb èxit! Adreça pública: {global_tunnel_url}")
                        publish_event('global', 'tunnel_status', {"tunnel_url": global_tunnel_url})
                        break
            
            t = threading.Thread(target=read_output, daemon=True)
            t.start()
            
            # Wait up to 5 seconds for the URL to be established
            for _ in range(25):
                if global_tunnel_url:
                    break
                time.sleep(0.2)
                
            return global_tunnel_url
        except Exception as e:
            print(f"⚠️ Error al obrir el túnel: {e}")
            global_tunnel_process = None
            return None

def stop_tunnel():
    global global_tunnel_url, global_tunnel_process
    with tunnel_lock:
        if global_tunnel_process:
            print("🛑 [Túnel] Tancant túnel de xarxa...")
            try:
                global_tunnel_process.terminate()
                global_tunnel_process.wait(timeout=2)
            except Exception:
                try:
                    global_tunnel_process.kill()
                except Exception:
                    pass
            global_tunnel_process = None
            global_tunnel_url = None
            publish_event('global', 'tunnel_status', {"tunnel_url": None})


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
            if client_sid == sid or client_sid == 'global':
                q.put(event_msg)

def broadcast_state(sid):
    sess = get_session(sid)
    sess["version"] += 1
    
    # Broadcast to local SSE clients first (so they don't depend on external internet/ntfy.sh)
    state_payload = {
        "sid": sid,
        "state": sess["state"],
        "version": sess["version"],
        "candidates": sess["candidates"],
        "formData": sess["formData"],
        "outcome": sess["outcome"],
        "active_page_id": sess["active_page_id"],
        "pc_locked": sess["pc_locked"],
        "show_tab_requested": sess.get("show_tab_requested", False),
        "decommission_status": sess.get("decommission_status", "idle"),
        "decommission_code": sess.get("decommission_code", ""),
        "decommission_selected_id": sess.get("decommission_selected_id", ""),
        "decommission_candidates": sess.get("decommission_candidates", [])
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
            except ConnectionAbortedError:
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

            if clean_path == '/api/decommission/ocr-local':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                
                matched_id = None
                text_cleaned = ""
                
                try:
                    payload = json.loads(post_data.decode('utf-8'))
                    img_data = payload.get('image', '')
                    if img_data.startswith('data:image'):
                        import base64
                        header, encoded = img_data.split(",", 1)
                        frame_bytes = base64.b64decode(encoded)
                        
                        if rapid_ocr_engine is not None:
                            result, elapse = rapid_ocr_engine(frame_bytes)
                            if result:
                                texts = [item[1] for item in result if item and len(item) > 1]
                                text_cleaned = " | ".join(texts).strip()
                                print(f"[Local OCR server] Textos llegits: {text_cleaned}")
                                
                                # Aplicar la segmentació geomètrica basant-nos en el separador vertical
                                match_div = re.search(r'[|/\\lI!\[\]\-=:]', text_cleaned)
                                left_num = None
                                right_num = None
                                
                                if match_div:
                                    div_idx = match_div.start()
                                    left_sub = text_cleaned[:div_idx]
                                    right_sub = text_cleaned[div_idx+1:]
                                    
                                    left_nums = re.findall(r'\d+', left_sub)
                                    right_nums = re.findall(r'\d+', right_sub)
                                    
                                    if left_nums and right_nums:
                                        left_num = left_nums[-1]
                                        right_num = right_nums[0]
                                
                                # Fallback: dos darrers números
                                if not left_num or not right_num:
                                    all_nums = re.findall(r'\d+', text_cleaned)
                                    if len(all_nums) >= 2:
                                        left_num = all_nums[-2]
                                        right_num = all_nums[-1]
                                        
                                if left_num and right_num and len(left_num) > len(right_num) and len(left_num) >= 3:
                                    matched_id = left_num
                                    print(f"[Local OCR server] Match correcte! ID: {matched_id} > Còpia: {right_num}")
                        else:
                            print("⚠️ Motor RapidOCR no inicialitzat!")
                except Exception as e:
                    print("⚠️ Error processant ocr-local al servidor:", e)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                
                resp = {
                    "ok": True,
                    "id": matched_id,
                    "text": text_cleaned
                }
                self.wfile.write(json.dumps(resp).encode('utf-8'))
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
                    scan_type = data.get('type')
                    if data.get('type') != 'desktop-log':
                        sess["last_mobile_seen"] = time.time()
                        
                    if scan_type in ('isbn', 'portada', 'portada-captured'):
                        sess["latest_scan"] = data
                        sess["state"] = 'searching'
                        sess["candidates"] = []
                        sess["formData"] = None
                        sess["outcome"] = None
                        broadcast_state(req_sid)
                    elif scan_type == 'reset':
                        sess["latest_scan"] = None
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
                    config_changed = False
                    config = load_config()
                    if 'gemini_api_key' in data:
                        posted_key = str(data['gemini_api_key']).strip()
                        # Sempre actualitzem la clau (tant si està informada com si la volem buidar)
                        sess["gemini_api_key"] = posted_key
                        config["gemini_api_key"] = posted_key
                        config_changed = True
                        # Actualitzem tambe totes les altres sessions actives
                        with sessions_lock:
                            for other_sid, other_sess in sessions.items():
                                other_sess["gemini_api_key"] = posted_key
                        print(f"[Config] Clau API actualitzada per a totes les sessions (longitud: {len(posted_key)})")
                    if 'ocr_engine' in data:
                        sess["ocr_engine"] = data['ocr_engine']
                        config["ocr_engine"] = sess["ocr_engine"]
                        config_changed = True
                    if config_changed:
                        save_config(config)
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

                    def fetch_bookfinder_cover(isbn_val):
                        if not isbn_val:
                            return None
                        try:
                            import urllib.request
                            import re
                            import ssl
                            url = f"https://www.bookfinder.com/isbn/{isbn_val}"
                            req_urllib = urllib.request.Request(
                                url, 
                                headers={
                                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                                    'Accept-Language': 'en-US,en;q=0.5'
                                }
                            )
                            context_ssl = ssl._create_unverified_context()
                            with urllib.request.urlopen(req_urllib, context=context_ssl, timeout=4) as response:
                                html = response.read().decode('utf-8', errors='ignore')
                                match = re.search(r'itemprop="image"\s+src="([^"]+)"', html)
                                if match:
                                    return match.group(1)
                                match = re.search(r'id="coverImage"\s+src="([^"]+)"', html)
                                if match:
                                    return match.group(1)
                                img_srcs = re.findall(r'<img[^>]+src="([^"]+)"', html)
                                for src in img_srcs:
                                    if 'cover' in src.lower() or 'isbn' in src.lower() or isbn_val in src:
                                        return src
                        except Exception as e:
                            print(f"⚠️ [BookFinder Scraper] Error scraping BookFinder for {isbn_val}: {e}")
                        return None

                    if isbn and (not cover or not is_cover_url_valid(cover)):
                        # Si no té portada o no és vàlida (inclosos els genèrics buits)
                        if True:
                            print(f"ℹ️ [Cover Fallback] La portada de la BNE no és vàlida o no existeix per al llibre amb ISBN: {isbn}")
                            
                            # 1. Provem de demanar la portada a Open Library
                            ol_cover = f"https://covers.openlibrary.org/b/isbn/{isbn}-M.jpg"
                            if is_cover_url_valid(ol_cover):
                                selected_book["cover"] = ol_cover
                                print(f"✅ [Cover Fallback] Portada recuperada d'Open Library correctament.")
                            else:
                                # 2. Provem imatge directa d'AbeBooks (utilitzada per BookFinder)
                                ab_cover = f"https://pictures.abebooks.com/isbn/{isbn}-us.jpg"
                                if is_cover_url_valid(ab_cover):
                                    selected_book["cover"] = ab_cover
                                    print(f"✅ [Cover Fallback] Portada recuperada d'AbeBooks correctament.")
                                else:
                                    # 3. Provem de raspar la pàgina de BookFinder
                                    bf_cover = fetch_bookfinder_cover(isbn)
                                    if bf_cover and is_cover_url_valid(bf_cover):
                                        selected_book["cover"] = bf_cover
                                        print(f"✅ [Cover Fallback] Portada recuperada de BookFinder correctament.")
                                    else:
                                        selected_book["cover"] = ""
                                        print(f"⚠️ [Cover Fallback] Cap font externa de portada ha funcionat per a l'ISBN: {isbn}")
                                
                    sess["formData"] = selected_book
                    
                    latest_scan = sess.get("latest_scan")
                    # Només injectem la foto o restaurem la portada prèvia si el llibre triat NO té portada de catàleg
                    has_catalog_cover = bool(sess["formData"].get("cover"))
                    if not has_catalog_cover:
                        if latest_scan and latest_scan.get("type") == "portada-captured" and sess.get("latest_camera_frame"):
                            import base64
                            b64_img = base64.b64encode(sess["latest_camera_frame"]).decode('utf-8')
                            sess["formData"]["_cover_image"] = f"data:image/jpeg;base64,{b64_img}"
                        elif old_cover:
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
                        if is_empty and sess["state"] != 'searching':
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

            if clean_path in ('/api/decommission/search', '/api/decommission/candidates', '/api/decommission/select', '/api/decommission/confirm', '/api/decommission/done', '/api/decommission/reset'):
                content_length = int(self.headers.get('Content-Length', 0))
                try:
                    data = json.loads(self.rfile.read(content_length).decode('utf-8')) if content_length > 0 else {}
                except Exception:
                    data = {}
                req_sid = data.get('sid') or sid
                sess = get_session(req_sid)
                
                if clean_path == '/api/decommission/search':
                    sess["decommission_code"] = str(data.get('code', '')).strip()
                    sess["decommission_candidates"] = []
                    sess["decommission_selected_id"] = ""
                    sess["decommission_status"] = "searching"
                    sess["version"] += 1
                elif clean_path == '/api/decommission/candidates':
                    sess["decommission_candidates"] = data.get('candidates', [])
                    sess["decommission_status"] = "found"
                    sess["version"] += 1
                elif clean_path == '/api/decommission/select':
                    sess["decommission_selected_id"] = str(data.get('id', '')).strip()
                    sess["decommission_status"] = "confirming"
                    sess["version"] += 1
                elif clean_path == '/api/decommission/confirm':
                    sess["decommission_status"] = "decommissioning"
                    sess["version"] += 1
                elif clean_path == '/api/decommission/done':
                    sess["decommission_status"] = "done"
                    sess["version"] += 1
                elif clean_path == '/api/decommission/reset':
                    sess["decommission_code"] = ""
                    sess["decommission_candidates"] = []
                    sess["decommission_selected_id"] = ""
                    sess["decommission_status"] = "idle"
                    sess["version"] += 1
                    
                broadcast_state(req_sid)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"ok": true}')
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
            
            if clean_path == '/api/log':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"status": "success"}')
                return

            if clean_path == '/api/tunnel':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    enable = data.get('enabled', False)
                    if enable:
                        url = start_tunnel()
                        status = "success" if url else "error"
                    else:
                        stop_tunnel()
                        url = None
                        status = "success"
                    
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(json.dumps({"status": status, "tunnel_url": url}).encode('utf-8'))
                except Exception as e:
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(str(e).encode('utf-8'))
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
                env_key = os.environ.get("GEMINI_API_KEY", "")
                sess_key = sess.get("gemini_api_key", "")
                final_key = sess_key if sess_key else env_key

                if 'state_only=true' in self.path:
                    self.wfile.write(json.dumps({
                        "state": sess["state"],
                        "version": sess["version"],
                        "sid": actual_sid,
                        "active_page_id": sess["active_page_id"],
                        "pc_locked": sess["pc_locked"],
                        "show_tab_requested": sess.get("show_tab_requested", False),
                        "gemini_api_key": final_key,
                        "ocr_engine": sess.get("ocr_engine", "gemini-api"),
                        "latest_scan": sess.get("latest_scan", None),
                        "decommission_code": sess.get("decommission_code", ""),
                        "decommission_selected_id": sess.get("decommission_selected_id", ""),
                        "decommission_status": sess.get("decommission_status", "idle")
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
                        "show_tab_requested": sess.get("show_tab_requested", False),
                        "gemini_api_key": final_key,
                        "ocr_engine": sess.get("ocr_engine", "gemini-api"),
                        "latest_scan": sess.get("latest_scan", None),
                        "decommission_code": sess.get("decommission_code", ""),
                        "decommission_candidates": sess.get("decommission_candidates", []),
                        "decommission_selected_id": sess.get("decommission_selected_id", ""),
                        "decommission_status": sess.get("decommission_status", "idle")
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

            if clean_path == '/api/tunnel':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "enabled": global_tunnel_process is not None,
                    "tunnel_url": global_tunnel_url
                }).encode('utf-8'))
                return

            if clean_path == '/api/ip':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                self.wfile.write(json.dumps({
                    "ip": get_local_ip(),
                    "tunnel_url": global_tunnel_url
                }).encode('utf-8'))
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
                '/api/update-cover', '/api/set-pc-lock', '/api/decommission/',
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
        stop_tunnel()
        if httpd_https:
            httpd_https.shutdown()

if __name__ == '__main__':
    run_server()
