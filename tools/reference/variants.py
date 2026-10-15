#!/usr/bin/env python3
"""Writes saved-game variants for the scenarios into OUT (default build/reference): the party
outdoors at Britain's gate (start_britain.GAM, by day; start_britain_night.GAM, at 21:00), and
there with monsters beside it (start_trolls.GAM, start_gazers.GAM, start_orcs.GAM: object 30, just
north of the party), and at the open entrances of Despise, Wrong and Shame (start_despise.GAM,
start_wrong.GAM, start_shame.GAM), and at the Shrine of Honesty (start_shrine.GAM); and an
Ultima IV PARTY.SAV for the transfer.
    python3 tools/reference/variants.py GAME_DIR [OUT]"""
import os, sys
game = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else 'build/reference'
os.makedirs(out, exist_ok=True)
g = open(os.path.join(game, 'SAVED.GAM'), 'rb').read()
img = open(os.path.join(game, 'DATA.OVL'), 'rb').read()[16:]
def var(name, changes):
    s = bytearray(g)
    for off, v in changes.items():
        s[off - 0x55A6] = v
    open(os.path.join(out, 'start_' + name + '.GAM'), 'wb').write(s)
gate = {0x5893: 0, 0x5895: 0, 0x5896: img[0x1E89 + 2], 0x5897: img[0x1EB1 + 2], 0x587C: 0x1C}
var('britain', gate)
var('britain_night', {**gate, 0x587F: 21, 0x5880: 21})
def monster(kind):  # object 30: tile, tile2, x, y, z, hull, flags, skiffs
    x, y = gate[0x5896], gate[0x5897] - 1
    return {**gate, **{0x5C5A + 30 * 8 + i: v for i, v in enumerate([kind * 4 + 0x40, kind * 4 + 0x40, x, y, 0, 0, 0, 0])}}
var('trolls', monster(0x29))
var('gazers', monster(0x1C))
var('orcs', monster(0x20))
def entrance(dungeon):  # on foot at a dungeon's entrance in Britannia, its seal opened (word of power)
    return {**gate, 0x5896: img[0x1E89 + dungeon], 0x5897: img[0x1EB1 + dungeon], 0x58D0 + dungeon - 0x21: 0x80}
var('despise', entrance(0x22))
var('wrong', entrance(0x24))
var('shame', entrance(0x26))
var('shrine', {**gate, 0x5896: img[0x1F6E], 0x5897: img[0x1F76]})  # at the Shrine of Honesty

# An Ultima IV PARTY.SAV for the transfer: an Avatar (every virtue complete) named Shamino.
u4 = bytearray(0x1F6)
hero = [0x1F4, 0x258, 0x0BB8, 25, 33, 18, 40, 0, 0, 0]  # hp, max hp, experience, str, dex, int, mp, ...
for i, w in enumerate(hero):
    u4[8 + 2 * i:10 + 2 * i] = w.to_bytes(2, 'little')
u4[8 + 0x14:8 + 0x14 + 7] = b'Shamino'
u4[8 + 0x24] = 0x0B  # male
u4[8 + 0x25] = 6     # ranger
u4[8 + 0x26] = ord('G')
open(os.path.join(out, 'PARTY.SAV'), 'wb').write(u4)
