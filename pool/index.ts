import { RpcClient } from "./wasm/kaspa"
import Treasury from "./src/treasury"
import Templates from "./src/templates"
import Stratum from "./src/stratum"
import Pool from "./src/pool"
import Database from "./src/pool/database"

import config from "./config.json"

const rpc = new RpcClient({
  url: config.node
})
await rpc.connect()

const serverInfo = await rpc.getServerInfo()
if (!serverInfo.isSynced || !serverInfo.hasUtxoIndex) throw Error('Provided node is either not synchronized or lacks the UTXO index.')

// Create database first (treasury needs it)
const database = new Database('./database')
// Load reward block hashes on startup
database.loadRewardBlockHashes()

const treasury = new Treasury(rpc, serverInfo.networkId, config.treasury.privateKey, config.treasury.fee, database)
const templates = new Templates(rpc, treasury.address, config.templates.identity, config.templates.daaWindow)
const stratum = new Stratum(templates, treasury.address, config.stratum.hostName, config.stratum.port, config.stratum.difficulty, config.stratum.vardiff)
const pool = new Pool(treasury, stratum, config.treasury.rewarding.paymentThreshold, database)

if (config.api.enabled) pool.serveApi(config.api.port)