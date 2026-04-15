const els = {
  refInput: document.getElementById('refInput'),
  maskInput: document.getElementById('maskInput'),
  refName: document.getElementById('refName'),
  maskName: document.getElementById('maskName'),
  tileWidth: document.getElementById('tileWidth'),
  tileHeight: document.getElementById('tileHeight'),
  baseScale: document.getElementById('baseScale'),
  baseScaleText: document.getElementById('baseScaleText'),
  tileGap: document.getElementById('tileGap'),
  tileGapText: document.getElementById('tileGapText'),
  generateBtn: document.getElementById('generateBtn'),
  fabricThumb: document.getElementById('fabricThumb'),
  pieceList: document.getElementById('pieceList'),
  pieceCanvas: document.getElementById('pieceCanvas'),
  previewCanvas: document.getElementById('previewCanvas'),
  offsetX: document.getElementById('offsetX'),
  offsetY: document.getElementById('offsetY'),
  pieceScale: document.getElementById('pieceScale'),
  rotation: document.getElementById('rotation'),
  mirrorX: document.getElementById('mirrorX'),
  mirrorY: document.getElementById('mirrorY'),
  offsetXText: document.getElementById('offsetXText'),
  offsetYText: document.getElementById('offsetYText'),
  scaleText: document.getElementById('scaleText'),
  rotationText: document.getElementById('rotationText'),
  resetCurrentBtn: document.getElementById('resetCurrentBtn'),
  exportPreviewBtn: document.getElementById('exportPreviewBtn'),
  exportAllBtn: document.getElementById('exportAllBtn')
};

const state = {
  refImage: null,
  refName: '',
  maskImage: null,
  maskName: '',
  fabricCanvas: null,
  pieces: [],
  selectedPieceId: null,
  isDragging: false,
  dragStart: null,
};

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function getSelectedPiece() {
  return state.pieces.find(p => p.id === state.selectedPieceId) || null;
}

function updateText() {
  els.baseScaleText.textContent = Number(els.baseScale.value).toFixed(2);
  els.tileGapText.textContent = els.tileGap.value;
  const p = getSelectedPiece();
  els.offsetXText.textContent = p ? Math.round(p.params.offsetX) : '0';
  els.offsetYText.textContent = p ? Math.round(p.params.offsetY) : '0';
  els.scaleText.textContent = p ? p.params.scale.toFixed(2) : '1.00';
  els.rotationText.textContent = p ? `${Math.round(p.params.rotation)}°` : '0°';
}

function syncControlsFromPiece() {
  const p = getSelectedPiece();
  if (!p) return;
  els.offsetX.value = p.params.offsetX;
  els.offsetY.value = p.params.offsetY;
  els.pieceScale.value = p.params.scale;
  els.rotation.value = p.params.rotation;
  els.mirrorX.checked = p.params.mirrorX;
  els.mirrorY.checked = p.params.mirrorY;
  updateText();
}

function applyControlsToPiece() {
  const p = getSelectedPiece();
  if (!p) return;
  p.params.offsetX = Number(els.offsetX.value);
  p.params.offsetY = Number(els.offsetY.value);
  p.params.scale = Number(els.pieceScale.value);
  p.params.rotation = Number(els.rotation.value);
  p.params.mirrorX = els.mirrorX.checked;
  p.params.mirrorY = els.mirrorY.checked;
  updateText();
  renderAll();
}

function alphaConnectedComponents(maskCanvas) {
  const { width, height } = maskCanvas;
  const ctx = maskCanvas.getContext('2d');
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = rgba[i * 4 + 3] > 10 ? 1 : 0;
  }
  const visited = new Uint8Array(width * height);
  const pieces = [];
  const queue = new Int32Array(width * height);
  const dirs = [1, -1, width, -width];

  for (let idx = 0; idx < mask.length; idx++) {
    if (!mask[idx] || visited[idx]) continue;
    let head = 0, tail = 0;
    queue[tail++] = idx;
    visited[idx] = 1;
    let minX = width, minY = height, maxX = 0, maxY = 0, area = 0;
    const pixels = [];

    while (head < tail) {
      const cur = queue[head++];
      const x = cur % width;
      const y = (cur / width) | 0;
      pixels.push(cur);
      area++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      if (x + 1 < width) {
        const n = cur + 1; if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
      }
      if (x - 1 >= 0) {
        const n = cur - 1; if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
      }
      if (y + 1 < height) {
        const n = cur + width; if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
      }
      if (y - 1 >= 0) {
        const n = cur - width; if (mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
      }
    }

    if (area < 1000) continue;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const pieceCanvas = createCanvas(bw, bh);
    const pctx = pieceCanvas.getContext('2d');
    const imageData = pctx.createImageData(bw, bh);
    for (const p of pixels) {
      const x = p % width - minX;
      const y = ((p / width) | 0) - minY;
      const pos = (y * bw + x) * 4;
      imageData.data[pos] = 255;
      imageData.data[pos + 1] = 255;
      imageData.data[pos + 2] = 255;
      imageData.data[pos + 3] = 255;
    }
    pctx.putImageData(imageData, 0, 0);

    const thumb = createCanvas(84, 84);
    const tctx = thumb.getContext('2d');
    tctx.clearRect(0, 0, 84, 84);
    const scale = Math.min(72 / bw, 72 / bh);
    const dw = bw * scale, dh = bh * scale;
    tctx.drawImage(pieceCanvas, (84 - dw) / 2, (84 - dh) / 2, dw, dh);

    pieces.push({
      sourceX: minX,
      sourceY: minY,
      width: bw,
      height: bh,
      area,
      maskCanvas: pieceCanvas,
      thumbUrl: thumb.toDataURL('image/png')
    });
  }
  pieces.sort((a, b) => b.area - a.area);
  return pieces.map((p, index) => ({
    id: `part_${String(index + 1).padStart(2, '0')}`,
    name: `${state.maskName.replace(/\.[^.]+$/, '')}_${String(index + 1).padStart(2, '0')}`,
    ...p,
    params: { offsetX: 0, offsetY: 0, scale: 1, rotation: 0, mirrorX: false, mirrorY: false }
  }));
}

function generateFabricCanvas() {
  if (!state.refImage) return null;
  const width = Math.max(256, Number(els.tileWidth.value) || 2048);
  const height = Math.max(256, Number(els.tileHeight.value) || 2048);
  const scale = Number(els.baseScale.value);
  const gap = Number(els.tileGap.value);
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  const tw = state.refImage.width * scale;
  const th = state.refImage.height * scale;
  const stepX = Math.max(1, tw + gap);
  const stepY = Math.max(1, th + gap);
  for (let y = 0; y < height + stepY; y += stepY) {
    for (let x = 0; x < width + stepX; x += stepX) {
      ctx.drawImage(state.refImage, x, y, tw, th);
    }
  }
  state.fabricCanvas = c;
  drawFabricThumb();
  renderAll();
}

function drawFabricThumb() {
  const c = els.fabricThumb;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!state.fabricCanvas) return;
  const scale = Math.min(c.width / state.fabricCanvas.width, c.height / state.fabricCanvas.height);
  const dw = state.fabricCanvas.width * scale;
  const dh = state.fabricCanvas.height * scale;
  ctx.drawImage(state.fabricCanvas, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
}

function renderPieceList() {
  if (!state.pieces.length) {
    els.pieceList.className = 'piece-list empty';
    els.pieceList.textContent = '请先上传总 mask。';
    return;
  }
  els.pieceList.className = 'piece-list';
  els.pieceList.innerHTML = '';
  for (const p of state.pieces) {
    const item = document.createElement('div');
    item.className = 'piece-item' + (p.id === state.selectedPieceId ? ' active' : '');
    item.innerHTML = `
      <img class="piece-thumb" src="${p.thumbUrl}" alt="${p.name}" />
      <div class="piece-meta">
        <div class="piece-name">${p.id}</div>
        <div class="piece-desc">${p.width} × ${p.height}<br>面积 ${p.area.toLocaleString()}</div>
      </div>
      <div class="piece-desc">x:${p.sourceX}<br>y:${p.sourceY}</div>`;
    item.onclick = () => {
      state.selectedPieceId = p.id;
      renderPieceList();
      syncControlsFromPiece();
      renderAll();
    };
    els.pieceList.appendChild(item);
  }
}

function makeTexturedPiece(piece, transparentTrim = true) {
  if (!state.fabricCanvas) return piece.maskCanvas;
  const out = createCanvas(piece.width, piece.height);
  const ctx = out.getContext('2d');
  const p = piece.params;

  ctx.save();
  ctx.translate(piece.width / 2 + p.offsetX, piece.height / 2 + p.offsetY);
  ctx.rotate((p.rotation * Math.PI) / 180);
  ctx.scale(p.mirrorX ? -p.scale : p.scale, p.mirrorY ? -p.scale : p.scale);
  ctx.drawImage(state.fabricCanvas, -state.fabricCanvas.width / 2, -state.fabricCanvas.height / 2);
  ctx.restore();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(piece.maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  if (!transparentTrim) {
    return out;
  }
  return out;
}

function renderCurrentPiece() {
  const c = els.pieceCanvas;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const piece = getSelectedPiece();
  if (!piece) return;

  const textured = makeTexturedPiece(piece);
  const margin = 40;
  const scale = Math.min((c.width - margin * 2) / piece.width, (c.height - margin * 2) / piece.height);
  const dw = piece.width * scale;
  const dh = piece.height * scale;
  const dx = (c.width - dw) / 2;
  const dy = (c.height - dh) / 2;
  ctx.drawImage(textured, dx, dy, dw, dh);
  ctx.strokeStyle = '#4b7cff';
  ctx.lineWidth = 2;
  ctx.strokeRect(dx, dy, dw, dh);
  piece._displayBox = { dx, dy, dw, dh, scale };
}

function renderPreview() {
  const c = els.previewCanvas;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!state.maskImage || !state.pieces.length) return;
  const maskW = state.maskImage.width;
  const maskH = state.maskImage.height;
  const margin = 24;
  const scale = Math.min((c.width - margin * 2) / maskW, (c.height - margin * 2) / maskH);
  const dx0 = (c.width - maskW * scale) / 2;
  const dy0 = (c.height - maskH * scale) / 2;

  for (const piece of state.pieces) {
    const textured = makeTexturedPiece(piece);
    ctx.drawImage(
      textured,
      dx0 + piece.sourceX * scale,
      dy0 + piece.sourceY * scale,
      piece.width * scale,
      piece.height * scale
    );
  }
  ctx.strokeStyle = '#4b7cff';
  ctx.lineWidth = 2;
  ctx.strokeRect(dx0, dy0, maskW * scale, maskH * scale);
}

function renderAll() {
  renderCurrentPiece();
  renderPreview();
}

function resetCurrentPiece() {
  const p = getSelectedPiece();
  if (!p) return;
  p.params = { offsetX: 0, offsetY: 0, scale: 1, rotation: 0, mirrorX: false, mirrorY: false };
  syncControlsFromPiece();
  renderAll();
}

function downloadDataUrl(name, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function exportPreview() {
  const out = createCanvas(state.maskImage.width, state.maskImage.height);
  const ctx = out.getContext('2d');
  for (const piece of state.pieces) {
    const textured = makeTexturedPiece(piece);
    ctx.drawImage(textured, piece.sourceX, piece.sourceY);
  }
  downloadDataUrl((state.maskName || 'preview').replace(/\.[^.]+$/, '') + '_preview.png', out.toDataURL('image/png'));
}

function exportAllPieces() {
  if (!state.pieces.length) return;
  state.pieces.forEach((piece, i) => {
    const textured = makeTexturedPiece(piece);
    setTimeout(() => downloadDataUrl(`${piece.id}.png`, textured.toDataURL('image/png')), i * 120);
  });
}

function handlePieceDragStart(evt) {
  const piece = getSelectedPiece();
  if (!piece || !piece._displayBox) return;
  const rect = els.pieceCanvas.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (els.pieceCanvas.width / rect.width);
  const y = (evt.clientY - rect.top) * (els.pieceCanvas.height / rect.height);
  const b = piece._displayBox;
  if (x >= b.dx && x <= b.dx + b.dw && y >= b.dy && y <= b.dy + b.dh) {
    state.isDragging = true;
    state.dragStart = { x, y, offsetX: piece.params.offsetX, offsetY: piece.params.offsetY, scale: b.scale };
  }
}
function handlePieceDragMove(evt) {
  if (!state.isDragging) return;
  const piece = getSelectedPiece();
  if (!piece) return;
  const rect = els.pieceCanvas.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (els.pieceCanvas.width / rect.width);
  const y = (evt.clientY - rect.top) * (els.pieceCanvas.height / rect.height);
  const dx = (x - state.dragStart.x) / state.dragStart.scale;
  const dy = (y - state.dragStart.y) / state.dragStart.scale;
  piece.params.offsetX = Math.round(state.dragStart.offsetX + dx);
  piece.params.offsetY = Math.round(state.dragStart.offsetY + dy);
  syncControlsFromPiece();
  renderAll();
}
function handlePieceDragEnd() { state.isDragging = false; }

els.refInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.refImage = await loadImage(file);
  state.refName = file.name;
  els.refName.textContent = file.name;
  generateFabricCanvas();
});

els.maskInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.maskImage = await loadImage(file);
  state.maskName = file.name;
  els.maskName.textContent = file.name;
  const c = createCanvas(state.maskImage.width, state.maskImage.height);
  c.getContext('2d').drawImage(state.maskImage, 0, 0);
  state.pieces = alphaConnectedComponents(c);
  state.selectedPieceId = state.pieces[0]?.id || null;
  renderPieceList();
  syncControlsFromPiece();
  renderAll();
});

[els.baseScale, els.tileGap].forEach(el => el.addEventListener('input', () => { updateText(); }));
els.generateBtn.addEventListener('click', generateFabricCanvas);
[els.offsetX, els.offsetY, els.pieceScale, els.rotation, els.mirrorX, els.mirrorY].forEach(el => el.addEventListener('input', applyControlsToPiece));
els.resetCurrentBtn.addEventListener('click', resetCurrentPiece);
els.exportPreviewBtn.addEventListener('click', exportPreview);
els.exportAllBtn.addEventListener('click', exportAllPieces);
['mousedown'].forEach(ev => els.pieceCanvas.addEventListener(ev, handlePieceDragStart));
['mousemove'].forEach(ev => els.pieceCanvas.addEventListener(ev, handlePieceDragMove));
['mouseup', 'mouseleave'].forEach(ev => els.pieceCanvas.addEventListener(ev, handlePieceDragEnd));
updateText();
