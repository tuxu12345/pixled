import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, autoInput } from '../js/game.js';

const step = (g, input = {}, n = 1) => { for (let i = 0; i < n; i++) g.update(1 / 60, input); };
const bare = () => { const g = new Game(); g.enemies = []; g.coins = []; return g; };

test('player lands on floor and cannot walk outside the left boundary', () => {
  const g = bare(); step(g, {left: true}, 120);
  assert.equal(g.player.x, 0); assert.equal(g.player.y + g.player.h, 42);
  assert.equal(g.player.grounded, true);
});
test('jump uses an edge, allows a second jump, rejects a third', () => {
  const g = bare(); step(g); step(g, {jump: true}, 12);
  assert.equal(g.player.jumps, 1); assert.ok(g.player.y < 35);
  step(g); step(g, {jump: true}); assert.equal(g.player.jumps, 2);
  step(g); const vy = g.player.vy; step(g, {jump: true});
  assert.equal(g.player.jumps, 2); assert.ok(g.player.vy > vy);
});
test('descending onto a platform lands on its top', () => {
  const g = bare(); g.platforms = [{x: 20, y: 29, w: 20, h: 3}];
  Object.assign(g.player, {x: 23, y: 10, vy: 12, grounded: false});
  step(g, {}, 50); assert.equal(g.player.y, 22); assert.equal(g.player.grounded, true);
});
test('a bullet hits an enemy, awards points, and is removed', () => {
  const g = bare(); g.enemies = [{x: 31,y: 36,w: 6,h: 6,hp: 1,vx: 0,min: 31,max: 31,kind: 'bot'}];
  step(g, {shoot: true}, 18);
  assert.equal(g.enemies.length, 0); assert.ok(g.score >= 100);
});
test('damage grants invulnerability and zero lives ends the run', () => {
  const g = bare(); g.hurt(); g.hurt(); assert.equal(g.lives, 2);
  g.player.invulnerable = 0; g.hurt(); g.player.invulnerable = 0; g.hurt();
  assert.equal(g.lives, 0); assert.equal(g.status, 'lost');
  const x = g.player.x; step(g, {right: true}, 60); assert.equal(g.player.x, x);
});
test('falling loses one life and respawns at a safe checkpoint', () => {
  const g = bare(); g.player.y = 80; step(g);
  assert.equal(g.lives, 2); assert.equal(g.player.x, 8); assert.equal(g.player.y, 35);
});
test('collectibles award once and disappear', () => {
  const g = bare(); g.coins = [{x: 10, y: 36}]; step(g);
  assert.equal(g.coins.length, 0); assert.equal(g.collected, 1);
  const score = g.score; step(g); assert.equal(g.score, score);
});
test('stage exits complete a stage and final guardian locks the exit', () => {
  const g = bare(); g.player.x = g.length - 10; step(g); assert.equal(g.status, 'won');
  const last = new Game(2); last.player.x = last.length - 10; step(last);
  assert.equal(last.status, 'playing'); last.enemies = []; step(last); assert.equal(last.status, 'won');
});
test('reset removes previous run state', () => {
  const g = bare(); g.score = 900; g.lives = 1; g.status = 'lost'; g.reset(1);
  assert.equal(g.score, 0); assert.equal(g.lives, 3); assert.equal(g.status, 'playing');
  assert.equal(g.stage, 1); assert.equal(g.player.x, 8);
});
for (const stage of [0, 1, 2]) {
  test(`attract controller can finish stage ${stage + 1} using normal collision rules`, () => {
    const g = new Game(stage);
    for (let i = 0; i < 60 * 100 && g.status === 'playing'; i++) g.update(1 / 60, autoInput(g));
    assert.equal(g.status, 'won', `x=${g.player.x}, lives=${g.lives}, enemies=${g.enemies.length}`);
  });
}
