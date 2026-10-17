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
import { KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_UP } from './platform/keys.js';
import { loadFiles, loadWritten, saveFiles, saveWritten } from './store.js';

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
const MENU_TOP = 17 * 8; // the menu's items (intro.menuKeys, top to bottom) from text row 17
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
  return item < intro.menuKeys.length ? item : -1;
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
      return item < 0 ? null : { key: intro.menuKeys.charCodeAt(item), rects: [] }; // the menu's cursor shows it
    }
    case 'targets': return targetAt(p);
  }
  return null;
}

// In the game, at the command prompt in Britannia or a town (input.commandPrompt), a press on the
// map - not a release - is an arrow key: towards a square WALK_FROM or more squares from the
// party's (across or down), along the axis it lies further along (a diagonal goes the nearer of the
// four ways). Held WALK_HOLD ms or more, it keeps walking - a step each time the game is back at
// the prompt - towards wherever the pointer is then, until it is released; but not from a square
// next to the party's. The four of those across or down are different again: a click on one
// (released within RING_HOLD ms, on it) is a step there, and a press held RING_HOLD ms opens the
// ring of directional commands around it (below). The party's own square does nothing.
const VIEW = { x: 8, y: 8, size: 11 * 16 }; // the 11 x 11 map view; the party is at its middle
const WALK_FROM = 1;
const WALK_HOLD = 500;
const RING_HOLD = 500;

/** The view square at a screen point, as (col, row) from the party's, or null off the view. */
function squareAt({ x, y }) {
  if (x < VIEW.x || x >= VIEW.x + VIEW.size || y < VIEW.y || y >= VIEW.y + VIEW.size) return null;
  return { col: Math.floor((x - VIEW.x) / 16) - 5, row: Math.floor((y - VIEW.y) / 16) - 5 };
}

/** The arrow key towards a square next to the party's (not diagonally), or 0. */
function neighbourKey(sq) {
  if (!sq || Math.abs(sq.col) + Math.abs(sq.row) !== 1) return 0;
  return sq.col < 0 ? KEY_LEFT : sq.col > 0 ? KEY_RIGHT : sq.row < 0 ? KEY_UP : KEY_DOWN;
}

/** The arrow key a press at this screen point walks by, or 0. */
function walkKeyAt({ x, y }) {
  if (x < VIEW.x || x >= VIEW.x + VIEW.size || y < VIEW.y || y >= VIEW.y + VIEW.size) return 0;
  const col = Math.floor((x - VIEW.x) / 16) - 5, row = Math.floor((y - VIEW.y) / 16) - 5;
  if (Math.max(Math.abs(col), Math.abs(row)) < WALK_FROM) return 0;
  const dx = x - (VIEW.x + VIEW.size / 2), dy = y - (VIEW.y + VIEW.size / 2); // from the party's middle
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? KEY_LEFT : KEY_RIGHT;
  return dy < 0 ? KEY_UP : KEY_DOWN;
}

let pointer = null; // the last screen point the pointer was at, null once it left the screen
let held = null; // the pointer pressed on the screen (its id), until it is released
let heldSince = 0; // when it was pressed (performance.now())
// A press on a square next to the party: { sq, timer } - the timer opens the ring.
let pressedNeighbour = null;
// A touch screen has no hover: then all the choices are outlined, and the one touched lights up.
let touch = matchMedia('(hover: none)').matches; // the last pointer used was a finger or a pen

screen.addEventListener('pointerdown', (e) => {
  touch = e.pointerType !== 'mouse';
  if (e.button !== 0) return;
  if (!intro.mouseMode) {
    if (!input.commandPrompt) return;
    const sq = squareAt(screenPoint(e));
    if (neighbourKey(sq)) {
      e.preventDefault();
      const id = e.pointerId;
      held = id;
      screen.setPointerCapture(id);
      pointer = screenPoint(e);
      pressedNeighbour = { sq, timer: setTimeout(() => ringHeld(id), RING_HOLD) };
      return;
    }
    const key = walkKeyAt(screenPoint(e));
    if (!key) return;
    e.preventDefault();
    platform.pushKey({ key, shifted: 0 });
    held = e.pointerId;
    // A press on a square next to the party (diagonally) is a step, never more.
    heldSince = Math.max(Math.abs(sq.col), Math.abs(sq.row)) > 1 ? performance.now() : Infinity;
    screen.setPointerCapture(e.pointerId); // a drag off the map still steers; the release stops it
    pointer = screenPoint(e);
    return;
  }
  e.preventDefault();
  held = e.pointerId;
  screen.setPointerCapture(e.pointerId); // the release counts even off the screen (as a cancel)
  pointer = screenPoint(e);
  platform.present();
});

screen.addEventListener('pointerup', (e) => {
  if (held !== e.pointerId) return;
  held = null;
  if (pressedNeighbour) {
    const { sq: at, timer } = pressedNeighbour;
    clearTimeout(timer);
    pressedNeighbour = null;
    const sq = squareAt(screenPoint(e));
    if (sq && sq.col === at.col && sq.row === at.row && input.commandPrompt) platform.pushKey({ key: neighbourKey(at), shifted: 0 });
    return;
  }
  const choice = choiceAt(screenPoint(e));
  if (touch) pointer = null; // a lifted finger points nowhere
  if (choice) platform.pushKey({ key: choice.key, shifted: 0 });
  platform.present();
});

screen.addEventListener('pointercancel', () => {
  held = null;
  if (pressedNeighbour) clearTimeout(pressedNeighbour.timer);
  pressedNeighbour = null;
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
// A long touch is a held press, not a call for the browser's menu.
screen.addEventListener('contextmenu', (e) => {
  if (held !== null) e.preventDefault();
});

// The directional commands: a press held on a square next to the party (not diagonally) opens a
// ring of them around it. The press may go on to a button and be released there, or be released
// and a button clicked. Choosing one sends its letter, and then - when the game asks which way - the
// arrow towards the square. A command that doesn't ask (Jimmy without keys, say) drops the arrow,
// so it can't become a step. A click outside the ring, a key or the game moving on closes it.
const RING = [
  ['Talk', 0x54], ['Look', 0x4c], ['Attack', 0x41], ['Get', 0x47],
  ['Open', 0x4f], ['Search', 0x53], ['Push', 0x50], ['Jimmy', 0x4a],
];
const ring = document.getElementById('ring');
let ringKey = 0; // the arrow towards the square the ring is around, while it is open
let pendingDirection = null; // { key, left }: the arrow to answer the next direction prompt with
let ringPress = null; // the press that opened the ring (its id), until it is released

/** RING_HOLD ms into a press on a square next to the party: the ring, if it is still there. */
function ringHeld(id) {
  const at = pressedNeighbour?.sq;
  pressedNeighbour = null;
  if (held !== id || !at || !input.commandPrompt) return;
  const sq = pointer && squareAt(pointer);
  if (!sq || sq.col !== at.col || sq.row !== at.row) return; // dragged off it: nothing
  held = null;
  screen.releasePointerCapture(id); // the buttons get the rest of the press
  ringPress = id;
  openRing(at);
}

/** Does the command of a ring button: its letter now, the arrow when the game asks. */
function chooseRing(key) {
  const dir = ringKey;
  closeRing();
  if (!input.commandPrompt) return;
  platform.pushKey({ key, shifted: 0 });
  pendingDirection = { key: dir, left: false };
}

function openRing(sq) {
  // The screen is shown 4:3, so its pixels are taller than wide.
  const r = screen.getBoundingClientRect(), sx = r.width / 320, sy = r.height / 200;
  const w = 16 * sx, h = 16 * sy; // the square
  const cx = r.left + (VIEW.x + (sq.col + 5) * 16 + 8) * sx, cy = r.top + (VIEW.y + (sq.row + 5) * 16 + 8) * sy;
  const size = Math.min(64, Math.max(44, w * 1.1)); // a button, big enough for a finger
  const radius = Math.max(h / 2 + size / 2 + 4, size * 1.35); // around the square; the buttons don't overlap
  ringKey = neighbourKey(sq);
  ring.replaceChildren();
  ring.style.setProperty('--size', `${size}px`);
  const mark = document.createElement('div');
  mark.className = 'ring-square';
  Object.assign(mark.style, { left: `${cx - w / 2}px`, top: `${cy - h / 2}px`, width: `${w}px`, height: `${h}px` });
  ring.append(mark);
  RING.forEach(([label, key], i) => {
    const a = (i / RING.length) * 2 * Math.PI; // clockwise from the top
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.left = `${cx + radius * Math.sin(a) - size / 2}px`;
    b.style.top = `${cy - radius * Math.cos(a) - size / 2}px`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      chooseRing(key);
    });
    // The press that opened the ring, released on a button; lit while over it.
    b.addEventListener('pointerup', (e) => {
      if (e.pointerId === ringPress) chooseRing(key);
    });
    b.addEventListener('pointerenter', () => b.classList.add('lit'));
    b.addEventListener('pointerleave', () => b.classList.remove('lit'));
    ring.append(b);
  });
  ring.hidden = false;
}

function closeRing() {
  ringPress = null;
  ring.hidden = true;
  ring.replaceChildren();
  ringKey = 0;
}

ring.addEventListener('pointerdown', (e) => {
  if (e.target === ring) closeRing(); // outside the buttons
});
// The press that opened it released off the buttons: the ring stays, for a click.
addEventListener('pointerup', (e) => {
  if (e.pointerId === ringPress) ringPress = null;
});
addEventListener('keydown', (e) => {
  if (ring.hidden) return;
  closeRing();
  if (e.key === 'Escape') e.stopImmediatePropagation(); // only closes it
}, true);
addEventListener('resize', closeRing);

setInterval(() => {
  if (!ring.hidden && !input.commandPrompt) closeRing();
  if (!pendingDirection) return;
  if (input.directionPrompt) {
    if (!platform.keyWaiting()) {
      platform.pushKey({ key: pendingDirection.key, shifted: 0 });
      pendingDirection = null;
    }
  } else if (!input.commandPrompt) pendingDirection.left = true; // the command is under way
  else if (pendingDirection.left) pendingDirection = null; // back at the prompt without asking
}, 20);

// Walking on while the press is held.
setInterval(() => {
  if (held === null || pressedNeighbour || intro.mouseMode || !pointer || !input.commandPrompt || platform.keyWaiting()) return;
  if (performance.now() - heldSince < WALK_HOLD) return;
  const key = walkKeyAt(pointer);
  if (key) platform.pushKey({ key, shifted: 0 });
}, 20);

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
  // While a touch can choose something or walk it stays the game's (no scrolling or zooming the
  // page with it), so a finger can be dragged across the choices or steer; otherwise the page
  // takes it as usual.
  const touchAction = intro.mouseMode || input.commandPrompt ? 'none' : 'manipulation';
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

// ---- saved games (step 7): what the game writes is kept in IndexedDB. The menu's Load/Save/Transfer
// Game (intro.filesMenu) takes it out of the browser or puts a saved game in.

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

/**
 * The files the player picks ([] if they cancel). A browser opens its file chooser only just after
 * a key or click; the menu's choice usually is, but if it came too late the chooser opens at the
 * next one, with a hint to give it.
 */
const TYPE_HINT = typeHint.textContent;

function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const picker = document.createElement('input');
    Object.assign(picker, { type: 'file', accept, multiple, hidden: true });
    document.body.append(picker);
    const open = () => {
      typeHint.hidden = true;
      picker.click();
    };
    const done = (picked) => {
      typeHint.hidden = !(input.typing && touch);
      typeHint.textContent = TYPE_HINT;
      removeEventListener('pointerup', open, true);
      removeEventListener('keydown', open, true);
      picker.remove();
      resolve(picked);
    };
    picker.addEventListener('change', () => done([...picker.files]));
    picker.addEventListener('cancel', () => done([]));
    if (navigator.userActivation?.isActive === false) {
      typeHint.textContent = 'Click or press a key to choose the file';
      typeHint.hidden = false;
      addEventListener('pointerup', open, { capture: true, once: true });
      addEventListener('keydown', open, { capture: true, once: true });
    } else open();
  });
}

intro.fileActions = {
  download() {
    download('SAVED.GAM');
    download('SAVED.OOL');
  },
  // A saved game from the computer: SAVED.GAM and SAVED.OOL, by their extensions (a download may
  // have been renamed "SAVED (1).GAM").
  async load() {
    let loaded = false;
    for (const file of await pickFiles('.gam,.ool,.GAM,.OOL', true)) {
      const ext = file.name.toUpperCase().split('.').pop();
      if (ext !== 'GAM' && ext !== 'OOL') continue;
      files.put(`SAVED.${ext}`, new Uint8Array(await file.arrayBuffer()));
      loaded = true;
    }
    return loaded;
  },
  // Ultima IV's PARTY.SAV, whatever it is called now.
  async party() {
    const [file] = await pickFiles('.sav,.SAV', false);
    if (!file) return false;
    files.put('PARTY.SAV', new Uint8Array(await file.arrayBuffer()));
    return true;
  },
};

// ?j goes straight into the saved game (Journey Onward, like holding J at start-up); ?m starts at
// the menu, skipping the title sequence.
const params = new URLSearchParams(location.search);

async function run() {
  await restoreWritten();
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
