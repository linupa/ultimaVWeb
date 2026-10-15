# Checking against the C++ port

The JS port should behave exactly like the C++ port (`../ultima5_sdl`). These tools play the
same thing in both, with the same random seed (1234) and a fixed clock seed (0x123), and compare:

- `ref_start.cpp` draws the first screen of Journey Onward; `test/start.test.js` compares with it
  (`U5_REF=<raw screen>`, `U5_SAVE=<a SAVED.GAM>`).
- `ref_play.cpp` plays a key script (`scenarios/*.keys`, hex key codes; 0 = a poll that finds no
  key) through `game_run` and writes the screen, the text printed and the saved game;
  `compare.sh NAME [SAVED.GAM]` runs it and `test/play.test.js` against it.
- `variants.py` makes saved games to start from: the party at Britain's gate by day and night,
  there with trolls, gazers or orcs beside it, at the open entrances of Despise, Wrong and Shame,
  and at the Shrine of Honesty.
- `check-all.sh` plays every scenario against its saved game; `dungeon-walk.py SEED N` writes
  a random walk through a dungeon (how wrong1-3 and shame1-3 were made).

```sh
make -C ../ultima5_sdl                     # the C++ objects the reference links with
python3 tools/reference/variants.py ../ultima5
tools/reference/compare.sh walk
tools/reference/compare.sh britain build/reference/start_britain.GAM
tools/reference/check-all.sh               # all of them
```

Scenarios cover walking, towns, talk and shops, fights (in town, outdoors, in dungeon corridors
and rooms), spells and items in and out of combat, camping (with the apparition), the party's
death, dungeons and a shrine, the title sequence and every menu item (with an Ultima IV
PARTY.SAV for the transfer), Blackthorn's capture and the ending. `compare.sh NAME SAVE MODE`
starts at the title (`intro`), the menu (`menu`) or a scene (`blackthorn`, `ending`) instead of
in the saved game.
