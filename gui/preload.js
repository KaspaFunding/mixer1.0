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
    importMnemonic: (mnemonic, passphrase) => ipcRenderer.invoke('wallet:import-mnemonic', { mnemonic, passphrase }),
    generateAddressesKpub: (kpub, startIndex, count) => ipcRenderer.invoke('wallet:generate-addresses-kpub', { kpub, startIndex, count }),
    detectKPUBFormat: (extendedKey) => ipcRenderer.invoke('wallet:detect-kpub-format', extendedKey),
    detectWalletType: (extendedKey, mnemonic) => ipcRenderer.invoke('wallet:detect-wallet-type', { extendedKey, mnemonic }),
    info: () => ipcRenderer.invoke('wallet:info'),
    balance: () => ipcRenderer.invoke('wallet:balance'),
    transactionHistory: (limit, offset) => ipcRenderer.invoke('wallet:transaction-history', { limit, offset }),
    estimateFee: (address, amountKAS) => ipcRenderer.invoke('wallet:estimate-fee', { address, amountKAS }),
    send: (address, amountKAS) => ipcRenderer.invoke('wallet:send', { address, amountKAS }),
    remove: () => ipcRenderer.invoke('wallet:remove'),
    addressBook: {
      list: () => ipcRenderer.invoke('wallet:addressbook:list'),
      add: (address, label, category) => ipcRenderer.invoke('wallet:addressbook:add', { address, label, category }),
      update: (id, updates) => ipcRenderer.invoke('wallet:addressbook:update', { id, updates }),
      remove: (id) => ipcRenderer.invoke('wallet:addressbook:remove', { id }),
    },
  },
  
  // Node status
  node: {
    status: () => ipcRenderer.invoke('node:status'),
    start: () => ipcRenderer.invoke('node:start'),
    getPortInfo: () => ipcRenderer.invoke('node:get-port-info'),
    getMode: () => ipcRenderer.invoke('node:get-mode'),
    setMode: (mode) => ipcRenderer.invoke('node:set-mode', { mode }),
    restart: () => ipcRenderer.invoke('node:restart'),
    onStatusUpdate: (callback) => {
      ipcRenderer.on('node-status-update', (event, data) => callback(data));
    }
  },

  // Mining pool
  pool: {
    start: (opts) => ipcRenderer.invoke('pool:start', opts),
    stop: () => ipcRenderer.invoke('pool:stop'),
    status: () => ipcRenderer.invoke('pool:status'),
    generateKeypair: () => ipcRenderer.invoke('pool:generate-keypair'),
    config: {
      get: () => ipcRenderer.invoke('pool:config:get'),
      update: (partial) => ipcRenderer.invoke('pool:config:update', partial)
    },
    miner: {
      updatePaymentInterval: (address, intervalHours, verificationIP) => ipcRenderer.invoke('pool:miner:update-payment-interval', { address, intervalHours, verificationIP }),
      get: (address) => ipcRenderer.invoke('pool:miner:get', { address })
    }
  },

  // System utilities
  system: {
    getLocalIp: () => ipcRenderer.invoke('system:getLocalIp')
  },
  
  // QR Code generation (via main process)
  qrcode: {
    toDataURL: (text, options) => ipcRenderer.invoke('qrcode:toDataURL', { text, options })
  }
});
