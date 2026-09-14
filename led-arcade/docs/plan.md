# LED Arcade implementation plan

Goal: a polished, independently runnable LED platform game demo.
Architecture: DOM-free simulation, pixel scene renderer, copied LED display, browser controller.
Stack: JavaScript ES modules, Canvas 2D, Node HTTP and node:test.
Spec: design.md. Original three projects remain intact; no external assets or dependencies.

- [x] Simulation — tests/game.test.mjs, js/game.js: fixed step movement, gravity, double jump, platforms and gaps, enemy patrol, shooting, damage/invulnerability, checkpoints, collectibles, final guardian and attract input. First run tests against missing implementation; implement and validate with `node --test`.
- [x] Screen and shell — index.html, css/app.css, js/render.js, js/app.js, js/led/: render sprites and all gameplay HUD into native frame dimensions, compose industrial arcade UI, keyboard/multi-touch controls and optional audio. Copy buffer.js/display.js from LED Studio, record provenance.
- [x] Delivery — server.mjs, package.json, start.bat, README.md: project-only static service, relative paths for standalone static hosting, documented controls and RGB565 layout. Verify Node tests, live browser operation, output downloads and desktop/mobile screenshots; leave preview running.
