// gametime.js - the game's clock and calendar, as the Time class; `gameTime` is the one object.
// A day has 24 hours, a month 28 days, a year 13 months. Part of the saved game. Ported from the
// C++ port's gametime.h.
import { data, SHARED } from './data/gamedata.js';
import { savegame } from './savegame.js';

export class Time {
  constructor() {
    this.minute = 0;
    this.hour = 0;
    this.prevHour = 0; // the hour before the last passTime: has the sky moved?
    this.day = 0; // 1-28
    this.month = 0; // 1-13
    this.year = 0;
    this.moon1Phase = 0; // Trammel: the glyph of its phase, also the moongate's destination '0'-'7'
    this.moon2Phase = 0; // Felucca
    this.moongatePhase = 0; // how far the moongates have risen, 0-16
    this.restCooldown = 0;
    this.reagentSpotDay = new Uint8Array(3);
    this.hiddenItemDay = 0;
    this.apparitionMonth = 0;
    this.noAmbush = 0; // a new game's grace period: smaller monster groups until the first month ends

    const s = savegame;
    s.u8(0x57b2, this, 'hiddenItemDay', 'time.hiddenItemDay');
    s.bytes(0x5858, this.reagentSpotDay, 'time.reagentSpotDay');
    s.u16(0x5874, this, 'year', 'time.year');
    for (const [off, key] of [[0x587d, 'month'], [0x587e, 'day'], [0x587f, 'hour'], [0x5880, 'prevHour'], [0x5881, 'minute'],
      [0x5885, 'moon1Phase'], [0x5886, 'moon2Phase'], [0x5887, 'moongatePhase'], [0x588c, 'restCooldown'],
      [0x588d, 'apparitionMonth'], [0x5959, 'noAmbush']]) {
      s.u8(off, this, key, `time.${key}`);
    }
    // Trammel's and Felucca's phase on day 1-28 (ds:1ED8 + day * 2); [0] is not a day.
    this.moonPhases = data.bytes(0x1ed8, new Uint8Array(29 * 2), 'time.moonPhases', SHARED);
  }

  /** Moon 0 (Trammel) or 1 (Felucca) on a day, as a glyph '0'-'7'. */
  moonPhase(day, moon) {
    return this.moonPhases[(day < 29 ? day : 28) * 2 + (moon & 1)];
  }
}

export const gameTime = new Time();
