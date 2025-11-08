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
    getPrivateKey: () => ipcRenderer.invoke('wallet:getPrivateKey'),
    balance: () => ipcRenderer.invoke('wallet:balance'),
    transactionHistory: (limit, offset) => ipcRenderer.invoke('wallet:transaction-history', { limit, offset }),
    estimateFee: (address, amountKAS) => ipcRenderer.invoke('wallet:estimate-fee', { address, amountKAS }),
    send: (address, amountKAS) => ipcRenderer.invoke('wallet:send', { address, amountKAS }),
    remove: () => ipcRenderer.invoke('wallet:remove'),
    getUtxos: (address) => ipcRenderer.invoke('wallet:get-utxos', { address }),
    hasMatchingUtxo: (targetAmountSompi, tolerancePercent, excludeUtxos) => ipcRenderer.invoke('wallet:has-matching-utxo', { targetAmountSompi, tolerancePercent, excludeUtxos }),
    createMatchingUtxo: (targetAmountSompi, excludeUtxos) => ipcRenderer.invoke('wallet:create-matching-utxo', { targetAmountSompi, excludeUtxos }),
    waitForUtxo: (targetAmountSompi, timeoutMs, pollIntervalMs, createdTxId, excludeUtxos) => ipcRenderer.invoke('wallet:wait-for-utxo', { targetAmountSompi, timeoutMs, pollIntervalMs, createdTxId, excludeUtxos }),
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
    forcePayoutAll: () => ipcRenderer.invoke('pool:force-payout-all'),
    config: {
      get: () => ipcRenderer.invoke('pool:config:get'),
      update: (partial) => ipcRenderer.invoke('pool:config:update', partial)
    },
    miner: {
      updatePaymentInterval: (address, intervalHours, verificationIP) => ipcRenderer.invoke('pool:miner:update-payment-interval', { address, intervalHours, verificationIP }),
      get: (address) => ipcRenderer.invoke('pool:miner:get', { address })
    },
    onBlockFound: (callback) => {
      ipcRenderer.on('pool:block-found', (event, data) => callback(data));
    }
  },

  // System utilities
  system: {
    getLocalIp: () => ipcRenderer.invoke('system:getLocalIp')
  },
  
  // QR Code generation (via main process)
  qrcode: {
    toDataURL: (text, options) => ipcRenderer.invoke('qrcode:toDataURL', { text, options })
  },
  
  // Coinjoin
  coinjoin: {
    create: (destinationAddress, options) => ipcRenderer.invoke('coinjoin:create', { destinationAddress, ...options }),
    get: (sessionId) => ipcRenderer.invoke('coinjoin:get', sessionId),
    list: () => ipcRenderer.invoke('coinjoin:list'),
    stats: () => ipcRenderer.invoke('coinjoin:stats'),
    reveal: (sessionId, revealedUtxos, destinationAddress) => ipcRenderer.invoke('coinjoin:reveal', { sessionId, revealedUtxos, destinationAddress }),
        build: (sessionIds) => ipcRenderer.invoke('coinjoin:build', { sessionIds }),
        sign: (sessionId, transactionData, privateKeyHex) => ipcRenderer.invoke('coinjoin:sign', { sessionId, transactionData, privateKeyHex }),
        submit: (transactionData, allSignatures) => ipcRenderer.invoke('coinjoin:submit', { transactionData, allSignatures }),
        storeSignatures: (transactionData, signatures) => ipcRenderer.invoke('coinjoin:store-signatures', { transactionData, signatures }),
        getSignatures: (transactionData) => ipcRenderer.invoke('coinjoin:get-signatures', { transactionData }),
    ws: {
      info: () => ipcRenderer.invoke('coinjoin:ws:info'),
      start: (port) => ipcRenderer.invoke('coinjoin:ws:start', { port }),
      stop: () => ipcRenderer.invoke('coinjoin:ws:stop')
    }
  }
});
