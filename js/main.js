// Dimensional Strike - wiring
import { PlanetStage } from './planet.js';
import { Civilization } from './civ.js';
import { Board, TIER_EN } from './board.js';
// gesture.js is imported dynamically: it pulls in an 11MB MediaPipe runtime and an 8MB model, and
// most visitors never turn the camera on. Load it when "Turn on camera" is clicked.

const $ = id => document.getElementById(id);

const el = {
  stage:$('stage'), temp:$('temp'), pres:$('pres'), tempOut:$('tempOut'), presOut:$('presOut'),
  reset:$('reset'), statusTag:$('statusTag'), pop:$('popOut'), tech:$('techOut'),
  hab:$('habOut'), habBar:$('habBar'), log:$('log'),
  crush:$('crush'), foil:$('foil'), flash:$('flash'),
  verdict:$('verdict'), verdictText:$('verdictText'),
  cam:$('cam'), camMin:$('camMin'), camBtn:$('camBtn'), video:$('video'), hand:$('hand'), gestState:$('gestState'),
  again:$('again'), specId:$('specId'), specTag:$('specTag'),
  envTag:$('envTag'), survivalBtn:$('survivalBtn'),
  survTime:$('survTime'), survKills:$('survKills'), survBlocks:$('survBlocks'), survShields:$('survShields'), survScore:$('survScore'), survTier:$('survTier'),
  heatWarn:$('heatWarn'),
  userName:$('userName'), nameNote:$('nameNote'), portrait:$('portrait'), portraitImg:$('portraitImg'), portraitMeta:$('portraitMeta'), board:$('board'), boardClear:$('boardClear'), boardTitle:$('boardTitle'),
  boardModal:$('boardModal'), boardRows:$('boardRows'), boardCsv:$('boardCsv'), boardClose:$('boardClose'), modalCount:$('modalCount'),
  boardClearModal:$('boardClearModal')
};

const stage = new PlanetStage(el.stage);
const civ = new Civilization();
const board = new Board(el);    // survival scoring: snapshot, portrait, observer board
window.__ds = { stage, civ, board };   // debug handles

/* -- Pressure on a log scale: slider 0..100 -> 0.01..100 atm, with exactly 1 atm at 50 -- */
const toPressure = v => Math.pow(10, (v - 50) / 25);
const fmtPressure = p =>
  p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p >= 0.1 ? p.toFixed(3) : p.toFixed(4);

let T = 288, P = 1;

function readControls(){
  T = +el.temp.value;
  P = toPressure(+el.pres.value);
  el.tempOut.innerHTML = `${T}<i>K</i>`;
  el.presOut.innerHTML = `${fmtPressure(P)}<i>atm</i>`;
}
el.temp.addEventListener('input', readControls);
el.pres.addEventListener('input', readControls);
readControls();
// Survival mode: impacts drive the environment and the sliders fall back to being gauges - push them
// to the matching position and keep writing the readouts. The module's T/P are untouched, so
// readControls() hands control back in one call on exit.
let envTxt = '';
function writeEnv(t, p){
  const txt = `${Math.round(t)}|${fmtPressure(p)}`;
  if(txt === envTxt) return;
  envTxt = txt;
  el.tempOut.innerHTML = `${Math.round(t)}<i>K</i>`;
  el.presOut.innerHTML = `${fmtPressure(p)}<i>atm</i>`;
  el.temp.value = Math.round(t);
  el.pres.value = 50 + 25 * Math.log10(p);
}

/* -- Draining the amber: as the civilization dies, the color that stands for "them" converges to dead grey -- */
const AMBER = [232, 176, 75], DEAD = [90, 103, 115];
let shownAmber = -1;
function paintLife(life){
  const q = Math.round(life * 24) / 24;          // quantized, so styles aren't rewritten every frame
  if(q === shownAmber) return;
  shownAmber = q;
  const c = AMBER.map((a, i) => Math.round(DEAD[i] + (a - DEAD[i]) * q));
  document.documentElement.style.setProperty('--amber-live', `rgb(${c.join(',')})`);
}

/* -- Comms log -- */
let year = 0;
function pushLog({ text, tone }){
  const li = document.createElement('li');
  li.className = tone === 'final' ? 'is-final' : 'is-new';
  const t = document.createElement('time');
  t.textContent = `T+${String(Math.floor(year)).padStart(4, '0')} STD YR`;
  li.appendChild(t);
  li.appendChild(document.createTextNode(text));
  el.log.appendChild(li);
  // only the newest line is highlighted
  [...el.log.children].forEach(n => { if(n !== li && n.classList.contains('is-new')) n.classList.remove('is-new'); });
  while(el.log.children.length > 14) el.log.removeChild(el.log.firstChild);
}

/* -- Status tag -- */
function statusOf(){
  if(civ.struck === 'foil') return ['FLATTENED', true];
  if(civ.struck === 'crush') return ['DISINTEGRATED', true];
  if(civ.dead) return ['SILENT', true];
  if(civ.pop < 0.25) return ['CRITICAL', true];
  if(civ.pop < 0.7) return ['STRESSED', false];
  return ['OBSERVING', false];
}

/* -- Strikes -- */
function fire(kind){
  if(civ.struck) return false;
  const ok = kind === 'foil' ? stage.triggerFoil() : stage.triggerCrush();
  if(!ok) return false;
  civ.strike(kind);
  el.crush.disabled = el.foil.disabled = true;
  if(survivalOn){
    // The heat-death path already tagged 'heat'; anything else reaching here is a weapon fired by
    // a gesture = you ended it yourself
    survival.finish(endCause || 'self'); endCause = null;
    // The snapshot has to happen now: the verdict waits out a 2.7s shatter animation, and by then
    // the reaction has left the face
    board.endRun({ ending:survival.ending, snapshot:board.capture(el.video),
                   score:survival.score, kills:survival.kills, blocks:survival.blocks, elapsed:survival.elapsed });
  }
  return true;
}
window.__ds.fire = fire;   // test handle: simulate a gesture weapon with no camera

// The flash hangs off the frame the planet breaks, not a scheduled number of seconds: hit-stop
// stretches scene time, so a hardcoded delay is guaranteed to drift out of sync with the picture.
stage.onShock = () => {
  el.flash.animate(
    [{ opacity:0 }, { opacity:.88, offset:.08 }, { opacity:0 }],
    { duration:520, easing:'ease-out' }
  );
};

function showVerdict(){
  if(el.verdict.classList.contains('is-on')) return;
  // In survival the verdict is about you (tier, score, how it ended); in the sandbox it is their story
  el.verdictText.textContent = survivalOn ? survival.verdictCard() : civ.verdict();
  el.verdict.classList.add('is-on');
  el.verdict.setAttribute('aria-hidden', 'false');
  board.showVerdict();
  // While the verdict is up the camera only watches for a clap; interrupt any charge still being held
  gesture?.interrupt();
  gesture?.setClapMode(true);
}
stage.onEffectEnd = showVerdict;

/* -- Replay: on to the next specimen --
   The number only goes up and nothing else changes - to an observer they are interchangeable anyway.
   That fits this premise better than "restart": you are not retrying, you are processing the next one. */
/* Scene reset, shared by newSpecimen and #reset. `next` decides between a new number and
   zeroing the current specimen. */
function resetScene({ next }){
  gesture?.interrupt();          // the fist is probably still clenched: without this it lands on the new specimen 0.3s later
  gesture?.setClapMode(false);   // before stage.reset(): the hitch from switching recognizers falls on the reset frame
  next ? civ.nextSpecimen() : civ.reset();
  stage.reset();
  year = 0; shownAmber = -1;
  el.log.replaceChildren();
  el.crush.disabled = el.foil.disabled = false;
  board.clear();
  el.verdict.classList.remove('is-on');
  el.verdict.setAttribute('aria-hidden', 'true');
  el.specId.textContent = civ.idText;
  el.specTag.textContent = civ.tag;
  el.temp.value = 288; el.pres.value = 50;
  readControls(); envTxt = '';
  if(survivalOn){ survival.start(); board.probe(); }   // in survival, a new specimen = a new run; sliders stay gauges; refresh the board too
}
function newSpecimen(){ resetScene({ next:true }); }
el.again.addEventListener('click', newSpecimen);

el.crush.addEventListener('click', () => fire('crush'));
el.foil.addEventListener('click', () => fire('foil'));

/* -- Handling: turn it like a globe --
   Pointer events are bound to the canvas only; the HUD panels are separate elements above it, so a
   press that lands on a panel never reaches here.
   Pointer events rather than separate mouse/touch paths: one code path covers mouse, touch and pen. */
let dragId = null, lastX = 0, lastY = 0;

el.stage.addEventListener('pointerdown', ev => {
  if(dragId !== null || !stage.grab()) return;
  dragId = ev.pointerId;
  lastX = ev.clientX; lastY = ev.clientY;
  el.stage.setPointerCapture(dragId);   // keep receiving events when the drag leaves the canvas
  el.stage.classList.add('is-grabbing');
});

el.stage.addEventListener('pointermove', ev => {
  if(ev.pointerId !== dragId) return;
  stage.dragBy(ev.clientX - lastX, ev.clientY - lastY);
  lastX = ev.clientX; lastY = ev.clientY;
});

const endDrag = ev => {
  if(ev.pointerId !== dragId) return;
  stage.release();
  el.stage.classList.remove('is-grabbing');
  dragId = null;
};
el.stage.addEventListener('pointerup', endDrag);
el.stage.addEventListener('pointercancel', endDrag);

/* -- Reset (in survival mode this restarts the run) -- */
el.reset.addEventListener('click', () => resetScene({ next:false }));

/* -- Gestures -- */
// The gesture module calls back on every camera frame and the text usually hasn't changed;
// don't write to the DOM each time
let gestTxt = '', gestCls = '';
const setGestState = (txt, cls = '') => {
  if(txt === gestTxt && cls === gestCls) return;
  gestTxt = txt; gestCls = cls;
  el.gestState.textContent = txt;
  el.gestState.className = 'cam-state' + (cls ? ` is-${cls}` : '');
};

let gesture = null;
async function ensureGesture(){
  if(gesture) return gesture;
  setGestState('Loading…');
  const { GestureInput } = await import('./gesture.js');
  gesture = new GestureInput({
    video: el.video,
    canvas: el.hand,
    // Pointer priority covers weapons too: while someone is actually dragging, a fist shouldn't
    // crush the planet out from under them
    canFire: () => !civ.struck && stage.state === 'idle' && dragId === null,
    onGesture: g => {
      // A clap only means anything while the verdict is up; the recognizer only tracks two hands then,
      // and this is a second guard
      if(g === 'clap'){ if(el.verdict.classList.contains('is-on')) newSpecimen(); return true; }
      return fire(g === 'fist' ? 'crush' : 'foil');
    },
    // Charge visuals are for gravity crush only: a two-dimensional weapon has no "building up" to show,
    // so the foil only advances a percentage on the status tag
    onCharge: (kind, k) => stage.setCharge(kind === 'fist' ? k : 0),
    // Crosshair: gesture.js already mirrored it and applied gain; this just forwards it to survival
    onAim: (x, y, pose) => { if(survivalOn) x == null ? survival.aim(null) : survival.aim(x, y, pose); },
    onState: setGestState,
    // Gesture spin goes through exactly the same path as the mouse, inheriting inertia, clamping and
    // the lockout during a strike.
    // Pointer priority: while someone is actually dragging, don't let the camera fight them for the planet.
    onDrag: (kind, dx, dy) => {
      if(dragId !== null) return;
      if(kind === 'start') stage.grab();
      else if(kind === 'move') stage.dragBy(dx, dy);
      else stage.release();
    }
  });
  window.__ds.gesture = gesture;   // debug handle; capture.js only reads stage / civ
  return gesture;
}

let camOn = false;
el.camBtn.addEventListener('click', async () => {
  if(camOn){
    exitSurvival();                  // no hand, no crosshair: turning the camera off leaves survival
    gesture?.stop(); camOn = false;
    el.cam.classList.remove('is-live'); document.body.classList.remove('cam-live');
    el.camBtn.textContent = 'Turn on camera';
    return;
  }
  el.camBtn.disabled = true;
  try{
    const g = await ensureGesture();
    g.setClapMode(el.verdict.classList.contains('is-on'));   // if the verdict is already up, go straight to two-hand mode
    g.setMode(survivalOn ? 'survive' : 'observe');
    await g.start();
    camOn = true;
    el.cam.classList.add('is-live'); document.body.classList.add('cam-live');
    el.camBtn.textContent = 'Turn off camera';
  }catch(err){
    console.error('[gesture]', err);
    el.gestState.textContent = el.gestState.textContent.includes('HTTPS') ? 'HTTPS required' : 'Unavailable';
    el.gestState.className = 'cam-state is-err';
  }finally{
    el.camBtn.disabled = false;
  }
});

/* -- Survival mode --
   Camera only: the cost of a shot is holding your hand still, which costs nothing with a mouse -
   the difficulty comes from the hand.
   Impacts and shields drive the environment and the sliders fall back to gauges; the civilization
   evolves as usual, and their readouts are your scoreboard. */
let survival = null, survivalOn = false, endCause = null;
async function ensureSurvival(){
  if(survival) return survival;
  const { Survival } = await import('./survival.js');
  // Temperature topping out reuses the existing gravity crush; tag 'heat' first so the finish inside
  // fire() knows this wasn't you
  survival = new Survival({ stage, civ, onCrush: () => { endCause = 'heat'; fire('crush'); } });
  window.__ds.survival = survival;
  return survival;
}
async function enterSurvival(force = false){
  if(survivalOn || (!camOn && !force)) return;    // force is for headless tests only
  if(!force && board.isTaken(el.userName.value)){ syncSurvivalBtn(); return; }   // callsign taken: the button is already greyed, this is a second guard
  el.survivalBtn.disabled = true;
  try{
    await ensureSurvival();
    if(!camOn && !force) return;                  // the camera was switched off while the import was in flight
    survivalOn = true;
    document.body.classList.add('is-survive');
    board.probe();                                // is the local server there? if so, pull the board
    el.survivalBtn.textContent = 'Exit Survival';
    el.reset.textContent = 'Restart';
    el.envTag.textContent = 'IMPACT';
    // Verdict still up: that one is gone, move to the next. Otherwise zero the current specimen -
    // it hasn't been spent yet
    resetScene({ next: el.verdict.classList.contains('is-on') });   // this calls survival.start()
    gesture?.setMode('survive');
  }finally{ syncSurvivalBtn(); }
}
function exitSurvival(){
  if(!survivalOn) return;
  survivalOn = false;
  survival.stop();                              // clear the field: asteroids, shields, crosshair
  board.clear();
  gesture?.setMode('observe');
  document.body.classList.remove('is-survive');
  el.survivalBtn.textContent = 'Start Survival';
  el.reset.textContent = 'Reset parameters';
  el.envTag.textContent = 'ENV';
  el.tempOut.classList.remove('is-hot', 'is-critical');
  el.heatWarn.classList.remove('is-on', 'is-critical');
  el.temp.value = 288; el.pres.value = 50;
  readControls(); envTxt = '';                  // hand control back to the sliders; the civilization and stage
                                                // are not reset, the planet cools down on its own
}
el.survivalBtn.addEventListener('click', () => survivalOn ? exitSurvival() : enterSurvival());
// The camera panel can be collapsed (the choice is remembered); the right panel yields to its actual height
el.camMin.addEventListener('click', () => {
  const on = el.cam.classList.toggle('is-min');
  el.camMin.textContent = on ? '+' : '–';
  try{ localStorage.setItem('ds.camMin', on ? '1' : '0'); }catch{}
});
try{ if(localStorage.getItem('ds.camMin') === '1') el.camMin.click(); }catch{}
new ResizeObserver(() => document.documentElement.style.setProperty('--cam-h', el.cam.offsetHeight + 'px')).observe(el.cam);
board.probe();                                   // probe once on page load: the board isn't limited to survival mode
// Observer callsign: required before a run, and the last one is remembered
el.userName.value = localStorage.getItem('ds.username') || '';
const syncSurvivalBtn = () => {
  const name = el.userName.value.trim(), taken = !!name && board.isTaken(name);
  el.nameNote.hidden = !taken;
  el.survivalBtn.disabled = !survivalOn && (!name || taken);   // callsigns are unique: a name already on the board can't start a run
};
el.userName.addEventListener('input', () => { localStorage.setItem('ds.username', el.userName.value.trim()); syncSurvivalBtn(); });
syncSurvivalBtn();
board.onRows = syncSurvivalBtn;                  // recheck after a board refresh: a name someone just finished with counts as taken
window.__ds.enterSurvival = enterSurvival; window.__ds.exitSurvival = exitSurvival;

let survTxt = '';
function writeSurv(){
  const tier = survival.tier;
  const txt = `${survival.elapsed.toFixed(1)}|${survival.kills}|${survival.blocks}|${survival.shields}|${survival.score}|${tier}`;
  if(txt === survTxt) return;
  survTxt = txt;
  el.survTier.textContent = TIER_EN[tier];
  el.survTier.className = `num tier is-${tier}`;
  el.survTime.textContent = survival.elapsed.toFixed(1) + 's';
  el.survKills.textContent = survival.kills;
  el.survBlocks.textContent = survival.blocks;
  el.survShields.textContent = survival.shields;
  el.survScore.textContent = survival.score.toLocaleString('en-US');
}

/* -- Adaptive quality: raise and lower the render scale from the mean real frame interval. The planet
   pipeline is GPU-bound, and full Retina resolution pins it at 30fps; dropping to DPR 1.0 removes
   three quarters of the fragments with almost no visible difference. -- */
const Q_STEPS = [1, 0.83, 0.67];        // DPR 1.5 → 1.25 → 1.0
let qIdx = 0, fEma = 16.7, qSlow = 0, qFast = 0, qHold = 0;
function adaptQuality(rawMs){
  fEma += (rawMs - fEma) * 0.08;
  if(document.hidden){ qSlow = qFast = 0; return; }
  if(qHold > 0){ qHold -= rawMs; return; }
  if(fEma > 22){ qSlow += rawMs; qFast = 0; }
  else if(fEma < 13){ qFast += rawMs; qSlow = 0; }
  else { qSlow = qFast = 0; }
  let next = qIdx;
  if(qSlow > 1200 && qIdx < Q_STEPS.length - 1) next = qIdx + 1;
  else if(qFast > 6000 && qIdx > 0) next = qIdx - 1;
  if(next !== qIdx){
    qIdx = next; qSlow = qFast = 0; qHold = 2000;
    stage.setQuality(Q_STEPS[qIdx]);
    console.log(`[quality] ×${Q_STEPS[qIdx]} (frame ${fEma.toFixed(1)}ms)`);
  }
}
window.__ds.quality = () => ({ scale: Q_STEPS[qIdx], frameMs: +fEma.toFixed(1), pixelRatio: stage.renderer.getPixelRatio() });

/* -- Main loop -- */
let last = performance.now();
function frame(now){
  requestAnimationFrame(frame);
  const rawMs = now - last;
  const dt = Math.min(0.05, rawMs / 1000);
  last = now;
  adaptQuality(rawMs);

  if(!civ.struck) year += dt * 47;     // one second of your time is forty-seven of their years

  let envT = T, envP = P;
  if(survivalOn){
    survival.update(dt);               // step first: this frame's impacts must land before the civilization and stage see them
    envT = survival.T; envP = survival.P;
    writeEnv(envT, envP);
    el.tempOut.classList.toggle('is-hot', envT >= 560);        // two more hits to go
    el.tempOut.classList.toggle('is-critical', envT >= 610);   // one more hit to go
    el.heatWarn.classList.toggle('is-on', !survival.over && envT >= 560);
    el.heatWarn.classList.toggle('is-critical', envT >= 610);
    writeSurv();
  }
  civ.update(dt, envT, envP, stage.spinAnomaly);
  stage.setEnv(envT, envP, civ.pop);
  stage.update(dt);

  el.pop.textContent = civ.popText;
  el.tech.textContent = civ.techText;
  el.hab.textContent = civ.habText;
  el.habBar.style.width = (civ.hab * 100).toFixed(1) + '%';

  const [tag, alert] = statusOf();
  if(el.statusTag.textContent !== tag){
    el.statusTag.textContent = tag;
    el.statusTag.classList.toggle('is-alert', alert);
  }

  paintLife(civ.struck ? 0 : civ.pop);
  for(const m of civ.drain()) pushLog(m);

  // They can be worn down without you touching a weapon. That path used to have no ending and no
  // exit - just an empty planet left over.
  // In survival, the civilization falling silent is something that happens along the way (they are
  // gone around 391K, far from the 640K limit), not an ending.
  if(civ.dead && !civ.struck && !survivalOn) showVerdict();
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  stage.resize();
  if(survivalOn && innerWidth <= 900) exitSurvival();   // the camera panel hides on narrow screens, taking the exit button with it
});
