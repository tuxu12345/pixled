import { LedBuffer } from './led/buffer.js';
import { STAGES } from './game.js';

const FONT = {
  '0':'111101101101111','1':'010110010010111','2':'111001111100111','3':'111001111001111','4':'101101111001001','5':'111100111001111','6':'111100111101111','7':'111001010010010','8':'111101111101111','9':'111101111001111',
  A:'010101111101101',B:'110101110101110',C:'111100100100111',D:'110101101101110',E:'111100110100111',F:'111100110100100',G:'111100101101111',H:'101101111101101',I:'111010010010111',J:'001001001101111',K:'101101110101101',L:'100100100100111',M:'101111111101101',N:'101111111111101',O:'111101101101111',P:'111101111100100',Q:'111101101111001',R:'110101110101101',S:'111100111001111',T:'111010010010010',U:'101101101101111',V:'101101101101010',W:'101101111111101',X:'101101010101101',Y:'101101010010010',Z:'111001010100111','-':'000000111000000',':':'000010000010000',' ':'000000000000000',
};
const HERO = ['.OOO.','OOOOW','WCCWC','.CCCC','.OTTO','OOTTO','.T.T.'];
const BOT = ['.RRRR.','RRRRRR','RW..WR','RRRRRR','.RRRR.','R....R'];
const COLORS = {O:'#ff9454',W:'#fff4ce',C:'#b5efdf',T:'#5d9aa6',R:'#fa797e'};
const THEMES = [
  {sky:'#06131c', far:'#102b3a', mid:'#164453', edge:'#52c6ab', sun:'#ed8b57', floor:'#12383b', neon:'#8af6cd'},
  {sky:'#1b1220', far:'#362233', mid:'#58323d', edge:'#d4846c', sun:'#ffd079', floor:'#493238', neon:'#ffb769'},
  {sky:'#101127', far:'#222447', mid:'#373263', edge:'#7d6cb9', sun:'#b69bea', floor:'#292a46', neon:'#bca4ff'},
];

export class SceneRenderer {
  constructor() {this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d', {willReadFrequently:true});}
  render(game, cols = 96, rows = 48, {paused = false, attract = false} = {}) {
    if (this.canvas.width !== cols || this.canvas.height !== rows) {this.canvas.width = cols; this.canvas.height = rows;}
    const c = this.ctx, theme = THEMES[game.stage], t = game.time;
    const camera = Math.max(0, Math.min(game.length - cols, game.player.x - cols * .3));
    const offsetY = rows - 48;
    const rect = (x,y,w,h,color) => {c.fillStyle=color; c.fillRect(Math.floor(x),Math.floor(y),Math.ceil(w),Math.ceil(h));};
    const world = (x,y,w,h,color) => rect(x-camera,y+offsetY,w,h,color);
    const text = (value, x, y, color, scale=1) => {
      for (const ch of value) {const bits=FONT[ch] || FONT[' ']; for(let i=0;i<15;i++) if(bits[i]==='1') rect(x+(i%3)*scale,y+Math.floor(i/3)*scale,scale,scale,color); x+=4*scale;}
    };
    const centered = (value, y, color, scale=1) => text(value,Math.floor((cols-(value.length*4-1)*scale)/2),y,color,scale);
    rect(0,0,cols,rows,theme.sky);
    for(let i=0;i<30;i++) {
      const x=((i*37+9-camera*.08)%cols+cols)%cols, y=(i*17+3)%Math.max(12,rows-20);
      rect(x,y,1,1,i%5===0?'#8eafa8':'#314451');
    }
    // Hard-edged scanline sun and layered silhouettes remain legible at 96×48.
    const sunX=cols*.74-camera*.025, sunY=offsetY+18, radius=10;
    for(let yy=-radius;yy<=radius;yy++) {
      if(yy>1 && yy%3===0) continue;
      const half=Math.floor(Math.sqrt(radius*radius-yy*yy));
      rect(sunX-half,sunY+yy,half*2,1,theme.sun);
    }
    for(let layer=0;layer<2;layer++) {
      const parallax=camera*(layer===0?.18:.36), spacing=layer===0?13:19;
      for(let i=-1;i<Math.ceil(cols/spacing)+2;i++) {
        const seed=i+Math.floor(parallax/spacing), x=i*spacing-parallax%spacing;
        const h=8+Math.abs(Math.sin(seed*7.1+layer))*17;
        const top=rows-9-h;
        rect(x,top,spacing-3,h+6,layer===0?theme.far:theme.mid);
        if(layer===1) {
          rect(x+1,top,spacing-5,1,theme.edge);
          rect(x+3,top-3,1,3,theme.mid);
          for(let yy=top+4;yy<rows-9;yy+=4) for(let xx=3;xx<spacing-4;xx+=4) if((Math.floor(yy)+xx+seed)%3) rect(x+xx,yy,1,1,theme.edge);
        }
      }
    }
    for(let x=Math.floor(camera);x<camera+cols+1;x++) if(game.solidAt(x)) {
      world(x,42,1,6,theme.floor); world(x,42,1,1,theme.neon);
      if(x%3===0) world(x,43,1,1,theme.edge);
      if(x%7===0) world(x,46,2,1,theme.edge);
      if(x%19===0) {world(x,40,1,2,theme.edge); world(x+1,41,1,1,theme.neon);}
    }
    for(const p of game.platforms) {
      world(p.x,p.y,p.w,p.h,theme.floor); world(p.x,p.y,p.w,1,theme.neon);
      for(let x=p.x+2;x<p.x+p.w-1;x+=4) world(x,p.y+2,2,1,theme.edge);
    }
    for(const coin of game.coins) {
      const y=coin.y+Math.sin(t*4+coin.x)*.7;
      world(coin.x+1,y,1,4,'#ffe3a4'); world(coin.x,y+1,3,2,'#ffba56'); world(coin.x+1,y+1,1,1,'#fff4ce');
    }
    // Exit is always part of the LED frame, including its lock state.
    const locked=game.enemies.some(e=>e.kind==='boss'), gate=game.length-13;
    world(gate,25,9,17,theme.mid); world(gate,25,9,1,locked?'#fa797e':theme.neon);
    world(gate,25,1,17,theme.neon); world(gate+8,25,1,17,theme.neon);
    for(let yy=28;yy<41;yy+=3) world(gate+2,yy,5,1,locked?'#713647':theme.edge);
    const sprite=(data,x,y,palette,flip=false)=>data.forEach((row,yy)=>[...row].forEach((ch,xx)=>{if(ch!=='.') world(x+(flip?row.length-1-xx:xx),y+yy,1,1,palette[ch]);}));
    for(const e of game.enemies) {
      if(e.kind==='bot') sprite(BOT,e.x,e.y+Math.sin(t*9+e.x)*.4,e.flash?{R:'#ffffff',W:'#ffffff'}:COLORS);
      else {
        world(e.x+2,e.y,8,2,'#a57bcd'); world(e.x,e.y+2,12,10,e.flash?'#fff4ce':'#9264b5');
        world(e.x+1,e.y+4,10,3,'#26162f'); world(e.x+2,e.y+5,3,1,'#ff856c'); world(e.x+7,e.y+5,3,1,'#ff856c');
        world(e.x+2,e.y+12,3,2,'#ba97d7'); world(e.x+8,e.y+12,3,2,'#ba97d7');
        world(e.x,e.y-3,12,1,'#432e58'); world(e.x,e.y-3,12*e.hp/e.maxHp,1,'#ff856c');
      }
    }
    const p=game.player;
    if(p.invulnerable<=0 || Math.floor(t*14)%2===0) {
      sprite(HERO,p.x,p.y,COLORS,p.facing<0);
      if(p.grounded && Math.abs(p.vx)>4 && Math.floor(t*12)%2) {world(p.x,p.y+6,1,1,COLORS.T);world(p.x+4,p.y+6,1,1,COLORS.T);}
      world(p.x+(p.facing>0?4:-2),p.y+3,3,1,'#fff0c4');
    }
    for(const b of game.bullets) {world(b.x,b.y,b.w,b.h,b.enemy?'#ff686b':'#ffe3a4');world(b.x-Math.sign(b.vx)*2,b.y,2,1,b.enemy?'#922e46':'#bb7436');}
    for(const s of game.sparks) world(s.x,s.y,1,1,s.color);
    rect(0,0,cols,8,'#071018');
    for(let i=0;i<3;i++) {
      const color=i<game.lives?'#ff947c':'#34414b';
      rect(3+i*7,2,2,2,color);rect(6+i*7,2,2,2,color);rect(4+i*7,3,3,2,color);rect(5+i*7,5,1,1,color);
    }
    text(String(game.score).padStart(5,'0'),cols-22,2,'#f4deb4');
    if(attract) text('DEMO',Math.floor(cols/2)-8,2,theme.neon);
    else text('0'+(game.stage+1),Math.floor(cols/2)-4,2,theme.neon);
    if(paused || game.status!=='playing') {
      rect(8,Math.floor(rows/2)-10,cols-16,23,'#09131d');
      rect(8,Math.floor(rows/2)-10,cols-16,1,theme.neon);
      centered(paused?'PAUSED':game.status==='won'?'STAGE CLEAR':'GAME OVER',Math.floor(rows/2)-5,theme.neon);
      centered(paused?'P TO RESUME':game.status==='won'?'SIGNAL RESTORED':'R TO RETRY',Math.floor(rows/2)+4,'#c1cbd1');
    }
    if(!this.buffer || this.buffer.cols!==cols || this.buffer.rows!==rows) this.buffer=new LedBuffer(cols,rows);
    const rgba=c.getImageData(0,0,cols,rows).data;
    for(let i=0;i<cols*rows;i++) for(let k=0;k<3;k++) this.buffer.data[i*3+k]=rgba[i*4+k]/255;
    return this.buffer;
  }
}
