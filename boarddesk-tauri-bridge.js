/**
 * boarddesk-tauri-bridge.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Integriert das .board-Dateiformat (ZIP-Archiv) in BoardDesk.
 * Läuft sowohl im Tauri-Kontext (Desktop) als auch im Browser (Fallback).
 *
 * .board-Format (analog zu .docx):
 * ┌─ myboard.board (ZIP)
 * │   ├── boarddesk.json     Metadaten: Version, Erstelldatum, App-Version
 * │   ├── board.json         Boarddaten (items, layers, viewport)
 * │   │                      Bilder nur als Referenz: "media://a3f8c1.jpg"
 * │   └── media/
 * │       ├── a3f8c1.jpg     Bilddaten als echte Binärdateien
 * │       └── bg_9d2e.png
 * └─
 *
 * Verwendung (in index.html, nach JSZip laden):
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
 *   <script src="boarddesk-tauri-bridge.js"></script>
 *   Dann: BoardFile.save(captureBoard())  /  BoardFile.open() → restoreBoard(data)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BOARDDESK_VERSION = '1.0';

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Generiert einen kurzen Hash aus einem String (für Dateinamen). */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < Math.min(str.length, 2000); i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Extrahiert MIME-Typ und rohe Base64-Daten aus einer Data-URL. */
function parseDataURL(dataURL) {
  const m = dataURL.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

/** Gibt die passende Dateiendung für einen MIME-Typ zurück. */
function extForMime(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/png':  'png', 'image/webp': 'webp',
    'image/gif':  'gif', 'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
  };
  return map[mime] || 'bin';
}

/** Base64-String → Uint8Array (Browser-nativ, kein Node nötig). */
function b64ToUint8(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Uint8Array → Base64-String. */
function uint8ToB64(arr) {
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ── Erkennung: Tauri vs. Browser ─────────────────────────────────────────────

const IS_TAURI = typeof window.__TAURI__ !== 'undefined';

async function tauriInvoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

// ── queryLocalFonts-Polyfill für Tauri ───────────────────────────────────────
// Im Browser benötigt queryLocalFonts() eine explizite Nutzer-Erlaubnis (Permission-Dialog).
// In Tauri gibt es diese API gar nicht — die WebView blockiert sie stillschweigend.
// Lösung: window.queryLocalFonts wird durch einen Rust-Command ersetzt, der OS-Fonts
// direkt liest. Das bestehende HTML-Code ruft queryLocalFonts() unverändert auf —
// er bekommt einfach die bessere Implementierung geliefert.

if (IS_TAURI) {
  window.queryLocalFonts = async () => {
    try {
      const families = await tauriInvoke('list_system_fonts', {});
      // Rückgabe-Format muss der Local Font Access API entsprechen:
      // Array von Objekten mit mindestens {family: string}
      return families.map(family => ({ family, fullName: family, postscriptName: '', style: 'Regular' }));
    } catch (err) {
      console.warn('[BoardFile] Systemschriften konnten nicht geladen werden:', err);
      return [];
    }
  };
  console.log('[BoardFile] queryLocalFonts → Tauri-Rust-Polyfill aktiv');
}

// ── Pack: Board → ZIP-Bytes ──────────────────────────────────────────────────

/**
 * Serialisiert ein Board-Objekt (captureBoard()) als ZIP.
 * Alle Base64-Bilder werden extrahiert und als echte Dateien im media/-Ordner gespeichert.
 * Im board.json erscheinen sie als "media://HASH.EXT".
 *
 * @param {object} boardData  Rückgabe von captureBoard()
 * @param {string} boardName  Anzeigename des Boards
 * @returns {Promise<Uint8Array>}  ZIP als Bytes
 */
async function packBoard(boardData, boardName) {
  const zip = new JSZip();

  // Metadaten-Datei
  zip.file('boarddesk.json', JSON.stringify({
    version:    BOARDDESK_VERSION,
    app:        'BoardDesk',
    name:       boardName || 'Unbenanntes Board',
    created:    new Date().toISOString(),
    platform:   IS_TAURI ? 'tauri' : 'browser',
  }, null, 2));

  // board.json aufbauen — Bilder durch Referenzen ersetzen
  const media = {};       // hash → { mime, b64 }
  const mediaFolder = zip.folder('media');

  function extractMediaFromValue(value) {
    if (typeof value !== 'string') return value;
    if (!value.startsWith('data:')) return value;
    const parsed = parseDataURL(value);
    if (!parsed) return value;
    const hash = hashString(parsed.b64.slice(0, 500)) + '_' + parsed.b64.length;
    const ext  = extForMime(parsed.mime);
    const filename = `${hash}.${ext}`;
    if (!media[filename]) {
      media[filename] = parsed;
      mediaFolder.file(filename, b64ToUint8(parsed.b64));
    }
    return `media://${filename}`;
  }

  // Deep-traversal: ersetzt alle data:-URLs in items und bgImage
  function processItem(item) {
    const out = { ...item };
    if (out.src)      out.src      = extractMediaFromValue(out.src);
    if (out.fileData) out.fileData = extractMediaFromValue(out.fileData);
    if (out.children) {
      out.children = out.children.map(ch => {
        if (typeof ch === 'string') return ch;
        const c = { ...ch };
        if (c.fileData) c.fileData = extractMediaFromValue(c.fileData);
        return c;
      });
    }
    return out;
  }

  const boardJSON = {
    ...boardData,
    items:   (boardData.items || []).map(processItem),
    bgImage: boardData.bgImage ? extractMediaFromValue(boardData.bgImage) : null,
  };

  zip.file('board.json', JSON.stringify(boardJSON, null, 2));

  // ZIP komprimieren
  const bytes = await zip.generateAsync({
    type:               'uint8array',
    compression:        'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return bytes;
}

// ── Unpack: ZIP-Bytes → Board ────────────────────────────────────────────────

/**
 * Liest ein ZIP und stellt alle media://-Referenzen als data:-URLs wieder her.
 * @param {Uint8Array|ArrayBuffer} zipBytes
 * @returns {Promise<{ meta: object, board: object }>}
 */
async function unpackBoard(zipBytes) {
  const zip = await JSZip.loadAsync(zipBytes);

  // Metadaten
  const metaFile = zip.file('boarddesk.json');
  const meta = metaFile
    ? JSON.parse(await metaFile.async('string'))
    : { version: '?', name: 'Unbekannt' };

  // Mediendateien in ein Cache-Objekt laden
  const mediaCache = {};
  const mediaFiles = zip.folder('media')?.files || {};

  await Promise.all(
    Object.entries(zip.files)
      .filter(([path]) => path.startsWith('media/') && !path.endsWith('/'))
      .map(async ([path, file]) => {
        const filename = path.replace('media/', '');
        const ext = filename.split('.').pop().toLowerCase();
        const mimeMap = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
          pdf: 'application/pdf',
        };
        const mime = mimeMap[ext] || 'application/octet-stream';
        const b64  = uint8ToB64(await file.async('uint8array'));
        mediaCache[filename] = `data:${mime};base64,${b64}`;
      })
  );

  // board.json lesen und Referenzen auflösen
  const boardFile = zip.file('board.json');
  if (!boardFile) throw new Error('Ungültige .board-Datei: board.json fehlt');
  const boardJSON = JSON.parse(await boardFile.async('string'));

  function resolveRef(value) {
    if (typeof value !== 'string') return value;
    if (!value.startsWith('media://')) return value;
    const filename = value.replace('media://', '');
    return mediaCache[filename] || value;  // Fallback: Referenz behalten
  }

  function restoreItem(item) {
    const out = { ...item };
    if (out.src)      out.src      = resolveRef(out.src);
    if (out.fileData) out.fileData = resolveRef(out.fileData);
    if (out.children) {
      out.children = out.children.map(ch => {
        if (typeof ch === 'string') return ch;
        const c = { ...ch };
        if (c.fileData) c.fileData = resolveRef(c.fileData);
        return c;
      });
    }
    return out;
  }

  const board = {
    ...boardJSON,
    items:   (boardJSON.items || []).map(restoreItem),
    bgImage: boardJSON.bgImage ? resolveRef(boardJSON.bgImage) : null,
  };

  return { meta, board };
}

// ── Öffentliche API ──────────────────────────────────────────────────────────

window.BoardFile = {

  /** Aktuell geöffneter Dateipfad (Tauri) oder null (Browser). */
  currentPath: null,

  /**
   * Speichert das Board als .board-Datei.
   * Im Tauri-Kontext: nativer Speichern-Dialog (oder Überschreiben).
   * Im Browser: Download.
   *
   * @param {object} boardData   Rückgabe von captureBoard()
   * @param {string} boardName   Anzeigename
   * @param {boolean} saveAs     true → immer Dialog zeigen
   */
  async save(boardData, boardName, saveAs = false) {
    try {
      const bytes = await packBoard(boardData, boardName);

      if (IS_TAURI) {
        const path = (!saveAs && this.currentPath) ? this.currentPath : null;
        const savedPath = await tauriInvoke('save_board', {
          path,
          data: Array.from(bytes),   // Vec<u8> erwartet Array
        });
        this.currentPath = savedPath;
        console.log('[BoardFile] Gespeichert:', savedPath);
        return savedPath;

      } else {
        // Browser-Fallback: Datei-Download
        const blob = new Blob([bytes], { type: 'application/zip' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        const filename = (boardName || 'board')
          .replace(/[<>:"/\\|?*]/g, '_') + '.board';
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
        return filename;
      }
    } catch (err) {
      console.error('[BoardFile] Speichern fehlgeschlagen:', err);
      throw err;
    }
  },

  /**
   * Öffnet eine .board-Datei.
   * Im Tauri-Kontext: nativer Öffnen-Dialog.
   * Im Browser: <input type="file"> Fallback.
   *
   * @returns {Promise<{ meta, board }>} oder null (abgebrochen)
   */
  async open() {
    try {
      let zipBytes;

      if (IS_TAURI) {
        const [path, data] = await tauriInvoke('open_board', {});
        zipBytes = new Uint8Array(data);
        this.currentPath = path;

      } else {
        // Browser-Fallback
        zipBytes = await new Promise((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.board,application/zip';
          input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) { resolve(null); return; }
            const buf = await file.arrayBuffer();
            resolve(new Uint8Array(buf));
          };
          input.oncancel = () => resolve(null);
          input.click();
        });
        if (!zipBytes) return null;
      }

      return await unpackBoard(zipBytes);

    } catch (err) {
      console.error('[BoardFile] Öffnen fehlgeschlagen:', err);
      throw err;
    }
  },

  /**
   * Autosave — nur im Tauri-Kontext sinnvoll (kein Dialog).
   * @param {object} boardData
   * @param {string} boardName
   */
  async autosave(boardData, boardName) {
    if (!IS_TAURI || !this.currentPath) return;  // Browser oder kein Pfad → skip
    try {
      const bytes = await packBoard(boardData, boardName);
      await tauriInvoke('autosave_board', {
        path: this.currentPath,
        data: Array.from(bytes),
      });
    } catch (err) {
      console.warn('[BoardFile] Autosave fehlgeschlagen:', err);
      // Stumm fehlschlagen — nicht den User unterbrechen
    }
  },

  /** Gibt zurück ob die App im Tauri-Kontext läuft. */
  get isTauri() { return IS_TAURI; },
};

// ── Integration in bestehende BoardDesk-Funktionen ──────────────────────────
// Diese Übersteuerungen greifen in die vorhandene save/load-Logik ein.
// In index.html NACH den bestehenden Skripts einbinden.

(function patchBoardDesk() {
  // Warte bis BoardDesk vollständig initialisiert ist
  window.addEventListener('load', () => {

    // ── Speichern-Button (Toolbar) ────────────────────────
    // Fügt einen ".board speichern"-Button zur Toolbar hinzu
    const header = document.getElementById('header');
    if (header) {
      const btn = document.createElement('button');
      btn.className = 'hdr-btn';
      btn.title = IS_TAURI ? 'Als .board-Datei speichern (Strg+S)' : '.board herunterladen';
      btn.textContent = IS_TAURI ? '💾 Speichern' : '⬇ .board';
      btn.onclick = async () => {
        const name = document.getElementById('board-name-display')?.textContent || 'Board';
        // captureBoard() ist global in BoardDesk definiert
        if (typeof captureBoard !== 'function') {
          alert('captureBoard() nicht gefunden — Integration prüfen');
          return;
        }
        try {
          btn.disabled = true;
          btn.textContent = '…';
          await window.BoardFile.save(captureBoard(), name);
          btn.textContent = IS_TAURI ? '💾 Gespeichert ✓' : '⬇ .board';
          setTimeout(() => {
            btn.textContent = IS_TAURI ? '💾 Speichern' : '⬇ .board';
            btn.disabled = false;
          }, 1500);
        } catch (e) {
          btn.textContent = '⚠ Fehler';
          btn.disabled = false;
          console.error(e);
        }
      };
      // Vor dem ersten hdr-btn einfügen
      const firstBtn = header.querySelector('.hdr-btn');
      header.insertBefore(btn, firstBtn || null);

      // ── Öffnen-Button ─────────────────────────────────
      const openBtn = document.createElement('button');
      openBtn.className = 'hdr-btn';
      openBtn.title = IS_TAURI ? '.board-Datei öffnen (Strg+O)' : '.board-Datei laden';
      openBtn.textContent = '📂 Öffnen';
      openBtn.onclick = async () => {
        try {
          openBtn.disabled = true;
          openBtn.textContent = '…';
          const result = await window.BoardFile.open();
          if (!result) { openBtn.disabled = false; openBtn.textContent = '📂 Öffnen'; return; }
          const { meta, board } = result;
          // restoreBoard() ist global in BoardDesk
          if (typeof restoreBoard === 'function') {
            restoreBoard(board);
            if (meta.name) {
              const display = document.getElementById('board-name-display');
              if (display) display.textContent = meta.name;
              document.title = meta.name;
            }
          }
          openBtn.textContent = '📂 Öffnen';
          openBtn.disabled = false;
        } catch (e) {
          openBtn.textContent = '⚠ Fehler';
          openBtn.disabled = false;
          console.error(e);
        }
      };
      header.insertBefore(openBtn, firstBtn || null);
    }

    // ── Tastaturkürzel ─────────────────────────────────────
    document.addEventListener('keydown', async (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const name = document.getElementById('board-name-display')?.textContent || 'Board';

      if (e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        if (typeof captureBoard === 'function')
          await window.BoardFile.save(captureBoard(), name);
      }
      if (e.key === 's' && e.shiftKey) {
        e.preventDefault();
        if (typeof captureBoard === 'function')
          await window.BoardFile.save(captureBoard(), name, true /* saveAs */);
      }
      if (e.key === 'o') {
        e.preventDefault();
        document.querySelector('#header button[title*="Öffnen"]')?.click();
      }
    });

    // ── Autosave alle 60 Sekunden (nur Tauri) ──────────────
    if (IS_TAURI) {
      setInterval(async () => {
        if (!window.BoardFile.currentPath) return;
        const name = document.getElementById('board-name-display')?.textContent || 'Board';
        if (typeof captureBoard === 'function')
          await window.BoardFile.autosave(captureBoard(), name);
      }, 60_000);
    }

  });
})();
