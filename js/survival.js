// 生存模式 —— 陨石、护盾、指向射击
//
// 舞台（planet.js）只提供两件事：撞击光斑（stage.impact）与深度登记（trackDepth / overlay）。
// 其余全部在这里：石头的运动、命中、停留瞄准、温度/气压模型、判词里的那一行分数。
// 不加灯光——全场没有 THREE 灯，材质一律拿 uLightDir 自己算 Lambert，和行星、地幔、内核同一套做法。
// 石头和护盾是不透明的，走 trackDepth；光束与碎屑是叠加的，走 overlay。漏登记一个，景深就错一片。

import * as THREE from 'three';
import { NOISE } from './planet.js';
import { tierOf, TIER_EN } from './board.js';

/* ── 节奏 ── */
const MAX_ROCKS  = 64;                  // InstancedMesh 容量。同屏很少超过 8，64 是零成本的余量
const SPAWN_R    = 2.8;                 // 16:9 下画面半宽 2.58：从画外一点点进来；固定半径 ⇒ 落地时间一致
/* 难度按分定档（分只来自陨石）：起步慢；125 分（二十五颗）快一点；200 分（四十颗）再快；
   往后每 100 分再加一成。时间再乘一层：半分钟、一分钟各快一档——只拦不打的人也躲不过钟表。
   两层相乘后封顶。目标值用 τ=4s 逼近，换档读作「快了一点」而不是跳变；已经在飞的石头不改速。 */
const STAGES = [
  { at:0,   v:0.32, iv:1.9, dbl:0.00 },
  { at:125, v:0.42, iv:1.4, dbl:0.15 },
  { at:200, v:0.55, iv:1.0, dbl:0.35 }
];
const TIME_STEPS = [ { at:30, k:1.15 }, { at:60, k:1.30 } ];    // k = 速度倍率，间隔除以 k；两颗一起的概率只看分
const STAGE_STEP = 100, STAGE_GAIN = 0.10, V_CAP = 0.8, IV_FLOOR = 0.7, DBL_CAP = 0.5;
const STAGE_TAU  = 4;
const SPAWN_JIT  = 0.35;                // 间隔 ±35%：去掉节拍器感
const V_JIT      = 0.15;
const G          = 0.12;                // 向心常加速度（单位/秒²）：偏心路径弯成弧、慢石头越落越快；真万有引力在 2.8 处几乎为零、贴地又爆掉
const AIM_SPREAD = 0.75;                // 目标点取盘面内半径 0.75 的圆盘：必中（<1），又不是每颗都直奔球心
const R_MIN = 0.05, R_MAX = 0.13;       // 屏幕直径约 37→97 px @1080p：够指、不遮
/* ── 温度 / 气压 ── */
const HEAT_BASE = 6, HEAT_K = 3600;     // ΔT = 6 + 3600·r²：9K…67K。用 r³ 小石头就等于没砸
const COOL       = 5;                   // K/s。晚期七成击落率下热流入约 15K/s：饱和后一分钟内结束
const T0 = 288, T_LIMIT = 640;          // 640：熔融（620→900）刚起、hot3 已播——挤压落在一颗正在开裂的星上
export const T_WARN = 560, T_CRIT = 610;  // 再挨两下 / 再挨一下：屏幕正中要喊
const P_PER_PLATE = 0.5;                // 两块 → 宜居 0.61，七块 → 0.10。代价要疼，才是决策
/* ── 护盾 ── */
const PLATE_HP = 2, PLATE_W = 0.42, PLATE_H = 0.28, PLATE_T = 0.02, PLATE_MAX = 8;   // 一块挡两颗；满 8 块时新的顶掉最旧的
const PLATE_LIFE = 7, PLATE_FADE = 1.0;  // 秒。盾只活 7 秒，最后 1 秒渐隐——它是临时的东西，不是城墙
const PLATE_RMIN = 1.35, PLATE_RMAX = 2.3;   // 下限在大气壳（1.14）外留余量；上限在画内且在生成环内——石头到盾前已可见
const PLATE_TILT = 0.6;                 // 弧度。盾面从「正对镜头」向「径向外」倾 35°：既看得见面，又迎着来石
/* ── 停留 ── */
const DWELL_FIRE = 0, DWELL_SHIELD = 0.5;       // 射击不停留：指到就打；护盾要停住——✌️ 一直比着，每 0.5s 落一块
const DWELL_GAP  = 0.08;                // 分类器抖一帧、石头翻滚时擦出命中圈：这么久以内算没离开
const DWELL_DECAY = 2.5;                // 进度环退回去的速度，不是瞬间清零
/* 护盾的空档比射击宽：✌️ 的分数在迟滞带里抖一下、摄像头卡一帧，都只暂停进度环，不放掉。
   进度只在确认是 ✌️ 的帧里长，所以划过去的手仍然放不下盾。 */
const SHIELD_GAP = 0.25, SHIELD_DECAY = 1.2;
const FIRE_COOL  = 0.12;                // 两发之间的最短间隔：光束先落地，准星再找下一颗；扫过一片也不会一帧全清
const AIM_STALE  = 0.25;                // 秒。摄像头掉帧超过这么久视为无手
const HIT_PX_MIN = 46, HIT_PX_K = 2.6, HIT_PX_PAD = 22;   // 命中圈 = max(46, 投影半径×2.6 + 22) px：手比鼠标抖，圈要宽
/* ── 击碎。石头不是消失，是碎成一把发红的渣：碎片走同一套实例渲染，快速翻滚、飞散、缩小、冷却 ── */
const SHARD_N0 = 7, SHARD_NK = 30;      // 碎片数 = 7 + 30·r
const SHARD_LIFE = [0.35, 0.6];
/* ── 计分。只算陨石：击落一颗 5，护盾拦下一颗 2；时间不给分。自己结束（握拳 / 摊掌）+20 = 四颗；
   行星先你一步死去分照算，只是没有这 +20 ── */
const KILL_POINTS = 5, BLOCK_POINTS = 2, SELF_BONUS = 4 * KILL_POINTS;
/* ── 特效 ── */
const ENTRY_R0 = 1.7, ENTRY_R1 = 1.05;  // 进入辉光从 1.7 半径起烧，到贴地烧满
const BEAM_LIFE = 0.18, BEAM_W = 0.035, BEAM_POOL = 3;
const BURST_N = 256, BURST_PER = 20;    // 环形缓冲：十几团同时在场绰绰有余
const HOT  = new THREE.Color(1.0, 0.45, 0.15).multiplyScalar(2.2);
const COLD = new THREE.Color(1.1, 1.40, 1.90).multiplyScalar(1.2);

/* 他们的视角：临床、简短、看不见那只手。走 civ.say，同一条冷却、同一个「每个样本只说一次」。 */
const SAY = {
  sv_sight:      'Uncatalogued bodies in near space. Observatories file them as a periodic meteor stream. No warning issued.',
  sv_first_hit:  'Surface impact. The shockwave circles the planet. They attribute it to tectonics.',
  sv_beam:       'A light falls from the zenith; a falling rock turns to dust mid-air. They have no word for that light.',
  sv_plate:      'A plane that should not exist appears in orbit. Pressure rises with it: it is holding the atmosphere down.',
  sv_plate_lost: 'The plane shattered. They logged the fragments\' trajectories and never mentioned it again.',
  sv_kills5:     'Five bodies in a row break up at the same altitude. Someone points out that this is not chance.',
  sv_hot:        'Impacts come too fast to count. Shelter places are now assigned by lottery.',
  sv_late:       'The lights overhead thicken. They have started calling it the Observer\'s War.'
};

const clamp01 = v => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const rnd = (a, b) => a + Math.random() * (b - a);
function randomUnit(out = new THREE.Vector3()){
  const z = rnd(-1, 1), t = rnd(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(t), r * Math.sin(t), z);
}

/* CPU 侧的值噪声，只用来给石头顶点做一次位移。与 planet.js 的 _hash1 同一族。 */
function hash3(x, y, z){
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, z){
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
  const x00 = lerp(c(0,0,0), c(1,0,0), u), x10 = lerp(c(0,1,0), c(1,1,0), u);
  const x01 = lerp(c(0,0,1), c(1,0,1), u), x11 = lerp(c(0,1,1), c(1,1,1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

/* ── 着色器 ── */
const ROCK_VERT = `
attribute float aHeat;
attribute float aSeed;
varying vec3 vN, vW, vObj;
varying float vHeat, vSeed;
void main(){
  vec4 p = instanceMatrix * vec4(position, 1.0);
  vec4 w = modelMatrix * p;
  vW = w.xyz;
  // 非均匀缩放很轻（0.8~1.15）：法线直接过旋转缩放再归一，省一次逆转置，误差看不出来
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vObj = position; vHeat = aHeat; vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const ROCK_FRAG = `
precision highp float;
uniform vec3 uLightDir;
varying vec3 vN, vW, vObj;
varying float vHeat, vSeed;
${NOISE}
void main(){
  vec3 N = normalize(vN), L = normalize(uLightDir), V = normalize(cameraPosition - vW);
  float d = fbm3(vObj * 3.1 + vSeed * 17.3) * 0.5 + 0.5;
  vec3 rock = mix(vec3(0.085, 0.072, 0.064), vec3(0.24, 0.20, 0.17), d);   // 反照率 <0.3，远在 bloom 阈值下
  float ndl = max(dot(N, L), 0.0);
  vec3 lit = rock * (0.045 + 1.15 * ndl);                                  // 夜面留一点天光，别成剪影
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  lit += vec3(0.05, 0.08, 0.14) * rim * 0.6;                               // 冷蓝边缘：观测者世界的环境光
  // 进入大气：朝行星那一面先烧起来（那就是迎风面，不必传速度）
  float lead = smoothstep(-0.25, 0.75, dot(N, normalize(-vW)));
  float h = vHeat * vHeat;
  lit += mix(vec3(1.0, 0.30, 0.06), vec3(1.0, 0.72, 0.40), h) * lead * h * 2.8;   // >1.1 交给 bloom
  gl_FragColor = vec4(lit, 1.0);
}
`;

const PLATE_VERT = `
varying vec2 vUv;
varying vec3 vN, vW;
void main(){
  vUv = uv;
  vW = (modelMatrix * vec4(position, 1.0)).xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;
const PLATE_FRAG = `
precision highp float;
uniform vec3 uLightDir;
uniform float uHP, uBorn, uDie, uTime, uSeed;
varying vec2 vUv;
varying vec3 vN, vW;
${NOISE}
void main(){
  vec3 N = normalize(vN); if(!gl_FrontFacing) N = -N;
  vec3 L = normalize(uLightDir), V = normalize(cameraPosition - vW);
  float edge = 1.0 - smoothstep(0.0, 0.05, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
  float ndl = abs(dot(N, L));                                     // 薄片两面受光
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);
  vec3 body = vec3(0.12, 0.30, 0.56) * (0.25 + 0.75 * ndl) + vec3(0.20, 0.42, 0.70) * fres * 0.5;
  // 裂纹只在 HP 掉到 1 后出现。不发光：那是缺损，不是能量
  float cr = pow(clamp(1.0 - abs(fbm3(vec3(vUv * 6.0, uSeed))) * 7.0, 0.0, 1.0), 2.0) * step(uHP, 1.5);
  body = mix(body, vec3(0.55, 0.62, 0.70), cr * 0.8);
  float born = smoothstep(0.0, 0.25, uTime - uBorn);              // 生成那一下边框闪亮
  vec3 col = body + vec3(0.30, 0.62, 1.15) * edge * (2.0 + 2.5 * (1.0 - born));   // 边框 >1.1 交给 bloom；冷蓝属于观测者
  float a = (0.55 + 0.45 * edge) * mix(0.75, 1.0, uHP * 0.5);
  float fade = 1.0 - smoothstep(uDie - ${PLATE_FADE.toFixed(2)}, uDie, uTime);   // 到寿的最后一秒渐隐
  gl_FragColor = vec4(col * mix(0.6, 1.0, fade), a * fade);
}
`;

const BEAM_VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const BEAM_FRAG = `
precision highp float;
uniform float uK;
varying vec2 vUv;
void main(){
  float y = abs(vUv.y - 0.5) * 2.0;
  float core = pow(1.0 - y, 8.0), halo = pow(1.0 - y, 1.6) * 0.35;
  float along = mix(0.55, 1.0, vUv.x);                 // 能量落在目标那头
  // 蓝通道过 1.1、红压在 1 下：是蓝光不是白光（同箔片的理由）
  vec3 col = vec3(0.32, 0.66, 1.25) * (core * 3.2 + halo) * along;
  gl_FragColor = vec4(col * uK, (core + halo) * uK);
}
`;

const BURST_VERT = `
attribute vec3 aV;
attribute float aT0, aLife, aSize;
attribute vec3 aCol;
uniform float uTime;
varying float vK;
varying vec3 vCol;
void main(){
  float age = uTime - aT0;
  float k = clamp(age / aLife, 0.0, 1.0);
  vK = (age < 0.0 || age > aLife) ? 0.0 : 1.0 - k;
  vec3 p = position + aV * age * (1.0 - 0.4 * k);       // 抛出后减速
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = vK > 0.0 ? aSize * (1.0 - 0.6 * k) * 300.0 / -mv.z : 0.0;   // 同星空的尺寸律
  gl_Position = projectionMatrix * mv;
  vCol = aCol;
}
`;
const BURST_FRAG = `
precision highp float;
varying float vK;
varying vec3 vCol;
void main(){
  if(vK <= 0.0) discard;
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if(d > 1.0) discard;
  float a = pow(1.0 - d, 1.8) * vK;
  gl_FragColor = vec4(vCol * a, a);
}
`;

export class Survival {
  constructor({ stage, civ, onCrush }){
    this.stage = stage; this.civ = civ; this.onCrush = onCrush || (() => {});
    this.el = document.getElementById('aim');
    this.running = false;
    this.group = new THREE.Group();

    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3(); this._v4 = new THREE.Vector3();
    this._q = new THREE.Quaternion(); this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3(); this._size = new THREE.Vector2(1, 1);
    this._pr = new THREE.Vector3();

    this._buildRocks();
    this._buildPlates();
    this._buildBeams();
    this._buildBurst();

    this.rocks = []; this.plates = []; this.said = new Set(); this.pendingSay = [];
    this.shown = false; this.lastCls = '';
    this._resetRun();
  }

  /* ── 构建 ── */
  _buildRocks(){
    // 二十面体细分两次再按值噪声位移，non-indexed ⇒ 平面朝向的硬棱，石头该有的样子
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const pos = geo.attributes.position;
    for(let i = 0; i < pos.count; i++){
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const k = 1 + 0.22 * vnoise(x * 2.1 + 3.7, y * 2.1, z * 2.1) + 0.08 * vnoise(x * 5.3, y * 5.3 + 1.3, z * 5.3);
      pos.setXYZ(i, x * k, y * k, z * k);
    }
    geo.computeVertexNormals();
    this.aHeat = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ROCKS), 1).setUsage(THREE.DynamicDrawUsage);
    this.aSeed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ROCKS), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHeat', this.aHeat);
    geo.setAttribute('aSeed', this.aSeed);
    const mat = new THREE.ShaderMaterial({
      uniforms:{ uLightDir:{ value:this.stage.lightDir } },
      vertexShader:ROCK_VERT, fragmentShader:ROCK_FRAG
    });
    this.rockMesh = new THREE.InstancedMesh(geo, mat, MAX_ROCKS);
    this.rockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rockMesh.frustumCulled = false;   // 包围球只算一次，实例每帧都在动
    this.rockMesh.count = 0;
    this.group.add(this.rockMesh);
  }

  _buildPlates(){
    const geo = new THREE.PlaneGeometry(PLATE_W, PLATE_H);
    this.platePool = [];
    for(let i = 0; i < PLATE_MAX; i++){
      const mat = new THREE.ShaderMaterial({
        uniforms:{ uLightDir:{ value:this.stage.lightDir }, uHP:{ value:PLATE_HP }, uBorn:{ value:0 }, uDie:{ value:1e9 }, uTime:{ value:0 }, uSeed:{ value:0 } },
        vertexShader:PLATE_VERT, fragmentShader:PLATE_FRAG,
        transparent:true, depthWrite:false, depthTest:true, side:THREE.DoubleSide
      });
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 6; m.visible = false;
      this.platePool.push(m); this.group.add(m);
    }
  }

  _buildBeams(){
    const geo = new THREE.PlaneGeometry(1, 1);
    this.beams = [];
    for(let i = 0; i < BEAM_POOL; i++){
      const mat = new THREE.ShaderMaterial({
        uniforms:{ uK:{ value:0 } }, vertexShader:BEAM_VERT, fragmentShader:BEAM_FRAG,
        transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:true, side:THREE.DoubleSide
      });
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 11; m.visible = false; m.frustumCulled = false;
      this.beams.push({ mesh:m, a:new THREE.Vector3(), b:new THREE.Vector3(), t:BEAM_LIFE });
      this.group.add(m);
    }
  }

  _buildBurst(){
    const geo = new THREE.BufferGeometry();
    const mk = (n, size) => new THREE.BufferAttribute(new Float32Array(BURST_N * n), n).setUsage(THREE.DynamicDrawUsage);
    this.bP = mk(3); this.bV = mk(3); this.bT0 = mk(1); this.bLife = mk(1); this.bSize = mk(1); this.bCol = mk(3);
    this.bT0.array.fill(-1e9);
    geo.setAttribute('position', this.bP); geo.setAttribute('aV', this.bV);
    geo.setAttribute('aT0', this.bT0); geo.setAttribute('aLife', this.bLife);
    geo.setAttribute('aSize', this.bSize); geo.setAttribute('aCol', this.bCol);
    const mat = new THREE.ShaderMaterial({
      uniforms:{ uTime:{ value:0 } }, vertexShader:BURST_VERT, fragmentShader:BURST_FRAG,
      transparent:true, blending:THREE.AdditiveBlending, depthWrite:false
    });
    this.burst = new THREE.Points(geo, mat);
    this.burst.frustumCulled = false;
    this.burstHead = 0;
    this.group.add(this.burst);
  }

  /* ── 生命周期 ── */
  _resetRun(){
    Object.assign(this, {
      heat:0, T:T0, P:1, platesMade:0, elapsed:0, kills:0, blocks:0, impacts:0, score:0, over:false,
      t:0, fxT:0, spawnT:1.2, seq:0,
      level:0, curV:STAGES[0].v, curIv:STAGES[0].iv, curDbl:0,   // level = 难度档（this.stage 是舞台）
      cur:null, aimAt:0, target:null, dwell:0, gap:0, shieldK:0, vGap:1, fireCool:0,
      ending:null
    });
  }
  get shields(){ return this.plates.length; }

  start(){
    if(this.running) this.stop();
    this._resetRun();
    this.said.clear(); this.pendingSay.length = 0;
    this.stage.scene.add(this.group);
    this.stage.trackDepth(this.rockMesh);
    for(const m of this.platePool) this.stage.trackDepth(m, THREE.DoubleSide);   // 透明但要写深度：否则景深把 0.42 的硬边糊掉
    for(const b of this.beams) this.stage.overlay(b.mesh);
    this.stage.overlay(this.burst);
    this.bT0.array.fill(-1e9); this.bT0.needsUpdate = true;
    this.stage.renderer.compile(this.stage.scene, this.stage.camera);   // 四套新程序此刻编译，别等第一颗石头进画面才卡一下
    this.running = true;
  }

  stop(){
    this.running = false;
    this.stage.scene.remove(this.group);
    this.stage.untrack(this.rockMesh);
    for(const m of this.platePool){ this.stage.untrack(m); m.visible = false; }
    for(const b of this.beams){ this.stage.untrack(b.mesh); b.mesh.visible = false; b.t = BEAM_LIFE; }
    this.stage.untrack(this.burst);
    this.rocks.length = 0; this.plates.length = 0; this.rockMesh.count = 0;
    this.cur = null; this.target = null; this.dwell = this.shieldK = 0;
    this._crosshair(null);
  }

  /* 每个摄像头帧由 main.js 调用；x/y 为归一化视口坐标（已镜像、已加增益），pose ∈ 'point' | 'victory'。 */
  aim(x, y, pose){
    if(x === null || x === undefined){ this.cur = null; return; }
    this.cur = { x:clamp01(x), y:clamp01(y), pose };
    this.aimAt = performance.now();
  }

  /* 一局的终点。self = 你自己按下了武器（+20，四颗的分）；heat = 行星先你一步死去（分照算，没有奖励）。
     幂等：热死那条路先标记 'heat' 再走 fire()，随后 fire() 里的 finish('self') 就不作数。 */
  finish(ending){
    if(this.ending) return;
    this.ending = ending;
    if(ending === 'self') this.score += SELF_BONUS;
    this.over = true;
    this.aim(null);
  }

  get tier(){ return tierOf(this.ending || 'self', this.score); }   // 局中：假如现在收手，会是什么评级

  /* 判词：生存模式里说的是你，不是他们。三行：评级、分与战绩、怎么结束的。 */
  verdictCard(){
    const t = this.tier;
    const l1 = `RANK ${TIER_EN[t]}`;
    const l2 = `SCORE ${this.score.toLocaleString('en-US')} · HELD ${this.elapsed.toFixed(1)} s · SHOT ${this.kills} · BLOCKED ${this.blocks}`;
    const l3 = this.ending === 'heat' ? 'The planet died before you did.' : `You ended it yourself. +${SELF_BONUS}`;
    return `${l1}\n${l2}\n${l3}`;
  }
  verdictLine(){ return this.verdictCard(); }

  update(dt){
    if(!this.running) return;
    const idle = this.stage.state === 'idle';
    // 误触握拳/摊掌走的是 main.js 的 fire()：这里只会看到 state 离开 idle。分数当场定格。
    if(!this.over && (!idle || this.civ.struck)) this.over = true;
    this.fxT += dt;                         // 闪光、碎屑照常放完
    this.stage.camera.updateMatrixWorld();
    this.stage.renderer.getSize(this._size);
    if(!idle || this.over){ this._beams(dt); this._syncFx(); this._crosshair(null); return; }   // 冻结但不隐藏

    this.t += dt; this.elapsed += dt;
    this._spawnClock(dt);
    this._moveRocks(dt);
    this._agePlates();
    this._dwell(dt);
    this._beams(dt);
    this.score = this.kills * KILL_POINTS + this.blocks * BLOCK_POINTS;   // 先记分，再判生死：_cool 里的 finish() 要有最后一句话
    this._stage(dt);
    this._cool(dt);
    this._sync(dt);
    this._flavour();
  }

  /* ── 难度：按分定档 × 按时加码，目标值慢慢逼近 ── */
  _stageTarget(){
    let s = 0;
    for(let i = 0; i < STAGES.length; i++) if(this.score >= STAGES[i].at) s = i;
    const top = STAGES[STAGES.length - 1];
    const extra = s === STAGES.length - 1 ? Math.floor((this.score - top.at) / STAGE_STEP) : 0;   // 200 分之后每 100 分再加一成
    let tk = 1, ts = 0;
    for(const st of TIME_STEPS) if(this.elapsed >= st.at){ tk = st.k; ts++; }                     // 半分钟 ×1.15，一分钟 ×1.30
    const k = Math.pow(1 + STAGE_GAIN, extra) * tk;
    return { stage:s + extra + ts, v:Math.min(V_CAP, STAGES[s].v * k), iv:Math.max(IV_FLOOR, STAGES[s].iv / k),
             dbl:Math.min(DBL_CAP, STAGES[s].dbl + (extra ? 0.15 : 0)) };
  }
  _stage(dt){
    const t = this._stageTarget();
    this.level = t.stage;
    const a = 1 - Math.exp(-dt / STAGE_TAU);
    this.curV  += (t.v  - this.curV)  * a;
    this.curIv += (t.iv - this.curIv) * a;
    this.curDbl += (t.dbl - this.curDbl) * a;
  }

  /* ── 生成 ── */
  _spawnClock(dt){
    this.spawnT -= dt;
    while(this.spawnT <= 0 && this.liveRocks() < MAX_ROCKS - 12){
      this._spawn();
      if(Math.random() < this.curDbl) this._spawn();   // 高档一次两颗
      this.spawnT += this.curIv * (1 - SPAWN_JIT + 2 * SPAWN_JIT * Math.random());
    }
  }

  _spawn(){
    const cam = this.stage.camera;
    // 在过球心、垂直视轴的平面上取一个环：从画面边缘进来，也留在景深的合焦带里
    const right = this._v1.setFromMatrixColumn(cam.matrixWorld, 0);
    const up    = this._v2.setFromMatrixColumn(cam.matrixWorld, 1);
    const th = Math.random() * Math.PI * 2;
    const p = new THREE.Vector3().addScaledVector(right, Math.cos(th) * SPAWN_R).addScaledVector(up, Math.sin(th) * SPAWN_R);
    // 瞄准盘面内一点而不是球心：保证命中（0.75 < 1），路径也不全是一条条直奔中心的射线
    const ta = Math.random() * Math.PI * 2, tr = Math.sqrt(Math.random()) * AIM_SPREAD;
    const tgt = this._v3.set(0, 0, 0).addScaledVector(right, Math.cos(ta) * tr).addScaledVector(up, Math.sin(ta) * tr);
    const speed = this.curV * (1 - V_JIT + 2 * V_JIT * Math.random());
    const v = tgt.sub(p).normalize().multiplyScalar(speed);
    // 小石头多、大石头少；晚期指数往 1 走，大块变多
    const r = R_MIN + (R_MAX - R_MIN) * Math.pow(Math.random(), 1.6 - 0.15 * Math.min(3, this.level));   // 高档大块变多
    this._spawnAt(p, v, r);
    this._say('sv_sight');
  }

  liveRocks(){ let n = 0; for(const k of this.rocks) if(!k.shard) n++; return n; }

  // 调试与测试入口：在指定位置、速度、半径放一颗
  _spawnAt(p, v, r){
    const k = (r - R_MIN) / (R_MAX - R_MIN);
    this.rocks.push({
      p:new THREE.Vector3().copy(p), v:new THREE.Vector3().copy(v), r,
      sx:rnd(0.8, 1.15), sy:rnd(0.8, 1.15), sz:rnd(0.8, 1.15),
      axis:randomUnit(), rate:lerp(2.2, 0.6, k) * rnd(0.7, 1.3),   // 大块转得慢：同 planet.js 的碎片
      ang:Math.random() * 6.283, seed:Math.random() * 10, heat:0, id:++this.seq, shard:false
    });
    return this.rocks[this.rocks.length - 1];
  }

  _shatter(rock){
    const n = SHARD_N0 + Math.floor(rock.r * SHARD_NK);
    for(let i = 0; i < n; i++){
      const d = randomUnit(new THREE.Vector3());
      const p = new THREE.Vector3().copy(rock.p).addScaledVector(d, rock.r * 0.6);
      const v = new THREE.Vector3().copy(rock.v).multiplyScalar(0.35).addScaledVector(randomUnit(this._v3), rnd(0.6, 1.6));
      const r = rock.r * rnd(0.25, 0.5);
      this.rocks.push({
        p, v, r, sx:rnd(0.7, 1.3), sy:rnd(0.7, 1.3), sz:rnd(0.7, 1.3),
        axis:randomUnit(), rate:rnd(6, 14), ang:Math.random() * 6.283, seed:rock.seed + i,
        heat:1, id:++this.seq, shard:true, life:rnd(SHARD_LIFE[0], SHARD_LIFE[1]), age:0
      });
    }
  }

  /* ── 运动与命中 ── */
  _moveRocks(dt){
    const rocks = this.rocks;
    outer:
    for(let i = rocks.length - 1; i >= 0; i--){
      const rock = rocks[i];
      // 向心常加速度：常量既弯得出弧线又调得住节奏
      rock.v.addScaledVector(this._v1.copy(rock.p).normalize(), -G * dt);
      rock.p.addScaledVector(rock.v, dt);
      rock.ang += rock.rate * dt;
      if(rock.shard){                                   // 碎片：只飞、只凉、只缩，不撞任何东西
        rock.age += dt;
        if(rock.age >= rock.life){ rocks.splice(i, 1); continue; }
        rock.heat = 1 - rock.age / rock.life;
        continue;
      }
      rock.heat = ss(ENTRY_R0, ENTRY_R1, rock.p.length());

      // 盾牌：球 vs 有向盒（盾有 0.02 厚度）。局部化用生成时缓存的逆矩阵，盾不动
      for(let j = this.plates.length - 1; j >= 0; j--){
        const pl = this.plates[j];
        const l = this._v1.copy(rock.p).applyMatrix4(pl.inv);
        const qx = Math.max(-PLATE_W / 2, Math.min(PLATE_W / 2, l.x));
        const qy = Math.max(-PLATE_H / 2, Math.min(PLATE_H / 2, l.y));
        const qz = Math.max(-PLATE_T, Math.min(PLATE_T, l.z));
        if(Math.hypot(l.x - qx, l.y - qy, l.z - qz) <= rock.r){
          this._burst(rock.p, COLD, null, 14);
          this.blocks++;
          pl.hp--;
          pl.mesh.material.uniforms.uHP.value = pl.hp;
          if(pl.hp <= 0){
            this._burst(pl.mesh.position, COLD, null, 26);
            this._removePlate(j);
            this._say('sv_plate_lost');
          }
          this._removeRock(i);
          continue outer;
        }
      }

      // 地表：让它钻进去一点再判，石头得看见碰到地面
      if(rock.p.length() <= 1 + rock.r * 0.6){
        const n = this._v1.copy(rock.p).normalize();
        this.stage.impact(n, rock.r);                  // 光斑 + 疤 + 震动都在舞台那边
        this.heat += HEAT_BASE + HEAT_K * rock.r * rock.r;
        this.impacts++;
        this._burst(this._v2.copy(n).multiplyScalar(1.02), HOT, n, BURST_PER);
        this._say('sv_first_hit');
        this._removeRock(i);
      }
    }
  }

  _removeRock(i){
    const rock = this.rocks[i];
    if(this.target === rock) this.target = null;
    this.rocks.splice(i, 1);
  }

  _kill(rock){
    const i = this.rocks.indexOf(rock);
    if(i < 0) return;
    this.kills++;
    this._beam(rock.p);
    this._shatter(rock);
    this._burst(rock.p, COLD, null, 30);
    this._flash(rock.p);
    this._removeRock(i);
    this._say('sv_beam');
    if(this.kills === 5) this._say('sv_kills5');
  }

  /* ── 护盾 ── */
  _placePlate(x, y){
    let mesh = this.platePool.find(m => !m.visible);
    if(!mesh){                                         // 满了：最旧的那块让位，别让进度环白转
      this._burst(this.plates[0].mesh.position, COLD, null, 12);
      this._removePlate(0);
      mesh = this.platePool.find(m => !m.visible);
    }
    const cam = this.stage.camera;
    const fwd = this._v1.setFromMatrixColumn(cam.matrixWorld, 2).negate();     // 视轴
    const rd  = this._cursorRay(x, y, this._v2);
    const t   = -cam.position.dot(fwd) / rd.dot(fwd);
    const p   = this._v3.copy(cam.position).addScaledVector(rd, t);
    const len = p.length();
    p.multiplyScalar(Math.max(PLATE_RMIN, Math.min(PLATE_RMAX, len)) / Math.max(1e-4, len));   // 指在盘面上 → 推到最近的许可环
    const radial = this._v4.copy(p).normalize();
    // 朝向：正对镜头与径向外之间倾 35°。纯正对镜头 = 石头在盾的平面里滑过去，读不出「挡住」；
    // 纯径向 = 侧对镜头只剩一条线。倾角还让它在 uLightDir 下有明暗，是空间里的一块东西。
    const n = fwd.clone().negate().multiplyScalar(Math.cos(PLATE_TILT)).addScaledVector(radial, Math.sin(PLATE_TILT)).normalize();
    mesh.up.copy(radial);
    mesh.position.copy(p);
    mesh.lookAt(p.clone().add(n));                     // Mesh.lookAt 让 +Z（面法线）对准目标；up = 径向 ⇒ 长边沿切向
    mesh.scale.setScalar(1);
    mesh.updateMatrixWorld(true);
    const inv = mesh.matrixWorld.clone().invert();     // 命中判定用满尺寸的矩阵；出场缩放只是视觉
    mesh.scale.setScalar(0.01);
    mesh.visible = true;
    const u = mesh.material.uniforms;
    u.uHP.value = PLATE_HP; u.uBorn.value = this.fxT; u.uDie.value = this.fxT + PLATE_LIFE; u.uSeed.value = Math.random() * 10;
    this.plates.push({ mesh, hp:PLATE_HP, inv, born:this.fxT, die:this.fxT + PLATE_LIFE });
    this.platesMade++;
    this.P = 1 + this.platesMade * P_PER_PLATE;
    this._say('sv_plate');
  }

  /* 到寿的盾散掉：一小蓬冷光，不算拦截。渐隐由着色器按 uDie 自己算 */
  _agePlates(){
    for(let j = this.plates.length - 1; j >= 0; j--){
      const pl = this.plates[j];
      if(this.fxT < pl.die) continue;
      this._burst(pl.mesh.position, COLD, null, 10);
      this._removePlate(j);
    }
  }
  _removePlate(j){
    const pl = this.plates[j];
    pl.mesh.visible = false;
    this.plates.splice(j, 1);
  }

  /* ── 光束与碎屑 ── */
  _beam(target){
    const b = this.beams.find(b => !b.mesh.visible) || this.beams[0];
    b.b.copy(target); b.t = 0; b.mesh.visible = true;
    this._beamFrame(b);
  }
  _beams(dt){
    for(const b of this.beams){
      if(!b.mesh.visible) continue;
      b.t += dt;
      if(b.t >= BEAM_LIFE){ b.mesh.visible = false; continue; }
      this._beamFrame(b);
    }
  }
  _beamFrame(b){
    const cam = this.stage.camera;
    // 起点：镜头前 1.6、画面底边中央——观测者的射击来自画外下方
    const h = 1.6 * Math.tan(cam.fov * Math.PI / 360);
    b.a.set(0, -h * 0.95, -1.6); cam.localToWorld(b.a);
    const x = this._v1.subVectors(b.b, b.a); const len = Math.max(1e-4, x.length()); x.normalize();
    const mid = this._v2.addVectors(b.a, b.b).multiplyScalar(0.5);
    const y = this._v3.subVectors(cam.position, mid).normalize().cross(x).normalize();   // 带面朝镜头
    const z = this._v4.crossVectors(x, y);
    b.mesh.quaternion.setFromRotationMatrix(this._m.makeBasis(x, y, z));
    b.mesh.position.copy(mid);
    b.mesh.scale.set(len, BEAM_W, 1);
    b.mesh.material.uniforms.uK.value = 1 - b.t / BEAM_LIFE;
  }

  _burst(pos, col, normal, n){
    for(let k = 0; k < n; k++){
      const i = this.burstHead; this.burstHead = (this.burstHead + 1) % BURST_N;
      const d = randomUnit(this._v3);
      if(normal) d.addScaledVector(normal, 1.2).normalize();      // 溅射沿法线
      const sp = rnd(0.3, 0.9);
      this.bP.setXYZ(i, pos.x, pos.y, pos.z);
      this.bV.setXYZ(i, d.x * sp, d.y * sp, d.z * sp);
      this.bT0.setX(i, this.fxT);
      this.bLife.setX(i, rnd(0.45, 0.8));
      this.bSize.setX(i, rnd(0.03, 0.08));
      this.bCol.setXYZ(i, col.r, col.g, col.b);
    }
    for(const a of [this.bP, this.bV, this.bT0, this.bLife, this.bSize, this.bCol]) a.needsUpdate = true;
  }

  // 击中那一下的白闪：四个大点，四分之一秒
  _flash(pos){
    const white = new THREE.Color(2.2, 2.4, 2.8);
    for(let k = 0; k < 4; k++){
      const i = this.burstHead; this.burstHead = (this.burstHead + 1) % BURST_N;
      this.bP.setXYZ(i, pos.x, pos.y, pos.z);
      this.bV.setXYZ(i, 0, 0, 0);
      this.bT0.setX(i, this.fxT);
      this.bLife.setX(i, 0.25);
      this.bSize.setX(i, rnd(0.25, 0.4));
      this.bCol.setXYZ(i, white.r, white.g, white.b);
    }
    for(const a of [this.bP, this.bV, this.bT0, this.bLife, this.bSize, this.bCol]) a.needsUpdate = true;
  }

  /* ── 屏幕空间 ── */
  // 世界点 → 归一化视口坐标（0..1，y 向下）；z 带回视空间深度，供投影半径用。
  // 用上一帧渲染用过的 matrixWorldInverse（含抖动）：和玩家看见的那张画面严格一致。
  _project(p, out){
    const cam = this.stage.camera;
    this._pr.copy(p).applyMatrix4(cam.matrixWorldInverse);
    const zv = -this._pr.z;
    this._pr.applyMatrix4(cam.projectionMatrix);
    return out.set(this._pr.x * 0.5 + 0.5, 0.5 - this._pr.y * 0.5, zv);
  }
  // 投影半径（CSS px）= r / zv × f × H/2，f = projectionMatrix[5] = 1/tan(fov/2)
  _projR(r, zv){ return r * this.stage.camera.projectionMatrix.elements[5] / Math.max(0.1, zv) * this._size.y * 0.5; }
  _cursorRay(x, y, out){
    const cam = this.stage.camera;
    return out.set(x * 2 - 1, -(y * 2 - 1), 0.5).unproject(cam).sub(cam.position).normalize();
  }

  /* ── 停留 ── */
  _dwell(dt){
    this.fireCool = Math.max(0, this.fireCool - dt);
    const c = this.cur;
    const age = c ? (performance.now() - this.aimAt) / 1000 : Infinity;
    const stale = age > AIM_STALE;
    if(stale){ this._retarget(null, dt); this._shield(age > SHIELD_GAP ? null : c, dt); this._crosshair(null); return; }
    const W = this._size.x, H = this._size.y, cx = c.x * W, cy = c.y * H;
    let best = null, bestD = Infinity;                   // 最近的、投影距离小于命中圈的石头
    for(const k of this.rocks){
      if(k.shard) continue;
      const q = this._project(k.p, this._s);
      if(q.z <= 0) continue;
      const hit = Math.max(HIT_PX_MIN, this._projR(k.r, q.z) * HIT_PX_K + HIT_PX_PAD);
      const d = Math.hypot(q.x * W - cx, q.y * H - cy);
      if(d < hit && d < bestD){ best = k; bestD = d; }
    }
    if(c.pose === 'victory'){ this._retarget(null, dt); this._shield(c, dt); }   // ✌️ 不是在指
    else                    { this._shield(null, dt); this._retarget(best, dt); }
    this._crosshair(c);
  }

  _retarget(hit, dt){
    if(hit){
      if(hit !== this.target){ this.target = hit; this.dwell = 0; }   // 换目标从零蓄；空档内回到同一颗不算换
      this.gap = 0;
      if(this.fireCool <= 0) this.dwell += dt;
      if(this.fireCool <= 0 && this.dwell >= DWELL_FIRE){ this._kill(this.target); this.target = null; this.dwell = 0; this.fireCool = FIRE_COOL; }
    }else if(this.target){
      this.gap += dt;                                     // 80ms 空档：分类器抖一帧、石头翻滚时恰好擦出命中圈
      if(this.gap > DWELL_GAP) this.target = null;
    }else{
      this.dwell = Math.max(0, this.dwell - dt * DWELL_DECAY);   // 进度环退回去，不是瞬间清零
    }
  }

  /* ✌️ 比着不放：每满 0.5s 在准星处落一块，进度环归零再长。空档 ≤0.25s 只暂停，更久才慢慢退。 */
  _shield(c, dt){
    if(c && c.pose === 'victory'){
      this.vGap = 0;
      if((this.shieldK += dt) >= DWELL_SHIELD){
        this._placePlate(c.x, c.y);
        this.shieldK = 0;
      }
    }else{
      this.vGap += dt;
      if(this.vGap > SHIELD_GAP) this.shieldK = Math.max(0, this.shieldK - dt * SHIELD_DECAY);
    }
  }

  _crosshair(c){
    const el = this.el; if(!el) return;
    if(!c){
      if(this.shown){ el.className = 'aim'; this.shown = false; this.lastCls = 'aim'; }
      return;
    }
    el.style.transform = `translate(${(c.x * this._size.x).toFixed(1)}px, ${(c.y * this._size.y).toFixed(1)}px)`;
    const k = c.pose === 'victory' ? this.shieldK / DWELL_SHIELD : (DWELL_FIRE > 0 ? this.dwell / DWELL_FIRE : (this.target ? 1 : 0));
    el.style.setProperty('--k', Math.min(1, k).toFixed(3));
    const cls = 'aim ' + (c.pose === 'victory' ? 'is-shield' : 'is-point') + (this.target ? ' is-lock' : '');
    if(cls !== this.lastCls){ el.className = cls; this.lastCls = cls; }   // 只在变化时写 class
    this.shown = true;
  }

  /* ── 温度 / 气压 ── */
  _cool(dt){
    this.heat = Math.max(0, this.heat - COOL * dt);
    this.T = T0 + this.heat;
    this.P = 1 + this.platesMade * P_PER_PLATE;
    if(this.T > 470) this._say('sv_hot');
    if(this.elapsed >= 120) this._say('sv_late');
    if(this.T >= T_LIMIT && !this.over){ this.over = true; this.onCrush(); }   // 只喊一次；main.js 先标 'heat' 再走 fire('crush')
  }

  /* ── 同步到 GPU ── */
  _sync(dt){
    const mesh = this.rockMesh;
    for(let i = 0; i < this.rocks.length; i++){
      const rock = this.rocks[i];
      this._q.setFromAxisAngle(rock.axis, rock.ang);
      const k = rock.shard ? 1 - Math.pow(rock.age / rock.life, 2) : 1;   // 碎片越飞越小
      this._s.set(rock.r * rock.sx * k, rock.r * rock.sy * k, rock.r * rock.sz * k);
      this._m.compose(rock.p, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
      this.aHeat.array[i] = rock.heat;
      this.aSeed.array[i] = rock.seed;
    }
    mesh.count = this.rocks.length;
    mesh.instanceMatrix.needsUpdate = true;
    this.aHeat.needsUpdate = true; this.aSeed.needsUpdate = true;
    for(const pl of this.plates){
      const k = ss(0, 0.2, this.fxT - pl.born);
      pl.mesh.scale.setScalar(0.01 + 0.99 * k);
    }
    this._syncFx();
  }
  _syncFx(){
    this.burst.material.uniforms.uTime.value = this.fxT;
    for(const pl of this.plates) pl.mesh.material.uniforms.uTime.value = this.fxT;
  }

  /* ── 播报 ── */
  _say(id){
    if(this.said.has(id)) return;
    this.said.add(id);
    this.pendingSay.push(id);
  }
  _flavour(){
    if(!this.pendingSay.length) return;
    this.pendingSay = this.pendingSay.filter(id => !this.civ.say(id, SAY[id]));   // 冷却期内被丢弃就下一帧再试
  }
}
