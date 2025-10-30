import { RpcClient } from "../wasm/kaspa";

export default class Kaspa {
  rpc: RpcClient
  
  constructor (node: string) {
    this.rpc = new RpcClient({
      url: node,
    })
  }

  async connect () {
    await this.rpc.connect()

  }
}