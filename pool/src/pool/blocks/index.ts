import type { Contribution } from '../../stratum/stratum'
import type Database from '../database'
import type Rewarding from '../rewarding'
import type Treasury from '../../treasury'
import type Stratum from '../../stratum'
import type Monitoring from '../monitoring'

/**
 * BlockRecorder - Records blocks found by miners and verifies them in the chain
 * 
 * Responsibilities:
 * - Record blocks found by miners
 * - Verify blocks are in chain (filter orphaned/rejected blocks)
 * - Store all contributions for reward distribution
 * - Handle verification failures gracefully
 */
export default class BlockRecorder {
  constructor(
    private database: Database,
    private rewarding: Rewarding,
    private treasury: Treasury,
    private stratum: Stratum,
    private monitoring: Monitoring
  ) {}

  /**
   * Record a block found by a miner
   * 
   * @param hash Block hash
   * @param contribution Block finder's contribution
   */
  async recordBlock(hash: string, contribution: Contribution): Promise<void> {
    // Get contributions before clearing (record them first, then clear)
    const contributions = this.stratum.getContributions()
    
    // Add the block finder's contribution
    contributions.push(contribution)

    // Record all contributions for this block
    const contributorCount = this.rewarding.recordContributions(hash, contributions)
    
    // Clear contributions from memory after recording
    this.stratum.clearContributions()

    // Verify block is actually in the chain before recording
    try {
      const blockInfo = await this.treasury.processor.rpc.getBlock({ hash, includeTransactions: false }).catch(() => null)
      
      if (!blockInfo?.block) {
        // Block not found in chain - might be orphaned/rejected
        const addressWithPrefix = contribution.address.startsWith('kaspa:') ? contribution.address : `kaspa:${contribution.address}`
        this.monitoring.log(`⚠️ Block ${hash.substring(0, 16)}... submitted but not found in chain (may be orphaned/rejected)`)
        return // Don't record orphaned blocks
      }
      
      // Use hash from block header (canonical hash from node)
      const confirmedHash = blockInfo.block.header.hash || hash
      
      // Get DAA score from block header
      const header = blockInfo.block.header
      const daaScore = header?.daaScore 
        ? (typeof header.daaScore === 'bigint' 
            ? header.daaScore.toString() 
            : String(header.daaScore || '0'))
        : undefined
      
      // Block confirmed in chain - record it
      await this.saveBlock(confirmedHash, contribution, contributions, contributorCount, true, daaScore)
      
      const addressWithPrefix = contribution.address.startsWith('kaspa:') ? contribution.address : `kaspa:${contribution.address}`
      this.monitoring.log(`✓ Block ${confirmedHash.substring(0, 16)}... found by ${addressWithPrefix} (${contributorCount} contributor(s))`)
    } catch (err) {
      // If verification fails, still record it but warn
      const addressWithPrefix = contribution.address.startsWith('kaspa:') ? contribution.address : `kaspa:${contribution.address}`
      this.monitoring.log(`⚠️ Could not verify block ${hash.substring(0, 16)}... in chain: ${err instanceof Error ? err.message : String(err)}`)
      this.monitoring.log(`Recording block anyway - verify manually in explorer`)
      
      // Try to get DAA score even if verification failed
      let daaScore: string | undefined = undefined
      try {
        const blockInfo = await this.treasury.processor.rpc.getBlock({ hash, includeTransactions: false }).catch(() => null)
        if (blockInfo?.block?.header?.daaScore) {
          const headerDaa = blockInfo.block.header.daaScore
          daaScore = typeof headerDaa === 'bigint' ? headerDaa.toString() : String(headerDaa || '0')
        }
      } catch {
        // Ignore errors getting DAA score
      }
      
      // Store block even if verification failed
      await this.saveBlock(hash, contribution, contributions, contributorCount, false, daaScore)
    }
  }

  /**
   * Save block to database with all contributions
   */
  private async saveBlock(
    hash: string,
    contribution: Contribution,
    contributions: Contribution[],
    contributorCount: number,
    verified: boolean = true,
    daaScore?: string
  ): Promise<void> {
    // Block confirmed in chain - record it
    this.database.incrementBlockCount(contribution.address)
    
    // Store block details with all contributions (convert to database format)
    const contributionsForDb = contributions.map(c => ({
      address: c.address.replace(/^(kaspa:?|kaspatest:?)/i, ''),
      difficulty: c.difficulty.toString()
    }))
    
    this.database.addBlock({
      hash,
      address: contribution.address,
      timestamp: Date.now(),
      difficulty: contribution.difficulty.toString(),
      contributions: contributionsForDb,
      paid: false,
      daaScore
    })
  }
}

