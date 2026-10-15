// gamestate.js - whether the player has left the game (Ctrl-E, or the page closing). From the C++
// port's game.cpp (exit_game, game_quit).
import { platform } from './platform/platform.js';

let exitRequested = false;

export function exitGame() {
  exitRequested = true;
}

export function gameQuit() {
  return exitRequested || (platform ? platform.quitRequested() : false);
}

export function gameClearExit() {
  exitRequested = false;
}
