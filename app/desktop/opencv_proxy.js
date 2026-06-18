console.log('[OpenCV-Proxy] Iniciant...');

export default new Promise((resolve, reject) => {
  const safeResolve = (cv) => {
    if (cv) {
      console.log('[OpenCV-Proxy] Eliminant cv.then per evitar bucles de resolució de Promise...');
      try {
        delete cv.then;
      } catch (e) {
        try {
          cv.then = undefined;
        } catch (err) {
          console.warn('[OpenCV-Proxy] No s\'ha pogut esborrar o modificar cv.then:', err);
        }
      }
    }
    resolve(cv);
  };

  if (window.cv && !(window.cv instanceof Promise)) {
    console.log('[OpenCV-Proxy] OpenCV ja està disponible globalment.');
    safeResolve(window.cv);
    return;
  }

  const existingScript = document.querySelector('script[src*="opencv.js"]');
  window.Module = window.Module || {};
  const oldInit = window.Module.onRuntimeInitialized;

  window.Module.onRuntimeInitialized = () => {
    console.log('[OpenCV-Proxy] OpenCV inicialitzat correctament des de Module.onRuntimeInitialized!');
    if (oldInit) oldInit();
    safeResolve(window.cv);
  };

  if (!window.cv && !existingScript) {
    console.log('[OpenCV-Proxy] Creant element script per descarregar opencv.js...');
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.9.0-release.1/dist/opencv.js';
    script.async = true;
    script.onload = () => {
      console.log('[OpenCV-Proxy] script.onload disparat.');
      if (window.cv && !(window.cv instanceof Promise)) {
        console.log('[OpenCV-Proxy] OpenCV resolt a onload.');
        safeResolve(window.cv);
      }
    };
    script.onerror = (e) => {
      console.error('[OpenCV-Proxy] Error carregant script opencv.js:', e);
      reject(new Error('Error de xarxa descarregant OpenCV (opencv.js)'));
    };
    document.head.appendChild(script);
  } else if (existingScript) {
    console.log('[OpenCV-Proxy] Script d\'OpenCV existent detectat, esperant onRuntimeInitialized...');
  }
});
