// DOM manipulation utilities

// HTML escape helper
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Show status message
function showMessage(text, type = 'info', duration = 5000) {
  const msg = document.getElementById('status-message');
  if (!msg) return;
  
  if (text.includes('<') && text.includes('>')) {
    msg.innerHTML = text;
  } else {
    msg.textContent = text;
  }
  msg.className = `status-message ${type}`;
  msg.classList.remove('hidden');
  setTimeout(() => {
    msg.classList.add('hidden');
  }, duration);
}

// Create port badge element
function createPortBadge(label, port, active, tooltip) {
  const badge = document.createElement('div');
  badge.className = `port-badge ${active ? 'port-active' : 'port-inactive'}`;
  badge.title = tooltip || `${label} Port ${port}`;
  
  badge.innerHTML = `
    <span class="port-label">${label}</span>
    <span class="port-number">${port}</span>
  `;
  
  return badge;
}

module.exports = {
  escapeHtml,
  showMessage,
  createPortBadge,
};

