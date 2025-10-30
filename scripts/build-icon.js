/* Convert a PNG logo to Windows ICO for electron-builder (auto-square and resize) */
const fs = require('fs');
const path = require('path');
const pngToIco = require('png-to-ico');
const sharp = require('sharp');

async function ensureSquarePng(inputPath, outputPath, size = 512) {
  const img = sharp(inputPath).png();
  const meta = await img.metadata();
  const maxSide = Math.max(meta.width || size, meta.height || size);
  // Resize to fit within maxSide, then extend to square with transparent padding
  const resized = sharp(inputPath)
    .resize({ width: maxSide, height: maxSide, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png();
  // Finally, scale to target size (512) for best ICO quality
  const squared = await resized
    .resize({ width: size, height: size, fit: 'cover' })
    .toBuffer();
  fs.writeFileSync(outputPath, squared);
  return outputPath;
}

async function main() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  const srcPng = path.join(assetsDir, 'logo.png');
  const squaredPng = path.join(assetsDir, 'icon-512.png');
  const outIco = path.join(assetsDir, 'icon.ico');

  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  if (!fs.existsSync(srcPng)) {
    console.error('Missing assets/logo.png. Please save a Kaspa logo PNG there from the media kit.');
    process.exit(1);
  }

  try {
    await ensureSquarePng(srcPng, squaredPng, 512);
    const buf = await pngToIco(squaredPng);
    fs.writeFileSync(outIco, buf);
    console.log('Created', outIco);
  } catch (e) {
    console.error('Failed to create icon.ico:', e.message);
    process.exit(1);
  }
}

main();


