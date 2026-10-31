import { View, div, PathBuilder } from "gpui-kit";
import { appHome, readTextFile, watchFolder, settings, run } from "herdr";
import { WebSocket } from "websocket";
import rough from "./vendor/rough.esm.js";

const gen = rough.generator();
export default class NativeCanvas extends View {
  init(_props, cx) {
    this.elements = []; this.pan = {x:30,y:65}; this.z = 1; this.selected = null; this.drag = null;
    this.handle = cx.focus_handle(); this.renderMs = 0; this.frames = 0; this.moves = 0; this.note = "loading";
    this.samples=[]; this.eventTimes=[]; this.wsNote='connecting';
    cx.spawn(async cx=>{try {const ws=await WebSocket.connect('ws://127.0.0.1:18743/ws');this.ws=ws;
      for(let i=0;i<20;i++){const t=Date.now();await ws.write(JSON.stringify({ping:t}));await ws.read();this.eventTimes.push(Date.now()-t);}
      this.wsNote=`WS RTT ${this.eventTimes.slice().sort((a,b)=>a-b)[10]}ms median`;
      await fetch('http://127.0.0.1:18743/metrics',{method:'POST',body:JSON.stringify({kind:'ws',rtt:this.eventTimes})});cx.notify();
      for(;;){const msg=JSON.parse(await ws.read());if(msg.elements){this.elements=msg.elements;this.prepare();cx.notify();}}
    }catch(e){this.wsNote=String(e);cx.notify();}});
    this.source = `${appHome()}/mods/native-canvas/scene.json`;
    cx.spawn(async cx => {
      await this.load(cx);
      for (;;) { await watchFolder(`${appHome()}/mods/native-canvas`); await this.load(cx); }
    });
  }
  async close(_cx) { if(this.ws) await this.ws.close(); }
  async load(cx) {
    try { const s = JSON.parse(await readTextFile(this.source)); if(s.probeStamp) {await fetch('http://127.0.0.1:18743/metrics',{method:'POST',body:JSON.stringify({kind:'watch',latency:Date.now()-s.probeStamp})});}
      this.elements = s.elements.filter(e=>!e.isDeleted); this.prepare(); this.note = "relative RoughJS ESM loaded"; if(s.benchmark){this.benchmark(cx);} }
    catch(e) { this.note = String(e); }
    cx.notify();
  }
  prepare() {
    for (const e of this.elements) {
      const o={seed:e.seed||42,roughness:e.roughness??1,strokeWidth:e.strokeWidth||2};
      const w=e.width,h=e.height;
      let d;
      if(e.type==='rectangle') d=gen.rectangle(0,0,w,h,o);
      else if(e.type==='ellipse') d=gen.ellipse(w/2,h/2,w,h,o);
      else if(e.type==='diamond') d=gen.polygon([[w/2,0],[w,h/2],[w/2,h],[0,h/2]],o);
      else if(['line','arrow','freedraw'].includes(e.type)) d=gen.linearPath(e.points,o);
      e._sets=d?.sets||[];
    }
  }
  pt(x,y,e) {
    const a=e.angle||0, c=Math.cos(a),s=Math.sin(a), w=e.width/2,h=e.height/2;
    return [(e.x+w+(x-w)*c-(y-h)*s)*this.z+this.pan.x,(e.y+h+(x-w)*s+(y-h)*c)*this.z+this.pan.y];
  }
  draw(e) {
    const children=[];
    const key=`${this.z}:${settings()?.zoom||1}:${e.width}:${e.height}:${e.angle||0}`;
    if(e.type!=='text' && e._nativeKey===key) return e._native.map(n=>window.paint_path(n,e.strokeColor||'#dae3f0').absolute().left(e.x*this.z+this.pan.x).top(e.y*this.z+this.pan.y).size_full());
    const native=[];
    if(e.type==='text') {
      children.push(div().absolute().left(e.x*this.z+this.pan.x).top(e.y*this.z+this.pan.y)
        .text_size((e.fontSize||20)*this.z).text_color(e.strokeColor||'#dae3f0').child(e.text));
      return children;
    }
    const appZoom=settings()?.zoom||1;
    const p=(x,y)=>{const q=this.pt(x,y,e);return [(q[0]-e.x*this.z-this.pan.x)*appZoom,(q[1]-e.y*this.z-this.pan.y)*appZoom];};
    for(const set of e._sets) {
      const b=PathBuilder.stroke((e.strokeWidth||2)*this.z*appZoom);
      for(const op of set.ops) {
        const d=op.data;
        if(op.op==='move') b.move_to(...p(d[0],d[1]));
        else if(op.op==='lineTo') b.line_to(...p(d[0],d[1]));
        else if(op.op==='bcurveTo') b.cubic_bezier_to(...p(d[4],d[5]),...p(d[0],d[1]),...p(d[2],d[3]));
      }
      native.push(b.build());
    }
    if(e.type==='arrow' && e.points.length>1) {
      const a=e.points[e.points.length-2],q=e.points[e.points.length-1], angle=Math.atan2(q[1]-a[1],q[0]-a[0]);
      const b=PathBuilder.stroke(2*this.z*appZoom);
      b.move_to(...p(q[0]-14*Math.cos(angle-.5),q[1]-14*Math.sin(angle-.5))).line_to(...p(...q))
        .line_to(...p(q[0]-14*Math.cos(angle+.5),q[1]-14*Math.sin(angle+.5)));
      native.push(b.build());
    }
    e._native=native;e._nativeKey=key;
    return native.map(n=>window.paint_path(n,e.strokeColor||'#dae3f0').absolute().left(e.x*this.z+this.pan.x).top(e.y*this.z+this.pan.y).size_full());
  }
  benchmark(cx) {
    this.samples=[];this.benchStart=Date.now();const began=this.benchStart;let n=0;
    const timer=cx.timer.every(16,cx=>{this.pan.x+=n%2?1:-1;n++;cx.notify();if(n>=120){timer.cancel();this.benchStart=null;cx.spawn(async cx=>{
      await fetch('http://127.0.0.1:18743/metrics',{method:'POST',body:JSON.stringify({kind:'bench',elements:this.elements.length,elapsed:Date.now()-began,samples:this.samples})});this.note='bench complete';cx.notify();});}});
  }
  zoom(f, x=400,y=250) {
    const z=Math.max(.2,Math.min(4,this.z*f)),k=z/this.z;
    this.pan={x:x-(x-this.pan.x)*k,y:y-(y-this.pan.y)*k};this.z=z;
  }
  render(cx) {
    const start=Date.now(), appZoom=settings()?.zoom||1;
    const children=this.elements.flatMap(e=>this.draw(e));
    const sel=this.elements.find(e=>e.id===this.selected);
    if(sel) children.push(div().absolute().left(sel.x*this.z+this.pan.x-5).top(sel.y*this.z+this.pan.y-5)
      .w(sel.width*this.z+10).h(sel.height*this.z+10).border_1().border_color('#a78bfa'));
    this.renderMs=Date.now()-start; this.frames++; if(this.benchStart)this.samples.push({at:Date.now(),build:this.renderMs});
    const button=(label,fn)=>div().id(label).px(8).py(5).bg('#26344a').cursor_pointer().child(label).on_click((e,cx)=>{fn(cx);cx.stop_propagation();cx.notify();});
    return div().id('native-canvas').relative().size_full().overflow_hidden().bg('#101827').track_focus(this.handle)
      .on_mouse_down('left',(e,cx)=>{
        this.handle.focus(); const p=e.local_position;if(!p)return;
        const x=(p.x/appZoom-this.pan.x)/this.z,y=(p.y/appZoom-this.pan.y)/this.z;
        const hit=[...this.elements].reverse().find(q=>x>=q.x-8&&x<=q.x+q.width+8&&y>=q.y-8&&y<=q.y+q.height+8);
        this.selected=hit?.id||null;
        this.drag=hit?{e:hit,x:hit.x,y:hit.y,px:e.position.x,py:e.position.y}:null;
        this.note=`down ${hit?.id||'background'} clicks=${e.click_count} modifiers=${JSON.stringify(e.modifiers)}`;
        cx.notify();
      })
      .on_mouse_move((e,cx)=>{if(!this.drag)return;const d=this.drag;d.e.x=d.x+(e.position.x-d.px)/(this.z*appZoom);d.e.y=d.y+(e.position.y-d.py)/(this.z*appZoom);this.moves++;cx.notify();})
      .on_mouse_up('left',(e,cx)=>{this.drag=null;this.note=`up; moves=${this.moves}`;cx.notify();})
      .on_hover((hover,cx)=>{if(!hover&&this.drag){this.drag=null;this.note='drag cancelled at boundary (no capture API)';cx.notify();}})
      .on_scroll_wheel((e,cx)=>{if(e.modifiers.platform||e.modifiers.control)this.zoom(Math.exp(-e.delta.y/300),e.local_position.x/appZoom,e.local_position.y/appZoom);else{this.pan.x+=e.delta.x/appZoom;this.pan.y+=e.delta.y/appZoom;}cx.stop_propagation();cx.notify();})
      .on_key_down((e,cx)=>{if(e.key==='+'||e.key==='=')this.zoom(1.2);else if(e.key==='-')this.zoom(1/1.2);else if(e.key==='0'){this.z=1;this.pan={x:30,y:65};}else if(e.key==='escape')this.selected=null;else {this.note=`key ${e.keystroke} char=${e.key_char||''}`;}cx.stop_propagation();cx.notify();})
      .children(children)
      .child(div().absolute().left(12).top(10).flex().gap(8).text_size(12).text_color('#d5dff0')
        .child(button('−',()=>this.zoom(1/1.2))).child(button('+',()=>this.zoom(1.2)))
        .child(button('Reset',()=>{this.pan={x:30,y:65};this.z=1;}))
        .child(button('200 shapes',()=>{this.elements=Array.from({length:200},(_,i)=>({id:`bench${i}`,type:i%5===0?'text':'rectangle',x:(i%20)*43,y:Math.floor(i/20)*35,width:37,height:26,fontSize:9,text:`${i}`,strokeColor:'#8ebafa',seed:i+1}));this.prepare();}))
        .child(button('Bench',cx=>this.benchmark(cx)))
        .child(button('Reload',cx=>cx.spawn(cx=>this.load(cx))))
        .child(button('Pane zoom',()=>run('pane.zoom'))))
      .child(div().absolute().left(12).bottom(10).text_size(11).text_color('#9babbe')
        .child(`${this.elements.length} elements · ${Math.round(this.z*100)}% · JS build ${this.renderMs}ms · render ${this.frames} · ${this.note} · ${this.wsNote}\nDrag shapes · wheel pan · cmd/ctrl-wheel or +/- zoom · 0 reset`));
  }
}
