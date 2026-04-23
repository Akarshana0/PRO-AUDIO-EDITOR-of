// ── AudioForge Engine ─────────────────────────────────────────────────
// All Web Audio API processing happens here

import { UndoRedoManager } from './undo-manager.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.origBuffer = null;
    this.workBuffer = null; // current working buffer (may differ from orig)
    this.source = null;
    this.nodes = {};
    this.state = 'stopped'; // 'playing' | 'paused' | 'stopped'
    this.startTime = 0;
    this.pauseOffset = 0;
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.onTimeUpdate = null;
    this.onEnded = null;
    this._rafId = null;
    this._undoMgr = new UndoRedoManager();
    this.params = {
      eq: [0, 0, 0, 0, 0, 0, 0],
      eqBypass: false,
      compThreshold: -24, compRatio: 4, compAttack: 0.01,
      compRelease: 0.25, compKnee: 10, compGain: 0,
      compBypass: false,
      reverbOn: true, reverbSize: 2, reverbDecay: 2, reverbWet: 0.3, reverbPreDelay: 0.02,
      delayOn: false, delayTime: 0.25, delayFeedback: 0.3, delayWet: 0.25, delaySpread: 0.5,
      distOn: false, distDrive: 20, distTone: 3000, distWet: 0.5, distType: 'soft',
      chorusOn: false, chorusRate: 1.5, chorusDepth: 0.005, chorusWet: 0.4,
      vocalRemoval: false, vocalIsolate: false, vocalWidth: 0.5,
      bassEnhOn: false, bassSubBoost: 3, bassPunch: 4, bassWarmth: 2, bassTighten: 2,
      masterVol: 1.0, masterGain2: 1.0, stereoWidth: 1.0, pan: 0,
      playbackRate: 1.0, pitchShift: 0,
    };
    this._impulseCache = {};
  }

  getCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async loadFile(arrayBuffer) {
    const ctx = this.getCtx();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    this.origBuffer = decoded;
    this.workBuffer = decoded;
    await this._undoMgr.clear();
    return decoded;
  }

  // ── VOCAL PROCESSING ──────────────────────────────────────────────────
  computeVocalBuffer(mode) {
    // mode: 'remove' = L-R, 'isolate' = L+R (center)
    const buf = this.origBuffer;
    if (!buf || buf.numberOfChannels < 2) return buf;
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const nb = this.getCtx().createBuffer(2, buf.length, buf.sampleRate);
    const nL = nb.getChannelData(0), nR = nb.getChannelData(1);
    for (let i = 0; i < buf.length; i++) {
      if (mode === 'remove') {
        const d = L[i] - R[i];
        nL[i] = d; nR[i] = d;
      } else {
        const m = (L[i] + R[i]) * 0.5;
        nL[i] = m; nR[i] = m;
      }
    }
    return nb;
  }

  // ── FADE PROCESSING ───────────────────────────────────────────────────
  async applyFade(fadeIn, fadeOut, inDur, outDur, inCurve, outCurve) {
    const buf = this.workBuffer;
    if (!buf) return;
    await this._pushUndo();
    const sr = buf.sampleRate;
    const nb = this._cloneBuffer(buf);
    const inSamples = Math.floor(inDur * sr);
    const outSamples = Math.floor(outDur * sr);
    const total = nb.length;
    for (let c = 0; c < nb.numberOfChannels; c++) {
      const d = nb.getChannelData(c);
      if (fadeIn && inSamples > 0) {
        for (let i = 0; i < inSamples && i < total; i++) {
          d[i] *= this._curveVal(i / inSamples, inCurve, false);
        }
      }
      if (fadeOut && outSamples > 0) {
        for (let i = 0; i < outSamples; i++) {
          const idx = total - outSamples + i;
          if (idx >= 0) d[idx] *= this._curveVal(i / outSamples, outCurve, true);
        }
      }
    }
    this.workBuffer = nb;
    return nb;
  }

  _curveVal(t, curve, reverse) {
    if (reverse) t = 1 - t;
    switch (curve) {
      case 'linear': return t;
      case 'exponential': return t === 0 ? 0 : Math.pow(10, (t - 1) * 4);
      case 'logarithmic': return Math.log10(1 + 9 * t) / Math.log10(10);
      case 'sCurve': return (Math.sin((t - 0.5) * Math.PI) + 1) / 2;
      default: return t;
    }
  }

  // ── TRIM / CUT ────────────────────────────────────────────────────────
  async trimToSelection(startTime, endTime) {
    const buf = this.workBuffer;
    if (!buf) return null;
    const sr = buf.sampleRate;
    const startSample = Math.floor(startTime * sr);
    const endSample = Math.min(Math.ceil(endTime * sr), buf.length);
    const len = endSample - startSample;
    if (len <= 0) return null;  // validate before touching undo stack
    await this._pushUndo();
    const nb = this.getCtx().createBuffer(buf.numberOfChannels, len, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      nb.getChannelData(c).set(buf.getChannelData(c).subarray(startSample, endSample));
    }
    this.workBuffer = nb;
    return nb;
  }

  async deleteSelection(startTime, endTime) {
    const buf = this.workBuffer;
    if (!buf) return null;
    const sr = buf.sampleRate;
    const s = Math.floor(startTime * sr);
    const e = Math.min(Math.ceil(endTime * sr), buf.length);
    const newLen = buf.length - (e - s);
    if (newLen <= 0) return null;  // validate before touching undo stack
    await this._pushUndo();
    const nb = this.getCtx().createBuffer(buf.numberOfChannels, newLen, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = nb.getChannelData(c);
      dst.set(src.subarray(0, s), 0);
      dst.set(src.subarray(e), s);
    }
    this.workBuffer = nb;
    return nb;
  }

  // ── Clipboard ─────────────────────────────────────────────────────────
  copySelection(startTime, endTime) {
    const buf = this.workBuffer;
    if (!buf) return null;
    const sr = buf.sampleRate;
    const s = Math.floor(startTime * sr);
    const e = Math.min(Math.ceil(endTime * sr), buf.length);
    const len = e - s;
    if (len <= 0) return null;
    const clip = this.getCtx().createBuffer(buf.numberOfChannels, len, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      clip.getChannelData(c).set(buf.getChannelData(c).subarray(s, e));
    }
    this.clipboardBuffer = clip;
    return clip;
  }

  async cutSelection(startTime, endTime) {
    this.copySelection(startTime, endTime);
    return await this.deleteSelection(startTime, endTime);
  }

  async pasteAtTime(insertTime) {
    const buf = this.workBuffer;
    const clip = this.clipboardBuffer;
    if (!buf || !clip) return null;
    await this._pushUndo();
    const sr = buf.sampleRate;
    const ins = Math.max(0, Math.min(Math.floor(insertTime * sr), buf.length));
    const newLen = buf.length + clip.length;
    const nb = this.getCtx().createBuffer(buf.numberOfChannels, newLen, sr);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = nb.getChannelData(c);
      dst.set(src.subarray(0, ins), 0);
      // If clipboard has fewer channels, mirror ch 0
      const clipCh = clip.getChannelData(Math.min(c, clip.numberOfChannels - 1));
      dst.set(clipCh, ins);
      dst.set(src.subarray(ins), ins + clip.length);
    }
    this.workBuffer = nb;
    return nb;
  }

  async reverse(startTime, endTime) {
    const buf = this.workBuffer;
    if (!buf) return;
    await this._pushUndo();
    const sr = buf.sampleRate;
    const s = startTime !== null ? Math.floor(startTime * sr) : 0;
    const e = endTime !== null ? Math.min(Math.ceil(endTime * sr), buf.length) : buf.length;
    const nb = this._cloneBuffer(buf);
    for (let c = 0; c < nb.numberOfChannels; c++) {
      const d = nb.getChannelData(c);
      const chunk = d.slice(s, e);
      chunk.reverse();
      d.set(chunk, s);
    }
    this.workBuffer = nb;
    return nb;
  }

  async normalize(startTime, endTime, targetDb) {
    const buf = this.workBuffer;
    if (!buf) return;
    const sr = buf.sampleRate;
    const s = startTime !== null ? Math.floor(startTime * sr) : 0;
    const e = endTime !== null ? Math.min(Math.ceil(endTime * sr), buf.length) : buf.length;
    const target = Math.pow(10, (targetDb || -0.1) / 20);
    // Pre-scan peak BEFORE touching undo stack — avoids ghost entries
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = s; i < e; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    if (peak === 0) return;  // silent region — nothing to do, don't pollute undo stack
    await this._pushUndo();
    const gain = target / peak;
    const nb = this._cloneBuffer(buf);
    for (let c = 0; c < nb.numberOfChannels; c++) {
      const d = nb.getChannelData(c);
      for (let i = s; i < e; i++) d[i] = Math.max(-1, Math.min(1, d[i] * gain));
    }
    this.workBuffer = nb;
    return nb;
  }

  async removeDC() {
    const buf = this.workBuffer;
    if (!buf) return;
    await this._pushUndo();
    const nb = this._cloneBuffer(buf);
    for (let c = 0; c < nb.numberOfChannels; c++) {
      const d = nb.getChannelData(c);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i];
      const dc = sum / d.length;
      for (let i = 0; i < d.length; i++) d[i] -= dc;
    }
    this.workBuffer = nb;
    return nb;
  }

  async stereoToMono() {
    const buf = this.workBuffer;
    if (!buf) return;
    await this._pushUndo();
    const nb = this.getCtx().createBuffer(1, buf.length, buf.sampleRate);
    const d = nb.getChannelData(0);
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    for (let i = 0; i < buf.length; i++) d[i] = (L[i] + R[i]) * 0.5;
    this.workBuffer = nb;
    return nb;
  }

  async swapLR() {
    const buf = this.workBuffer;
    if (!buf || buf.numberOfChannels < 2) return;
    await this._pushUndo();
    const nb = this._cloneBuffer(buf);
    const tmp = Float32Array.from(nb.getChannelData(0));
    nb.getChannelData(0).set(nb.getChannelData(1));
    nb.getChannelData(1).set(tmp);
    this.workBuffer = nb;
    return nb;
  }

  async invertPhase() {
    const buf = this.workBuffer;
    if (!buf) return;
    await this._pushUndo();
    const nb = this._cloneBuffer(buf);
    for (let c = 0; c < nb.numberOfChannels; c++) {
      const d = nb.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = -d[i];
    }
    this.workBuffer = nb;
    return nb;
  }

  // ── UNDO / REDO (IndexedDB-backed, RAM-safe) ──────────────────────────
  // All three methods are async — AudioBuffer data lives in IDB, not RAM.
  async _pushUndo() {
    await this._undoMgr.push(this.workBuffer);
  }
  async undo() {
    if (!this._undoMgr.canUndo()) return null;
    const buf = await this._undoMgr.undo(this.workBuffer, this.getCtx());
    if (buf) this.workBuffer = buf;
    return this.workBuffer;
  }
  async redo() {
    if (!this._undoMgr.canRedo()) return null;
    const buf = await this._undoMgr.redo(this.workBuffer, this.getCtx());
    if (buf) this.workBuffer = buf;
    return this.workBuffer;
  }
  canUndo() { return this._undoMgr.canUndo(); }
  canRedo() { return this._undoMgr.canRedo(); }
  undoCount() { return this._undoMgr.undoCount(); }
  redoCount() { return this._undoMgr.redoCount(); }

  _cloneBuffer(buf) {
    if (!buf) return null;
    const ctx = this.getCtx();
    const nb = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      nb.getChannelData(c).set(buf.getChannelData(c));
    }
    return nb;
  }

  // ── IMPULSE RESPONSE (for Reverb) ────────────────────────────────────
  createImpulse(duration, decay) {
    const ctx = this.getCtx();
    const key = `${duration}_${decay}`;
    if (this._impulseCache[key]) return this._impulseCache[key];
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * duration);
    const impulse = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = impulse.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    this._impulseCache[key] = impulse;
    return impulse;
  }

  // ── DISTORTION CURVE ─────────────────────────────────────────────────
  makeDistCurve(drive, type) {
    const n = 512;
    const curve = new Float32Array(n);
    const k = drive * 3;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      switch (type) {
        case 'hard': curve[i] = Math.max(-1, Math.min(1, x * (1 + k))); break;
        case 'fuzz': curve[i] = Math.sign(x) * (1 - Math.exp(-Math.abs(x) * k)); break;
        case 'tape': curve[i] = Math.tanh(x * (1 + k * 0.5)); break;
        default: curve[i] = ((3 + k) * x) / (Math.PI * (1 + (k * Math.abs(x)))); break;
      }
    }
    return curve;
  }

  // ── BUILD AUDIO GRAPH ─────────────────────────────────────────────────
  buildGraph() {
    const ctx = this.getCtx();
    const p = this.params;

    // Analysers (always present)
    const analyser = ctx.createAnalyser(); analyser.fftSize = 4096;
    const scopeAnalyser = ctx.createAnalyser(); scopeAnalyser.fftSize = 2048;
    const corrAnalyser = ctx.createAnalyser(); corrAnalyser.fftSize = 2048;

    // Master gain
    const masterGain = ctx.createGain();
    masterGain.gain.value = p.masterVol * p.masterGain2;

    // Pan node
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = p.pan;

    // Compressor
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = p.compThreshold;
    comp.ratio.value = p.compRatio;
    comp.attack.value = p.compAttack;
    comp.release.value = p.compRelease;
    comp.knee.value = p.compKnee;
    const compGainNode = ctx.createGain();
    compGainNode.gain.value = Math.pow(10, p.compGain / 20);

    // EQ chain (7 bands)
    const eqFreqs = [32, 100, 300, 1000, 3500, 8000, 16000];
    const eqTypes = ['lowshelf','lowshelf','peaking','peaking','peaking','highshelf','highshelf'];
    const eqNodes = eqFreqs.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.type = eqTypes[i]; f.frequency.value = freq;
      f.gain.value = p.eqBypass ? 0 : p.eq[i];
      if (f.type === 'peaking') f.Q.value = 1.2;
      return f;
    });

    // Bass enhancement
    const bassNodes = [];
    if (p.bassEnhOn) {
      const subFilter = ctx.createBiquadFilter();
      subFilter.type = 'lowshelf'; subFilter.frequency.value = 80;
      subFilter.gain.value = p.bassSubBoost;
      const punchFilter = ctx.createBiquadFilter();
      punchFilter.type = 'peaking'; punchFilter.frequency.value = 100;
      punchFilter.Q.value = 1.5; punchFilter.gain.value = p.bassPunch;
      const warmFilter = ctx.createBiquadFilter();
      warmFilter.type = 'peaking'; warmFilter.frequency.value = 200;
      warmFilter.Q.value = 1.0; warmFilter.gain.value = p.bassWarmth;
      const tightFilter = ctx.createBiquadFilter();
      tightFilter.type = 'peaking'; tightFilter.frequency.value = 400;
      tightFilter.Q.value = 1.0; tightFilter.gain.value = -p.bassTighten;
      bassNodes.push(subFilter, punchFilter, warmFilter, tightFilter);
    }

    // Reverb
    let reverbNode = null, reverbWetGain = null;
    if (p.reverbOn) {
      reverbNode = ctx.createConvolver();
      reverbNode.buffer = this.createImpulse(p.reverbSize, p.reverbDecay);
      reverbWetGain = ctx.createGain(); reverbWetGain.gain.value = p.reverbWet;
    }

    // Delay
    let delayNode = null, delayFbGain = null, delayWetGain = null;
    if (p.delayOn) {
      delayNode = ctx.createDelay(2.0); delayNode.delayTime.value = p.delayTime;
      delayFbGain = ctx.createGain(); delayFbGain.gain.value = p.delayFeedback;
      delayWetGain = ctx.createGain(); delayWetGain.gain.value = p.delayWet;
    }

    // Distortion
    let distNode = null, distToneFilter = null, distWetGain = null, distDryGain = null;
    if (p.distOn) {
      distNode = ctx.createWaveShaper();
      distNode.curve = this.makeDistCurve(p.distDrive / 100, p.distType);
      distNode.oversample = '4x';
      distToneFilter = ctx.createBiquadFilter();
      distToneFilter.type = 'lowpass'; distToneFilter.frequency.value = p.distTone;
      distWetGain = ctx.createGain(); distWetGain.gain.value = p.distWet;
      distDryGain = ctx.createGain(); distDryGain.gain.value = 1 - p.distWet;
    }

    // Chorus (via LFO + delay)
    let chorusDelay = null, chorusLFO = null, chorusWetGain = null, chorusDryGain = null;
    if (p.chorusOn) {
      chorusDelay = ctx.createDelay(0.1);
      chorusDelay.delayTime.value = p.chorusDepth;
      chorusLFO = ctx.createOscillator();
      chorusLFO.frequency.value = p.chorusRate;
      const lfoGain = ctx.createGain(); lfoGain.gain.value = p.chorusDepth;
      chorusLFO.connect(lfoGain); lfoGain.connect(chorusDelay.delayTime);
      chorusLFO.start();
      chorusWetGain = ctx.createGain(); chorusWetGain.gain.value = p.chorusWet;
      chorusDryGain = ctx.createGain(); chorusDryGain.gain.value = 1 - p.chorusWet * 0.5;
    }

    // Chain: EQ → bass → comp → effects → master → pan → analyser → dest
    let chain = [];
    chain.push(...eqNodes);
    if (bassNodes.length) chain.push(...bassNodes);
    if (!p.compBypass) { chain.push(comp, compGainNode); }

    // Build simple chain
    const chainEntry = chain[0];
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    const chainExit = chain[chain.length - 1];

    // Connect effects in parallel with dry signal
    const effectsInput = ctx.createGain();
    const effectsMix = ctx.createGain();
    chainExit.connect(effectsInput);

    const dryBus = ctx.createGain(); dryBus.gain.value = 1;
    effectsInput.connect(dryBus);
    dryBus.connect(effectsMix);

    // Reverb
    if (p.reverbOn && reverbNode) {
      effectsInput.connect(reverbNode);
      reverbNode.connect(reverbWetGain);
      reverbWetGain.connect(effectsMix);
    }
    // Delay
    if (p.delayOn && delayNode) {
      effectsInput.connect(delayNode);
      delayNode.connect(delayFbGain);
      delayFbGain.connect(delayNode);
      delayNode.connect(delayWetGain);
      delayWetGain.connect(effectsMix);
    }
    // Distortion
    if (p.distOn && distNode) {
      effectsInput.connect(distNode);
      distNode.connect(distToneFilter);
      distToneFilter.connect(distWetGain);
      distWetGain.connect(effectsMix);
    }
    // Chorus
    if (p.chorusOn && chorusDelay) {
      effectsInput.connect(chorusDelay);
      chorusDelay.connect(chorusWetGain);
      chorusWetGain.connect(effectsMix);
    }

    // Master → pan → analyser → dest
    effectsMix.connect(masterGain);
    let lastNode = masterGain;
    if (panner) { masterGain.connect(panner); lastNode = panner; }

    // Stereo split for scope/correlation
    lastNode.connect(analyser);
    lastNode.connect(scopeAnalyser);

    analyser.connect(ctx.destination);

    this.nodes = {
      chainEntry, analyser, scopeAnalyser, corrAnalyser,
      eqNodes, masterGain, comp, panner, chorusLFO
    };

    return chainEntry;
  }

  // ── PLAYBACK ──────────────────────────────────────────────────────────
  play(offset) {
    if (!this.workBuffer) return;
    this.stop(true);
    const ctx = this.getCtx();
    const p = this.params;

    // Determine buffer (vocal processing)
    let buf = this.workBuffer;
    if (p.vocalRemoval && this.origBuffer && this.origBuffer.numberOfChannels >= 2) {
      buf = this.computeVocalBuffer('remove');
    } else if (p.vocalIsolate && this.origBuffer && this.origBuffer.numberOfChannels >= 2) {
      buf = this.computeVocalBuffer('isolate');
    }

    const entryNode = this.buildGraph();
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = p.playbackRate;

    const loopStart = this.loopStart;
    const loopEnd = this.loopEnd > loopStart ? this.loopEnd : buf.duration;
    if (this.loop) {
      source.loop = true;
      source.loopStart = loopStart;
      source.loopEnd = loopEnd;
    }

    source.connect(entryNode);

    const when = 0;
    const start = offset !== undefined ? offset : this.pauseOffset;
    source.start(when, start);
    this.source = source;
    this.startTime = ctx.currentTime - start;
    this.state = 'playing';

    source.onended = () => {
      if (this.state === 'playing') {
        this.state = 'stopped';
        this.pauseOffset = 0;
        if (this.onEnded) this.onEnded();
      }
    };

    this._startRAF();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.pauseOffset = this.currentTime;
    this.stop(true);
    this.state = 'paused';
  }

  stop(silent) {
    if (this.source) {
      try { this.source.stop(); this.source.disconnect(); } catch {}
      this.source = null;
    }
    if (this.nodes.chorusLFO) { try { this.nodes.chorusLFO.stop(); } catch {} }
    this._stopRAF();
    if (!silent) {
      this.state = 'stopped';
      this.pauseOffset = 0;
      if (this.onTimeUpdate) this.onTimeUpdate(0);
    }
  }

  get currentTime() {
    if (this.state === 'playing' && this.ctx) {
      const t = this.ctx.currentTime - this.startTime;
      const dur = this.workBuffer ? this.workBuffer.duration : 0;
      return Math.min(t, dur);
    }
    return this.pauseOffset;
  }

  get duration() { return this.workBuffer ? this.workBuffer.duration : 0; }

  seek(time) {
    const wasPlaying = this.state === 'playing';
    this.pauseOffset = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying) this.play(this.pauseOffset);
    else if (this.onTimeUpdate) this.onTimeUpdate(this.pauseOffset);
  }

  _startRAF() {
    const tick = () => {
      if (this.state !== 'playing') return;
      if (this.onTimeUpdate) this.onTimeUpdate(this.currentTime);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }
  _stopRAF() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  // ── EXPORT ────────────────────────────────────────────────────────────
  async export(options, onProgress) {
    const { startTime, endTime, sampleRate, channels } = options;
    let srcBuf = this.workBuffer;
    const p = this.params;

    // Apply vocal processing to source buf
    if (p.vocalRemoval && srcBuf.numberOfChannels >= 2) {
      srcBuf = this.computeVocalBuffer('remove');
    } else if (p.vocalIsolate && srcBuf.numberOfChannels >= 2) {
      srcBuf = this.computeVocalBuffer('isolate');
    }

    const sr = sampleRate || srcBuf.sampleRate;
    const s = startTime ? Math.floor(startTime * srcBuf.sampleRate) : 0;
    const e = endTime ? Math.ceil(endTime * srcBuf.sampleRate) : srcBuf.length;
    const len = e - s;
    const numCh = channels === 'mono' ? 1 : (channels === 'stereo' ? 2 : srcBuf.numberOfChannels);

    const octx = new OfflineAudioContext(numCh, Math.ceil(len * (sr / srcBuf.sampleRate)), sr);
    const src = octx.createBufferSource();

    // Create region buffer
    const region = octx.createBuffer(srcBuf.numberOfChannels, len, srcBuf.sampleRate);
    for (let c = 0; c < srcBuf.numberOfChannels; c++) {
      region.getChannelData(c).set(srcBuf.getChannelData(c).subarray(s, e));
    }
    src.buffer = region;
    src.playbackRate.value = p.playbackRate;

    // EQ
    const eqFreqs = [32, 100, 300, 1000, 3500, 8000, 16000];
    const eqTypes = ['lowshelf','lowshelf','peaking','peaking','peaking','highshelf','highshelf'];
    const eqNodes = eqFreqs.map((freq, i) => {
      const f = octx.createBiquadFilter();
      f.type = eqTypes[i]; f.frequency.value = freq;
      f.gain.value = p.eqBypass ? 0 : p.eq[i];
      if (f.type === 'peaking') f.Q.value = 1.2;
      return f;
    });

    // Bass
    const bassNodes = [];
    if (p.bassEnhOn) {
      const filters = [
        { type:'lowshelf', freq:80, gain:p.bassSubBoost },
        { type:'peaking',  freq:100, gain:p.bassPunch, Q:1.5 },
        { type:'peaking',  freq:200, gain:p.bassWarmth, Q:1.0 },
        { type:'peaking',  freq:400, gain:-p.bassTighten, Q:1.0 },
      ];
      filters.forEach(f => {
        const n = octx.createBiquadFilter();
        n.type = f.type; n.frequency.value = f.freq;
        n.gain.value = f.gain; if (f.Q) n.Q.value = f.Q;
        bassNodes.push(n);
      });
    }

    // Compressor
    const comp = octx.createDynamicsCompressor();
    if (!p.compBypass) {
      comp.threshold.value = p.compThreshold; comp.ratio.value = p.compRatio;
      comp.attack.value = p.compAttack; comp.release.value = p.compRelease;
      comp.knee.value = p.compKnee;
    }
    const compGain = octx.createGain();
    compGain.gain.value = Math.pow(10, p.compGain / 20);

    // Master
    const masterGain = octx.createGain();
    masterGain.gain.value = p.masterVol * p.masterGain2;

    // Reverb
    const reverbNode = octx.createConvolver();
    if (p.reverbOn) {
      const ir = this.createImpulse(p.reverbSize, p.reverbDecay);
      const octxIR = octx.createBuffer(ir.numberOfChannels, ir.length, ir.sampleRate);
      for (let c = 0; c < ir.numberOfChannels; c++) octxIR.getChannelData(c).set(ir.getChannelData(c));
      reverbNode.buffer = octxIR;
    }
    const revWet = octx.createGain(); revWet.gain.value = p.reverbOn ? p.reverbWet : 0;

    // Delay
    let delayNode = null, delayFbGain = null, delayWetGain = null;
    if (p.delayOn) {
      delayNode = octx.createDelay(2.0); delayNode.delayTime.value = p.delayTime;
      delayFbGain = octx.createGain(); delayFbGain.gain.value = p.delayFeedback;
      delayWetGain = octx.createGain(); delayWetGain.gain.value = p.delayWet;
    }

    // Distortion
    let distNode = null, distToneFilter = null, distWetGain = null;
    if (p.distOn) {
      distNode = octx.createWaveShaper();
      distNode.curve = this.makeDistCurve(p.distDrive / 100, p.distType);
      distNode.oversample = '4x';
      distToneFilter = octx.createBiquadFilter();
      distToneFilter.type = 'lowpass'; distToneFilter.frequency.value = p.distTone;
      distWetGain = octx.createGain(); distWetGain.gain.value = p.distWet;
    }

    // Chorus
    let chorusDelay = null, chorusLFO = null, chorusWetGain = null;
    if (p.chorusOn) {
      chorusDelay = octx.createDelay(0.1);
      chorusDelay.delayTime.value = p.chorusDepth;
      chorusLFO = octx.createOscillator();
      chorusLFO.frequency.value = p.chorusRate;
      const lfoGain = octx.createGain(); lfoGain.gain.value = p.chorusDepth;
      chorusLFO.connect(lfoGain); lfoGain.connect(chorusDelay.delayTime);
      chorusLFO.start();
      chorusWetGain = octx.createGain(); chorusWetGain.gain.value = p.chorusWet;
    }

    // Chain: EQ → bass → [comp] → masterGain → effects mix → destination
    let chain = [...eqNodes, ...bassNodes];
    if (!p.compBypass) chain.push(comp, compGain);
    chain.push(masterGain);
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i+1]);

    src.connect(chain[0]);

    // Parallel effects bus (dry + wet effects)
    const effectsInput = masterGain;
    const effectsMix = octx.createGain();

    const dryBus = octx.createGain(); dryBus.gain.value = 1;
    effectsInput.connect(dryBus); dryBus.connect(effectsMix);

    // Reverb
    if (p.reverbOn) {
      effectsInput.connect(reverbNode); reverbNode.connect(revWet); revWet.connect(effectsMix);
    }
    // Delay
    if (p.delayOn && delayNode) {
      effectsInput.connect(delayNode);
      delayNode.connect(delayFbGain); delayFbGain.connect(delayNode);
      delayNode.connect(delayWetGain); delayWetGain.connect(effectsMix);
    }
    // Distortion
    if (p.distOn && distNode) {
      effectsInput.connect(distNode);
      distNode.connect(distToneFilter);
      distToneFilter.connect(distWetGain); distWetGain.connect(effectsMix);
    }
    // Chorus
    if (p.chorusOn && chorusDelay) {
      effectsInput.connect(chorusDelay);
      chorusDelay.connect(chorusWetGain); chorusWetGain.connect(effectsMix);
    }

    effectsMix.connect(octx.destination);
    src.start(0);

    if (onProgress) onProgress(10);
    const rendered = await octx.startRendering();
    if (onProgress) onProgress(80);

    // Encode WAV
    const wav = this._encodeWAV(rendered, options.bit32);
    if (onProgress) onProgress(100);
    return wav;
  }

  _encodeWAV(audioBuffer, float32) {
    const numCh = audioBuffer.numberOfChannels;
    const sr = audioBuffer.sampleRate;
    const n = audioBuffer.length;
    const bps = float32 ? 4 : 2;
    const dataLen = numCh * n * bps;
    const buf = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o+i, s.charCodeAt(i)); };
    ws(0,'RIFF'); view.setUint32(4, 36+dataLen, true); ws(8,'WAVE');
    ws(12,'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, float32 ? 3 : 1, true); view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr*numCh*bps, true);
    view.setUint16(32, numCh*bps, true); view.setUint16(34, bps*8, true);
    ws(36,'data'); view.setUint32(40, dataLen, true);
    let offset = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(c)[i]));
        if (float32) { view.setFloat32(offset, s, true); offset += 4; }
        else { view.setInt16(offset, s * 0x7FFF, true); offset += 2; }
      }
    }
    return buf;
  }

  // Update params and rebuild if playing
  setParam(key, value) {
    this.params[key] = value;
  }
  setEQ(band, value) {
    this.params.eq[band] = value;
    // Update live node if playing
    if (this.nodes.eqNodes && this.nodes.eqNodes[band]) {
      this.nodes.eqNodes[band].gain.value = this.params.eqBypass ? 0 : value;
    }
  }
}
