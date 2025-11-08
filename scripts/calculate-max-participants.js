// Calculate maximum CoinJoin participants based on transaction mass

const baseMass = 1000; // Base transaction overhead
const massPerInput = 1200; // Estimated mass per input (with signature script)
const massPerOutput = 400; // Estimated mass per output
const maxMass = 100000; // Maximum transaction mass limit

// From actual test: 10 participants = 16,054 mass
const actualMass10 = 16054;
const actualMassPerParticipant = actualMass10 / 10;

console.log('='.repeat(60));
console.log('CoinJoin Transaction Mass Analysis');
console.log('='.repeat(60));
console.log('');
console.log('Actual Test Data:');
console.log(`  10 participants: ${actualMass10} mass (${((actualMass10/maxMass)*100).toFixed(1)}%)`);
console.log(`  Mass per participant: ${actualMassPerParticipant.toFixed(2)}`);
console.log('');
console.log('Estimated Mass Breakdown:');
console.log(`  Base overhead: ${baseMass} mass`);
console.log(`  Per input (with signature): ~${massPerInput} mass`);
console.log(`  Per output: ~${massPerOutput} mass`);
console.log(`  Per participant (1 input + 1 output): ~${(massPerInput + massPerOutput)} mass`);
console.log('');
console.log('Maximum Participants Calculation:');
console.log('');

// Method 1: Linear scaling from actual data
const maxParticipantsActual = Math.floor(maxMass / actualMassPerParticipant);
console.log(`Method 1: Using actual measured rate`);
console.log(`  Maximum: ${maxParticipantsActual} participants`);
console.log(`  Estimated mass: ${(maxParticipantsActual * actualMassPerParticipant).toFixed(0)} mass`);
console.log('');

// Method 2: Conservative estimate with base overhead
const maxParticipantsConservative = Math.floor((maxMass - baseMass) / (massPerInput + massPerOutput));
const conservativeMass = baseMass + (maxParticipantsConservative * (massPerInput + massPerOutput));
console.log(`Method 2: Conservative estimate (with base overhead)`);
console.log(`  Maximum: ${maxParticipantsConservative} participants`);
console.log(`  Estimated mass: ${conservativeMass.toFixed(0)} mass (${((conservativeMass/maxMass)*100).toFixed(1)}%)`);
console.log('');

// Show projections for different participant counts
console.log('Projections for Different Participant Counts:');
console.log('─'.repeat(60));
console.log('Participants | Estimated Mass | Percentage of Max');
console.log('─'.repeat(60));

for (const participants of [10, 20, 30, 40, 50, 60, 62, 63]) {
  const estimatedMass = participants * actualMassPerParticipant;
  const percentage = (estimatedMass / maxMass) * 100;
  const status = percentage > 100 ? ' ❌ EXCEEDS' : percentage > 80 ? ' ⚠️  WARNING' : ' ✅ OK';
  console.log(`     ${participants.toString().padStart(2)}      |    ${estimatedMass.toFixed(0).padStart(6)}     |      ${percentage.toFixed(1).padStart(5)}%${status}`);
}

console.log('─'.repeat(60));
console.log('');
console.log('Recommendations:');
console.log(`  • Safe maximum: ${Math.floor(maxParticipantsActual * 0.9)} participants (90% safety margin)`);
console.log(`  • Theoretical maximum: ~${maxParticipantsActual} participants`);
console.log(`  • Conservative maximum: ${maxParticipantsConservative} participants`);
console.log('');
console.log('Note: Actual mass may vary slightly due to signature script sizes.');
console.log('      It is recommended to test with target participant counts before production use.');

