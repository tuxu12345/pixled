# LED Arcade

Independent fourth demo based on LED Studio. Reuse the existing buffer and display interface with provenance; no runtime imports from sibling projects. The display implementation caches a lamp alpha mask and uploads a native image each frame, replacing costly per-lamp gradients. Plain ES modules, Canvas 2D, no install or build required.

Original game: Neon Run, a side-scrolling platform shooter with three handcrafted stages, collectibles, enemies, a final guardian, checkpoints, three lives, double jump and replay. Keyboard and multi-touch controls. Attract mode plays using the same physics and collision rules as a person. All gameplay, including health and outcome, appears in the LED framebuffer.

UI: warm graphite arcade enclosure, orange accent, large central screen, stage navigation, compact screen settings and accessible controls. 96×48 default; 128×64 and 192×96 show more of the world at native pixel resolution. Adjustable brightness/bloom, LED vs clean pixels, fullscreen, optional synthesized sound, PNG and RGB565 current-frame export.

Game simulation is DOM-free, fixed 1/60 second steps. Renderer consumes game state; screen output uses LedBuffer → RGB565 quantize → LedDisplay. The static server serves this project only. Hardware transmission is outside this browser demo; RGB565 exports are a documented integration boundary.

Validation: node:test covers landing, double jump, damage, projectiles, restart, checkpoints, stage completion and attract-mode completion. Browser checks cover actual keyboard interaction, settings, pause/restart, downloads, responsive layout and errors.
