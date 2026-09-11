pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const RENDER_SCALE = 2.0; // canvas px per PDF point — higher = sharper + more precise flood fill
const WALL_LUMINANCE_THRESHOLD = 140; // below this = "ink" (wall/line), above = "open space"

const el = (id) => document.getElementById(id);
const fileInput = el('fileInput');
const projectList = el('projectList');
const oneClickBtn = el('oneClickBtn');
const calibrateBtn = el('calibrateBtn');
const clearBtn = el('clearBtn');
const saveBtn = el('saveBtn');
const scaleInfo = el('scaleInfo');
const statusBar = el('statusBar');
const canvasWrap = el('canvasWrap');
const pdfCanvas = el('pdfCanvas');
const overlayCanvas = el('overlayCanvas');
const emptyState = el('emptyState');

const saveModal = el('saveModal');
const nameInput = el('nameInput');
const descInput = el('descInput');
const calibrateModal = el('calibrateModal');
const realLengthInput = el('realLengthInput');

let state = {
  fileId: null,        // server-side id for the uploaded PDF (set after upload)
  fileUrl: null,        // /uploads/xxx.pdf
  pdfDoc: null,          // pdfjs document
  pageNumber: 1,
  pageWidth: 0,
  pageHeight: 0,          // canvas px dimensions at RENDER_SCALE
  pdfImageData: null,      // ImageData snapshot of the rendered drawing (flood fill reads this, never the overlay)
  metersPerPixel: null,     // current scale, however it was derived
  scaleSource: null,         // 'auto' | 'manual'
  mode: null,                 // null | 'oneclick' | 'calibrate'
  calibratePoints: [],
  rooms: [],                    // {runRanges: [{y,ranges:[[x0,x1]...]}], area, labelX, labelY, minX,minY,maxX,maxY}
  activeProjectId: null,
};

// ---------- Utility ----------
function setStatus(msg) { statusBar.textContent = msg; }

function resizeCanvases(w, h) {
  pdfCanvas.width = w; pdfCanvas.height = h;
  overlayCanvas.width = w; overlayCanvas.height = h;
  pdfCanvas.style.width = w + 'px'; pdfCanvas.style.height = h + 'px';
  overlayCanvas.style.width = w + 'px'; overlayCanvas.style.height = h + 'px';
}

function updateToolbarEnabled() {
  const ready = !!state.pdfDoc;
  oneClickBtn.disabled = !ready;
  calibrateBtn.disabled = !ready;
  clearBtn.disabled = !ready || state.rooms.length === 0;
  saveBtn.disabled = !ready;
}

function setMode(mode) {
  state.mode = mode;
  state.calibratePoints = [];
  oneClickBtn.classList.toggle('active', mode === 'oneclick');
  calibrateBtn.classList.toggle('active', mode === 'calibrate');
  overlayCanvas.classList.toggle('click-mode', !!mode);
}

// ---------- Auto scale detection ----------
// Reads the page's text layer looking for a "N:M" style scale label (e.g. "1:100"),
// which is standard on architectural/engineering drawing title blocks.
// This avoids needing any OCR/vision API call or manual calibration in the common case.
async function tryAutoDetectScale(page) {
  try {
    const textContent = await page.getTextContent();
    const fullText = textContent.items.map((i) => i.str).join(' ');
    const match = fullText.match(/\b1\s*:\s*(\d{1,4})\b/);
    if (!match) return null;
    const denom = parseFloat(match[1]);
    if (!denom || denom <= 0) return null;

    // 1 PDF point = 1/72 inch = 0.0254/72 m of *paper*.
    // At drawing scale 1:denom, 1 paper metre = `denom` real metres.
    const metersPerPointOnPaper = 0.0254 / 72;
    const metersPerPointReal = metersPerPointOnPaper * denom;
    // We render at RENDER_SCALE canvas-px per PDF point, so:
    const metersPerPixel = metersPerPointReal / RENDER_SCALE;
    return { metersPerPixel, scaleRatio: denom };
  } catch (e) {
    console.warn('Auto scale detection failed', e);
    return null;
  }
}

function updateScaleInfo() {
  if (!state.metersPerPixel) {
    scaleInfo.textContent = 'Scale: not set — use Manual Calibrate';
    return;
  }
  const src = state.scaleSource === 'auto' ? 'auto-detected from title block' : 'manual calibration';
  scaleInfo.textContent = `Scale: ${src}`;
}

// ---------- PDF loading & rendering ----------
async function loadPdfFromUrl(url, pageNumber = 1) {
  setStatus('Loading PDF...');
  const loadingTask = pdfjsLib.getDocument(url);
  const pdfDoc = await loadingTask.promise;
  state.pdfDoc = pdfDoc;
  state.pageNumber = pageNumber;
  await renderPage();
  emptyState.style.display = 'none';
  updateToolbarEnabled();
}

async function renderPage() {
  const page = await state.pdfDoc.getPage(state.pageNumber);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  resizeCanvases(viewport.width, viewport.height);
  state.pageWidth = viewport.width;
  state.pageHeight = viewport.height;

  const ctx = pdfCanvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Snapshot the raw drawing pixels once — flood fill always reads this,
  // never the overlay canvas, so repeated clicks stay accurate.
  state.pdfImageData = ctx.getImageData(0, 0, viewport.width, viewport.height);

  canvasWrap.style.minHeight = viewport.height + 40 + 'px';

  if (!state.calibrationLockedManual) {
    const auto = await tryAutoDetectScale(page);
    if (auto) {
      state.metersPerPixel = auto.metersPerPixel;
      state.scaleSource = 'auto';
    } else {
      state.metersPerPixel = null;
      state.scaleSource = null;
    }
  }
  updateScaleInfo();
  redrawOverlay();
}

// ---------- Flood fill (scanline) ----------
// Starting from a clicked pixel, flood-fills the contiguous open (non-wall) region
// using the actual rendered drawing pixels — no external API, works on any plan.
function luminanceAt(data, width, x, y) {
  const idx = (y * width + x) * 4;
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}

function floodFillRegion(imageData, startX, startY) {
  const { width, height, data } = imageData;
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) return null;
  if (luminanceAt(data, width, startX, startY) < WALL_LUMINANCE_THRESHOLD) {
    return { error: 'clicked-on-line' };
  }

  const visited = new Uint8Array(width * height);
  const rowMap = new Map(); // y -> array of [x0,x1] segments
  const stack = [[startX, startY]];
  const HARD_CAP = Math.floor(width * height * 0.35); // if fill leaks past this, abort (likely leaked through a gap)
  let filled = 0;
  let minX = startX, maxX = startX, minY = startY, maxY = startY;

  const isOpen = (x, y) => !visited[y * width + x] && luminanceAt(data, width, x, y) >= WALL_LUMINANCE_THRESHOLD;

  while (stack.length) {
    const [sx, sy] = stack.pop();
    if (visited[sy * width + sx]) continue;

    let xl = sx;
    while (xl - 1 >= 0 && isOpen(xl - 1, sy)) xl--;
    let xr = sx;
    while (xr + 1 < width && isOpen(xr + 1, sy)) xr++;

    for (let xx = xl; xx <= xr; xx++) {
      const vIdx = sy * width + xx;
      if (!visited[vIdx]) { visited[vIdx] = 1; filled++; }
    }
    if (filled > HARD_CAP) return { error: 'leaked' };

    if (xl < minX) minX = xl;
    if (xr > maxX) maxX = xr;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;

    if (!rowMap.has(sy)) rowMap.set(sy, []);
    rowMap.get(sy).push([xl, xr]);

    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue;
      let xx = xl;
      while (xx <= xr) {
        if (isOpen(xx, ny)) {
          stack.push([xx, ny]);
          while (xx <= xr && isOpen(xx, ny)) xx++;
        } else {
          xx++;
        }
      }
    }
  }

  // Merge/sort segments per row for compact, clean storage
  const runRanges = [];
  for (const [y, segs] of rowMap.entries()) {
    segs.sort((a, b) => a[0] - b[0]);
    const merged = [segs[0]];
    for (let i = 1; i < segs.length; i++) {
      const last = merged[merged.length - 1];
      if (segs[i][0] <= last[1] + 1) last[1] = Math.max(last[1], segs[i][1]);
      else merged.push(segs[i]);
    }
    runRanges.push({ y, ranges: merged });
  }
  runRanges.sort((a, b) => a.y - b.y);

  return { filled, minX, maxX, minY, maxY, runRanges };
}

function pixelAreaToSqm(pixelCount) {
  if (!state.metersPerPixel) return null;
  return pixelCount * state.metersPerPixel * state.metersPerPixel;
}

// ---------- Overlay drawing ----------
function redrawOverlay() {
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  ctx.fillStyle = 'rgba(79, 109, 245, 0.35)';
  ctx.strokeStyle = 'rgba(79, 109, 245, 0.9)';

  for (const room of state.rooms) {
    for (const row of room.runRanges) {
      for (const [x0, x1] of row.ranges) {
        ctx.fillRect(x0, row.y, x1 - x0 + 1, 1);
      }
    }
  }
  // Labels drawn after fills so they sit on top
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  for (const room of state.rooms) {
    const cx = (room.minX + room.maxX) / 2;
    const cy = (room.minY + room.maxY) / 2;
    const label = room.area != null ? `${room.area.toFixed(2)} m²` : `${room.filled}px`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(label, cx, cy);
    ctx.fillStyle = '#1f2430';
    ctx.fillText(label, cx, cy);
  }

  // Calibration line preview
  if (state.mode === 'calibrate' && state.calibratePoints.length >= 1) {
    ctx.strokeStyle = '#e0432c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const [p0] = state.calibratePoints;
    ctx.arc(p0.x, p0.y, 4, 0, Math.PI * 2);
    ctx.fill();
    if (state.calibratePoints[1]) {
      const p1 = state.calibratePoints[1];
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------- Event handlers ----------
overlayCanvas.addEventListener('click', async (e) => {
  if (!state.mode) return;
  const rect = overlayCanvas.getBoundingClientRect();
  const scaleX = overlayCanvas.width / rect.width;
  const scaleY = overlayCanvas.height / rect.height;
  const x = Math.round((e.clientX - rect.left) * scaleX);
  const y = Math.round((e.clientY - rect.top) * scaleY);

  if (state.mode === 'oneclick') {
    setStatus('Calculating area...');
    const result = floodFillRegion(state.pdfImageData, x, y);
    if (!result || result.error === 'clicked-on-line') {
      setStatus('That looks like a wall/line — click inside an open room area.');
      return;
    }
    if (result.error === 'leaked') {
      setStatus('Fill leaked through a gap (open doorway/break in the line) — try clicking closer to the room center, or zoom the source PDF.');
      return;
    }
    const area = pixelAreaToSqm(result.filled);
    state.rooms.push({ ...result, area });
    redrawOverlay();
    updateToolbarEnabled();
    setStatus(area != null
      ? `Room area: ${area.toFixed(2)} m²`
      : `Filled ${result.filled}px — set a scale (Manual Calibrate) to see m²`);
  } else if (state.mode === 'calibrate') {
    state.calibratePoints.push({ x, y });
    if (state.calibratePoints.length === 2) {
      calibrateModal.classList.remove('hidden');
    }
    redrawOverlay();
  }
});

oneClickBtn.addEventListener('click', () => setMode(state.mode === 'oneclick' ? null : 'oneclick'));
calibrateBtn.addEventListener('click', () => setMode(state.mode === 'calibrate' ? null : 'calibrate'));
clearBtn.addEventListener('click', () => {
  state.rooms = [];
  redrawOverlay();
  updateToolbarEnabled();
  setStatus('Cleared all marks.');
});

el('cancelCalibrateBtn').addEventListener('click', () => {
  calibrateModal.classList.add('hidden');
  state.calibratePoints = [];
  setMode(null);
  redrawOverlay();
});
el('confirmCalibrateBtn').addEventListener('click', () => {
  const realLength = parseFloat(realLengthInput.value);
  if (!realLength || realLength <= 0) return;
  const [p0, p1] = state.calibratePoints;
  const pixelDist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  state.metersPerPixel = realLength / pixelDist;
  state.scaleSource = 'manual';
  state.calibrationLockedManual = true; // don't let auto-detect override this on re-render
  updateScaleInfo();
  calibrateModal.classList.add('hidden');
  realLengthInput.value = '';
  setMode(null);
  redrawOverlay();
  setStatus('Manual scale applied. Re-run One Click on rooms to update areas.');
  // Recompute areas for already-marked rooms with the new scale
  for (const room of state.rooms) room.area = pixelAreaToSqm(room.filled);
  redrawOverlay();
});

// ---------- Upload ----------
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  setStatus('Uploading PDF...');
  const formData = new FormData();
  formData.append('pdf', file);
  const res = await fetch('/api/upload', { method: 'POST', body: formData });
  if (!res.ok) { setStatus('Upload failed.'); return; }
  const { fileId, url } = await res.json();

  state = {
    ...state,
    fileId, fileUrl: url, rooms: [], activeProjectId: null,
    calibrationLockedManual: false, metersPerPixel: null, scaleSource: null,
  };
  setMode(null);
  await loadPdfFromUrl(url);
  setStatus('PDF loaded. Click "One Click" then click inside a room.');
  highlightActiveProject(null);
});

// ---------- Save ----------
saveBtn.addEventListener('click', () => {
  nameInput.value = '';
  descInput.value = '';
  saveModal.classList.remove('hidden');
});
el('cancelSaveBtn').addEventListener('click', () => saveModal.classList.add('hidden'));
el('confirmSaveBtn').addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  const payload = {
    name,
    description: descInput.value.trim(),
    fileId: state.fileId,
    fileUrl: state.fileUrl,
    pageNumber: state.pageNumber,
    calibration: state.metersPerPixel
      ? { metersPerPixel: state.metersPerPixel, source: state.scaleSource, renderScale: RENDER_SCALE }
      : null,
    rooms: state.rooms.map((r) => ({
      runRanges: r.runRanges, area: r.area, filled: r.filled,
      minX: r.minX, maxX: r.maxX, minY: r.minY, maxY: r.maxY,
    })),
  };
  const res = await fetch('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!res.ok) { setStatus('Save failed.'); return; }
  const project = await res.json();
  saveModal.classList.add('hidden');
  setStatus(`Saved "${project.name}".`);
  await refreshProjectList();
  highlightActiveProject(project.id);
});

// ---------- Saved project list ----------
async function refreshProjectList() {
  const res = await fetch('/api/projects');
  const projects = await res.json();
  projectList.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.className = 'project-item';
    li.dataset.id = p.id;
    li.innerHTML = `<div class="p-name">${escapeHtml(p.name)}</div><div class="p-desc">${escapeHtml(p.description || '')}</div>`;
    li.addEventListener('click', () => openProject(p.id));
    projectList.appendChild(li);
  }
}

function highlightActiveProject(id) {
  state.activeProjectId = id;
  [...projectList.children].forEach((li) => li.classList.toggle('active', li.dataset.id === id));
}

async function openProject(id) {
  setStatus('Opening saved drawing...');
  const res = await fetch(`/api/projects/${id}`);
  if (!res.ok) { setStatus('Could not load project.'); return; }
  const project = await res.json();

  state = {
    ...state,
    fileId: project.fileId,
    fileUrl: project.fileUrl,
    rooms: project.rooms || [],
    metersPerPixel: project.calibration ? project.calibration.metersPerPixel : null,
    scaleSource: project.calibration ? project.calibration.source : null,
    calibrationLockedManual: !!project.calibration,
    activeProjectId: id,
  };
  setMode(null);
  await loadPdfFromUrl(project.fileUrl, project.pageNumber || 1);
  highlightActiveProject(id);
  setStatus(`Loaded "${project.name}" — markings restored.`);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- Init ----------
refreshProjectList();
