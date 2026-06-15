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
            if hasattr(self.server, 'ssl_context') and self.server.ssl_context:
                try:
                    self.request = self.server.ssl_context.wrap_socket(self.request, server_side=True)
                except Exception as e:
                    try:
                        self.request.close()
                    except Exception:
                        pass
                    raise e
            super().setup()

        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            super().end_headers()

        def do_OPTIONS(self):
            self.send_response(200)
            self.end_headers()

        def do_POST(self):
            global latest_scan
            clean_path = self.path.split('?')[0]
            
            if clean_path == '/api/scan':
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                try:
                    data = json.loads(post_data.decode('utf-8'))
                    latest_scan = data
                    print(f"\\n✅ Rebut des del mòbil: {data['type']} - {data['value'][:50]}...")
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
            global latest_scan
            clean_path = self.path.split('?')[0]

            if clean_path == '/api/poll':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                if latest_scan:
                    self.wfile.write(json.dumps(latest_scan).encode('utf-8'))
                    latest_scan = None
                else:
                    self.wfile.write(b'{}')
                return

            if clean_path == '/api/ip':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({"ip": get_local_ip()}).encode('utf-8'))
                return
                
            # Allow directory redirection for cleaner URLs
            if clean_path == '/':
                self.send_response(301)
                self.send_header('Location', '/desktop/')
                self.end_headers()
                return

            super().do_GET()

        def log_message(self, format, *args):
            # Silence polling noise
            if '/api/poll' in format % args:
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
