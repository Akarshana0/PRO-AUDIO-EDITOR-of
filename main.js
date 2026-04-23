// ── AudioForge Main ───────────────────────────────────────────────────
import { AudioEngine } from './audio-engine.js';
import { WaveformRenderer, SpectrumAnalyzer, Oscilloscope } from './waveform.js';

// ── State ─────────────────────────────────────────────────────────────
const engine = new AudioEngine();
let waveform, spectrum, scope;
let selStart = null, selEnd = null;
let loopMode = false;
const eqColors = ['#ff4444','#ff8c00','#ffcc00','#44ff88','#00d4ff','#60a0ff','#aa44ff'];

// ── Helpers ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = (s) => {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2,'0')}:${ss.toFixed(3).padStart(6,'0')}`;
};

function toast(msg, type = 'info', dur = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, dur);
}

function showModal(text = 'Processing...') {
  $('exportModal').classList.remove('hidden');
  $('exportText').textContent = text;
  $('exportProgress').style.width = '0%';
}
function updateModal(pct, text) {
  $('exportProgress').style.width = pct + '%';
  if (text) $('exportText').textContent = text;
}
function hideModal() { $('exportModal').classList.add('hidden'); }

// ── Undo/Redo Button State ─────────────────────────────────────────────
function updateUndoRedoButtons() {
  const undoBtn = $('btnUndo');
  const redoBtn = $('btnRedo');
  if (undoBtn) undoBtn.disabled = !engine.canUndo();
  if (redoBtn) redoBtn.disabled = !engine.canRedo();
  // Update counter badges if they exist
  const undoCount = $('undoCount');
  const redoCount = $('redoCount');
  if (undoCount) undoCount.textContent = engine.undoCount() || '';
  if (redoCount) redoCount.textContent = engine.redoCount() || '';
}

function runLoadingScreen() {
  const bar = $('loadingBar'), text = $('loadingText');
  const isOffline = !navigator.onLine;
  const steps = [
    [15, 'Loading audio engine...'],
    [35, 'Initializing effects chain...'],
    [55, 'Building interface...'],
    [75, isOffline ? '✈ Running from cache...' : 'Loading assets...'],
    [90, isOffline ? 'Offline mode ready!' : 'Almost ready...'],
    [100, 'Welcome to AudioForge!'],
  ];
  let i = 0;
  const run = () => {
    if (i >= steps.length) {
      setTimeout(() => {
        $('loadingScreen').style.opacity = '0';
        $('loadingScreen').style.transition = 'opacity 0.5s';
        $('app').classList.remove('hidden');
        setTimeout(() => $('loadingScreen').style.display = 'none', 500);
      }, 300);
      return;
    }
    const [pct, msg] = steps[i++];
    bar.style.width = pct + '%';
    text.textContent = msg;
    setTimeout(run, 260);
  };
  setTimeout(run, 200);
}

// ── Tab Navigation ────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── File Loading ──────────────────────────────────────────────────────
async function loadAudioFile(file) {
  showModal('Decoding audio...');
  updateModal(10, 'Reading file...');
  try {
    const ab = await file.arrayBuffer();
    updateModal(40, 'Decoding audio...');
    const buf = await engine.loadFile(ab);
    updateModal(80, 'Building waveform...');
    waveform.loadBuffer(buf);
    updateModal(100, 'Done!');
    // UI updates
    $('fileName').textContent = file.name;
    $('fileMeta').textContent = `${buf.numberOfChannels}ch · ${(buf.sampleRate/1000).toFixed(1)}kHz · ${fmt(buf.duration)}`;
    $('timeTotal').textContent = fmt(buf.duration);
    $('timeCurrent').textContent = '00:00.000';
    $('btnExport').disabled = false;
    $('dropZone').style.display = 'none';
    // Mono warning
    if (buf.numberOfChannels < 2) {
      $('monoWarning').style.display = 'block';
      $('vocalRemoval').disabled = true;
      $('vocalIsolate').disabled = true;
    } else {
      $('monoWarning').style.display = 'none';
      $('vocalRemoval').disabled = false;
      $('vocalIsolate').disabled = false;
    }
    selStart = null; selEnd = null;
    updateSelectionUI();
    toast(`Loaded: ${file.name}`, 'success');
    setTimeout(hideModal, 400);
  } catch(e) {
    hideModal();
    toast('Failed to load audio file. Try MP3, WAV, OGG, or FLAC.', 'error', 4000);
    console.error(e);
  }
}

$('fileInput').addEventListener('change', e => { if(e.target.files[0]) loadAudioFile(e.target.files[0]); });
$('btnLoad').addEventListener('click', () => $('fileInput').click());
$('btnLoadBig').addEventListener('click', () => $('fileInput').click());

// Drag & drop on entire app
const wfContainer = $('waveformContainer');
['dragover','dragenter'].forEach(ev => {
  document.addEventListener(ev, e => {
    e.preventDefault();
    wfContainer.classList.add('wf-dragover');
  });
});
document.addEventListener('dragleave', e => {
  if (!e.relatedTarget || !document.contains(e.relatedTarget)) {
    wfContainer.classList.remove('wf-dragover');
  }
});
document.addEventListener('drop', e => {
  e.preventDefault();
  wfContainer.classList.remove('wf-dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('audio/')) loadAudioFile(file);
  else toast('Please drop an audio file.', 'error');
});

// ── Transport ─────────────────────────────────────────────────────────
engine.onTimeUpdate = (t) => {
  $('timeCurrent').textContent = fmt(t);
  $('wfCurrentTime').textContent = fmt(t);
  const pct = engine.duration > 0 ? (t / engine.duration) * 100 : 0;
  $('progressFill').style.width = pct + '%';
  $('progressHead').style.left = pct + '%';
  if (waveform) waveform.setPlayhead(t);
};

engine.onEnded = () => {
  $('btnPlay').textContent = '▶';
  $('btnPlay').classList.remove('playing');
  engine.state = 'stopped';
  engine.pauseOffset = 0;
};

$('btnPlay').addEventListener('click', () => {
  if (!engine.workBuffer) { toast('Load an audio file first', 'error'); return; }
  if (engine.state === 'playing') {
    engine.pause();
    $('btnPlay').textContent = '▶';
    $('btnPlay').classList.remove('playing');
  } else {
    engine.loop = loopMode;
    if (loopMode && selStart !== null) {
      engine.loopStart = selStart;
      engine.loopEnd = selEnd;
    }
    engine.play();
    $('btnPlay').textContent = '⏸';
    $('btnPlay').classList.add('playing');
  }
});

$('btnStop').addEventListener('click', () => {
  engine.stop();
  $('btnPlay').textContent = '▶';
  $('btnPlay').classList.remove('playing');
  engine.pauseOffset = 0;
  if(waveform) waveform.setPlayhead(0);
  $('timeCurrent').textContent = '00:00.000';
  $('progressFill').style.width = '0%';
  $('progressHead').style.left = '0%';
});

$('btnSkipStart').addEventListener('click', () => {
  engine.seek(0);
  if(waveform) waveform.setPlayhead(0);
});
$('btnSkipEnd').addEventListener('click', () => {
  engine.seek(engine.duration);
});
$('btnLoop').addEventListener('click', () => {
  loopMode = !loopMode;
  engine.loop = loopMode;
  $('btnLoop').classList.toggle('active', loopMode);
  toast(loopMode ? 'Loop ON' : 'Loop OFF', 'info', 1500);
});

// Progress bar seek
$('progressTrack').addEventListener('click', e => {
  const rect = $('progressTrack').getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * engine.duration;
  engine.seek(t);
  if (waveform) waveform.setPlayhead(t);
});

// Master volume
$('masterVol').addEventListener('input', e => {
  const v = Number(e.target.value);
  $('volVal').textContent = v + '%';
  engine.params.masterVol = v / 100;
  if (engine.nodes.masterGain) engine.nodes.masterGain.gain.value = v / 100 * engine.params.masterGain2;
});

// ── EQ ────────────────────────────────────────────────────────────────
for (let i = 0; i < 7; i++) {
  const el = $('b' + i);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    engine.setEQ(i, v);
    $('bv' + i).textContent = (v >= 0 ? '+' : '') + v.toFixed(1) + 'dB';
    $('bv' + i).style.color = eqColors[i];
    drawEQCurve();
  });
}

$('eqBypass').addEventListener('click', () => {
  engine.params.eqBypass = !engine.params.eqBypass;
  $('eqBypass').classList.toggle('active', engine.params.eqBypass);
  for (let i = 0; i < 7; i++) {
    if (engine.nodes.eqNodes && engine.nodes.eqNodes[i]) {
      engine.nodes.eqNodes[i].gain.value = engine.params.eqBypass ? 0 : engine.params.eq[i];
    }
  }
  toast(engine.params.eqBypass ? 'EQ Bypassed' : 'EQ Active', 'info', 1500);
  drawEQCurve();
});

$('eqReset').addEventListener('click', () => {
  for (let i = 0; i < 7; i++) {
    $('b' + i).value = 0;
    engine.setEQ(i, 0);
    $('bv' + i).textContent = '0dB';
    $('bv' + i).style.color = '';
  }
  drawEQCurve();
  toast('EQ Reset', 'info', 1200);
});

// EQ Presets
const eqPresets = {
  flat:       [0,0,0,0,0,0,0],
  bass_boost: [5,8,3,0,0,0,0],
  vocal_boost:[-2,-2,0,5,7,5,2],
  v_shape:    [6,5,0,-4,0,5,5],
  club:       [4,6,2,0,2,4,3],
  clarity:    [-2,0,-1,3,6,7,5],
  warm:       [2,4,3,1,-1,-2,-3],
  rock:       [4,3,1,-1,3,5,4],
  acoustic:   [1,2,3,4,3,2,1],
  podcast:    [-3,-2,1,5,6,4,2],
};
$('eqPreset').addEventListener('change', e => {
  const p = eqPresets[e.target.value];
  if (!p) return;
  p.forEach((v, i) => {
    $('b'+i).value = v;
    engine.setEQ(i, v);
    $('bv'+i).textContent = (v>=0?'+':'')+v.toFixed(1)+'dB';
    $('bv'+i).style.color = v !== 0 ? eqColors[i] : '';
  });
  drawEQCurve();
  toast(`Preset: ${e.target.value.replace('_',' ')}`, 'info', 1500);
  e.target.value = '';
});

function drawEQCurve() {
  const c = $('eqCurve');
  const ctx = c.getContext('2d');
  const W = c.clientWidth || c.width;
  const H = c.height;
  c.width = W;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = '#020509';
  ctx.fillRect(0,0,W,H);
  // grid
  ctx.strokeStyle = 'rgba(10,30,60,0.5)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0,H/2); ctx.lineTo(W,H/2); ctx.stroke();
  [H*0.2, H*0.8].forEach(y => {
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
  });
  // curve
  const freqs = [32,100,300,1000,3500,8000,16000];
  const gains = engine.params.eq;
  const bypass = engine.params.eqBypass;
  const pts = freqs.map((f, i) => {
    const x = (Math.log10(f/20) / Math.log10(24000/20)) * W;
    const y = H/2 - (bypass ? 0 : gains[i]) / 15 * (H/2 * 0.85);
    return [x, y];
  });
  // Smooth curve
  ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 2;
  ctx.shadowBlur = 6; ctx.shadowColor = '#0070ff';
  ctx.beginPath();
  ctx.moveTo(0, H/2);
  pts.forEach(([x,y], i) => {
    if (i === 0) { ctx.lineTo(x, y); return; }
    const [px, py] = pts[i-1];
    const cpx = (px + x) / 2;
    ctx.bezierCurveTo(cpx, py, cpx, y, x, y);
  });
  ctx.lineTo(W, H/2);
  ctx.stroke(); ctx.shadowBlur = 0;
  // Dots at band frequencies
  pts.forEach(([x,y], i) => {
    ctx.fillStyle = eqColors[i];
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2); ctx.fill();
  });
}

// ── Compressor ────────────────────────────────────────────────────────
const bindCompressor = (id, paramKey, display, unit='') => {
  $(id).addEventListener('input', e => {
    const v = Number(e.target.value);
    engine.params[paramKey] = v;
    $(display).textContent = v + unit;
    if (engine.nodes.comp) {
      try { engine.nodes.comp[paramKey.replace('comp','').toLowerCase().replace('threshold','threshold').replace('ratio','ratio').replace('attack','attack').replace('release','release').replace('knee','knee')].value = v; } catch {}
    }
  });
};
$('compThresh').addEventListener('input', e => { engine.params.compThreshold = +e.target.value; $('compThreshVal').textContent = e.target.value+'dB'; if(engine.nodes.comp) engine.nodes.comp.threshold.value=+e.target.value; });
$('compRatio').addEventListener('input', e => { engine.params.compRatio = +e.target.value; $('compRatioVal').textContent = e.target.value+':1'; if(engine.nodes.comp) engine.nodes.comp.ratio.value=+e.target.value; });
$('compAttack').addEventListener('input', e => { engine.params.compAttack = +e.target.value/1000; $('compAttackVal').textContent = e.target.value+'ms'; if(engine.nodes.comp) engine.nodes.comp.attack.value=+e.target.value/1000; });
$('compRelease').addEventListener('input', e => { engine.params.compRelease = +e.target.value/1000; $('compReleaseVal').textContent = e.target.value+'ms'; if(engine.nodes.comp) engine.nodes.comp.release.value=+e.target.value/1000; });
$('compKnee').addEventListener('input', e => { engine.params.compKnee = +e.target.value; $('compKneeVal').textContent = e.target.value+'dB'; if(engine.nodes.comp) engine.nodes.comp.knee.value=+e.target.value; });
$('compGain').addEventListener('input', e => { engine.params.compGain = +e.target.value; $('compGainVal').textContent = '+'+e.target.value+'dB'; });
$('compBypass').addEventListener('click', () => {
  engine.params.compBypass = !engine.params.compBypass;
  $('compBypass').classList.toggle('active', engine.params.compBypass);
  toast(engine.params.compBypass ? 'Compressor Bypassed' : 'Compressor Active', 'info', 1500);
});

// ── Master ────────────────────────────────────────────────────────────
$('masterGain2').addEventListener('input', e => {
  engine.params.masterGain2 = +e.target.value/100;
  $('masterGain2Val').textContent = e.target.value+'%';
  if(engine.nodes.masterGain) engine.nodes.masterGain.gain.value = engine.params.masterVol * engine.params.masterGain2;
});
$('stereoWidth').addEventListener('input', e => {
  engine.params.stereoWidth = +e.target.value/100;
  $('stereoWidthVal').textContent = e.target.value+'%';
});
$('btnNormalize').addEventListener('click', async () => {
  if(!engine.workBuffer) return;
  await engine.normalize(null, null, -0.1);
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('Normalized to -0.1dB', 'success');
});

// ── Effects ───────────────────────────────────────────────────────────
const bindEffect = (toggleId, paramKey, controls) => {
  $(toggleId).addEventListener('change', e => {
    engine.params[paramKey] = e.target.checked;
    toast(e.target.checked ? paramKey.replace('On','') + ' ON' : paramKey.replace('On','') + ' OFF', 'info', 1200);
  });
  controls.forEach(([ctrlId, param, valId, fmt]) => {
    $(ctrlId).addEventListener('input', e => {
      engine.params[param] = +e.target.value;
      $(valId).textContent = fmt(+e.target.value);
    });
  });
};

// Reverb
$('reverbOn').addEventListener('change', e => { engine.params.reverbOn = e.target.checked; toast(e.target.checked?'Reverb ON':'Reverb OFF','info',1200); });
$('reverbSize').addEventListener('input', e => { engine.params.reverbSize = +e.target.value; $('reverbSizeVal').textContent = (+e.target.value).toFixed(1)+'s'; engine._impulseCache={}; });
$('reverbDecay').addEventListener('input', e => { engine.params.reverbDecay = +e.target.value; $('reverbDecayVal').textContent = (+e.target.value).toFixed(1); engine._impulseCache={}; });
$('reverbWet').addEventListener('input', e => { engine.params.reverbWet = +e.target.value/100; $('reverbWetVal').textContent = e.target.value+'%'; });
$('reverbPreDelay').addEventListener('input', e => { engine.params.reverbPreDelay = +e.target.value/1000; $('reverbPreDelayVal').textContent = e.target.value+'ms'; });

// Delay
$('delayOn').addEventListener('change', e => { engine.params.delayOn = e.target.checked; });
$('delayTime').addEventListener('input', e => { engine.params.delayTime = +e.target.value/1000; $('delayTimeVal').textContent = e.target.value+'ms'; });
$('delayFeedback').addEventListener('input', e => { engine.params.delayFeedback = +e.target.value/100; $('delayFeedbackVal').textContent = e.target.value+'%'; });
$('delayWet').addEventListener('input', e => { engine.params.delayWet = +e.target.value/100; $('delayWetVal').textContent = e.target.value+'%'; });
$('delaySpread').addEventListener('input', e => { engine.params.delaySpread = +e.target.value/100; $('delaySpreadVal').textContent = e.target.value+'%'; });

// Distortion
$('distOn').addEventListener('change', e => { engine.params.distOn = e.target.checked; });
$('distDrive').addEventListener('input', e => { engine.params.distDrive = +e.target.value; $('distDriveVal').textContent = e.target.value+'%'; });
$('distTone').addEventListener('input', e => { engine.params.distTone = +e.target.value; $('distToneVal').textContent = e.target.value+'Hz'; });
$('distWet').addEventListener('input', e => { engine.params.distWet = +e.target.value/100; $('distWetVal').textContent = e.target.value+'%'; });
$('distType').addEventListener('change', e => { engine.params.distType = e.target.value; });

// Chorus
$('chorusOn').addEventListener('change', e => { engine.params.chorusOn = e.target.checked; });
$('chorusRate').addEventListener('input', e => { engine.params.chorusRate = +e.target.value; $('chorusRateVal').textContent = (+e.target.value).toFixed(1)+'Hz'; });
$('chorusDepth').addEventListener('input', e => { engine.params.chorusDepth = +e.target.value/1000; $('chorusDepthVal').textContent = e.target.value+'ms'; });
$('chorusWet').addEventListener('input', e => { engine.params.chorusWet = +e.target.value/100; $('chorusWetVal').textContent = e.target.value+'%'; });
$('chorusMode').addEventListener('change', e => { engine.params.chorusMode = e.target.value; });

// ── Editor Controls ───────────────────────────────────────────────────
function updateSelectionUI() {
  const s = selStart, e2 = selEnd;
  if (s !== null && e2 !== null) {
    $('inPoint').value = fmt(s);
    $('outPoint').value = fmt(e2);
    $('selLength').textContent = fmt(e2 - s);
    $('selInfo').textContent = `Sel: ${fmt(s)} → ${fmt(e2)} (${fmt(e2-s)})`;
    if (loopMode) { engine.loopStart = s; engine.loopEnd = e2; }
  } else {
    $('inPoint').value = '00:00.000';
    $('outPoint').value = '00:00.000';
    $('selLength').textContent = '00:00.000';
    $('selInfo').textContent = 'No selection';
  }
}

// Fade controls
$('fadeInDur').addEventListener('input', e => { $('fadeInDurVal').textContent = (+e.target.value).toFixed(1)+'s'; });
$('fadeOutDur').addEventListener('input', e => { $('fadeOutDurVal').textContent = (+e.target.value).toFixed(1)+'s'; });

$('btnApplyFadeIn').addEventListener('click', async () => {
  if (!engine.workBuffer) return;
  const dur = +$('fadeInDur').value;
  if (dur <= 0) { toast('Set fade duration first', 'error'); return; }
  await engine.applyFade(true, false, dur, 0, $('fadeInCurve').value, 'linear');
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast(`Fade In ${dur}s applied`, 'success');
});

$('btnApplyFadeOut').addEventListener('click', async () => {
  if (!engine.workBuffer) return;
  const dur = +$('fadeOutDur').value;
  if (dur <= 0) { toast('Set fade duration first', 'error'); return; }
  await engine.applyFade(false, true, 0, dur, 'linear', $('fadeOutCurve').value);
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast(`Fade Out ${dur}s applied`, 'success');
});

// Trim
$('btnTrimToSel').addEventListener('click', async () => {
  if (!engine.workBuffer) return;
  if (selStart === null || selEnd === null || Math.abs(selEnd - selStart) < 0.01) {
    toast('Make a selection first', 'error'); return;
  }
  const s = Math.min(selStart, selEnd), e = Math.max(selStart, selEnd);
  await engine.trimToSelection(s, e);
  selStart = 0; selEnd = engine.workBuffer.duration;
  waveform.loadBuffer(engine.workBuffer);
  $('timeTotal').textContent = fmt(engine.workBuffer.duration);
  updateSelectionUI();
  toast(`Trimmed: ${fmt(e-s)} kept`, 'success');
});

$('btnDeleteSel').addEventListener('click', async () => {
  if (!engine.workBuffer || selStart === null) { toast('Make a selection first', 'error'); return; }
  const s = Math.min(selStart, selEnd), e = Math.max(selStart, selEnd);
  await engine.deleteSelection(s, e);
  selStart = null; selEnd = null;
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  waveform.clearSelection();
  $('timeTotal').textContent = fmt(engine.workBuffer.duration);
  updateSelectionUI();
  toast('Selection deleted', 'success');
});

// ── Clipboard: Copy / Cut / Paste ─────────────────────────────────────
function updateClipboardUI() {
  const clip = engine.clipboardBuffer;
  const btn = $('btnPasteSel');
  const info = $('clipboardInfo');
  if (clip) {
    btn.disabled = false;
    info.textContent = `📋 ${fmt(clip.duration)} · ${clip.numberOfChannels}ch`;
    info.classList.add('has-data');
  } else {
    btn.disabled = true;
    info.textContent = 'Clipboard empty';
    info.classList.remove('has-data');
  }
}

$('btnCopySel').addEventListener('click', () => {
  if (!engine.workBuffer || selStart === null || selEnd === null) {
    toast('Make a selection first', 'error'); return;
  }
  const s = Math.min(selStart, selEnd), e = Math.max(selStart, selEnd);
  if (e - s < 0.001) { toast('Selection too short', 'error'); return; }
  engine.copySelection(s, e);
  updateClipboardUI();
  toast(`Copied ${fmt(e - s)} to clipboard`, 'success');
});

$('btnCutSel').addEventListener('click', async () => {
  if (!engine.workBuffer || selStart === null || selEnd === null) {
    toast('Make a selection first', 'error'); return;
  }
  const s = Math.min(selStart, selEnd), e = Math.max(selStart, selEnd);
  if (e - s < 0.001) { toast('Selection too short', 'error'); return; }
  await engine.cutSelection(s, e);
  selStart = null; selEnd = null;
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  waveform.clearSelection();
  $('timeTotal').textContent = fmt(engine.workBuffer.duration);
  updateSelectionUI();
  updateClipboardUI();
  toast(`Cut ${fmt(engine.clipboardBuffer.duration)} to clipboard`, 'success');
});

$('btnPasteSel').addEventListener('click', async () => {
  if (!engine.workBuffer || !engine.clipboardBuffer) {
    toast('Nothing in clipboard', 'error'); return;
  }
  const insertAt = engine.pauseOffset || 0;
  await engine.pasteAtTime(insertAt);
  waveform.loadBuffer(engine.workBuffer);
  $('timeTotal').textContent = fmt(engine.workBuffer.duration);
  updateUndoRedoButtons();
  // Select the pasted region so user can see/hear it
  selStart = insertAt;
  selEnd = insertAt + engine.clipboardBuffer.duration;
  waveform.setSelection(selStart, selEnd);
  updateSelectionUI();
  toast(`Pasted at ${fmt(insertAt)}`, 'success');
});

$('btnSelAll').addEventListener('click', () => {
  if (!engine.workBuffer) return;
  selStart = 0; selEnd = engine.workBuffer.duration;
  waveform.selectAll();
  updateSelectionUI();
});

$('btnSelClear').addEventListener('click', () => {
  selStart = null; selEnd = null;
  waveform.clearSelection();
  updateSelectionUI();
});

$('btnCropLeft').addEventListener('click', async () => {
  if (!engine.workBuffer || selStart === null) return;
  await engine.trimToSelection(selStart, engine.workBuffer.duration);
  selEnd = engine.workBuffer.duration; selStart = 0;
  waveform.loadBuffer(engine.workBuffer);
  $('timeTotal').textContent = fmt(engine.workBuffer.duration);
  updateUndoRedoButtons();
  updateSelectionUI();
  toast('Cropped left', 'success');
});

$('btnCropRight').addEventListener('click', async () => {
  if (!engine.workBuffer || selEnd === null) return;
  await engine.trimToSelection(0, selEnd);
  selStart = null; selEnd = null;
  waveform.loadBuffer(engine.workBuffer);
  $('timeTotal').textContent = fmt(engine.workBuffer.duration);
  updateUndoRedoButtons();
  updateSelectionUI();
  toast('Cropped right', 'success');
});

// Transform
$('playbackRate').addEventListener('input', e => {
  engine.params.playbackRate = +e.target.value/100;
  $('playbackRateVal').textContent = e.target.value+'%';
  if(engine.source) engine.source.playbackRate.value = engine.params.playbackRate;
});

$('pitchShift').addEventListener('input', e => {
  const s = +e.target.value;
  engine.params.pitchShift = s;
  $('pitchShiftVal').textContent = (s > 0 ? '+' : '') + s + ' st';
  // Pitch shift via playbackRate approximation
  const rate = Math.pow(2, s / 12);
  engine.params.playbackRate = rate;
  $('playbackRate').value = Math.round(rate * 100);
  $('playbackRateVal').textContent = Math.round(rate * 100) + '%';
  if(engine.source) engine.source.playbackRate.value = rate;
});

$('btnReverse').addEventListener('click', async () => {
  if(!engine.workBuffer) return;
  await engine.reverse(selStart, selEnd);
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('Reversed', 'success');
});

$('btnNormalizeSel').addEventListener('click', async () => {
  if(!engine.workBuffer) return;
  await engine.normalize(selStart, selEnd, -0.1);
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('Normalized', 'success');
});

$('btnDCOffset').addEventListener('click', async () => {
  if(!engine.workBuffer) return;
  await engine.removeDC();
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('DC Offset removed', 'success');
});

$('btnSilence').addEventListener('click', async () => {
  if(!engine.workBuffer || selStart === null) { toast('Make a selection first', 'error'); return; }
  const buf = engine.workBuffer;
  await engine._pushUndo();
  const sr = buf.sampleRate;
  const nb = engine._cloneBuffer(buf);
  const s = Math.floor(selStart*sr), e = Math.ceil(selEnd*sr);
  for(let c=0;c<nb.numberOfChannels;c++) nb.getChannelData(c).fill(0,s,e);
  engine.workBuffer = nb;
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('Silence inserted', 'success');
});

$('btnUndo').addEventListener('click', async () => {
  if(!engine.canUndo()) { toast('Nothing to undo', 'error'); return; }
  await engine.undo();
  waveform.loadBuffer(engine.workBuffer);
  $('timeTotal').textContent = fmt(engine.workBuffer.duration);
  updateUndoRedoButtons();
  toast('Undo', 'info', 1200);
});

$('btnRedo').addEventListener('click', async () => {
  if(!engine.canRedo()) { toast('Nothing to redo', 'error'); return; }
  await engine.redo();
  waveform.loadBuffer(engine.workBuffer);
  $('timeTotal').textContent = fmt(engine.workBuffer.duration);
  updateUndoRedoButtons();
  toast('Redo', 'info', 1200);
});

// ── Tools ─────────────────────────────────────────────────────────────
$('vocalRemoval').addEventListener('change', e => {
  if(e.target.checked) $('vocalIsolate').checked = false;
  engine.params.vocalRemoval = e.target.checked;
  engine.params.vocalIsolate = false;
  toast(e.target.checked ? '🎤 Vocal Removal ON' : 'Vocal Removal OFF', 'info', 1500);
  if(engine.state==='playing') { engine.pause(); setTimeout(()=>{ engine.play(); $('btnPlay').textContent='⏸'; }, 100); }
});
$('vocalIsolate').addEventListener('change', e => {
  if(e.target.checked) $('vocalRemoval').checked = false;
  engine.params.vocalIsolate = e.target.checked;
  engine.params.vocalRemoval = false;
  toast(e.target.checked ? '🎤 Vocal Isolation ON' : 'Vocal Isolation OFF', 'info', 1500);
  if(engine.state==='playing') { engine.pause(); setTimeout(()=>{ engine.play(); $('btnPlay').textContent='⏸'; }, 100); }
});
$('vocalWidth').addEventListener('input', e => { engine.params.vocalWidth = +e.target.value/100; $('vocalWidthVal').textContent = e.target.value+'%'; });

$('btnBakeVocal').addEventListener('click', async () => {
  if(!engine.origBuffer) return;
  const mode = engine.params.vocalRemoval ? 'remove' : engine.params.vocalIsolate ? 'isolate' : null;
  if (!mode) { toast('Enable vocal removal or isolation first', 'error'); return; }
  await engine._pushUndo();
  engine.workBuffer = engine.computeVocalBuffer(mode);
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('Baked to buffer!', 'success');
});

// Bass enhancement
$('bassEnhOn').addEventListener('change', e => { engine.params.bassEnhOn = e.target.checked; toast(e.target.checked?'Bass Enhancement ON':'Bass Enhancement OFF','info',1200); });
$('bassSubBoost').addEventListener('input', e => { engine.params.bassSubBoost = +e.target.value; $('bassSubBoostVal').textContent = '+'+e.target.value+'dB'; });
$('bassPunch').addEventListener('input', e => { engine.params.bassPunch = +e.target.value; $('bassPunchVal').textContent = '+'+e.target.value+'dB'; });
$('bassWarmth').addEventListener('input', e => { engine.params.bassWarmth = +e.target.value; $('bassWarmthVal').textContent = '+'+e.target.value+'dB'; });
$('bassTighten').addEventListener('input', e => { engine.params.bassTighten = +e.target.value; $('bassTightenVal').textContent = '-'+e.target.value+'dB'; });

// Stereo tools
$('stereoW').addEventListener('input', e => { engine.params.stereoWidth = +e.target.value/100; $('stereoWVal').textContent = e.target.value+'%'; });
$('panControl').addEventListener('input', e => {
  const v = +e.target.value;
  engine.params.pan = v / 100;
  $('panControlVal').textContent = v === 0 ? 'C' : v > 0 ? 'R'+v : 'L'+Math.abs(v);
  if(engine.nodes.panner) engine.nodes.panner.pan.value = v/100;
});
$('btnMonoToStereo').addEventListener('click', async () => {
  if(!engine.workBuffer || engine.workBuffer.numberOfChannels >= 2) return;
  await engine._pushUndo();
  const b = engine.workBuffer;
  const nb = engine.getCtx().createBuffer(2, b.length, b.sampleRate);
  nb.getChannelData(0).set(b.getChannelData(0));
  nb.getChannelData(1).set(b.getChannelData(0));
  engine.workBuffer = nb;
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('Mono → Stereo', 'success');
});
$('btnStereoToMono').addEventListener('click', async () => {
  if(!engine.workBuffer) return;
  await engine.stereoToMono();
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('Stereo → Mono', 'success');
});
$('btnSwapLR').addEventListener('click', async () => {
  if(!engine.workBuffer) return;
  await engine.swapLR();
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('L/R Swapped', 'success');
});
$('btnInvertPhase').addEventListener('click', async () => {
  if(!engine.workBuffer) return;
  await engine.invertPhase();
  waveform.loadBuffer(engine.workBuffer);
  updateUndoRedoButtons();
  toast('Phase Inverted', 'success');
});

// ── Visualizer mode ───────────────────────────────────────────────────
$('specMode').addEventListener('change', e => { if(spectrum) spectrum.mode = e.target.value; });

// ── Export Format Toggle ──────────────────────────────────────────────
$('exportFormat').addEventListener('change', e => {
  $('mp3BitrateWrap').style.display = e.target.value === 'mp3' ? '' : 'none';
});

// ── MP3 Encoder (lamejs) ──────────────────────────────────────────────
function encodeMp3(audioBuffer, bitrate) {
  return new Promise((resolve, reject) => {
    try {
      const numCh = audioBuffer.numberOfChannels;
      const sr = audioBuffer.sampleRate;
      const mp3enc = new lamejs.Mp3Encoder(numCh, sr, bitrate);
      const blockSize = 1152;
      const mp3Data = [];
      const L = audioBuffer.getChannelData(0);
      const R = numCh > 1 ? audioBuffer.getChannelData(1) : L;

      // Convert Float32 (-1..1) to Int16 (-32768..32767)
      const toInt16 = (f32) => {
        const int16 = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
        }
        return int16;
      };
      const lInt = toInt16(L);
      const rInt = numCh > 1 ? toInt16(R) : lInt;

      const total = lInt.length;
      for (let i = 0; i < total; i += blockSize) {
        const lChunk = lInt.subarray(i, i + blockSize);
        const rChunk = rInt.subarray(i, i + blockSize);
        const encoded = numCh > 1
          ? mp3enc.encodeBuffer(lChunk, rChunk)
          : mp3enc.encodeBuffer(lChunk);
        if (encoded.length > 0) mp3Data.push(encoded);
        // Yield control periodically
        if (i % (blockSize * 100) === 0) updateModal(
          80 + Math.round((i / total) * 18),
          'Encoding MP3...'
        );
      }
      const flushed = mp3enc.flush();
      if (flushed.length > 0) mp3Data.push(flushed);

      // Merge all chunks
      const totalLen = mp3Data.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of mp3Data) { out.set(chunk, offset); offset += chunk.length; }
      resolve(out.buffer);
    } catch(e) { reject(e); }
  });
}

// ── Export ────────────────────────────────────────────────────────────
async function doExport() {
  if(!engine.workBuffer) { toast('Load a file first', 'error'); return; }
  const format = $('exportFormat').value;
  const isMp3 = format === 'mp3';
  showModal(isMp3 ? 'Exporting MP3...' : 'Exporting WAV...');
  try {
    const region = $('exportRegion').value;
    const opts = {
      startTime: region === 'selection' && selStart !== null ? selStart : null,
      endTime: region === 'selection' && selEnd !== null ? selEnd : null,
      sampleRate: $('exportSR').value === 'original' ? null : +$('exportSR').value,
      channels: $('exportCh').value,
      bit32: format === 'wav32',
    };
    updateModal(5, 'Building processing chain...');
    const wav = await engine.export(opts, pct => updateModal(
      isMp3 ? Math.round(pct * 0.75) : pct,
      pct < 80 ? 'Rendering...' : (isMp3 ? 'Preparing MP3 encoder...' : 'Encoding WAV...')
    ));

    let blob, filename;
    if (isMp3) {
      if (typeof lamejs === 'undefined') {
        throw new Error('MP3 encoder (lame.js) failed to load. Try refreshing the app.');
      }
      updateModal(76, 'Starting MP3 encode...');
      // Decode WAV back to AudioBuffer for lame encoding
      const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
      const renderedBuf = await tmpCtx.decodeAudioData(wav.slice(0));
      await tmpCtx.close();
      const bitrate = parseInt($('mp3Bitrate').value);
      const mp3 = await encodeMp3(renderedBuf, bitrate);
      updateModal(100, 'Download starting...');
      blob = new Blob([mp3], { type: 'audio/mp3' });
      filename = `audioforge_export_${bitrate}k.mp3`;
    } else {
      updateModal(100, 'Download starting...');
      blob = new Blob([wav], { type: 'audio/wav' });
      filename = 'audioforge_export.wav';
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setTimeout(hideModal, 800);
    const sizeMb = (blob.size / 1024 / 1024).toFixed(1);
    toast(`Export complete! (${sizeMb} MB)`, 'success');
  } catch(e) {
    hideModal();
    toast('Export failed: ' + e.message, 'error', 5000);
    console.error(e);
  }
}
$('btnExport').addEventListener('click', doExport);
$('btnExportFull').addEventListener('click', doExport);

// ── Mic Recording ──────────────────────────────────────────────────────
let recMediaStream = null;
let recMediaRecorder = null;
let recChunks = [];
let recStartTime = null;
let recTimerInterval = null;
let recAnalyserNode = null;
let recAudioCtx = null;
let recAnimFrame = null;

// ── Metronome ──────────────────────────────────────────────────────────
const metronome = (() => {
  let _ctx = null;
  let _running = false;
  let _bpm = 120;
  let _nextBeatTime = 0;
  let _scheduleAhead = 0.1;   // seconds to schedule ahead
  let _lookAhead = 25;        // ms interval for scheduler
  let _timerId = null;
  let _beatCount = 0;

  function _getCtx() {
    if (!_ctx || _ctx.state === 'closed') {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  function _scheduleClick(time, isDownbeat) {
    const ctx = _getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = isDownbeat ? 1000 : 660;
    gain.gain.setValueAtTime(isDownbeat ? 0.6 : 0.35, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.start(time);
    osc.stop(time + 0.05);
    // Visual flash
    const flashDelay = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      const light = document.getElementById('metroBeatLight');
      if (light) {
        light.classList.add('flash');
        setTimeout(() => light.classList.remove('flash'), 80);
      }
    }, flashDelay);
  }

  function _scheduler() {
    const ctx = _getCtx();
    while (_nextBeatTime < ctx.currentTime + _scheduleAhead) {
      _scheduleClick(_nextBeatTime, _beatCount % 4 === 0);
      _beatCount++;
      _nextBeatTime += 60 / _bpm;
    }
  }

  return {
    start(bpm) {
      if (_running) return;
      _bpm = bpm || _bpm;
      _running = true;
      _beatCount = 0;
      _nextBeatTime = _getCtx().currentTime + 0.05;
      _timerId = setInterval(_scheduler, _lookAhead);
    },
    stop() {
      if (!_running) return;
      _running = false;
      clearInterval(_timerId);
      _timerId = null;
      if (_ctx) { _ctx.close().catch(()=>{}); _ctx = null; }
      const light = document.getElementById('metroBeatLight');
      if (light) light.classList.remove('flash');
    },
    setBpm(bpm) { _bpm = Math.max(40, Math.min(240, bpm)); },
    get running() { return _running; },
  };
})();

function openRecordModal() {
  $('recordModal').classList.remove('hidden');
  $('recTime').textContent = '00:00.000';
  $('recStatus').textContent = 'Ready to record';
  $('recStatus').classList.remove('active');
  $('btnRecStart').disabled = false;
  $('btnRecStop').disabled = true;
  drawRecIdle();
}
function closeRecordModal() {
  stopRecording(false);
  metronome.stop();
  $('btnMetronome').textContent = '🎵 OFF';
  $('btnMetronome').classList.remove('active');
  $('recordModal').classList.add('hidden');
  if (recAnimFrame) { cancelAnimationFrame(recAnimFrame); recAnimFrame = null; }
}

function drawRecIdle() {
  const canvas = $('recCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth || 400;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#0e1f3a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();
}

function drawRecWaveform() {
  const canvas = $('recCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth || 400;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (recAnalyserNode) {
    const bufLen = recAnalyserNode.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    recAnalyserNode.getByteTimeDomainData(data);
    ctx.strokeStyle = '#ff3344';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255,40,60,0.5)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    const sliceW = w / bufLen;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const v = data[i] / 128.0;
      const y = v * h / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceW;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  recAnimFrame = requestAnimationFrame(drawRecWaveform);
}

async function startRecording() {
  try {
    recMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch(e) {
    toast('Microphone access denied or unavailable.', 'error', 4000);
    return;
  }

  // Setup analyser for live waveform
  recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = recAudioCtx.createMediaStreamSource(recMediaStream);
  recAnalyserNode = recAudioCtx.createAnalyser();
  recAnalyserNode.fftSize = 2048;
  src.connect(recAnalyserNode);

  recChunks = [];
  recMediaRecorder = new MediaRecorder(recMediaStream);
  recMediaRecorder.ondataavailable = e => { if(e.data.size > 0) recChunks.push(e.data); };
  recMediaRecorder.onstop = () => finalizeRecording();
  recMediaRecorder.start(100);

  recStartTime = Date.now();
  recTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - recStartTime) / 1000;
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    $('recTime').textContent = `${String(m).padStart(2,'0')}:${s.toFixed(3).padStart(6,'0')}`;
  }, 50);

  $('recStatus').textContent = '● RECORDING...';
  $('recStatus').classList.add('active');
  $('btnRecStart').disabled = true;
  $('btnRecStop').disabled = false;
  $('btnRecord').classList.add('recording');
  drawRecWaveform();
}

function stopRecording(save = true) {
  clearInterval(recTimerInterval);
  if (recAnimFrame) { cancelAnimationFrame(recAnimFrame); recAnimFrame = null; }
  if (recMediaRecorder && recMediaRecorder.state !== 'inactive') {
    recMediaRecorder._save = save;
    recMediaRecorder.stop();
  }
  if (recMediaStream) {
    recMediaStream.getTracks().forEach(t => t.stop());
    recMediaStream = null;
  }
  if (recAudioCtx) {
    recAudioCtx.close().catch(()=>{});
    recAudioCtx = null;
  }
  recAnalyserNode = null;
  $('btnRecord').classList.remove('recording');
}

async function finalizeRecording() {
  const save = recMediaRecorder._save !== false;
  if (!save || recChunks.length === 0) {
    drawRecIdle();
    return;
  }
  $('recStatus').textContent = 'Processing...';
  $('btnRecStop').disabled = true;

  try {
    const blob = new Blob(recChunks, { type: recChunks[0].type || 'audio/webm' });
    const ab = await blob.arrayBuffer();
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await tmpCtx.decodeAudioData(ab);
    await tmpCtx.close();

    engine.origBuffer = decoded;
    engine.workBuffer = decoded;
    await engine._undoMgr.clear();

    waveform.loadBuffer(decoded);
    const duration = decoded.duration;
    const m = Math.floor(duration / 60);
    const s = duration % 60;
    const durStr = `${String(m).padStart(2,'0')}:${s.toFixed(3).padStart(6,'0')}`;

    $('fileName').textContent = `Recording_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}`;
    $('fileMeta').textContent = `${decoded.numberOfChannels}ch · ${(decoded.sampleRate/1000).toFixed(1)}kHz · ${durStr}`;
    $('timeTotal').textContent = durStr;
    $('timeCurrent').textContent = '00:00.000';
    $('btnExport').disabled = false;
    $('dropZone').style.display = 'none';
    selStart = null; selEnd = null;
    updateSelectionUI();

    closeRecordModal();
    toast(`🎙 Recording loaded! (${durStr})`, 'success', 3500);
  } catch(e) {
    $('recStatus').textContent = 'Error processing recording';
    toast('Failed to process recording: ' + e.message, 'error', 5000);
    console.error(e);
  }
}

$('btnRecord').addEventListener('click', openRecordModal);
$('btnRecStart').addEventListener('click', startRecording);
$('btnRecStop').addEventListener('click', () => stopRecording(true));
$('btnRecCancel').addEventListener('click', () => closeRecordModal());

// Metronome toggle
$('btnMetronome').addEventListener('click', () => {
  if (metronome.running) {
    metronome.stop();
    $('btnMetronome').textContent = '🎵 OFF';
    $('btnMetronome').classList.remove('active');
  } else {
    const bpm = parseInt($('metroBpm').value) || 120;
    metronome.start(bpm);
    $('btnMetronome').textContent = '🎵 ON';
    $('btnMetronome').classList.add('active');
  }
});
$('metroBpm').addEventListener('input', () => {
  const bpm = parseInt($('metroBpm').value) || 120;
  metronome.setBpm(bpm);
});
// Close on backdrop click
$('recordModal').addEventListener('click', e => {
  if(e.target === $('recordModal')) closeRecordModal();
});

// ── VU Meter ─────────────────────────────────────────────────────────
function updateVU() {
  if (!engine.nodes.analyser) {
    $('grFill').style.width = '0%';
    return;
  }
  const buf = new Float32Array(engine.nodes.analyser.fftSize);
  engine.nodes.analyser.getFloatTimeDomainData(buf);
  let rms = 0;
  for(let i=0;i<buf.length;i++) rms += buf[i]*buf[i];
  rms = Math.sqrt(rms/buf.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-9));
  const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
  $('vuFillL').style.height = pct + '%';
  $('vuFillR').style.height = pct + '%';
  // Compressor GR
  if(engine.nodes.comp) {
    const gr = engine.nodes.comp.reduction;
    const grPct = Math.min(100, Math.abs(gr) / 30 * 100);
    $('grFill').style.width = grPct + '%';
    $('grVal').textContent = gr.toFixed(1) + 'dB';
  }
  requestAnimationFrame(updateVU);
}
requestAnimationFrame(updateVU);

// ── Waveform tools ────────────────────────────────────────────────────
$('toolZoomIn').addEventListener('click', () => waveform && waveform.zoomIn());
$('toolZoomOut').addEventListener('click', () => waveform && waveform.zoomOut());
$('toolFit').addEventListener('click', () => waveform && waveform.fitView());

// ── Keyboard Shortcuts ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  switch(e.code) {
    case 'Space': e.preventDefault(); $('btnPlay').click(); break;
    case 'KeyS': if(e.ctrlKey||e.metaKey) { e.preventDefault(); doExport(); } break;
    case 'KeyZ': if(e.ctrlKey||e.metaKey) { e.preventDefault(); $('btnUndo').click(); } break;
    case 'KeyY': if(e.ctrlKey||e.metaKey) { e.preventDefault(); $('btnRedo').click(); } break;
    case 'KeyC': if(e.ctrlKey||e.metaKey) { e.preventDefault(); $('btnCopySel').click(); } break;
    case 'KeyX': if(e.ctrlKey||e.metaKey) { e.preventDefault(); $('btnCutSel').click(); } break;
    case 'KeyV': if(e.ctrlKey||e.metaKey) { e.preventDefault(); $('btnPasteSel').click(); } break;
    case 'Delete':
    case 'Backspace': {
      if (e.code === 'Backspace' && e.target.tagName === 'INPUT') return;
      e.preventDefault();
      $('btnDeleteSel').click();
      break;
    }
    case 'End': $('btnSkipEnd').click(); break;
    case 'KeyL': $('btnLoop').click(); break;
  }
});

// ── PWA Install ───────────────────────────────────────────────────────
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  // Show install notification
  setTimeout(() => toast('📱 Install AudioForge as app! (tap ⬇ to install)', 'info', 6000), 3000);
});

// ── Custom Presets ────────────────────────────────────────────────────
const PRESETS_KEY = 'audioforge_custom_presets';

function presetsLoad() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); }
  catch { return {}; }
}

function presetsSave(presets) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

function presetsGetCurrentSettings() {
  return {
    // Reverb
    reverbOn:       $('reverbOn').checked,
    reverbSize:     +$('reverbSize').value,
    reverbDecay:    +$('reverbDecay').value,
    reverbWet:      +$('reverbWet').value,
    reverbPreDelay: +$('reverbPreDelay').value,
    // Delay
    delayOn:        $('delayOn').checked,
    delayTime:      +$('delayTime').value,
    delayFeedback:  +$('delayFeedback').value,
    delayWet:       +$('delayWet').value,
    delaySpread:    +$('delaySpread').value,
    // Compressor
    compThresh:     +$('compThresh').value,
    compRatio:      +$('compRatio').value,
    compAttack:     +$('compAttack').value,
    compRelease:    +$('compRelease').value,
    compKnee:       +$('compKnee').value,
    compGain:       +$('compGain').value,
    compBypass:     engine.params.compBypass,
  };
}

function presetsApply(s) {
  // Reverb
  $('reverbOn').checked = s.reverbOn;
  engine.params.reverbOn = s.reverbOn;
  setSlider('reverbSize',     s.reverbSize,     v => v.toFixed(1)+'s');
  setSlider('reverbDecay',    s.reverbDecay,    v => v.toFixed(1));
  setSlider('reverbWet',      s.reverbWet,      v => Math.round(v)+'%');
  setSlider('reverbPreDelay', s.reverbPreDelay, v => Math.round(v)+'ms');
  engine.params.reverbSize     = s.reverbSize;
  engine.params.reverbDecay    = s.reverbDecay;
  engine.params.reverbWet      = s.reverbWet / 100;
  engine.params.reverbPreDelay = s.reverbPreDelay / 1000;
  engine._impulseCache = {};

  // Delay
  $('delayOn').checked = s.delayOn;
  engine.params.delayOn = s.delayOn;
  setSlider('delayTime',      s.delayTime,     v => Math.round(v)+'ms');
  setSlider('delayFeedback',  s.delayFeedback, v => Math.round(v)+'%');
  setSlider('delayWet',       s.delayWet,      v => Math.round(v)+'%');
  setSlider('delaySpread',    s.delaySpread,   v => Math.round(v)+'%');
  engine.params.delayTime     = s.delayTime / 1000;
  engine.params.delayFeedback = s.delayFeedback / 100;
  engine.params.delayWet      = s.delayWet / 100;
  engine.params.delaySpread   = s.delaySpread / 100;

  // Compressor
  engine.params.compBypass = s.compBypass;
  $('compBypass').classList.toggle('active', s.compBypass);
  setSlider('compThresh',   s.compThresh,   v => Math.round(v)+'dB');
  setSlider('compRatio',    s.compRatio,    v => v+':1');
  setSlider('compAttack',   s.compAttack,   v => Math.round(v)+'ms');
  setSlider('compRelease',  s.compRelease,  v => Math.round(v)+'ms');
  setSlider('compKnee',     s.compKnee,     v => Math.round(v)+'dB');
  setSlider('compGain',     s.compGain,     v => '+'+v+'dB');
  engine.params.compThreshold = s.compThresh;
  engine.params.compRatio     = s.compRatio;
  engine.params.compAttack    = s.compAttack / 1000;
  engine.params.compRelease   = s.compRelease / 1000;
  engine.params.compKnee      = s.compKnee;
  engine.params.compGain      = s.compGain;
  if (engine.nodes.comp) {
    engine.nodes.comp.threshold.value = s.compThresh;
    engine.nodes.comp.ratio.value     = s.compRatio;
    engine.nodes.comp.attack.value    = s.compAttack / 1000;
    engine.nodes.comp.release.value   = s.compRelease / 1000;
    engine.nodes.comp.knee.value      = s.compKnee;
  }
}

function setSlider(id, value, fmtFn) {
  const el = $(id);
  if (!el) return;
  el.value = value;
  const valId = id + 'Val';
  const valEl = $(valId);
  if (valEl) valEl.textContent = fmtFn(value);
}

function presetsRenderList() {
  const presets = presetsLoad();
  const sel = $('presetSelect');
  const names = Object.keys(presets).sort();
  sel.innerHTML = '<option value="">— Select a preset —</option>';
  names.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  const hasPresets = names.length > 0;
  $('presetEmptyHint').classList.toggle('hidden', hasPresets);
  presetsUpdateButtons();
}

function presetsUpdateButtons() {
  const sel = $('presetSelect').value;
  $('btnLoadPreset').disabled   = !sel;
  $('btnDeletePreset').disabled = !sel;
}

// UI: open/close save modal
$('btnSavePreset').addEventListener('click', () => {
  $('presetNameInput').value = '';
  $('savePresetModal').classList.remove('hidden');
  setTimeout(() => $('presetNameInput').focus(), 80);
});

$('btnCancelPreset').addEventListener('click', () => {
  $('savePresetModal').classList.add('hidden');
});

$('savePresetModal').addEventListener('click', e => {
  if (e.target === $('savePresetModal')) $('savePresetModal').classList.add('hidden');
});

$('presetNameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btnConfirmSavePreset').click();
  if (e.key === 'Escape') $('savePresetModal').classList.add('hidden');
});

$('btnConfirmSavePreset').addEventListener('click', () => {
  const name = $('presetNameInput').value.trim();
  if (!name) { toast('Enter a preset name', 'error', 2000); return; }
  const presets = presetsLoad();
  const exists = !!presets[name];
  presets[name] = presetsGetCurrentSettings();
  presetsSave(presets);
  presetsRenderList();
  $('presetSelect').value = name;
  presetsUpdateButtons();
  $('savePresetModal').classList.add('hidden');
  toast(exists ? `✓ Updated: "${name}"` : `💾 Saved: "${name}"`, 'success');
});

$('btnLoadPreset').addEventListener('click', () => {
  const name = $('presetSelect').value;
  if (!name) return;
  const presets = presetsLoad();
  if (!presets[name]) { toast('Preset not found', 'error'); return; }
  presetsApply(presets[name]);
  toast(`⬇ Loaded: "${name}"`, 'success');
});

$('btnDeletePreset').addEventListener('click', () => {
  const name = $('presetSelect').value;
  if (!name) return;
  if (!confirm(`Delete preset "${name}"?`)) return;
  const presets = presetsLoad();
  delete presets[name];
  presetsSave(presets);
  presetsRenderList();
  toast(`Deleted: "${name}"`, 'info', 2000);
});

$('presetSelect').addEventListener('change', presetsUpdateButtons);

// ── INIT ──────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Init waveform renderer
  waveform = new WaveformRenderer($('waveformCanvas'), $('waveformContainer'));
  waveform.onSeek = (t) => {
    engine.seek(t);
    if(waveform) waveform.setPlayhead(t);
  };
  waveform.onSelect = (s, e) => {
    selStart = s; selEnd = e;
    updateSelectionUI();
  };

  // Init spectrum analyzer
  spectrum = new SpectrumAnalyzer($('spectrumCanvas'));
  scope = new Oscilloscope($('scopeCanvas'));

  // Connect visualizers when playing
  const origPlay = engine.play.bind(engine);
  engine.play = function(...args) {
    origPlay(...args);
    setTimeout(() => {
      if(engine.nodes.analyser) {
        spectrum.connect(engine.nodes.analyser);
        scope.connect(engine.nodes.scopeAnalyser || engine.nodes.analyser);
      }
    }, 100);
  };

  drawEQCurve();
  presetsRenderList();
  runLoadingScreen();

  // ── Offline / Online Status ─────────────────────────────────────────
  const badge     = $('offlineBadge');
  const dot       = $('offlineDot');
  const label     = $('offlineLabel');
  const strip     = $('offlineStrip');

  function setNetworkStatus(online) {
    if (online) {
      badge.className  = 'offline-badge online';
      label.textContent = 'ONLINE';
      strip.classList.remove('show');
    } else {
      badge.className  = 'offline-badge offline';
      label.textContent = 'OFFLINE';
      strip.classList.add('show');
      toast('✈ Offline mode — running from cache', 'info', 4000);
    }
  }

  setNetworkStatus(navigator.onLine);
  window.addEventListener('online',  () => {
    setNetworkStatus(true);
    toast('🌐 Back online!', 'info', 2500);
  });
  window.addEventListener('offline', () => {
    setNetworkStatus(false);
  });

  // ── PWA Install Prompt ─────────────────────────────────────────────
  let deferredInstallPrompt = null;
  const btnInstall = $('btnInstall');

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btnInstall.classList.remove('hidden');
  });

  btnInstall.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      toast('✅ AudioForge installed as app!', 'info', 3000);
      btnInstall.classList.add('hidden');
    }
    deferredInstallPrompt = null;
  });

  // Hide install button if already installed
  window.addEventListener('appinstalled', () => {
    btnInstall.classList.add('hidden');
    deferredInstallPrompt = null;
    toast('✅ AudioForge installed successfully!', 'info', 3000);
  });

  // ── Service Worker Registration + Update Detection ─────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(reg => {
        console.log('[App] Service worker registered:', reg.scope);

        // Check SW cache status
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'CACHE_STATUS' });
        }

        // Listen for messages from SW
        navigator.serviceWorker.addEventListener('message', e => {
          if (e.data && e.data.type === 'CACHE_REPORT') {
            console.log(`[App] Cache: ${e.data.count}/${e.data.total} assets`);
            if (e.data.ready) {
              label.textContent = navigator.onLine ? 'ONLINE' : 'OFFLINE';
            }
          }
        });

        // Detect new SW waiting (update available)
        const handleNewSW = (worker) => {
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed') {
              showUpdateBanner(worker);
            }
          });
          if (worker.state === 'installed') {
            showUpdateBanner(worker);
          }
        };

        if (reg.waiting) handleNewSW(reg.waiting);
        reg.addEventListener('updatefound', () => {
          handleNewSW(reg.installing);
        });

        // Periodic update check every 30 min
        setInterval(() => reg.update(), 30 * 60 * 1000);
      })
      .catch(e => console.warn('[App] SW registration failed:', e));
  }

  // ── Update Banner ──────────────────────────────────────────────────
  const updateBanner = $('updateBanner');
  const btnApplyUpdate  = $('btnApplyUpdate');
  const btnDismissUpdate = $('btnDismissUpdate');
  const btnUpdate = $('btnUpdate');
  let pendingWorker = null;

  function showUpdateBanner(worker) {
    pendingWorker = worker;
    updateBanner.classList.add('show');
    btnUpdate.classList.remove('hidden');
  }

  btnApplyUpdate.addEventListener('click', () => {
    if (pendingWorker) {
      pendingWorker.postMessage({ type: 'SKIP_WAITING' });
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });
  });

  btnUpdate.addEventListener('click', () => {
    updateBanner.classList.add('show');
  });

  btnDismissUpdate.addEventListener('click', () => {
    updateBanner.classList.remove('show');
  });

});
