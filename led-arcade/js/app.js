import { Game, STAGES, autoInput } from './game.js';
import { SceneRenderer } from './render.js';
import { LedDisplay } from './led/display.js';
import { quantize, toRGB565 } from './led/buffer.js';

const $ = id => document.getElementById(id);
const game = new Game(), scene = new SceneRenderer(), display = new LedDisplay($('screen'));
let cols = 96, rows = 48, brightness = .85, bloom = .35, led = true;
let attract = true, paused = false, sound = false, audioContext, lastBuffer, toastTimer;
let accumulator = 0, previous = 0, endTimer = 0, lastUI = 0, frameCount = 0, fpsTimer = 0;
const keys = new Set(), keyCodes = new Set(), pointers = new Map();
let best = {};
try { const saved = JSON.parse(localStorage.getItem('led-arcade-best') || '{}'); if (saved && typeof saved === 'object') best = saved; } catch { /* Storage is optional in private/restricted browsers. */ }
const bestScore = () => Number.isFinite(best[game.stage]) ? Math.max(0, best[game.stage]) : 0;
const toast = message => { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2800); };

function clearInput() { keys.clear(); keyCodes.clear(); pointers.clear(); document.querySelectorAll('.held').forEach(b => b.classList.remove('held')); }
function saveBest() {
  if (attract || game.score <= bestScore()) return;
  best[game.stage] = game.score;
  try {localStorage.setItem('led-arcade-best', JSON.stringify(best));} catch { /* Gameplay does not require persistent storage. */ }
}
function load(stage = game.stage, demo = attract) {
  saveBest(); attract = demo; paused = false; endTimer = 0; accumulator = 0; clearInput(); game.reset(stage); updateUI();
}
function updateUI() {
  const stage = STAGES[game.stage], ended = game.status !== 'playing';
  $('score').textContent = String(game.score).padStart(5,'0'); $('best').textContent = String(bestScore()).padStart(5,'0');
  $('coins').textContent = String(game.collected).padStart(2,'0');
  $('lives').textContent = Array.from({length:3},(_,i)=>i<game.lives?'♥':'♡').join(' ');
  $('lives').setAttribute('aria-label',game.lives+' 条生命');
  $('stageLabel').textContent = `${stage.zone} — ${stage.en}`;
  $('screenState').textContent = paused?'PAUSED':ended?(game.status==='won'?'SIGNAL RESTORED':'GAME OVER'):attract?'ATTRACT MODE':'PLAYER 01';
  $('screenSpec').textContent = `${cols} × ${rows} · RGB565`;
  const progress = Math.min(100,Math.floor(game.player.x/(game.length-15)*100));
  $('progress').style.width = progress+'%'; $('progressValue').textContent = progress+'%';
  $('runLabel').textContent = paused?'已暂停 · 按 P 继续':game.status==='won'?(game.stage===2?'信号已恢复 · 你做到了！':'关卡完成 · 继续下一段旅程'):game.status==='lost'?'信号中断 · 再来一次':attract?'自动演示中 · 随时加入冒险':`${stage.name} · 向右抵达信号门`;
  $('play').querySelector('span').textContent = attract?'开始游戏':game.status==='won'&&game.stage<2?'下一关':ended?'再玩一次':'重新挑战';
  $('pause').querySelector('span').textContent = paused?'继续':'暂停';
  $('fsPause').textContent = paused?'继续':'暂停';
  $('fsNext').hidden = game.status!=='won' || game.stage===2;
  $('pause').setAttribute('aria-pressed',String(paused));
  $('demo').classList.toggle('active',attract); $('demo').setAttribute('aria-pressed',String(attract));
  document.querySelectorAll('[data-stage]').forEach(b=>{const active=+b.dataset.stage===game.stage; b.classList.toggle('selected',active); b.setAttribute('aria-pressed',String(active));});
}
function play() {
  const next = !attract && game.status==='won' && game.stage<2 ? game.stage+1 : game.stage;
  load(next,false); $('screen').focus({preventScroll:true}); beep('coin');
}
function pause() {
  if(game.status!=='playing') return;
  paused=!paused; accumulator=0; clearInput(); updateUI();
}
function beep(event) {
  if(!sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if(audioContext.state==='suspended') audioContext.resume().catch(()=>{});
    const tones = {jump:[230,520,.09],shoot:[460,140,.035],coin:[700,1300,.12],destroy:[160,50,.15],hurt:[110,35,.22],win:[500,1000,.45]};
    const [from,to,duration]=tones[event] || tones.coin, osc=audioContext.createOscillator(), gain=audioContext.createGain(), now=audioContext.currentTime;
    osc.type=event==='shoot'?'triangle':'square'; osc.frequency.setValueAtTime(from,now); osc.frequency.exponentialRampToValueAtTime(to,now+duration);
    gain.gain.setValueAtTime(.025,now); gain.gain.exponentialRampToValueAtTime(.001,now+duration);
    osc.connect(gain); gain.connect(audioContext.destination); osc.start(now); osc.stop(now+duration);
    osc.onended=()=>{osc.disconnect();gain.disconnect();};
  } catch {sound=false; $('sound').setAttribute('aria-pressed','false'); toast('当前浏览器无法播放音效');}
}
function humanInput() {const held=new Set([...keys,...pointers.values()]);return {left:held.has('left'),right:held.has('right'),jump:held.has('jump'),shoot:held.has('shoot')};}
function render() {
  lastBuffer=scene.render(game,cols,rows,{paused,attract});
  display.setOptions({ledShape:led?'round':'square',gap:led?.25:0,bloom:led?bloom:0,scanlines:led&&$('scanlines').checked,glowCenter:led});
  const wrap=$('screenWrap');
  const cell=Math.min((wrap.clientWidth-2)/cols,(wrap.clientHeight-2)/rows);
  display.render(quantize(lastBuffer,'rgb565',{brightness,gamma:1}),cols,rows,{cellPx:Math.max(.25,cell)});
}
function frame(now) {
  const elapsed=previous?Math.min(.1,(now-previous)/1000):0; previous=now;
  if(!document.hidden && !paused) {
    if(game.status==='playing') {
      accumulator+=elapsed;
      while(accumulator>=1/60) {game.update(1/60,attract?autoInput(game):humanInput()); if(!attract) game.events.forEach(beep); accumulator-=1/60; if(game.status!=='playing') {saveBest();break;}}
    } else if(attract) {endTimer+=elapsed;if(endTimer>2.8)load((game.stage+1)%3,true);}
  } else accumulator=0;
  render(); frameCount++; fpsTimer+=elapsed;
  if(fpsTimer>=1) {$('fps').textContent=Math.min(240,Math.round(frameCount/fpsTimer))+' FPS';frameCount=0;fpsTimer=0;}
  if(now-lastUI>100) {updateUI();lastUI=now;}
  requestAnimationFrame(frame);
}

$('play').addEventListener('click',play);
$('pause').addEventListener('click',pause);
$('restart').addEventListener('click',()=>{load(game.stage,attract);toast('关卡已重新开始');});
$('demo').addEventListener('click',()=>{load(game.stage,!attract);toast(attract?'自动演示已开启':'已切换为手动游玩');});
$('sound').addEventListener('click',()=>{sound=!sound;$('sound').classList.toggle('muted',!sound);$('sound').setAttribute('aria-pressed',String(sound));$('sound').setAttribute('aria-label',sound?'关闭音效':'开启音效');if(sound)beep('coin');toast(sound?'音效已开启':'音效已关闭');});
async function fullscreen() {
  try {if(document.fullscreenElement)await document.exitFullscreen();else await $('cabinet').requestFullscreen();}
  catch {toast('当前浏览器暂不支持全屏，可使用浏览器的全屏模式');}
}
$('fullscreen').addEventListener('click',fullscreen);
$('fsExit').addEventListener('click',fullscreen);
$('fsPause').addEventListener('click',pause);
$('fsRestart').addEventListener('click',()=>load(game.stage,false));
$('fsNext').addEventListener('click',()=>load(Math.min(2,game.stage+1),false));
document.addEventListener('fullscreenchange',()=>{render(); if(document.fullscreenElement) $('screen').focus({preventScroll:true});});
document.querySelectorAll('[data-cols]').forEach(button=>button.addEventListener('click',()=>{
  cols=+button.dataset.cols;rows=+button.dataset.rows;
  document.querySelectorAll('[data-cols]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});
  $('resolutionHelp').textContent=`${cols===96?'经典车屏':cols===128?'宽阔视野':'全景点阵'} · ${(cols*rows).toLocaleString()} 颗灯珠`;
  updateUI();render();
}));
for(const id of ['brightness','bloom']) {
  const input=$(id);const sync=()=>{const value=+input.value;$(id+'Value').textContent=value+'%';input.style.setProperty('--fill',(value-Number(input.min))/(Number(input.max)-Number(input.min))*100+'%');if(id==='brightness')brightness=value/100;else bloom=value/100;};
  input.addEventListener('input',sync);sync();
}
function setMode(value) {led=value; for(const id of ['ledMode','pixelMode']) {const active=(id==='ledMode')===led;$(id).classList.toggle('selected',active);$(id).setAttribute('aria-pressed',String(active));} $('bloom').disabled=!led;$('scanlines').disabled=!led;}
$('ledMode').addEventListener('click',()=>setMode(true));$('pixelMode').addEventListener('click',()=>setMode(false));
document.querySelectorAll('[data-stage]').forEach(b=>b.addEventListener('click',()=>{load(+b.dataset.stage,attract);toast('已载入「'+STAGES[game.stage].name+'」');}));
const keyMap={ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right',ArrowUp:'jump',KeyW:'jump',Space:'jump',KeyK:'jump',KeyJ:'shoot',KeyX:'shoot'};
function rebuildKeys(){keys.clear();for(const code of keyCodes)if(keyMap[code])keys.add(keyMap[code]);}
window.addEventListener('keydown',event=>{
  if(event.altKey||event.ctrlKey||event.metaKey||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName))return;
  if((event.code==='Space'||event.code==='Enter')&&event.target.closest('button,a'))return;
  if(keyMap[event.code]) {event.preventDefault();if(attract)load(game.stage,false);keyCodes.add(event.code);rebuildKeys();}
  if(event.repeat)return;
  if(event.code==='Enter'){event.preventDefault();play();}
  if(event.code==='KeyP'||event.code==='Escape'&&!document.fullscreenElement){event.preventDefault();pause();}
  if(event.code==='KeyR')load(game.stage,attract);
  if(event.code==='KeyF')fullscreen();
});
window.addEventListener('keyup',event=>{keyCodes.delete(event.code);rebuildKeys();});
function releaseAll(){keyCodes.clear();clearInput();}
window.addEventListener('blur',()=>{releaseAll();if(!attract&&game.status==='playing'&&!paused){paused=true;updateUI();}});
document.addEventListener('visibilitychange',()=>{previous=0;accumulator=0;releaseAll();if(document.hidden&&!attract&&game.status==='playing'){paused=true;updateUI();}});
document.querySelectorAll('[data-control]').forEach(button=>{
  button.addEventListener('pointerdown',event=>{event.preventDefault();if(attract)load(game.stage,false);if(paused){paused=false;updateUI();}pointers.set(event.pointerId,button.dataset.control);button.classList.add('held');button.setPointerCapture(event.pointerId);});
  const release=event=>{pointers.delete(event.pointerId);if(![...pointers.values()].includes(button.dataset.control))button.classList.remove('held');};
  button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);button.addEventListener('contextmenu',e=>e.preventDefault());
});
function download(blob,name) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
$('exportPNG').addEventListener('click',()=>{
  const canvas=document.createElement('canvas');canvas.width=cols;canvas.height=rows;
  canvas.getContext('2d').putImageData(new ImageData(quantize(lastBuffer,'rgb565',{brightness,gamma:1}),cols,rows),0,0);
  canvas.toBlob(blob=>{if(blob){download(blob,`neon-run-${cols}x${rows}.png`);toast(`已保存 ${cols} × ${rows} 原生像素 PNG`);}else toast('保存失败，请重试');},'image/png');
});
$('exportRGB').addEventListener('click',()=>{
  const bytes=toRGB565(lastBuffer,{brightness,gamma:1});download(new Blob([bytes],{type:'application/octet-stream'}),`neon-run-${cols}x${rows}-be.rgb565`);
  toast(`已导出 RGB565 · ${bytes.length.toLocaleString()} 字节 · 大端逐行`);
});
for(let i=0;i<3;i++) {
  const preview=new Game(i);preview.player.x=i===2?538:46;preview.time=2;
  const thumbScene=new SceneRenderer(),buffer=thumbScene.render(preview,96,48);
  $('thumb'+i).getContext('2d').putImageData(new ImageData(quantize(buffer,'rgb565',{gamma:1}),96,48),0,0);
}
new ResizeObserver(()=>render()).observe($('screenWrap'));
updateUI();render();requestAnimationFrame(frame);
