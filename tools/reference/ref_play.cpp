// Reference for the JS port: Journey Onward then game_run with a key script, fixed seeds. With a
// last argument "intro" (or "menu", skipping the title sequence) it starts at the title instead,
// as the game does, and plays on into the game after Journey Onward.
// A last argument "blackthorn" or "ending" plays that scene first, from the saved game (as the
// C++ port's -x option does).
// args: gamedir savedir seed keysfile out.raw out.gam out.txt [intro|menu|blackthorn|ending]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include "files.h"
#include "game.h"
#include "gamedata.h"
#include "gfx.h"
#include "intro.h"
#include "endings.h"
#include "platform.h"
#include "map.h"
#include "misc.h"
#include "party.h"
#include "pictures.h"
#include "platform_script.h"
#include "savegame.h"
#include "sound.h"
#include "status.h"
#include "strings.h"
#include "text.h"
#include "tiles.h"
#include "video.h"
#include "view.h"
extern "C" unsigned __wrap__Z9time_seedv(void) { return 0x123; }
static FILE *txt;
static void echo(uint8_t c, int rune) { fputc(rune ? '#' : c, txt); }
int main(int argc, char **argv)
{
    files_set_game_dir(argv[1]);
    files_set_save_dir(argv[2]);
    if (!Data::instance().load()) return 1;
    gfx.video_type = 1;
    if (!video_start() || !load_tileset(pictures.name(Pictures::TILES))) return 1;
    reset_tile_anim_map(); reset_text_windows(); reset_text_attrs(); select_font(0);
    set_random_seed((uint16_t)atoi(argv[3]));
    std::vector<int> keys;
    FILE *k = fopen(argv[4], "r");
    unsigned v;
    while (fscanf(k, "%x", &v) == 1) keys.push_back((int)v);
    fclose(k);
    script_platform.keys(keys.data(), (int)keys.size());
    txt = fopen(argv[7], "w");
    text_echo = echo;
    const char *scene = argc > 8 && strcmp(argv[8], "intro") && strcmp(argv[8], "menu") ? argv[8] : NULL;
    if (argc > 8 && !scene) {   /* the title and menu */
        if (intro.intro_main(!strcmp(argv[8], "menu"))) {
            select_text_window(2);
            set_text_color((uint8_t)gfx.color_text);
            view.world_tick_enabled = 1;
            game_run();
        }
    } else {
    if (load_game_file("SAVED.GAM") != 0) return 1;
    {
        static uint8_t ool[0x200];
        if (load_file_part(0, 0x200, ool, "SAVED.OOL") == 0) {
            save_file_part(0x100, ool, "BRIT.OOL");
            save_file_part(0x100, ool + 0x100, "UNDER.OOL");
        }
    }
    sound.enabled = 1;
    tiles.origin_y = 8;
    select_text_window(0);
    draw_screen_frame();
    define_text_window(9, 0x27, 1, 0x18, 1);
    define_text_window(0x17, 0x27, 0x0B, 0x18, 2);
    select_text_window(2);
    set_text_color((uint8_t)gfx.color_text);
    if (scene) {   /* as sdl_main's -x */
        view.world_tick_enabled = 1;
        if (!strcmp(scene, "blackthorn")) {
            endings.captured_by_blackthorn();
        } else if (!strcmp(scene, "ending")) {
            map.set(Map::SCENE);
            party.sandalwood_box = 1;
            endings.rescue_lord_british();
        }
        if (!platform->quit_requested()) {
            select_text_window(0);
            draw_screen_frame();
            select_text_window(2);
        }
    }
    view.world_tick_enabled = 1;
    if (!scene || !platform->quit_requested()) game_run();
    }
    fclose(txt);
    FILE *f = fopen(argv[5], "wb");
    for (int y = 0; y < 200; y++) fwrite(video_fb[y], 1, 320, f);
    fclose(f);
    uint8_t image[SaveGame::SIZE];
    savegame.pack(image);
    f = fopen(argv[6], "wb");
    fwrite(image, 1, sizeof image, f);
    fclose(f);
    return 0;
}
