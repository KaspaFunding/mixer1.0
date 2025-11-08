// Coinjoin WebSocket server for zero-trust coordination
// Supports both CLI and Electron modes
// Requires 'ws' package: npm install ws

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

// In-memory lobby for stateless matching
const activeLobby = new Map(); // amountRange -> [participants]
const coinjoinRooms = new Map(); // coinjoinId -> { participants, commitments, revealedUtxos }

let wss = null;
let httpServer = null;
let wsPort = 8080;

// Create WebSocket server
function createCoinjoinWebSocketServer(port = 8080) {
  if (wss) {
    console.log('[Coinjoin WS] WebSocket server already running');
    return { wss, server: httpServer, port: wsPort };
  }

  wsPort = port;

  // Create HTTP server for WebSocket
  httpServer = http.createServer((req, res) => {
    // Simple HTTP response for health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'coinjoin-websocket' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  // Create WebSocket server
  wss = new WebSocket.Server({ 
    server: httpServer,
    path: '/ws/coinjoin'
  });

  wss.on('connection', (ws, req) => {
    console.log('[Coinjoin WS] New WebSocket connection');
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        await handleWebSocketMessage(ws, data);
      } catch (err) {
        console.error('[Coinjoin WS] Error handling message:', err);
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => {
      console.log('[Coinjoin WS] Connection closed');
      // Clean up lobby entries
      for (const [amountRange, participants] of activeLobby.entries()) {
        const index = participants.findIndex(p => p.ws === ws);
        if (index !== -1) {
          participants.splice(index, 1);
        }
      }
      // Clean up coinjoin rooms
      for (const [coinjoinId, room] of coinjoinRooms.entries()) {
        const index = room.participants.findIndex(p => p.ws === ws);
        if (index !== -1) {
          room.participants.splice(index, 1);
        }
      }
    });

    ws.on('error', (err) => {
      console.error('[Coinjoin WS] WebSocket error:', err);
    });
  });

  // Start HTTP server
  httpServer.listen(wsPort, () => {
    console.log(`[Coinjoin WS] WebSocket server started on ws://localhost:${wsPort}/ws/coinjoin`);
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Coinjoin WS] Port ${wsPort} is already in use. WebSocket server not started.`);
      // Try next port
      const nextPort = wsPort + 1;
      httpServer.close();
      setTimeout(() => createCoinjoinWebSocketServer(nextPort), 1000);
    } else {
      console.error('[Coinjoin WS] HTTP server error:', err);
    }
  });

  return { wss, server: httpServer, port: wsPort };
}

// Stop WebSocket server
function stopCoinjoinWebSocketServer() {
  if (wss) {
    wss.close(() => {
      console.log('[Coinjoin WS] WebSocket server closed');
    });
    wss = null;
  }
  
  if (httpServer) {
    httpServer.close(() => {
      console.log('[Coinjoin WS] HTTP server closed');
    });
    httpServer = null;
  }
}

// Get WebSocket server info
function getWebSocketServerInfo() {
  return {
    running: wss !== null,
    port: wsPort,
    url: wss ? `ws://localhost:${wsPort}/ws/coinjoin` : null,
    lobbyParticipants: Array.from(activeLobby.values()).reduce((sum, p) => sum + p.length, 0),
    activeRooms: coinjoinRooms.size
  };
}

// Handle WebSocket messages
async function handleWebSocketMessage(ws, data) {
  const { type } = data;

  switch (type) {
    case 'join-lobby':
      await handleJoinLobby(ws, data);
      break;
    
    case 'commit-utxos':
      await handleCommitUtxos(ws, data);
      break;
    
    case 'reveal-utxos':
      await handleRevealUtxos(ws, data);
      break;
    
    case 'join-coinjoin':
      await handleJoinCoinjoin(ws, data);
      break;
    
    case 'transaction-ready':
      await handleTransactionReady(ws, data);
      break;
    
    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${type}` }));
  }
}

// Handle joining the lobby (stateless matching)
async function handleJoinLobby(ws, data) {
  const { amountRange, sessionId } = data;
  
  if (!amountRange || !sessionId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing amountRange or sessionId' }));
    return;
  }

  const key = `${amountRange.min}-${amountRange.max}`;
  
  if (!activeLobby.has(key)) {
    activeLobby.set(key, []);
  }

  const participant = {
    ws,
    sessionId,
    amountRange,
    joinedAt: Date.now()
  };

  activeLobby.get(key).push(participant);

  // Check if we have enough participants
  const participants = activeLobby.get(key);
  const MIN_PARTICIPANTS = 3; // Minimum for zero-trust coinjoin
  
  if (participants.length >= MIN_PARTICIPANTS) {
    // Match participants
    const matched = participants.splice(0, MIN_PARTICIPANTS);
    const coinjoinId = 'cj_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    
    // Create coinjoin room
    coinjoinRooms.set(coinjoinId, {
      participants: matched.map(p => ({ sessionId: p.sessionId, ws: p.ws })),
      commitments: [],
      revealedUtxos: [],
      status: 'matching'
    });

    // Notify all matched participants
    matched.forEach(p => {
      p.ws.send(JSON.stringify({
        type: 'matched',
        coinjoinId,
        participants: matched.length,
        message: 'You have been matched for coinjoin. Please commit your UTXOs.'
      }));
    });
  } else {
    // Notify participant they're waiting
    ws.send(JSON.stringify({
      type: 'waiting',
      participants: participants.length,
      minRequired: MIN_PARTICIPANTS,
      message: 'Waiting for more participants...'
    }));
  }
}

// Handle UTXO commitment
async function handleCommitUtxos(ws, data) {
  const { coinjoinId, sessionId, commitments } = data;
  
  if (!coinjoinId || !sessionId || !commitments) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing coinjoinId, sessionId, or commitments' }));
    return;
  }

  const room = coinjoinRooms.get(coinjoinId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Coinjoin room not found' }));
    return;
  }

  // Verify participant is in room
  const participant = room.participants.find(p => p.sessionId === sessionId && p.ws === ws);
  if (!participant) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not a participant in this coinjoin' }));
    return;
  }

  // Store commitment
  room.commitments.push({
    sessionId,
    commitments,
    committedAt: Date.now()
  });

  // Broadcast to all participants
  room.participants.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'commitment-received',
      coinjoinId,
      sessionId,
      totalCommitments: room.commitments.length,
      totalParticipants: room.participants.length
    }));
  });

  // Check if all participants have committed
  if (room.commitments.length === room.participants.length) {
    room.status = 'all-committed';
    
    // Request UTXO reveals
    room.participants.forEach(p => {
      p.ws.send(JSON.stringify({
        type: 'request-reveal',
        coinjoinId,
        message: 'All participants have committed. Please reveal your UTXOs.'
      }));
    });
  }
}

// Handle UTXO reveal
async function handleRevealUtxos(ws, data) {
  const { coinjoinId, sessionId, revealedUtxos, destinationAddress } = data;
  
  if (!coinjoinId || !sessionId || !revealedUtxos || !destinationAddress) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing required fields' }));
    return;
  }

  const room = coinjoinRooms.get(coinjoinId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Coinjoin room not found' }));
    return;
  }

  // Verify participant is in room
  const participant = room.participants.find(p => p.sessionId === sessionId && p.ws === ws);
  if (!participant) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not a participant in this coinjoin' }));
    return;
  }

  // Find commitment for this participant
  const commitment = room.commitments.find(c => c.sessionId === sessionId);
  if (!commitment) {
    ws.send(JSON.stringify({ type: 'error', message: 'Commitment not found for this participant' }));
    return;
  }

  // Store revealed UTXOs
  room.revealedUtxos.push({
    sessionId,
    utxos: revealedUtxos,
    destinationAddress,
    revealedAt: Date.now()
  });

  // Broadcast to all participants
  room.participants.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'utxo-revealed',
      coinjoinId,
      sessionId,
      totalRevealed: room.revealedUtxos.length,
      totalParticipants: room.participants.length
    }));
  });

  // Check if all participants have revealed
  if (room.revealedUtxos.length === room.participants.length) {
    room.status = 'all-revealed';
    
    // Notify all participants that transaction can be built
    room.participants.forEach(p => {
      p.ws.send(JSON.stringify({
        type: 'ready-to-build',
        coinjoinId,
        revealedUtxos: room.revealedUtxos,
        message: 'All UTXOs revealed. You can now build the transaction.'
      }));
    });
  }
}

// Handle joining a specific coinjoin room
async function handleJoinCoinjoin(ws, data) {
  const { coinjoinId, sessionId } = data;
  
  if (!coinjoinId || !sessionId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing coinjoinId or sessionId' }));
    return;
  }

  const room = coinjoinRooms.get(coinjoinId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Coinjoin room not found' }));
    return;
  }

  // Update WebSocket reference (in case of reconnection)
  const participant = room.participants.find(p => p.sessionId === sessionId);
  if (participant) {
    participant.ws = ws;
  }

  ws.send(JSON.stringify({
    type: 'joined',
    coinjoinId,
    status: room.status,
    participants: room.participants.length,
    commitments: room.commitments.length,
    revealedUtxos: room.revealedUtxos.length
  }));
}

// Handle transaction ready notification
async function handleTransactionReady(ws, data) {
  const { coinjoinId, sessionId, signedTransaction } = data;
  
  if (!coinjoinId || !sessionId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing coinjoinId or sessionId' }));
    return;
  }

  const room = coinjoinRooms.get(coinjoinId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Coinjoin room not found' }));
    return;
  }

  // Store signed transaction part (each user signs their own inputs)
  if (!room.signedParts) {
    room.signedParts = [];
  }

  room.signedParts.push({
    sessionId,
    signedTransaction,
    signedAt: Date.now()
  });

  // Broadcast to all participants
  room.participants.forEach(p => {
    p.ws.send(JSON.stringify({
      type: 'transaction-signed',
      coinjoinId,
      sessionId,
      totalSigned: room.signedParts.length,
      totalParticipants: room.participants.length
    }));
  });

  // Check if all participants have signed
  if (room.signedParts && room.signedParts.length === room.participants.length) {
    room.status = 'all-signed';
    
    // Notify all participants that transaction is ready to submit
    room.participants.forEach(p => {
      p.ws.send(JSON.stringify({
        type: 'transaction-ready',
        coinjoinId,
        signedParts: room.signedParts,
        message: 'All participants have signed. Transaction is ready to submit.'
      }));
    });
  }
}

// Clean up old rooms (prevent memory leak)
setInterval(() => {
  const now = Date.now();
  const MAX_AGE = 3600000; // 1 hour
  
  for (const [coinjoinId, room] of coinjoinRooms.entries()) {
    const oldestParticipant = room.participants.reduce((oldest, p) => {
      return (p.joinedAt || now) < oldest ? (p.joinedAt || now) : oldest;
    }, now);
    
    if (now - oldestParticipant > MAX_AGE) {
      console.log(`[Coinjoin WS] Cleaning up old coinjoin room: ${coinjoinId}`);
      coinjoinRooms.delete(coinjoinId);
    }
  }
  
  // Clean up empty lobbies
  for (const [key, participants] of activeLobby.entries()) {
    if (participants.length === 0) {
      activeLobby.delete(key);
    }
  }
}, 300000); // Check every 5 minutes

module.exports = {
  createCoinjoinWebSocketServer,
  stopCoinjoinWebSocketServer,
  getWebSocketServerInfo,
  activeLobby,
  coinjoinRooms
};

