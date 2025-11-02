// Build script to download Bun runtime for Windows x64
// Downloads the latest Bun release and extracts it to the app directory

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BUN_VERSION = 'latest'; // Use 'latest' or a specific version like 'v1.1.0'
const PLATFORM = 'windows';
const ARCH = 'x64';
const BUN_URL = `https://github.com/oven-sh/bun/releases/${BUN_VERSION}/download/bun-${PLATFORM}-${ARCH}.zip`;
const OUTPUT_DIR = path.join(__dirname, '..');
const BUN_ZIP_PATH = path.join(OUTPUT_DIR, 'bun.zip');
const BUN_EXTRACT_DIR = path.join(OUTPUT_DIR, 'bun');
const BUN_EXE_PATH = path.join(BUN_EXTRACT_DIR, 'bun.exe');

console.log('Fetching Bun runtime...');
console.log(`Download URL: ${BUN_URL}`);
console.log(`Output directory: ${OUTPUT_DIR}`);

// Check if Bun already exists
if (fs.existsSync(BUN_EXE_PATH)) {
  console.log('✓ Bun already exists, skipping download');
  process.exit(0);
}

// Download Bun zip file
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    console.log(`Downloading Bun from ${url}...`);
    
    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        console.log(`Following redirect to: ${response.headers.location}`);
        // Close current file stream before redirecting
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest).catch(() => {});
        reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`));
        return;
      }
      
      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = 0;
      
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize > 0) {
          const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
          process.stdout.write(`\rDownloading: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(2)} MB / ${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
        }
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        // Ensure file is properly closed before resolving
        file.close((err) => {
          if (err) {
            reject(err);
          } else {
            // Wait a moment for file handle to be fully released
            setTimeout(() => {
              console.log('\n✓ Download complete');
              resolve();
            }, 100);
          }
        });
      });
      
      file.on('error', (err) => {
        file.close(() => {
          fs.unlinkSync(dest).catch(() => {});
          reject(err);
        });
      });
    }).on('error', (err) => {
      file.close(() => {
        fs.unlinkSync(dest).catch(() => {});
        reject(err);
      });
    });
  });
}

// Extract zip file using PowerShell (Windows)
function extractZip(zipPath, extractDir) {
  console.log(`Extracting Bun to ${extractDir}...`);
  
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
  }
  
  // Wait a moment to ensure file handle is released
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        // Use PowerShell Expand-Archive (built into Windows)
        // Use -LiteralPath to handle paths with spaces properly
        const zipPathEscaped = zipPath.replace(/'/g, "''"); // Escape single quotes for PowerShell
        const extractDirEscaped = extractDir.replace(/'/g, "''");
        
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPathEscaped}' -DestinationPath '${extractDirEscaped}' -Force"`,
          { stdio: 'inherit', shell: true, timeout: 60000 }
        );
        console.log('✓ Extraction complete');
        resolve(true);
      } catch (error) {
        console.error('Failed to extract zip:', error.message);
        
        // Try alternative: use 7-Zip if available
        try {
          execSync(
            `7z x "${zipPath}" -o"${extractDir}" -y`,
            { stdio: 'inherit', timeout: 60000 }
          );
          console.log('✓ Extraction complete (using 7-Zip)');
          resolve(true);
        } catch (e) {
          console.error('Failed to extract with 7-Zip:', e.message);
          resolve(false);
        }
      }
    }, 500); // Wait 500ms for file handle to be released
  });
}

// Find bun.exe in extracted directory (might be in subdirectory)
function findBunExe(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      const found = findBunExe(fullPath);
      if (found) return found;
    } else if (file.name.toLowerCase() === 'bun.exe') {
      return fullPath;
    }
  }
  
  return null;
}

// Main execution
async function main() {
  try {
    // Download Bun
    await downloadFile(BUN_URL, BUN_ZIP_PATH);
    
    // Extract Bun
    const extractSuccess = await extractZip(BUN_ZIP_PATH, BUN_EXTRACT_DIR);
    if (!extractSuccess) {
      throw new Error('Failed to extract Bun zip file');
    }
    
    // Wait a moment for extraction to fully complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Clean up zip file
    try {
      if (fs.existsSync(BUN_ZIP_PATH)) {
        fs.unlinkSync(BUN_ZIP_PATH);
        console.log('✓ Cleaned up zip file');
      }
    } catch (cleanupErr) {
      console.warn('Warning: Could not delete zip file (may be in use):', cleanupErr.message);
    }
    
    // Verify Bun exists - check if it's in the expected location or a subdirectory
    let actualBunPath = BUN_EXE_PATH;
    if (!fs.existsSync(BUN_EXE_PATH)) {
      console.log('Bun.exe not in expected location, searching subdirectories...');
      const foundPath = findBunExe(BUN_EXTRACT_DIR);
      if (foundPath) {
        // Move or copy to expected location
        actualBunPath = foundPath;
        console.log(`Found Bun.exe at: ${actualBunPath}`);
        
        // If it's not in the root of extractDir, move it there
        if (actualBunPath !== BUN_EXE_PATH) {
          try {
            fs.copyFileSync(actualBunPath, BUN_EXE_PATH);
            console.log(`✓ Copied Bun.exe to expected location: ${BUN_EXE_PATH}`);
            actualBunPath = BUN_EXE_PATH;
          } catch (copyErr) {
            console.warn('Could not copy to expected location, using found path:', copyErr.message);
          }
        }
      }
    }
    
    if (!fs.existsSync(actualBunPath)) {
      throw new Error(`Bun executable not found at ${BUN_EXE_PATH} or any subdirectory after extraction`);
    }
    
    console.log(`✓ Bun successfully downloaded and extracted to: ${actualBunPath}`);
    console.log(`  File size: ${(fs.statSync(actualBunPath).size / 1024 / 1024).toFixed(2)} MB`);
  } catch (error) {
    console.error('Error fetching Bun:', error.message);
    process.exit(1);
  }
}

main();

