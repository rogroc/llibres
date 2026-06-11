import http.server
import ssl
import subprocess
import os
import socket

PORT = 8000

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
            subprocess.run(cmd, check=True)
            print("Certificats SSL generats correctament.")
        except Exception as e:
            print(f"Error generant certificats amb openssl: {e}")
            print("Si us plau, assegura't que tens openssl instal·lat.")

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't need to actually connect, just resolve local interface IP
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = '127.0.0.1'
    finally:
        s.close()
    return local_ip

def run_server():
    server_address = ('0.0.0.0', PORT)
    
    # Enable CORS headers
    class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            super().end_headers()
            
        def do_GET(self):

                
            if self.path.startswith('/api/bne'):
                from urllib.parse import urlparse, parse_qs
                query = parse_qs(urlparse(self.path).query)
                isbn = query.get('isbn', [''])[0]
                
                if not isbn:
                    self.send_response(400)
                    self.end_headers()
                    return
                
                try:
                    import ssl
                    import urllib.request
                    context = ssl._create_unverified_context()
                    
                    # URL complerta obtinguda del cercador de la BNE
                    url = (
                        f"https://catalogo.bne.es/primaws/rest/pub/pnxs"
                        f"?blendFacetsSeparately=false"
                        f"&disableCache=false"
                        f"&getMore=0"
                        f"&inst=34BNE_INST"
                        f"&isCDSearch=false"
                        f"&lang=es"
                        f"&limit=10"
                        f"&newspapersActive=false"
                        f"&newspapersSearch=false"
                        f"&offset=0"
                        f"&pcAvailability=true"
                        f"&q=any,contains,{isbn},AND;rtype,exact,books"
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
            
            # Serve static files normally for all other paths
            super().do_GET()
            
    httpd = http.server.HTTPServer(server_address, CORSRequestHandler)
    
    local_ip = get_local_ip()
    print("\n" + "="*50)
    print("BiblioScan - Servidor Web Actiu (HTTP Normal)")
    print("="*50)
    print("Zero avisos de seguretat a l'ordinador!")
    print(f"  - Ordinador: http://localhost:{PORT}")
    if local_ip != '127.0.0.1':
        print(f"  - Mòbil:     http://{local_ip}:{PORT}")
    print("="*50)
    print("Prem Ctrl+C per aturar el servidor.\n")
    print("Nota: Si fas servir el mòbil, com que no és localhost, Chrome podria bloquejar la")
    print("càmera. Si et passa, avisa'm i farem un túnel públic temporal per solucionar-ho.")
    print("="*50 + "\n")
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"Error al servidor: {e}")

if __name__ == '__main__':
    run_server()
