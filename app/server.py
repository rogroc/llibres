import http.server
import ssl
import subprocess
import os
import socket
import json
import threading
import time

PORT = 8080        # Desktop HTTP
PORT_HTTPS = 8443  # Mobile HTTPS

# State to pass between mobile and desktop
latest_scan = None
latest_camera_frame = None
camera_frame_timestamp = 0
latest_synced_book = None
scan_queue = []
queue_lock = threading.Lock()

def generate_ssl_certs():
    if not os.path.exists('key.pem') or not os.path.exists('cert.pem'):
        print("Generant certificat SSL auto-signat per al mòbil...")
        cmd = [
            '/usr/bin/openssl', 'req', '-new', '-x509',
            '-keyout', 'key.pem', '-out', 'cert.pem',
            '-days', '365', '-nodes',
            '-subj', '/C=ES/ST=Catalonia/L=Barcelona/O=BiblioScan/OU=Dev/CN=localhost'
        ]
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print("Certificats SSL generats correctament.")
        except Exception as e:
            print(f"Error generant certificats amb openssl: {e}")
            print("Assegura't que tens openssl instal·lat.")

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
                    silent_terms = ["certificate unknown", "handshake", "violation of protocol", "eof occurred"]
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
            global latest_scan, latest_camera_frame, camera_frame_timestamp, latest_synced_book
            clean_path = self.path.split('?')[0]
            
            if clean_path == '/api/camera-frame':
                content_length = int(self.headers.get('Content-Length', 0))
                # Límit de 2MB per frame: evita que frames massa grans esgotin la memòria
                MAX_FRAME_SIZE = 2 * 1024 * 1024  # 2 MB
                if content_length > MAX_FRAME_SIZE:
                    self.rfile.read(content_length)  # Buidem el buffer
                    self.send_response(413)  # Payload Too Large
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(b'{"error": "frame massa gran"}')
                    return
                frame_data = self.rfile.read(content_length)
                latest_camera_frame = frame_data
                camera_frame_timestamp = int(time.time() * 1000)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'{"ok": true}')
                return

            if clean_path == '/api/sync':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                latest_synced_book = post_data
                try:
                    book = json.loads(post_data.decode('utf-8'))
                    print(f"\n  ✅ Llibre sincronitzat des del mòbil: {book.get('title','?')} ({book.get('source','?')})")
                except Exception:
                     pass
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
                    latest_scan = data
                    if data.get('type') in ('isbn', 'portada', 'portada-captured', 'connection', 'reset'):
                        with queue_lock:
                            scan_queue.append(data)
                    print(f"\n✅ Rebut des del mòbil: {data['type']} - {str(data.get('value',''))[:50]}...")
                    # Rotació del log: mantenim màxim 500 línies
                    log_path = 'mobile_logs.txt'
                    log_line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {data['type']}: {data.get('value','')}\n"
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
            
            self.send_response(404)
            self.end_headers()

        def do_GET(self):
            global latest_scan, latest_camera_frame, camera_frame_timestamp, latest_synced_book
            clean_path = self.path.split('?')[0]

            if clean_path == '/api/camera-frame':
                if latest_camera_frame:
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/jpeg')
                    self.send_header('Content-Length', str(len(latest_camera_frame)))
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('X-Frame-Timestamp', str(camera_frame_timestamp))
                    self.end_headers()
                    self.wfile.write(latest_camera_frame)
                else:
                    self.send_response(204)  # No Content yet
                    self.end_headers()
                return

            if clean_path == '/api/camera-status':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                import time
                is_active = (time.time() * 1000 - camera_frame_timestamp) < 3000  # active if frame < 3s
                self.wfile.write(json.dumps({
                    'active': is_active and latest_camera_frame is not None,
                    'timestamp': camera_frame_timestamp
                }).encode('utf-8'))
                return

            if clean_path == '/api/sync-poll':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                if latest_synced_book:
                    self.wfile.write(latest_synced_book)
                    latest_synced_book = None
                else:
                    self.wfile.write(b'{}')
                return

            if clean_path == '/api/poll':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
                self.end_headers()
                with queue_lock:
                    to_send = list(scan_queue)
                    scan_queue.clear()
                    latest_scan = None
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
                'Bad request version', 'Bad HTTP/0.9 request', 'Bad request syntax',
                '\x16\x03',  # TLS ClientHello (Chrome intentant HTTPS al port HTTP)
            )
            if any(p in msg for p in SILENT):
                return
            super().log_message(format, *args)

    httpd_http = http.server.ThreadingHTTPServer(server_address_http, APIRequestHandler)
    
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

    local_ip = get_local_ip()
    
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
