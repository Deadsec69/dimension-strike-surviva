// 行星渲染 —— Three.js
//
// 关键设计：行星网格永不旋转。自转由 shader 内偏移噪声采样实现（uSpin），
// 因此物体空间 +Z 恒定朝向相机，二向箔沿 Z 压缩才能稳定工作。

import * as THREE from '../vendor/three.module.js';

/* ── 共用 GLSL ───────────────────────────────────────── */

const NOISE = `
float hash(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x){
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                 mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                 mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm5(vec3 p){
  float a = 0.5, s = 0.0;
  for(int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
float fbm3(vec3 p){
  float a = 0.5, s = 0.0;
  for(int i = 0; i < 3; i++){ s += a * vnoise(p); p *= 2.07; a *= 0.5; }
  return s;
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
vec3 deform(vec3 p, vec3 cen, vec3 dir, float rnd, out float outFlat){
  p = flatten(p, outFlat);

  if(uShatter > 0.0){
    float s = uShatter;
    float implode = smoothstep(0.0, 0.16, s) * (1.0 - smoothstep(0.16, 0.30, s));
    p *= 1.0 - implode * 0.24;

    float burst = smoothstep(0.20, 1.0, s);
    if(burst > 0.0){
      vec3 local = (p - cen) * (1.0 - burst * 0.45);   // 碎片随距离收缩
      float ang = burst * (rnd - 0.5) * 11.0;
      float c = cos(ang), si = sin(ang);
      local = local * c + cross(dir, local) * si + dir * dot(dir, local) * (1.0 - c);
      // 飞散距离控制在 2.8 以内：相机在 4.1，再远碎片会糊到镜头上
      p = cen + local + dir * burst * (0.85 + rnd * 1.95);
    }
  }
  return p;
}
`;

/* ── 行星本体 ────────────────────────────────────────── */

const PLANET_VERT = `
attribute vec3 aCentroid;
attribute vec3 aDir;
attribute float aRnd;

varying vec3 vSurf;
varying vec3 vNrm;
varying float vFlat;

${DEFORM}

void main(){
  vSurf = normalize(position);   // 未形变方向，用于采样地表；保证碎裂时纹理不滑移
  vNrm  = normalize(normal);

  float f;
  vec3 p = deform(position, aCentroid, aDir, aRnd, f);
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
uniform vec3  uLightDir;

varying vec3 vSurf;
varying vec3 vNrm;
varying float vFlat;

${NOISE}

void main(){
  vec3 sp = rotY(vSurf, uSpin);
  float lat = abs(sp.y);
  float T = uTemp;

  float h      = fbm5(sp * 2.05);
  float land   = smoothstep(0.492, 0.548, h);
  float detail = fbm3(sp * 7.0);

  // 冰盖：低温时冰线从两极向赤道推进
  float freeze  = smoothstep(298.0, 212.0, T);
  float iceLine = mix(1.08, -0.14, freeze);
  float ice     = smoothstep(iceLine - 0.11, iceLine + 0.03, lat);

  vec3 ocean  = mix(vec3(0.043,0.126,0.235), vec3(0.014,0.052,0.098), detail * 0.7);
  vec3 green  = mix(vec3(0.106,0.243,0.118), vec3(0.204,0.298,0.133), detail);
  vec3 desert = mix(vec3(0.451,0.345,0.196), vec3(0.612,0.478,0.290), detail);
  vec3 iceCol = mix(vec3(0.662,0.733,0.784), vec3(0.816,0.859,0.894), detail);
  vec3 rock   = mix(vec3(0.157,0.141,0.129), vec3(0.243,0.220,0.200), detail);

  // 升温 → 绿地退化为荒漠 → 岩石
  float arid = smoothstep(296.0, 400.0, T);
  vec3 surf = mix(green, desert, arid);
  surf = mix(surf, rock, smoothstep(385.0, 475.0, T));

  vec3 col = mix(ocean, surf, land);

  // 海洋沸腾蒸干，露出海床
  float boil = smoothstep(372.0, 452.0, T);
  col = mix(col, rock * 0.62, (1.0 - land) * boil);

  col = mix(col, iceCol, ice * freeze);

  // 熔融：裂缝自发光
  float melt   = smoothstep(620.0, 900.0, T);
  float ridge  = 1.0 - abs(fbm3(sp * 3.3) - 0.5) * 2.0;
  float cracks = pow(clamp(ridge, 0.0, 1.0), 7.0);
  vec3  magma  = mix(vec3(0.204,0.043,0.020), vec3(0.965,0.396,0.106), cracks);
  col = mix(col, magma, melt);
  vec3 emissive = magma * cracks * melt * 1.8;

  // 光照
  float ndl = dot(normalize(vNrm), normalize(uLightDir));
  float day = smoothstep(-0.14, 0.32, ndl);

  // 城市灯火：夜面 + 陆地 + 非冰盖 + 人口
  float clus = fbm3(sp * 15.0);
  float city = smoothstep(0.575, 0.695, clus) * land * (1.0 - ice) * uPop;
  vec3 cityCol = vec3(0.949,0.737,0.353) * city * (1.0 - day) * 1.55;

  vec3 lit = col * (0.055 + day * 1.06) + cityCol + emissive;

  // 二向箔：光照塌缩为无光——二维没有法线可以接光，它变成一张画
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 flatCol = mix(col, vec3(lum), 0.24);
  vec3 flatLit = flatCol * 1.30 + 0.035 + emissive * 0.55 + cityCol * 0.45;
  lit = mix(lit, flatLit, vFlat);

  // 引力挤压：碎片带着塌缩时的余温，越靠近内核越亮，随飞散冷却
  if(uShatter > 0.0){
    float heat = smoothstep(0.06, 0.26, uShatter) * (1.0 - smoothstep(0.30, 0.95, uShatter));
    float depth = 1.0 - smoothstep(0.55, 1.0, length(vSurf));  // 近似：朝内的面更热
    lit += vec3(1.0, 0.46, 0.16) * heat * (0.55 + 0.45 * fbm3(vSurf * 9.0));
    lit *= 1.0 + heat * 0.5 * depth;
  }

  gl_FragColor = vec4(lit, 1.0);
}
`;

/* ── 大气 ────────────────────────────────────────────── */

const ATMO_VERT = `
varying vec3 vNrm;
varying vec3 vView;
varying float vFlat;

${DEFORM}

void main(){
  vNrm = normalize(normalMatrix * normal);
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
uniform vec3  uColor;
uniform float uDensity;
uniform float uShatter;
varying vec3 vNrm;
varying vec3 vView;
varying float vFlat;

void main(){
  float rim = pow(clamp(1.0 - abs(dot(normalize(vNrm), normalize(vView))), 0.0, 1.0), 2.4);
  float a = rim * uDensity * (1.0 - vFlat) * (1.0 - smoothstep(0.0, 0.26, uShatter));
  gl_FragColor = vec4(uColor * a * 1.6, a);
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
  vec3 sp = rotY(vSurf, uSpin);
  float c = fbm5(sp * 3.1 + vec3(0.0, 0.0, uSpin * 0.35));
  float a = smoothstep(0.52 - uCover * 0.26, 0.64, c) * uCover;
  if(a < 0.01) discard;

  float ndl = dot(normalize(vNrm), normalize(uLightDir));
  float day = smoothstep(-0.16, 0.34, ndl);

  vec3 col = mix(vec3(0.92,0.94,0.96), vec3(0.78,0.52,0.35), uTint);
  col *= 0.10 + day * 1.0;
  gl_FragColor = vec4(col, a * (1.0 - vFlat * 0.5) * (1.0 - smoothstep(0.0, 0.22, uShatter)));
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

      for(let k = 0; k < 3; k++){
        cen[(t+k)*3] = cx; cen[(t+k)*3+1] = cy; cen[(t+k)*3+2] = cz;
        dir[(t+k)*3] = dx; dir[(t+k)*3+1] = dy; dir[(t+k)*3+2] = dz;
        rnd[t+k] = r;
      }
    }
    geo.setAttribute('aCentroid', new THREE.BufferAttribute(cen, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));

    this.uPlanet = {
      uTemp:{value:288}, uPop:{value:1}, uSpin:{value:0},
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
      uColor:{value:new THREE.Color(0.32, 0.56, 0.92)}, uDensity:{value:0.85},
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
    const pc = Math.min(1, Math.pow(pressureAtm / 6, 0.62));
    const tk = Math.min(1, Math.max(0, (tempK - 150) / 120)) *
               Math.min(1, Math.max(0, (760 - tempK) / 180));
    this.uCloud.uCover.value = pc * (0.25 + 0.75 * tk);
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

    if(this.state === 'foil'){
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
      const op = Math.min(1, t / 0.20) * (1 - this._ss(0.26, 0.80, t));
      this.uCore.uOpacity.value = Math.max(0, op);
      this.core.visible = op > 0.002;
      const k = 0.55 + this._ss(0.0, 0.85, t) * 2.1;
      this.core.scale.set(k, k, 1);
      this.core.quaternion.copy(this.camera.quaternion);   // 始终正对相机

      if(t >= 1) this._finish();
    }

    this.renderer.render(this.scene, this.camera);
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
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
