// Planet rendering - Three.js
//
// Art direction: photoreal. A NASA base map (Solar System Scope, CC BY 4.0) underneath, with the
// effects of temperature and pressure layered on procedurally - ice caps, desertification, oceans
// boiling dry, molten fissures, each its own mask. The textures carry the material quality; the
// procedural layers keep the sliders meaningful.
//
// The mesh never rotates: spin is a UV offset (RepeatWrapping textures, so derivatives stay
// continuous and there is no seam). That way the foil compresses along a fixed world plane without
// turning with it, and lighting can use world-space normals directly.

import * as THREE from 'three';
import { EffectComposer }   from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass }       from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from '../vendor/jsm/postprocessing/OutputPass.js';
import { ShaderPass }       from '../vendor/jsm/postprocessing/ShaderPass.js';

/* -- Noise (only the molten fissures still need it) ------------------- */

export const NOISE = `
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
`;

/* -- Atmospheric circulation ------------------------------------------
   Clouds are not one texture sliding along. Real cloud decks are torn apart by zonal wind bands:
   the trade winds (0-30 degrees) blow east to west, so clouds move west; the westerlies (30-60)
   reverse and clouds move east; the polar easterlies (60-90) turn west again, weak and unsteady.
   Adjacent bands run in opposite directions, so their boundaries shear continuously - that is what
   a cloud deck in motion looks like, as opposed to a cloud deck being moved.

   Cloud cover is banded too: the intertropical convergence zone (whose real center sits near 6N
   rather than on the equator) is the thickest band; the subtropics near 25 are the descending branch
   of the Hadley cell and the thinnest; the storm track near 46 rises again. */
const WIND = `
float zonalWind(float s){          // s = sin(latitude), signed
  float a = abs(s);
  float trade = -0.60 * (1.0 - smoothstep(0.26, 0.56, a));
  float west  =  1.00 * smoothstep(0.32, 0.60, a) * (1.0 - smoothstep(0.76, 0.94, a));
  float polar = -0.32 * smoothstep(0.80, 0.97, a);
  return trade + west + polar;
}

/* The weights of the three bands and each band's zonal speed.
   The key point: the offset must be *constant within a band* and must not vary continuously with
   latitude. A constant offset has zero UV derivative, so it can accumulate arbitrarily far without
   blurring; a continuously varying one drags neighbouring latitudes' sample points further and
   further apart, the derivative explodes, and automatic mip selection smears the whole deck to grey.
   Bands are blended by weight, and that blend band reads exactly as the turbulent mixing zone inside
   a wind shear layer - which is physically what is there: two opposing flows stirring. */
vec3 bandWeights(float s){
  float a = abs(s);
  float wT = 1.0 - smoothstep(0.38, 0.52, a);
  float wW = smoothstep(0.40, 0.54, a) * (1.0 - smoothstep(0.80, 0.90, a));
  float wP = smoothstep(0.82, 0.92, a);
  return vec3(wT, wW, wP) / (wT + wW + wP + 1e-4);
}

// Trades blow west, westerlies east, polar easterlies west again
const vec3 BAND_SPEED = vec3(-0.60, 1.00, -0.32);

vec3 rotY(vec3 v, float ang){
  float c = cos(ang), s = sin(ang);
  return vec3(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
}

float cloudBand(float s){
  float a = abs(s);
  float itcz  =  1.00 * (1.0 - smoothstep(0.02, 0.26, abs(s - 0.10)));
  float dry   = -0.62 * (1.0 - smoothstep(0.00, 0.24, abs(a - 0.42)));
  float storm =  0.42 * (1.0 - smoothstep(0.00, 0.32, abs(a - 0.72)));
  return itcz + dry + storm;
}
`;

/* -- Vertex deformation (foil flattening + gravitational crush) ------- */

const DEFORM = `
uniform float uFoilX;    // foil sweep position (-1.9 -> +1.9)
uniform float uShatter;  // crush progress 0 -> 1
uniform float uSpread;   // spread factor once flattened
uniform vec2  uFracWin;  // fracture time window (start, spread): the crust cracks first, the mantle later
uniform float uBurstK;   // scatter speed multiplier: the deeper in, the denser, and the slower it flies

float flatAmount(vec3 p){
  return smoothstep(uFoilX + 0.30, uFoilX - 0.30, p.x);
}

// Flattening only. The clouds and atmosphere use this - they don't shatter, they just flatten and disperse with the planet.
vec3 flatten(vec3 p, out float outFlat){
  float f = flatAmount(p);
  outFlat = f;
  float spread = smoothstep(0.12, 1.0, f) * uSpread;
  p.xz *= 1.0 + spread * 0.52;
  p.y  *= 1.0 - f * 0.98;   // leave 2% thickness to avoid z-fighting between the two faces
  return p;
}

// Flatten plus shatter. Only the planet body takes this path.
//
// Shattering uses impulse-and-integrate, not position = f(progress). Displacement used to be driven
// by a smoothstep, whose derivative goes to zero at both ends - every fragment started and stopped
// at the same instant, the falsest thing in the whole effect.
// A fracture is an instantaneous impulse; after it there is no drag in vacuum, and speed is only
// reduced by the remnant core's gravity, so slow pieces fall back and fast ones never return.
// That long tail is free, as long as the displacement itself is never interpolated.
vec3 rotAxis(vec3 v, vec3 axis, float c, float s){
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

vec3 deform(vec3 p, vec3 cen, vec3 dir, vec3 axis, float rnd, float mass,
            out float outFlat, out vec3 outNrm, out float outBurst){
  outNrm = normalize(p);     // undeformed, the sphere normal is the direction itself
  outBurst = 0.0;
  p = flatten(p, outFlat);

  if(uShatter > 0.0){
    float s = uShatter;
    // rnd is already taken by the scatter speed. This needs an independent random value, otherwise
    // "fractured late" would always imply "flies slowly"
    float r2 = fract(rnd * 43758.5453);

    // The crack does not reach everywhere at once: each fragment has its own fracture time, collapsing
    // with the whole before it and stopping once it breaks. Staggering the two is what makes the
    // surface broken rather than smooth at the end of the collapse.
    float tFrac = uFracWin.x + r2 * uFracWin.y;
    float cs = min(s, tFrac);
    float squeeze = pow(cs / (uFracWin.x + uFracWin.y), 2.4) * 0.26;   // the exponent: the further it collapses the stronger gravity gets
    p   *= 1.0 - squeeze;
    cen *= 1.0 - squeeze;

    float tb = s - tFrac;
    if(tb > 0.0){
      outBurst = tb;
      vec3 local = p - cen;
      // Tumbling at a constant rate around an independent random axis - nothing in vacuum slows it
      // down. Reusing the scatter direction as the axis would spin each fragment about its flight
      // axis, keeping it face-on to the camera: a floor covered in confetti.
      // Bigger pieces turn slower: the same impulse torque against a larger moment of inertia.
      float ang = (rnd * 2.0 - 1.0) * 17.0 * mix(1.55, 0.40, mass) * tb;
      float c = cos(ang), si = sin(ang);
      local  = rotAxis(local,  axis, c, si);
      outNrm = rotAxis(outNrm, axis, c, si);   // the normal has to turn with its fragment
      // Spread of initial speeds: rnd cubed lengthens the tail, then it is divided by mass - the same
      // impulse sends a small piece faster.
      // The quadratic term is the remnant core's gravity, which pulls slow fragments back.
      float v0   = (0.42 + rnd * rnd * rnd * 3.4) * mix(1.50, 0.52, mass) * uBurstK;
      float disp = max(0.0, v0 * tb - 0.34 * tb * tb);
      p = cen + local + dir * disp;
    }
  }
  return p;
}
`;

/* -- Planet body ------------------------------------------------------ */

const PLANET_VERT = `
attribute vec3 aCentroid;
attribute vec3 aDir;
attribute vec3 aAxis;
attribute float aRnd;
attribute float aMass;

varying vec2 vUv;
varying vec3 vSurf;
varying vec3 vNrm;
varying vec3 vPos;
varying float vFlat;
varying float vBurst;

${DEFORM}

void main(){
  vUv   = uv;
  vSurf = normalize(position);   // undeformed direction: textures and surface properties are all sampled by it, so nothing slides during the shatter

  float f, burst;
  vec3 nrm;
  vec3 p = deform(position, aCentroid, aDir, aAxis, aRnd, aMass, f, nrm, burst);
  vFlat  = f;
  vNrm   = nrm;                  // used for lighting: a tumbling fragment has to change shade as it turns
  vPos   = p;                    // the mesh has no transform, so object space is world space
  vBurst = burst;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const PLANET_FRAG = `
precision highp float;

uniform sampler2D uDay;      // NASA daytime color map
uniform sampler2D uNight;    // NASA night lights
uniform sampler2D uSpec;     // water mask (white = water)
uniform sampler2D uCloudTex; // used for cloud shadows on the surface

// Four temperature channels: one target value, four following speeds. The slider changes the energy
// being injected, and each subsystem responds with its own heat capacity - ice is slowest, rock
// fastest. The constants are ENV_TAU in planet.js.
uniform vec4  uTempLag;      // x=ice y=vegetation z=ocean w=rock, in K
uniform float uPop;          // 0..1
uniform float uSpinUV;       // spin = horizontal UV offset
uniform float uShatter;
uniform float uCover;        // cloud cover
uniform float uWind;         // accumulated zonal displacement, shared with the cloud layer
uniform float uCrustT;       // lithosphere temperature: a channel even slower than the ice
uniform float uCharge;       // gravitational charge 0..1: the crust is stressed first, and the fissures light first
uniform vec4  uImpacts[8];   // impact slots: xyz is the de-spun direction, w is age in seconds (negative = empty)
uniform float uImpactSize[8];
uniform float uFire;         // current fire intensity (driven by thermal shock)
uniform float uBurn;         // cumulative burned area
uniform float uCoreGlow;     // core brightness, used to light the inner faces of fragments
uniform vec3  uLightDir;

varying vec2 vUv;
varying vec3 vSurf;
varying vec3 vNrm;
varying vec3 vPos;
varying float vFlat;
varying float vBurst;

${NOISE}
${WIND}

/* Ice coverage. Factored into a function so it can be evaluated again on a second, slower
   temperature channel: the difference between the two is exactly "where the ice has just retreated
   from". The ice margin is not a line of latitude - noise breaks the boundary up. The sea freezes
   first (thin ice spreads fast, while a land ice sheet has to be built up snowfall by snowfall, so
   water gets an extra push), and dry bright highlands and deserts radiate heat away fastest, so they
   go white early too. */
float iceAmount(float T, float lat, float water, float alt, float nLow, float nMid){
  float freeze = smoothstep(296.0, 214.0, T);
  float line = mix(1.16, -0.12, freeze)
             + (nLow - 0.5) * 0.17 + (nMid - 0.5) * 0.06
             - water * 0.13 - alt * 0.10;
  return smoothstep(line - 0.10, line + 0.05, lat) * freeze;
}

void main(){
  vec2 uv = vec2(vUv.x + uSpinUV, vUv.y);   // RepeatWrapping handles the wrap
  // n0 is the coordinate for surface properties (ice by latitude, lava by noise) and does not tumble
  // with a fragment; N is the shading normal and must tumble. Keeping them separate is what lets the
  // fragments feel alive.
  vec3 n0 = normalize(vSurf);
  vec3 N  = normalize(vNrm);
  if(!gl_FrontFacing) N = -N;               // a fracture face pointing outward needs its normal flipped
  float lat = abs(n0.y);

  vec3  base   = texture2D(uDay, uv).rgb;
  float water  = texture2D(uSpec, uv).r;
  float relief = dot(base, vec3(0.299, 0.587, 0.114));

  // Two shared noise fields: low frequency places the patches, mid frequency breaks up the edges.
  // What gives the temperature effects away is never the palette, it is the whole planet changing
  // along one curve - a real phase change has a front, an order, a raggedness. The four sections
  // below are all about restoring that.
  float nLow = fbm3(n0 * 3.4) * 0.5 + 0.5;
  float nMid = fbm3(n0 * 6.1) * 0.5 + 0.5;

  // -- Ice caps: advancing from the poles as it cools
  float alt = clamp((relief - 0.44) * 2.2, 0.0, 1.0) * (1.0 - water);
  float ice = iceAmount(uTempLag.x, lat, water, alt, nLow, nMid);
  // The edge of sea ice is broken. High-frequency noise is mixed in only within the transition band -
  // (1-|2i-1|) peaks at i=0.5 and vanishes at both ends, so the interior of the cap and the open water
  // are untouched, and only the ring of floes at the boundary breaks up.
  // Land is excluded: a snow line is naturally tidier than a sea-ice edge.
  float floe = snoise(n0 * 24.0) * 0.5 + 0.5;
  ice = clamp(ice + (floe - 0.5) * 1.15 * (1.0 - abs(ice * 2.0 - 1.0)) * water, 0.0, 1.0);
  // Sea ice is flat and slightly blue-grey; land snow is brighter and has relief. Albedo is held below
  // the bloom threshold (1.10), or the entire snowball would blow out into a white sheet at once.
  vec3  seaIce  = vec3(0.612, 0.664, 0.716);
  vec3  snow    = vec3(0.716, 0.742, 0.776) * (0.88 + nMid * 0.16);
  vec3  iceCol  = mix(snow, seaIce, water);
  iceCol *= 0.86 + relief * 0.42;   // let a little of the base map's shading through: mountains are still readable under the snowfield
  base = mix(base, iceCol, ice * 0.94);

  // -- Desertification: vegetation fading to sand as it warms
  float veg = clamp((base.g - (base.r + base.b) * 0.5) * 4.2, 0.0, 1.0);
  // Not everywhere at once. The subtropics are the descending branch of the Hadley cell and dry out
  // first; equatorial rainforest has the most moisture and collapses last. Multiplying by a patch
  // noise makes the drought front something gnawed out rather than pushed flat.
  float belt = smoothstep(0.10, 0.40, lat) * (1.0 - smoothstep(0.60, 0.94, lat));
  float arid = smoothstep(292.0, 402.0, uTempLag.y);
  arid = clamp(arid * (0.42 + 0.88 * belt) * (0.52 + 0.80 * nLow), 0.0, 1.0);
  vec3 sand = mix(vec3(0.470, 0.392, 0.286), vec3(0.624, 0.498, 0.322), nMid);
  base = mix(base, sand, arid * veg * (1.0 - water) * 0.92);

  // -- Fires: thermal shock hitting vegetation that has had no time to adapt.
  // Intensity comes from uFire (the gap between the target temperature and the vegetation channel,
  // times a flammable temperature band), so easing the slider along never starts a fire and yanking
  // it up does - what burns is the part of the biosphere that could not keep up.
  float land = (1.0 - water) * (1.0 - ice);
  vec3  fq   = n0 * 7.4 + vec3(0.0, uWind * 3.2, 0.0);
  // A fire front is a front, not scattered dots. Taking the zero crossing of the noise (its ridge)
  // is what gives a continuous fire line; raising the noise to a high power directly only yields
  // sparse isolated points, too dim to see.
  float fr    = 1.0 - abs(fbm3(fq)) * 2.6;
  float front = pow(clamp(fr, 0.0, 1.0), 4.0);
  float fire  = uFire * veg * land * front;

  // Burn scars: charred patches that spread with the cumulative burned area and fade slowly once the
  // vegetation recovers. The low-frequency noise field is reused - a burn scar is a large thing anyway.
  float scar = smoothstep(1.02 - uBurn * 1.18, 1.04 - uBurn * 1.18, nLow) * veg * land;
  base = mix(base, vec3(0.074, 0.060, 0.050), scar * 0.92);

  // Smoke drags downwind: sampling the fire intensity upwind gives "the smoke here was made over there".
  // east is the local eastward tangent; when zonalWind is negative (the trades) upwind is to the east
  // and the sign flips on its own.
  vec3  east   = normalize(vec3(-n0.z, 0.0, n0.x) + vec3(1e-5));
  vec3  upwind = fq - east * (zonalWind(n0.y) * 1.15);
  float sr     = 1.0 - abs(fbm3(upwind)) * 2.6;
  float smoke  = pow(clamp(sr, 0.0, 1.0), 2.2) * uFire * land;
  base = mix(base, vec3(0.300, 0.266, 0.232), clamp(smoke * 1.15, 0.0, 0.78));

  // -- Oceans boiling dry: the shallows go first, then the basins.
  // Proximity to shore is decided by sampling the water mask at four points; land in the neighbourhood
  // means shallow water. Darkening the whole ocean uniformly reads as seawater changing color; the
  // shelves surfacing before the basins is what reads as the sea retreating.
  // Shallow and deep follow separate curves: shallow dries first, deep later, and both eventually
  // reach 1. It used to be one curve discounted by depth, and the deep basins then only ever dried
  // out about forty percent however hot it got - a patch of blue left at maximum temperature, which
  // was the falsest thing of all.
  float boilShallow = smoothstep(362.0, 438.0, uTempLag.z);
  float boilDeep    = smoothstep(424.0, 516.0, uTempLag.z);
  float e = 0.010;
  float near = texture2D(uSpec, uv + vec2( e, 0.0)).r
             + texture2D(uSpec, uv + vec2(-e, 0.0)).r
             + texture2D(uSpec, uv + vec2(0.0,  e)).r
             + texture2D(uSpec, uv + vec2(0.0, -e)).r;
  float shelf = 1.0 - near * 0.25;                       // 0 = deep basin, 1 = shoreline
  float dry   = mix(boilDeep, boilShallow, shelf);
  vec3  bed   = mix(vec3(0.088, 0.076, 0.068), vec3(0.186, 0.158, 0.132),
                    shelf * (0.45 + 0.55 * nMid));
  base = mix(base, bed, water * dry);

  // -- Impacts (survival mode). One loop computes three masks: the scar has to be pressed into base
  // before lighting, while the heat and the shock ring wait until after emissive is declared.
  // The direction is rotated back by the current spin (what is stored is the de-spun direction; see
  // the IMPACT_SGN derivation in planet.js): n0 does not follow the texture, so storing a world
  // direction directly would make the flash slide across the ground.
  float impScar = 0.0, impHot = 0.0, impRing = 0.0;
  {
    float sa = uSpinUV * 6.2831853;
    float cs = cos(sa), sn = sin(sa);
    for(int i = 0; i < 8; i++){
      vec4 im = uImpacts[i];
      if(im.w >= 0.0){                                        // no continue: old drivers dislike it
        vec3  d   = vec3(im.x * cs - im.z * sn, im.y, im.x * sn + im.z * cs);   // rotY(im.xyz, sa)
        float ang = sqrt(max(0.0, 2.0 - 2.0 * dot(n0, d)));  // chord length is close enough to angular distance, saving an acos
        float rc  = uImpactSize[i] * 0.9;                     // the crater's angular radius is about the rock's radius in radians: an r=0.12 rock leaves a crater about 6 degrees across
        float age = im.w;
        float a2  = ang + (nMid - 0.5) * rc * 0.7;            // the rim is gnawed by mid-frequency noise: a crater is not drawn with a compass
        float spot = 1.0 - smoothstep(rc * 0.55, rc * 1.35, a2);
        // Flash (0.15s) + residual heat (2.5s) + dark red embers (9s): only these three timescales stacked read as "struck, then cooling"
        impHot += spot * (1.6 * exp(-age / 0.15) + exp(-age / 2.5) + 0.35 * exp(-age / 9.0));
        float rr = rc + age * 0.10;                           // the shock ring travels out, widening and fading: done within a second, not expanding into a ring half the planet across
        impRing += (1.0 - smoothstep(0.0, 0.025 + age * 0.02, abs(a2 - rr))) * exp(-age / 0.6);
        impScar = max(impScar, spot * exp(-age / 60.0));      // the scar is slowly covered by dust over a minute
      }
    }
  }
  // Scars only remain on land and on dried-out sea floor: water closes over them
  base = mix(base, vec3(0.050, 0.038, 0.032), impScar * 0.88 * (1.0 - water * (1.0 - dry)));

  // -- Melting: fissures appear, then widen, then merge into a magma sea
  float melt  = smoothstep(620.0, 900.0, uTempLag.w);
  float rn    = fbm3(n0 * 3.1);
  float ridge = 1.0 - abs(rn) * 1.7;
  // The exponent falls as melting progresses: thin cracks -> wide cracks -> continuous. With a fixed
  // exponent the magma is the same width from start to finish and merely gets brighter, which is not
  // melting, it is turning up the brightness.
  float cracks = pow(clamp(ridge, 0.0, 1.0), mix(11.0, 3.4, melt));
  vec3  magma  = mix(vec3(0.120,0.024,0.010), vec3(1.000,0.398,0.098), cracks);
  // White heat is reserved for the stretch that is genuinely near total melt. Given out earlier, the planet smears into a star at eight hundred degrees.
  magma = mix(magma, vec3(1.000, 0.664, 0.302), cracks * smoothstep(0.80, 1.0, melt));
  base = mix(base, magma * 0.30, melt);
  vec3 emissive = magma * cracks * melt * 3.2;      // above 1 this goes to bloom

  // -- Crustal activity: before melting, thermal stress tears thin fissures in the crust, and where the
  // ice has retreated there is a second pathway.
  // Ice unloading -> upper crust rebounds and depressurizes -> decompression melting. After the last
  // deglaciation Iceland erupted at 30-50 times today's rate for over a thousand years. Here, the
  // lithosphere channel lagging behind the ice channel is what locates where the ice margin has been:
  // the difference between the ice computed on the two channels is exactly the ring just unloaded.
  float iceWas = iceAmount(uCrustT, lat, water, alt, nLow, nMid);
  float freed  = clamp(iceWas - ice, 0.0, 1.0);
  float rift   = clamp(smoothstep(455.0, 690.0, uTempLag.w) * (1.0 - melt) + freed * 0.55, 0.0, 1.0);
  // The fissures need their own, much narrower ridge. The factor 1.7 in ridge was tuned for the magma
  // sea and is so wide it is positive almost everywhere; no exponent can hold that back - the same
  // noise value has to be re-evaluated with a different factor.
  float fissure = pow(clamp(1.0 - abs(rn) * 10.0, 0.0, 1.0), 2.0);
  // Volcanism comes in provinces rather than opening evenly along every crack; it happens under the sea too, just never that bright
  fissure *= smoothstep(0.50, 0.86, nLow) * (1.0 - water * 0.62);
  emissive += vec3(1.00, 0.30, 0.05) * fissure * rift * 3.6;

  // Gravitational charge: the external force tears at the whole crust, regardless of province and
  // regardless of melting - which is why it is not folded into rift (that one is held back by (1-melt)
  // and the province mask, so folding it in would light only a few provinces and nothing at all on a
  // molten planet).
  // Squared: the glow only arrives in the second half while the shaking has been rising from the
  // start, giving two stages rather than one.
  // This ridge has no province mask and is far denser than the rift one, so its factor has to sit well
  // below 3.6: at 1.2 a full charge only just crosses the bloom threshold and the fissures read as
  // bright lines rather than white blobs. At 2.4 whole continents blow out to white and the surface
  // is smeared away - exactly the over-exposure the README warns about.
  float fissureAll = pow(clamp(1.0 - abs(rn) * 10.0, 0.0, 1.0), 3.0);
  emissive += vec3(1.00, 0.30, 0.05) * fissureAll * (1.0 - water * 0.85) * uCharge * uCharge * 1.2;

  emissive += vec3(1.00, 0.34, 0.06) * fire * 3.0;

  // Impact glow. The 0.9 factor: for the half second after landing the hot spot just crosses the bloom
  // threshold (a flash), then falls back to a dark red afterglow that doesn't clip - at 3.2 every
  // crater is a solid white blob smearing half the planet. The shock ring stays under the threshold
  // and hugs the ground.
  emissive += vec3(1.00, 0.52, 0.20) * impHot  * 0.9 * (0.6 + 0.8 * nMid);
  emissive += vec3(1.00, 0.36, 0.10) * impRing * 0.35;

  float wet = water * (1.0 - dry) * (1.0 - ice);    // the part that is still liquid water

  // -- Surface relief. This layer is the line between "the whole planet is changing" and "a picture has
  // been pasted on": change only the albedo and the light treats every material identically, which
  // always reads as a sticker; change the normal and snow ridges, dunes and lava slopes grow out of
  // the terminator, and the materials hold up.
  vec3  Tg = normalize(cross(vec3(0.0, 1.0, 0.0), n0) + vec3(1e-4));
  vec3  Bg = cross(n0, Tg);

  // Base terrain takes its gradient straight from the base map: that is real imagery, the mountain
  // ranges are already in it, and it is far more convincing than inventing a layer out of noise -
  // noise spread over a continent just turns it into sandpaper.
  float eT = 0.0026;
  float lu = dot(texture2D(uDay, uv + vec2(eT, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
  float lv = dot(texture2D(uDay, uv + vec2(0.0, eT)).rgb, vec3(0.299, 0.587, 0.114));
  vec2  gTex = vec2(lu - relief, lv - relief) * (1.0 - water * (1.0 - dry)) * 7.0;

  // The procedural layer only appears once the material has genuinely changed: snow ridges are coarse
  // and gentle, dunes and lava slopes fine and dense. A 288K Earth therefore has essentially only the
  // base map's own relief, with no gratuitous layer of noise on top.
  float procA = max(max(ice, arid * 0.70), melt * 0.85);
  float bumpK = mix(20.0, 5.2, ice);
  float eB = 0.030;
  float hC = snoise(n0 * bumpK);
  float hT = snoise((n0 + Tg * eB) * bumpK);
  float hB = snoise((n0 + Bg * eB) * bumpK);
  vec2  gPro = vec2(hT - hC, hB - hC) * procA * 0.28;

  N = normalize(N - Tg * (gTex.x + gPro.x) - Bg * (gTex.y + gPro.y));

  // -- Lighting. The mesh never rotates, so world-space normals can face the sun directly.
  vec3 L = normalize(uLightDir);
  float ndl = dot(N, L);
  float day = smoothstep(-0.06, 0.14, ndl);

  // Cloud shadows: sample the same cloud texture at a small UV offset along the light direction.
  // *The banded offset must match the cloud layer exactly*, or the shadow slides out from under its
  // cloud. The formation/dissipation layer is left out - a shadow is soft anyway, and three more
  // noise evaluations for it are not worth it.
  vec3  wB = bandWeights(n0.y);
  vec3  oB = BAND_SPEED * uWind;
  vec2  sB = vec2(uv.x + 0.008, uv.y - 0.004);
  float cShadow = wB.x * texture2D(uCloudTex, sB + vec2(oB.x, 0.0)).r
                + wB.y * texture2D(uCloudTex, sB + vec2(oB.y, 0.0)).r
                + wB.z * texture2D(uCloudTex, sB + vec2(oB.z, 0.0)).r;
  float coverHere = clamp(uCover * (1.0 + 0.30 * cloudBand(n0.y)), 0.0, 1.4);
  day *= 1.0 - smoothstep(0.30, 0.82, cShadow) * coverHere * 0.42;

  // Terminator tint: grazing light travels through more atmosphere and goes red
  vec3 warm = mix(vec3(1.0, 0.98, 0.95), vec3(1.0, 0.60, 0.34),
                  smoothstep(0.38, 0.0, ndl) * smoothstep(-0.14, 0.10, ndl));

  vec3 lit = base * day * warm * 1.22;
  lit += base * vec3(0.034, 0.044, 0.066) * (1.0 - day);   // skylight on the night side, so it isn't crushed to pure black

  // -- How each material responds to light. With only the albedo differing, ice, sand and magma are the
  // same substance under the light, and that is precisely where "a layer pasted on" comes from. The
  // three terms below give each of them its own optical behaviour.

  vec3 V = normalize(cameraPosition - vPos);
  vec3 H = normalize(L + V);

  // Water: a very tight specular highlight
  float spec = pow(max(dot(N, H), 0.0), 1100.0) * wet * smoothstep(-0.02, 0.16, ndl);
  lit += vec3(1.0, 0.95, 0.86) * spec * 1.9;               // above 1 this goes to bloom

  // Ice: a much wider specular lobe, and blue shadows - multiple scattering inside the ice eats the
  // red end, which is one of the most recognizable features of snow. It also scatters light sideways,
  // so the night side never crushes to black.
  float iceSpec = pow(max(dot(N, H), 0.0), 46.0) * ice * smoothstep(-0.04, 0.20, ndl);
  lit += vec3(0.80, 0.88, 1.00) * iceSpec * 0.85;
  lit += vec3(0.055, 0.085, 0.150) * ice * (1.0 - day) * 1.15;

  // Sand: the opposition effect of a rough surface - backscatter peaks when the view and light directions nearly coincide, which is why deserts go white at noon
  float back = pow(max(dot(V, L), 0.0), 3.5) * arid * (1.0 - water) * day;
  lit += vec3(0.42, 0.34, 0.22) * back * 0.55;

  // -- City lights: the raw NASA night-lights image
  vec3 night = texture2D(uNight, uv).rgb;
  lit += night * pow(1.0 - day, 1.5) * uPop * 2.3 * (1.0 - ice * 0.85);

  // Fire lines are what really stand out on the night side - satellite fire detection works off exactly this thermal anomaly
  lit += vec3(1.00, 0.30, 0.05) * fire * (1.0 - day) * 4.5;

  // -- Thermal radiation. Visible as dark red from about 650K and obvious by 900K. This term treats day
  // and night alike: once it is hot enough the entire night hemisphere burns rather than just the
  // fissures - and the difference between "the whole planet is changing" and "a layer pasted on"
  // finally comes down to terms like this one that ignore the day/night divide.
  float glowT = smoothstep(645.0, 1010.0, uTempLag.w);
  lit += vec3(1.00, 0.22, 0.040) * pow(glowT, 2.3) * 1.8;

  lit += emissive;

  // -- The foil: lighting collapses to no lighting and the color information goes with it - it becomes a painting
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  vec3 flatLit = mix(base, vec3(lum), 0.26) * 1.42 + emissive * 0.55;
  lit = mix(lit, flatLit, vFlat);

  // -- The collapse front. The light of this strike comes from the energy matter releases as it loses a
  // dimension, not from the foil glowing - which is why it grows on the sphere and follows its
  // curvature instead of floating in front of the image.
  // vFlat's transition band is the front, and this takes its peak; it must be applied after the mix
  // above, or the flattened unlit palette would dilute it.
  if(vFlat > 0.001 && vFlat < 0.999){
    // The high exponent narrows the front: the transition band is itself 0.6 of a radius wide, and
    // using its peak directly smears into a blur that bloom then spreads into a white sheet.
    float front = pow(vFlat * (1.0 - vFlat) * 4.0, 7.0);
    // Matter does not collapse uniformly, so the front is torn rather than a clean line
    float grain = 0.30 + 0.70 * (fbm3(n0 * 16.0) * 0.5 + 0.5);
    // The red channel has to stay below 1. With all three channels over 1, ACES compresses it to white -
    // the entire difference between "intense blue light" and "white light" is here, not in brightness.
    lit += vec3(0.12, 0.42, 1.00) * front * grain * 2.2;  // above 1 this goes to bloom
  }

  // -- Gravitational crush
  if(uShatter > 0.0){
    // The afterglow hangs off this fragment's own scatter timing rather than global progress -
    // otherwise two thousand pieces light up and go out together, and no amount of good scattering
    // would hide it.
    float b     = vBurst;
    float heat  = smoothstep(0.0, 0.04, b) * (1.0 - smoothstep(0.06, 0.34, b));
    float grain = fbm3(n0 * 7.0) * 0.5 + 0.5;

    // The heat is on the fracture faces, not on the crust. The crust keeps whatever color it had -
    // brushing the afterglow evenly over every face turns two thousand fragments into orange leaves.
    if(!gl_FrontFacing){
      // The back face is freshly exposed mantle: no land or sea, no clouds, just rock and the heat
      // brought up from the center.
      // The material used to be FrontSide, so a fragment turning over was culled outright - thin
      // flakes blinking in and out, which is worse than "like confetti": it isn't even a solid.
      float d = fbm3(n0 * 11.0) * 0.5 + 0.5;
      vec3 rock = mix(vec3(0.052, 0.040, 0.036), vec3(0.128, 0.104, 0.092), d);
      lit = rock * (0.22 + 0.92 * max(dot(N, L), 0.0))
          + vec3(1.0, 0.36, 0.10) * heat * (0.40 + 0.80 * grain) * 1.75;
    }else{
      lit += vec3(1.0, 0.42, 0.14) * heat * grain * 0.20;   // the crust face gets only a touch: any more and the oceans go purple
    }

    // A triangle has no thickness and thins to a line when seen edge-on; a real rock would be showing
    // its rough side at that angle. A view-dependent falloff adds a dark edge so that it at least
    // reads as having volume.
    float edgeOn = 1.0 - abs(dot(N, V));
    lit = mix(lit, lit * 0.22, pow(edgeOn, 4.0));

    // Light from the core. The inner faces of fragments being lit by it is the most direct evidence
    // that there is something inside; without that light, a broken planet is just a skin blown apart.
    float cd = length(vPos);
    float cl = max(dot(N, -vPos / max(cd, 1e-4)), 0.0);
    lit += vec3(1.0, 0.44, 0.14) * cl * uCoreGlow / (0.30 + cd * cd);

    lit *= 1.0 - smoothstep(0.0, 0.18, uShatter) * 0.35;   // darken overall during the collapse
    lit *= 1.0 - smoothstep(0.10, 0.80, b) * 0.55;         // and cool down once it has flown far
  }

  gl_FragColor = vec4(lit, 1.0);
}
`;

/* -- Atmosphere ------------------------------------------------------- */

const ATMO_VERT = `
varying vec3 vWorld;
void main(){
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}

`;

const ATMO_FRAG = `
precision highp float;

// Analytic single scattering. The atmosphere is not expressed through mesh shape: for each view ray
// this finds the chord it actually travels through the atmosphere and integrates along it, with
// density falling off exponentially with height, so it reaches zero at the outer edge naturally and
// there is no visible boundary. The previous approach was a spherical shell plus fresnel, and that
// shell's geometric outer edge was exactly where the "membrane" look came from.
uniform vec3  uLightDir;
uniform float uDensity;   // driven by pressure
uniform float uFade;      // overall fade-out during the foil strike or the crush
uniform vec3  uTint;      // temperature-driven color shift

varying vec3 vWorld;

const float Rp = 1.00;    // planet radius
const float Ra = 1.14;    // outer edge of the atmosphere (about 1.016 in reality, exaggerated here to be visible)
const float H  = 4.2;     // inverse scale height: larger falls off faster

// Ray-sphere intersection. Returns an empty interval when there is no hit.
vec2 raySphere(vec3 ro, vec3 rd, float R){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if(d < 0.0) return vec2(1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

void main(){
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);

  vec2 atm = raySphere(ro, rd, Ra);
  if(atm.y <= 0.0 || atm.x >= atm.y) discard;

  float t0 = max(atm.x, 0.0);
  float t1 = atm.y;

  // If the view ray hits the planet body, integrate only up to there - atmosphere behind the planet is not visible
  vec2 pl = raySphere(ro, rd, Rp);
  if(pl.x < pl.y && pl.y > 0.0) t1 = min(t1, max(pl.x, 0.0));
  if(t1 <= t0) discard;

  vec3 L = normalize(uLightDir);
  // Per-pixel jittered start. Evenly spaced samples leave visible concentric banding on a thin-shell integral like this.
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  const int STEPS = 12;
  float seg = (t1 - t0) / float(STEPS);

  vec3 acc = vec3(0.0);

  for(int i = 0; i < STEPS; i++){
    vec3 p = ro + rd * (t0 + (float(i) + jit) * seg);
    float h = clamp((length(p) - Rp) / (Ra - Rp), 0.0, 1.0);
    float dens = exp(-h * H) * seg;

    // Whether this sample point is shadowed from the sun by the planet (this is what places the terminator)
    vec2 toSun = raySphere(p, L, Rp);
    float lit = (toSun.x < toSun.y && toSun.y > 0.0) ? 0.0 : 1.0;

    // How much atmosphere the sunlight passed through to reach this point. The thicker it is, the more
    // blue is scattered away and the redder what remains - the colors of a sunset come out of this on
    // their own, with nothing tuned by hand.
    vec2 sunExit = raySphere(p, L, Ra);
    float sunDepth = exp(-h * H) * max(sunExit.y, 0.0) * 1.20;
    vec3 sunCol = exp(-sunDepth * vec3(0.40, 1.00, 2.30));

    acc += dens * lit * sunCol;
  }

  // Rayleigh scattering goes as 1/lambda^4, strongest at the blue end
  vec3 rayleigh = vec3(0.30, 0.54, 1.00) * uTint;
  vec3 col = acc * rayleigh * 3.4 * uDensity;

  gl_FragColor = vec4(col * uFade, 1.0);
}

`;

/* -- Cloud layer ------------------------------------------------------ */

const CLOUD_VERT = `
varying vec2 vUv;
varying vec3 vSurf;
varying float vFlat;

${DEFORM}

void main(){
  vUv   = uv;
  vSurf = normalize(position);
  float f;
  vec3 p = flatten(position, f);
  vFlat = f;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const CLOUD_FRAG = `
precision highp float;
uniform sampler2D uCloudTex;
uniform float uShatter;
uniform float uSpinUV;
uniform float uWind;
uniform float uCover;
uniform float uTint;
uniform vec3  uLightDir;
varying vec2 vUv;
varying vec3 vSurf;
varying float vFlat;

${NOISE}
${WIND}

void main(){
  vec3 n0 = normalize(vSurf);

  // Clouds are carried by wind, and the primary motion is *translation*. To dodge the mip blurring,
  // advection was once replaced by "oscillating shear plus an in-place deformation field": the
  // oscillation slid the clouds back and forth while the field twisted each mass in place - that is
  // not motion, that is procedural deformation, and it is obvious at a glance.
  // The right answer is a constant offset per band: rigid translation within a band (zero UV
  // derivative, no blurring, and it can accumulate without bound) blended between bands by weight.
  // See the comment on bandWeights().
  vec3 w   = bandWeights(n0.y);
  vec3 off = BAND_SPEED * uWind;
  vec2 b   = vec2(vUv.x + uSpinUV, vUv.y);
  float c = w.x * texture2D(uCloudTex, b + vec2(off.x, 0.0)).r
          + w.y * texture2D(uCloudTex, b + vec2(off.y, 0.0)).r
          + w.z * texture2D(uCloudTex, b + vec2(off.z, 0.0)).r;

  // Formation and dissipation: rigidly advected per band as well. Holding the modulating pattern
  // still while the clouds move produces "a stationary pattern laid over moving clouds", which is
  // worse than having no formation at all. The third dimension drifts with time and does the forming
  // and dissolving.
  float tD = uWind * 12.0;   // the rhythm of formation is decoupled from advection: slower wind shouldn't lengthen a cloud's life
  float flow = w.x * (snoise(rotY(n0, off.x * 6.2831853) * 3.6 + vec3(0.0, tD, 0.0)) * 0.5 + 0.5)
             + w.y * (snoise(rotY(n0, off.y * 6.2831853) * 3.6 + vec3(0.0, tD, 0.0)) * 0.5 + 0.5)
             + w.z * (snoise(rotY(n0, off.z * 6.2831853) * 3.6 + vec3(0.0, tD, 0.0)) * 0.5 + 0.5);

  // Banded cloud cover: thickest at the intertropical convergence zone, thinnest at the subtropical
  // descending branch, rising again at the mid-latitude storm track.
  // The weight is kept small: this cloud map is real observation and already contains that climatology,
  // so pushing it harder cuts the bands too sharply.
  float cover = clamp(uCover * (1.0 + 0.30 * cloudBand(n0.y)), 0.0, 1.4);

  // cover pushes the threshold (at low pressure only the thickest cores survive), then scales the opacity overall
  float a = smoothstep(0.30 - cover * 0.22, 0.74 - cover * 0.22, c);
  a *= clamp(cover * 2.4, 0.0, 1.0);
  a *= 0.62 + 0.98 * flow;          // density waves: clouds form here and dissipate there
  if(a < 0.012) discard;

  vec3 L  = normalize(uLightDir);
  float ndl = dot(n0, L);
  float day = smoothstep(-0.10, 0.18, ndl);

  vec3 warm = mix(vec3(1.0, 0.99, 0.97), vec3(1.0, 0.64, 0.40),
                  smoothstep(0.38, 0.0, ndl) * smoothstep(-0.16, 0.12, ndl));

  vec3 col = mix(vec3(0.95, 0.96, 0.98), vec3(0.72, 0.44, 0.28), uTint);
  // A cloud's albedo is about 0.7, the brightest thing on the day side; it must not be darker than the sea.
  col *= (0.040 + day * 1.02) * warm;

  gl_FragColor = vec4(col, a * (1.0 - vFlat * 0.55) * (1.0 - smoothstep(0.0, 0.22, uShatter)));
}
`;

/* -- Mantle and core ---------------------------------------------------
   With only the shell breaking apart and nothing inside, the planet reads as a balloon. The mantle
   and core normally hide behind the opaque crust and are revealed only during the gravitational
   crush: the mantle fractures later than the crust, into larger and slower pieces, and the core does
   not fracture at all - it is compressed, lit up, and left behind as an ember.
   The core is also the light source for the inner faces of the fragments, and "there is something
   inside" mostly stands on that light. */

const MANTLE_FRAG = `
precision highp float;
uniform vec3  uLightDir;
uniform float uShatter;
uniform float uCoreGlow;

varying vec3 vSurf;
varying vec3 vNrm;
varying vec3 vPos;
varying float vBurst;

${NOISE}

void main(){
  vec3 n0 = normalize(vSurf);
  vec3 N  = normalize(vNrm);
  if(!gl_FrontFacing) N = -N;

  float d     = fbm3(n0 * 5.5) * 0.5 + 0.5;
  // The factor decides how wide the "cracks" are. At 1.9 the ridge is positive almost everywhere -
  // that isn't a fissure, that is the whole sphere glowing. Narrow cracks need a large factor and a
  // high exponent.
  float ridge = 1.0 - abs(fbm3(n0 * 3.4)) * 3.4;
  float vein  = pow(clamp(ridge, 0.0, 1.0), 6.0);

  vec3 rock = mix(vec3(0.070, 0.052, 0.046), vec3(0.150, 0.118, 0.100), d);
  vec3 L = normalize(uLightDir);
  vec3 lit = rock * (0.16 + 0.86 * max(dot(N, L), 0.0));

  // Veins of melt: brighter the tighter it is compressed, cooling with the scatter once it breaks apart
  float squeezed = smoothstep(0.0, 0.28, uShatter) * (1.0 - smoothstep(0.0, 0.42, vBurst));
  lit += mix(vec3(0.85, 0.18, 0.03), vec3(1.0, 0.60, 0.20), vein)
         * vein * (0.30 + 0.90 * squeezed) * 1.6;

  // Light from the core
  float cd = length(vPos);
  float cl = max(dot(N, -vPos / max(cd, 1e-4)), 0.0);
  lit += vec3(1.0, 0.44, 0.14) * cl * uCoreGlow / (0.30 + cd * cd);

  lit *= 1.0 - smoothstep(0.10, 0.85, vBurst) * 0.55;
  gl_FragColor = vec4(lit, 1.0);
}
`;

// The core never fractures, only compresses, so it needs no fragment attributes and gets its own minimal pair.
const CORE_VERT = `
uniform float uSquash;
varying vec3 vSurf;
varying vec3 vPos;
void main(){
  vSurf = normalize(position);
  vec3 p = position * (1.0 - uSquash);
  vPos = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const CORE_BODY_FRAG = `
precision highp float;
uniform float uHeat;
varying vec3 vSurf;
varying vec3 vPos;

${NOISE}

void main(){
  vec3 n0 = normalize(vSurf);
  float d = fbm3(n0 * 4.2) * 0.5 + 0.5;
  // Redder at the rim: a longer path through it and a lower temperature there; only the center is white hot
  float rim = pow(1.0 - abs(dot(n0, normalize(cameraPosition - vPos))), 1.6);
  vec3 hot = mix(vec3(1.00, 0.88, 0.66), vec3(1.00, 0.30, 0.05),
                 clamp(0.28 + 0.44 * d + 0.46 * rim, 0.0, 1.0));
  gl_FragColor = vec4(hot * uHeat, 1.0);   // above 1 this goes to bloom
}
`;

/* -- The foil and the core glow --------------------------------------- */

const FOIL_VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// The foil itself barely emits - the real light is the collapse front on the planet's surface (see
// PLANET_FRAG).
// A two-dimensional object should have no visible thickness gradient, so there is no soft glow band
// here: the centerline is an extremely narrow hard line, flanked by the interference fringes it
// leaves by perturbing the light path. An earlier version was a symmetric pow-5 white band whose
// core hit pure white - it read as a light rod, not as something with zero thickness.
// The quad is 5.2 long: enough already-converted space behind the leading edge, with the tail
// decaying by a pow, so it doesn't have to actually be infinite.
const FOIL_LEN = 5.2, FOIL_WID = 4.4;

const FOIL_FRAG = `
precision highp float;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;

// A cheap approximation of thin-film interference: the phase picks which wavelength is reinforced. The color fringe is the only way it can be seen.
vec3 spectrum(float t){
  return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
}

void main(){
  float u = vUv.x;                    // 1 = leading edge, decaying backwards

  float edge   = pow(u, 52.0);        // the conversion front: extremely narrow
  float tail   = pow(u, 3.2) * 0.16;  // the space already flattened to two dimensions, left with an afterglow
  float phase  = (1.0 - u) * 24.0 - uTime * 0.8;
  float fringe = pow(u, 7.0) * (0.5 + 0.5 * cos(phase * 6.2831853)) * 0.30;

  // Contained laterally near the planet. What is being flattened is all of space, but painting all of
  // it bright would be a glowing board; the distance is left to the imagination - and this is also the
  // cure for "a light rod running across the frame".
  float hz   = abs(vUv.y - 0.5) * ${FOIL_WID.toFixed(1)};
  float span = smoothstep(2.05, 0.30, hz);

  float a = (edge + tail + fringe) * span * uOpacity;

  // Cold blue, never pure white: with all three channels over 1, ACES compresses it into a blown-out
  // board. In the color narrative cold blue belongs to the observer, and this strike is the
  // observer's doing.
  vec3 col = vec3(0.30, 0.62, 1.15) * edge * 4.0
           + vec3(0.10, 0.34, 0.86) * tail * 2.2
           + spectrum(phase * 0.5) * fringe * 1.6;
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

/* -- Post-processing: depth of field and grain ---------------------------
   Depth of field needs depth, and three's own BokehPass renders it with scene.overrideMaterial,
   which bypasses our vertex deformation - a fragment's depth would stay on the unshattered sphere,
   and the near fragments that most need blurring would come out perfectly sharp. So this renders its
   own: materials are swapped per object, and the deformation shares the same uniforms.

   Depth stores radial distance to the camera (not view-space z), which is closer to real optics for
   depth of field. */

// Normalization ceiling for depth. The starfield sits at 42-56 and clamps to 1.0, so it naturally falls out of focus.
const DEPTH_FAR = 20.0;

/* -- Impacts (survival mode) -------------------------------
   Eight slots reused in a ring. The direction is "de-spun" by uSpinUV at the moment of impact before
   being stored, and the shader rotates it back by the current uSpinUV: n0 does not follow the texture
   (spin is a UV offset), so storing a world direction directly would make the flash slide off the
   ground (0.055 rad/s, 12 degrees in four seconds).
   The sign follows from SphereGeometry's UV convention: x = -cos(2*pi*u)*sin(theta),
   z = sin(2*pi*u)*sin(theta), so a texture feature's world azimuth is phi = 2*pi*(u_t - uSpinUV),
   while rotY(P(phi), a) = P(phi - a) in WIND. Hence storing rotY(dir, -2*pi*s0) and applying
   rotY(., 2*pi*uSpinUV) in the shader, with a positive sign. How to test it: hit a recognizable
   coastline, then spin the planet - the flash has to stay on that coastline. With the sign flipped it
   slides away at twice the angle in the opposite direction. */
const IMPACT_N = 8, IMPACT_LIFE = 60;

const DEPTH_FRAG = `
precision highp float;
uniform float uFar;
varying vec3 vPos;
void main(){
  gl_FragColor = vec4(clamp(length(vPos - cameraPosition) / uFar, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

/* Depth material for foreign objects (the asteroids and shields of survival mode). They only translate,
   rotate and scale (including the instance matrix) and never deform, so one vertex shader covers them
   all. For a ShaderMaterial on an InstancedMesh, three defines USE_INSTANCING and declares
   instanceMatrix automatically. */
const DEPTH_XFORM_VERT = `
varying vec3 vPos;
void main(){
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
  #endif
  vPos = (modelMatrix * p).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
}
`;

const DOF_SHADER = {
  uniforms: {
    tDiffuse:{ value:null }, tDepth:{ value:null },
    uTexel:{ value:new THREE.Vector2() },
    uFocus:{ value:0.2 }, uRange:{ value:0.125 }, uMax:{ value:5 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uFocus, uRange, uMax;
    varying vec2 vUv;

    void main(){
      float z = texture2D(tDepth, vUv).r;
      float coc = clamp(abs(z - uFocus) / uRange, 0.0, 1.0);
      coc *= coc;                       // keep the in-focus region wide and let it fall off quickly outside
      float r = coc * uMax;

      // Most of the frame is in focus, and an early exit saves sampling the whole screen
      if(r < 0.6){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); return; }

      vec3 sum = vec3(0.0);
      float wsum = 0.0;
      for(int i = 0; i < 16; i++){
        // Vogel spiral: points spread by the golden angle, close to a Poisson disc and needing no
        // constant array (GLSL ES 1.0 has no const arrays with initializers)
        float fi = float(i);
        float a  = fi * 2.39996323;
        float rr = sqrt((fi + 0.5) / 16.0) * r;
        vec2 off = vec2(cos(a), sin(a)) * rr * uTexel;

        float zs = texture2D(tDepth, vUv + off).r;
        // Only samples that are themselves defocused contribute fully, otherwise a sharp foreground smears onto the background
        float w = abs(zs - uFocus) / uRange >= coc * 0.6 ? 1.0 : 0.25;
        sum  += texture2D(tDiffuse, vUv + off).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
    }
  `
};

// Grain hangs off the end, after OutputPass: it is a product of film or a sensor, so it belongs in display space after tone mapping.
const GRAIN_SHADER = {
  uniforms: {
    tDiffuse:{ value:null }, uTime:{ value:0 }, uAmount:{ value:0.060 }
  },
  vertexShader: DOF_SHADER.vertexShader,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uAmount;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float n = fract(sin(dot(vUv * 1024.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      // Grain is heaviest in the midtones and nearly absent at pure black and pure white - adding noise uniformly just looks dirty
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      gl_FragColor = vec4(c + n * uAmount * (0.30 + 0.70 * (1.0 - abs(lum * 2.0 - 1.0))), 1.0);
    }
  `
};

/* -- Stage ------------------------------------------------------------ */

const TEX = {
  day:    './textures/earth_day.jpg',
  night:  './textures/earth_night.jpg',
  clouds: './textures/earth_clouds.jpg',
  spec:   './textures/earth_spec.jpg'
};

/* -- Time constants for environmental response (seconds) ----------------
   The slider sets a target and each subsystem chases it with its own heat capacity. The numbers are
   scaled to the "one second of yours is forty-seven of their years" timescale: four seconds of ice
   is about two hundred years.
   This layer is the line between "this is a celestial body" and "this is a widget" - zero-latency
   response gives away faster than any texture problem that it is not a simulation. */
const ENV_TAU = {
  crust: 8.0,   // lithosphere: slower even than the ice. The amount it lags the ice by is "where the ice has just retreated from"
  ice:   4.0,   // ice caps: the largest heat capacity, the last to react
  sea:   2.6,   // oceans: slow to boil away and slow to freeze over
  veg:   1.8,   // vegetation: desertification takes generations
  rock:  0.9,   // rock melting: fast once it is hot enough
  cloud: 0.75,  // cloud cover: forming and clearing takes days
  air:   0.35   // atmospheric density and tint: nearly instant
};

// Frame-rate-independent exponential approach. A naive lerp(x, 0.1) jitters at 144Hz and feels sticky
// at 30Hz, because it means "cover 10% of the remaining distance each frame" rather than "decay to
// 1/e each second".
const damp = (cur, tgt, tau, dt) => cur + (tgt - cur) * (1 - Math.exp(-dt / tau));
const clamp01 = v => Math.min(1, Math.max(0, v));

/* -- Fracture pattern ---------------------------------------
   Groups the sphere's triangles into fragments. It used to be one triangle per fragment: twenty
   thousand identical triangles, and no amount of tuning the scatter could make that anything but
   confetti - real fracture has a size spectrum.

   The method is Worley: space is cut into a grid, each cell holds one jittered seed, and the nearest
   seed wins. That is equivalent to a Voronoi partition but only needs the 27 neighbouring cells
   checked, instead of comparing against thousands of seeds (twenty million dot products, enough to
   drop a frame at load time).
   A low-frequency noise picks between two grid densities, so some regions split into large plates and
   others crumble to grit - fracture is uneven to begin with. */
const _rand3 = (x, y, z, salt) => {
  let h = (x * 374761393 + y * 668265263 + z * 1442695040 + salt * 2654435761) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function fractureCell(x, y, z){
  // The low-frequency field decides whether this area splits into plates or crumbles to grit
  const gx = Math.floor(x * 1.6), gy = Math.floor(y * 1.6), gz = Math.floor(z * 1.6);
  const scale = _rand3(gx, gy, gz, 7) < 0.42 ? 7.0 : 14.5;

  const px = x * scale, py = y * scale, pz = z * scale;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let best = 1e9, bx = 0, by = 0, bz = 0;
  for(let dx = -1; dx <= 1; dx++)
    for(let dy = -1; dy <= 1; dy++)
      for(let dz = -1; dz <= 1; dz++){
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const sx = cx + _rand3(cx, cy, cz, 1);
        const sy = cy + _rand3(cx, cy, cz, 2);
        const sz = cz + _rand3(cx, cy, cz, 3);
        const d = (sx-px)*(sx-px) + (sy-py)*(sy-py) + (sz-pz)*(sz-pz);
        if(d < best){ best = d; bx = cx; by = cy; bz = cz; }
      }
  // The keys of the two grids must be disjoint, or the coarse and fine cells would collide
  return (((bx + 64) * 181 + (by + 64)) * 181 + (bz + 64)) * 2 + (scale > 10 ? 1 : 0);
}

/* Hit-stop: on the frame it fractures, time is almost frozen and then released. That instant is the
   most important thing in the 2.7-second crush, and sliding through it at a constant rate is the same
   as it never having happened. */
const STOP_HOLD = 0.13, STOP_RAMP = 0.24;

/* -- Handling --------------------------------------------------
   Turn it like a globe. There is one hard constraint: *the planet mesh never rotates* (the foil has to
   compress along a fixed world plane). So horizontal turning reuses the existing surface UV offset -
   what turns is the textures and clouds, while the terminator and the latitude bands stay put, which
   is exactly how real rotation looks (the sun does not turn with it). Vertical turning raises and
   lowers the camera instead, which is tipping the globe over to look at a pole. */
const DRAG_SPIN = 0.0070;   // radians per pixel (horizontal)
const DRAG_TILT = 0.0055;   // radians per pixel (vertical)
const SPIN_TAU  = 2.1;      // friction time constant after release: a globe turns for a long time, but it does stop
const SPIN_VMAX = 3.2;      // maximum flick speed. Faster than this is a gyroscope: the surface becomes unreadable, and so does the sense of handling it
const TILT_TAU  = 0.75;     // tilt settles faster, otherwise it drifts past
const TILT_MAX  = 1.02;     // any higher and up is nearly parallel to the view axis, where lookAt degenerates
const SPIN_BASE = 0.055;    // base rotation rate

/* Release speed is the peak of the last 90ms. A release is always detected late - as the hand opens,
   tracking drops first and the classification changes after, so by the frame release() runs the speed
   estimate is already falling. It is only used while the hand is still moving (current speed >= 35%
   of the peak): dragging, stopping, then letting go is "putting it down", not "flicking it", and
   deserves no peak. Spin only, never tilt: tilt has a hard limit and clears its speed on reaching it,
   so a peak there is just a bump against the boundary. */
const PEAK_WINDOW = 0.09;
const PEAK_GATE   = 0.35;
/* Speed is estimated from the real interval since the last input, not per frame. A 30fps camera in a
   60Hz loop only moves on every other frame, and a per-frame estimate sees alternating double-spikes
   and zeros, wobbling within +/-15% at steady state (+/-25% at 144Hz), so which frame the release
   lands on is pure luck. 45ms is longer than one 30fps period plus a capture substep and shorter than
   a 15fps period; a mouse has an event every frame, so its behaviour is unchanged. */
const MOVE_GAP    = 0.045;
/* Gravitational charge: the crust is stressed first while the fist is held. The rising edge is
   lightly smoothed to erase the 30fps steps, and after an interrupt it decays over 0.4s rather than
   vanishing instantly. The 0.18 shake peak sits below the crush's collapse phase (0.10 -> 0.30), so
   the moment it fires the shake only increases, reading as a progression of 0.18 -> 0.30 -> 1.0;
   set any higher and it would drop on the frame it fires. */
const CHARGE_RISE   = 0.08;
const CHARGE_TAU    = 0.40;
const CHARGE_TRAUMA = 0.18;

/* The observer's tilt relative to the planet, in radians. The planet's rotation axis is world Y, and
   if the camera's up were world Y too, the latitude bands, the direction of rotation and the poles
   would all align with the screen axes - which reads as "a sphere with a scrolling texture" rather
   than a body in space with an orientation of its own. Giving up a tilt is giving it an axial tilt
   (Earth's is 23.4 degrees). The mesh is untouched: "the mesh never rotates" is the foil's
   precondition. */
const CAM_TILT = 0.34;

const DPR_MAX = 1.5;   // see setQuality: Retina at full resolution pins this pipeline at 30fps

/* One-dimensional value noise. Camera shake displacement has to be continuous: a per-frame random
   number shakes as high-frequency speckle, while a noise field shakes as movement. */
const _hash1 = i => { const x = Math.sin(i * 127.1) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
function noise1(t){
  const i = Math.floor(t), f = t - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return _hash1(i) * (1 - u) + _hash1(i + 1) * u;
}

export class PlanetStage {
  constructor(canvas){
    this.canvas = canvas;
    this.spin = 0;
    this.wind = 0;
    this.state = 'idle';       // idle | foil | crush | done
    this.effectT = 0;
    this.driftT = 0;
    this.onEffectEnd = null;
    this.onShock = null;       // callback on the frame it fractures, so the HUD can flash on the same frame

    this.aimX = 0; this.aimY = 0;   // view axis offset, so the planet isn't nailed to dead center
    this.roll = CAM_TILT;

    this.grabbed = false;           // currently "held": the planet does not spin, it is in your hand
    this.dragDX = 0; this.dragDY = 0;
    this.spinVel = 0;               // flicked angular velocity, decaying by friction after release
    this.tiltVel = 0;
    this.userEl = 0;                // tilt the user has pulled to by hand, which stays where it was put
    this.inputT = 0;                // handling clock: accumulated dt rather than performance.now(), since a capture script driving frame by frame makes the wall clock unevenly spaced
    this.quality = 1;               // render scale 0.5-1, multiplied into the DPR; the main loop adapts it from frame time (see setQuality)
    this.lastMoveT = 0;             // time of the last input that actually moved
    this.velLog = [];               // angular velocity samples within the last PEAK_WINDOW, peaked on release
    this.charge = 0;                // gravitational charge target (supplied by the gesture module)
    this.chargeK = 0;               // the charge actually displayed, following with a time constant

    this.trauma = 0;           // 0..1; the actual displacement is its square
    this.shakeT = 0;
    this.stop = 0;             // remaining hit-stop duration, on real time
    this.fractured = false;
    this.impactHead = 0;       // ring write pointer for the impact slots

    // Environment: tgt is what the slider asks for, cur is what each subsystem has actually reached
    this.tgt = { temp:288, cover:0.5, ctint:0, density:0.85, tr:1, tg:1, tb:1 };
    this.cur = { ice:288, sea:288, veg:288, rock:288, crust:288,
                 cover:0.5, ctint:0, density:0.85, tr:1, tg:1, tb:1,
                 fire:0, burn:0 };
    this.warm = false;         // the first frame lands straight on the target, so the opening seconds aren't spent "warming up"

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:false });
    this.renderer.setClearColor(0x05070A, 1);
    // Linear HDR rendering, emissive above 1.0 for bloom to extract, OutputPass at the end of the chain doing ACES + sRGB
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.baseR = 4.1; this.camAz = 0; this.camEl = 0; this.camPush = 0;
    this.camera.position.set(0, 0, this.baseR);

    this.lightDir = new THREE.Vector3(0.68, 0.26, 0.69).normalize();

    this._loadTextures();
    this._buildStars();
    this._buildPlanet();
    this._buildMantle();
    this._buildCoreBody();
    this._buildClouds();
    this._buildAtmo();
    this._buildFoil();
    this._buildCore();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // A threshold of 1.10 is above the peak of every diffuse surface (ice about 1.03, clouds 0.90),
    // so only emissive terms clip into bloom: magma 3.2 / city lights 2.3 / sea reflection 1.9 /
    // the foil / the core.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.90, 0.34, 1.10);

    this._buildDepth();
    this.dof = new ShaderPass(DOF_SHADER);
    this.grain = new ShaderPass(GRAIN_SHADER);
    // Order: depth of field before bloom (a blurred highlight should still bloom), grain after tone mapping
    this.composer.addPass(this.dof);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.grain);

    this.resize();
  }

  /* - Textures. A 1x1 placeholder goes in first and is swapped once loaded, avoiding empty samples on the first frame - */
  _loadTextures(){
    const solid = (r, g, b) => {
      const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
      t.needsUpdate = true;
      return t;
    };
    this.tex = {
      day:    solid(12, 20, 34),
      night:  solid(0, 0, 0),
      clouds: solid(0, 0, 0),
      spec:   solid(0, 0, 0)
    };

    const loader = new THREE.TextureLoader();
    for(const [key, url] of Object.entries(TEX)){
      loader.load(url, t => {
        t.wrapS = THREE.RepeatWrapping;       // spin is a UV offset, so it has to wrap
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        // The color maps are sRGB-encoded photographs; spec is data and stays linear
        t.colorSpace = (key === 'spec') ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        this.tex[key] = t;
        if(this.uPlanet){
          this.uPlanet.uDay.value      = this.tex.day;
          this.uPlanet.uNight.value    = this.tex.night;
          this.uPlanet.uSpec.value     = this.tex.spec;
          this.uPlanet.uCloudTex.value = this.tex.clouds;
          this.uCloud.uCloudTex.value  = this.tex.clouds;
        }
      }, undefined, () => {
        console.warn('[texture] failed to load ' + url + ' (run fetch-assets.sh first)');
      });
    }
  }

  /* - Starfield. Uniformly random monochrome points read as a flat backdrop, which turns the planet
       into a decal floating in front of it. Two things make it "a place with depth": coloring stars by
       spectral type (blue-white through orange-red), and pushing some of the density into a tilted
       galactic band. - */
  _buildStars(){
    const N = 3400;
    const pos = new Float32Array(N * 3), sz = new Float32Array(N), tmp = new Float32Array(N);
    // The normal of the galactic plane, offset from both the view axis and the planet's rotation axis so there isn't another screen-aligned line
    const gn = new THREE.Vector3(0.36, 0.82, -0.44).normalize();
    const ga = new THREE.Vector3().crossVectors(gn, new THREE.Vector3(0, 1, 0)).normalize();
    const gb = new THREE.Vector3().crossVectors(gn, ga);

    for(let i = 0; i < N; i++){
      let x, y, z;
      if(i % 5 === 0){
        // Galactic band: uniform within the plane, narrowed by a gaussian along its normal
        const th = Math.random() * Math.PI * 2;
        const h = (Math.random() + Math.random() + Math.random() - 1.5) * 0.17;
        const c = Math.cos(th), s2 = Math.sin(th);
        x = ga.x * c + gb.x * s2 + gn.x * h;
        y = ga.y * c + gb.y * s2 + gn.y * h;
        z = ga.z * c + gb.z * s2 + gn.z * h;
        const L = Math.hypot(x, y, z) || 1;
        x /= L; y /= L; z /= L;
      }else{
        const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
        const s2 = Math.sqrt(1 - u * u);
        x = s2 * Math.cos(th); y = u; z = s2 * Math.sin(th);
      }
      const r = 42 + Math.random() * 14;
      pos[i*3] = x * r; pos[i*3+1] = y * r; pos[i*3+2] = z * r;
      sz[i] = Math.random() < 0.05 ? 0.30 : 0.045 + Math.random() * 0.095;
      // Biased toward the middle with a few at each end: a real star field is mostly white and yellow, with blue giants and red dwarfs as the accents
      tmp[i] = Math.min(1, Math.max(0, (Math.random() + Math.random() + Math.random()) / 3
                                        + (Math.random() - 0.5) * 0.55));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('aTemp', new THREE.BufferAttribute(tmp, 1));
    const m = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
      vertexShader:`
        attribute float aSize; attribute float aTemp;
        varying float vA; varying float vT;
        void main(){
          vA = aSize; vT = aTemp;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * 300.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader:`
        varying float vA; varying float vT;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if(d > 0.5) discard;
          // Spectral sequence: orange-red -> white -> blue-white
          vec3 col = vT < 0.5
            ? mix(vec3(1.00, 0.74, 0.55), vec3(1.00, 0.97, 0.92), vT * 2.0)
            : mix(vec3(1.00, 0.97, 0.92), vec3(0.74, 0.83, 1.00), (vT - 0.5) * 2.0);
          float a = (1.0 - d * 2.0) * clamp(vA * 6.0, 0.15, 0.95);
          gl_FragColor = vec4(col, a);
        }`
    });
    this.stars = new THREE.Points(g, m);
    this.scene.add(this.stars);
  }

  /* - Depth map. Depth of field needs it, and it has to use exactly the same vertex deformation as the
       image, or a fragment's depth would stay on the unshattered sphere. The uniforms are shared
       objects, used directly. - */
  _buildDepth(){
    this.depthRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer:true });
    const mk = (uni, vert, side) => new THREE.ShaderMaterial({
      uniforms: Object.assign({ uFar:{ value:DEPTH_FAR } }, uni),
      vertexShader: vert, fragmentShader: DEPTH_FRAG, side
    });
    this.depthMat = new Map([
      [this.planet,   mk(this.uPlanet,   PLANET_VERT, THREE.DoubleSide)],
      [this.mantle,   mk(this.uMantle,   PLANET_VERT, THREE.DoubleSide)],
      [this.coreBody, mk(this.uCoreBody, CORE_VERT,   THREE.FrontSide)]
    ]);
    // Transparent layers don't write depth: they should not be deciding the focal plane
    this.depthHide = [this.clouds, this.atmo, this.foil, this.core, this.stars];
  }

  /* -- Impacts: an asteroid landing in survival mode. dir is a world direction (a Vector3 or {x,y,z}) and size is the rock's radius. -- */
  impact(dir, size){
    const a = -this.uPlanet.uSpinUV.value * Math.PI * 2;      // de-spin, see the derivation at IMPACT_N
    const c = Math.cos(a), s = Math.sin(a);
    const u = this.uPlanet.uImpacts.value, k = this.impactHead * 4;
    u[k] = dir.x * c - dir.z * s; u[k + 1] = dir.y; u[k + 2] = dir.x * s + dir.z * c;   // rotY(dir, -spin)
    u[k + 3] = 0;
    this.uPlanet.uImpactSize.value[this.impactHead] = size;
    this.impactHead = (this.impactHead + 1) % IMPACT_N;
    // 0.33-0.45: above the charge's 0.18 and the foil's 0.30, below the fracture's 1.0
    this.trauma = Math.max(this.trauma, 0.25 + size * 1.5);
  }
  // On scene time: during hit-stop the flash should stop too
  _ageImpacts(edt){
    const u = this.uPlanet.uImpacts.value;
    for(let i = 3; i < u.length; i += 4){
      if(u[i] < 0) continue;
      u[i] += edt;
      if(u[i] > IMPACT_LIFE) u[i] = -1;
    }
  }

  /* -- Depth registration for foreign objects. The depth map renders the whole scene as usual: an
     unregistered mesh writes its own color into the depth map and the depth of field goes wrong with
     it. Opaque objects use trackDepth (which swaps in a depth material); additive and transparent
     ones use overlay (which hides them while depth is rendered). -- */
  trackDepth(mesh, side = THREE.FrontSide){
    if(this.depthMat.has(mesh)) return;
    this.depthMat.set(mesh, new THREE.ShaderMaterial({
      uniforms:{ uFar:{ value:DEPTH_FAR } },
      vertexShader:DEPTH_XFORM_VERT, fragmentShader:DEPTH_FRAG, side
    }));
  }
  overlay(obj){ if(!this.depthHide.includes(obj)) this.depthHide.push(obj); }
  untrack(obj){
    const m = this.depthMat.get(obj);
    if(m){ m.dispose(); this.depthMat.delete(obj); }
    const i = this.depthHide.indexOf(obj);
    if(i >= 0) this.depthHide.splice(i, 1);
  }

  _renderDepth(){
    const vis = this.depthHide.map(o => o.visible);
    this.depthHide.forEach(o => { o.visible = false; });
    const keep = [];
    for(const [mesh, mat] of this.depthMat){
      keep.push(mesh.material);
      mesh.material = mat;
    }

    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.depthRT);
    this.renderer.setClearColor(0xffffff, 1);      // empty space = furthest away, so the starfield is blurred
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(0x05070A, 1);

    let i = 0;
    for(const mesh of this.depthMat.keys()) mesh.material = keep[i++];
    this.depthHide.forEach((o, k) => { o.visible = vis[k]; });
  }

  /* - Fracture pattern: group triangles into fragments, then spread each fragment's rigid-body
       attributes back onto all of its vertices.
       A coarse value below 1 means larger pieces - the mantle is tougher than the crust and breaks
       more coarsely. - */
  _fracture(geo, coarse){
    const pos = geo.attributes.position;
    const n = pos.count;
    const cen = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const axis = new Float32Array(n * 3);
    const rnd = new Float32Array(n);
    const mass = new Float32Array(n);

    // First pass: assign each triangle to a fragment, accumulating each fragment's centroid and face count on the way
    const faces = n / 3;
    const keyOf = new Int32Array(faces);
    const blocks = new Map();
    for(let t = 0, f = 0; t < n; t += 3, f++){
      let cx = 0, cy = 0, cz = 0;
      for(let k = 0; k < 3; k++){
        cx += pos.getX(t + k); cy += pos.getY(t + k); cz += pos.getZ(t + k);
      }
      cx /= 3; cy /= 3; cz /= 3;

      // Normalize before multiplying by coarse: only then are fragment sizes comparable between shells of different radius
      const inv = coarse / (Math.hypot(cx, cy, cz) || 1);
      const key = fractureCell(cx * inv, cy * inv, cz * inv);
      keyOf[f] = key;
      let b = blocks.get(key);
      if(!b){ b = { cx:0, cy:0, cz:0, c:0 }; blocks.set(key, b); }
      b.cx += cx; b.cy += cy; b.cz += cz; b.c++;
    }

    // Second pass: compute the rigid-body attributes once per fragment, shared by the whole piece - that is what "one fragment" means
    for(const b of blocks.values()){
      b.cx /= b.c; b.cy /= b.c; b.cz /= b.c;

      let dx = b.cx + (Math.random() - 0.5) * 0.55;
      let dy = b.cy + (Math.random() - 0.5) * 0.55;
      let dz = b.cz + (Math.random() - 0.5) * 0.55;
      const L = Math.hypot(dx, dy, dz) || 1;
      b.dx = dx / L; b.dy = dy / L; b.dz = dz / L;

      let ax = Math.random() * 2 - 1, ay = Math.random() * 2 - 1, az = Math.random() * 2 - 1;
      const AL = Math.hypot(ax, ay, az) || 1;
      b.ax = ax / AL; b.ay = ay / AL; b.az = az / AL;

      b.rnd = Math.random();
      // Mass proxy: the square root of the face count, normalized. Under the same impulse it decides how fast this piece is pushed and how hard it spins.
      b.mass = Math.min(1, Math.sqrt(b.c / 60));
    }

    for(let f = 0; f < faces; f++){
      const b = blocks.get(keyOf[f]);
      for(let k = 0; k < 3; k++){
        const v = f * 3 + k;
        cen[v*3] = b.cx; cen[v*3+1] = b.cy; cen[v*3+2] = b.cz;
        dir[v*3] = b.dx; dir[v*3+1] = b.dy; dir[v*3+2] = b.dz;
        axis[v*3] = b.ax; axis[v*3+1] = b.ay; axis[v*3+2] = b.az;
        rnd[v] = b.rnd;
        mass[v] = b.mass;
      }
    }
    geo.setAttribute('aCentroid', new THREE.BufferAttribute(cen, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aAxis', new THREE.BufferAttribute(axis, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    geo.setAttribute('aMass', new THREE.BufferAttribute(mass, 1));
    return geo;
  }

  /* - The planet. SphereGeometry for its correct equirectangular UVs, converted to non-indexed so
       fracture attributes can be attached per triangle. - */
  _buildPlanet(){
    const geo = this._fracture(new THREE.SphereGeometry(1, 128, 80).toNonIndexed(), 1.0);

    this.uPlanet = {
      uDay:{value:this.tex.day}, uNight:{value:this.tex.night},
      uSpec:{value:this.tex.spec}, uCloudTex:{value:this.tex.clouds},
      uTempLag:{value:new THREE.Vector4(288, 288, 288, 288)},
      uPop:{value:1}, uSpinUV:{value:0}, uCover:{value:0.5}, uWind:{value:0},
      uCrustT:{value:288}, uFire:{value:0}, uBurn:{value:0}, uCharge:{value:0},
      uLightDir:{value:this.lightDir},
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1},
      uFracWin:{value:new THREE.Vector2(0.15, 0.09)}, uBurstK:{value:1.0},
      uCoreGlow:{value:0},
      // three's flatten() passes values that are already TypedArrays straight through: these two buffers are rewritten in place, zero copies
      uImpacts:{value:new Float32Array(IMPACT_N * 4).fill(-1)},
      uImpactSize:{value:new Float32Array(IMPACT_N)}
    };
    this.planet = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uPlanet, vertexShader:PLANET_VERT, fragmentShader:PLANET_FRAG,
      side:THREE.FrontSide
    }));
    this.scene.add(this.planet);
  }

  /* - Mantle: fractures later than the crust, into larger pieces that fly slower. Normally hidden
       behind the opaque crust and only switched on during the gravitational crush - with the complete
       sphere in front of it, rendering a layer nobody can see is pointless. - */
  _buildMantle(){
    const geo = this._fracture(new THREE.SphereGeometry(0.86, 96, 56).toNonIndexed(), 0.58);
    this.uMantle = {
      uLightDir:{value:this.lightDir},
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1},
      uFracWin:{value:new THREE.Vector2(0.27, 0.11)}, uBurstK:{value:0.62},
      uCoreGlow:{value:0}
    };
    this.mantle = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uMantle, vertexShader:PLANET_VERT, fragmentShader:MANTLE_FRAG,
      side:THREE.FrontSide
    }));
    this.mantle.visible = false;
    this.scene.add(this.mantle);
  }

  /* - Core: never fractures, only compresses, lights up, and is left behind as an ember.
       It is also the light source for the inner faces of the fragments, and "there is something
       inside" mostly stands on that light. - */
  _buildCoreBody(){
    this.uCoreBody = { uSquash:{value:0}, uHeat:{value:0.5} };
    this.coreBody = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.40, 4),
      new THREE.ShaderMaterial({
        uniforms:this.uCoreBody, vertexShader:CORE_VERT, fragmentShader:CORE_BODY_FRAG
      })
    );
    this.coreBody.visible = false;
    this.scene.add(this.coreBody);
  }

  _buildClouds(){
    const geo = new THREE.SphereGeometry(1.012, 96, 60);
    this.uCloud = {
      uCloudTex:{value:this.tex.clouds},
      uSpinUV:{value:0}, uWind:{value:0}, uCover:{value:0.5}, uTint:{value:0},
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
    // The shell is only a carrier for the integral and should never be seen itself - its radius has to
    // cover the atmosphere's outer edge, Ra=1.55.
    // Occlusion is resolved by ray intersection inside the shader, so depth testing is off.
    const geo = new THREE.IcosahedronGeometry(1.17, 5);
    this.uAtmo = {
      uLightDir:{value:this.lightDir},
      uDensity:{value:0.85},
      uFade:{value:1},
      uTint:{value:new THREE.Color(1, 1, 1)}
    };
    this.atmo = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uAtmo, vertexShader:ATMO_VERT, fragmentShader:ATMO_FRAG,
      transparent:true, depthWrite:false, depthTest:false,
      blending:THREE.AdditiveBlending, side:THREE.BackSide
    }));
    this.atmo.renderOrder = 5;
    this.scene.add(this.atmo);
  }

  /* - The foil is the very plane the planet is collapsing into, which is why it is horizontal.
       It used to be a vertical quad sweeping sideways while the result was a horizontal disc - the
       blade and the cut plane 90 degrees apart, something no amount of brightness tuning can rescue.
       Now it lies on y ~= 0 and its leading edge advances along X, coplanar with the flattened sheet;
       the unconverted half of the sphere occludes the leading edge, and the sheet emerges from under
       the folds. - */
  _buildFoil(){
    const geo = new THREE.PlaneGeometry(FOIL_LEN, FOIL_WID);
    this.uFoil = { uOpacity:{value:0}, uTime:{value:0} };
    // depthTest has to stay on. Without it the foil draws over everything and is never occluded by the
    // planet - which is the most direct difference between "a streak of light stuck on the image" and
    // "an object in the scene".
    this.foil = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uFoil, vertexShader:FOIL_VERT, fragmentShader:FOIL_FRAG,
      transparent:true, depthWrite:false, depthTest:true,
      blending:THREE.AdditiveBlending, side:THREE.DoubleSide
    }));
    this.foil.rotation.x = -Math.PI / 2;   // lying flat, normal along +Y
    this.foil.position.y = 0.06;           // slightly above the sheet, to avoid coplanar fighting
    this._placeFoil(-1.9);
    this.foil.renderOrder = 10;
    this.scene.add(this.foil);
  }

  // The leading edge lands at x: the quad's center has to sit back by half its length
  _placeFoil(x){ this.foil.position.x = x - FOIL_LEN / 2; }

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

  _applyCam(){
    const r = this.baseR + this.camPush;
    const { camAz: a, camEl: e } = this;
    this.camera.position.set(
      r * Math.sin(a) * Math.cos(e),
      r * Math.sin(e),
      r * Math.cos(a) * Math.cos(e)
    );
    this.camera.up.set(Math.sin(this.roll), Math.cos(this.roll), 0);
    // The view axis is not locked to the planet's center. Pinning the subject dead center is the most
    // direct source of "floating on the image" - no real camera position does that.
    this.camera.lookAt(this.aimX, this.aimY, 0);
  }

  /* -- Public interface -- */

  // Only the targets are recorded here. What goes into the uniforms is the result of _dampEnv() approaching them with each subsystem's own time constant.
  setEnv(tempK, pressureAtm, popNorm){
    this.uPlanet.uPop.value = popNorm;
    const t = this.tgt;
    t.temp = tempK;

    // Cloud cover: pressure sets the ceiling, and extreme temperatures suppress it (freeze-dried or evaporated away)
    const pc = Math.min(1, Math.pow(pressureAtm / 9, 0.60));
    const tk = Math.min(1, Math.max(0, (tempK - 150) / 120)) *
               Math.min(1, Math.max(0, (760 - tempK) / 180));
    // While the oceans boil away, the steam wraps the whole planet before dispersing at higher
    // temperatures. Without this step the ocean merely "quietly darkens" - and where did the water go?
    const steam = Math.min(1, Math.max(0, (tempK - 362) / 70)) *
                  Math.min(1, Math.max(0, (560 - tempK) / 130));
    t.cover = Math.min(1, pc * (0.25 + 0.75 * tk) + steam * 0.55);
    t.ctint = Math.min(1, Math.max(0, (tempK - 340) / 260));

    // The atmosphere can't listen to pressure alone. A dry surface raises dust, a boiling sea raises
    // steam, a frozen one has its gases condense out onto the ground - the thickness of an atmosphere
    // is part of the state of the surface. Without that coupling the halo at the limb never moves
    // however the surface changes, and half of the "only one layer changed" impression comes from here.
    // Dust peaks in the desert temperature band and has to retreat before melting - extrapolated
    // linearly it would still be at full strength at eight hundred degrees, pushing the whole
    // atmosphere into an orange glow that smears the surface away.
    const dust     = clamp01((tempK - 300) / 140) * clamp01((620 - tempK) / 140) * 0.45;
    const condense = clamp01((248 - tempK) / 90) * 0.42;    // cold -> gases condense onto the surface
    t.density = Math.min(2.6, Math.pow(pressureAtm / 1.2, 0.55) * 0.80
                              * (1 + dust + steam * 0.55) * (1 - condense));
    // A hot atmosphere skews orange (dust and sulfur), a cold one blue-white
    const hot = Math.min(1, Math.max(0, (tempK - 320) / 320));
    const cold = Math.min(1, Math.max(0, (250 - tempK) / 130));
    t.tr = 1 + hot * 1.10 + cold * 0.15;
    t.tg = 1 - hot * 0.22 + cold * 0.18;
    t.tb = 1 - hot * 0.62 + cold * 0.10;
  }

  _dampEnv(dt){
    const t = this.tgt, c = this.cur;
    if(this.warm){
      c.crust = damp(c.crust, t.temp, ENV_TAU.crust, dt);
      c.ice  = damp(c.ice,  t.temp, ENV_TAU.ice,  dt);
      c.sea  = damp(c.sea,  t.temp, ENV_TAU.sea,  dt);
      c.veg  = damp(c.veg,  t.temp, ENV_TAU.veg,  dt);
      c.rock = damp(c.rock, t.temp, ENV_TAU.rock, dt);
      c.cover   = damp(c.cover,   t.cover,   ENV_TAU.cloud, dt);
      c.ctint   = damp(c.ctint,   t.ctint,   ENV_TAU.cloud, dt);
      c.density = damp(c.density, t.density, ENV_TAU.air,   dt);
      c.tr = damp(c.tr, t.tr, ENV_TAU.air, dt);
      c.tg = damp(c.tg, t.tg, ENV_TAU.air, dt);
      c.tb = damp(c.tb, t.tb, ENV_TAU.air, dt);
    }else{
      Object.assign(c, { ice:t.temp, sea:t.temp, veg:t.temp, rock:t.temp, crust:t.temp,
                         cover:t.cover, ctint:t.ctint, density:t.density,
                         tr:t.tr, tg:t.tg, tb:t.tb });
      this.warm = true;
    }

    /* Thermal shock = the gap between the target temperature and the vegetation channel. Ease the
       slider along and it stays near zero; yank it up and it spikes, then falls back as the slow
       channel catches up - which is exactly the quantified form of "the biosphere can't keep up",
       with no separate rate-of-change to track. Fires hang off it. */
    const shock = clamp01((t.temp - c.veg) / 55);
    const flam  = clamp01((t.temp - 300) / 45) * clamp01((525 - t.temp) / 70);
    c.fire = damp(c.fire, shock * flam, 0.6, dt);
    // Burned area: grows while burning, then fades slowly as vegetation recovers (tau about 22 seconds)
    c.burn = Math.min(1, Math.max(0, c.burn + dt * (c.fire * 0.24 - c.burn * 0.045)));

    this.uPlanet.uTempLag.value.set(c.ice, c.veg, c.sea, c.rock);
    this.uPlanet.uCover.value = this.uCloud.uCover.value = c.cover;
    this.uCloud.uTint.value = c.ctint;
    this.uPlanet.uCrustT.value = c.crust;
    this.uPlanet.uFire.value = c.fire;
    this.uPlanet.uBurn.value = c.burn;
    // Burning itself also loads aerosols, clouding the atmosphere with it
    const smoke = Math.min(0.55, c.fire * 1.1);
    this.uAtmo.uDensity.value = c.density * (1 + smoke * 0.45);
    this.uAtmo.uTint.value.setRGB(c.tr + smoke * 0.34, c.tg - smoke * 0.10, c.tb - smoke * 0.28);
  }

  triggerFoil(){
    if(this.state !== 'idle') return false;
    this.state = 'foil'; this.effectT = 0;
    this._dropGrab();
    return true;
  }

  triggerCrush(){
    if(this.state !== 'idle') return false;
    this.state = 'crush'; this.effectT = 0;
    this._dropGrab();
    // The fracture faces only become visible once it breaks apart. A complete sphere is closed, so
    // culling every back face costs nothing, while leaving DoubleSide on permanently pays for twice
    // the fragment shading for nothing.
    this.planet.material.side = THREE.DoubleSide;
    this.mantle.material.side = THREE.DoubleSide;
    this.mantle.visible = this.coreBody.visible = true;
    return true;
  }

  // A strike releases any existing grab immediately, with no peak: the camera belongs to the choreography during a strike, and whatever momentum was in the hand shouldn't carry into it.
  _dropGrab(){ this.grabbed = false; this.velLog.length = 0; }

  reset(){
    this.state = 'idle'; this.effectT = 0;
    this.trauma = 0; this.stop = 0; this.fractured = false;
    this.charge = this.chargeK = 0; this.uPlanet.uCharge.value = 0;
    this.uPlanet.uImpacts.value.fill(-1); this.impactHead = 0;
    for(const u of [this.uPlanet, this.uCloud]){
      u.uFoilX.value = -1.9; u.uShatter.value = 0; u.uSpread.value = 1;
    }
    this.uAtmo.uFade.value = 1;
    this.uFoil.uOpacity.value = 0;
    this._placeFoil(-1.9);
    this.uCore.uOpacity.value = 0;
    this.core.visible = false;
    this.planet.material.side = THREE.FrontSide;
    this.mantle.material.side = THREE.FrontSide;
    this.mantle.visible = this.coreBody.visible = false;
    this.uMantle.uShatter.value = 0;
    this.uPlanet.uCoreGlow.value = this.uMantle.uCoreGlow.value = 0;
    this.uCoreBody.uSquash.value = 0; this.uCoreBody.uHeat.value = 0.5;
    this.camAz = 0; this.camEl = 0; this.camPush = 0;
    this.aimX = 0; this.aimY = 0; this.roll = CAM_TILT;
    this.grabbed = false; this.dragDX = this.dragDY = 0;
    this.spinVel = 0; this.tiltVel = 0; this.userEl = 0;
    this.velLog.length = 0; this.lastMoveT = this.inputT;
    this._applyCam();
  }

  update(dt){
    const edt = this._timeScale(dt);   // scene time: slowed during hit-stop
    this._dampEnv(edt);
    this._ageImpacts(edt);

    this._input(dt);                // handling runs on real time: hit-stop shouldn't make it feel sticky
    this._charge(dt);
    if(!this.grabbed) this.spin += edt * SPIN_BASE;
    const spinUV = this.spin / (Math.PI * 2);
    this.uPlanet.uSpinUV.value = spinUV;
    this.uCloud.uSpinUV.value = spinUV;
    // Cloud displacement relative to the ground is handled by the zonal wind bands, no longer a rigid
    // "the whole layer moves 1.18x faster than the surface" translation.
    // The rate has to be held down: the surface rotates at 0.0088 UV/s, real jet streams are only a
    // few percent of the equatorial rotation speed, and clouds moving faster than the planet turns
    // reads as "the clouds are being yanked". This is about five minutes for the westerlies to go
    // once around.
    this.wind += edt * 0.0034;
    this.uPlanet.uWind.value = this.uCloud.uWind.value = this.wind;

    if(this.state === 'idle'){
      // Drift of the observation platform. It used to be two pure sines reversing about every forty
      // seconds - which is precisely the kinematic signature of "floating in water": no direction, no
      // end, perfectly smooth. A noise field instead: aperiodic, able to hold a direction for a long
      // time, and it reads as being carried along rather than bobbing in place.
      this.driftT += edt;
      const d = this.driftT;
      this.camAz = noise1(d * 0.021) * 0.17 + noise1(d * 0.079 + 11.0) * 0.030;
      this.camEl = Math.max(-TILT_MAX, Math.min(TILT_MAX,
                    this.userEl + noise1(d * 0.017 + 41.0) * 0.115 + 0.055));
      // The subject breathes within the frame too, drifting along with a little roll
      this.aimX = noise1(d * 0.013 + 63.0) * 0.105;
      this.aimY = noise1(d * 0.011 + 87.0) * 0.080;
      this.roll = CAM_TILT + noise1(d * 0.009 + 29.0) * 0.05;
    }
    else if(this.state === 'foil'){
      this.effectT += edt / 7.4;                    // about 7.4 seconds end to end, slow and irresistible
      const t = Math.min(1, this.effectT);
      // The foil is dropped, not interpolated: it only ever gets faster. An earlier smoothstep brought
      // the end velocity to zero, and the sweep looked like it had stopped by itself on the far side
      // of the planet.
      const x = -1.9 + t * (0.74 + 0.26 * t) * 3.8;
      for(const u of [this.uPlanet, this.uCloud]) u.uFoilX.value = x;
      // The atmosphere fades out with the flattening: two-dimensional space has no atmosphere
      this.uAtmo.uFade.value = 1 - this._ss(0.0, 0.62, t);
      this._placeFoil(x);
      this.uFoil.uTime.value = this.effectT;
      this.uFoil.uOpacity.value = Math.sin(Math.min(1, t * 1.12) * Math.PI) * 0.78;

      // The sustained low rumble while the foil passes over the planet. It is not an impact, it is that piece of space collapsing.
      if(x > -1.05 && x < 1.05) this.trauma = Math.max(this.trauma, 0.30);

      // The camera turns to a grazing angle before the foil arrives. Flattening cannot be seen head
      // on - reading a thickness going to zero needs parallax, and this move is what makes the whole
      // effect work.
      const c = Math.min(1, t / 0.24);
      const ce = c * c * (3 - 2 * c);
      this.camAz = ce * 0.30;
      this.camEl = ce * 0.36;
      this.camPush = ce * 1.25;

      if(t >= 1) this._finish();
    }
    else if(this.state === 'crush'){
      this.effectT += edt / 2.7;
      const t = Math.min(1, this.effectT);
      for(const u of [this.uPlanet, this.uCloud, this.uMantle]) u.uShatter.value = t;
      this.uAtmo.uFade.value = 1 - this._ss(0.0, 0.26, t);

      if(t < 0.17){
        this.trauma = Math.max(this.trauma, 0.10 + t * 1.2);   // louder the further the collapse goes
      }else if(!this.fractured){
        // The fracture. Hit-stop, shake and flash must all land on the same frame, or the three of them tell three different stories.
        this.fractured = true;
        this.stop = STOP_HOLD + STOP_RAMP;
        this.trauma = 1;
        if(this.onShock) this.onShock();
      }

      // Pull back after the fracture, and faster than the debris cloud expands - lag behind and the
      // screen is nothing but grit in your face.
      // This is also the only camera language in this strike: it is done, now step back.
      this.camPush = this._ss(0.16, 0.95, this.effectT) * 2.40;

      this._updateInterior();

      // The glow halo must not brighten until the fragments start separating - any earlier and it is a white blob smeared in front of an intact sphere
      const op = this._ss(0.17, 0.30, t) * (1 - this._ss(0.34, 0.72, t)) * 0.55;
      this.uCore.uOpacity.value = Math.max(0, op);
      this.core.visible = op > 0.002;
      const k = 0.42 + this._ss(0.15, 0.90, t) * 1.45;
      this.core.scale.set(k, k, 1);
      this.core.quaternion.copy(this.camera.quaternion);

      if(t >= 1) this._finish();
    }
    else if(this.state === 'done' && this.uPlanet.uShatter.value > 0 && this.effectT < 1.8){
      // Fragments do not stop on the frame the animation "ends" - nothing in vacuum could stop them.
      // Integration continues to 1.8: the fast ones leave the frame, the slow ones are pulled back by
      // the remnant core's gravity, and a field of rubble is left.
      this.effectT += edt / 2.7;
      const v = Math.min(1.8, this.effectT);
      this.uPlanet.uShatter.value = this.uCloud.uShatter.value = this.uMantle.uShatter.value = v;
      this.camPush = 2.40 + this._ss(1.0, 1.8, v) * 1.20;
      this._updateInterior();
    }

    this._applyCam();
    this._shake(dt);          // shake runs on real time: the image keeps shaking during hit-stop

    this._renderDepth();
    this.dof.uniforms.tDepth.value = this.depthRT.texture;
    // The focal plane always lands on the planet's center: as the camera pulls back the focus has to go with it, or everything blurs the moment it moves
    this.dof.uniforms.uFocus.value = (this.baseR + this.camPush) / DEPTH_FAR;
    this.grain.uniforms.uTime.value = (this.grain.uniforms.uTime.value + dt * 61.0) % 1000.0;

    this.composer.render();
  }

  /* State of the core and mantle. Hung off effectT rather than the t clamped to 1, so the ember keeps
     cooling after the animation "ends". */
  _updateInterior(){
    const e = this.effectT;
    // Compression: tighter the further the collapse goes, then fixed once it fractures
    this.uCoreBody.uSquash.value = Math.pow(Math.min(e, 0.30) / 0.30, 2.2) * 0.42;
    // Brightness: ignition during the collapse -> brightest at the fracture -> cooling as an ember afterwards
    this.uCoreBody.uHeat.value = Math.max(
      0.12, 0.35 + this._ss(0.05, 0.24, e) * 1.60 - this._ss(0.34, 1.5, e) * 1.45);
    // The light that illuminates the fragments' inner faces pulls back faster than the core itself - the inverse square law also takes over once they fly far
    const g = this._ss(0.10, 0.26, e) * 1.10 - this._ss(0.38, 1.25, e) * 1.00;
    this.uPlanet.uCoreGlow.value = this.uMantle.uCoreGlow.value = Math.max(0, g);
  }

  /* -- Handling interface. Pointer events are collected in main.js; this only does the physics. -- */

  grab(){
    if(this.state !== 'idle') return false;   // a strike is running, the camera belongs to the choreography
    this.grabbed = true;
    this.spinVel = 0; this.tiltVel = 0;       // grabbing again = grabbing it to a stop
    this.velLog.length = 0;
    return true;
  }
  dragBy(dx, dy){ if(this.grabbed){ this.dragDX += dx; this.dragDY += dy; } }
  release(){
    if(!this.grabbed) return;
    this.grabbed = false;
    // Release takes the recent peak, but only while the hand is still moving: stopping and then letting go is "putting it down", which keeps the current value.
    let peak = this.spinVel;
    for(const s of this.velLog) if(Math.abs(s.v) > Math.abs(peak)) peak = s.v;
    if(Math.abs(this.spinVel) >= PEAK_GATE * Math.abs(peak)) this.spinVel = peak;
    this.spinVel = Math.max(-SPIN_VMAX, Math.min(SPIN_VMAX, this.spinVel));
    this.velLog.length = 0;
  }
  // Externally imposed angular velocity (radians/s). The civilization integrates it over time to get "how many radians it has been turned by".
  get spinAnomaly(){ return Math.abs(this.spinVel); }
  // Gravitational charge target 0..1. Only effective while idle: a strike zeroes the target immediately, and the glow fades out under the collapse.
  setCharge(k){ this.charge = clamp01(k); }

  _input(dt){
    const dx = this.dragDX, dy = this.dragDY;
    this.dragDX = this.dragDY = 0;

    this.inputT += dt;
    if(this.grabbed){
      this.spin  -= dx * DRAG_SPIN;
      this.userEl = Math.max(-TILT_MAX, Math.min(TILT_MAX, this.userEl + dy * DRAG_TILT));
      // Speed estimation has to be smoothed. Single-frame differences are too noisy, and using one
      // directly as the initial velocity makes the release stutter.
      // It also has to be computed over the real interval since the last input: a camera only moves on
      // alternate frames, and a per-frame computation alternates between spikes and zeros.
      if(dx !== 0 || dy !== 0){
        const span = Math.max(this.inputT - this.lastMoveT, 1e-3);
        this.lastMoveT = this.inputT;
        this.spinVel = damp(this.spinVel, -dx * DRAG_SPIN / span, 0.055, span);
        this.tiltVel = damp(this.tiltVel,  dy * DRAG_TILT / span, 0.055, span);
      }else if(this.inputT - this.lastMoveT > MOVE_GAP){   // input really has stopped (a stationary mouse)
        this.spinVel = damp(this.spinVel, 0, 0.055, dt);
        this.tiltVel = damp(this.tiltVel, 0, 0.055, dt);
      }
      this.spinVel = Math.max(-SPIN_VMAX, Math.min(SPIN_VMAX, this.spinVel));
      this.velLog.push({ t:this.inputT, v:this.spinVel });
      while(this.velLog.length && this.velLog[0].t < this.inputT - PEAK_WINDOW) this.velLog.shift();
    }else{
      this.spin  += dt * this.spinVel;
      this.userEl = Math.max(-TILT_MAX, Math.min(TILT_MAX, this.userEl + dt * this.tiltVel));
      this.spinVel *= Math.exp(-dt / SPIN_TAU);
      this.tiltVel *= Math.exp(-dt / TILT_TAU);
      // Leaving momentum at the limit would make it vibrate against the boundary forever after release
      if(Math.abs(this.userEl) >= TILT_MAX - 1e-4) this.tiltVel = 0;
    }
  }

  // How the gravitational charge presents: the crustal fissures light up with uCharge and the camera
  // shakes slightly with it. Runs on real time and only while idle; once it fires, the crush timeline
  // takes over trauma (both take a max, so it only ever increases) and uCharge fades out under the collapse.
  _charge(dt){
    const tgt = this.state === 'idle' ? this.charge : 0;
    this.chargeK = damp(this.chargeK, tgt, tgt > this.chargeK ? CHARGE_RISE : CHARGE_TAU, dt);
    if(this.chargeK < 1e-3) this.chargeK = 0;
    this.uPlanet.uCharge.value = this.chargeK;
    if(this.state === 'idle') this.trauma = Math.max(this.trauma, this.chargeK * CHARGE_TRAUMA);
  }

  // Hit-stop. Almost freeze first, then release, returning the scaled time step.
  _timeScale(dt){
    if(this.stop <= 0) return dt;
    this.stop = Math.max(0, this.stop - dt);
    const k = this.stop > STOP_RAMP ? 0.14
                                    : 0.14 + 0.86 * (1 - this.stop / STOP_RAMP);
    return dt * k;
  }

  // Camera shake. trauma decays linearly and the displacement is its square - human perception of
  // intensity is exponential, and squaring makes the shake start hard and finish cleanly. It shakes
  // rotation, never translation: the camera is being shaken, not pushed, so the composition stays put.
  _shake(dt){
    this.trauma = Math.max(0, this.trauma - dt * 1.35);
    if(this.trauma <= 0.001) return;
    const a = this.trauma * this.trauma;
    this.shakeT += dt;
    const f = this.shakeT * 26;
    this.camera.rotateX(noise1(f)        * a * 0.050);
    this.camera.rotateY(noise1(f + 37.1) * a * 0.044);
    this.camera.rotateZ(noise1(f + 91.7) * a * 0.062);
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

  /* Render scale. The planet shader runs twice per frame (color plus the self-rendered depth map) on
     top of 16-sample depth of field and five bloom levels - on Retina, DPR 2 means 3024x1424, and four
     megapixels pin even an M-series chip at 30fps. The DPR is capped at 1.5 and then adapted from
     frame time. */
  setQuality(q){
    q = Math.max(0.5, Math.min(1, q));
    if(Math.abs(q - this.quality) < 1e-3) return;
    this.quality = q;
    this.resize();
  }

  resize(){
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, DPR_MAX) * this.quality;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    if(this.composer){
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
      // The depth map matches the composition chain's resolution; the blur radius is given in pixels, so dpr has to be folded in
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      this.depthRT.setSize(pw, ph);
      this.dof.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      this.dof.uniforms.uMax.value = Math.max(3, ph * 0.008);
    }
    this.camera.aspect = w / h;
    // Solve for the distance from the field of view and the aspect ratio. In portrait the limiting
    // dimension is width, and a hardcoded distance would inevitably crop; narrow screens need extra
    // margin on top of that - a panel takes about a third of the height at each end.
    const vFov = this.camera.fov * Math.PI / 180;
    const margin = w < 760 ? 1.52 : 1.45;
    this.baseR = margin / (Math.tan(vFov / 2) * Math.min(1, w / h));
    this.camera.updateProjectionMatrix();
    this._applyCam();
  }
}
