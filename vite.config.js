import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vite';

// For development only: `npm run dev` serves your own copy of the game (U5_GAME, default
// ../ultima5) at /gamedata/, with /gamedata/index.json listing it, so the page needn't ask for the
// folder each time. Nothing of it goes into the built site.
const gameDir = resolve(process.env.U5_GAME ?? '../ultima5');

function devGameData() {
  return {
    name: 'dev-game-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/gamedata', (req, res, next) => {
        try {
          const name = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
          if (name === 'index.json') {
            const files = readdirSync(gameDir).filter((f) => statSync(join(gameDir, f)).isFile());
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(files));
            return;
          }
          if (!/^[\w.-]+$/.test(name)) return next();
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(readFileSync(join(gameDir, name)));
        } catch {
          next();
        }
      });
    },
  };
}

// `base: './'` makes the built site work from any path, such as
// https://<user>.github.io/<repo>/ on GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [devGameData()],
  test: {
    include: ['test/**/*.test.js'],
  },
});
