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
import { input } from './input.js';
import { clearWritten, loadFiles, loadWritten, saveFiles, saveWritten } from './store.js';

const screen = document.getElementById('screen');
const setup = document.getElementById('setup');
const status = document.getElementById('status');
const folder = document.getElementById('folder');
const zip = document.getElementById('zip');

const gameFiles = new GameFiles();

// The mouse (or a finger), before the game (intro.mouseMode). As with buttons, a press only arms:
// what counts is where it is released. In the title sequence, the demo, the introduction and the
// acknowledgements a release anywhere on the screen is a key press - sent as Escape, which skips or
// turns the page and which the menu ignores. In the menu a release on an item chooses it, as its
// letter does. When the game offers a choice (intro.mouseTargets: Male or Female, the gypsy's A or
// B) a release on it is its key. While pressed, the item under the pointer is lit and the light
// follows a drag - in the menu its own cursor moves there instead, and follows a mouse even
// unpressed; a release elsewhere chooses nothing.
const MENU_KEYS = 'JCTUAR'; // the items, top to bottom: text rows 17-22
const MENU_TOP = 17 * 8;
const SKIP = { key: 0x1b, rects: [] };

/** The screen pixel under the pointer (the canvas is scaled to the page). */
function screenPoint(e) {
  const r = screen.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * 320) / r.width, y: ((e.clientY - r.top) * 200) / r.height };
}

const onScreen = ({ x, y }) => x >= 0 && x < 320 && y >= 0 && y < 200;

/** The menu item at a screen point, or -1: anywhere along its row inside the menu's frame. */
function menuItemAt({ x, y }) {
  if (x < 8 || x >= 312 || y < MENU_TOP) return -1;
  const item = Math.floor((y - MENU_TOP) / 8);
  return item < MENU_KEYS.length ? item : -1;
}

/** The choice at a screen point, or null. */
function targetAt({ x, y }) {
  if (intro.mouseMode !== 'targets') return null;
  return intro.mouseTargets.find((t) => t.rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) ?? null;
}

/** What a release at this point would do, as { key, rects } (the rects to light), or null. */
function choiceAt(p) {
  if (!p || !onScreen(p)) return null;
  switch (intro.mouseMode) {
    case 'skip': return SKIP;
    case 'menu': {
      const item = menuItemAt(p);
      return item < 0 ? null : { key: MENU_KEYS.charCodeAt(item), rects: [] }; // the menu's cursor shows it
    }
    case 'targets': return targetAt(p);
  }
  return null;
}

let pointer = null; // the last screen point the pointer was at, null once it left the screen
let held = null; // the pointer pressed on the screen (its id), until it is released
// A touch screen has no hover: then all the choices are outlined, and the one touched lights up.
let touch = matchMedia('(hover: none)').matches; // the last pointer used was a finger or a pen

screen.addEventListener('pointerdown', (e) => {
  touch = e.pointerType !== 'mouse';
  if (e.button !== 0 || !intro.mouseMode) return;
  e.preventDefault();
  held = e.pointerId;
  screen.setPointerCapture(e.pointerId); // the release counts even off the screen (as a cancel)
  pointer = screenPoint(e);
  platform.present();
});

screen.addEventListener('pointerup', (e) => {
  if (held !== e.pointerId) return;
  held = null;
  const choice = choiceAt(screenPoint(e));
  if (touch) pointer = null; // a lifted finger points nowhere
  if (choice) platform.pushKey({ key: choice.key, shifted: 0 });
  platform.present();
});

screen.addEventListener('pointercancel', () => {
  held = null;
  pointer = null;
  platform?.present();
});

// A hand over what a release would do; the light follows the pointer.
screen.addEventListener('pointermove', (e) => {
  touch = e.pointerType !== 'mouse';
  pointer = screenPoint(e);
  screen.style.cursor = choiceAt(pointer) ? 'pointer' : '';
  platform?.present();
});
screen.addEventListener('pointerleave', () => {
  if (held !== null) return; // still pressed: it may come back
  pointer = null;
  platform?.present();
});

/**
 * What the page draws over each frame. While pressed, the item under the pointer lit. Otherwise,
 * when the game offers a choice: with a mouse the one under the pointer lit (hover), on a touch
 * screen every one outlined.
 */
function highlight() {
  // In the menu its own cursor follows a mouse, or a pressed finger.
  intro.menuPointed = intro.mouseMode === 'menu' && pointer && (held !== null || !touch) ? menuItemAt(pointer) : -1;
  // While a touch can choose something it stays the game's (no scrolling the page with it), so a
  // finger can be dragged across the choices; otherwise the page scrolls as usual.
  const touchAction = intro.mouseMode ? 'none' : 'manipulation';
  if (screen.style.touchAction !== touchAction) screen.style.touchAction = touchAction;
  const under = choiceAt(pointer);
  const lit = (rects) => rects.map((r) => ({ ...r, lit: true }));
  if (intro.mouseMode === 'targets' && touch)
    return intro.mouseTargets.flatMap((t) => t.rects.map((r) => ({ ...r, lit: held !== null && t === under })));
  if (held !== null || intro.mouseMode === 'targets') return under ? lit(under.rects) : [];
  return [];
}

// A touch screen's keyboard. It opens only for a text field, and (on most phones) only on a tap:
// while the game waits for typed text (input.typing) a tap on the screen focuses the hidden field
// #type-here, and many Android phones open it at once. What changes in the field is sent to the
// game as keys - the letters added, Backspace for each one removed - since touch keyboards often
// build up a word before it is final; Return comes as a key. The field starts with two spaces, so
// Backspace has something to remove even when nothing has been typed.
const typeHere = document.getElementById('type-here');
const typeHint = document.getElementById('type-hint');
const BLANK = '  ';
let typed = BLANK; // the field's text the game has been given

function resetTypeHere() {
  typeHere.value = typed = BLANK;
  typeHere.setSelectionRange(BLANK.length, BLANK.length);
}

function openKeyboard() {
  if (!input.typing) return;
  typeHere.inputMode = input.typing === 'number' ? 'numeric' : 'text';
  resetTypeHere();
  typeHere.focus({ preventScroll: true });
}

input.onTyping = (kind) => {
  if (kind && touch) openKeyboard();
  else if (!kind) typeHere.blur();
  typeHint.hidden = !(kind && touch && document.activeElement !== typeHere);
};
typeHere.addEventListener('focus', () => { typeHint.hidden = true; });
typeHere.addEventListener('blur', () => { typeHint.hidden = !(input.typing && touch); });
screen.addEventListener('click', () => { // a tap: the user action a keyboard may open on
  if (input.typing) openKeyboard();
});

typeHere.addEventListener('input', (e) => {
  const now = typeHere.value;
  let same = 0;
  while (same < now.length && same < typed.length && now[same] === typed[same]) same++;
  for (let n = typed.length - same; n > 0; n--) platform.pushKey({ key: 8, shifted: 0 });
  for (const ch of now.slice(same)) {
    const c = ch.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) platform.pushKey({ key: c, shifted: 0 });
  }
  typed = now;
  if (!e.isComposing) resetTypeHere(); // (not while the keyboard is still building a word)
});

async function start() {
  setPlatform(new BrowserPlatform(screen, window, highlight));
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
