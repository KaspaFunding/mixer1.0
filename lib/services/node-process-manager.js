// Node process management service

const { spawn } = require('child_process');
const path = require('path');

// Start node using batch file
function startNodeWithBatch(batPath, isPublic) {
  console.log('[Node Process] Starting kaspad with batch file...');
  console.log('[Node Process] Batch file path:', batPath);
  console.log('[Node Process] Mode:', isPublic ? 'Public' : 'Private');
  
  const batFullPath = path.resolve(batPath);
  const batDir = path.dirname(batFullPath);
  
  console.log('[Node Process] Resolved batch path:', batFullPath);
  console.log('[Node Process] Batch directory:', batDir);
  
  try {
    const process = spawn('cmd', ['/c', `start "" cmd /c cd /d "${batDir}" && "${batFullPath}"`], {
      detached: true,
      stdio: 'ignore',
      shell: true
    });
    
    console.log('[Node Process] Batch file spawn successful, PID:', process.pid);
    process.unref();
    return process;
  } catch (error) {
    console.error('[Node Process] Error spawning batch file:', error);
    throw error;
  }
}

// Start node directly with executable
function startNodeWithExe(exePath, isPublic) {
  console.log('[Node Process] Starting kaspad directly...');
  console.log('[Node Process] Executable path:', exePath);
  console.log('[Node Process] Mode:', isPublic ? 'Public' : 'Private');
  
  const exeFullPath = path.resolve(exePath);
  const args = [
    '--utxoindex',
    '--rpclisten=127.0.0.1:16110',
    '--rpclisten-borsh=127.0.0.1:17110',
    '--perf-metrics',
    '--perf-metrics-interval-sec=1',
    '--outpeers=128'
  ];
  
  if (!isPublic) {
    args.push('--disable-upnp');
  }
  
  console.log('[Node Process] Arguments:', args.join(' '));
  
  try {
    const process = spawn(`"${exeFullPath}"`, args, {
      detached: true,
      stdio: 'ignore',
      shell: true
    });
    
    console.log('[Node Process] Direct spawn successful, PID:', process.pid);
    process.unref();
    return process;
  } catch (error) {
    console.error('[Node Process] Error spawning executable:', error);
    throw error;
  }
}

// Wait for node to become ready
async function waitForNodeReady(isNodeListening, maxWait = 90) {
  for (let i = 0; i < maxWait; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (await isNodeListening()) {
      return { ready: true, waited: i };
    }
    
    if (i % 5 === 0 && i > 0) {
      process.stdout.write('.');
    }
  }
  
  return { ready: false, waited: maxWait };
}

module.exports = {
  startNodeWithBatch,
  startNodeWithExe,
  waitForNodeReady,
};

