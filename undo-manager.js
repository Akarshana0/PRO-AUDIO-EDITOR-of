// ── UndoRedoManager ───────────────────────────────────────────────────
// IndexedDB-backed undo/redo stack.
// AudioBuffer channel data is serialised to IDB instead of living in
// RAM, so even 10-minute files with 20 undo steps don't crash the tab.

const DB_NAME    = 'AudioForgeUndo';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const MAX_STEPS  = 20;

export class UndoRedoManager {
  constructor() {
    this._undoKeys = [];   // ordered oldest → newest
    this._redoKeys = [];
    this._db       = null;
    this._ready    = this._openDB();
  }

  // ── DB init ─────────────────────────────────────────────────────────
  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = e => {
        this._db = e.target.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _getDB() {
    await this._ready;
    return this._db;
  }

  // ── Low-level IDB helpers ────────────────────────────────────────────
  async _idbSet(key, value) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async _idbGet(key) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async _idbDelete(key) {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  // ── Serialise / deserialise AudioBuffer ──────────────────────────────
  async _saveBuffer(buffer) {
    const key = `snap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const channelData = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      // slice() creates a plain Float32Array copy (structured-cloneable)
      channelData.push(buffer.getChannelData(c).slice());
    }
    await this._idbSet(key, {
      channels:    buffer.numberOfChannels,
      length:      buffer.length,
      sampleRate:  buffer.sampleRate,
      channelData,
    });
    return key;
  }

  async _loadBuffer(key, ctx) {
    const snap = await this._idbGet(key);
    if (!snap) return null;
    const buf = ctx.createBuffer(snap.channels, snap.length, snap.sampleRate);
    for (let c = 0; c < snap.channels; c++) {
      buf.getChannelData(c).set(snap.channelData[c]);
    }
    return buf;
  }

  // ── Public API ───────────────────────────────────────────────────────

  /** Save current workBuffer as a new undo snapshot. */
  async push(buffer) {
    if (!buffer) return;
    const key = await this._saveBuffer(buffer);
    this._undoKeys.push(key);

    // Evict oldest step if over limit
    if (this._undoKeys.length > MAX_STEPS) {
      const old = this._undoKeys.shift();
      await this._idbDelete(old);
    }

    // Any new edit invalidates the redo branch
    for (const k of this._redoKeys) await this._idbDelete(k);
    this._redoKeys = [];
  }

  /** Undo: saves current state to redo stack, returns previous buffer. */
  async undo(currentBuffer, ctx) {
    if (!this._undoKeys.length) return null;

    // Push current state onto redo stack
    const redoKey = await this._saveBuffer(currentBuffer);
    this._redoKeys.push(redoKey);

    const undoKey = this._undoKeys.pop();
    const buf     = await this._loadBuffer(undoKey, ctx);
    await this._idbDelete(undoKey);
    return buf;
  }

  /** Redo: saves current state to undo stack, returns next buffer. */
  async redo(currentBuffer, ctx) {
    if (!this._redoKeys.length) return null;

    const undoKey = await this._saveBuffer(currentBuffer);
    this._undoKeys.push(undoKey);

    const redoKey = this._redoKeys.pop();
    const buf     = await this._loadBuffer(redoKey, ctx);
    await this._idbDelete(redoKey);
    return buf;
  }

  /** Wipe everything (called on new file load). */
  async clear() {
    const all = [...this._undoKeys, ...this._redoKeys];
    for (const k of all) {
      try { await this._idbDelete(k); } catch {}
    }
    this._undoKeys = [];
    this._redoKeys = [];
  }

  canUndo() { return this._undoKeys.length > 0; }
  canRedo() { return this._redoKeys.length > 0; }
  undoCount() { return this._undoKeys.length; }
  redoCount() { return this._redoKeys.length; }
}
