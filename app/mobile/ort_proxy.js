console.log('[ORT-Proxy] Iniciant...');
import * as realOrt from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/+esm?bypass';

// Clone/referenciar classe i sobreescriure el mètode estàtic create
const InferenceSession = realOrt.InferenceSession;
const originalCreate = InferenceSession.create;

InferenceSession.create = async function(model, options) {
  let size = 0;
  if (model) {
    if (model.byteLength) {
      size = model.byteLength;
    } else if (model.buffer && model.buffer.byteLength) {
      size = model.buffer.byteLength;
    }
  }
  
  // 8980573 és la mida exacta en bytes del model rec descompromès del tar
  if (size === 8980573 || size === 8990720 || (size > 8000000 && size < 10000000)) {
    console.log(`[ORT-Proxy] Interceptant sessió de reconeixement (mida: ${size} bytes). Retornant mock session.`);
    return {
      inputNames: ["x"],
      outputNames: ["y"],
      run: async function(inputs) {
        return { y: { data: new Float32Array(0), dims: [1, 1, 1] } };
      },
      release: async function() {
        console.log("[ORT-Proxy] Mock session alliberada.");
      }
    };
  }
  
  return originalCreate.apply(this, arguments);
};

export * from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/+esm?bypass';
export { InferenceSession };
