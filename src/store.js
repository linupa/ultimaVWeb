// store.js - keeps things in the browser between visits (IndexedDB): the player's game files, and
// the files the game writes (SAVED.GAM, SAVED.OOL and the working .OOL files). Browser only.

const DB = 'ultima-v-web';
const GAME = 'files'; // the player's copy of the game
const SAVES = 'saves'; // what the game has written

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GAME)) db.createObjectStore(GAME);
      if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function readAll(storeName) {
  const db = await open();
  const store = db.transaction(storeName, 'readonly').objectStore(storeName);
  const [names, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  db.close();
  return names.map((name, i) => [name, values[i]]);
}

/** Saves every file of a GameFiles. */
export async function saveFiles(gameFiles) {
  const db = await open();
  const tx = db.transaction(GAME, 'readwrite');
  for (const [name, bytes] of gameFiles.files) tx.objectStore(GAME).put(bytes, name);
  await done(tx);
  db.close();
}

/** Loads the saved game files into a GameFiles; returns how many there were. */
export async function loadFiles(gameFiles) {
  const all = await readAll(GAME);
  for (const [name, bytes] of all) gameFiles.add(name, bytes);
  return all.length;
}

/** Keeps one file the game wrote. */
export async function saveWritten(name, bytes) {
  const db = await open();
  const tx = db.transaction(SAVES, 'readwrite');
  tx.objectStore(SAVES).put(bytes, name);
  await done(tx);
  db.close();
}

/** The files the game wrote on earlier visits, as [name, bytes] pairs. */
export function loadWritten() {
  return readAll(SAVES);
}

/** Forgets them: the game starts again from the folder's own SAVED.GAM. */
export async function clearWritten() {
  const db = await open();
  const tx = db.transaction(SAVES, 'readwrite');
  tx.objectStore(SAVES).clear();
  await done(tx);
  db.close();
}
