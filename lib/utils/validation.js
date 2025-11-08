// Validation utilities for addresses, amounts, and other inputs

const { kaspa } = require('../config');

// Validate Kaspa address
function validateAddress(address) {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Address must be a non-empty string' };
  }
  if (!kaspa.Address.validate(address)) {
    return { valid: false, error: `Invalid Kaspa address: ${address}` };
  }
  return { valid: true };
}

// Validate amount in KAS and convert to sompi
function validateAndConvertAmount(amountKAS, minAmount = 0.00001) {
  if (typeof amountKAS !== 'number' || isNaN(amountKAS) || amountKAS <= 0) {
    return { valid: false, error: 'Amount must be a positive number in KAS' };
  }
  
  const amountSompi = Math.round(amountKAS * 1e8);
  const minSompi = Math.round(minAmount * 1e8);
  
  if (amountSompi < minSompi) {
    return { 
      valid: false, 
      error: `Amount too small. Minimum is ${minAmount} KAS (dust threshold)` 
    };
  }
  
  return { valid: true, amountSompi, amountKAS };
}

// Validate destination for mixing session
function validateDestination(destination) {
  if (!destination.address || typeof destination.address !== 'string') {
    return { valid: false, error: 'Invalid destination address' };
  }
  
  const addressValidation = validateAddress(destination.address);
  if (!addressValidation.valid) {
    return addressValidation;
  }
  
  const destAmount = BigInt(destination.amount || 0);
  if (destAmount <= 0n) {
    return { valid: false, error: `Invalid destination amount: ${destination.amount}` };
  }
  
  return { valid: true, amount: destAmount };
}

// Validate multiple destinations
function validateDestinations(destinations, maxCount = 10) {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    return { valid: false, error: 'At least one destination address is required' };
  }
  
  if (destinations.length > maxCount) {
    return { valid: false, error: `Maximum ${maxCount} destinations allowed per mix` };
  }
  
  const validated = [];
  let totalAmount = 0n;
  
  for (const dest of destinations) {
    const validation = validateDestination(dest);
    if (!validation.valid) {
      return validation;
    }
    validated.push(dest);
    totalAmount += validation.amount;
  }
  
  return { valid: true, destinations: validated, totalAmount };
}

// Validate total amount matches sum of destinations
function validateTotalAmount(destinations, expectedAmount) {
  const totalAmount = destinations.reduce((sum, d) => sum + BigInt(d.amount), 0n);
  const expected = BigInt(expectedAmount);
  
  if (totalAmount !== expected) {
    return { 
      valid: false, 
      error: `Sum of destination amounts (${totalAmount}) does not equal total amount (${expected})` 
    };
  }
  
  return { valid: true, totalAmount };
}

module.exports = {
  validateAddress,
  validateAndConvertAmount,
  validateDestination,
  validateDestinations,
  validateTotalAmount,
};

