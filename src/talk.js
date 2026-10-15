// talk.js - conversations: the .TLK script interpreter and the Talk command (TALK.OVL), as the
// Conversation class; `conversation` is the one object. Ported from the C++ port's talk.cpp; the
// script format is in its docs/conversations.md.
//
// The script (0x400 bytes) is loaded into the text buffer and read through ptr. Printing goes
// through a word buffer so words wrap whole in the 16-column message window; bytes with bit 7
// clear are drawn in the rune font. Most functions return 1 when the conversation has ended. The
// conversation nests: a question runs the main loop again from inside the string being run, and
// the "1" result unwinds everything.
import { askDirection, getCommandKey, readLine, toUpper } from './commands.js';
import { data } from './data/gamedata.js';
import { S, strings } from './data/strings.js';
import { loadFilePart } from './files.js';
import { gameTime } from './gametime.js';
import { input } from './input.js';
import { M, map } from './map.js';
import { addByteCapped, addWordCapped, randomBetween, setRandomSeed, strFindNocase, subByteFloor0, subWordFloor0, timeSeed } from './misc.js';
import { npcs } from './npc.js';
import { findObjectAt } from './objects.js';
import { party } from './party.js';
import { platform } from './platform/platform.js';
import { savegame } from './savegame.js';
import { openShop } from './shops.js';
import { sound } from './sound.js';
import { status } from './status.js';
import { textWindows as tw } from './text.js';
import { textBuffer } from './textbuf.js';
import { town } from './town.js';
import { view } from './view.js';

/** bf80: equal ignoring case and bit 7 (the original's loop; both must end together). */
export function strEqualNocase(a, b) {
  for (let i = 0; ; i++) {
    if (toUpper(a.charCodeAt(i) & 0x7f) !== toUpper(b.charCodeAt(i) & 0x7f)) return false;
    if (i + 1 >= a.length && i + 1 >= b.length) return true;
  }
}

export class Conversation {
  static WORDS = 129;
  static BUILTIN_KEYWORDS = 34;

  constructor() {
    this.npc = 0;
    this.ptr = 0; // the script read pointer, into the text buffer
    this.label = 0; // the label to jump to (0x91-0x9F)
    this.keywordIndex = 0;
    this.input = ''; // the keyword the player typed (the shops read theirs here too)
    this.pendingOp = 0;
    this.operandCount = 0;
    this.operands = [0, 0, 0];
    this.fontMask = 0xff; // op 0x8E toggles the rune font (bit 7)
    this.questionPending = 0;
    this.wordBuf = [];
    this.lastCol = 0;
    this.lastOp = 0;
    this.needSpace = 0;
    this.almsCounter = 0; // turns since alms were last given
    // A bit per NPC met, by location 1-0x20 (entry 0 unused): the words from ds:5BDA on.
    this.metBits = new Uint32Array(33);
    savegame.u8(0x588b, this, 'almsCounter', 'conversation.almsCounter');
    savegame.bytes(0x5bda, new Uint8Array(this.metBits.buffer, 4, 32 * 4), 'conversation.metBits');
    // The script's words below 0x81 ("the", "thou", ...) and the words every NPC knows.
    this.words = data.words(0x24e8, new Array(Conversation.WORDS).fill(0), 'conversation.words');
    this.builtinKeywords = data.words(0x4aa8, new Array(Conversation.BUILTIN_KEYWORDS).fill(0), 'conversation.builtinKeywords');
  }

  word(n) {
    return strings.get(n < Conversation.WORDS ? this.words[n] : S.NONE);
  }
  builtinKeywordText(n) {
    return strings.get(n < Conversation.BUILTIN_KEYWORDS ? this.builtinKeywords[n] : S.NONE);
  }

  tp() {
    return textBuffer.get(this.ptr);
  }

  /** The script string at ptr (strings end with NUL). */
  scriptStr() {
    let s = '';
    for (let p = this.ptr; p < textBuffer.constructor.SIZE; p++) {
      const c = textBuffer.get(p);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  wordStart(pos) {
    return pos === 0 || (pos > 0 && this.input.charCodeAt(pos - 1) === 0x20);
  }

  findWord(needle) {
    const pos = strFindNocase(this.input, needle);
    return pos !== -1 && this.wordStart(pos);
  }

  /** bfd4: counters and tables one can talk across. */
  isTalkThroughTile(y, x) {
    const t = map.getTile(y, x);
    return t === 0x29 || (t >= 0x94 && t <= 0x9c) || t === 0xa5 || t === 0xae || t === 0xba || t === 0xbb || t === 0xbe || t === 0xca || t === 0xcb;
  }

  /** c02c: 1 = No. */
  async askPayYesNo() {
    tw.printText(strings.get(S.Dost_thou_pay_9052));
    for (;;) {
      const key = toUpper(await getCommandKey());
      if (key === 0x59) {
        tw.printText(strings.get(S.Yes_9066));
        return 0;
      }
      if (key === 0x4e || platform.quitRequested()) break;
    }
    tw.printText(strings.get(S.No_906C));
    return 1;
  }

  /** c162: the guards' tribute (half the gold in Minoc; a password at Blackthorn's). 1 = refused. */
  async guardToll() {
    if (map.id === M.PALACE_OF_BLACKTHORN) {
      if (party.activeSpell === 0x1d) { // the password check (the byte doubles as a flag here)
        tw.putChar(0x22);
        tw.printText(strings.get(S.Give_now_the_password_90FC));
        tw.putChar(0x22);
        tw.printText(strings.get(S.Your_response_9128));
        const answer = (await readLine(0x0e)).slice(0, 4); // a 4-byte buffer in the original
        tw.putChar(0x0a);
        if (strEqualNocase(answer, strings.get(S.IMPE_4A9A))) {
          tw.putChar(0x0a);
          tw.putChar(0x22);
          tw.printText(strings.get(S.Pass_friend_913A));
          tw.putChar(0x22);
          tw.putChar(0x0a);
          return 0;
        }
      }
      return 1;
    }
    if (map.id === M.MINOC) {
      tw.putChar(0x22);
      tw.printText(strings.get(S.Thou_wilt_give_half_thy_90A2));
      tw.putChar(0x22);
      if (await this.askPayYesNo()) return 1;
      party.gold = Math.trunc(((party.gold << 16) >> 16) / 2) & 0xffff;
    } else {
      let toll = 0;
      for (let i = 0; i < party.size; i++) if (!party.member(i).dead()) toll += 10;
      tw.printText(strings.get(S.A_guard_demands_a_90CC));
      tw.printNumber(' ', 2, toll);
      tw.printText(strings.get(S.gp_tribute_to_Blackthorn_90E0));
      if ((await this.askPayYesNo()) || party.gold < toll) return 1;
      party.gold -= toll;
    }
    status.drawStatusBar();
    return 0;
  }

  /** c29e: what an NPC does when talked to. 1 = the guard is refused (an arrest follows). */
  async talkToNpc(npc) {
    tw.putChar(0x0a);
    this.npc = npc;
    const s = npcs.state[npc];
    const activity = npcs.schedules[npc].activity;
    if (activity[s.schedSlot] === 4) {
      activity[s.schedSlot] = 1; // came to talk: now just wanders
    } else if (map.objects.at(s.object).tile === 0x70 && ((s.schedSlot & 1) === 0 || s.dialogue === 0)) {
      tw.printText(strings.get(S.The_guard_offers_no_9148));
      return 0;
    }
    const d = (s.dialogue << 16) >> 16;
    if (d === 0) {
      tw.printText(strings.get(S.No_response_9168));
    } else if (d < 0x80) {
      await this.talkRunConversation(d);
    } else if (d === 0xfd) {
      tw.putChar(0x22);
      tw.printText(strings.get(S.Don_t_hurt_me_Please_9176));
      tw.putChar(0x22);
      tw.putChar(0x0a);
    } else if (d === 0xfe) {
      await town.npcBegone(npc);
    } else if (d === 0xff) {
      return this.guardToll();
    } else if ((s.schedSlot & 1) && (npcs.currentScheduleSlot(gameTime.hour, npc) & 1)) {
      await openShop(d); // merchants are at the shop in schedule entry 1
    } else {
      tw.printText(strings.get(S.A_merchant_says_Come_see_9196));
      tw.printText(strings.get(S.when_it_s_open_91C4));
    }
    return 0;
  }

  /** c39c: T in a town. Non-zero if it ended in an arrest. */
  async cmdTalk() {
    const dir = await askDirection();
    if (!dir) return 0;
    let x = dir.dx + map.x, y = dir.dy + map.y;
    if (findObjectAt(map.z, y, x).tile === 0 && this.isTalkThroughTile(y, x)) {
      x += dir.dx;
      y += dir.dy;
    }
    const found = findObjectAt(map.z, y, x);
    if (found.tile === 0) {
      tw.printText(strings.get(S.Nobody_s_here_91D6));
      return 0;
    }
    const npc = town.npcForObject(found.slot);
    const t = map.getTile(y, x);
    if (t === 0x9d) tw.printText(strings.get(S.No_response_91F6)); // in bed
    else if (t === 0xab) tw.printText(strings.get(S.Zzzzzz_91E8));
    else if (npc < 0) tw.printText(strings.get(S.No_response_91F6)); // not an NPC (a horse ...)
    else return this.talkToNpc(npc);
    return 0;
  }

  talkEmitNewline() { return this.talkExecOp(0x8d); }
  talkEmitQuote() { return this.talkExecOp(0xa2); }

  /** c462: prints the buffered word; a space at column 0, or a newline right after a wrap, is dropped. */
  talkFlushWord() {
    if (this.wordBuf.length === 0) return;
    for (const b of this.wordBuf) {
      tw.selectFont((b & 0x80) === 0 ? 1 : 0);
      const c = b & 0x7f;
      if (tw.getCursorCol() === 0 && c === 0x20) continue;
      if (this.lastCol >= 0x0f && c === 0x0a) {
        this.lastCol = 0;
        continue;
      }
      if (c !== 0x0a) this.lastCol = tw.getCursorCol();
      tw.putChar(c);
    }
    this.wordBuf = [];
    tw.selectFont(0);
  }

  /** c4f4: up to 16 characters; a space or newline ends the word, a new line first if it won't fit. */
  talkBufferChar(c) {
    if (this.wordBuf.length !== 0x10) {
      this.wordBuf.push(c);
      if (c !== 0x8a && c !== 0xa0) return;
      if (tw.getCursorCol() + this.wordBuf.length >= 0x12) tw.putChar(0x0a);
    }
    this.talkFlushWord();
  }

  /** c536: three digit operands; beggars give karma for alms. */
  async talkOpPayGold() {
    const amount = (this.operands[0] & 0x7f) * 100 + (this.operands[1] & 0x7f) * 10 + (this.operands[2] & 0x7f) - 0x14d0;
    if (((party.gold << 16) >> 16) < amount) {
      this.wordBuf = [];
      tw.putChar(0x22);
      tw.printText(strings.get(S.Thou_hast_not_enough_9328));
      tw.putChar(0x22);
      tw.printText(strings.get(S.NL_NL_9344));
      this.pendingOp = 0;
      this.operandCount = 0;
      return this.talkMainLoop();
    }
    party.gold = (party.gold - amount) & 0xffff;
    status.drawStatusBar();
    if ((map.objects.at(npcs.state[this.npc].object).tile & 0xfc) === 0x6c && this.almsCounter > 99) {
      this.almsCounter = 0;
      addByteCapped(99, 1, party, 'karma');
      if (party.gold === 0) addByteCapped(99, 2, party, 'karma');
    }
    return 0;
  }

  /** c602: < 0x40 inventory (0x30 on: mixed spells), 0x41 food, 0x42 gold, 0x43 keys ... */
  talkOpGiveItem(item) {
    if (item < 0x40) {
      if (item < 0x30) addByteCapped(99, 1, party.inventory, item);
      else addByteCapped(99, 1, party.mixedSpells, item - 0x30);
      return;
    }
    const keys = { 0x43: 'keys', 0x44: 'gems', 0x45: 'torches', 0x46: 'grapples', 0x47: 'magicCarpets', 0x4b: 'oddKeys' };
    switch (item) {
      case 0x41: addWordCapped(9999, 1, party, 'food'); status.drawStatusBar(); return;
      case 0x42: addWordCapped(9999, 1, party, 'gold'); status.drawStatusBar(); return;
      case 0x48: party.sextant = 0xff; return;
      case 0x49: party.spyglass = 0xff; return;
      case 0x4a: party.blackBadge = 0xff; return;
    }
    if (keys[item]) addByteCapped(99, 1, party, keys[item]);
  }

  /** c6a8: past the next match byte (true) or stop byte (false); stops at the buffer's end. */
  talkSkipTo(stop, match) {
    for (;;) {
      if (this.ptr >= 0x400) return false;
      const b = this.tp();
      this.ptr++;
      if (b === match) return true;
      if (b === stop) return false;
    }
  }

  talkSeekString(index) {
    this.ptr = 0;
    for (; index !== 0; index--) this.talkSkipTo(0x90, 0);
  }

  async talkRunString() {
    while (this.tp() !== 0) {
      const op = this.tp();
      this.ptr++;
      if (await this.talkExecOp(op)) return 1;
      if (this.ptr >= 0x400) return 0;
    }
    return 0;
  }

  async talkSayString(index) {
    this.talkSeekString(index & 0xff);
    return this.talkRunString();
  }

  /** c73e: "same answer as the next keyword". */
  async talkOpOr() {
    let p = this.ptr + 1;
    while (textBuffer.get(p) === 0 && p < 0x400) p++;
    do p++;
    while (textBuffer.get(p - 1) !== 0 && p < 0x400);
    this.ptr = p;
    return this.talkRunString();
  }

  async talkOpAvatarName() {
    const n = party.member(0).name;
    for (let i = 0; i < n.length; i++) await this.talkExecOp(n.charCodeAt(i) | 0x80);
  }

  /** c78a: the NPC joins if a roster member has the same first three letters as its name. */
  async talkOpJoinParty() {
    const saved = this.ptr;
    if (party.full()) {
      await getCommandKey();
      tw.printText(strings.get(S.Thou_hast_no_room_for_9348));
      tw.printText(strings.get(S.Seek_me_again_if_one_9372));
      return 0;
    }
    this.talkSeekString(0);
    const npcName = this.scriptStr().slice(0, 3);
    this.ptr += 3;
    for (let i = 15; i > 0; i--) {
      if (strEqualNocase(party.member(i).name.slice(0, 3), npcName)) {
        party.swapIn(i);
        town.markNpcDead(this.npc);
        town.removeNpc(this.npc);
        status.drawStatusBar();
        this.talkFlushWord();
        this.ptr = saved;
        return 1;
      }
    }
    this.talkBufferChar(0x22);
    this.talkBufferChar(0x0a);
    tw.printText(strings.get(S.System_Error_No_Match_93A8));
    this.ptr = saved;
    return 1;
  }

  /** Label sections follow the keywords, each after a 0x90 byte; 0x9F ends them. */
  seekLabel() {
    this.ptr = 0;
    while (this.tp() !== this.label && this.ptr < 0x400) this.talkSkipTo(0x9f, 0x90);
  }

  async talkGotoLabel() {
    this.seekLabel();
    this.ptr++;
    return this.talkRunString();
  }

  async talkRunNextString() {
    this.talkSkipTo(0x90, 0);
    return this.talkRunString();
  }

  async talkGotoLabelDefault() {
    this.seekLabel();
    this.talkSkipTo(0x9f, 0);
    return this.talkRunString();
  }

  talkSeekKeyword(index) {
    this.ptr = 0;
    for (let n = index * 2 + 5; n !== 0; n--) if (!this.talkSkipTo(0x90, 0)) return false;
    return true;
  }

  talkMatchKeyword() {
    for (this.keywordIndex = 0; ; this.keywordIndex++) {
      if (!this.talkSeekKeyword(this.keywordIndex)) return false;
      if (this.findWord(this.scriptStr())) return true;
      this.ptr++;
    }
  }

  async talkReadInput() {
    this.talkFlushWord();
    this.input = await readLine(0x0f);
  }

  async talkSayBye() {
    await this.talkEmitQuote();
    if ((await this.talkSayString(4)) === 0) {
      await this.talkEmitQuote();
      await this.talkEmitNewline();
    }
    return 1;
  }

  /** About 1.5 s, or a key. */
  async rebukePause() {
    for (let i = 0; i < 0x1c; i++) {
      await view.worldTick();
      if (input.pollKey() !== 0) break;
      await input.delayTicks(1);
    }
    input.flushKeyboard();
  }

  /** c9d4: 0 NAME, 1-2 JOB/WORK, 3-4 BYE/THANK, 5-33 swearing. 2 while a question is pending, 1 if ended. */
  async talkBuiltinKeyword(index) {
    let r;
    if (index < 5 && this.questionPending) return 2;
    if (index === 0) {
      tw.printText(strings.get(S.My_name_is_93C2));
      r = await this.talkSayString(0);
    } else if (index < 3) {
      await this.talkEmitQuote();
      r = await this.talkSayString(3);
    } else if (index < 5) {
      return this.talkSayBye();
    } else {
      tw.printText(strings.get(S.With_language_like_that_93D0));
      await this.talkEmitQuote();
      await this.talkEmitNewline();
      await this.talkEmitNewline();
      await this.rebukePause();
      return 0;
    }
    if (r) return 1;
    await this.talkEmitQuote();
    await this.talkEmitNewline();
    await this.talkEmitNewline();
    return 0;
  }

  /** -1 none matched, 0 handled, 1 ended, 2 ignored (a question pending). */
  async checkBuiltins() {
    let r = -1;
    for (let i = 0; i < 0x22; i++) {
      if (!this.findWord(this.builtinKeywordText(i))) continue;
      r = await this.talkBuiltinKeyword(i);
      if (r === 0 || r === 1) return r;
    }
    return r;
  }

  /** ca84 */
  async talkMainLoop() {
    for (;;) {
      this.questionPending = 0;
      tw.printText(strings.get(S.Your_interest_9408));
      await this.talkReadInput();
      if (this.input === '' || platform.quitRequested()) {
        tw.printText(strings.get(S.BYE_941A));
        return this.talkSayBye();
      }
      await this.talkEmitNewline();
      await this.talkEmitNewline();
      const r = await this.checkBuiltins();
      if (r === 1) return 1;
      if (r === 0) continue;
      if (!this.talkMatchKeyword()) {
        tw.printText(strings.get(S.I_cannot_help_thee_with_9420));
      } else {
        await this.talkEmitQuote();
        if (await this.talkSayString(this.keywordIndex * 2 + 6)) return 1;
      }
      await this.talkEmitQuote();
      await this.talkEmitNewline();
      await this.talkEmitNewline();
    }
  }

  /** cb54: after the label, the question, the default reply, then (answer, reply) pairs up to 0x90. */
  talkMatchLabelAnswer() {
    this.seekLabel();
    this.talkSkipTo(0x9f, 0);
    this.talkSkipTo(0x9f, 0);
    do {
      if (this.findWord(this.scriptStr())) return true;
    } while (this.talkSkipTo(0x90, 0) && this.talkSkipTo(0x90, 0));
    return false;
  }

  /** cbdc */
  async talkAskQuestion() {
    let r;
    do {
      await this.talkEmitQuote();
      if (await this.talkGotoLabel()) return 1;
      await this.talkEmitQuote();
      do {
        await this.talkEmitNewline();
        await this.talkEmitNewline();
        this.questionPending = 0xff;
        tw.printText(strings.get(S.You_respond_9440));
        await this.talkReadInput();
        if (platform.quitRequested()) return 1;
        if (this.input === '') tw.printText(strings.get(S.What_didst_thou_say_9450));
      } while (this.input === '');
      await this.talkEmitNewline();
      await this.talkEmitNewline();
      r = await this.checkBuiltins();
      if (r === 1) return 1;
    } while (r === 0); // swearing asks again
    await this.talkEmitQuote();
    r = this.talkMatchLabelAnswer() ? await this.talkRunNextString() : await this.talkGotoLabelDefault();
    if (r) return 1;
    await this.talkEmitQuote();
    await this.talkEmitNewline();
    await this.talkEmitNewline();
    return this.talkMainLoop();
  }

  talkMarkMet(npc) {
    this.metBits[map.id] |= 1 << (npc & 31);
  }
  talkHasMet(npc) {
    return (this.metBits[map.id] >>> (npc & 31)) & 1;
  }

  clearPending() {
    this.operandCount = 0;
    this.pendingOp = 0;
  }

  /** cd3e: the operands of 0x85 (3 digits), 0x86 (item), 0x8C (label if met) and 0xFE (karma, label). */
  async talkOpOperands(b) {
    switch (this.pendingOp) {
      case 0x85:
        this.operands[this.operandCount++] = b;
        if (this.operandCount !== 3) return 0;
        if (await this.talkOpPayGold()) return 1;
        break;
      case 0x86:
        this.talkOpGiveItem(b & 0x7f);
        break;
      case 0x8c:
        this.clearPending();
        if (!this.talkHasMet(this.npc)) return 0;
        if (b === 0xff) return this.talkMainLoop();
        this.label = b;
        return this.talkAskQuestion();
      case 0xfe:
        this.operands[this.operandCount++] = b;
        if (this.operandCount !== 2) return 0;
        this.clearPending();
        if (party.karma < this.operands[0]) return 0;
        this.label = this.operands[1];
        return this.talkAskQuestion();
    }
    this.clearPending();
    return 0;
  }

  /** cdf8: the first four letters of a member's name: the NPC now knows the party. */
  async talkOpAskName() {
    await this.talkEmitQuote();
    this.talkFlushWord();
    tw.printText(strings.get(S.What_is_thy_name_9468));
    tw.printText(strings.get(S.You_respond_947C));
    await this.talkReadInput();
    this.clearPending();
    if (this.input !== '') {
      for (let i = 0; i < party.size; i++) {
        if (this.findWord(party.member(i).name.slice(0, 4))) {
          this.talkMarkMet(this.npc);
          tw.printText(strings.get(S.A_pleasure_94A0));
          return;
        }
      }
      tw.printText(strings.get(S.If_you_say_so_94B0));
      return;
    }
    tw.printText(strings.get(S.If_you_say_so_948C));
  }

  /** ceb2: one script byte. 1 if the conversation has ended. */
  async talkExecOp(op) {
    let resume = this.ptr; // most ops leave the pointer where it was
    if (this.pendingOp !== 0) return this.talkOpOperands(op);
    this.operandCount = 0;
    if (op === 0xa2 && this.lastOp === 0xa2) return 0; // no doubled quotes
    switch (op) {
      case 0x81: await this.talkOpAvatarName(); resume = this.ptr; break;
      case 0x82: return 1; // end
      case 0x83: await this.rebukePause(); resume = this.ptr; break; // pause
      case 0x84: return this.talkOpJoinParty();
      case 0x85: case 0x86: case 0x8c: case 0xfe: this.pendingOp = op; break;
      case 0x87:
        if (await this.talkOpOr()) return 1;
        break;
      case 0x88: await this.talkOpAskName(); resume = this.ptr; break;
      case 0x89: addByteCapped(99, 1, party, 'karma'); return 0;
      case 0x8a: subByteFloor0(1, party, 'karma'); return 0;
      case 0x8b: town.alertTown(); return 0;
      case 0x8e: this.fontMask ^= 0x80; return 0;
      case 0x8f: await getCommandKey(); return 0;
      case 0xff:
        this.talkFlushWord();
        return this.talkMainLoop();
      default:
        if (op > 0x90 && op < 0xa0) { // a label inside text: ask its question
          this.label = op;
          return this.talkAskQuestion();
        }
        if (op < 0x81) { // a word from the table, with spaces around it
          const w = this.word(op);
          this.talkBufferChar(0xa0);
          for (let i = 0; i < w.length; i++) this.talkBufferChar(w.charCodeAt(i) | 0x80);
          if (w.length === 0) this.talkBufferChar(op);
          else this.needSpace = 1;
        } else { // a character; 0x8D = new line
          op |= 0x80;
          if (op === 0x8d) op = 0x8a;
          const c = op & this.fontMask;
          this.lastOp = c;
          if (this.needSpace) this.talkBufferChar(0xa0);
          this.talkBufferChar(c);
          this.needSpace = 0;
        }
        resume = this.ptr;
    }
    this.ptr = resume;
    return 0;
  }

  /** d09c: "You see ...", then the greeting if the NPC knows the party, else half the time its name. */
  async talkGreeting() {
    tw.printText(strings.get(S.You_see_94C4));
    if (await this.talkSayString(1)) return 1;
    await this.talkEmitNewline();
    await this.talkEmitNewline();
    let r;
    if (!this.talkHasMet(this.npc)) {
      setRandomSeed(timeSeed());
      if (randomBetween(1, 0) === 0) return 0;
      tw.printText(strings.get(S.I_am_called_94CE));
      r = await this.talkSayString(0);
    } else {
      await this.talkEmitQuote();
      r = await this.talkSayString(2);
    }
    if (r) return 1;
    await this.talkEmitQuote();
    await this.talkEmitNewline();
    await this.talkEmitNewline();
    return 0;
  }

  /** d100: with the Shadowlord of Falsehood in town, something is stolen after each conversation. */
  async talkMaybeSteal() {
    if (town.shadowlordHere !== 0) return;
    tw.printText(strings.get(S.Something_was_stolen_94DC));
    await sound.soundSlide(0x32, 1, 2000, 800);
    setRandomSeed(timeSeed());
    if (party.keys === 0 && party.gems === 0 && party.torches === 0) {
      for (let i = 0x2f; i >= 0; i--) if (party.inventory[i]) { subByteFloor0(1, party.inventory, i); return; }
      for (let i = 7; i >= 0; i--) if (party.potions[i]) { subByteFloor0(1, party.potions, i); return; }
      for (let i = 7; i >= 0; i--) if (party.scrolls[i]) { subByteFloor0(1, party.scrolls, i); return; }
      subWordFloor0(randomBetween(0x0f, 1), party, 'gold');
      status.drawStatusBar();
      return;
    }
    for (;;) {
      const r = randomBetween(2, 0);
      const key = r === 0 ? 'keys' : r === 1 ? 'gems' : 'torches';
      if (party[key]) { subByteFloor0(1, party, key); return; }
    }
  }

  /** d1fe: the .TLK index (count, then (script, offset) pairs), then the script. */
  async talkRunConversation(script) {
    const file = map.tlkFile();
    loadFilePart(0, 0x200, textBuffer.data.subarray(0, 0x200), file);
    const count = textBuffer.word(0);
    let entry = 0;
    for (let i = 1; i <= count && i < 0x80; i++, entry++) if (textBuffer.word(2 + entry * 4) === script) break;
    const offset = textBuffer.word(2 + entry * 4 + 2);
    textBuffer.data.fill(0, 0, 0x400);
    loadFilePart(offset, 0x400, textBuffer.data.subarray(0, 0x400), file); // may be short at the end of the file
    this.wordBuf = [];
    this.needSpace = 0;
    if ((await this.talkGreeting()) === 0 && (await this.talkMainLoop()) === 0) await this.talkSayBye();
    await this.talkMaybeSteal();
  }
}

export const conversation = new Conversation();
