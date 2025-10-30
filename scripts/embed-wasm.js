// Build script to embed kaspa_bg.wasm as base64 into the executable

const fs = require('fs');
const path = require('path');

const wasmPath = path.join(__dirname, '..', 'kaspa', 'kaspa_bg.wasm');
const outputPath = path.join(__dirname, '..', 'lib', 'wasm-embedded.js');

console.log('Embedding WASM file as base64...');

if (!fs.existsSync(wasmPath)) {
  console.error(`Error: ${wasmPath} not found!`);
  process.exit(1);
}

const wasmBytes = fs.readFileSync(wasmPath);
const wasmBase64 = wasmBytes.toString('base64');

const output = `// Auto-generated file - embeds kaspa_bg.wasm as base64
// This allows the executable to be a single file without external WASM

module.exports = {
  wasmBase64: ${JSON.stringify(wasmBase64)},
  wasmSize: ${wasmBytes.length},
};
`;

fs.writeFileSync(outputPath, output);

console.log(`✓ Embedded WASM file (${(wasmBytes.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  Output: ${outputPath}`);

