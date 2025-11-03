import { Header, PoW, type RpcClient, type IRawBlock, type IRawHeader } from "../../wasm/kaspa"
import Jobs from "./jobs"

export default class Templates {
  private rpc: RpcClient
  private address: string
  private identity: string
  private daaWindow: number

  private templates: Map<string, [ IRawBlock, PoW ]> = new Map()
  private jobs = new Jobs()

  constructor (rpc: RpcClient, address: string, identity: string, daaWindow: number) {
    this.rpc = rpc
    this.address = address
    this.identity = identity
    this.daaWindow = daaWindow

    this.rpc.addEventListener('connect', () => this.rpc.subscribeNewBlockTemplate())
  }

  getHash (id: string) {
    return this.jobs.getHash(id)
  }
  
  getPoW (hash: string) {
    return this.templates.get(hash)?.[1]
  }
  
  getHeader (hash: string): IRawHeader | undefined {
    return this.templates.get(hash)?.[0].header
  }

  async submit (hash: string, nonce: bigint) {
    const template = this.templates.get(hash)![0]
    template.header.nonce = nonce
  
    const { report } = await this.rpc.submitBlock({
      block: template,
      allowNonDAABlocks: false
    })

    if (report.type === 'success') {
      // Compute header hash locally first (for immediate return)
      const header = new Header(template.header)
      const computedHash = header.finalize()
      
      // Try to get the actual accepted block hash from the node
      // The node may have a slightly different hash if it modified the block
      // Wait a brief moment for block to be accepted, then query
      try {
        await new Promise(resolve => setTimeout(resolve, 500)) // Wait 500ms for block acceptance
        const blockResponse = await this.rpc.getBlock({ 
          hash: computedHash, 
          includeTransactions: false 
        }).catch(() => null)
        
        if (blockResponse?.block?.header?.hash) {
          // Use the actual accepted hash from the node
          const acceptedHash = blockResponse.block.header.hash
          console.log(`[Templates] Block accepted: computed=${computedHash.substring(0, 16)}... actual=${acceptedHash.substring(0, 16)}...`)
          return acceptedHash
        }
      } catch (err) {
        // If query fails, fall back to computed hash
        console.warn(`[Templates] Could not verify accepted block hash, using computed: ${err.message}`)
      }
      
      // Fallback to computed hash if we can't get the actual one
      return computedHash
    } else throw Error('Block is on IBD/route is full')
  }

  async register (callback: (id: string, hash: string, timestamp: bigint, header: IRawHeader) => void) {
    // Define the template handler function
    const handleNewTemplate = async () => {
      const { block } = await this.rpc.getBlockTemplate({
        payAddress: this.address,
        extraData: this.identity
      })

      const proofOfWork = new PoW(block.header)
      if (this.templates.has(proofOfWork.prePoWHash)) return

      this.templates.set(proofOfWork.prePoWHash, [ block, proofOfWork ])
      const id = this.jobs.deriveId(proofOfWork.prePoWHash)

      if (this.templates.size > this.daaWindow) {
        this.templates.delete(this.templates.entries().next().value![0])
        this.jobs.expireNext()
      }

      callback(id, proofOfWork.prePoWHash, block.header.timestamp, block.header)
    }

    // Subscribe to future templates
    this.rpc.addEventListener('new-block-template', handleNewTemplate)

    // Subscribe to notifications and fetch initial template
    await this.rpc.subscribeNewBlockTemplate()
    
    // Fetch initial template immediately so we have at least one job when miners connect
    await handleNewTemplate()
  }
}
