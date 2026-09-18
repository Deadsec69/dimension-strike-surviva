// 生存模式结算 —— 抓拍、上报、画像与观测者榜
//
// 服务器只在本地 serve.py 里有；GitHub Pages 上每个 fetch 都 404，一律吞掉，流程照走：
// 判词照出，画像退成原片按档调色，榜单只活在本页内存里。
// 抓拍发生在一局结束的那一帧（fire() 里），不在判词那一刻：判词要等 2.7 秒的碎裂动画，
// 到那时脸上的反应已经散了。

const GOD_SCORE = 250;                                   // 与 serve.py 保持一致：五十颗小行星的分（每颗 5）
const TIER_ZH = { devil:'魔', god:'神', human:'人' };
const TIER_EN = { devil:'DEVIL', god:'GOD', human:'HUMAN' };
const PROBE_MS = 8000, FINISH_MS = 20000;               // 结算立刻回（分先入账），画像在后台生成、这边轮询
const POLL_MS = 3000, POLL_MAX_MS = 20 * 60000;        // Gemini 慢起来实测要十分钟以上：轮询二十分钟，之后当失败
const BOARD_REFRESH_MS = 10000;                        // 榜上还有在生成的行时，每 10 秒刷一次
const tmo = ms => AbortSignal.timeout(ms);

export function tierOf(ending, score){
  return score >= GOD_SCORE ? 'god' : ending === 'self' ? 'devil' : 'human';
}

/* 从直播 <video> 抓一张 640×480 JPEG（纯 base64）。面板上是 scaleX(-1) 的镜像，
   照片也要镜像——那才是他自己看见的那张脸。无流 / 未就绪 → null。 */
export function captureSnapshot(video){
  if(!video?.srcObject || video.readyState < 2 || !video.videoWidth) return null;
  const W = 640, H = 480, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const s = Math.max(W / video.videoWidth, H / video.videoHeight);       // object-fit:cover 同款裁法
  const w = video.videoWidth * s, h = video.videoHeight * s;
  ctx.translate(W, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h);
  try{ return c.toDataURL('image/jpeg', 0.85).split(',')[1]; }catch{ return null; }
}

export class Board {
  constructor(el){
    this.el = el;                     // { userName, portrait, portraitImg, portraitMeta, board }
    this.online = null;               // null = 未探；探过一次就定
    this.hasKey = false;
    this.rows = []; this.local = []; this.run = null; this.seq = 0;
    this.capture = captureSnapshot;   // 无头测试可替换：__ds.board.capture = () => B64
  }

  username(){
    const v = (this.el.userName?.value || '').trim() || localStorage.getItem('ds.username') || '观测者';
    return v.slice(0, 16);
  }

  async probe(){                      // 进生存模式时探一次
    try{
      const r = await fetch('api/health', { cache:'no-store', signal:tmo(PROBE_MS) });
      const j = r.ok ? await r.json() : null;            // Pages 回 404 HTML：先看 ok 再 json
      this.online = !!j?.ok; this.hasKey = !!j?.hasKey;
    }catch{ this.online = false; }
    this._toggle();
    if(this.online) await this.refresh();
    return this.online;
  }

  async refresh(){
    try{
      const r = await fetch('api/leaderboard?limit=8', { cache:'no-store', signal:tmo(PROBE_MS) });
      if(r.ok) this.rows = (await r.json()).leaderboard || [];
    }catch{}
    this.render(this.run?.entry);
    // 榜上还有画像没生成完的行（也许是上一次会话留下的）：过会儿再来看
    clearTimeout(this._refreshT);
    if(this.rows.some(e => e.pending)) this._refreshT = setTimeout(() => this.refresh(), BOARD_REFRESH_MS);
  }

  /* fire() 那一刻调用：抓拍、定档、立刻上报。判词 2.7 秒后才出现，到时候看 run.state。 */
  endRun({ ending, snapshot, score, kills, elapsed }){
    const run = this.run = {
      id:++this.seq, username:this.username(), ending, tier:tierOf(ending, score),
      score, kills, elapsed:+elapsed.toFixed(1), snapshot, state:'pending', entry:null
    };
    this._submit(run);                // 不 await
    return run;
  }

  async _submit(run){
    const payload = { username:run.username, score:run.score, kills:run.kills, elapsed:run.elapsed,
                      ending:run.ending, tier:run.tier, snapshot:run.snapshot };
    try{
      // 不看 online：探测超时不该让整局白抓。真没有服务器（Pages）这里会立刻 404，一样走降级
      const r = await fetch('api/finish', { method:'POST', headers:{ 'Content-Type':'application/json' },
                                            body:JSON.stringify(payload), signal:tmo(FINISH_MS) });
      if(!r.ok) throw new Error('finish → ' + r.status);
      const j = await r.json();
      run.entry = j.entry; run.state = j.entry.pending ? 'generating' : 'done'; this.online = true;
      if(j.leaderboard) this.rows = j.leaderboard;
      if(j.warnings?.length) console.warn('[结算] 降级：', j.warnings);
      if(run.state === 'generating') this._poll(run);
    }catch(e){                        // 服务器不在 / 超时 / 5xx：原片 + 本地行，不落盘
      console.warn('[结算] 本地降级：', e.message);
      run.state = 'failed'; run.error = e.message;
      run.entry = { username:run.username, score:run.score, kills:run.kills, elapsed:run.elapsed, ending:run.ending,
                    tier:run.tier, portrait:null, emotion:null, emotion_zh:null,
                    ts:new Date().toISOString(), local:true, id:'local-' + run.id };
      this.local.push(run.entry);
    }
    this._toggle();
    this._paintVerdict(run);
    this.render(run.entry);
  }

  /* 画像在服务器后台生成：每 3 秒问一次，到了就换上。哪怕玩家已经开了下一局，榜单上的缩略图也会补上。 */
  async _poll(run){
    const t0 = performance.now();
    while(performance.now() - t0 < POLL_MAX_MS){
      await new Promise(r => setTimeout(r, POLL_MS));
      try{
        const r = await fetch('api/run/' + encodeURIComponent(run.entry.id), { cache:'no-store', signal:tmo(PROBE_MS) });
        if(!r.ok) continue;
        const e = (await r.json()).entry;
        if(!e || e.pending) continue;
        run.entry = e; run.state = 'done';
        if(e.warnings?.length) console.warn('[结算] 画像降级：', e.warnings);
        this._paintVerdict(run);
        await this.refresh(); this.render(run.entry);
        return;
      }catch{}
    }
    run.state = 'done'; run.entry.pending = false; run.entry.timeout = true;
    this._paintVerdict(run);
  }

  showVerdict(){ this._paintVerdict(this.run); }       // main.showVerdict() 调用；非生存局 run 为 null

  clear(){                                             // 换样本 / 退出 / 重开：丢掉本局；迟到的响应只刷榜不画像
    this.run = null;
    const { portrait, portraitImg, portraitMeta } = this.el;
    portrait.className = 'portrait'; portrait.removeAttribute('href');
    portraitImg.removeAttribute('src'); portraitMeta.textContent = '';
  }

  _paintVerdict(run){
    const { portrait, portraitImg, portraitMeta } = this.el;
    if(!run || run !== this.run) return;
    portrait.className = `portrait is-on is-${run.tier}`;
    // 评级先行，在计分卡上说清楚：魔 DEVIL / 人 HUMAN / 神 GOD
    const tierTag = () => { const b = document.createElement('b'); b.className = `tier is-${run.tier}`;
      b.textContent = `评级 ${TIER_ZH[run.tier]} · ${TIER_EN[run.tier]}`; return b; };
    if(run.state === 'pending' || run.state === 'generating'){
      portrait.classList.add('is-wait');
      if(run.snapshot) portraitImg.src = 'data:image/jpeg;base64,' + run.snapshot;   // 先垫原片，画像到了再换
      portraitMeta.replaceChildren(tierTag(), document.createTextNode(run.state === 'pending' ? '　记录中…' : '　生成画像中…（Gemini 有时要几分钟）'));
      return;
    }
    const e = run.entry;
    if(e.portrait){ portraitImg.src = e.portrait; portrait.href = e.portrait; }
    else if(run.snapshot){                            // 降级：原片，按档调色
      portraitImg.src = portrait.href = 'data:image/jpeg;base64,' + run.snapshot;
      portrait.classList.add('is-raw');
    }else portrait.classList.add('is-none');
    const why = e.local ? (run.error === 'offline' || /Failed to fetch|404/.test(run.error || '') ? '　· 未连接服务器' : '　· 未存档')
              : (e.timeout ? '　· 画像超时' : (!e.portrait && e.warnings?.length ? '　· 画像失败' : ''));
    portraitMeta.replaceChildren(tierTag(),
      document.createTextNode(`　表情 ${e.emotion_zh || e.emotion || '未读出'}` + why));
  }

  _toggle(){ document.body.classList.toggle('has-board', !!this.online || this.local.length > 0); }

  render(me){
    const rows = [...this.rows, ...this.local]
      .sort((a, b) => b.score - a.score || (a.ts < b.ts ? -1 : 1)).slice(0, 8);
    this.el.board.replaceChildren(...rows.map((e, i) => {
      const li = document.createElement('li');
      li.className = (me && e.id === me.id ? 'is-me' : '') + (e.local ? ' is-local' : '');
      const thumb = document.createElement(e.portrait ? 'a' : 'span');
      thumb.className = `thumb is-${e.tier}` + (e.pending ? ' is-pending' : '');
      if(e.pending) thumb.title = '画像生成中…';
      if(e.portrait){
        thumb.href = e.portrait; thumb.target = '_blank'; thumb.rel = 'noopener';
        const img = new Image(); img.src = e.portrait; img.alt = ''; thumb.appendChild(img);
      }
      const mk = (cls, txt, title) => { const s = document.createElement('span'); s.className = cls; s.textContent = txt; if(title) s.title = title; return s; };
      li.append(mk('rank', String(i + 1).padStart(2, '0')), thumb,
                mk('name', e.username, `${TIER_ZH[e.tier] || ''} · ${e.emotion_zh || e.emotion || ''} · ${e.elapsed}s · ${e.kills} 颗`),
                mk(`tag is-${e.tier}`, TIER_EN[e.tier] || ''),
                mk('score num', Number(e.score || 0).toLocaleString('en-US')));
      return li;
    }));
  }
}
