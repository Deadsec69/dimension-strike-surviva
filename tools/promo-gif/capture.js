// Page-side capture for the promo GIFs. Injected into /capture.html by capserve.py; not part of the site.
//
// Advance deterministically frame by frame -> render -> toDataURL -> POST back to capserve to be saved.
// The page's own main loop has to be stopped: it advances on real time, and sampling on top of it is
// no longer evenly spaced.

const FPS = 24;
const W = 960, H = 540;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => document.getElementById(id);

while (!window.__ds) await sleep(50);
const S = window.__ds.stage, C = window.__ds.civ;
const cv = $('stage');

async function post(path, body){
  for(let a = 0; ; a++){
    try{
      const r = await fetch(path, { method:'POST', body });
      if(r.ok) return;
      throw new Error(`${path} → ${r.status}`);
    }catch(e){
      if(a >= 5) throw e;
      await sleep(200 * (a + 1));      // an occasional Failed to fetch; retrying is enough
    }
  }
}

/* -- Freeze the page -- */
async function freeze(){
  // Textures load asynchronously; starting before they arrive would give the first frames placeholder colors
  for(let k = 0; ; k++){
    if(Object.values(S.tex).every(t => t.image && t.image.width > 1)) break;
    if(k > 240) throw new Error('textures did not finish loading - run fetch-assets.sh first');
    await sleep(250);
  }
  window.requestAnimationFrame = () => 0;
  await sleep(1500);                   // let the already-scheduled frame finish, after which we are the only thing stepping it

  // Pin the size: any window change and the page's resize listener recomputes it by devicePixelRatio
  S.resize = function(){
    this.renderer.setPixelRatio(1); this.renderer.setSize(W, H, false);
    this.composer.setPixelRatio(1); this.composer.setSize(W, H);
    this.depthRT.setSize(W, H);
    this.dof.uniforms.uTexel.value.set(1 / W, 1 / H);
    this.dof.uniforms.uMax.value = Math.max(3, H * 0.008);
    this.camera.aspect = W / H;
    const vFov = this.camera.fov * Math.PI / 180;
    this.baseR = 1.45 / (Math.tan(vFov / 2) * Math.min(1, W / H));
    this.camera.updateProjectionMatrix();
    this._applyCam();
  };
  S.resize();
  // Grain changes every pixel every frame, defeating GIF's inter-frame differencing entirely; after 256-color quantization it is invisible anyway
  S.grain.uniforms.uAmount.value = 0;
}

/* -- Stepping -- */
const T = () => +$('temp').value;
const P = () => Math.pow(10, (+$('pres').value - 50) / 25);
const setSlider = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event('input')); };

// envK: the environment and the civilization advance at envK times speed while the camera, rotation
// and strikes stay at 1x. Speeding up everything would turn the planet 200 degrees during the 18
// seconds of heating, and you could not see what the surface was doing.
function advance(dt, sub, envK){
  for(let k = 0; k < sub; k++){
    const h = dt / sub;
    C.update(h * envK, T(), P(), S.spinAnomaly);
    S.setEnv(T(), P(), C.struck ? 0 : C.pop);
    if(envK > 1) S._dampEnv(h * (envK - 1));
    S.update(h);
  }
}

function fresh(spin){
  $('reset').click();
  setSlider('pres', 50); setSlider('temp', 288);
  C.drain();
  S.warm = false;                      // the environment lands on its target directly, with no damped ramp to wait out
  S.cur.fire = 0; S.cur.burn = 0;
  S.driftT = 0; S.wind = 0;
  for(let i = 0; i < 4; i++) advance(1 / FPS, 1, 1);
  S.spin = spin;                       // 2.9 puts the Indian Ocean toward the camera, 3.3 East Asia
}

/* -- Events -- */
let cur = null;
const onShock = S.onShock, onEnd = S.onEffectEnd;
S.onShock = () => { if(cur) cur.events.shock ??= cur.frames; onShock && onShock(); };
S.onEffectEnd = w => {
  if(cur){ cur.events.end ??= cur.frames; cur.verdict = C.verdict(); }
  onEnd && onEnd(w);
};

function strike(kind, m){
  m.events.trigger = m.frames;
  $(kind).click();                     // go through the button: the strike and the civilization's reaction share one path
}

// The hand for the spin clip. Coordinates are canvas pixels, and compose.py draws the touch point from them.
let ptr = null;
const grab = (x, y) => { S.grab(); ptr = [x, y]; };
const drag = (dx, dy) => { S.dragBy(dx, dy); ptr[0] += dx; ptr[1] += dy; };
const release = () => { S.release(); ptr = null; };

/* -- The clips -- */
const CLIPS = {
  a_hero: {
    spin:2.9, dt:2.5 / FPS, sub:1,
    until: m => m.frames >= 120,
  },
  b_foil: {
    spin:3.3, sub:2,
    step: (i, m) => { if(i === 16) strike('foil', m); },
    // The hold has to be long enough to read the verdict: 1.6s to fade in, then about 3s more
    until: m => m.events.end !== undefined && m.frames >= m.events.end + 110,
  },
  c_crush: {
    spin:3.3, sub:4,                   // the fracture frames change fastest, so they get twice the substeps
    step: (i, m) => {
      if(i === 12) strike('crush', m);
      // The fragments keep integrating to 1.8 after the "end", so hold only once they have settled
      if(m.events.settled === undefined && S.state === 'done' && S.effectT >= 1.8) m.events.settled = i;
    },
    until: m => m.events.settled !== undefined && m.frames >= m.events.settled + 48,
  },
  d_heat: {
    spin:3.3, sub:3, envK:3,
    // 6s up to 520K (fires hang off thermal shock, so it has to rise hard), then 5s to 800K, then
    // hold while the slow channels catch up.
    // Not 900: above 880K the whole planet is white hot and blown out, and bloom smears the frame.
    temp: te => te < 1 ? 288 : te < 7 ? 288 + (te - 1) / 6 * 232
              : te < 12 ? 520 + (te - 7) / 5 * 280 : 800,
    until: m => m.envT >= 18 - 1e-6,
  },
  e_cold: {
    spin:3.3, sub:3, envK:3, tilt:0.28,  // tipped toward the northern hemisphere, to watch the ice spread down from Siberia
    // The ice line advances as the ice channel goes 296 -> 214K with tau=4: descend slowly to 200K to let it run its full course, then drop to the bottom
    temp: te => te < 1 ? 288 : te < 14 ? 288 - (te - 1) / 13 * 88
              : te < 18 ? 200 - (te - 14) / 4 * 90 : 110,
    until: m => m.envT >= 21 - 1e-6,
  },
  f_spin: {
    spin:3.3, sub:2,
    step: i => {
      // Flick it left and let inertia carry it
      if(i === 12) grab(600, 300);
      if(i >= 13 && i <= 32){ const s = Math.pow((i - 13) / 19, 1.5); drag(-(4 + 22 * s), -0.6); }
      if(i === 33) release();
      // Grab it to a stop, then tip down to look at the north pole
      if(i === 81) grab(470, 250);
      if(i >= 82 && i <= 105) drag(-2, 7);
      if(i === 106) release();
      // Tip back. The speed is brought to zero on a sine before release, or the tilt overshoots on its own momentum
      if(i === 136) grab(480, 410);
      if(i >= 137 && i <= 156){ const s = Math.sin((i - 136.5) / 20 * Math.PI); drag(9 * s, -13.9 * s); }
      if(i === 157) release();
    },
    until: m => m.frames >= 190,
  },
};

async function capture(name){
  const c = CLIPS[name];
  if(!c) throw new Error('no such clip: ' + name);
  await post(`/reset/${name}`, '');
  const m = cur = { frames:0, events:{}, ptr:[], log:[], temp:[], envT:0, spec:C.idText, verdict:null };
  fresh(c.spin);
  if(c.tilt) S.userEl = c.tilt;
  const dt = c.dt ?? 1 / FPS, envK = c.envK ?? 1;

  while(!c.until(m)){
    if(m.frames > 600) throw new Error(name + ' will not stop');
    if(c.temp) setSlider('temp', Math.round(c.temp(m.envT)));
    if(c.step) c.step(m.frames, m);
    advance(dt, c.sub, envK);
    m.envT += dt * envK;
    // One second of yours is forty-seven of their years - the same conversion as main.js
    for(const msg of C.drain()) m.log.push({ f:m.frames, year:Math.floor(m.envT * 47), ...msg });
    m.ptr.push(S.grabbed && ptr ? [...ptr] : null);
    m.temp.push(T());
    // Must be read in the same task as the render: the buffer is cleared afterwards
    await post(`/frame/${name}/${m.frames}`, cv.toDataURL('image/png'));
    m.frames++;
    document.title = `capturing ${name} · ${m.frames}`;
  }
  cur = null;
  return m;
}

try{
  await freeze();
  const want = new URLSearchParams(location.search).get('clips');
  const names = want ? want.split(',') : Object.keys(CLIPS);
  const meta = {};
  for(const n of names) meta[n] = await capture(n);
  await post('/meta', JSON.stringify(meta));
  document.title = 'capture complete';
}catch(e){
  console.error(e);
  document.title = 'capture failed';
  await post('/fail', String(e && e.stack || e)).catch(() => {});
}
