// 行星渲染 —— Three.js
//
// 关键设计：行星网格永不旋转。自转由 shader 内偏移噪声采样实现（uSpin），
// 因此物体空间 +Z 恒定朝向相机，二向箔沿 Z 压缩才能稳定工作。

import * as THREE from 'three';
import { EffectComposer }   from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass }       from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from '../vendor/jsm/postprocessing/OutputPass.js';

/* ── 共用 GLSL ───────────────────────────────────────── */

const NOISE = `
// 3D Simplex noise —— Ashima Arts / Stefan Gustavson 的标准实现（MIT）。
// 换掉原先手写的 hash 值噪声：那个有可见的轴向网格伪影，大陆只能是糊块。
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float fbm3(vec3 p){
  float a = 0.5, s = 0.0;
  for(int i = 0; i < 3; i++){ s += a * snoise(p); p = p * 2.03 + 19.7; a *= 0.5; }
  return s;
}
float fbm5(vec3 p){
  float a = 0.5, s = 0.0;
  for(int i = 0; i < 5; i++){ s += a * snoise(p); p = p * 2.02 + 11.3; a *= 0.5; }
  return s;
}

// 域扭曲：把噪声的输入坐标本身再用噪声推一把。
// 这是「糊块」和「有峡湾、半岛的真实海岸线」之间的分水岭。
float terrain(vec3 p){
  vec3 w = vec3(fbm3(p * 1.6), fbm3(p * 1.6 + 31.4), fbm3(p * 1.6 + 57.1));
  float continent = snoise(p * 0.78) * 0.62;          // 大陆尺度的整块结构
  return continent + fbm5(p * 1.95 + w * 0.68) * 0.72;
}

// 云层密度。地表云影与云层本身共用这一个函数，保证影子和云对得上。
float clouds(vec3 p, float cover, float drift){
  float c = fbm5(p * 2.9 + vec3(0.0, 0.0, drift)) * 0.5 + 0.5;   // 归一到 [0,1]
  return smoothstep(0.60 - cover * 0.28, 0.76, c) * cover;
}

vec3 rotY(vec3 p, float a){
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

`;

// 形变：二向箔压平 + 引力挤压碎裂。两种效果共用同一段顶点形变。
const DEFORM = `
uniform float uFoilX;    // 二向箔扫掠位置（-1.9 → +1.9）
uniform float uShatter;  // 挤压进度 0 → 1
uniform float uSpread;   // 压平后铺开系数

// 返回该顶点的局部压平量 0..1
float flatAmount(vec3 p){
  return smoothstep(uFoilX + 0.30, uFoilX - 0.30, p.x);
}

// 仅二向箔压平。云层与大气用这个——它们不该碎裂，只该随行星一起摊平/消散。
vec3 flatten(vec3 p, out float outFlat){
  float f = flatAmount(p);
  outFlat = f;
  float spread = smoothstep(0.12, 1.0, f) * uSpread;
  p.xz *= 1.0 + spread * 0.52;
  p.y  *= 1.0 - f * 0.98;   // 残留 2% 厚度，避免正反面 z-fighting
  return p;
}

// 压平 + 引力挤压碎裂。只有行星本体走这条。
vec3 deform(vec3 p, vec3 cen, vec3 dir, vec3 axis, float rnd, out float outFlat){
  p = flatten(p, outFlat);

  if(uShatter > 0.0){
    float s = uShatter;
    float implode = smoothstep(0.0, 0.16, s) * (1.0 - smoothstep(0.16, 0.30, s));
    p *= 1.0 - implode * 0.24;

    float burst = smoothstep(0.20, 1.0, s);
    if(burst > 0.0){
      vec3 local = (p - cen) * (1.0 - burst * 0.40);
      // 绕独立随机轴翻滚，转速也按碎片随机
      float ang = burst * (rnd * 2.0 - 1.0) * 16.0;
      float c = cos(ang), si = sin(ang);
      local = local * c + cross(axis, local) * si + axis * dot(axis, local) * (1.0 - c);
      // 速度离散：rnd 的三次方拉开长尾，少数碎片冲得很远，多数留在近处
      float speed = 0.35 + rnd * rnd * rnd * 4.6;
      p = cen + local + dir * burst * speed;
    }
  }
  return p;
}
`;

/* ── 行星本体 ────────────────────────────────────────── */

const PLANET_VERT = `
attribute vec3 aCentroid;
attribute vec3 aDir;
attribute vec3 aAxis;
attribute float aRnd;

varying vec3 vSurf;
varying vec3 vNrm;
varying float vFlat;

${DEFORM}

void main(){
  vSurf = normalize(position);   // 未形变方向，用于采样地表；保证碎裂时纹理不滑移
  vNrm  = normalize(normal);

  float f;
  vec3 p = deform(position, aCentroid, aDir, aAxis, aRnd, f);
  vFlat = f;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const PLANET_FRAG = `
precision highp float;

uniform float uTemp;      // K
uniform float uPop;       // 0..1
uniform float uSpin;
uniform float uShatter;
uniform float uCover;     // 云量，用于云影
uniform vec3  uLightDir;

varying vec3 vSurf;
varying vec3 vNrm;
varying float vFlat;

${NOISE}

void main(){
  // 全部光照在「地表坐标系」内完成：自转靠偏移噪声采样实现，
  // 所以把光和视线反向旋转进这个系，而不是去转法线。
  vec3 sp = rotY(normalize(vSurf), uSpin);
  vec3 L  = rotY(normalize(uLightDir), uSpin);
  vec3 V  = rotY(normalize(cameraPosition - vSurf), uSpin);

  float lat = abs(sp.y);
  float T = uTemp;

  float h    = terrain(sp);
  float elev = h * 0.5 + 0.5;
  float land = smoothstep(0.468, 0.508, elev);
  float detail = fbm3(sp * 6.0) * 0.5 + 0.5;

  // ── 法线扰动。没有这个，地表不接光，看着就是喷漆塑料。
  vec3 n0 = normalize(sp);
  vec3 up = abs(n0.y) < 0.98 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 tang = normalize(cross(up, n0));
  vec3 bita = cross(n0, tang);
  float E = 0.012;
  float F = 5.2;                              // 频率高于此值，起伏读作噪点而非地形
  float b0 = fbm3(sp * F);
  float bx = fbm3(normalize(sp + tang * E) * F);
  float by = fbm3(normalize(sp + bita * E) * F);
  // 起伏强度与高程相关：平原平坦，山地崎岖。海面只留极轻的波纹。
  float rugged = land * (0.20 + smoothstep(0.58, 0.80, elev) * 0.85) + 0.04;
  vec3 grad = (tang * (bx - b0) + bita * (by - b0)) / E;
  vec3 N = normalize(n0 - grad * 0.024 * rugged);

  // ── 冰盖
  float freeze  = smoothstep(298.0, 212.0, T);
  float iceLine = mix(1.08, -0.14, freeze);
  float ice     = smoothstep(iceLine - 0.11, iceLine + 0.03, lat);

  // 深海 → 近岸浅水。硬边海岸线是「假」的最大来源之一，
  // 真实行星在大陆架上有一圈明显更亮的浅蓝。
  vec3 deepSea = mix(vec3(0.012,0.042,0.098), vec3(0.006,0.022,0.055), detail * 0.7);
  vec3 shallow = vec3(0.055, 0.180, 0.226);
  float shelf  = smoothstep(0.424, 0.470, elev);
  vec3 ocean   = mix(deepSea, shallow, shelf * 0.85);

  // 纬度生物群系：赤道雨林 → 副热带干旱带 → 温带 → 苔原
  vec3 tropic    = mix(vec3(0.038,0.112,0.040), vec3(0.070,0.150,0.052), detail);
  vec3 dryBelt   = mix(vec3(0.330,0.262,0.148), vec3(0.452,0.362,0.216), detail);
  vec3 temperate = mix(vec3(0.078,0.132,0.062), vec3(0.140,0.180,0.086), detail);
  vec3 tundra    = mix(vec3(0.210,0.214,0.182), vec3(0.282,0.276,0.238), detail);

  vec3 bio = tropic;
  bio = mix(bio, dryBelt,   smoothstep(0.10, 0.31, lat));
  bio = mix(bio, temperate, smoothstep(0.35, 0.56, lat));
  bio = mix(bio, tundra,    smoothstep(0.62, 0.85, lat));

  vec3 iceCol = mix(vec3(0.662,0.733,0.784), vec3(0.840,0.878,0.910), detail);
  vec3 rock   = mix(vec3(0.168,0.150,0.138), vec3(0.248,0.222,0.202), detail);

  // 高程：山地裸岩，再往上是雪线
  bio = mix(bio, rock, smoothstep(0.700, 0.790, elev) * 0.85);
  bio = mix(bio, vec3(0.855,0.878,0.900), smoothstep(0.800, 0.880, elev) * 0.78);

  float arid = smoothstep(296.0, 400.0, T);
  vec3 surf = mix(bio, dryBelt, arid);
  surf = mix(surf, rock, smoothstep(385.0, 475.0, T));

  vec3 albedo = mix(ocean, surf, land);

  float boil = smoothstep(372.0, 452.0, T);
  albedo = mix(albedo, rock * 0.62, (1.0 - land) * boil);
  albedo = mix(albedo, iceCol, ice * freeze);

  // ── 熔融
  float melt   = smoothstep(620.0, 900.0, T);
  float ridge  = 1.0 - abs(fbm3(sp * 2.9)) * 1.6;
  float cracks = pow(clamp(ridge, 0.0, 1.0), 6.0);
  vec3  magma  = mix(vec3(0.130,0.026,0.012), vec3(1.000,0.404,0.102), cracks);
  albedo = mix(albedo, magma * 0.35, melt);
  vec3 emissive = magma * cracks * melt * 3.4;      // 超过 1.0，交给 bloom

  // ── 光照
  float ndl = dot(N, L);
  float day = smoothstep(-0.22, 0.36, ndl);

  // 云影：沿光方向偏移采样同一个云函数
  float drift = uSpin * 1.22 * 0.35;
  float shadow = clouds(normalize(sp + L * 0.052), uCover, drift);
  day *= 1.0 - shadow * 0.52;

  // 终结线染色：掠射角的光穿过更厚的大气，偏红
  vec3 warmLight = mix(vec3(1.0, 0.98, 0.94), vec3(1.0, 0.62, 0.36),
                       smoothstep(0.42, 0.02, ndl) * smoothstep(-0.10, 0.10, ndl));
  vec3 lit = albedo * day * warmLight * 1.08;
  lit += albedo * vec3(0.045, 0.058, 0.082) * (1.0 - day);   // 夜面天光

  // ── 海洋高光。没有太阳反射点，水就永远不像水。
  float water = (1.0 - land) * (1.0 - ice * freeze) * (1.0 - boil);
  vec3 H = normalize(L + V);
  // 指数决定光斑大小。240 会糊成一大团白，太阳的角直径其实很小。
  float spec = pow(max(dot(N, H), 0.0), 900.0) * water * smoothstep(-0.02, 0.18, ndl);
  lit += vec3(1.0, 0.95, 0.86) * spec * 3.2;                  // 超过 1.0，交给 bloom

  // ── 城市灯火
  float clus = fbm3(sp * 12.0) * 0.5 + 0.5;
  float city = smoothstep(0.640, 0.760, clus) * land * (1.0 - ice) * uPop;
  lit += vec3(1.000, 0.742, 0.352) * city * pow(1.0 - day, 1.6) * 1.9; // 超过 1.0，交给 bloom

  lit += emissive;

  // ── 二向箔：光照塌缩为无光，色彩信息一并流失——它变成一张画
  float lum = dot(albedo, vec3(0.299, 0.587, 0.114));
  vec3 flatLit = mix(albedo, vec3(lum), 0.26) * 1.45 + emissive * 0.55;
  lit = mix(lit, flatLit, vFlat);

  // ── 引力挤压：碎片带着塌缩余温
  if(uShatter > 0.0){
    float burst = smoothstep(0.20, 1.0, uShatter);        // 与顶点着色器同一条曲线
    // 裂开的瞬间最热，碎片飞散后迅速冷却
    float heat = smoothstep(0.02, 0.26, burst) * (1.0 - smoothstep(0.32, 0.92, burst));
    float grain = fbm3(sp * 7.0) * 0.5 + 0.5;
    lit += vec3(1.0, 0.42, 0.14) * heat * (0.42 + 0.78 * grain) * 1.55;
    lit *= 1.0 - smoothstep(0.0, 0.18, uShatter) * 0.35;  // 外壳先暗下去，反衬内核
    lit *= 1.0 - smoothstep(0.30, 0.95, burst) * 0.55;    // 碎片飞散后冷却、隐入暗处
  }

  gl_FragColor = vec4(lit, 1.0);
}

`;

/* ── 大气 ────────────────────────────────────────────── */

const ATMO_VERT = `
varying vec3 vNrm;
varying vec3 vView;
varying vec3 vObj;
varying float vFlat;

${DEFORM}

void main(){
  vNrm = normalize(normalMatrix * normal);
  vObj = normalize(position);
  float f;
  vec3 p = flatten(position, f);
  vFlat = f;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}

`;

const ATMO_FRAG = `
precision highp float;
uniform vec3  uColor;       // 深空侧冷色
uniform vec3  uSunset;      // 终结线暖色
uniform float uDensity;
uniform float uShatter;
uniform vec3  uLightDir;
varying vec3 vNrm;
varying vec3 vView;
varying vec3 vObj;
varying float vFlat;

void main(){
  vec3 nrm = normalize(vNrm);
  float rim = pow(clamp(1.0 - abs(dot(nrm, normalize(vView))), 0.0, 1.0), 2.2);

  // 受光程度决定大气亮度：背光侧不该发光
  float ndl = dot(normalize(vObj), normalize(uLightDir));
  float daySide = smoothstep(-0.42, 0.22, ndl);

  // 终结线附近的暖色带——从轨道上看到的那圈日出日落，
  // 这一条比什么都更能让大气像真的。
  float sunset = exp(-ndl * ndl * 14.0);

  vec3 col = mix(uColor, uSunset, sunset * 0.92);
  float a = rim * uDensity * daySide * (1.0 - vFlat) * (1.0 - smoothstep(0.0, 0.26, uShatter));
  gl_FragColor = vec4(col * a * 2.6, a);
}

`;

/* ── 云层 ────────────────────────────────────────────── */

const CLOUD_VERT = `
varying vec3 vSurf;
varying vec3 vNrm;
varying float vFlat;

${DEFORM}

void main(){
  vSurf = normalize(position);
  vNrm  = normalize(normal);
  float f;
  vec3 p = flatten(position, f);
  vFlat = f;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const CLOUD_FRAG = `
precision highp float;
uniform float uShatter;
uniform float uSpin;
uniform float uCover;
uniform float uTint;
uniform vec3  uLightDir;
varying vec3 vSurf;
varying vec3 vNrm;
varying float vFlat;

${NOISE}

void main(){
  vec3 sp = rotY(normalize(vSurf), uSpin);
  vec3 L  = rotY(normalize(uLightDir), uSpin);

  float drift = uSpin * 1.22 * 0.35;
  float a = clouds(sp, uCover, drift);
  if(a < 0.012) discard;

  // 云的自阴影：向光侧亮、背光侧暗，云团才有体积
  float self = clouds(normalize(sp + L * 0.030), uCover, drift);
  float shade = 1.0 - clamp(self - a, 0.0, 1.0) * 1.5;

  float ndl = dot(normalize(sp), L);
  float day = smoothstep(-0.16, 0.30, ndl);
  vec3 warm = mix(vec3(1.0, 0.99, 0.96), vec3(1.0, 0.66, 0.42),
                  smoothstep(0.40, 0.02, ndl) * smoothstep(-0.12, 0.12, ndl));

  vec3 col = mix(vec3(0.94, 0.95, 0.97), vec3(0.72, 0.44, 0.28), uTint);
  col *= (0.050 + day * 0.56) * shade * warm;   // 峰值约 0.55，低于 bloom 阈值

  gl_FragColor = vec4(col, a * (1.0 - vFlat * 0.55) * (1.0 - smoothstep(0.0, 0.22, uShatter)));
}

`;

/* ── 二向箔 ──────────────────────────────────────────── */

const FOIL_FRAG = `
precision highp float;
uniform float uOpacity;
varying vec2 vUv;
void main(){
  // 一道竖直的高亮薄膜，中心最亮，上下淡出
  float band = 1.0 - abs(vUv.x - 0.5) * 2.0;
  band = pow(clamp(band, 0.0, 1.0), 5.0);
  float fade = smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.84, vUv.y);
  float a = band * fade * uOpacity;
  vec3 col = mix(vec3(0.44,0.66,0.86), vec3(1.0,1.0,1.0), band);
  gl_FragColor = vec4(col, a);
}
`;

const CORE_FRAG = `
precision highp float;
uniform float uOpacity;
varying vec2 vUv;
void main(){
  float d = length(vUv - 0.5) * 2.0;
  float k = clamp(1.0 - d, 0.0, 1.0);
  float core = pow(k, 2.4);
  float halo = pow(k, 0.7) * 0.32;
  vec3 col = mix(vec3(1.0, 0.46, 0.14), vec3(1.0, 0.96, 0.88), core);
  float a = (core + halo) * uOpacity;
  gl_FragColor = vec4(col * a, a);
}
`;

const FOIL_VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/* ── 舞台 ────────────────────────────────────────────── */

export class PlanetStage {
  constructor(canvas){
    this.canvas = canvas;
    this.spin = 0;
    this.state = 'idle';       // idle | foil | crush | done
    this.effectT = 0;
    this.onEffectEnd = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:false });
    this.renderer.setClearColor(0x05070A, 1);
    // 场景在线性 HDR 空间渲染（自发光可超过 1.0，供 bloom 提取），
    // 由链尾的 OutputPass 统一做 ACES 色调映射并转 sRGB。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.baseR = 4.1; this.camAz = 0; this.camEl = 0; this.camPush = 0;
    this.camera.position.set(0, 0, this.baseR);

    this.lightDir = new THREE.Vector3(0.68, 0.26, 0.69).normalize();

    this._buildStars();
    this._buildPlanet();
    this._buildClouds();
    this._buildAtmo();
    this._buildFoil();
    this._buildCore();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // threshold 0.62：只让真正发光的东西（城市灯火/岩浆/箔片/内核）溢出，
    // 地表漫反射不参与，否则整个画面会发糊。
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.80, 0.45, 0.78);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
  }

  /* — 星空 — */
  _buildStars(){
    const N = 2600, pos = new Float32Array(N * 3), sz = new Float32Array(N);
    for(let i = 0; i < N; i++){
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      const r = 42 + Math.random() * 14, s = Math.sqrt(1 - u * u);
      pos[i*3] = r * s * Math.cos(th);
      pos[i*3+1] = r * u;
      pos[i*3+2] = r * s * Math.sin(th);
      sz[i] = Math.random() < 0.06 ? 0.30 : 0.055 + Math.random() * 0.10;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const m = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
      vertexShader:`
        attribute float aSize; varying float vA;
        void main(){
          vA = aSize;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * 300.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader:`
        varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if(d > 0.5) discard;
          float a = (1.0 - d * 2.0) * clamp(vA * 6.0, 0.15, 0.95);
          gl_FragColor = vec4(vec3(0.85, 0.90, 1.0), a);
        }`
    });
    this.scene.add(new THREE.Points(g, m));
  }

  /* — 行星（带碎裂属性） — */
  _buildPlanet(){
    const geo = new THREE.IcosahedronGeometry(1, 28);  // 非索引，20*29² = 16820 面
    const pos = geo.attributes.position;
    const n = pos.count;
    const cen = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const axis = new Float32Array(n * 3);   // 翻滚轴，与飞散方向无关
    const rnd = new Float32Array(n);

    for(let t = 0; t < n; t += 3){
      let cx = 0, cy = 0, cz = 0;
      for(let k = 0; k < 3; k++){
        cx += pos.getX(t + k); cy += pos.getY(t + k); cz += pos.getZ(t + k);
      }
      cx /= 3; cy /= 3; cz /= 3;

      // 爆散方向 = 面心方向加随机扰动
      let dx = cx + (Math.random() - 0.5) * 0.85;
      let dy = cy + (Math.random() - 0.5) * 0.85;
      let dz = cz + (Math.random() - 0.5) * 0.85;
      const L = Math.hypot(dx, dy, dz) || 1;
      dx /= L; dy /= L; dz /= L;
      const r = Math.random();

      // 翻滚轴独立随机。若沿用飞散方向，碎片只会绕自己的飞行轴自旋，
      // 始终正对镜头，看起来就是一地彩纸屑。
      let ax = Math.random() * 2 - 1, ay = Math.random() * 2 - 1, az = Math.random() * 2 - 1;
      const AL = Math.hypot(ax, ay, az) || 1;
      ax /= AL; ay /= AL; az /= AL;

      for(let k = 0; k < 3; k++){
        cen[(t+k)*3] = cx; cen[(t+k)*3+1] = cy; cen[(t+k)*3+2] = cz;
        dir[(t+k)*3] = dx; dir[(t+k)*3+1] = dy; dir[(t+k)*3+2] = dz;
        axis[(t+k)*3] = ax; axis[(t+k)*3+1] = ay; axis[(t+k)*3+2] = az;
        rnd[t+k] = r;
      }
    }
    geo.setAttribute('aCentroid', new THREE.BufferAttribute(cen, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aAxis', new THREE.BufferAttribute(axis, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));

    this.uPlanet = {
      uTemp:{value:288}, uPop:{value:1}, uSpin:{value:0}, uCover:{value:0.5},
      uLightDir:{value:this.lightDir},
      
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1}
    };
    this.planet = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uPlanet, vertexShader:PLANET_VERT, fragmentShader:PLANET_FRAG,
      side:THREE.FrontSide
    }));
    this.scene.add(this.planet);
  }

  _buildClouds(){
    const geo = new THREE.IcosahedronGeometry(1.017, 4);
    this.uCloud = {
      uSpin:{value:0}, uCover:{value:0.5}, uTint:{value:0},
      uLightDir:{value:this.lightDir},
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1}
    };
    this.clouds = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uCloud, vertexShader:CLOUD_VERT, fragmentShader:CLOUD_FRAG,
      transparent:true, depthWrite:false, side:THREE.FrontSide
    }));
    this.scene.add(this.clouds);
  }

  _buildAtmo(){
    const geo = new THREE.IcosahedronGeometry(1.14, 4);
    this.uAtmo = {
      uColor:{value:new THREE.Color(0.30, 0.52, 0.95)},
      uSunset:{value:new THREE.Color(1.00, 0.46, 0.20)},
      uDensity:{value:0.85}, uLightDir:{value:this.lightDir},
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1}
    };
    this.atmo = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uAtmo, vertexShader:ATMO_VERT, fragmentShader:ATMO_FRAG,
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
      side:THREE.BackSide
    }));
    this.scene.add(this.atmo);
  }

  _buildFoil(){
    // 一面垂直于扫掠方向的薄膜。Z 向要足够深才能罩住整颗行星（半径 1）。
    const geo = new THREE.PlaneGeometry(3.2, 5.6);
    this.uFoil = { uOpacity:{value:0} };
    this.foil = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uFoil, vertexShader:FOIL_VERT, fragmentShader:FOIL_FRAG,
      transparent:true, depthWrite:false, depthTest:false,
      blending:THREE.AdditiveBlending, side:THREE.DoubleSide
    }));
    this.foil.rotation.y = Math.PI / 2;   // 置于 YZ 平面，沿 X 扫掠
    this.foil.position.x = -1.9;
    this.foil.renderOrder = 10;
    this.scene.add(this.foil);
  }

  _buildCore(){
    this.uCore = { uOpacity:{value:0} };
    this.core = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms:this.uCore, vertexShader:FOIL_VERT, fragmentShader:CORE_FRAG,
      transparent:true, depthWrite:false, depthTest:false,
      blending:THREE.AdditiveBlending
    }));
    this.core.renderOrder = 9;
    this.core.visible = false;
    this.scene.add(this.core);
  }

  /** 相机轨道。az 方位角、el 仰角、push 额外拉远 */
  _applyCam(){
    const r = this.baseR + this.camPush;
    const { camAz: a, camEl: e } = this;
    this.camera.position.set(
      r * Math.sin(a) * Math.cos(e),
      r * Math.sin(e),
      r * Math.cos(a) * Math.cos(e)
    );
    this.camera.lookAt(0, 0, 0);
  }

  /* ── 外部接口 ── */

  setEnv(tempK, pressureAtm, popNorm){
    this.uPlanet.uTemp.value = tempK;
    this.uPlanet.uPop.value = popNorm;

    // 云量：气压给上限，极端温度抑制（冻干 / 蒸散殆尽）
    const pc = Math.min(1, Math.pow(pressureAtm / 9, 0.60));
    const tk = Math.min(1, Math.max(0, (tempK - 150) / 120)) *
               Math.min(1, Math.max(0, (760 - tempK) / 180));
    this.uCloud.uCover.value = pc * (0.25 + 0.75 * tk);
    this.uPlanet.uCover.value = this.uCloud.uCover.value;
    this.uCloud.uTint.value = Math.min(1, Math.max(0, (tempK - 340) / 260));

    this.uAtmo.uDensity.value = Math.min(2.4, Math.pow(pressureAtm / 1.2, 0.55) * 0.85);
    const hot = Math.min(1, Math.max(0, (tempK - 320) / 320));
    const cold = Math.min(1, Math.max(0, (250 - tempK) / 130));
    this.uAtmo.uColor.value.setRGB(
      0.32 + hot * 0.60 + cold * 0.28,
      0.56 - hot * 0.22 + cold * 0.16,
      0.92 - hot * 0.66 + cold * 0.06
    );
  }

  triggerFoil(){
    if(this.state !== 'idle') return false;
    this.state = 'foil'; this.effectT = 0;
    return true;
  }

  triggerCrush(){
    if(this.state !== 'idle') return false;
    this.state = 'crush'; this.effectT = 0;
    return true;
  }

  reset(){
    this.state = 'idle'; this.effectT = 0;
    for(const u of [this.uPlanet, this.uCloud, this.uAtmo]){
      u.uFoilX.value = -1.9; u.uShatter.value = 0; u.uSpread.value = 1;
    }
    this.uFoil.uOpacity.value = 0;
    this.foil.position.x = -1.9;
    this.uCore.uOpacity.value = 0;
    this.core.visible = false;
    this.camAz = 0; this.camEl = 0; this.camPush = 0;
    this._applyCam();
  }

  update(dt){
    this.spin += dt * 0.055;
    this.uPlanet.uSpin.value = this.spin;
    this.uCloud.uSpin.value = this.spin * 1.22;

    if(this.state === 'idle'){
      // 极慢的机位漂移。幅度很小，观众不会察觉在动，
      // 但少了它画面就是一张会转的静态图。
      this.driftT = (this.driftT || 0) + dt;
      this.camAz = Math.sin(this.driftT * 0.074) * 0.085;
      this.camEl = Math.sin(this.driftT * 0.053 + 1.7) * 0.062 + 0.045;
      this._applyCam();
    }
    else if(this.state === 'foil'){
      this.effectT += dt / 7.4;                     // 全程约 7.4 秒，缓慢不可抗
      const t = Math.min(1, this.effectT);
      const e = t * t * (3 - 2 * t);                 // smoothstep
      const x = -1.9 + e * 3.8;
      for(const u of [this.uPlanet, this.uCloud, this.uAtmo]) u.uFoilX.value = x;
      this.foil.position.x = x;
      this.uFoil.uOpacity.value = Math.sin(Math.min(1, t * 1.12) * Math.PI) * 0.78;

      // 相机抢在箔片抵达前转到斜侧角。正面观察压平是看不出来的——
      // 厚度归零需要视差才能读出，这一转是整个效果成立的前提。
      const c = Math.min(1, t / 0.24);
      const ce = c * c * (3 - 2 * c);
      this.camAz = ce * 0.30;
      this.camEl = ce * 0.36;   // ≈ 21° 俯角，掠射看平面
      this.camPush = ce * 1.25;
      this._applyCam();

      if(t >= 1) this._finish();
    }
    else if(this.state === 'crush'){
      this.effectT += dt / 2.7;
      const t = Math.min(1, this.effectT);
      for(const u of [this.uPlanet, this.uCloud, this.uAtmo]) u.uShatter.value = t;

      // 内核：塌缩到爆散的瞬间最亮，随碎片扩散冷却
      // 内核必须等碎片开始分离才亮——提前亮就是在一颗完整球体前面糊一团白
      const op = this._ss(0.17, 0.30, t) * (1 - this._ss(0.34, 0.72, t)) * 0.82;
      this.uCore.uOpacity.value = Math.max(0, op);
      this.core.visible = op > 0.002;
      const k = 0.42 + this._ss(0.15, 0.90, t) * 1.45;
      this.core.scale.set(k, k, 1);
      this.core.quaternion.copy(this.camera.quaternion);   // 始终正对相机

      if(t >= 1) this._finish();
    }

    this.composer.render();
  }

  _ss(a, b, x){
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  _finish(){
    const was = this.state;
    this.state = 'done';
    if(this.onEffectEnd) this.onEffectEnd(was);
  }

  resize(){
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    if(this.composer){
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
    }
    this.camera.aspect = w / h;
    // 按视场角和宽高比反算距离。竖屏时限制维度是宽度，写死距离必然裁切；
    // 窄屏还要多留余量——上下各被一块面板压掉约三分之一高度。
    const vFov = this.camera.fov * Math.PI / 180;
    const margin = w < 760 ? 1.52 : 1.45;
    this.baseR = margin / (Math.tan(vFov / 2) * Math.min(1, w / h));
    this.camera.updateProjectionMatrix();
    this._applyCam();
  }
}
