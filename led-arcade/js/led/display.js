/**
 * Adapted from LED Studio's LedDisplay. Keeps its render/setOptions interface,
 * circular lamps, two-pass bloom and scanlines. The per-lamp shape is cached in
 * an alpha mask: animation uploads one native frame instead of making thousands
 * of gradients and draw calls per frame.
 */
export class LedDisplay {
  constructor(canvas) {
    this.canvas=canvas;this.ctx=canvas.getContext('2d');
    this.source=document.createElement('canvas');this.sourceCtx=this.source.getContext('2d');
    this.lamps=document.createElement('canvas');this.lampsCtx=this.lamps.getContext('2d');
    this.mask=document.createElement('canvas');this.maskCtx=this.mask.getContext('2d');
    this.opts={ledShape:'round',gap:.25,bloom:.35,scanlines:false,glowCenter:true};
    this.maskKey='';this.geom=null;
  }
  setOptions(options){Object.assign(this.opts,options);}
  render(rgba,cols,rows,{cellPx=null}={}) {
    const dpr=Math.min(2,window.devicePixelRatio||1);
    const cell=cellPx||Math.min(this.canvas.parentElement.clientWidth/cols,window.innerHeight*.58/rows);
    const w=cell*cols,h=cell*rows,bw=Math.round(w*dpr),bh=Math.round(h*dpr);
    if(this.canvas.width!==bw||this.canvas.height!==bh){this.canvas.width=bw;this.canvas.height=bh;}
    this.canvas.style.width=w+'px';this.canvas.style.height=h+'px';
    if(this.source.width!==cols||this.source.height!==rows){this.source.width=cols;this.source.height=rows;}
    this.sourceCtx.putImageData(new ImageData(rgba,cols,rows),0,0);
    const key=[bw,bh,cols,rows,this.opts.ledShape,this.opts.gap,this.opts.glowCenter].join(':');
    if(this.maskKey!==key) {
      this.maskKey=key;this.mask.width=bw;this.mask.height=bh;this.lamps.width=bw;this.lamps.height=bh;
      const mx=bw/cols,my=bh/rows,mc=this.maskCtx;
      const tile=document.createElement('canvas');tile.width=tile.height=Math.max(4,Math.ceil(Math.max(mx,my)*2));
      const tc=tile.getContext('2d'),size=tile.width,inset=size*this.opts.gap/2;
      if(this.opts.ledShape==='round') {
        const radius=size/2-inset;
        if(this.opts.glowCenter){const grad=tc.createRadialGradient(size/2,size/2,0,size/2,size/2,radius);grad.addColorStop(0,'#fff');grad.addColorStop(.55,'#fff');grad.addColorStop(1,'#ffffffb8');tc.fillStyle=grad;}
        else tc.fillStyle='#fff';
        tc.beginPath();tc.arc(size/2,size/2,radius,0,Math.PI*2);tc.fill();
      }else {tc.fillStyle='#fff';tc.fillRect(inset,inset,size-inset*2,size-inset*2);}
      for(let y=0;y<rows;y++)for(let x=0;x<cols;x++)mc.drawImage(tile,x*mx,y*my,mx,my);
    }
    const lc=this.lampsCtx;
    lc.globalCompositeOperation='source-over';lc.clearRect(0,0,bw,bh);lc.imageSmoothingEnabled=false;
    lc.drawImage(this.source,0,0,bw,bh);lc.globalCompositeOperation='destination-in';lc.drawImage(this.mask,0,0);
    const ctx=this.ctx;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#05070a';ctx.fillRect(0,0,w,h);
    ctx.drawImage(this.lamps,0,0,w,h);
    if(this.opts.bloom>.01&&cell>=2) {
      ctx.save();ctx.globalCompositeOperation='lighter';ctx.globalAlpha=this.opts.bloom*.8;
      ctx.imageSmoothingEnabled=true;ctx.filter=`blur(${Math.max(2,cell*1.2)}px)`;
      ctx.drawImage(this.source,0,0,w,h);ctx.restore();
    }
    if(this.opts.scanlines&&cell>=3) {
      ctx.fillStyle='#00000030';for(let y=0;y<rows;y+=2)ctx.fillRect(0,y*cell,w,Math.max(1,cell*.25));
    }
    this.geom={cell,w,h,cols,rows};return this.geom;
  }
}
