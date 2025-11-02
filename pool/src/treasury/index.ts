import { EventEmitter } from 'events'
import { PrivateKey, UtxoProcessor, UtxoContext, type RpcClient, type IPaymentOutput, createTransactions } from "../../wasm/kaspa"

const startTime = BigInt(Date.now())

UtxoProcessor.setCoinbaseTransactionMaturityDAA('mainnet', 200n)
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-10', 200n)
UtxoProcessor.setCoinbaseTransactionMaturityDAA('testnet-11', 2000n)

export default class Treasury extends EventEmitter {
  privateKey: PrivateKey
  address: string
  processor: UtxoProcessor
  context: UtxoContext
  fee: number
  rpc: RpcClient
  
  constructor (rpc: RpcClient, networkId: string, privateKey: string, fee: number) {
    super()
  
    this.rpc = rpc
    this.privateKey = new PrivateKey(privateKey)
    this.address = (this.privateKey.toAddress(networkId)).toString()
    this.processor = new UtxoProcessor({ rpc, networkId })
    this.context = new UtxoContext({ processor: this.processor })
    this.fee = fee

    this.registerProcessor()
  }
  
  async send (outputs: IPaymentOutput[]) {
    const { estimate } = await this.rpc.getFeeEstimate({})
    const rpc = this.processor.rpc

    const hashes: string[] = []

    for (const output of outputs) {
      const { transactions, summary } = await createTransactions({
        entries: this.context,
        outputs: [ output ],
        changeAddress: this.address,
        priorityFee: 0n,
        // @ts-ignore - feeRate is used at runtime even if not in type definition
        feeRate: estimate.lowBuckets[0].feerate
      })
  
      for (const transaction of transactions) {
        transaction.sign([ this.privateKey.toString() ])
        await transaction.submit(rpc)
        hashes.push(summary.finalTransactionId!)
      }
    }

    return hashes
  }
  
  private registerProcessor () {
    this.processor.addEventListener("utxo-proc-start", async () => {
      await this.context.clear()
      await this.context.trackAddresses([ this.address ])
      console.log(`[Treasury] UTXO processor started, tracking address: ${this.address}`)
      console.log(`[Treasury] Start time filter: ${new Date(Number(startTime)).toISOString()} (only coinbases after this time will be processed)`)
    })

    this.processor.addEventListener('maturity', async (e) => {
      // @ts-ignore - isCoinbase, value, and blockDaaScore exist on TransactionRecord at runtime
      if (!e.data.isCoinbase) return
      
      // @ts-ignore - blockDaaScore exists on TransactionRecord at runtime
      const eventBlockDaaScore = e.data.blockDaaScore
      const { timestamps } = await this.rpc.getDaaScoreTimestampEstimate({
        daaScores: [ eventBlockDaaScore ]
      })

      const blockTimestamp = timestamps[0]
      const startTimeDate = Number(startTime)
      
      // @ts-ignore - value exists on TransactionRecord at runtime
      const eventValue = e.data.value
      
      console.log(`[Treasury] Coinbase maturity event: value=${eventValue.toString()} sompi, blockDaaScore=${eventBlockDaaScore}, timestamp=${new Date(Number(blockTimestamp)).toISOString()}`)
      
      if (blockTimestamp < startTime) {
        console.log(`[Treasury] Skipping coinbase (block timestamp ${new Date(Number(blockTimestamp)).toISOString()} < start time ${new Date(startTimeDate).toISOString()})`)
        return
      }

      const reward = eventValue
      const poolFee = (reward * BigInt(this.fee * 100)) / 10000n
      const rewardKAS = (Number(reward - poolFee) / 100000000).toFixed(8)
      const feeKAS = (Number(poolFee) / 100000000).toFixed(8)

      console.log(`[Treasury] Coinbase matured: ${rewardKAS} KAS to miners, ${feeKAS} KAS pool fee`)
      this.emit('coinbase', reward - poolFee)
      this.emit('revenue', poolFee)
    })

    this.processor.start()
    console.log(`[Treasury] UTXO processor started, waiting for coinbase maturity events...`)
  }
}
