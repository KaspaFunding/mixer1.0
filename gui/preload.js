// Preload script - Bridge between renderer and main process

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Session management
  session: {
    create: (destinations, amount) => ipcRenderer.invoke('session:create', { destinations, amount }),
    get: (sessionId) => ipcRenderer.invoke('session:get', sessionId),
    list: () => ipcRenderer.invoke('session:list'),
    delete: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
    exportKeys: (sessionId) => ipcRenderer.invoke('session:export-keys', sessionId),
    onUpdate: (callback) => {
      ipcRenderer.on('sessions-update', (event, data) => callback(data));
    }
  },
  
  // Wallet management
  wallet: {
    import: (privateKeyHex) => ipcRenderer.invoke('wallet:import', privateKeyHex),
    info: () => ipcRenderer.invoke('wallet:info'),
    balance: () => ipcRenderer.invoke('wallet:balance'),
    send: (address, amountKAS) => ipcRenderer.invoke('wallet:send', { address, amountKAS }),
    remove: () => ipcRenderer.invoke('wallet:remove'),
  },
  
  // Node status
  node: {
    status: () => ipcRenderer.invoke('node:status'),
    start: () => ipcRenderer.invoke('node:start'),
    onStatusUpdate: (callback) => {
      ipcRenderer.on('node-status-update', (event, data) => callback(data));
    }
  },

  // Mining pool
  pool: {
    start: (opts) => ipcRenderer.invoke('pool:start', opts),
    stop: () => ipcRenderer.invoke('pool:stop'),
    status: () => ipcRenderer.invoke('pool:status'),
    config: {
      get: () => ipcRenderer.invoke('pool:config:get'),
      update: (partial) => ipcRenderer.invoke('pool:config:update', partial)
    }
  }
});

