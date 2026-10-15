// main.js - start-up: find the game files, then the title and menu (or straight into the saved
// game with ?j), then the game.
import { GameFiles } from './gamefiles.js';
import { gameRun, journeyOnward, startUp, WIN_MESSAGE } from './game.js';
import { gfx } from './gfx.js';
import { intro } from './intro.js';
import { textWindows as tw } from './text.js';
import { view } from './view.js';
import { BrowserPlatform } from './platform/browser.js';
import { platform, setPlatform } from './platform/platform.js';
import { files } from './files.js';
import { clearWritten, loadFiles, loadWritten, saveFiles, saveWritten } from './store.js';

const screen = document.getElementById('screen');
const setup = document.getElementById('setup');
const status = document.getElementById('status');
const folder = document.getElementById('folder');
const zip = document.getElementById('zip');

const gameFiles = new GameFiles();

// The mouse, before the game (intro.mouseMode): in the title sequence, the demo, the introduction
// and the acknowledgements a click is a key press - sent as Escape, which skips or turns the page
// and which the menu ignores. In the menu a click on an item chooses it, as its letter does.
const MENU_KEYS = 'JCTUAR'; // the items, top to bottom: text rows 17-22
const MENU_TOP = 17 * 8;

/** The screen pixel under the pointer (the canvas is scaled to the page). */
function screenPoint(e) {
  const r = screen.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * 320) / r.width, y: ((e.clientY - r.top) * 200) / r.height };
}

/** The menu item at a screen point, or -1: anywhere along its row inside the menu's frame. */
function menuItemAt({ x, y }) {
  if (x < 8 || x >= 312 || y < MENU_TOP) return -1;
  const item = Math.floor((y - MENU_TOP) / 8);
  return item < MENU_KEYS.length ? item : -1;
}

screen.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !intro.mouseMode) return;
  if (intro.mouseMode === 'skip') {
    e.preventDefault();
    platform.pushKey({ key: 0x1b, shifted: 0 });
  } else if (intro.mouseMode === 'menu') {
    const item = menuItemAt(screenPoint(e));
    if (item < 0) return;
    e.preventDefault();
    platform.pushKey({ key: MENU_KEYS.charCodeAt(item), shifted: 0 });
  }
});

// A hand over what a click would do.
screen.addEventListener('pointermove', (e) => {
  const clickable = intro.mouseMode === 'skip' || (intro.mouseMode === 'menu' && menuItemAt(screenPoint(e)) >= 0);
  screen.style.cursor = clickable ? 'pointer' : '';
});

async function start() {
  setPlatform(new BrowserPlatform(screen));
  try {
    await loadFiles(gameFiles);
  } catch {
    // no IndexedDB (private window): the player chooses the folder each time
  }
  if (!gameFiles.check().ok && import.meta.env.DEV) await loadDevGameData();
  if (gameFiles.check().ok) run();
  else askForFiles();
}

// `npm run dev` only: the game folder the dev server serves (see vite.config.js).
async function loadDevGameData() {
  try {
    const names = await (await fetch('./gamedata/index.json')).json();
    for (const name of names) gameFiles.add(name, new Uint8Array(await (await fetch(`./gamedata/${name}`)).arrayBuffer()));
  } catch {
    // no dev game folder: ask, as the published site does
  }
}

function askForFiles(message = '') {
  setup.hidden = false;
  status.textContent = message;
}

/** The files are in: check them, remember them, start. */
async function useGameFiles() {
  const { ok, missing, problem } = gameFiles.check();
  if (!ok) {
    askForFiles(problem ?? `Missing: ${missing.join(', ')}`);
    return;
  }
  try {
    await saveFiles(gameFiles);
  } catch {
    // keep going without remembering them
  }
  status.textContent = '';
  setup.hidden = true;
  run();
}

folder.addEventListener('change', async () => {
  await gameFiles.addFileList(folder.files);
  await useGameFiles();
});

// The game as a ZIP archive, e.g. the one it was downloaded as: unpacked here, in the browser.
zip.addEventListener('change', async () => {
  const file = zip.files[0];
  if (!file) return;
  status.textContent = `Unpacking ${file.name}...`;
  try {
    await gameFiles.addZip(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    askForFiles(`${file.name}: ${e.message ?? e}`);
    return;
  }
  await useGameFiles();
});

// ---- saved games (step 7): what the game writes is kept in IndexedDB, and can be taken out or put in.

const savesPanel = document.getElementById('saves');
const saveControls = document.getElementById('save-controls');
const toggleSaves = document.getElementById('toggle-saves');

// The save options can be hidden; the choice is remembered in this browser (if it lets the page).
function showSaveControls(show) {
  saveControls.hidden = !show;
  toggleSaves.textContent = show ? 'Hide save options' : 'Show save options';
  toggleSaves.setAttribute('aria-expanded', String(show));
}
try {
  showSaveControls(localStorage.getItem('saveControlsHidden') !== '1');
} catch {
  showSaveControls(true);
}
toggleSaves.addEventListener('click', () => {
  const show = saveControls.hidden;
  showSaveControls(show);
  try {
    localStorage.setItem('saveControlsHidden', show ? '0' : '1');
  } catch {
    // not remembered: private window or storage blocked
  }
  toggleSaves.blur(); // the keys go back to the game
});

async function restoreWritten() {
  try {
    for (const [name, bytes] of await loadWritten()) files.written.set(name, bytes);
  } catch {
    // no IndexedDB: the game's writes last only while the page is open
  }
  files.onWrite = (name, bytes) => saveWritten(name, bytes).catch(() => {});
}

function download(name) {
  const bytes = files.get(name);
  if (!bytes) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.getElementById('download').addEventListener('click', () => {
  download('SAVED.GAM');
  download('SAVED.OOL');
});

document.getElementById('upload').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    const name = file.name.toUpperCase();
    if (name !== 'SAVED.GAM' && name !== 'SAVED.OOL' && name !== 'PARTY.SAV') continue; // PARTY.SAV: Ultima IV's, for the transfer
    await saveWritten(name, new Uint8Array(await file.arrayBuffer())).catch(() => {});
  }
  location.reload(); // the game starts again from the save loaded
});

document.getElementById('reset').addEventListener('click', async () => {
  if (!confirm('Forget the saves made in this browser and start from the folder\'s SAVED.GAM?')) return;
  await clearWritten().catch(() => {});
  location.reload();
});

// ?j goes straight into the saved game (Journey Onward, like holding J at start-up); ?m starts at
// the menu, skipping the title sequence.
const params = new URLSearchParams(location.search);

async function run() {
  await restoreWritten();
  savesPanel.hidden = false;
  try {
    startUp(gameFiles);
    if (params.has('j')) {
      if (!journeyOnward()) {
        askForFiles('There is no saved game (SAVED.GAM) yet: open the page without ?j to create a character.');
        return;
      }
    } else {
      if (!(await intro.introMain(params.has('m')))) return; // the title, the menu; back after Journey Onward
      tw.selectTextWindow(WIN_MESSAGE);
      tw.setTextColor(gfx.colorText);
      view.worldTickEnabled = 1;
    }
  } catch (e) {
    askForFiles(String(e.message ?? e));
    return;
  }
  platform.present();
  await gameRun();
  platform.present();
}

start();
