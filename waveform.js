// ── Waveform Renderer ─────────────────────────────────────────────────

export class WaveformRenderer {
  constructor(canvas, container) {
    this.canvas = canvas;
    this.container = container;
    this.ctx = canvas.getContext('2d');
    this.buffer = null;
    this.zoom = 1.0;
    this.scrollX = 0;
    this.playhead = 0;
    this.selStart = null;
    this.selEnd = null;
    this._isDragging = false;
    this._dragType = null; // 'playhead' | 'sel' | 'selL' | 'selR'
    this._dragStart = 0;
    this._peakCache = null;
    this._cacheZoom = null;
    this.onSeek = null;
    this.onSelect = null;
    this._ro = null;
    this._initResize();
    this._initMouse();
  }

  _initResize() {
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.container);
    this._resize();
  }

  _resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.scale(dpr, dpr);
    this._peakCache = null; // invalidate cache
    this.render();
  }

  get displayWidth() { return parseFloat(this.canvas.style.width) || this.canvas.width; }
  get displayHeight() { return parseFloat(this.canvas.style.height) || this.canvas.height; }

  loadBuffer(buffer) {
    this.buffer = buffer;
    this._peakCache = null;
    this.zoom = 1;
    this.scrollX = 0;
    this.selStart = null;
    this.selEnd = null;
    this.render();
  }

  _buildPeakCache(numBins) {
    if (!this.buffer) return null;
    const data = this.buffer.getChannelData(0);
    const dataR = this.buffer.numberOfChannels > 1 ? this.buffer.getChannelData(1) : data;
    const step = Math.ceil(data.length / numBins);
    const mins = new Float32Array(numBins);
    const maxs = new Float32Array(numBins);
    const minsR = new Float32Array(numBins);
    const maxsR = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) {
      let minL = 1, maxL = -1, minR = 1, maxR = -1;
      const start = i * step;
      for (let j = 0; j < step; j++) {
        const idx = start + j;
        if (idx >= data.length) break;
        const vL = data[idx], vR = dataR[idx];
        if (vL < minL) minL = vL; if (vL > maxL) maxL = vL;
        if (vR < minR) minR = vR; if (vR > maxR) maxR = vR;
      }
      mins[i] = minL; maxs[i] = maxL;
      minsR[i] = minR; maxsR[i] = maxR;
    }
    return { mins, maxs, minsR, maxsR, numBins, step };
  }

  render() {
    const ctx = this.ctx;
    const W = this.displayWidth, H = this.displayHeight;
    ctx.clearRect(0, 0, W, H);

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#04080f');
    bg.addColorStop(1, '#020509');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    if (!this.buffer) {
      this._drawGrid(W, H);
      return;
    }

    // Grid
    this._drawGrid(W, H);

    const numBins = Math.floor(W * this.zoom * 2);
    if (!this._peakCache || this._peakCache.numBins !== numBins) {
      this._peakCache = this._buildPeakCache(numBins);
    }
    const cache = this._peakCache;
    const dur = this.buffer.duration;

    // Visible range in samples
    const visStart = this.scrollX / (W * this.zoom);
    const visEnd = (this.scrollX + W) / (W * this.zoom);
    const binStart = Math.floor(visStart * numBins);
    const binEnd = Math.ceil(visEnd * numBins);

    const H2 = H / 2;
    const midH = H * 0.5;

    // Selection
    if (this.selStart !== null && this.selEnd !== null) {
      const s = Math.min(this.selStart, this.selEnd);
      const e = Math.max(this.selStart, this.selEnd);
      const x1 = this._timeToX(s, W);
      const x2 = this._timeToX(e, W);
      ctx.fillStyle = 'rgba(0,80,180,0.25)';
      ctx.fillRect(x1, 0, x2 - x1, H);
      ctx.strokeStyle = 'rgba(0,150,255,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, 0, x2 - x1, H);
    }

    // Waveform
    const drawWave = (minsArr, maxsArr, yOff, ampH, color) => {
      const grd = ctx.createLinearGradient(0, yOff - ampH, 0, yOff + ampH);
      grd.addColorStop(0, color + '44');
      grd.addColorStop(0.5, color + 'cc');
      grd.addColorStop(1, color + '44');
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = binStart; i < Math.min(binEnd, numBins); i++) {
        const x = this._binToX(i, numBins, W);
        const yMax = yOff - maxsArr[i] * ampH;
        const yMin = yOff - minsArr[i] * ampH;
        if (i === binStart) ctx.moveTo(x, yMax);
        ctx.lineTo(x, yMax);
        ctx.lineTo(x, yMin);
      }
      ctx.stroke();
      // Filled shape
      ctx.fillStyle = grd;
      ctx.beginPath();
      for (let i = binStart; i < Math.min(binEnd, numBins); i++) {
        const x = this._binToX(i, numBins, W);
        if (i === binStart) ctx.moveTo(x, yOff);
        ctx.lineTo(x, yOff - maxsArr[i] * ampH);
      }
      for (let i = Math.min(binEnd, numBins) - 1; i >= binStart; i--) {
        const x = this._binToX(i, numBins, W);
        ctx.lineTo(x, yOff - minsArr[i] * ampH);
      }
      ctx.closePath();
      ctx.fill();
    };

    if (this.buffer.numberOfChannels >= 2) {
      // Stereo: top = L, bottom = R
      drawWave(cache.mins, cache.maxs, H * 0.28, H * 0.26, '#0080ff');
      drawWave(cache.minsR, cache.maxsR, H * 0.72, H * 0.26, '#00c8ff');
      // Center line
      ctx.strokeStyle = 'rgba(0,100,180,0.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, H * 0.5); ctx.lineTo(W, H * 0.5); ctx.stroke();
    } else {
      drawWave(cache.mins, cache.maxs, midH, H * 0.45, '#00a8ff');
    }

    // Playhead
    const px = this._timeToX(this.playhead, W);
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 8; ctx.shadowColor = '#00d4ff';
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    ctx.shadowBlur = 0;
    // Triangle marker
    ctx.fillStyle = '#00d4ff';
    ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill();

    // Time ruler
    this._drawRuler(W, H, dur);
  }

  _drawGrid(W, H) {
    this.ctx.strokeStyle = 'rgba(10,30,60,0.6)';
    this.ctx.lineWidth = 1;
    for (let y = H * 0.25; y < H; y += H * 0.25) {
      this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(W, y); this.ctx.stroke();
    }
  }

  _drawRuler(W, H, dur) {
    const ctx = this.ctx;
    const visStart = this.scrollX / (W * this.zoom);
    const visEnd = (this.scrollX + W) / (W * this.zoom);
    const visDur = (visEnd - visStart) * dur;
    // Pick interval
    const intervals = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];
    let interval = intervals.find(i => visDur / i < W / 80) || 120;
    const startT = visStart * dur;
    const firstTick = Math.ceil(startT / interval) * interval;

    ctx.fillStyle = 'rgba(30,50,80,0.7)';
    ctx.fillRect(0, H - 18, W, 18);
    ctx.strokeStyle = '#0a1830'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 18); ctx.lineTo(W, H - 18); ctx.stroke();

    ctx.fillStyle = '#304060'; ctx.font = '9px Share Tech Mono, monospace';
    for (let t = firstTick; t <= visEnd * dur + interval; t += interval) {
      const x = this._timeToX(t, W);
      if (x < 0 || x > W) continue;
      ctx.strokeStyle = 'rgba(0,80,160,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, H - 18); ctx.lineTo(x, H - 10); ctx.stroke();
      ctx.fillStyle = '#3a5880';
      ctx.fillText(this._fmtTime(t), x + 2, H - 5);
    }
  }

  _fmtTime(s) {
    const m = Math.floor(s / 60);
    const ss = (s % 60).toFixed(1);
    return `${m.toString().padStart(2,'0')}:${ss.padStart(4,'0')}`;
  }

  _timeToX(time, W) {
    const dur = this.buffer ? this.buffer.duration : 1;
    const ratio = time / dur;
    return ratio * W * this.zoom - this.scrollX;
  }

  _xToTime(x, W) {
    const dur = this.buffer ? this.buffer.duration : 1;
    const ratio = (x + this.scrollX) / (W * this.zoom);
    return Math.max(0, Math.min(dur, ratio * dur));
  }

  _binToX(bin, numBins, W) {
    return (bin / numBins) * W * this.zoom - this.scrollX;
  }

  setPlayhead(time) {
    this.playhead = time;
    this.render();
  }

  zoomIn() {
    this.zoom = Math.min(this.zoom * 1.5, 50);
    this._peakCache = null;
    this.render();
  }

  zoomOut() {
    this.zoom = Math.max(this.zoom / 1.5, 1);
    if (this.zoom <= 1) this.scrollX = 0;
    this._peakCache = null;
    this.render();
  }

  fitView() {
    this.zoom = 1; this.scrollX = 0;
    this._peakCache = null;
    this.render();
  }

  _initMouse() {
    let isDragging = false;
    let dragType = null;
    let startX = 0;
    let startSelStart = null;

    let moveSelDur = 0;
    let moveStartTime = 0;

    const getType = (x) => {
      const W = this.displayWidth;
      if (this.selStart !== null && this.selEnd !== null) {
        const s = Math.min(this.selStart, this.selEnd);
        const e = Math.max(this.selStart, this.selEnd);
        const xS = this._timeToX(s, W), xE = this._timeToX(e, W);
        if (Math.abs(x - xS) < 8) return 'selL';
        if (Math.abs(x - xE) < 8) return 'selR';
        if (x > xS + 8 && x < xE - 8) return 'move'; // inside = drag to move
      }
      return 'sel';
    };

    // Update cursor based on hover position
    this.canvas.addEventListener('mousemove', (ev) => {
      if (isDragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const type = getType(x);
      if (type === 'selL' || type === 'selR') this.canvas.style.cursor = 'ew-resize';
      else if (type === 'move') this.canvas.style.cursor = 'grab';
      else this.canvas.style.cursor = 'crosshair';
    });

    this.canvas.addEventListener('mousedown', (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const W = this.displayWidth;
      isDragging = true;
      dragType = getType(x);
      startX = x;
      if (dragType === 'sel') {
        const t = this._xToTime(x, W);
        this.selStart = t; this.selEnd = t;
        if (this.onSelect) this.onSelect(this.selStart, this.selEnd);
      } else if (dragType === 'move') {
        // Remember selection duration and the time at mousedown
        moveSelDur = Math.abs((this.selEnd || 0) - (this.selStart || 0));
        moveStartTime = this._xToTime(x, W);
        this.canvas.style.cursor = 'grabbing';
      }
      startSelStart = this.selStart;
    });

    window.addEventListener('mousemove', (ev) => {
      if (!isDragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const W = this.displayWidth;
      const t = this._xToTime(x, W);
      if (dragType === 'sel') {
        this.selEnd = t;
      } else if (dragType === 'selL') {
        this.selStart = t;
      } else if (dragType === 'selR') {
        this.selEnd = t;
      } else if (dragType === 'move') {
        // Shift entire selection by delta
        const dur = this.buffer ? this.buffer.duration : 1;
        const delta = t - moveStartTime;
        const origStart = Math.min(startSelStart, startSelStart + moveSelDur);
        let newStart = Math.max(0, origStart + delta);
        let newEnd = newStart + moveSelDur;
        if (newEnd > dur) { newEnd = dur; newStart = Math.max(0, dur - moveSelDur); }
        this.selStart = newStart;
        this.selEnd = newEnd;
      }
      if (dragType !== 'move') {
        if (this.onSelect) this.onSelect(
          Math.min(this.selStart, this.selEnd),
          Math.max(this.selStart, this.selEnd)
        );
      } else {
        if (this.onSelect) this.onSelect(this.selStart, this.selEnd);
      }
      this.render();
    });

    window.addEventListener('mouseup', (ev) => {
      if (!isDragging) return;
      isDragging = false;
      this.canvas.style.cursor = 'crosshair';
      if (dragType === 'move') {
        // Finalize move — selection already updated in mousemove
        if (this.onSelect) this.onSelect(this.selStart, this.selEnd);
        dragType = null;
        this.render();
        return;
      }
      if (dragType === 'sel') {
        const rect = this.canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const W = this.displayWidth;
        const t = this._xToTime(x, W);
        if (Math.abs(t - (startSelStart !== null ? startSelStart : t)) < 0.05) {
          // Single click = seek, no selection
          this.selStart = null; this.selEnd = null;
          if (this.onSeek) this.onSeek(t);
          if (this.onSelect) this.onSelect(null, null);
        } else {
          this.selEnd = t;
        }
      }
      this.render();
    });

    // Scroll to zoom/pan
    this.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        const W = this.displayWidth;
        const rect = this.canvas.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const ratio = (mx + this.scrollX) / (W * this.zoom);
        if (ev.deltaY < 0) this.zoom = Math.min(this.zoom * 1.15, 50);
        else this.zoom = Math.max(this.zoom / 1.15, 1);
        this.scrollX = Math.max(0, ratio * W * this.zoom - mx);
        const maxScroll = W * (this.zoom - 1);
        this.scrollX = Math.min(this.scrollX, maxScroll);
        this._peakCache = null;
      } else {
        this.scrollX = Math.max(0, this.scrollX + ev.deltaX + ev.deltaY);
        const W = this.displayWidth;
        this.scrollX = Math.min(this.scrollX, W * (this.zoom - 1));
      }
      this.render();
    }, { passive: false });

    // Touch events
    let lastTouchX = null;
    this.canvas.addEventListener('touchstart', (ev) => {
      if (ev.touches.length === 1) lastTouchX = ev.touches[0].clientX;
    }, { passive: true });
    this.canvas.addEventListener('touchmove', (ev) => {
      if (ev.touches.length === 1 && lastTouchX !== null) {
        const dx = lastTouchX - ev.touches[0].clientX;
        const W = this.displayWidth;
        this.scrollX = Math.max(0, Math.min(this.scrollX + dx, W * (this.zoom - 1)));
        lastTouchX = ev.touches[0].clientX;
        this.render();
      }
    }, { passive: true });
  }

  clearSelection() {
    this.selStart = null; this.selEnd = null;
    this.render();
  }

  setSelection(start, end) {
    if (!this.buffer) return;
    this.selStart = Math.max(0, start);
    this.selEnd = Math.min(this.buffer.duration, end);
    if (this.onSelect) this.onSelect(this.selStart, this.selEnd);
    this.render();
  }

  selectAll() {
    if (!this.buffer) return;
    this.selStart = 0; this.selEnd = this.buffer.duration;
    if (this.onSelect) this.onSelect(0, this.buffer.duration);
    this.render();
  }
}

// ── Spectrum Analyzer ────────────────────────────────────────────────

export class SpectrumAnalyzer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this._rafId = null;
    this.mode = 'bars';
    this._peakData = null;
    this._peakDecay = 0.98;
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas);
    this._resize();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.scale(dpr, dpr);
  }

  connect(analyser) {
    this.analyser = analyser;
    this.analyser.fftSize = 2048;
    this._peakData = new Float32Array(analyser.frequencyBinCount);
    this.start();
  }

  start() {
    if (this._rafId) return;
    const draw = () => {
      this._rafId = requestAnimationFrame(draw);
      this._draw();
    };
    draw();
  }

  stop() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    const ctx = this.ctx;
    const W = parseFloat(this.canvas.style.width) || this.canvas.width;
    const H = parseFloat(this.canvas.style.height) || this.canvas.height;
    ctx.fillStyle = '#020509';
    ctx.fillRect(0, 0, W, H);
  }

  _draw() {
    if (!this.analyser) return;
    const ctx = this.ctx;
    const W = parseFloat(this.canvas.style.width) || this.canvas.width;
    const H = parseFloat(this.canvas.style.height) || this.canvas.height;
    const bufLen = this.analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    this.analyser.getByteFrequencyData(data);

    // Decay background
    ctx.fillStyle = 'rgba(2,5,9,0.75)';
    ctx.fillRect(0, 0, W, H);

    if (this.mode === 'bars') this._drawBars(ctx, data, W, H, bufLen);
    else if (this.mode === 'line') this._drawLine(ctx, data, W, H, bufLen);
    else if (this.mode === 'filled') this._drawFilled(ctx, data, W, H, bufLen);
    else if (this.mode === 'mirror') this._drawMirror(ctx, data, W, H, bufLen);

    // Frequency labels
    ctx.fillStyle = '#1a3060';
    ctx.font = '8px Share Tech Mono, monospace';
    const freqLabels = ['100','500','1k','2k','5k','10k','20k'];
    const freqHz = [100, 500, 1000, 2000, 5000, 10000, 20000];
    const nyq = this.analyser.context.sampleRate / 2;
    freqLabels.forEach((lbl, i) => {
      const x = (freqHz[i] / nyq) * W;
      ctx.fillText(lbl, x + 2, H - 4);
    });
  }

  _drawBars(ctx, data, W, H, bufLen) {
    const numBars = Math.min(bufLen, Math.floor(W / 3));
    const bw = W / numBars;
    for (let i = 0; i < numBars; i++) {
      const v = data[Math.floor(i * bufLen / numBars)] / 255;
      const bh = v * H;
      const hue = 200 + v * 80;
      const grd = ctx.createLinearGradient(0, H - bh, 0, H);
      grd.addColorStop(0, `hsla(${hue+20},100%,60%,0.9)`);
      grd.addColorStop(1, `hsla(${hue},100%,35%,0.8)`);
      ctx.fillStyle = grd;
      ctx.fillRect(i * bw, H - bh, bw - 1, bh);
      // Peak
      if (this._peakData) {
        const pk = this._peakData[i];
        if (data[Math.floor(i * bufLen / numBars)] >= pk) {
          this._peakData[i] = data[Math.floor(i * bufLen / numBars)];
        } else {
          this._peakData[i] = pk * this._peakDecay;
        }
        const ph = (this._peakData[i] / 255) * H;
        ctx.fillStyle = 'rgba(0,220,255,0.8)';
        ctx.fillRect(i * bw, H - ph - 1, bw - 1, 2);
      }
    }
  }

  _drawLine(ctx, data, W, H, bufLen) {
    ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 1.5;
    ctx.shadowBlur = 4; ctx.shadowColor = '#0080ff';
    ctx.beginPath();
    for (let i = 0; i < bufLen; i++) {
      const x = (i / bufLen) * W;
      const y = H - (data[i] / 255) * H;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  }

  _drawFilled(ctx, data, W, H, bufLen) {
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, 'rgba(0,200,255,0.7)');
    grd.addColorStop(1, 'rgba(0,50,150,0.1)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let i = 0; i < bufLen; i++) {
      ctx.lineTo((i / bufLen) * W, H - (data[i] / 255) * H);
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }

  _drawMirror(ctx, data, W, H, bufLen) {
    const H2 = H / 2;
    for (let i = 0; i < bufLen; i++) {
      const v = data[i] / 255;
      const x = (i / bufLen) * W;
      const bh = v * H2;
      const hue = 200 + v * 60;
      ctx.fillStyle = `hsla(${hue},100%,50%,0.7)`;
      ctx.fillRect(x, H2 - bh, W / bufLen, bh);
      ctx.fillRect(x, H2, W / bufLen, bh);
    }
  }
}

// ── Oscilloscope ─────────────────────────────────────────────────────

export class Oscilloscope {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this._rafId = null;
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas);
    this._resize();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.scale(dpr, dpr);
  }

  connect(analyser) {
    this.analyser = analyser;
    this.analyser.fftSize = 2048;
    this.start();
  }

  start() {
    if (this._rafId) return;
    const draw = () => { this._rafId = requestAnimationFrame(draw); this._draw(); };
    draw();
  }

  stop() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  _draw() {
    if (!this.analyser) return;
    const ctx = this.ctx;
    const W = parseFloat(this.canvas.style.width) || this.canvas.width;
    const H = parseFloat(this.canvas.style.height) || this.canvas.height;
    const bufLen = this.analyser.fftSize;
    const data = new Uint8Array(bufLen);
    this.analyser.getByteTimeDomainData(data);

    ctx.fillStyle = 'rgba(2,5,9,0.8)';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(10,30,60,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W/2, 0); ctx.lineTo(W/2, H); ctx.stroke();

    ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 1.5;
    ctx.shadowBlur = 4; ctx.shadowColor = '#0070ff';
    ctx.beginPath();
    const slice = W / bufLen;
    for (let i = 0; i < bufLen; i++) {
      const v = data[i] / 128 - 1;
      const x = i * slice;
      const y = H / 2 + v * H / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  }
}
