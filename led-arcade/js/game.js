export const STAGES = [
  { name: '霓虹边境', en: 'NEON FRONTIER', zone: '01', length: 540, color: '#72efce', gaps: [[132, 144], [282, 295], [416, 429]], platforms: [[62, 32, 22], [188, 32, 25], [335, 32, 24]], bots: [104, 226, 320, 465] },
  { name: '落日工厂', en: 'SUNSET WORKS', zone: '02', length: 620, color: '#ffb36c', gaps: [[122, 136], [260, 274], [408, 422], [530, 544]], platforms: [[55, 32, 20], [178, 31, 26], [310, 32, 25], [453, 31, 22]], bots: [95, 215, 302, 378, 485, 576] },
  { name: '最后的信号', en: 'LAST SIGNAL', zone: '03', length: 640, color: '#bda5ff', gaps: [[126, 140], [284, 298], [424, 438]], platforms: [[61, 32, 22], [187, 31, 25], [338, 32, 25]], bots: [104, 239, 385, 468], boss: 557 },
];
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Game {
  constructor(stage = 0) { this.reset(stage); }
  reset(stage = this.stage) {
    this.stage = clamp(stage, 0, STAGES.length - 1);
    const def = STAGES[this.stage];
    this.length = def.length; this.time = 0; this.score = 0; this.collected = 0;
    this.lives = 3; this.status = 'playing'; this.checkpoint = 8;
    this.previousJump = false; this.events = []; this.bullets = []; this.sparks = [];
    this.gaps = def.gaps.map(([a, b]) => [a, b]);
    this.platforms = def.platforms.map(([x, y, w]) => ({x, y, w, h: 3}));
    this.enemies = def.bots.map((x, i) => ({ x, y: 36, w: 6, h: 6, hp: 2, vx: i % 2 ? 6 : -6, min: x - 9, max: x + 9, kind: 'bot', cooldown: 2 }));
    if (def.boss) this.enemies.push({x: def.boss, y: 28, w: 12, h: 14, hp: 14, maxHp: 14, vx: 0, kind: 'boss', cooldown: 1.8});
    this.coins = [];
    for (let x = 38; x < this.length - 30; x += 35) {
      if (this.gaps.some(([a, b]) => x > a - 8 && x < b + 8)) continue;
      const platform = this.platforms.find(p => x > p.x && x < p.x + p.w);
      this.coins.push({x, y: platform ? platform.y - 5 : 35});
    }
    this.player = {x: 8, y: 35, w: 5, h: 7, vx: 0, vy: 0, facing: 1, grounded: true, jumps: 0, coyote: .1, jumpBuffer: 0, cooldown: 0, invulnerable: 0};
  }
  solidAt(x) { return x >= 0 && x < this.length && !this.gaps.some(([a, b]) => x >= a && x < b); }
  burst(x, y, color, count = 10) {
    for (let i = 0; i < count; i++) {
      const angle = i * 2.4 + this.time;
      this.sparks.push({x, y, vx: Math.cos(angle) * (7 + i % 4 * 4), vy: Math.sin(angle) * 14 - 7, life: .4 + i % 3 * .1, color});
    }
  }
  hurt(fall = false) {
    if (this.status !== 'playing' || (!fall && this.player.invulnerable > 0)) return;
    this.lives--; this.events.push('hurt');
    this.burst(this.player.x + 2, this.player.y + 3, '#ff725e');
    if (this.lives <= 0) { this.status = 'lost'; return; }
    this.player.invulnerable = 1.8;
    if (fall) Object.assign(this.player, {x: this.checkpoint, y: 35, vx: 0, vy: 0, grounded: true, jumps: 0});
  }
  update(dt, input = {}) {
    if (this.status !== 'playing') return;
    // Fixed substeps belong to the controller; cap accidental long frames here as well.
    dt = clamp(dt, 0, 1 / 30); this.time += dt; this.events = [];
    const p = this.player;
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    p.cooldown = Math.max(0, p.cooldown - dt);
    p.coyote = p.grounded ? .1 : Math.max(0, p.coyote - dt);
    p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
    if (input.jump && !this.previousJump) p.jumpBuffer = .1;
    this.previousJump = !!input.jump;
    const dir = Number(!!input.right) - Number(!!input.left);
    p.vx += (dir * 32 - p.vx) * Math.min(1, dt * (dir ? 16 : 22));
    if (dir) p.facing = dir;
    if (p.jumpBuffer > 0 && (p.coyote > 0 || p.jumps < 2)) {
      p.vy = p.jumps === 0 ? -48 : -44; p.jumps++; p.grounded = false; p.coyote = 0; p.jumpBuffer = 0;
      this.events.push('jump'); this.burst(p.x + 2, p.y + 7, '#85ecd2', 5);
    }
    p.x = clamp(p.x + p.vx * dt, 0, this.length - p.w);
    const oldBottom = p.y + p.h;
    p.vy = Math.min(70, p.vy + 100 * dt); p.y += p.vy * dt; p.grounded = false;
    // Platforms are intentionally one-way: jump through their underside and land on top.
    const surfaces = [...this.platforms];
    if (this.solidAt(p.x + 1) || this.solidAt(p.x + p.w - 1)) surfaces.push({x: p.x - 1, y: 42, w: p.w + 2});
    if (p.vy >= 0) for (const s of surfaces) {
      if (p.x + p.w > s.x && p.x < s.x + s.w && oldBottom <= s.y + .05 && p.y + p.h >= s.y) {
        p.y = s.y - p.h; p.vy = 0; p.grounded = true; p.jumps = 0;
      }
    }
    if (p.grounded && p.y === 35 && p.x > this.checkpoint + 110 && this.solidAt(p.x + 15) && !this.enemies.some(e => Math.abs(e.x - p.x) < 30)) this.checkpoint = p.x;
    if (p.y > 65) { this.hurt(true); return; }
    if (input.shoot && p.cooldown <= 0) {
      this.bullets.push({x: p.x + (p.facing > 0 ? 5 : -2), y: p.y + 3, w: 3, h: 1, vx: p.facing * 100, life: 1.15, enemy: false});
      p.cooldown = .2; this.events.push('shoot');
    }
    for (const e of this.enemies) {
      if (e.kind === 'bot') { e.x += e.vx * dt; if (e.x < e.min || e.x > e.max) {e.x = clamp(e.x, e.min, e.max); e.vx *= -1;} }
      else {
        e.cooldown -= dt;
        if (Math.abs(e.x - p.x) < 92 && e.cooldown <= 0) {
          e.cooldown = 1.5;
          this.bullets.push({x: e.x - 2, y: 38, w: 3, h: 2, vx: -35, life: 3, enemy: true});
        }
      }
      if (overlap(p, e)) this.hurt();
    }
    for (const b of this.bullets) {
      b.x += b.vx * dt; b.life -= dt;
      if (b.enemy) { if (overlap(b, p)) {this.hurt(); b.life = 0;} }
      else for (const e of this.enemies) {
        if (e.hp > 0 && overlap(b, e)) {
          e.hp--; e.flash = .08; b.life = 0; this.burst(b.x, b.y, '#ffd27e', 4);
          if (e.hp <= 0) {this.score += e.kind === 'boss' ? 1000 : 100; this.events.push('destroy'); this.burst(e.x + e.w / 2, e.y + 3, '#ffb45f', 15);}
          break;
        }
      }
    }
    this.enemies = this.enemies.filter(e => e.hp > 0);
    for (const e of this.enemies) e.flash = Math.max(0, (e.flash || 0) - dt);
    this.bullets = this.bullets.filter(b => b.life > 0);
    this.coins = this.coins.filter(c => {
      if (!overlap(p, {...c, w: 3, h: 4})) return true;
      this.collected++; this.score += 50; this.events.push('coin'); this.burst(c.x, c.y, '#ffd681', 6); return false;
    });
    for (const s of this.sparks) {s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 35 * dt; s.life -= dt;}
    this.sparks = this.sparks.filter(s => s.life > 0);
    if (this.status === 'playing' && p.x >= this.length - 15 && !this.enemies.some(e => e.kind === 'boss')) {
      this.status = 'won'; this.score += this.lives * 200; this.events.push('win');
    }
  }
}

export function autoInput(g) {
  const p = g.player;
  const gapAhead = g.gaps.some(([a, b]) => p.x + p.w > a - 8 && p.x < b);
  const bulletAhead = g.bullets.some(b => b.enemy && b.x > p.x && b.x < p.x + 16);
  const boss = g.enemies.find(e => e.kind === 'boss');
  const hold = boss && boss.x - p.x < 52;
  return {right: !hold, shoot: true, jump: !g.previousJump && p.grounded && (gapAhead || bulletAhead)};
}
