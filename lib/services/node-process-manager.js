// Node process management service

const { spawn } = require('child_process');
const path = require('path');

// Start node using batch file
function startNodeWithBatch(batPath, isPublic) {
  const batFullPath = path.resolve(batPath);
  const batDir = path.dirname(batFullPath);
  
  const process = spawn('cmd', ['/c', `start "" cmd /c cd /d "${batDir}" && "${batFullPath}"`], {
    detached: true,
    stdio: 'ignore',
    shell: true
  });
  
  process.unref();
  return process;
}

// Start node directly with executable
function startNodeWithExe(exePath, isPublic) {
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
  
  const process = spawn(`"${exeFullPath}"`, args, {
    detached: true,
    stdio: 'ignore',
    shell: true
  });
  
  process.unref();
  return process;
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

