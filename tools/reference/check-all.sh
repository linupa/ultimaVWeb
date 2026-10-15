#!/bin/bash
# Plays every scenario in the C++ port and this port and compares them (see README.md). Needs the
# saved-game variants: python3 tools/reference/variants.py ../ultima5
here=$(cd "$(dirname "$0")" && pwd); v=build/reference
# scenario, the saved game it starts from (- : the game folder's SAVED.GAM), how it starts (intro,
# menu, or a scene: blackthorn, ending; none: in the saved game), and another file it needs
while read -r name save mode extra; do
  [ "$save" = - ] && save=
  printf '%-14s' "$name"
  tools/reference/compare.sh "$name" "${save:+$v/start_$save.GAM}" "$mode" "${extra:+$v/$extra}" 2>&1 | grep -E "Tests " || echo "(failed to run)"
done <<'LIST'
walk
leave
cmds
roam1
roam2
roam3
roam4
roam5
britain britain
britain_night britain_night
talk1 britain
armoury britain
inn britain
tavern britain
fight1 britain
magic britain
camp britain
apparition britain_night
trolls trolls
gazers gazers
orcs orcs
death trolls
despise despise
wrong1 wrong
wrong2 wrong
wrong3 wrong
shame1 shame
shame2 shame
shame3 shame
shrine shrine
title_150 - intro
title_700 - intro
title_1500 - intro
title_2500 - intro
title_4000 - intro
title_5500 - intro
title - intro
menu_journey - menu
menu_ack - menu
menu_story - menu
menu_demo - menu
menu_create - menu
menu_transfer - menu PARTY.SAV
blackthorn britain blackthorn
ending britain ending
LIST
