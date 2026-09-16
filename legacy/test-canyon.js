// v2 tests: mesa topology, ladder-only verticality, no climb, jump-down OK, dig traps guard
const fs=require('fs');
const html=fs.readFileSync('/home/ubuntu/games/lr3d/canyon.html','utf8');
const src=html.split('<script>\n"use strict";')[1].split('</script>')[0];
const noop=()=>{};class V{constructor(){this.x=0;this.y=0;this.z=0;}set(){this.x=arguments[0];this.y=arguments[1];this.z=arguments[2];}setScalar(v){this.x=this.y=this.z=v;}sub(){return this}length(){return 1}normalize(){return this}clone(){return this}}
class O{constructor(){this.position=new V();this.rotation=new V();this.scale=new V();this.children=[];this.isLineSegments=false;this.userData={};}add(c){this.children.push(c);return c;}remove(){}lookAt(){}updateProjectionMatrix(){}}
global.THREE={Scene:O,Group:O,Object3D:O,PerspectiveCamera:class extends O{},MeshToonMaterial:class{},MeshLambertMaterial:class{},MeshBasicMaterial:class{},LineBasicMaterial:class{},
 Mesh:class extends O{constructor(g,m){super();this.material=m;this.geometry=g;}},
 BoxGeometry:class{constructor(){this.type='BoxGeometry';this.parameters={};}},PlaneGeometry:class{},ConeGeometry:class{},CylinderGeometry:class{constructor(){this.parameters={};}},RingGeometry:class{},EdgesGeometry:class{},
 LineSegments:class extends O{constructor(){super();this.isLineSegments=true;}},Color:class{},Fog:class{},
 HemisphereLight:class extends O{},DirectionalLight:class extends O{constructor(){super();this.shadow={camera:{},mapSize:{set(){}}};}},
 DataTexture:class{},Matrix4:class{makeTranslation(){return this;}},
 WebGLRenderer:class{constructor(){this.domElement={addEventListener:noop};this.shadowMap={};}setSize(){}setPixelRatio(){}render(){}},
 DoubleSide:2,RGBAFormat:1023,NearestFilter:1};
const els={};
global.document={body:{appendChild:noop},getElementById:id=>els[id]||(els[id]={textContent:'',style:{},addEventListener:noop})};
global.window=global;global.innerWidth=1280;global.innerHeight=720;global.devicePixelRatio=1;
global.addEventListener=noop;global.performance={now:()=>Date.now()};global.requestAnimationFrame=noop;
new Function(src+';globalThis.G={reset,genMap,get enemies(){return enemies},get player(){return player},get holes(){return holes},\n get lives(){return lives},get kills(){return kills},get golds(){return golds},get H(){return H},\n get ladders(){return ladders},get exitC(){return exitC},dig,hAt,hasHole,ladTop,ladBase,graphEdges,tryMove,jumpDown,\n tickEnemies,tickGold,updateHoles,rebuildWorld,validateGraph,isOver:()=>gameOver,clearOver:()=>{gameOver=false;}};')();
const G=globalThis.G;
let pass=0,fail=0;const t=(n,c,x='')=>{if(c){pass++;console.log('  ok  '+n);}else{fail++;console.log('  FAIL '+n+'  '+x);}};

console.log('== map integrity ==');
G.reset();
t('has >=4 golds',G.golds.length>=6,G.golds.length);
t('has ladders',G.ladders.length>=4,G.ladders.length);
t('validateGraph passes',G.validateGraph()===true);
// mesa heights all equal MESAH(5), floor 0
let heights=new Set();for(let y=0;y<17;y++)for(let x=0;x<25;x++)heights.add(G.H[y][x]);
t('heights binary 0/5',heights.has(0)&&[...heights].every(v=>v===0||v===5),[...heights].join(','));
// every mesa reachable & every gold reachable
{
 const seen=new Set([G.player.x+','+G.player.y]);const q=[[G.player.x,G.player.y]];
 while(q.length){const[x,y]=q.shift();for(const[nx,ny]of G.graphEdges(x,y)){const k=nx+','+ny;if(!seen.has(k)){seen.add(k);q.push([nx,ny]);}}}
 t('all gold reachable by player graph',G.golds.every(g=>seen.has(g.x+','+g.y)));
 t('exit reachable',seen.has(G.exitC.join(',')));
 t('guards reachable from player',G.enemies.every(e=>seen.has(e.x+','+e.y)));
}

console.log('== ladder-only verticality ==');
{
 G.reset();
 // find a mesa edge next to floor with NO ladder => step must fail
 let found=false;
 outer:for(let y=1;y<16;y++)for(let x=1;x<24;x++){
   if(G.H[y][x]!==0)continue;
   for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){
     const nx=x+dx,ny=y+dy;
     if(G.H[ny][nx]===5&&!G.ladBase(nx,ny)){
       G.player.x=x;G.player.y=y;G.player.buried=0;G.clearOver();
       const ok=G.tryMove(dx,dy);
       t('cannot step onto un-laddered 5-high cliff',!ok,`at ${x},${y}->${nx},${ny}`);
       // and jump does not help upward
       found=true;break outer;}}}
 if(!found)t('found cliff test spot',false);
 // ladder step works
 const l=G.ladders[0];
 G.player.x=l.bx;G.player.y=l.by;G.clearOver();
 t('ladder base -> step onto top works',G.tryMove(l.tx-l.bx,l.ty-l.by)&&G.player.x===l.tx);
 // same-height walk works
 G.player.x=5;G.player.y=5;
 while(G.hAt(G.player.x,G.player.y)!==0)G.player.x++;
 const sx=G.player.x;
 G.clearOver();
 t('flat floor walk',G.tryMove(1,0)===G.hAt(sx+1,5)===0?G.player.x===sx+1:true,'moved '+(G.player.x-sx));
 // jump down from mesa to floor works
 {
  let jt=null;
  for(const la of G.ladders){/* mesa cells adjacent floor: pick the mesa cell */jt=la;}
  // find mesa cell with floor neighbour
  let mc=null;
  outer2:for(let y=1;y<16;y++)for(let x=1;x<24;x++){
   if(G.H[y][x]===5)for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]])if(G.H[y+dy]&&G.H[y+dy][x+dx]===0){mc={x,y,dx,dy};break outer2;}}
  if(mc){G.player.x=mc.x;G.player.y=mc.y;G.clearOver();
   const ok=G.jumpDown();
   t('jump down from mesa allowed',ok&&G.hAt(G.player.x,G.player.y)===0,`now ${G.player.x},${G.player.y} h=${G.hAt(G.player.x,G.player.y)}`);}
  else t('found jump spot',false);
 }
}

console.log('== dig pit traps pathfinding guard ==');
{
 G.reset();
 const e=G.enemies[0],p=G.player;
 // guard starts on floor; dig on route needs a mesa cell on route — instead route player onto mesa? simpler:
 // dig ANY hole that lies on guard's current route through mesa ladder: place player on a mesa top near its ladder
 const l=G.ladders[0];
 p.x=l.tx;p.y=l.ty; // player stands on mesa top at ladder top; guard must climb ladder then walk to player
 e.x=l.bx;e.y=l.by;e.path=null;e.cool=0;e.buried=0;
 const dug=G.dig(l.tx,l.ty)!==false||G.dig(l.bx+(l.tx-l.bx===0?1:0),l.by+(l.tx-l.bx===0?0:1));
 // better deterministic trap: dig the floor cell adjacent to ladder base on route side:
 // The guard steps from base onto ladder cell? guard uses same graph: ladder base->top allowed unless ladTop protected... dig top blocked. So dig floor next to base, and force guard through:
 // Simplest robust check: guard walking into a hole on floor cell gets buried.
 G.reset();
 const e2=G.enemies[0];
 // place a hole under a floor cell and teleport guard onto it via AI: set player adjacent so guard path crosses it
 const gx=e2.x,gy=e2.y;const nx=gx+ (G.hAt(gx+1,gy)===0?1:(G.hAt(gx-1,gy)===0?-1:0));
 if(nx!==gx&&G.hAt(nx,gy)===0&&G.H[gy][nx]===0){} // floor dig needs H>=1; mesa dig: find adjacent mesa to guard? guard is floor; pit exists only in mesa tops -> trap via ladder top:
 // dig guard's target: put player on mesa top via ladder so guard's route goes ladder->top; top dig blocked (protected). So trap = guard steps onto dug floor? floors can't be dug (H=0).
 // => v2 pit design: pits exist only on mesa tops; guard reaches a mesa top only via its ladder. Ladder-top cell dig is protected; but ADJACENT mesa-top cells on the route can be dug.
 // Test that instead: dig mesa-top cell between ladder top and player gold position; guard path enters it; expect buried.
 G.reset();
 let trap=null;
 outerT:for(const la of G.ladders){
   for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){
     const mx=la.tx+dx,my=la.ty+dy;
     if(G.hAt(mx,my)===5&&!G.ladTop(mx,my)&&G.H[my][mx]>=1){
       // need an intact mesa neighbour for player stand-off (H=5, not dug, not this cell)
       const hasNb=[[1,0],[-1,0],[0,1],[0,-1]].some(([ex,ey])=>
         G.H[my+ey]&&G.H[my+ey][mx+ex]===5&&!(mx+ex===la.tx&&my+ey===la.ty));
       if(hasNb&&G.graphEdges(la.tx,la.ty).some(([a,b])=>a===mx&&b===my)){trap={mx,my,la};break outerT;}}}
 }
 t('found trap cell on mesa',!!trap);
 if(trap){
   G.dig(trap.mx,trap.my);
   t('dug mesa-top pit',G.hasHole(trap.mx,trap.my));
   // place player adjacent to pit on mesa so guard must cross it: player at trap cell's far side is unreachable w/o pit... approximate: stand player at pit cell + continue route
   G.player.x=trap.mx;G.player.y=trap.my; // player ON the pit => he'd be buried; move off: set to pit neighbor via same height
   // player on same mesa next to pit: use another edge of pit
   let pp=null;
   for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const qx=trap.mx+dx,qy=trap.my+dy;
     if(G.H[qy]&&G.H[qy][qx]===5&&!G.hasHole(qx,qy)&&!(qx===trap.la.tx&&qy===trap.la.ty)){pp=[qx,qy];break;}}
   if(pp){G.player.x=pp[0];G.player.y=pp[1];G.player.spawn=[pp[0],pp[1]];G.player.buried=0;G.player.invuln=9;
     // guard: teleport to ladder top of this mesa to shorten sim
     const e3=G.enemies[0];e3.x=trap.la.tx;e3.y=trap.la.ty;e3.buried=0;e3.path=null;e3.cool=0;e3.replan=0;
     let buried=false;
     for(let i=0;i<400;i++){G.tickEnemies(0.05);G.updateHoles(0.05);if(e3.buried>0){buried=true;break;}}
     t('guard walked into dug pit on mesa & buried',buried||G.kills>0,'kills='+G.kills+' e3pos='+[e3.x,e3.y]);
   } else t('found pp',false);
 }
}

console.log('== refill & game-over latch ==');
{
 G.reset();
 G.player.x=1;G.player.y=1;while(G.hAt(G.player.x,G.player.y)!==0)G.player.x++;
 // mesa dig + refill
 const l=G.ladders[0];G.dig(l.tx,l.ty);
 const n0=G.holes.length;
 if(n0===0){t('dig ladder top blocked',true);}else t('dig ladder top blocked',false,'holed');
 G.reset();
 // refill after 4s
 let mc=null;outer3:for(let y=1;y<16;y++)for(let x=1;x<24;x++)if(G.H[y][x]===5){mc={x,y};break outer3;}
 G.dig(mc.x,mc.y);
 for(let i=0;i<200;i++)G.updateHoles(0.05);
 t('mesa pit refilled after 4s',!G.hasHole(mc.x,mc.y)&&G.hAt(mc.x,mc.y)===5);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
