// Formatting utilities for GUI

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Format time duration
function formatDuration(ms) {
  if (!ms) return 'N/A';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Format large numbers with abbreviations
function formatNumber(num) {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toString();
}

// Format numbers with thousand separators
function formatNumberWithSeparators(num) {
  if (num === null || num === undefined) return 'N/A';
  return Number(num).toLocaleString('en-US');
}

// Format numbers with precision
function formatNumberPrecise(num, precision = 3) {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1e12) return (num / 1e12).toFixed(precision) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(precision) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(precision) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(precision) + 'K';
  return num.toString();
}

// Format hashrate
function formatHashrate(h) {
  if (!h || h === 0) return '0 H/s';
  if (h < 1000) return `${h.toFixed(2)} H/s`;
  if (h < 1000000) return `${(h / 1000).toFixed(2)} KH/s`;
  if (h < 1000000000) return `${(h / 1000000).toFixed(2)} MH/s`;
  const gh = h / 1000000000;
  if (gh >= 1000) return `${(gh / 1000).toFixed(2)} TH/s`;
  return `${gh.toFixed(2)} GH/s`;
}

// Format KAS amount
function formatKAS(amount) {
  if (typeof amount === 'bigint') {
    return (Number(amount) / 1e8).toFixed(8);
  }
  return (Number(amount) / 1e8).toFixed(8);
}

module.exports = {
  formatBytes,
  formatDuration,
  formatNumber,
  formatNumberWithSeparators,
  formatNumberPrecise,
  formatHashrate,
  formatKAS,
};

