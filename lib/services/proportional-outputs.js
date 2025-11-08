// Proportional output distribution service

// Calculate proportion for each destination
function calculateProportions(destinations) {
  const totalRequested = destinations.reduce((sum, d) => sum + BigInt(d.amount), 0n);
  return destinations.map(d => ({
    address: d.address,
    proportion: Number(BigInt(d.amount)) / Number(totalRequested),
    requestedAmount: BigInt(d.amount)
  }));
}

// Calculate proportional amount for a single output
function calculateProportionalAmount(availableAfterFee, proportion, isLast) {
  if (isLast) {
    return availableAfterFee;
  }
  return (availableAfterFee * BigInt(Math.floor(proportion * 1000000000))) / 1000000000n;
}

// Ensure minimum dust threshold
function ensureMinimumAmount(amount, minAmount = 1000n) {
  return amount < minAmount ? minAmount : amount;
}

// Create proportional output amounts
function createProportionalOutputs(destinations, availableAfterFee) {
  const outputs = calculateProportions(destinations);
  const outputsWithAmounts = [];
  let remaining = availableAfterFee;

  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    const isLast = i === outputs.length - 1;
    
    // For last output, use remaining amount. For others, calculate proportionally
    let amount;
    if (isLast) {
      amount = remaining; // Use whatever is left
    } else {
      amount = calculateProportionalAmount(availableAfterFee, o.proportion, false);
      // Ensure we don't exceed remaining
      if (amount > remaining) {
        amount = remaining;
      }
      remaining -= amount;
    }
    
    amount = ensureMinimumAmount(amount);
    outputsWithAmounts.push({ address: o.address, amount });
  }

  // Verify total doesn't exceed availableAfterFee
  const totalOutputAmount = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
  
  if (totalOutputAmount > availableAfterFee) {
    // This shouldn't happen, but if it does, reduce last output
    const excess = totalOutputAmount - availableAfterFee;
    if (outputsWithAmounts.length > 0) {
      const lastOutput = outputsWithAmounts[outputsWithAmounts.length - 1];
      lastOutput.amount = ensureMinimumAmount(lastOutput.amount - excess);
    }
  } else if (totalOutputAmount < availableAfterFee && outputsWithAmounts.length > 0) {
    // Add rounding remainder to last output
    const remainder = availableAfterFee - totalOutputAmount;
    outputsWithAmounts[outputsWithAmounts.length - 1].amount += remainder;
  }

  // Final verification
  const finalTotal = outputsWithAmounts.reduce((sum, o) => sum + o.amount, 0n);
  if (finalTotal !== availableAfterFee) {
    console.warn(`Warning: Output total ${finalTotal} does not match available ${availableAfterFee}, adjusting last output`);
    if (outputsWithAmounts.length > 0) {
      const diff = availableAfterFee - finalTotal;
      outputsWithAmounts[outputsWithAmounts.length - 1].amount += diff;
    }
  }

  return outputsWithAmounts;
}

// Adjust outputs when fee increases
function adjustOutputsForFeeIncrease(outputs, newAvailableAfterFee) {
  if (outputs.length === 0) {
    return [];
  }
  
  const totalOutputAmount = outputs.reduce((sum, o) => sum + o.amount, 0n);
  
  // If total is already correct, return as-is
  if (totalOutputAmount === newAvailableAfterFee) {
    return outputs;
  }
  
  let newRemaining = newAvailableAfterFee;
  const adjusted = [];

  // Calculate proportional amounts based on original proportions
  for (let idx = 0; idx < outputs.length; idx++) {
    const o = outputs[idx];
    const isLast = idx === outputs.length - 1;
    
    let newAmount;
    if (isLast) {
      // Last output gets whatever is remaining
      newAmount = newRemaining;
    } else {
      // Calculate proportion based on original output amounts
      const proportion = Number(o.amount) / Number(totalOutputAmount);
      newAmount = (newAvailableAfterFee * BigInt(Math.floor(proportion * 1000000000))) / 1000000000n;
      
      // Ensure we don't exceed remaining
      if (newAmount > newRemaining) {
        newAmount = newRemaining;
      }
      
      newRemaining -= newAmount;
    }
    
    // Ensure minimum amount, but don't let it exceed remaining
    newAmount = ensureMinimumAmount(newAmount);
    if (newAmount > newRemaining && !isLast) {
      newAmount = newRemaining;
      newRemaining = 0n;
    }
    
    adjusted.push({ address: o.address, amount: newAmount });
  }

  // Final verification and adjustment
  const finalTotal = adjusted.reduce((sum, o) => sum + o.amount, 0n);
  
  if (finalTotal > newAvailableAfterFee) {
    // Reduce last output to fix excess
    const excess = finalTotal - newAvailableAfterFee;
    if (adjusted.length > 0) {
      adjusted[adjusted.length - 1].amount = ensureMinimumAmount(adjusted[adjusted.length - 1].amount - excess);
    }
  } else if (finalTotal < newAvailableAfterFee) {
    // Add remainder to last output
    const remainder = newAvailableAfterFee - finalTotal;
    if (adjusted.length > 0) {
      adjusted[adjusted.length - 1].amount += remainder;
    }
  }

  // Final safety check
  const verifiedTotal = adjusted.reduce((sum, o) => sum + o.amount, 0n);
  if (verifiedTotal !== newAvailableAfterFee) {
    console.warn(`Warning: Adjusted output total ${verifiedTotal} does not match available ${newAvailableAfterFee}, fixing last output`);
    if (adjusted.length > 0) {
      const diff = newAvailableAfterFee - verifiedTotal;
      adjusted[adjusted.length - 1].amount += diff;
    }
  }

  return adjusted;
}

module.exports = {
  createProportionalOutputs,
  adjustOutputsForFeeIncrease,
};

