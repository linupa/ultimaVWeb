# Ultima V Web

*Ultima V: Warriors of Destiny* (the 1988 MS-DOS version) in your web browser.

**Play it here: https://linupa.github.io/ultimaVWeb/**

This is a JavaScript port of [ultimaVSDL](https://github.com/linupa/ultimaVSDL), a C++ port made
from the decompiled original. It plays the whole game: the title sequence and character
creation, Britannia and its towns, conversations and shops, combat and magic, the dungeons and
shrines, and the endings. It looks and sounds like the original on an EGA card with the PC
speaker.

## You need your own copy of the game

**This site contains none of the game's data** - no pictures, maps, text or music. It reads them
from your own copy of Ultima V, which must be the **IBM PC (MS-DOS) version**. Versions for other
machines (Apple II, Commodore 64, Atari ST, Amiga, ...) use different file formats and won't work.

You can recognise the right files by `ULTIMA.EXE`, `DATA.OVL` and the other `.OVL` files,
`TILES.16`, `BRIT.DAT` and `INIT.GAM`. If your copy came on several floppy disks, put the contents
of all of them in one folder. Upper or lower case file names are both fine. A ZIP file of the
game works too: the page takes the files from the folder in it that holds `DATA.OVL`.

Your files stay in your browser. Nothing is uploaded anywhere.

## Playing

1. Open the page and click **Choose the Ultima V folder**, then pick the folder with the game's
   files - or click **Or a ZIP of it** and pick a ZIP file of the game, which is unpacked in your
   browser. The browser remembers the files, so this is needed only once.
2. The game starts as the original does: the Origin logo, Lord British's signature, the title and
   the menu. Choose **Create New Character** to start a new game, or **Journey Onward** to carry
   on with the saved game in your folder.

You need a keyboard; the game is played entirely with keys, as on DOS.

- **Arrow keys** move; the letters **A**-**Z** are the commands (Attack, Board, Cast, Enter, Fire,
  Get, Hole up, Ignite torch, Jimmy, Klimb, Look, Mix, New order, Open, Push, Quit & save, Ready,
  Search, Talk, Use, View, X-it, Yell, Ztats). **1**-**6** pick the active player, **0** clears it.
- **Ctrl+S** turns the sound on or off. Sound starts after your first key press (browsers don't
  let a page play sound before that).
- **Ctrl+R**, **Ctrl+W**, **Ctrl+T**, **Ctrl+N**, **Ctrl+L** and **Ctrl+Q** are left to the browser.
- In combat, aim with the arrow keys; **Home**, **End**, **Page Up** and **Page Down** aim
  diagonally.

### Saving

**Q** saves the game, as in the original. The save is kept in your browser, and it is what
**Journey Onward** loads next time. Under the screen:

- **Download saved game** gives you `SAVED.GAM` and `SAVED.OOL`. They work in the original game
  too.
- **Load a saved game** takes a `SAVED.GAM` (and `SAVED.OOL`) from your computer - from the
  original game, for example.
- **Start over from the folder's save** forgets the saves made in this browser.

Clearing the site's data in your browser also deletes your saves, so download the ones you want
to keep.

### Transfer from Ultima IV

To bring your hero over from Ultima IV, include Ultima IV's `PARTY.SAV` in the folder you choose,
or add it later with **Load a saved game**. Then pick **Transfer from Ultima IV** in the menu.

### Shortcuts

Add these to the address:

- `?m` - start at the menu, skipping the title sequence.
- `?j` - go straight into the saved game (Journey Onward).

## What isn't there yet

- Only the EGA look. The C++ port can also look like the CGA and Hercules versions; this one
  can't.
- No touch controls: phones and tablets need a keyboard.

## Development

You need [Node.js](https://nodejs.org/) 22.

```sh
npm install
npm run dev     # a local server with hot reload
npm test        # the tests (Vitest)
npm run build   # the static site, in dist/
```

`npm run dev` also serves your copy of the game from `../ultima5` (or the folder in the
`U5_GAME` environment variable), so the page doesn't have to ask for it. The tests that need the
game's files read them from the same place and are skipped when it isn't there.

**Never commit the game's files.** `.gitignore` keeps them out of the repository.

### How the code is organised

The port follows the C++ port's structure module by module, and through it the original's: the
comments cite the original's routines by address (e.g. `/** 5a28 */`). Everything that waits for
time or a key is `async`.

| Where | What |
|---|---|
| `src/main.js`, `src/store.js`, `src/gamefiles.js`, `src/zip.js` | the page: choosing the game folder or ZIP, saves in IndexedDB |
| `src/platform/` | the browser: canvas, keyboard, timers, Web Audio |
| `src/data/` | reading `DATA.OVL`, the strings, LZW-compressed pictures |
| `src/video/`, `src/gfx.js`, `src/text.js`, `src/tiles.js`, `src/picture.js` | EGA graphics and text |
| `src/game.js`, `src/outdoor.js`, `src/town.js`, `src/dungeon.js` | the game loops |
| `src/combat.js`, `src/magic.js`, `src/stats.js`, `src/talk.js`, `src/shops.js`, ... | the rest of the game |
| `src/intro.js`, `src/endings.js` | the title, menu and character creation; death and the endings |
| `test/` | the tests |
| `tools/reference/` | checks against the C++ port (see its README) |

`tools/gen-string-ids.py` makes `src/data/string-ids.js` (names and offsets only, no text) from
the C++ port's `strings.h`.

### Checking against the C++ port

With [ultimaVSDL](https://github.com/linupa/ultimaVSDL) built in `../ultima5_sdl` and the game in
`../ultima5`, the scripts in `tools/reference/` play the same key sequences in both ports, with the
same random seeds, and compare the screen, the text and the saved game. 45 scenarios cover the
title and menu, towns, conversations and shops, fights, magic, dungeons, shrines, death and the
ending:

```sh
python3 tools/reference/variants.py ../ultima5   # saved games the scenarios start from
tools/reference/check-all.sh
```

## Publishing on GitHub Pages

`.github/workflows/deploy.yml` tests and builds the site and publishes it on every push to `main`.
To turn it on, set **Settings > Pages > Source** to **GitHub Actions** in the repository. The site
works under any repository name (the build uses relative paths); its address is
`https://<user>.github.io/<repository>/`.

## License

The code is under the [MIT License](LICENSE). The license covers this project's code only, not
Ultima V itself.

## Credits

*Ultima V: Warriors of Destiny* is © 1988 Origin Systems; Ultima is a trademark of Electronic Arts.
This project is not affiliated with or endorsed by them, and it includes none of the game's
content: it needs your own copy of the game to run.
