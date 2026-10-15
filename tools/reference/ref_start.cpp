// Reference for the JS port: the C++ port's Journey Onward start, with a fixed random seed,
// written as raw 320x200 colour numbers.
#include <stdio.h>
#include <stdlib.h>
#include "files.h"
#include "gamedata.h"
#include "gfx.h"
#include "map.h"
#include "misc.h"
#include "party.h"
#include "pictures.h"
#include "status.h"
#include "strings.h"
#include "text.h"
#include "tiles.h"
#include "town.h"
#include "video.h"
#include "view.h"
#include "outdoor.h"
int main(int argc, char **argv)
{
    files_set_game_dir(argv[1]);
    files_set_save_dir(argv[2]);
    if (!Data::instance().load()) return 1;
    gfx.video_type = 1;
    if (!video_start() || !load_tileset(pictures.name(Pictures::TILES))) return 1;
    reset_tile_anim_map(); reset_text_windows(); reset_text_attrs(); select_font(0);
    set_random_seed((uint16_t)atoi(argv[3]));
    if (load_game_file("SAVED.GAM") != 0) return 1;
    tiles.origin_y = 8;
    select_text_window(0);
    draw_screen_frame();
    define_text_window(9, 0x27, 1, 0x18, 1);
    define_text_window(0x17, 0x27, 0x0B, 0x18, 2);
    select_text_window(2);
    set_text_color((uint8_t)gfx.color_text);
    view.world_tick_enabled = 1;
    draw_status_bar();
    if (map.is_outdoors()) { map.enter_outdoors(); world_tick(); }
    else town.enter_town(0);
    FILE *f = fopen(argv[4], "wb");
    for (int y = 0; y < 200; y++) fwrite(video_fb[y], 1, 320, f);
    fclose(f);
    return 0;
}
