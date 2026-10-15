// Prints routes (as key codes, 'O dir' before a closed door) from the party to beside each merchant's
// shop spot, for writing shop scenarios. Run with:
//   SAVE=build/reference/start_britain.GAM OUT=routes.txt npx vitest run --dir . tools/reference/routes.test.js
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { gameRun, journeyOnward, startUp } from '../../src/game.js';
import { setRandomSeed, setTimeSeedSource } from '../../src/misc.js';
import { setPlatform } from '../../src/platform/platform.js';
import { ScriptPlatform } from '../../src/platform/script.js';
import { loadGameFolder } from '../../test/helpers.js';
import { map } from '../../src/map.js';
import { npcs } from '../../src/npc.js';
import { tilePassable } from '../../src/commands.js';
it.skipIf(!process.env.SAVE || !process.env.OUT)('routes', async () => {
  const files = loadGameFolder();
  files.add('SAVED.GAM', readFileSync(process.env.SAVE));
  const p = new ScriptPlatform(); setPlatform(p); startUp(files);
  setTimeSeedSource(() => 0x123); setRandomSeed(1234);
  p.keys([0x45, 0, 0]);
  journeyOnward(); await gameRun();
  const doors = new Set([0xb8, 0xba]);
  const out = [];
  for (let n = 1; n < 32; n++) {
    const d = npcs.state[n].dialogue;
    if (!npcs.type[n] || d < 0x81 || d > 0x88) continue;
    const sc = npcs.schedules[n];
    const tx = sc.x[1], ty = sc.y[1], tz = sc.z[1];
    if (tz !== map.z) { out.push(`npc ${n} shop ${d - 0x81} on level ${tz}`); continue; }
    // BFS to a square from which a talk reaches (tx,ty): adjacent, or two away across a counter
    const goals = new Map();
    for (const [dx, dy, k] of [[1, 0, 1], [-1, 0, 2], [0, 1, 3], [0, -1, 4]]) { goals.set(`${tx + dx},${ty + dy}`, k); goals.set(`${tx + 2 * dx},${ty + 2 * dy}`, k); }
    const prev = new Map([[`${map.x},${map.y}`, null]]);
    const q = [[map.x, map.y]];
    let found = null;
    while (q.length) {
      const [x, y] = q.shift();
      if (goals.has(`${x},${y}`)) { found = [x, y]; break; }
      for (const [dx, dy, k] of [[-1, 0, 1], [1, 0, 2], [0, -1, 3], [0, 1, 4]]) {
        const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
        if (nx < 0 || ny < 0 || nx > 31 || ny > 31 || prev.has(key)) continue;
        const t = map.getTile(ny, nx);
        if (!tilePassable(t, 0x1c) && !doors.has(t)) continue;
        prev.set(key, [x, y, k, doors.has(t)]);
        q.push([nx, ny]);
      }
    }
    if (!found) { out.push(`npc ${n} shop ${d - 0x81}: no route`); continue; }
    const keys = [];
    let cur = `${found[0]},${found[1]}`;
    while (prev.get(cur)) { const [x, y, k, door] = prev.get(cur); keys.unshift(...(door ? ['4f', k, 0, k] : [k]), 0); cur = `${x},${y}`; }
    out.push(`npc ${n} shop ${d - 0x81} at ${tx},${ty} talk ${goals.get(`${found[0]},${found[1]}`)}: ${keys.join(' ')}`);
  }
  writeFileSync(process.env.OUT, out.join('\n') + '\n');
});
