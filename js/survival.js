// Survival mode - asteroids, shields, point-to-shoot
//
// The stage (planet.js) provides exactly two things: the impact flash (stage.impact) and depth
// registration (trackDepth / overlay).
// Everything else is here: rock motion, hits, dwell aiming, the temperature/pressure model, and the
// score line in the verdict.
// No lights are added - there are no THREE lights anywhere in this scene; every material computes
// its own Lambert term from uLightDir, the same approach as the planet, mantle and core.
// Rocks and shields are opaque and use trackDepth; beams and debris are additive and use overlay.
// Miss one registration and a whole patch of depth of field goes wrong.

import * as THREE from 'three';
import { NOISE } from './planet.js';
import { tierOf, TIER_EN } from './board.js';

/* -- Pacing -- */
const MAX_ROCKS  = 64;                  // InstancedMesh capacity. Rarely more than 8 on screen; 64 is free headroom
const SPAWN_R    = 2.8;                 // half the frame width at 16:9 is 2.58: they enter just off-screen, and a fixed radius means a consistent time to impact
/* Difficulty steps by score (and score comes only from asteroids): slow to start; a little faster at
   125 points (twenty-five rocks); faster again at 200 (forty); then another ten percent per 100.
   Time multiplies on top: one step at thirty seconds and another at sixty - someone who only blocks
   and never shoots can't outrun the clock either.
   The product of both layers is capped. Targets are approached with tau = 4s so a step reads as
   "a bit faster" rather than a jump, and rocks already in flight keep their speed. */
const STAGES = [
  { at:0,   v:0.32, iv:1.9, dbl:0.00 },
  { at:125, v:0.42, iv:1.4, dbl:0.15 },
  { at:200, v:0.55, iv:1.0, dbl:0.35 }
];
const TIME_STEPS = [ { at:30, k:1.15 }, { at:60, k:1.30 } ];    // k multiplies speed and divides the interval; the double-spawn chance depends on score alone
const STAGE_STEP = 100, STAGE_GAIN = 0.10, V_CAP = 0.8, IV_FLOOR = 0.7, DBL_CAP = 0.5;
const STAGE_TAU  = 4;
const SPAWN_JIT  = 0.35;                // interval +/-35%, to kill the metronome feel
const V_JIT      = 0.15;
const G          = 0.12;                // constant centripetal acceleration (units/s^2): off-center paths curve into arcs and slow rocks keep speeding up. Real gravity would be nearly zero at 2.8 and blow up near the surface
const AIM_SPREAD = 0.75;                // aim inside a disc of radius 0.75 on the facing plane: always a hit (<1), but not every rock heading dead center
const R_MIN = 0.05, R_MAX = 0.13;       // roughly 37 to 97 px across at 1080p: big enough to point at, small enough not to block the view
/* -- Temperature / pressure -- */
const HEAT_BASE = 6, HEAT_K = 3600;     // dT = 6 + 3600*r^2: 9K to 67K. With r^3 a small rock may as well not have hit
const COOL       = 5;                   // K/s. Late on, at a 70% kill rate, heat comes in at about 15K/s: once saturated the run ends within a minute
const T0 = 288, T_LIMIT = 640;          // 640: melting (620->900) has just begun and hot3 has aired - the crush lands on a planet already cracking open
export const T_WARN = 560, T_CRIT = 610;  // two more hits / one more hit: the center of the screen has to shout
const P_PER_PLATE = 0.5;                // two plates -> habitability 0.61, seven -> 0.10. The cost has to hurt for it to be a decision
/* -- Shields -- */
const PLATE_HP = 2, PLATE_W = 0.42, PLATE_H = 0.28, PLATE_T = 0.02, PLATE_MAX = 8;   // each blocks two rocks; at 8 alive, a new one evicts the oldest
const PLATE_LIFE = 7, PLATE_FADE = 1.0;  // seconds. A shield lives 7s and fades over the last one - it is a temporary thing, not a wall
const PLATE_RMIN = 1.35, PLATE_RMAX = 2.3;   // the floor leaves clearance outside the atmosphere shell (1.14); the ceiling stays on screen and inside the spawn ring, so rocks are visible before they reach a shield
const PLATE_TILT = 0.6;                 // radians. The face tilts 35 degrees from camera-facing toward radially outward: you can still see the face, and it meets the incoming rock
/* -- Dwell -- */
const DWELL_FIRE = 0, DWELL_SHIELD = 0.5;       // shooting needs no dwell: point and it fires. A shield does - hold the V and one drops every 0.5s
const DWELL_GAP  = 0.08;                // a single flickering classifier frame, or a tumbling rock clipping the hit circle: anything shorter than this counts as not having left
const DWELL_DECAY = 2.5;                // how fast the progress ring unwinds - it doesn't snap to zero
/* The shield's gap tolerance is wider than the gun's: the V score dipping into the hysteresis band,
   or one stalled camera frame, only pauses the progress ring instead of dropping it.
   Progress only grows on frames confirmed as a V, so a hand sweeping past still can't place one. */
const SHIELD_GAP = 0.25, SHIELD_DECAY = 1.2;
const FIRE_COOL  = 0.12;                // minimum spacing between shots: the beam lands before the crosshair finds the next rock, so sweeping across a cluster can't clear it in one frame
const AIM_STALE  = 0.25;                // seconds. A camera gap longer than this counts as no hand
const HIT_PX_MIN = 46, HIT_PX_K = 2.6, HIT_PX_PAD = 22;   // hit circle = max(46, projected radius * 2.6 + 22) px: a hand shakes more than a mouse, so the circle has to be generous
/* -- Shattering. A rock doesn't vanish, it breaks into a handful of glowing grit: the shards use the
      same instanced renderer and tumble fast, fly apart, shrink and cool -- */
const SHARD_N0 = 7, SHARD_NK = 30;      // shard count = 7 + 30*r
const SHARD_LIFE = [0.35, 0.6];
/* -- Scoring. Asteroids only: 5 for a kill, 2 for one a shield blocks; time is worth nothing.
      Ending it yourself (fist / open palm) adds 20, four rocks' worth.
      If the planet dies before you do the score still stands, it just doesn't get that +20 -- */
const KILL_POINTS = 5, BLOCK_POINTS = 2, SELF_BONUS = 4 * KILL_POINTS;
/* -- Effects -- */
const ENTRY_R0 = 1.7, ENTRY_R1 = 1.05;  // the entry glow starts burning at radius 1.7 and is at full strength by the surface
const BEAM_LIFE = 0.18, BEAM_W = 0.035, BEAM_POOL = 3;
const BURST_N = 256, BURST_PER = 20;    // ring buffer: plenty for a dozen bursts at once
const HOT  = new THREE.Color(1.0, 0.45, 0.15).multiplyScalar(2.2);
const COLD = new THREE.Color(1.1, 1.40, 1.90).multiplyScalar(1.2);

/* Their point of view: clinical, brief, and blind to the hand. Routed through civ.say, sharing one
   cooldown and the same "once per specimen" rule. */
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

/* CPU-side value noise, used once to displace the rock vertices. Same family as planet.js's _hash1. */
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

/* -- Shaders -- */
const ROCK_VERT = `
attribute float aHeat;
attribute float aSeed;
varying vec3 vN, vW, vObj;
varying float vHeat, vSeed;
void main(){
  vec4 p = instanceMatrix * vec4(position, 1.0);
  vec4 w = modelMatrix * p;
  vW = w.xyz;
  // The non-uniform scaling is mild (0.8-1.15): push the normal through rotation and scale and
  // renormalize, skipping an inverse transpose. The error is invisible
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
  vec3 rock = mix(vec3(0.085, 0.072, 0.064), vec3(0.24, 0.20, 0.17), d);   // albedo <0.3, well under the bloom threshold
  float ndl = max(dot(N, L), 0.0);
  vec3 lit = rock * (0.045 + 1.15 * ndl);                                  // leave a little skylight on the night side so it isn't a silhouette
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  lit += vec3(0.05, 0.08, 0.14) * rim * 0.6;                               // cold blue rim: ambient light from the observer's world
  // Atmospheric entry: the side facing the planet ignites first (that is the leading face, so no velocity needs passing in)
  float lead = smoothstep(-0.25, 0.75, dot(N, normalize(-vW)));
  float h = vHeat * vHeat;
  lit += mix(vec3(1.0, 0.30, 0.06), vec3(1.0, 0.72, 0.40), h) * lead * h * 2.8;   // above 1.1 this goes to bloom
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
  float ndl = abs(dot(N, L));                                     // a thin plate is lit from both sides
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);
  vec3 body = vec3(0.12, 0.30, 0.56) * (0.25 + 0.75 * ndl) + vec3(0.20, 0.42, 0.70) * fres * 0.5;
  // Cracks only appear once HP drops to 1. Not emissive: that is damage, not energy
  float cr = pow(clamp(1.0 - abs(fbm3(vec3(vUv * 6.0, uSeed))) * 7.0, 0.0, 1.0), 2.0) * step(uHP, 1.5);
  body = mix(body, vec3(0.55, 0.62, 0.70), cr * 0.8);
  float born = smoothstep(0.0, 0.25, uTime - uBorn);              // the border flares as it is created
  vec3 col = body + vec3(0.30, 0.62, 1.15) * edge * (2.0 + 2.5 * (1.0 - born));   // the border above 1.1 goes to bloom; cold blue belongs to the observer
  float a = (0.55 + 0.45 * edge) * mix(0.75, 1.0, uHP * 0.5);
  float fade = 1.0 - smoothstep(uDie - ${PLATE_FADE.toFixed(2)}, uDie, uTime);   // fade over the last second of its life
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
  float along = mix(0.55, 1.0, vUv.x);                 // the energy sits at the target end
  // Blue above 1.1 and red held below 1: this is blue light, not white (same reasoning as the foil)
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
  vec3 p = position + aV * age * (1.0 - 0.4 * k);       // decelerating after being thrown
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = vK > 0.0 ? aSize * (1.0 - 0.6 * k) * 300.0 / -mv.z : 0.0;   // same size law as the starfield
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

  /* -- Construction -- */
  _buildRocks(){
    // An icosahedron subdivided twice and displaced by value noise; non-indexed, so the facets keep
    // hard edges - which is what a rock should look like
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
    this.rockMesh.frustumCulled = false;   // the bounding sphere is computed once, and the instances move every frame
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

  /* -- Lifecycle -- */
  _resetRun(){
    Object.assign(this, {
      heat:0, T:T0, P:1, platesMade:0, elapsed:0, kills:0, blocks:0, impacts:0, score:0, over:false,
      t:0, fxT:0, spawnT:1.2, seq:0,
      level:0, curV:STAGES[0].v, curIv:STAGES[0].iv, curDbl:0,   // level = difficulty step (this.stage is the PlanetStage)
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
    for(const m of this.platePool) this.stage.trackDepth(m, THREE.DoubleSide);   // translucent but still writes depth: otherwise depth of field smears its 0.42 hard edge
    for(const b of this.beams) this.stage.overlay(b.mesh);
    this.stage.overlay(this.burst);
    this.bT0.array.fill(-1e9); this.bT0.needsUpdate = true;
    this.stage.renderer.compile(this.stage.scene, this.stage.camera);   // compile the four new programs now, rather than hitching when the first rock appears
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

  /* Called by main.js on every camera frame; x/y are normalized viewport coordinates (already
     mirrored and gained), and pose is 'point' or 'victory'. */
  aim(x, y, pose){
    if(x === null || x === undefined){ this.cur = null; return; }
    this.cur = { x:clamp01(x), y:clamp01(y), pose };
    this.aimAt = performance.now();
  }

  /* The end of a run. self = you fired a weapon yourself (+20, four rocks' worth); heat = the planet
     died before you did (the score stands, there is just no bonus).
     Idempotent: the heat-death path tags 'heat' before calling fire(), so the finish('self') inside
     fire() is then a no-op. */
  finish(ending){
    if(this.ending) return;
    this.ending = ending;
    if(ending === 'self') this.score += SELF_BONUS;
    this.over = true;
    this.aim(null);
  }

  get tier(){ return tierOf(this.ending || 'heat', this.score); }   // mid-run: the tier your score would earn (ending it yourself is always DEVIL)

  /* The verdict: in survival it is about you, not them. Three lines: tier, score and tally,
     and how it ended. */
  verdictCard(){
    const t = this.tier;
    const l1 = `RANK ${TIER_EN[t]}`;
    const l2 = `SCORE ${this.score.toLocaleString('en-US')} · HELD ${this.elapsed.toFixed(1)} s · SHOT ${this.kills} · BLOCKED ${this.blocks}`;
    const l3 = this.ending === 'heat' ? 'The planet died before you did.' : `You crushed it yourself: DEVIL, whatever the score. +${SELF_BONUS}`;
    return `${l1}\n${l2}\n${l3}`;
  }
  verdictLine(){ return this.verdictCard(); }

  update(dt){
    if(!this.running) return;
    const idle = this.stage.state === 'idle';
    // An accidental fist/palm goes through main.js's fire(): all that is visible here is state
    // leaving idle. The score freezes on the spot.
    if(!this.over && (!idle || this.civ.struck)) this.over = true;
    this.fxT += dt;                         // flashes and debris still play out
    this.stage.camera.updateMatrixWorld();
    this.stage.renderer.getSize(this._size);
    if(!idle || this.over){ this._beams(dt); this._syncFx(); this._crosshair(null); return; }   // frozen, but not hidden

    this.t += dt; this.elapsed += dt;
    this._spawnClock(dt);
    this._moveRocks(dt);
    this._agePlates();
    this._dwell(dt);
    this._beams(dt);
    this.score = this.kills * KILL_POINTS + this.blocks * BLOCK_POINTS;   // score first, then life and death: the finish() inside _cool needs the final word
    this._stage(dt);
    this._cool(dt);
    this._sync(dt);
    this._flavour();
  }

  /* -- Difficulty: steps by score multiplied by steps over time, approached gradually -- */
  _stageTarget(){
    let s = 0;
    for(let i = 0; i < STAGES.length; i++) if(this.score >= STAGES[i].at) s = i;
    const top = STAGES[STAGES.length - 1];
    const extra = s === STAGES.length - 1 ? Math.floor((this.score - top.at) / STAGE_STEP) : 0;   // past 200 points, another ten percent per 100
    let tk = 1, ts = 0;
    for(const st of TIME_STEPS) if(this.elapsed >= st.at){ tk = st.k; ts++; }                     // x1.15 at thirty seconds, x1.30 at sixty
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

  /* -- Spawning -- */
  _spawnClock(dt){
    this.spawnT -= dt;
    while(this.spawnT <= 0 && this.liveRocks() < MAX_ROCKS - 12){
      this._spawn();
      if(Math.random() < this.curDbl) this._spawn();   // at higher steps, two at a time
      this.spawnT += this.curIv * (1 - SPAWN_JIT + 2 * SPAWN_JIT * Math.random());
    }
  }

  _spawn(){
    const cam = this.stage.camera;
    // Pick a ring on the plane through the planet's center perpendicular to the view axis: they come
    // in from the frame edge and stay inside the in-focus band of the depth of field
    const right = this._v1.setFromMatrixColumn(cam.matrixWorld, 0);
    const up    = this._v2.setFromMatrixColumn(cam.matrixWorld, 1);
    const th = Math.random() * Math.PI * 2;
    const p = new THREE.Vector3().addScaledVector(right, Math.cos(th) * SPAWN_R).addScaledVector(up, Math.sin(th) * SPAWN_R);
    // Aim at a point on that disc rather than the center: still a guaranteed hit (0.75 < 1), and the
    // paths aren't all rays converging on one point
    const ta = Math.random() * Math.PI * 2, tr = Math.sqrt(Math.random()) * AIM_SPREAD;
    const tgt = this._v3.set(0, 0, 0).addScaledVector(right, Math.cos(ta) * tr).addScaledVector(up, Math.sin(ta) * tr);
    const speed = this.curV * (1 - V_JIT + 2 * V_JIT * Math.random());
    const v = tgt.sub(p).normalize().multiplyScalar(speed);
    // Many small rocks, few large ones; the exponent moves toward 1 later on, so big ones get more common
    const r = R_MIN + (R_MAX - R_MIN) * Math.pow(Math.random(), 1.6 - 0.15 * Math.min(3, this.level));   // bigger rocks at higher steps
    this._spawnAt(p, v, r);
    this._say('sv_sight');
  }

  liveRocks(){ let n = 0; for(const k of this.rocks) if(!k.shard) n++; return n; }

  // Debug and test entry point: place one rock at a given position, velocity and radius
  _spawnAt(p, v, r){
    const k = (r - R_MIN) / (R_MAX - R_MIN);
    this.rocks.push({
      p:new THREE.Vector3().copy(p), v:new THREE.Vector3().copy(v), r,
      sx:rnd(0.8, 1.15), sy:rnd(0.8, 1.15), sz:rnd(0.8, 1.15),
      axis:randomUnit(), rate:lerp(2.2, 0.6, k) * rnd(0.7, 1.3),   // bigger rocks tumble slower, same as the fragments in planet.js
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

  /* -- Motion and collisions -- */
  _moveRocks(dt){
    const rocks = this.rocks;
    outer:
    for(let i = rocks.length - 1; i >= 0; i--){
      const rock = rocks[i];
      // Constant centripetal acceleration: a constant both bends the arcs and keeps the pacing tunable
      rock.v.addScaledVector(this._v1.copy(rock.p).normalize(), -G * dt);
      rock.p.addScaledVector(rock.v, dt);
      rock.ang += rock.rate * dt;
      if(rock.shard){                                   // shards only fly, cool and shrink; they collide with nothing
        rock.age += dt;
        if(rock.age >= rock.life){ rocks.splice(i, 1); continue; }
        rock.heat = 1 - rock.age / rock.life;
        continue;
      }
      rock.heat = ss(ENTRY_R0, ENTRY_R1, rock.p.length());

      // Shields: sphere vs oriented box (a shield is 0.02 thick). Localized with the inverse matrix
      // cached at creation, since a shield never moves
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

      // Surface: let it sink in a little before testing - the rock has to be seen touching the ground
      if(rock.p.length() <= 1 + rock.r * 0.6){
        const n = this._v1.copy(rock.p).normalize();
        this.stage.impact(n, rock.r);                  // flash, scar and shake all live on the stage side
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

  /* -- Shields -- */
  _placePlate(x, y){
    let mesh = this.platePool.find(m => !m.visible);
    if(!mesh){                                         // full: the oldest gives way, so the progress ring never spins for nothing
      this._burst(this.plates[0].mesh.position, COLD, null, 12);
      this._removePlate(0);
      mesh = this.platePool.find(m => !m.visible);
    }
    const cam = this.stage.camera;
    const fwd = this._v1.setFromMatrixColumn(cam.matrixWorld, 2).negate();     // view axis
    const rd  = this._cursorRay(x, y, this._v2);
    const t   = -cam.position.dot(fwd) / rd.dot(fwd);
    const p   = this._v3.copy(cam.position).addScaledVector(rd, t);
    const len = p.length();
    p.multiplyScalar(Math.max(PLATE_RMIN, Math.min(PLATE_RMAX, len)) / Math.max(1e-4, len));   // pointing anywhere on the plane -> pushed to the nearest allowed ring
    const radial = this._v4.copy(p).normalize();
    // Orientation: tilted 35 degrees between camera-facing and radially outward. Purely camera-facing
    // means the rock slides along the shield's plane and nothing reads as "blocked"; purely radial
    // means it is edge-on and reduced to a line. The tilt also gives it light and shade under
    // uLightDir, making it an object in space.
    const n = fwd.clone().negate().multiplyScalar(Math.cos(PLATE_TILT)).addScaledVector(radial, Math.sin(PLATE_TILT)).normalize();
    mesh.up.copy(radial);
    mesh.position.copy(p);
    mesh.lookAt(p.clone().add(n));                     // Mesh.lookAt points +Z (the face normal) at the target; up = radial, so the long edge runs tangentially
    mesh.scale.setScalar(1);
    mesh.updateMatrixWorld(true);
    const inv = mesh.matrixWorld.clone().invert();     // collisions use the full-size matrix; the spawn scaling is purely visual
    mesh.scale.setScalar(0.01);
    mesh.visible = true;
    const u = mesh.material.uniforms;
    u.uHP.value = PLATE_HP; u.uBorn.value = this.fxT; u.uDie.value = this.fxT + PLATE_LIFE; u.uSeed.value = Math.random() * 10;
    this.plates.push({ mesh, hp:PLATE_HP, inv, born:this.fxT, die:this.fxT + PLATE_LIFE });
    this.platesMade++;
    this.P = 1 + this.platesMade * P_PER_PLATE;
    this._say('sv_plate');
  }

  /* A shield reaching the end of its life disperses in a small cold burst and counts as no block.
     The fade itself is computed by the shader from uDie. */
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

  /* -- Beams and debris -- */
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
    // Origin: 1.6 in front of the camera, centered on the bottom edge - the observer shoots from below the frame
    const h = 1.6 * Math.tan(cam.fov * Math.PI / 360);
    b.a.set(0, -h * 0.95, -1.6); cam.localToWorld(b.a);
    const x = this._v1.subVectors(b.b, b.a); const len = Math.max(1e-4, x.length()); x.normalize();
    const mid = this._v2.addVectors(b.a, b.b).multiplyScalar(0.5);
    const y = this._v3.subVectors(cam.position, mid).normalize().cross(x).normalize();   // the ribbon faces the camera
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
      if(normal) d.addScaledVector(normal, 1.2).normalize();      // spray follows the normal
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

  // The white flash on impact: four large points, a quarter of a second
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

  /* -- Screen space -- */
  // World point -> normalized viewport coordinates (0..1, y down); z carries view-space depth back
  // for the projected radius.
  // Uses the matrixWorldInverse the last frame actually rendered with (shake included), so this
  // matches exactly the picture the player is looking at.
  _project(p, out){
    const cam = this.stage.camera;
    this._pr.copy(p).applyMatrix4(cam.matrixWorldInverse);
    const zv = -this._pr.z;
    this._pr.applyMatrix4(cam.projectionMatrix);
    return out.set(this._pr.x * 0.5 + 0.5, 0.5 - this._pr.y * 0.5, zv);
  }
  // Projected radius (CSS px) = r / zv * f * H/2, where f = projectionMatrix[5] = 1/tan(fov/2)
  _projR(r, zv){ return r * this.stage.camera.projectionMatrix.elements[5] / Math.max(0.1, zv) * this._size.y * 0.5; }
  _cursorRay(x, y, out){
    const cam = this.stage.camera;
    return out.set(x * 2 - 1, -(y * 2 - 1), 0.5).unproject(cam).sub(cam.position).normalize();
  }

  /* -- Dwell -- */
  _dwell(dt){
    this.fireCool = Math.max(0, this.fireCool - dt);
    const c = this.cur;
    const age = c ? (performance.now() - this.aimAt) / 1000 : Infinity;
    const stale = age > AIM_STALE;
    if(stale){ this._retarget(null, dt); this._shield(age > SHIELD_GAP ? null : c, dt); this._crosshair(null); return; }
    const W = this._size.x, H = this._size.y, cx = c.x * W, cy = c.y * H;
    let best = null, bestD = Infinity;                   // the nearest rock whose projected distance is inside the hit circle
    for(const k of this.rocks){
      if(k.shard) continue;
      const q = this._project(k.p, this._s);
      if(q.z <= 0) continue;
      const hit = Math.max(HIT_PX_MIN, this._projR(k.r, q.z) * HIT_PX_K + HIT_PX_PAD);
      const d = Math.hypot(q.x * W - cx, q.y * H - cy);
      if(d < hit && d < bestD){ best = k; bestD = d; }
    }
    if(c.pose === 'victory'){ this._retarget(null, dt); this._shield(c, dt); }   // a V is not pointing
    else                    { this._shield(null, dt); this._retarget(best, dt); }
    this._crosshair(c);
  }

  _retarget(hit, dt){
    if(hit){
      if(hit !== this.target){ this.target = hit; this.dwell = 0; }   // a new target starts from zero; returning to the same rock within the gap doesn't count as a change
      this.gap = 0;
      if(this.fireCool <= 0) this.dwell += dt;
      if(this.fireCool <= 0 && this.dwell >= DWELL_FIRE){ this._kill(this.target); this.target = null; this.dwell = 0; this.fireCool = FIRE_COOL; }
    }else if(this.target){
      this.gap += dt;                                     // an 80ms gap: one flickering classifier frame, or a tumbling rock just clipping the hit circle
      if(this.gap > DWELL_GAP) this.target = null;
    }else{
      this.dwell = Math.max(0, this.dwell - dt * DWELL_DECAY);   // the ring unwinds rather than snapping to zero
    }
  }

  /* Hold the V: every completed 0.5s drops a plate at the crosshair and the ring restarts from zero.
     A gap of 0.25s or less only pauses it; anything longer unwinds it slowly. */
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
    if(cls !== this.lastCls){ el.className = cls; this.lastCls = cls; }   // only write the class when it changes
    this.shown = true;
  }

  /* -- Temperature / pressure -- */
  _cool(dt){
    this.heat = Math.max(0, this.heat - COOL * dt);
    this.T = T0 + this.heat;
    this.P = 1 + this.platesMade * P_PER_PLATE;
    if(this.T > 470) this._say('sv_hot');
    if(this.elapsed >= 120) this._say('sv_late');
    if(this.T >= T_LIMIT && !this.over){ this.over = true; this.onCrush(); }   // fires once; main.js tags 'heat' before calling fire('crush')
  }

  /* -- Sync to the GPU -- */
  _sync(dt){
    const mesh = this.rockMesh;
    for(let i = 0; i < this.rocks.length; i++){
      const rock = this.rocks[i];
      this._q.setFromAxisAngle(rock.axis, rock.ang);
      const k = rock.shard ? 1 - Math.pow(rock.age / rock.life, 2) : 1;   // shards shrink as they fly
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

  /* -- Broadcasts -- */
  _say(id){
    if(this.said.has(id)) return;
    this.said.add(id);
    this.pendingSay.push(id);
  }
  _flavour(){
    if(!this.pendingSay.length) return;
    this.pendingSay = this.pendingSay.filter(id => !this.civ.say(id, SAY[id]));   // dropped during the cooldown: retry next frame
  }
}
