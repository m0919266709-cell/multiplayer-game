const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const rooms = new Map();

const MAP = 18;
const OBSTACLES = [
  { id:'screen1', x:-7, z:-1, w:4.8, d:.45, h:2.2, type:'screen' },
  { id:'screen2', x:6, z:2, w:4.8, d:.45, h:2.2, type:'screen' },
  { id:'screen3', x:0, z:-8, w:5.4, d:.45, h:2.2, type:'screen' },
  { id:'screen4', x:0, z:8, w:5.4, d:.45, h:2.2, type:'screen' },
  { id:'screen5', x:-11, z:9, w:3.5, d:.45, h:2.2, type:'screen' },
  { id:'screen6', x:11, z:-9, w:3.5, d:.45, h:2.2, type:'screen' },
  ...[[-10,-10],[10,-10],[-10,10],[10,10],[-3,-4],[3,4]]
    .map((p,i)=>({
      id:'pillar'+i,x:p[0],z:p[1],
      w:1.25,d:1.25,h:4.2,type:'pillar'
    })),
  { id:'crate1',x:-13,z:0,w:1.6,d:1.6,h:1.2,type:'crate' },
  { id:'crate2',x:13,z:0,w:1.6,d:1.6,h:1.2,type:'crate' }
];

const ITEMS = [
  {id:'lime',type:'lime',x:-9,z:-5,label:'石灰粉'},
  {id:'dart',type:'dart',x:8,z:-8,label:'飛鏢'},
  {id:'smoke',type:'smoke',x:0,z:10,label:'迷煙'},
  {id:'robe',type:'robe',x:-11,z:7,label:'寶衣'},
  {id:'dagger',type:'dagger',x:11,z:5,label:'玄鐵匕首'}
];

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const dist = (a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

function makePlayer(id,role,ai=false){
  return {
    id,role,ai,
    x:role==='wei'?-4:4,
    z:12,y:0,
    yaw:role==='wei'?0:Math.PI,
    hp:role==='wei'?100:125,
    maxHp:role==='wei'?100:125,
    stamina:100,maxStamina:100,
    alive:true,
    input:{x:0,z:0},
    sprint:false,attack:false,block:false,jump:false,
    inventory:role==='wei'
      ?{lime:1,dart:2,smoke:1,robe:0,dagger:0}
      :{lime:0,dart:0,smoke:0,robe:0,dagger:0},
    effect:'',
    effectUntil:0,
    invulnerableUntil:0,
    wallRunUntil:0,
    wallRunCooldown:0,
    lastAttack:0,lastItem:0,
    aiNext:0,aiStrafe:1,aiStrafeUntil:0
  };
}

function makeRoom(mode){
  return {
    id:Math.random().toString(36).slice(2,9),
    mode,
    players:[],
    started:false,
    winner:null,
    items:ITEMS.map(i=>({...i,active:true})),
    destroyed:[],
    log:['對決準備開始！']
  };
}

function roomByPlayer(id){
  for(const r of rooms.values())
    if(r.players.some(p=>p.id===id)) return r;
  return null;
}

function publicState(r){
  return {
    roomId:r.id,
    mode:r.mode,
    started:r.started,
    winner:r.winner,
    players:r.players.map(p=>({
      id:p.id,role:p.role,ai:p.ai,
      x:p.x,z:p.z,y:p.y,yaw:p.yaw,
      hp:p.hp,maxHp:p.maxHp,
      stamina:p.stamina,
      alive:p.alive,
      inventory:p.inventory,
      effect:p.effect,
      wallRunUntil:p.wallRunUntil
    })),
    items:r.items.filter(i=>i.active),
    destroyed:r.destroyed,
    log:r.log.slice(-4)
  };
}

function say(r,msg){
  r.log.push(msg);
  if(r.log.length>12) r.log.shift();
}

function joinGame(socket,data){
  leaveGame(socket);

  const mode=data?.mode==='online'?'online':'ai';
  let role=data?.role==='hai'?'hai':'wei';
  let room=null;

  if(mode==='online'){
    room=[...rooms.values()].find(
      r=>r.mode==='online'&&!r.started&&r.players.length<2
    )||null;

    if(!room){
      room=makeRoom('online');
      rooms.set(room.id,room);
    }

    if(room.players.some(p=>p.role===role))
      role=role==='wei'?'hai':'wei';
  }else{
    room=makeRoom('ai');
    rooms.set(room.id,room);
  }

  const p=makePlayer(socket.id,role);
  room.players.push(p);
  socket.join(room.id);
  socket.data.roomId=room.id;

  if(mode==='ai'){
    room.players.push(
      makePlayer('AI-'+room.id,role==='wei'?'hai':'wei',true)
    );
    room.started=true;
    say(room,role==='wei'
      ?'你扮演韋小寶，設法逃出紫禁城！'
      :'你扮演海大富，阻止韋小寶逃跑！'
    );
  }else if(room.players.length===2){
    room.started=true;
    say(room,'雙方已到齊，對決開始！');
  }else{
    say(room,'等待另一名玩家加入……');
  }

  socket.emit('joined',{
    id:socket.id,role,mode,roomId:room.id
  });
  io.to(room.id).emit('state',publicState(room));
}

function leaveGame(socket){
  const rid=socket.data.roomId;
  if(!rid)return;

  const r=rooms.get(rid);
  socket.leave(rid);
  socket.data.roomId=null;

  if(r){
    r.players=r.players.filter(p=>p.id!==socket.id);

    if(r.players.length===0){
      rooms.delete(rid);
    }else{
      r.started=false;
      say(r,'對手已離開，等待新玩家加入。');
      io.to(rid).emit('state',publicState(r));
    }
  }
}

function collides(x,z,radius=.45){
  if(
    x < -MAP+radius || x > MAP-radius ||
    z < -MAP+radius || z > MAP-radius
  )return true;

  for(const o of OBSTACLES){
    if(
      Math.abs(x-o.x)<o.w/2+radius &&
      Math.abs(z-o.z)<o.d/2+radius
    )return true;
  }

  return false;
}

function sayCurrent(p,msg){
  const r=roomByPlayer(p.id);
  if(r)say(r,msg);
}

function movePlayer(p,dt){
  if(!p.alive)return;

  let ix=p.input.x;
  let iz=p.input.z;
  const len=Math.hypot(ix,iz);

  if(len>1){ix/=len;iz/=len;}

  if(Math.abs(ix)+Math.abs(iz)>.05)
    p.yaw=Math.atan2(ix,iz);

  const sprint=p.sprint&&p.stamina>1&&len>.1;
  let speed=(p.role==='wei'?5.1:4.0)*(sprint?1.42:1);

  if(sprint)
    p.stamina=Math.max(0,p.stamina-22*dt);
  else
    p.stamina=Math.min(100,p.stamina+13*dt);

  if(p.wallRunUntil>Date.now())speed*=1.8;

  const nx=p.x+ix*speed*dt;
  const nz=p.z+iz*speed*dt;

  if(!collides(nx,p.z))p.x=nx;
  if(!collides(p.x,nz))p.z=nz;

  if(p.jump&&p.role==='wei'&&p.stamina>10){
    p.stamina-=10;
    p.y=.7;
  }else{
    p.y=Math.max(0,p.y-4*dt);
  }

  p.jump=false;

  if(
    p.role==='hai' &&
    p.wallRunCooldown<Date.now() &&
    sprint && len>.1
  ){
    for(const o of OBSTACLES){
      const nearX=Math.abs(p.x-o.x)<o.w/2+1.0;
      const nearZ=Math.abs(p.z-o.z)<o.d/2+1.0;

      if((nearX||nearZ)&&p.stamina>=18){
        p.wallRunUntil=Date.now()+650;
        p.wallRunCooldown=Date.now()+2200;
        p.stamina-=18;
        sayCurrent(p,'海大富施展貼牆輕功！');
        break;
      }
    }
  }
}

function aiControl(r,p,enemy){
  if(!p.ai||!enemy||!enemy.alive)return;

  const d=dist(p,enemy);
  const dx=enemy.x-p.x;
  const dz=enemy.z-p.z;

  if(Date.now()>p.aiStrafeUntil){
    p.aiStrafe=Math.random()<.5?-1:1;
    p.aiStrafeUntil=Date.now()+900+Math.random()*1100;
  }

  if(d>2.1){
    p.input.x=clamp(dx*.55-dz*.28*p.aiStrafe,-1,1);
    p.input.z=clamp(dz*.55+dx*.28*p.aiStrafe,-1,1);
    p.sprint=d>5;
  }else{
    p.input.x=-dz*p.aiStrafe;
    p.input.z=dx*p.aiStrafe;
    p.sprint=false;
  }

  p.attack=d<2.3&&Date.now()>p.aiNext;
  p.block=d<1.7&&Math.random()<.25;

  if(p.attack)p.aiNext=Date.now()+850;
}

function processAction(r,p,enemy){
  const now=Date.now();

  if(
    p.attack &&
    now-p.lastAttack>650 &&
    enemy && enemy.alive &&
    dist(p,enemy)<2.25
  ){
    p.lastAttack=now;

    if(enemy.block){
      say(r,'對方擋住了攻擊！');
    }else if(enemy.invulnerableUntil>now){
      say(r,'對方以身法閃過攻擊！');
    }else{
      const dmg=p.inventory.dagger>0
        ?25
        :(p.role==='hai'?17:11);

      enemy.hp=Math.max(0,enemy.hp-dmg);
      enemy.invulnerableUntil=now+220;

      say(r,
        (p.role==='wei'?'韋小寶':'海大富')+
        '命中，造成 '+dmg+' 點傷害！'
      );

      if(enemy.hp<=0){
        enemy.alive=false;
        r.winner=p.role;
        say(r,(p.role==='wei'?'韋小寶':'海大富')+'獲勝！');
      }
    }

    p.attack=false;
  }

  if(p.useItem&&now-p.lastItem>500){
    const item=p.useItem;
    p.useItem=null;
    p.lastItem=now;

    if(p.inventory[item]>0){
      p.inventory[item]--;

      if(item==='lime'&&enemy&&dist(p,enemy)<6){
        enemy.effect='石灰粉';
        enemy.effectUntil=now+2200;
        say(r,'石灰粉命中，對手短暫失去視野！');
      }else if(item==='dart'&&enemy&&dist(p,enemy)<9){
        enemy.hp=Math.max(0,enemy.hp-12);
        say(r,'飛鏢命中，造成 12 點傷害！');

        if(enemy.hp<=0){
          enemy.alive=false;
          r.winner=p.role;
          say(r,'對手倒下，對決結束！');
        }
      }else if(item==='smoke'){
        p.invulnerableUntil=now+1600;
        say(r,'迷煙散開，趁亂移動！');
      }else if(item==='robe'){
        p.invulnerableUntil=now+2500;
        say(r,'寶衣擋下了接下來的傷害！');
      }else if(item==='dagger'){
        say(r,'玄鐵匕首已備妥，近身攻擊更強！');
      }else{
        say(r,'道具使用了，但沒有命中目標。');
      }
    }
  }
}

setInterval(()=>{
  const dt=.05;

  for(const r of rooms.values()){
    if(!r.started||r.winner)continue;

    const active=r.players.filter(p=>p.alive);
    if(active.length<2)continue;

    for(const p of r.players){
      const enemy=r.players.find(q=>q.id!==p.id);
      aiControl(r,p,enemy);
      movePlayer(p,dt);
      processAction(r,p,enemy);
    }

    for(const p of r.players){
      for(const item of r.items){
        if(item.active&&dist(p,item)<1.15){
          item.active=false;
          p.inventory[item.type]=(p.inventory[item.type]||0)+1;
          say(r,
            (p.role==='wei'?'韋小寶':'海大富')+
            '取得'+item.label+'！'
          );
        }
      }
    }

    io.to(r.id).emit('state',publicState(r));
  }
},50);

app.get('/health',(req,res)=>{
  res.json({ok:true,service:'紫禁城對決'});
});

app.get('/',(req,res)=>res.type('html').send(HTML));

io.on('connection',socket=>{
  socket.on('joinGame',data=>joinGame(socket,data||{}));

  socket.on('input',data=>{
    const r=rooms.get(socket.data.roomId);
    if(!r)return;

    const p=r.players.find(q=>q.id===socket.id);
    if(!p)return;

    p.input={
      x:clamp(Number(data.x)||0,-1,1),
      z:clamp(Number(data.z)||0,-1,1)
    };

    p.sprint=!!data.sprint;
    p.attack=!!data.attack;
    p.block=!!data.block;
    p.jump=!!data.jump;

    if(data.useItem)p.useItem=data.useItem;
  });

  socket.on('disconnect',()=>leaveGame(socket));
});

const HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>韋小寶：紫禁城對決</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#090d16;color:#fff;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif}
canvas{display:block;width:100%;height:100%;touch-action:none}
#game{position:fixed;inset:0}
#menu{position:fixed;z-index:5;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,#28354b 0,#0b101a 70%);padding:20px}
#panel{width:min(520px,100%);border:1px solid #bda56c;border-radius:18px;background:#101722ee;padding:24px;box-shadow:0 20px 80px #0009;text-align:center}
h1{margin:0 0 8px;font-size:clamp(26px,6vw,42px);color:#e8d29a}
p{color:#d0d5de;line-height:1.6}
.choices{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:14px 0}
.choice,button{border:1px solid #9e895b;border-radius:10px;background:#293548;color:white;padding:11px 15px;font-weight:700;font-size:15px}
.choice.selected{background:#8c6e35;color:#fff4d1}
#start{width:100%;background:#9b7435;border:0;padding:14px;font-size:17px}
#status{font-size:13px;min-height:20px;color:#e9cf8e}
#hud{display:none;position:fixed;inset:0;pointer-events:none;z-index:2;text-shadow:0 2px 4px #000}
#top{position:absolute;left:12px;right:12px;top:12px;display:flex;justify-content:space-between;gap:12px}
.card{background:#111827c9;border:1px solid #ffffff30;border-radius:12px;padding:9px 12px;min-width:120px}
.name{font-size:13px;color:#e8d29a}
.bar{height:9px;background:#542d35;border-radius:8px;overflow:hidden;margin:5px 0}
.fill{height:100%;width:100%;background:#e64d59;transition:width .15s}
.stamina{background:#2d654f}
.small{font-size:12px;color:#e5e7eb}
#message{position:absolute;top:95px;left:50%;transform:translateX(-50%);background:#111827b8;border-radius:8px;padding:7px 12px;font-size:13px;white-space:nowrap;max-width:92%;overflow:hidden}
#feed{position:absolute;left:12px;top:140px;font-size:12px;line-height:1.7;max-width:65%;color:#ffe7b1}
#controls{position:absolute;inset:auto 12px 14px;display:flex;align-items:end;justify-content:space-between;pointer-events:auto}
.pad{display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(2,48px);gap:5px}
.ctl{background:#152033c9;border:1px solid #ffffff50;border-radius:13px;display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;min-width:45px;min-height:44px}
.pad .up{grid-column:2}
.pad .left{grid-column:1;grid-row:2}
.pad .down{grid-column:2;grid-row:2}
.pad .right{grid-column:3;grid-row:2}
.actions{display:grid;grid-template-columns:repeat(2,54px);gap:7px}
.actions .ctl{font-size:12px;padding:4px}
.desktopHint{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);font-size:12px;color:#fff9;white-space:nowrap}
#crosshair{position:absolute;left:50%;top:50%;width:7px;height:7px;border:1px solid #fff9;border-radius:50%;transform:translate(-50%,-50%)}
@media(min-width:800px){#controls{opacity:.75}.desktopHint{bottom:10px}}
@media(max-width:420px){.card{min-width:105px;padding:7px}.actions{grid-template-columns:repeat(2,48px)}.pad{grid-template-columns:repeat(3,43px);grid-template-rows:repeat(2,43px)}}
</style>
</head>
<body>
<div id="game"></div>
<div id="menu"><div id="panel">
<h1>韋小寶：紫禁城對決</h1>
<p>在紫禁城中周旋、收集道具，運用身法與計謀取勝。</p>
<div class="choices">
<button class="choice selected" data-mode="ai">單人挑戰 AI</button>
<button class="choice" data-mode="online">雙人連線</button>
</div>
<div class="choices">
<button class="choice selected" data-role="wei">扮演韋小寶</button>
<button class="choice" data-role="hai">扮演海大富</button>
</div>
<button id="start">進入紫禁城</button>
<p id="status">正在連線……</p>
<p class="small">電腦：WASD 移動、Shift 奔跑、空白鍵跳躍、滑鼠點擊攻擊。手機：使用畫面按鈕。</p>
</div></div>
<div id="hud">
<div id="top">
<div class="card">
<div class="name" id="myName">韋小寶</div>
<div class="bar"><div class="fill" id="myHp"></div></div>
<div class="bar"><div class="fill stamina" id="myStamina"></div></div>
<div class="small" id="myStats">HP 100 · 體力 100</div>
</div>
<div class="card" style="text-align:right">
<div class="name" id="enemyName">海大富</div>
<div class="bar"><div class="fill" id="enemyHp"></div></div>
<div class="small" id="enemyStats">等待對手</div>
</div>
</div>
<div id="message">準備開始</div>
<div id="feed"></div>
<div id="crosshair"></div>
<div id="controls">
<div class="pad">
<div class="ctl up" data-key="forward">▲</div>
<div class="ctl left" data-key="left">◀</div>
<div class="ctl down" data-key="back">▼</div>
<div class="ctl right" data-key="right">▶</div>
</div>
<div class="actions">
<div class="ctl" data-key="attack">攻擊</div>
<div class="ctl" data-key="sprint">奔跑</div>
<div class="ctl" data-key="jump">跳躍</div>
<div class="ctl" data-key="block">防禦</div>
<div class="ctl" data-item="lime">石灰粉</div>
<div class="ctl" data-item="dart">飛鏢</div>
<div class="ctl" data-item="smoke">迷煙</div>
<div class="ctl" data-item="robe">寶衣</div>
<div class="ctl" data-item="dagger">匕首</div>
</div>
</div>
<div class="desktopHint">WASD 移動 · Shift 奔跑 · Space 跳躍 · 滑鼠點擊攻擊</div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.min.js"></script>
<script>
(()=>{
'use strict';

const $=id=>document.getElementById(id);
const status=$('status');
const socket=io();

let mode='ai',role='wei',joined=false;
let scene,camera,renderer,clock,meId=null,roomState=null;
let mouseDown=false;

const keys={},touch={},meshes=new Map(),itemMeshes=new Map();
const mat={};
const obstacles=${JSON.stringify(OBSTACLES)};

function choose(){
  document.querySelectorAll('[data-mode]').forEach(b=>{
    b.onclick=()=>{
      mode=b.dataset.mode;
      document.querySelectorAll('[data-mode]')
        .forEach(x=>x.classList.toggle('selected',x===b));
    };
  });

  document.querySelectorAll('[data-role]').forEach(b=>{
    b.onclick=()=>{
      role=b.dataset.role;
      document.querySelectorAll('[data-role]')
        .forEach(x=>x.classList.toggle('selected',x===b));
    };
  });
}

function material(color,roughness=.8,metalness=0){
  return new THREE.MeshStandardMaterial({color,roughness,metalness});
}

function box(w,h,d,ma,x,y,z){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),ma);
  m.position.set(x,y,z);
  m.castShadow=true;
  m.receiveShadow=true;
  scene.add(m);
  return m;
}

function init3D(){
  if(scene)return;

  scene=new THREE.Scene();
  scene.background=new THREE.Color(0x111b2b);
  scene.fog=new THREE.Fog(0x111b2b,32,70);

  camera=new THREE.PerspectiveCamera(
    65,innerWidth/innerHeight,.1,120
  );

  renderer=new THREE.WebGLRenderer({
    antialias:true,
    alpha:false,
    powerPreference:'high-performance'
  });

  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.7));
  renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;

  $('game').appendChild(renderer.domElement);
  clock=new THREE.Clock();

  scene.add(new THREE.HemisphereLight(0xb6d3ff,0x493426,2.0));

  const sun=new THREE.DirectionalLight(0xffd9a0,2.5);
  sun.position.set(-10,20,8);
  sun.castShadow=true;
  sun.shadow.mapSize.set(1024,1024);
  scene.add(sun);

  const lantern=new THREE.PointLight(0xff9a45,25,35);
  lantern.position.set(0,5,0);
  scene.add(lantern);

  mat.ground=material(0x5a5651);
  mat.wall=material(0x5a4637);
  mat.roof=material(0x8d2925);
  mat.gold=material(0xc7a35d,.45,.35);
  mat.wood=material(0x633d2a);
  mat.screen=material(0x9a302e);
  mat.stone=material(0x6c6b70);
  mat.wei=material(0x287e9b);
  mat.hai=material(0x26252e);
  mat.skin=material(0xd7a17d);
  mat.item=material(0xf0cf69,.3,.25);

  const floor=new THREE.Mesh(
    new THREE.PlaneGeometry(38,38),mat.ground
  );
  floor.rotation.x=-Math.PI/2;
  floor.receiveShadow=true;
  scene.add(floor);

  const grid=new THREE.GridHelper(36,36,0x887d68,0x77716a);
  grid.position.y=.015;
  grid.material.transparent=true;
  grid.material.opacity=.15;
  scene.add(grid);

  box(38,4,.8,mat.wall,0,2,-18);
  box(38,4,.8,mat.wall,0,2,18);
  box(.8,4,38,mat.wall,-18,2,0);
  box(.8,4,38,mat.wall,18,2,0);

  for(const z of [-18,18]){
    box(39,.35,1.2,mat.roof,0,4.05,z);
    for(let x=-16;x<=16;x+=4)
      box(.35,1.3,.35,mat.gold,x,4.65,z);
  }

  for(const z of [-14.5,14.5]){
    box(12,3,3.2,mat.wood,0,1.5,z);
    box(13,.45,4,mat.roof,0,3.2,z);
    box(13,.2,4,mat.gold,0,3.48,z);

    for(let x=-5;x<=5;x+=2.5)
      box(.22,2.5,.22,mat.gold,x,1.25,z);
  }

  for(const o of obstacles){
    if(o.type==='pillar'){
      const col=new THREE.Mesh(
        new THREE.CylinderGeometry(.52,.62,o.h,12),mat.roof
      );
      col.position.set(o.x,o.h/2,o.z);
      col.castShadow=true;
      scene.add(col);

      const cap=new THREE.Mesh(
        new THREE.CylinderGeometry(.72,.72,.22,12),mat.gold
      );
      cap.position.set(o.x,o.h-.05,o.z);
      scene.add(cap);
    }else if(o.type==='screen'){
      box(o.w,o.h,o.d,mat.screen,o.x,o.h/2,o.z);
      box(o.w,.12,o.d+.12,mat.gold,o.x,o.h,o.z);
      box(o.w,.12,o.d+.12,mat.gold,o.x,.08,o.z);
    }else{
      box(o.w,o.h,o.d,mat.wood,o.x,o.h/2,o.z);
    }
  }

  for(const [x,z] of [
    [-14,-5],[14,-5],[-14,5],[14,5],[-5,0],[5,0]
  ]){
    box(.35,1.8,.35,mat.wood,x,.9,z);
    box(.65,.15,.65,mat.gold,x,1.85,z);

    const bulb=new THREE.Mesh(
      new THREE.SphereGeometry(.16,10,8),
      new THREE.MeshBasicMaterial({color:0xffb35a})
    );
    bulb.position.set(x,2.05,z);
    scene.add(bulb);

    const light=new THREE.PointLight(0xff9a40,3,7);
    light.position.set(x,2.1,z);
    scene.add(light);
  }

  for(let i=0;i<100;i++){
    const p=new THREE.Mesh(
      new THREE.SphereGeometry(.025,5,5),
      new THREE.MeshBasicMaterial({
        color:0xffdba0,transparent:true,opacity:.5
      })
    );
    p.position.set(
      (Math.random()-.5)*34,
      Math.random()*5,
      (Math.random()-.5)*34
    );
    scene.add(p);
  }

  window.addEventListener('resize',()=>{
    if(!renderer)return;
    camera.aspect=innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth,innerHeight);
  });

  animate();
}

function makeCharacter(p){
  const g=new THREE.Group();
  const cloth=p.role==='wei'?mat.wei:mat.hai;

  const body=new THREE.Mesh(
    new THREE.CapsuleGeometry(.38,.8,4,8),cloth
  );
  body.position.y=1.05;
  body.castShadow=true;
  g.add(body);

  const head=new THREE.Mesh(
    new THREE.SphereGeometry(.25,12,10),mat.skin
  );
  head.position.y=1.75;
  head.castShadow=true;
  g.add(head);

  const hat=new THREE.Mesh(
    new THREE.CylinderGeometry(.25,.29,.12,10),
    p.role==='hai'?mat.hai:mat.gold
  );
  hat.position.y=2;
  g.add(hat);

  for(const side of [-1,1]){
    const leg=new THREE.Mesh(
      new THREE.BoxGeometry(.18,.55,.2),mat.wood
    );
    leg.position.set(side*.16,.35,0);
    g.add(leg);

    const arm=new THREE.Mesh(
      new THREE.BoxGeometry(.17,.55,.18),cloth
    );
    arm.position.set(side*.45,1.12,0);
    g.add(arm);
  }

  const shadow=new THREE.Mesh(
    new THREE.CircleGeometry(.55,16),
    new THREE.MeshBasicMaterial({
      color:0x000000,transparent:true,opacity:.3
    })
  );
  shadow.rotation.x=-Math.PI/2;
  shadow.position.y=.03;
  g.add(shadow);

  scene.add(g);
  return g;
}

function makeItem(item){
  const colors={
    lime:0x9be34b,
    dart:0x9ca6b2,
    smoke:0x8e8eff,
    robe:0xecd18a,
    dagger:0xc8d7e7
  };

  const g=new THREE.Group();

  const orb=new THREE.Mesh(
    new THREE.OctahedronGeometry(.32),
    new THREE.MeshStandardMaterial({
      color:colors[item.type]||0xffffff,
      emissive:colors[item.type]||0xffffff,
      emissiveIntensity:.3
    })
  );
  orb.position.y=.65;
  g.add(orb);

  const ring=new THREE.Mesh(
    new THREE.TorusGeometry(.48,.035,6,20),mat.gold
  );
  ring.rotation.x=Math.PI/2;
  ring.position.y=.12;
  g.add(ring);

  g.position.set(item.x,0,item.z);
  scene.add(g);
  return g;
}

function updateScene(state){
  if(!scene)return;

  const seen=new Set();

  for(const p of state.players){
    seen.add(p.id);

    let g=meshes.get(p.id);
    if(!g){
      g=makeCharacter(p);
      meshes.set(p.id,g);
    }

    g.visible=p.alive;
    g.position.set(p.x,p.y||0,p.z);
    g.rotation.y=p.yaw||0;
    g.scale.y=p.wallRunUntil>Date.now()?1.12:1;
  }

  for(const [id,g] of meshes){
    if(!seen.has(id)){
      scene.remove(g);
      meshes.delete(id);
    }
  }

  const itemSeen=new Set();

  for(const it of state.items){
    itemSeen.add(it.id);

    let g=itemMeshes.get(it.id);
    if(!g){
      g=makeItem(it);
      itemMeshes.set(it.id,g);
    }

    g.visible=it.active;
    g.rotation.y+=.025;
    g.position.y=Math.sin(Date.now()*.002+it.x)*.08;
  }

  for(const [id,g] of itemMeshes){
    if(!itemSeen.has(id)){
      scene.remove(g);
      itemMeshes.delete(id);
    }
  }
}

function updateHUD(state){
  const me=state.players.find(p=>p.id===meId);
  const enemy=state.players.find(p=>p.id!==meId);
  if(!me)return;

  $('myName').textContent=me.role==='wei'?'韋小寶':'海大富';
  $('enemyName').textContent=enemy
    ?(enemy.role==='wei'?'韋小寶':'海大富')
    :'等待對手';

  $('myHp').style.width=(me.hp/me.maxHp*100)+'%';
  $('myStamina').style.width=(me.stamina/100*100)+'%';
  $('myStats').textContent=
    'HP '+me.hp+'/'+me.maxHp+' · 體力 '+Math.round(me.stamina);

  $('enemyHp').style.width=enemy
    ?(enemy.hp/enemy.maxHp*100)+'%'
    :'0%';

  $('enemyStats').textContent=enemy
    ?'HP '+enemy.hp+'/'+enemy.maxHp
    :(state.mode==='online'?'等待對手加入':'');

  $('message').textContent=state.winner
    ?(state.winner===me.role?'你贏了！':'你輸了！')
    :(state.started?'尋找機會，活用道具！':'等待對手加入……');

  $('feed').innerHTML=state.log.slice(-4)
    .map(x=>'• '+escapeHtml(x)).join('<br>');

  if(me.effect)$('message').textContent=me.effect+'！';
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

function animate(){
  requestAnimationFrame(animate);
  if(!renderer||!scene)return;

  const dt=Math.min(clock.getDelta(),.05);

  if(roomState){
    const me=roomState.players.find(p=>p.id===meId);

    if(me){
      const target=new THREE.Vector3(me.x,1.2+me.y,me.z);
      const forward=new THREE.Vector3(
        Math.sin(me.yaw||0),0,Math.cos(me.yaw||0)
      );

      const desired=target.clone()
        .add(forward.clone().multiplyScalar(-5.8))
        .add(new THREE.Vector3(0,3.1,0));

      camera.position.lerp(
        desired,1-Math.exp(-5*dt)
      );

      camera.lookAt(target.x,target.y+.35,target.z);
    }

    updateScene(roomState);
  }

  renderer.render(scene,camera);
}

function inputNow(){
  let x=0,z=0;

  if(keys.KeyA||keys.ArrowLeft||touch.left)x-=1;
  if(keys.KeyD||keys.ArrowRight||touch.right)x+=1;
  if(keys.KeyW||keys.ArrowUp||touch.forward)z-=1;
  if(keys.KeyS||keys.ArrowDown||touch.back)z+=1;

  const len=Math.hypot(x,z);
  if(len>1){x/=len;z/=len;}

  return {
    x,z,
    sprint:!!(keys.ShiftLeft||touch.sprint),
    attack:mouseDown||!!touch.attack,
    block:!!(keys.KeyQ||touch.block),
    jump:!!(keys.Space||touch.jump)
  };
}

function bindControls(){
  window.addEventListener('keydown',e=>{
    keys[e.code]=true;
    if([
      'Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'
    ].includes(e.code))e.preventDefault();
  });

  window.addEventListener('keyup',e=>keys[e.code]=false);

  renderer.domElement.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse')mouseDown=true;
  });

  window.addEventListener('pointerup',()=>mouseDown=false);

  document.querySelectorAll('[data-key]').forEach(el=>{
    const k=el.dataset.key;

    const on=e=>{
      e.preventDefault();
      touch[k]=true;
    };

    const off=e=>{
      e.preventDefault();
      touch[k]=false;
    };

    el.addEventListener('pointerdown',on);
    el.addEventListener('pointerup',off);
    el.addEventListener('pointercancel',off);
    el.addEventListener('pointerleave',off);
  });

  document.querySelectorAll('[data-item]').forEach(el=>{
    el.addEventListener('pointerdown',e=>{
      e.preventDefault();
      if(socket.connected){
        socket.emit('input',{
          ...inputNow(),
          useItem:el.dataset.item
        });
      }
    });
  });

  setInterval(()=>{
    if(joined&&socket.connected)
      socket.emit('input',inputNow());
  },50);
}

choose();

socket.on('connect',()=>{
  status.textContent='連線成功，可以進入遊戲。';
});

socket.on('connect_error',()=>{
  status.textContent='伺服器連線失敗，請重新整理。';
});

socket.on('joined',d=>{
  meId=d.id;
  role=d.role;
  joined=true;
  status.textContent='已加入對決。';
});

socket.on('state',s=>{
  roomState=s;
  updateHUD(s);
});

$('start').addEventListener('click',()=>{
  try{
    if(!window.THREE){
      status.textContent='3D 引擎尚未載入，請確認網路後重新整理。';
      return;
    }

    init3D();
    bindControls();

    $('menu').style.display='none';
    $('hud').style.display='block';

    socket.emit('joinGame',{mode,role});
  }catch(e){
    console.error(e);
    status.textContent='3D 初始化失敗：'+e.message;
  }
});

})();
</script>
</body>
</html>`;

server.listen(PORT,'0.0.0.0',()=>{
  console.log('紫禁城對決已啟動，port='+PORT);
});
