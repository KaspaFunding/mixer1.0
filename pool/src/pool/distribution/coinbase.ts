import type { RpcClient } from '../../../wasm/kaspa'
import type Treasury from '../../treasury'
import type Monitoring from '../monitoring'

/**
 * CoinbaseFinder - Finds the coinbase UTXO value for a block using multi-stage fallback matching
 * 
 * Matching stages (in order):
 * 1. DAA score match (most reliable)
 * 2. Transaction ID match (fallback if UTXO spent)
 * 3. Script decoding match (find treasury address in outputs)
 * 4. Forwarded UTXO match (find forwarded coinbase by DAA score ±100)
 */
export default class CoinbaseFinder {
  constructor(
    private treasury: Treasury,
    private rpc: RpcClient,
    private monitoring: Monitoring
  ) {}

  /**
   * Find the coinbase value received by treasury for a block
   * Returns 0n if not found (caller should handle this case)
   */
  async findCoinbaseValue(
    blockHash: string,
    blockInfo: { block: { header: any, transactions: any[] } },
    coinbaseTx: any,
    storedDaaScore?: string  // Optional: DAA score from database (for persistence)
  ): Promise<{ value: bigint, found: boolean, method?: string }> {
    let coinbaseValue = 0n
    let found = false
    let method: string | undefined

    // Get block's DAA score to match UTXO (prefer stored DAA score from database)
    const header = blockInfo.block.header as any
    const blockDaaScore = storedDaaScore 
      ? BigInt(storedDaaScore)
      : (header?.daaScore 
          ? (typeof header.daaScore === 'bigint' 
              ? header.daaScore 
              : BigInt(String(header.daaScore || '0'))) 
          : undefined)

    // Stage 1: Match by DAA score (most reliable)
    if (blockDaaScore) {
      const result = await this.matchByDaaScore(blockDaaScore, blockHash)
      if (result.found) {
        coinbaseValue = result.value
        found = true
        method = 'daa_score'
        return { value: coinbaseValue, found, method }
      }
    }

    // Stage 2: Match by transaction ID (fallback if UTXO spent)
    if (!found) {
      const coinbaseTxId = (coinbaseTx as any).transactionId || (coinbaseTx as any).id || (coinbaseTx as any).txId || (coinbaseTx as any).txid
      if (coinbaseTxId) {
        const result = await this.matchByTransactionId(coinbaseTxId, blockHash)
        if (result.found) {
          coinbaseValue = result.value
          found = true
          method = 'transaction_id'
          return { value: coinbaseValue, found, method }
        }
      }
    }

    // Stage 3: Decode script public keys to find treasury address
    if (!found && coinbaseTx.outputs && coinbaseTx.outputs.length > 0) {
      const result = await this.matchByScriptDecoding(coinbaseTx, blockHash)
      if (result.found) {
        coinbaseValue = result.value
        found = true
        method = 'script_decoding'
        return { value: coinbaseValue, found, method }
      }
    }

    // Stage 4: Find forwarded UTXO by DAA score (if coinbase was forwarded)
    if (!found && blockDaaScore) {
      const result = await this.matchForwardedUtxo(blockDaaScore, blockHash)
      if (result.found) {
        coinbaseValue = result.value
        found = true
        method = 'forwarded_utxo'
        return { value: coinbaseValue, found, method }
      }
    }

    return { value: coinbaseValue, found, method }
  }

  /**
   * Stage 1: Match coinbase UTXO by DAA score
   */
  private async matchByDaaScore(
    blockDaaScore: bigint,
    blockHash: string
  ): Promise<{ value: bigint, found: boolean }> {
    try {
      const utxoResult = await this.rpc.getUtxosByAddresses({ addresses: [this.treasury.address] })
      if (utxoResult && utxoResult.entries && utxoResult.entries.length > 0) {
        for (const utxo of utxoResult.entries) {
          const utxoEntry = utxo as any
          const isCoinbase = utxoEntry.isCoinbase === true || utxoEntry.isCoinbase === 1
          const utxoDaaScoreValue = utxoEntry.blockDaaScore
          
          if (isCoinbase && utxoDaaScoreValue !== undefined) {
            const utxoDaaScore = typeof utxoDaaScoreValue === 'bigint' 
              ? utxoDaaScoreValue 
              : BigInt(String(utxoDaaScoreValue || '0'))
            
            // Match UTXO from same block (DAA score should match exactly for same block)
            if (utxoDaaScore === blockDaaScore) {
              const amount = typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(String(utxo.amount || '0'))
              this.monitoring.log(`[CoinbaseFinder] ✓ Found coinbase UTXO by DAA score (${blockDaaScore}): ${(Number(amount) / 100000000).toFixed(8)} KAS`)
              return { value: amount, found: true }
            }
          }
        }
      }
    } catch (error) {
      this.monitoring.log(`[CoinbaseFinder] ⚠️ Could not find coinbase UTXO by DAA score: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { value: 0n, found: false }
  }

  /**
   * Stage 2: Match coinbase UTXO by transaction ID
   */
  private async matchByTransactionId(
    coinbaseTxId: string,
    blockHash: string
  ): Promise<{ value: bigint, found: boolean }> {
    try {
      const utxoResult = await this.rpc.getUtxosByAddresses({ addresses: [this.treasury.address] })
      if (utxoResult && utxoResult.entries && utxoResult.entries.length > 0) {
        for (const utxo of utxoResult.entries) {
          const utxoEntry = utxo as any
          const isCoinbase = utxoEntry.isCoinbase === true || utxoEntry.isCoinbase === 1
          const utxoTxId = utxoEntry.outpoint?.transactionId || utxoEntry.transactionId || utxoEntry.txId || utxoEntry.txid
          
          if (isCoinbase && utxoTxId && String(utxoTxId).toLowerCase() === String(coinbaseTxId).toLowerCase()) {
            const amount = typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(String(utxo.amount || '0'))
            this.monitoring.log(`[CoinbaseFinder] ✓ Found coinbase UTXO by transaction ID: ${(Number(amount) / 100000000).toFixed(8)} KAS`)
            return { value: amount, found: true }
          }
        }
      }
    } catch (error) {
      this.monitoring.log(`[CoinbaseFinder] ⚠️ Could not find coinbase UTXO by transaction ID: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { value: 0n, found: false }
  }

  /**
   * Stage 3: Decode script public keys to find treasury address in outputs
   * Used when UTXO is already spent - match by address instead of amount
   */
  private async matchByScriptDecoding(
    coinbaseTx: any,
    blockHash: string
  ): Promise<{ value: bigint, found: boolean }> {
    this.monitoring.log(`[CoinbaseFinder] UTXO not found for block ${blockHash.substring(0, 16)}... (likely spent), decoding outputs to find treasury address`)
    
    try {
      const { addressFromScriptPublicKey } = await import('../../../wasm/kaspa')
      
      // Get full treasury address for comparison
      const treasuryAddressFull = this.treasury.address
      const treasuryAddressClean = treasuryAddressFull.replace(/^kaspa:?/i, '')
      
      this.monitoring.log(`[CoinbaseFinder] Treasury address (full): ${treasuryAddressFull}`)
      this.monitoring.log(`[CoinbaseFinder] Treasury address (cleaned): ${treasuryAddressClean}`)
      this.monitoring.log(`[CoinbaseFinder] Coinbase transaction has ${coinbaseTx.outputs.length} output(s), decoding all to find treasury...`)
      
      for (let i = 0; i < coinbaseTx.outputs.length; i++) {
        const output = coinbaseTx.outputs[i]
        const outputScript = (output as any).scriptPublicKey
        const outputValue = BigInt(String(output.value || '0'))
        
        if (outputScript) {
          try {
            // Decode address from script public key (try mainnet and testnet)
            let decodedAddressStr: string | null = null
            
            // Try mainnet
            try {
              const decodedAddress = addressFromScriptPublicKey(outputScript, 'mainnet')
              if (decodedAddress) {
                decodedAddressStr = decodedAddress.toString()
              }
            } catch (e) {
              // Try testnet if mainnet fails
              try {
                const decodedAddress = addressFromScriptPublicKey(outputScript, 'testnet-10')
                if (decodedAddress) {
                  decodedAddressStr = decodedAddress.toString()
                }
              } catch (e2) {
                // Log if both fail
                this.monitoring.log(`[CoinbaseFinder]   Output ${i + 1}: Failed to decode with both mainnet and testnet`)
              }
            }
            
            if (decodedAddressStr) {
              const decodedClean = decodedAddressStr.replace(/^kaspa:?/i, '')
              const treasuryClean = treasuryAddressClean
              
              // Compare addresses
              const exactMatch = decodedAddressStr.toLowerCase() === treasuryAddressFull.toLowerCase()
              const cleanMatch = decodedClean.toLowerCase() === treasuryClean.toLowerCase()
              const matches = exactMatch || cleanMatch
              
              // Log addresses for debugging
              this.monitoring.log(`[CoinbaseFinder]   Output ${i + 1}: ${(Number(outputValue) / 100000000).toFixed(8)} KAS`)
              this.monitoring.log(`[CoinbaseFinder]     Decoded (full): ${decodedAddressStr}`)
              this.monitoring.log(`[CoinbaseFinder]     Decoded (clean): ${decodedClean}`)
              this.monitoring.log(`[CoinbaseFinder]     Treasury (full): ${treasuryAddressFull}`)
              this.monitoring.log(`[CoinbaseFinder]     Treasury (clean): ${treasuryClean}`)
              this.monitoring.log(`[CoinbaseFinder]     Match: ${matches ? '✓ YES - MATCHES TREASURY' : '✗ NO'}`)
              
              if (matches) {
                this.monitoring.log(`[CoinbaseFinder] ✓ Found treasury output (index ${i + 1}) by address match: ${(Number(outputValue) / 100000000).toFixed(8)} KAS`)
                return { value: outputValue, found: true }
              }
            } else {
              this.monitoring.log(`[CoinbaseFinder]   Output ${i + 1}: Could not decode address from script`)
            }
          } catch (decodeError) {
            // Log decode failures
            this.monitoring.log(`[CoinbaseFinder]   Output ${i + 1}: Could not decode script: ${decodeError instanceof Error ? decodeError.message : String(decodeError)}`)
          }
        } else {
          this.monitoring.log(`[CoinbaseFinder]   Output ${i + 1}: No script public key in output`)
        }
      }
    } catch (importError) {
      this.monitoring.log(`[CoinbaseFinder] ⚠️ CRITICAL: Could not import addressFromScriptPublicKey: ${importError instanceof Error ? importError.message : String(importError)}`)
      this.monitoring.log(`[CoinbaseFinder] ⚠️ Cannot process block ${blockHash.substring(0, 16)}... without script decoding.`)
    }
    
    return { value: 0n, found: false }
  }

  /**
   * Stage 4: Find forwarded coinbase UTXO by matching DAA score in treasury's UTXO set
   * The coinbase may have been forwarded to treasury via a secondary transaction
   */
  private async matchForwardedUtxo(
    blockDaaScore: bigint,
    blockHash: string
  ): Promise<{ value: bigint, found: boolean }> {
    this.monitoring.log(`[CoinbaseFinder] ⚠️ Treasury address not found in coinbase outputs (likely forwarded via secondary tx)`)
    this.monitoring.log(`[CoinbaseFinder] ⚠️ Attempting to find forwarded amount by matching DAA score in treasury's UTXO set...`)
    
    try {
      const utxoResult = await this.rpc.getUtxosByAddresses({ addresses: [this.treasury.address] })
      if (utxoResult && utxoResult.entries && utxoResult.entries.length > 0) {
        this.monitoring.log(`[CoinbaseFinder] Checking ${utxoResult.entries.length} UTXO(s) for DAA score match (block DAA: ${blockDaaScore})...`)
        
        // Look for UTXO with matching DAA score (may have been forwarded)
        let bestMatch: { utxo: any, diff: bigint, amount: bigint } | null = null
        
        for (const utxo of utxoResult.entries) {
          const utxoEntry = utxo as any
          const utxoDaaScoreValue = utxoEntry.blockDaaScore
          if (utxoDaaScoreValue !== undefined) {
            const utxoDaaScore = typeof utxoDaaScoreValue === 'bigint' 
              ? utxoDaaScoreValue 
              : BigInt(String(utxoDaaScoreValue || '0'))
            
            const daaScoreDiff = utxoDaaScore > blockDaaScore ? utxoDaaScore - blockDaaScore : blockDaaScore - utxoDaaScore
            const amount = typeof utxo.amount === 'bigint' ? utxo.amount : BigInt(String(utxo.amount || '0'))
            
            // Log UTXOs for debugging
            this.monitoring.log(`[CoinbaseFinder]   UTXO: ${(Number(amount) / 100000000).toFixed(8)} KAS, DAA: ${utxoDaaScore}, Diff: ${daaScoreDiff}`)
            
            // Prefer closest match
            if (daaScoreDiff <= 100n) { // Allow up to 100 DAA score difference for forwarding delays
              if (!bestMatch || daaScoreDiff < bestMatch.diff) {
                bestMatch = { utxo, diff: daaScoreDiff, amount }
              }
            }
          }
        }
        
        // Use the best match if found
        if (bestMatch) {
          const utxoDaaScore = typeof bestMatch.utxo.blockDaaScore === 'bigint' 
            ? bestMatch.utxo.blockDaaScore 
            : BigInt(String(bestMatch.utxo.blockDaaScore || '0'))
          this.monitoring.log(`[CoinbaseFinder] ✓ Found forwarded coinbase UTXO (DAA score ${utxoDaaScore}, block ${blockDaaScore}, diff ${bestMatch.diff}): ${(Number(bestMatch.amount) / 100000000).toFixed(8)} KAS`)
          return { value: bestMatch.amount, found: true }
        }
      } else {
        this.monitoring.log(`[CoinbaseFinder] No UTXOs found in treasury address (all may be spent)`)
      }
    } catch (error) {
      this.monitoring.log(`[CoinbaseFinder] ⚠️ Error checking for forwarded UTXO: ${error instanceof Error ? error.message : String(error)}`)
    }
    
    return { value: 0n, found: false }
  }
}

