// === State ===
let requests = [];
let selectedId = null;
let totalCount = 0;
let loadedCount = 0;
let ws = null;
let reconnectDelay = 1000;
let loading = false;

// === DOM ===
const $ = (s) => document.querySelector(s);
const requestList = $('#request-list');
const detailPanel = $('#detail');
const placeholder = $('#placeholder');
const counter = $('#counter');
const connectionStatus = $('#connection-status');
const curlExample = $('#curl-example');
const placeholderCurl = $('#placeholder-curl');
const copyBtn = $('#copy-curl-btn');
const clearBtn = $('#clear-btn');
const sidebar = $('#sidebar');

// === Init ===
const curlText = `curl -X POST ${location.origin}/hook \\
  -H "Content-Type: application/json" \\
  -d '{"hello":"world"}'`;
curlExample.textContent = curlText;
placeholderCurl.textContent = curlText;

copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(curlText.replace(/\\\n\s*/g, ''));
  copyBtn.innerHTML = '<i class="bx bx-check mr-1"></i>Copied!';
  setTimeout(() => { copyBtn.innerHTML = '<i class="bx bx-copy mr-1"></i>Copy'; }, 1500);
});

clearBtn.addEventListener('click', async () => {
  await fetch('/api/requests', { method: 'DELETE' });
  requests = [];
  totalCount = 0;
  loadedCount = 0;
  selectedId = null;
  renderList();
  showPlaceholder();
  updateCounter();
});

// === Infinite scroll ===
const scrollObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !loading && loadedCount < totalCount) {
    loadMore();
  }
}, { root: sidebar, threshold: 0.1 });
scrollObserver.observe($('#load-more-sentinel'));

function loadMore() {
  if (loading || requests.length === 0) return;
  const oldest = requests[requests.length - 1];
  if (!oldest) return;
  loading = true;
  ws?.send(JSON.stringify({ type: 'load_more', before: oldest.timestamp }));
}

// === WebSocket ===
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    setStatus('connected');
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'history') {
      handleHistory(msg);
    } else if (msg.type === 'new') {
      handleNew(msg.request);
    }
  };

  ws.onclose = () => {
    setStatus('reconnecting');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect();
    }, reconnectDelay);
  };

  ws.onerror = () => ws.close();
}

function setStatus(state) {
  const dot = connectionStatus.querySelector('span:first-child');
  const text = connectionStatus.querySelector('span:last-child');
  if (state === 'connected') {
    dot.className = 'w-2 h-2 rounded-full bg-green-400';
    text.textContent = 'Connected';
  } else if (state === 'reconnecting') {
    dot.className = 'w-2 h-2 rounded-full bg-yellow-400';
    text.textContent = 'Reconnecting...';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-red-400';
    text.textContent = 'Disconnected';
  }
}

function handleHistory(msg) {
  const isInitial = requests.length === 0;
  totalCount = msg.total;

  // Deduplicate by id
  const existingIds = new Set(requests.map(r => r.id));
  const newReqs = msg.requests.filter(r => !existingIds.has(r.id));
  requests.push(...newReqs);
  loadedCount = requests.length;

  if (isInitial) {
    renderList();
  } else {
    newReqs.forEach(r => appendListItem(r));
  }
  loading = false;
  updateCounter();
}

function handleNew(req) {
  // Deduplicate
  if (requests.some(r => r.id === req.id)) return;
  requests.unshift(req);
  totalCount++;
  loadedCount++;
  prependListItem(req);
  updateCounter();
}

function updateCounter() {
  counter.textContent = `${loadedCount} / ${totalCount}`;
}

// === Render list ===
function renderList() {
  requestList.innerHTML = '';
  requests.forEach(r => appendListItem(r));
}

function createListItem(req) {
  const div = document.createElement('div');
  div.className = `px-3 py-2.5 cursor-pointer hover:bg-slate-800/50 transition-colors ${req.id === selectedId ? 'bg-slate-800 border-l-2 border-blue-500' : 'border-l-2 border-transparent'}`;
  div.dataset.id = req.id;

  const methodColor = {
    GET: 'bg-green-900/60 text-green-300',
    POST: 'bg-blue-900/60 text-blue-300',
    PUT: 'bg-orange-900/60 text-orange-300',
    DELETE: 'bg-red-900/60 text-red-300',
    PATCH: 'bg-purple-900/60 text-purple-300',
  }[req.method] || 'bg-slate-700 text-slate-300';

  const time = new Date(req.timestamp);
  const ts = time.toTimeString().slice(0, 8);
  const shortId = req.id.slice(0, 8);

  div.innerHTML = `
    <div class="flex items-center gap-2">
      <span class="px-1.5 py-0.5 text-xs font-bold rounded ${methodColor}">${req.method}</span>
      <span class="text-xs text-slate-500 ml-auto">${ts}</span>
    </div>
    <div class="mt-1 text-xs text-slate-400 truncate">${escapeHtml(req.url)}</div>
    <div class="mt-0.5 text-xs text-slate-600">${shortId}</div>
  `;

  div.addEventListener('click', () => selectRequest(req.id));
  return div;
}

function appendListItem(req) {
  requestList.appendChild(createListItem(req));
}

function prependListItem(req) {
  requestList.prepend(createListItem(req));
}

function selectRequest(id) {
  selectedId = id;
  // Update active state in list
  requestList.querySelectorAll('[data-id]').forEach(el => {
    if (el.dataset.id === id) {
      el.className = el.className.replace('border-transparent', 'border-blue-500').replace('hover:bg-slate-800/50', 'bg-slate-800');
      if (!el.className.includes('bg-slate-800')) el.className += ' bg-slate-800';
    } else {
      el.className = el.className.replace('border-blue-500', 'border-transparent').replace('bg-slate-800', 'hover:bg-slate-800/50');
    }
  });
  renderDetail();
}

// === Detail view ===
function showPlaceholder() {
  placeholder.classList.remove('hidden');
  detailPanel.classList.add('hidden');
}

function renderDetail() {
  const req = requests.find(r => r.id === selectedId);
  if (!req) { showPlaceholder(); return; }

  placeholder.classList.add('hidden');
  detailPanel.classList.remove('hidden');

  const time = new Date(req.timestamp);
  const fullTime = `${time.getFullYear()}-${pad(time.getMonth()+1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;

  const methodColor = {
    GET: 'bg-green-900/60 text-green-300',
    POST: 'bg-blue-900/60 text-blue-300',
    PUT: 'bg-orange-900/60 text-orange-300',
    DELETE: 'bg-red-900/60 text-red-300',
    PATCH: 'bg-purple-900/60 text-purple-300',
  }[req.method] || 'bg-slate-700 text-slate-300';

  const headers = JSON.parse(req.headers);
  const contentType = (headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';

  let bodySection = '';
  if (req.body_size === 0) {
    bodySection = `<div class="text-slate-500 italic">Empty</div>`;
  } else {
    bodySection = `
      <div class="flex gap-1 mb-3" id="body-tabs">
        <button class="tab-btn px-3 py-1 text-xs rounded" data-tab="parsed">Parsed</button>
        <button class="tab-btn px-3 py-1 text-xs rounded" data-tab="raw">Raw</button>
      </div>
      <div id="body-parsed">${renderParsedBody(req.body, contentType, headers)}</div>
      <div id="body-raw" class="hidden">${renderRawBody(req.body, headers)}</div>
    `;
  }

  detailPanel.innerHTML = `
    <div class="space-y-4">
      <!-- Header -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <span class="px-2 py-1 text-sm font-bold rounded ${methodColor}">${req.method}</span>
          <span class="text-slate-400 text-xs">${fullTime}</span>
        </div>
        <div class="flex items-center gap-2">
          <button id="download-btn" class="px-2.5 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded text-slate-300 transition-colors ${req.body_size === 0 ? 'opacity-50 cursor-not-allowed' : ''}" ${req.body_size === 0 ? 'disabled' : ''}>
            <i class="bx bx-download mr-1"></i>Download
          </button>
          <button id="delete-btn" class="px-2.5 py-1.5 text-xs bg-red-900/50 hover:bg-red-900 text-red-300 rounded border border-red-800/50 transition-colors">
            <i class="bx bx-trash mr-1"></i>Delete
          </button>
        </div>
      </div>

      <!-- UUID -->
      <div class="text-xs text-slate-500">${req.id}</div>

      <!-- URL -->
      <div>
        <div class="text-xs text-slate-500 mb-1">URL</div>
        <div class="bg-slate-900 rounded px-3 py-2 text-sm break-all">${escapeHtml(req.url)}</div>
      </div>

      <!-- Headers -->
      <div>
        <div class="text-xs text-slate-500 mb-1">Headers</div>
        <div class="bg-slate-900 rounded overflow-hidden">
          <table class="w-full text-xs">
            ${headers.map(([k, v]) => `<tr class="border-b border-slate-800/50"><td class="px-3 py-1.5 text-sky-300 whitespace-nowrap align-top">${escapeHtml(k)}</td><td class="px-3 py-1.5 text-slate-300 break-all">${escapeHtml(v)}</td></tr>`).join('')}
          </table>
        </div>
      </div>

      <!-- Body -->
      <div>
        <div class="text-xs text-slate-500 mb-1">Body <span class="text-slate-600">(${formatSize(req.body_size)})</span></div>
        ${bodySection}
      </div>
    </div>
  `;

  // Tab switching
  const tabs = detailPanel.querySelectorAll('.tab-btn');
  const parsedDiv = $('#body-parsed');
  const rawDiv = $('#body-raw');
  if (tabs.length) {
    setActiveTab('parsed');
    tabs.forEach(btn => {
      btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
    });
  }

  function setActiveTab(tab) {
    tabs.forEach(b => {
      b.className = `tab-btn px-3 py-1 text-xs rounded ${b.dataset.tab === tab ? 'bg-blue-900/60 text-blue-300' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`;
    });
    if (parsedDiv) parsedDiv.classList.toggle('hidden', tab !== 'parsed');
    if (rawDiv) rawDiv.classList.toggle('hidden', tab !== 'raw');
  }

  // Delete button
  $('#delete-btn')?.addEventListener('click', async () => {
    await fetch(`/api/requests/${req.id}`, { method: 'DELETE' });
    requests = requests.filter(r => r.id !== req.id);
    totalCount--;
    loadedCount--;
    selectedId = null;
    renderList();
    showPlaceholder();
    updateCounter();
  });

  // Download button
  if (req.body_size > 0) {
    $('#download-btn')?.addEventListener('click', () => downloadBody(req));
  }
}

// === Raw body ===
function renderRawBody(bodyB64, headers) {
  const headersText = headers.map(([k, v]) => `${k}: ${v}`).join('\n');
  let bodyText;
  try {
    const bytes = base64ToBytes(bodyB64);
    bodyText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    bodyText = '[Binary data]';
  }
  return `<div class="bg-slate-900 rounded p-3"><pre class="text-xs text-slate-300 whitespace-pre-wrap">${escapeHtml(headersText)}\n\n${escapeHtml(bodyText)}</pre></div>`;
}

// === Parsed body ===
function renderParsedBody(bodyB64, contentType, headers) {
  const ct = contentType.toLowerCase();

  if (!contentType) {
    return renderAsText(bodyB64);
  }

  if (ct.includes('application/json')) {
    return renderJson(bodyB64);
  }

  if (ct.includes('text/') || ct.includes('application/xml') || ct.includes('text/xml')) {
    return renderAsText(bodyB64);
  }

  if (ct.startsWith('image/')) {
    return renderImage(bodyB64, contentType);
  }

  if (ct.includes('application/pdf')) {
    return renderDownloadable('PDF Document', 'bx-file', '.pdf', bodyB64, contentType);
  }

  if (ct.includes('application/x-www-form-urlencoded')) {
    return renderFormUrlEncoded(bodyB64);
  }

  if (ct.includes('multipart/form-data')) {
    return renderMultipart(bodyB64, contentType);
  }

  return renderDownloadable('Unknown binary', 'bx-file-blank', '.bin', bodyB64, contentType);
}

function renderAsText(bodyB64) {
  try {
    const text = atob(bodyB64);
    return `<div class="bg-slate-900 rounded p-3"><pre class="text-xs text-slate-300 whitespace-pre-wrap">${escapeHtml(text)}</pre></div>`;
  } catch {
    return `<div class="text-slate-500 italic">Unable to decode</div>`;
  }
}

function renderJson(bodyB64) {
  try {
    const text = atob(bodyB64);
    const obj = JSON.parse(text);
    return `<div class="bg-slate-900 rounded p-3 text-xs">${jsonTree(obj, true)}</div>`;
  } catch {
    return renderAsText(bodyB64);
  }
}

function jsonTree(val, expanded = false, depth = 0) {
  if (val === null) return `<span class="json-null">null</span>`;
  if (typeof val === 'boolean') return `<span class="json-bool">${val}</span>`;
  if (typeof val === 'number') return `<span class="json-number">${val}</span>`;
  if (typeof val === 'string') return `<span class="json-string">"${escapeHtml(val)}"</span>`;

  if (Array.isArray(val)) {
    if (val.length === 0) return '<span class="text-slate-500">[]</span>';
    const items = val.map((v, i) => `<div class="ml-4">${jsonTree(v, false, depth + 1)}${i < val.length - 1 ? ',' : ''}</div>`).join('');
    return `<details ${expanded ? 'open' : ''}><summary class="text-slate-500 hover:text-slate-300">Array(${val.length}) [</summary>${items}<span class="text-slate-500">]</span></details>`;
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '<span class="text-slate-500">{}</span>';
    const items = keys.map((k, i) => `<div class="ml-4"><span class="json-key">"${escapeHtml(k)}"</span>: ${jsonTree(val[k], false, depth + 1)}${i < keys.length - 1 ? ',' : ''}</div>`).join('');
    return `<details ${expanded ? 'open' : ''}><summary class="text-slate-500 hover:text-slate-300">Object(${keys.length}) {</summary>${items}<span class="text-slate-500">}</span></details>`;
  }

  return escapeHtml(String(val));
}

function renderImage(bodyB64, contentType) {
  return `<div class="bg-slate-900 rounded p-3 text-center"><img src="data:${contentType};base64,${bodyB64}" class="max-w-full max-h-96 inline-block rounded" alt="Image"></div>`;
}

function renderDownloadable(label, icon, ext, bodyB64, contentType) {
  return `
    <div class="bg-slate-900 rounded p-4 flex items-center gap-3">
      <i class="bx ${icon} text-3xl text-slate-500"></i>
      <div>
        <div class="text-sm text-slate-300">${label}</div>
        <div class="text-xs text-slate-500">${contentType}</div>
      </div>
    </div>
  `;
}

function renderFormUrlEncoded(bodyB64) {
  try {
    const text = atob(bodyB64);
    const params = new URLSearchParams(text);
    let rows = '';
    for (const [k, v] of params) {
      rows += `<tr class="border-b border-slate-800/50"><td class="px-3 py-1.5 text-sky-300 whitespace-nowrap align-top">${escapeHtml(k)}</td><td class="px-3 py-1.5 text-slate-300 break-all">${escapeHtml(v)}</td></tr>`;
    }
    return `<div class="bg-slate-900 rounded overflow-hidden"><table class="w-full text-xs">${rows}</table></div>`;
  } catch {
    return renderAsText(bodyB64);
  }
}

function renderMultipart(bodyB64, contentType) {
  try {
    const bytes = base64ToBytes(bodyB64);
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
    if (!boundaryMatch) return renderAsText(bodyB64);
    const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '');

    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const parts = text.split('--' + boundary).slice(1);
    let html = '';

    for (const part of parts) {
      if (part.trim() === '--' || part.trim() === '') continue;
      const sepIdx = part.indexOf('\r\n\r\n');
      if (sepIdx === -1) continue;
      const headerSection = part.slice(0, sepIdx);
      const bodySection = part.slice(sepIdx + 4).replace(/\r\n$/, '');

      const disposition = headerSection.match(/Content-Disposition:\s*form-data;\s*(.*)/i);
      const partContentType = (headerSection.match(/Content-Type:\s*(.+)/i) || [])[1]?.trim();

      let name = '';
      let filename = '';
      if (disposition) {
        const nameMatch = disposition[1].match(/name="([^"]+)"/);
        const fileMatch = disposition[1].match(/filename="([^"]+)"/);
        if (nameMatch) name = nameMatch[1];
        if (fileMatch) filename = fileMatch[1];
      }

      html += `<div class="bg-slate-900 rounded p-3 mb-2">`;
      html += `<div class="flex items-center gap-2 mb-1">`;
      if (name) html += `<span class="text-sky-300 text-xs font-bold">${escapeHtml(name)}</span>`;
      if (filename) html += `<span class="text-slate-500 text-xs">${escapeHtml(filename)}</span>`;
      if (partContentType) html += `<span class="text-slate-600 text-xs ml-auto">${escapeHtml(partContentType)}</span>`;
      html += `</div>`;

      if (filename && partContentType && !partContentType.startsWith('text/')) {
        html += `<div class="text-xs text-slate-500">[binary: ${escapeHtml(filename)}, ${formatSize(bodySection.length)}]</div>`;
      } else {
        html += `<pre class="text-xs text-slate-300 whitespace-pre-wrap">${escapeHtml(bodySection)}</pre>`;
      }
      html += `</div>`;
    }

    return html || renderAsText(bodyB64);
  } catch {
    return renderAsText(bodyB64);
  }
}

// === Download ===
function downloadBody(req) {
  const headers = JSON.parse(req.headers);
  const contentType = (headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || 'application/octet-stream';
  const contentDisposition = (headers.find(([k]) => k.toLowerCase() === 'content-disposition') || [])[1] || '';

  let filename = '';
  const fnMatch = contentDisposition.match(/filename="?([^";]+)"?/);
  if (fnMatch) {
    filename = fnMatch[1];
  } else {
    const time = new Date(req.timestamp);
    const ts = `${time.getFullYear()}_${pad(time.getMonth()+1)}_${pad(time.getDate())}_${pad(time.getHours())}_${pad(time.getMinutes())}_${pad(time.getSeconds())}`;
    const ext = mimeToExt(contentType);
    filename = `${ts}${ext}`;
  }

  const bytes = base64ToBytes(req.body);
  const blob = new Blob([bytes], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function mimeToExt(mime) {
  const m = mime.toLowerCase().split(';')[0].trim();
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/json': '.json',
    'application/pdf': '.pdf',
    'application/xml': '.xml',
    'text/xml': '.xml',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/css': '.css',
    'application/javascript': '.js',
  };
  return map[m] || '.bin';
}

// === Utilities ===
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// === Start ===
connect();
