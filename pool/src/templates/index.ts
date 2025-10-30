import { Header, PoW, type RpcClient, type IRawBlock } from "../../wasm/kaspa"
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

  async submit (hash: string, nonce: bigint) {
    const template = this.templates.get(hash)![0]
    template.header.nonce = nonce
  
    const { report } = await this.rpc.submitBlock({
      block: template,
      allowNonDAABlocks: false
    })

    if (report.type === 'success') {
      const header = new Header(template.header) // TODO: convince core to return blocks hash on submitBlock
      return header.finalize()
    } else throw Error('Block is on IBD/route is full')
  }

  async register (callback: (id: string, hash: string, timestamp: bigint) => void) {
    this.rpc.addEventListener('new-block-template', async () => {
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

      callback(id, proofOfWork.prePoWHash, block.header.timestamp)
    })

    await this.rpc.subscribeNewBlockTemplate()
  }
}
