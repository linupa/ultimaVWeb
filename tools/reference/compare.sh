#!/bin/bash
# Plays a scenario in the C++ port and in this port and compares the screen, text and saved game.
#   tools/reference/compare.sh NAME [SAVED.GAM variant] [intro|menu] [another file for the game]
# (intro / menu: start at the title, or at the menu, instead of in the saved game)
# Needs CPP (the ultima5_sdl checkout, built with `make`) and GAME (the game folder); builds
# build/reference/ref_play from tools/reference/ref_play.cpp the first time.
set -e
CPP=${CPP:-../ultima5_sdl}; GAME=${GAME:-../ultima5}
here=$(cd "$(dirname "$0")" && pwd); out=build/reference; mkdir -p $out
if [ ! -x $out/ref_play ] || [ $here/ref_play.cpp -nt $out/ref_play ]; then
  g++ -std=c++17 -O1 -iquote $CPP/src -iquote $CPP/test -o $out/ref_play $here/ref_play.cpp $CPP/build/obj/platform_script.o \
    $(ls $CPP/build/obj/*.o | grep -v -E "/(sdl_main|sdl_platform|platform_script|test_[a-z_]+)\.o$") -Wl,--wrap=_Z9time_seedv
fi
n=$1; save=$2; mode=$3; extra=$4
rm -rf $out/save_$n && mkdir -p $out/save_$n
[ -n "$save" ] && cp "$save" $out/save_$n/SAVED.GAM
[ -n "$extra" ] && cp "$extra" $out/save_$n/
$out/ref_play "$GAME" $out/save_$n 1234 $here/scenarios/$n.keys $out/$n.raw $out/$n.gam $out/$n.txt $mode
env U5_GAME="$GAME" U5_KEYS=$here/scenarios/$n.keys U5_REF=$out/$n ${save:+U5_SAVE=$save} ${mode:+U5_INTRO=$mode} ${extra:+U5_EXTRA=$extra} U5_SHOT=$n.png npx vitest run test/play.test.js
