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

const gameFiles = new GameFiles();

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

folder.addEventListener('change', async () => {
  await gameFiles.addFileList(folder.files);
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
  setup.hidden = true;
  run();
});

// ---- saved games (step 7): what the game writes is kept in IndexedDB, and can be taken out or put in.

const savesPanel = document.getElementById('saves');

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
