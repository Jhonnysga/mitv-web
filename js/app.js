'use strict';
/* MiTV — interfaz principal */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    tab: 'tv',
    channels: [],
    categories: [],
    activeCat: 'all',
    favs: new Set(),
    epgCache: {},        // 'YYYY-MM-DD' -> { epgId: [programs] }
    catchupMap: {},      // channelId -> catchupId
    movies: [], moviePage: 0, movieCat: 'all', movieDone: false,
    series: [], seriesPage: 0, seriesDone: false,
    search: '',
  };
  try {
    const f = JSON.parse(localStorage.getItem('mitv_favs_v1') || '[]');
    if (Array.isArray(f)) state.favs = new Set(f);
  } catch { /* noop */ }
  function saveFavs() {
    try { localStorage.setItem('mitv_favs_v1', JSON.stringify([...state.favs])); } catch { /* noop */ }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }
  function friendly(err) {
    if (err && MiTVApi.isGeoBlock(err)) return MiTVApi.GEO_MSG;
    if (err && err.message) return err.message;
    return 'Ocurrió un error inesperado.';
  }

  /* ---------- tiempo ---------- */
  function parseTime(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  function fmtHM(d) {
    if (!d) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmtClock(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return h > 0 ? h + ':' + mm : mm;
  }
  function dayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------- programas EPG (formato defensivo) ---------- */
  function normProgram(p) {
    if (!p || typeof p !== 'object') return null;
    const title = p.title || p.name || p.programTitle || p.program_title || '';
    const start = parseTime(p.start ?? p.startTime ?? p.begin ?? p.beginTime ?? p.startsAt ?? p.start_at);
    const end = parseTime(p.end ?? p.endTime ?? p.finish ?? p.finishTime ?? p.endsAt ?? p.end_at);
    const desc = p.description || p.synopsis || p.plot || '';
    const id = p.id ?? p.programId ?? p.program_id ?? null;
    if (!title && !start) return null;
    return { id, title: String(title), start, end, desc: String(desc) };
  }
  function epgListFor(payload, epgId) {
    // La respuesta puede ser arreglo, {epgId:[...]}, {programs:[...]} u otras variantes
    let arr = MiTVApi.asArray(payload);
    if (arr.length) return arr.map(normProgram).filter(Boolean);
    if (payload && typeof payload === 'object') {
      for (const k of Object.keys(payload)) {
        if (String(k) === String(epgId) && Array.isArray(payload[k])) {
          return payload[k].map(normProgram).filter(Boolean);
        }
      }
      for (const k of ['programs', 'programmes', 'events', 'items']) {
        if (Array.isArray(payload[k])) return payload[k].map(normProgram).filter(Boolean);
      }
    }
    return [];
  }

  /* ---------- vistas ---------- */
  function showView(name) {
    for (const v of ['view-login', 'view-loading', 'app']) $(v).classList.add('hidden');
    if (name === 'login') {
      $('view-login').classList.remove('hidden');
      // El campo usuario recibe el foco de inmediato para empezar a escribir
      const u = $('login-user');
      if (u) u.focus({ preventScroll: true });
      return;
    }
    if (name === 'loading') { $('view-loading').classList.remove('hidden'); return; }
    $('app').classList.remove('hidden');
    for (const s of ['view-tv', 'view-movies', 'view-series', 'view-catchup']) {
      $(s).classList.toggle('hidden', s !== 'view-' + name);
    }
    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    state.tab = name;
    if (name === 'tv' && !state.channels.length) loadTv();
    if (name === 'movies' && !state.movies.length) loadMovies(true);
    if (name === 'series' && !state.series.length) loadSeries(true);
    if (name === 'catchup' && !$('catchup-channels').children.length) loadCatchupChannels();
  }

  /* ---------- login ---------- */
  async function doLogin(ev) {
    ev.preventDefault();
    const btn = $('login-btn'), errBox = $('login-error');
    errBox.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    const email = $('login-user').value.trim();
    const password = $('login-pass').value;
    const remember = $('login-remember').checked;
    try {
      await MiTVApi.login(email, password, remember);
      enterApp();
    } catch (err) {
      errBox.textContent = friendly(err);
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  }
  function enterApp() {
    showView('tv');
    loadCatchupMap();
    loadContinueWatching();
  }
  async function doLogout() {
    try { await MiTVApi.logout(); } catch { /* noop */ }
    closePlayer();
    location.reload();
  }

  /* ---------- TV: canales ---------- */
  async function loadTv() {
    const grid = $('channel-grid');
    grid.innerHTML = '<p class="empty">Cargando canales…</p>';
    try {
      const [channels, cats] = await Promise.all([
        MiTVApi.getChannels(),
        MiTVApi.getChannelCategories().catch(() => []),
      ]);
      state.channels = channels.filter(c => MiTVApi.chId(c) != null);
      state.channels.sort((a, b) => {
        const na = parseFloat(MiTVApi.chNum(a)), nb = parseFloat(MiTVApi.chNum(b));
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return MiTVApi.chName(a).localeCompare(MiTVApi.chName(b));
      });
      state.categories = cats;
      renderCatChips();
      renderChannels();
      loadNowNext();
    } catch (err) {
      grid.innerHTML = '';
      $('tv-empty').textContent = friendly(err);
      $('tv-empty').classList.remove('hidden');
      if (err && err.code === 'NO_SESSION') showView('login');
    }
  }

  function renderCatChips() {
    const box = $('cat-chips');
    const cats = [{ id: 'all', name: 'Todos' }, { id: 'fav', name: '★ Favoritos' }];
    for (const c of state.categories) {
      const id = c.id ?? c.categoryId ?? c.name;
      const name = c.name || c.title || String(id);
      if (id != null) cats.push({ id: String(id), name: String(name) });
    }
    box.innerHTML = cats.map(c =>
      '<button class="chip' + (state.activeCat === c.id ? ' active' : '') +
      '" data-cat="' + esc(c.id) + '">' + esc(c.name) + '</button>').join('');
    box.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
      state.activeCat = b.dataset.cat;
      renderCatChips();
      renderChannels();
    }));
  }

  function filteredChannels() {
    const q = state.search.trim().toLowerCase();
    return state.channels.filter(c => {
      if (state.activeCat === 'fav' && !state.favs.has(String(MiTVApi.chId(c)))) return false;
      if (state.activeCat !== 'all' && state.activeCat !== 'fav' &&
          String(MiTVApi.chCatId(c)) !== state.activeCat) return false;
      if (q && !(MiTVApi.chName(c).toLowerCase().includes(q) ||
                 String(MiTVApi.chNum(c)).toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderChannels() {
    const grid = $('channel-grid');
    const list = filteredChannels();
    $('tv-empty').classList.toggle('hidden', list.length > 0);
    if (!list.length && state.channels.length) {
      $('tv-empty').textContent = 'Sin resultados para este filtro.';
    }
    grid.innerHTML = list.map(c => {
      const id = MiTVApi.chId(c);
      const fav = state.favs.has(String(id));
      return '<button class="card" data-id="' + esc(id) + '" data-epg="' + esc(MiTVApi.chEpgId(c) || '') + '">' +
        '<img class="logo" loading="lazy" alt="" src="' + esc(MiTVApi.chLogo(c)) + '" ' +
        'onerror="this.style.visibility=\'hidden\'">' +
        '<span class="num">' + esc(MiTVApi.chNum(c)) + '</span>' +
        '<span class="name">' + esc(MiTVApi.chName(c)) + '</span>' +
        '<span class="now" data-now>…</span>' +
        '<span class="fav' + (fav ? ' on' : '') + '" data-fav role="button" tabindex="0" ' +
        'aria-label="Favorito" title="Favorito">★</span>' +
        '</button>';
    }).join('');
    grid.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-fav]')) return;
        const ch = state.channels.find(x => String(MiTVApi.chId(x)) === card.dataset.id);
        if (ch) playChannel(ch);
      });
    });
    grid.querySelectorAll('[data-fav]').forEach(star => {
      const toggle = (ev) => {
        ev.stopPropagation();
        const card = star.closest('.card');
        const id = card.dataset.id;
        if (state.favs.has(id)) { state.favs.delete(id); star.classList.remove('on'); }
        else { state.favs.add(id); star.classList.add('on'); }
        saveFavs();
        if (state.activeCat === 'fav') renderChannels();
      };
      star.addEventListener('click', toggle);
      star.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(ev); }
      });
    });
    paintNowNext();
  }

  async function loadNowNext() {
    const ids = [...new Set(state.channels.map(c => MiTVApi.chEpgId(c)).filter(Boolean))];
    if (!ids.length) { paintNowNext(); return; }
    const today = new Date();
    const key = dayKey(today);
    try {
      const { start, end } = MiTVApi.dayBounds(today);
      const payload = await MiTVApi.getEpg({ epgIds: ids, start, end });
      const map = {};
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        for (const k of Object.keys(payload)) {
          const arr = MiTVApi.asArray(payload[k]);
          map[String(k)] = (arr.length ? arr : payload[k]).constructor === Array
            ? arr.map(normProgram).filter(Boolean)
            : epgListFor(payload[k]);
        }
      }
      state.epgCache[key] = map;
    } catch { /* la grilla funciona sin EPG */ }
    paintNowNext();
  }

  function nowNextFor(epgId) {
    if (!epgId) return null;
    const key = dayKey(new Date());
    const list = (state.epgCache[key] || {})[String(epgId)];
    if (!list || !list.length) return null;
    const now = new Date();
    const sorted = [...list].sort((a, b) => (a.start || 0) - (b.start || 0));
    let cur = null, nxt = null;
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      if (p.start && p.end && p.start <= now && now < p.end) { cur = p; nxt = sorted[i + 1] || null; break; }
      if (p.start && p.start > now) { nxt = p; break; }
    }
    return { cur, nxt };
  }

  function paintNowNext() {
    document.querySelectorAll('#channel-grid .card').forEach(card => {
      const slot = card.querySelector('[data-now]');
      if (!slot) return;
      const nn = nowNextFor(card.dataset.epg);
      if (!nn || (!nn.cur && !nn.nxt)) { slot.innerHTML = ''; return; }
      let html = '';
      if (nn.cur) html += '<b>' + esc(nn.cur.title) + '</b>';
      if (nn.nxt) html += (html ? '<br>' : '') + '<span>Sigue: ' + esc(nn.nxt.title) +
        (nn.nxt.start ? ' · ' + fmtHM(nn.nxt.start) : '') + '</span>';
      slot.innerHTML = html;
    });
  }

  /* ---------- modal genérico ---------- */
  function openModal(html) {
    $('modal-body').innerHTML = html;
    $('modal').classList.remove('hidden');
  }
  function closeModal() {
    $('modal').classList.add('hidden');
    $('modal-body').innerHTML = '';
  }

  /* ---------- reproductor ---------- */
  let currentGuideChannel = null;
  async function openPlayer({ title, sub, getStream, guideChannel = null, live = false }) {
    currentGuideChannel = guideChannel || null;
    $('player-guide-btn').classList.toggle('hidden', !currentGuideChannel);
    $('player-title').textContent = title || '';
    $('player-sub').textContent = sub || '';
    $('player-overlay').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('ctrl-play').textContent = '⏸';
    wireSeekMode(live);
    try {
      const info = await getStream();
      await MiTVPlayer.load(info);
    } catch (err) {
      MiTVPlayer.showError(friendly(err));
    }
  }
  function wireSeekMode(live) {
    const seek = $('ctrl-seek');
    const badgeId = 'live-badge';
    let badge = document.getElementById(badgeId);
    if (live) {
      seek.classList.add('hidden');
      if (!badge) {
        badge = document.createElement('span');
        badge.id = badgeId;
        badge.className = 'live-badge';
        badge.textContent = 'EN VIVO';
        seek.parentNode.insertBefore(badge, seek);
      }
      badge.classList.remove('hidden');
      $('ctrl-time').textContent = '';
    } else {
      seek.classList.remove('hidden');
      if (badge) badge.classList.add('hidden');
    }
  }
  function closePlayer() {
    MiTVPlayer.unload();
    $('player-overlay').classList.add('hidden');
    document.body.style.overflow = '';
    currentGuideChannel = null;
  }
  function playChannel(ch) {
    const id = MiTVApi.chId(ch);
    openPlayer({
      title: (MiTVApi.chNum(ch) ? MiTVApi.chNum(ch) + ' · ' : '') + MiTVApi.chName(ch),
      sub: (() => { const nn = nowNextFor(MiTVApi.chEpgId(ch)); return nn && nn.cur ? 'Ahora: ' + nn.cur.title : ''; })(),
      guideChannel: ch,
      live: true,
      getStream: () => MiTVApi.getChannelStream(id),
    });
    try { MiTVApi.call('PUT', '/v3/channels/recently-watched/' + encodeURIComponent(id), {}); } catch { /* noop */ }
  }

  function initPlayerControls() {
    const v = MiTVPlayer.getVideo();
    $('player-back').addEventListener('click', closePlayer);
    $('player-guide-btn').addEventListener('click', () => {
      if (currentGuideChannel) openGuide(currentGuideChannel);
    });
    $('ctrl-play').addEventListener('click', () => {
      if (v.paused) { v.play().catch(() => {}); } else { v.pause(); }
    });
    v.addEventListener('play', () => { $('ctrl-play').textContent = '⏸'; });
    v.addEventListener('pause', () => { $('ctrl-play').textContent = '▶'; });
    v.addEventListener('timeupdate', () => {
      if (!v.duration || MiTVPlayer.isLive()) return;
      $('ctrl-seek').value = Math.round((v.currentTime / v.duration) * 1000);
      $('ctrl-time').textContent = fmtClock(v.currentTime) + ' / ' + fmtClock(v.duration);
    });
    $('ctrl-seek').addEventListener('input', () => {
      if (v.duration && !MiTVPlayer.isLive()) {
        v.currentTime = ($('ctrl-seek').value / 1000) * v.duration;
      }
    });
    $('ctrl-mute').addEventListener('click', () => {
      v.muted = !v.muted;
      $('ctrl-mute').textContent = v.muted ? '🔇' : '🔊';
    });
    $('ctrl-full').addEventListener('click', () => {
      const stage = document.getElementById('player-overlay');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else stage.requestFullscreen().catch(() => {});
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (!$('modal').classList.contains('hidden')) closeModal();
        else if (!$('player-overlay').classList.contains('hidden')) closePlayer();
      }
      if (!$('player-overlay').classList.contains('hidden') && ev.key === ' ') {
        const tag = (document.activeElement || {}).tagName;
        if (tag !== 'INPUT' && tag !== 'BUTTON') {
          ev.preventDefault();
          $('ctrl-play').click();
        }
      }
    });
  }

  /* ---------- guía de 5 días ---------- */
  const GUIDE_DAYS = [
    { off: -2, label: 'Anteayer' }, { off: -1, label: 'Ayer' }, { off: 0, label: 'Hoy' },
    { off: 1, label: 'Mañana' }, { off: 2, label: 'Pasado mañana' },
  ];
  async function openGuide(ch) {
    const epgId = MiTVApi.chEpgId(ch);
    if (!epgId) { toast('Este canal no tiene guía disponible.'); return; }
    openModal('<h2>' + esc(MiTVApi.chName(ch)) + ' — Guía</h2>' +
      '<div class="day-tabs">' + GUIDE_DAYS.map((d, i) =>
        '<button class="chip' + (i === 2 ? ' active' : '') + '" data-day="' + d.off + '">' + d.label + '</button>').join('') +
      '</div><div id="guide-list" class="programs"><p class="hint">Cargando…</p></div>');
    const list = $('guide-list');
    async function loadDay(off) {
      list.innerHTML = '<p class="hint">Cargando…</p>';
      const date = new Date();
      date.setDate(date.getDate() + off);
      try {
        const { start, end } = MiTVApi.dayBounds(date);
        const payload = await MiTVApi.getEpg({ epgIds: [epgId], start, end });
        let programs = epgListFor(payload, epgId);
        if (!programs.length && payload && typeof payload === 'object') {
          for (const k of Object.keys(payload)) {
            const cand = epgListFor(payload[k], epgId);
            if (cand.length) { programs = cand; break; }
          }
        }
        programs.sort((a, b) => (a.start || 0) - (b.start || 0));
        if (!programs.length) { list.innerHTML = '<p class="hint">Sin programación para este día.</p>'; return; }
        const now = new Date();
        list.innerHTML = programs.map(p => {
          const past = p.end && p.end < now;
          return '<button class="program' + (past ? ' past' : '') + '" data-pid="' + esc(p.id || '') + '">' +
            '<span class="t">' + esc(fmtHM(p.start)) + (p.end ? '–' + esc(fmtHM(p.end)) : '') + '</span>' +
            '<span><span class="pt">' + esc(p.title) + '</span>' +
            (p.desc ? '<span class="pd">' + esc(p.desc.slice(0, 160)) + '</span>' : '') + '</span>' +
            '</button>';
        }).join('');
        list.querySelectorAll('.program').forEach((b, i) => b.addEventListener('click', () => {
          const p = programs[i];
          const past = p.end && p.end < now;
          if (past) playCatchupProgram(ch, p);
          else if (p.start && p.start <= now && (!p.end || p.end > now)) playChannel(ch);
          else toast('Este programa aún no empieza.');
        }));
      } catch (err) {
        list.innerHTML = '<p class="hint">' + esc(friendly(err)) + '</p>';
      }
    }
    document.querySelectorAll('#modal .day-tabs .chip').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('#modal .day-tabs .chip').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      loadDay(parseInt(b.dataset.day, 10));
    }));
    loadDay(0);
  }

  /* ---------- catchup ---------- */
  async function loadCatchupMap() {
    try {
      const payload = await MiTVApi.getCatchupIndex();
      const arr = MiTVApi.asArray(payload);
      for (const it of arr) {
        const chId = it.channelId ?? it.channel_id ?? it.id;
        const cpId = it.catchupId ?? it.catchup_id ?? it.id;
        if (chId != null && cpId != null) state.catchupMap[String(chId)] = cpId;
      }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        for (const k of Object.keys(payload)) {
          const v = payload[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const cpId = v.catchupId ?? v.catchup_id ?? v.id;
            if (cpId != null) state.catchupMap[String(k)] = cpId;
          }
        }
      }
    } catch { /* catchup opcional */ }
  }
  async function loadCatchupChannels() {
    const box = $('catchup-channels');
    box.innerHTML = '<p class="empty">Cargando…</p>';
    try {
      if (!state.channels.length) state.channels = await MiTVApi.getChannels();
      const withCatchup = state.channels.filter(c => state.catchupMap[String(MiTVApi.chId(c))] != null);
      const list = withCatchup.length ? withCatchup : state.channels;
      if (!withCatchup.length) {
        box.innerHTML = '<p class="empty">No se pudo determinar qué canales tienen catchup; mostrando todos.</p>' + box.innerHTML;
      } else {
        box.innerHTML = '';
      }
      box.insertAdjacentHTML('beforeend', list.map(c =>
        '<button class="card" data-id="' + esc(MiTVApi.chId(c)) + '">' +
        '<img class="logo" loading="lazy" alt="" src="' + esc(MiTVApi.chLogo(c)) + '" onerror="this.style.visibility=\'hidden\'">' +
        '<span class="num">' + esc(MiTVApi.chNum(c)) + '</span>' +
        '<span class="name">' + esc(MiTVApi.chName(c)) + '</span></button>').join(''));
      box.querySelectorAll('.card').forEach(card => card.addEventListener('click', () => {
        const ch = state.channels.find(x => String(MiTVApi.chId(x)) === card.dataset.id);
        if (ch) openCatchupChannel(ch);
      }));
    } catch (err) {
      box.innerHTML = '<p class="empty">' + esc(friendly(err)) + '</p>';
    }
  }
  async function openCatchupChannel(ch) {
    const id = MiTVApi.chId(ch);
    $('catchup-channels').classList.add('hidden');
    const wrap = $('catchup-programs');
    wrap.classList.remove('hidden');
    $('catchup-title').textContent = MiTVApi.chName(ch) + ' — últimas 48 horas';
    const list = $('catchup-list');
    list.innerHTML = '<p class="hint">Cargando programas…</p>';
    let catchupId = state.catchupMap[String(id)];
    if (catchupId == null) catchupId = id; // intento razonable documentado
    try {
      const programs = (await MiTVApi.getCatchupProgrammes(id, catchupId))
        .map(normProgram).filter(Boolean)
        .sort((a, b) => (b.start || 0) - (a.start || 0));
      if (!programs.length) { list.innerHTML = '<p class="hint">Sin programas disponibles.</p>'; return; }
      list.innerHTML = programs.map((p, i) =>
        '<button class="program past" data-i="' + i + '">' +
        '<span class="t">' + esc(fmtHM(p.start)) + '</span>' +
        '<span><span class="pt">' + esc(p.title) + '</span>' +
        (p.desc ? '<span class="pd">' + esc(p.desc.slice(0, 160)) + '</span>' : '') + '</span></button>').join('');
      list.querySelectorAll('.program').forEach(b => b.addEventListener('click', () => {
        playCatchupProgram(ch, programs[parseInt(b.dataset.i, 10)], catchupId);
      }));
    } catch (err) {
      list.innerHTML = '<p class="hint">' + esc(friendly(err)) + '</p>';
    }
  }
  async function playCatchupProgram(ch, program, catchupId) {
    const id = MiTVApi.chId(ch);
    const cid = catchupId != null ? catchupId : (state.catchupMap[String(id)] != null ? state.catchupMap[String(id)] : id);
    const pid = program.id;
    if (pid == null) { toast('Este programa no tiene reproducción disponible.'); return; }
    openPlayer({
      title: program.title,
      sub: MiTVApi.chName(ch) + (program.start ? ' · ' + fmtHM(program.start) : ''),
      live: false,
      getStream: () => MiTVApi.getCatchupProgrammeStream(id, cid, pid),
    });
  }

  /* ---------- películas ---------- */
  const PAGE_SIZE = 30;
  async function loadMovies(reset) {
    if (reset) { state.movies = []; state.moviePage = 0; state.movieDone = false; $('movie-grid').innerHTML = ''; }
    if (state.movieDone) return;
    const grid = $('movie-grid');
    if (reset) {
      try {
        const cats = await MiTVApi.getVodCategories().catch(() => []);
        renderVodCatChips(cats);
      } catch { /* noop */ }
    }
    try {
      const query = { count: PAGE_SIZE, page: state.moviePage, 'sort-by': 'updatedTime', 'sort-order': 'desc' };
      if (state.movieCat !== 'all') query.categoryId = state.movieCat;
      const items = await MiTVApi.getVods(query);
      state.moviePage++;
      if (items.length < PAGE_SIZE) state.movieDone = true;
      state.movies.push(...items);
      renderMovies();
    } catch (err) {
      if (reset) grid.innerHTML = '<p class="empty">' + esc(friendly(err)) + '</p>';
      else toast(friendly(err));
    }
    $('movies-more').classList.toggle('hidden', state.movieDone || !state.movies.length);
  }
  function renderVodCatChips(cats) {
    const box = $('movie-cat-chips');
    const list = [{ id: 'all', name: 'Todas' }];
    for (const c of cats) {
      const id = c.id ?? c.categoryId ?? c.name;
      if (id != null) list.push({ id: String(id), name: String(c.name || c.title || id) });
    }
    box.innerHTML = list.map(c =>
      '<button class="chip' + (state.movieCat === c.id ? ' active' : '') +
      '" data-cat="' + esc(c.id) + '">' + esc(c.name) + '</button>').join('');
    box.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
      state.movieCat = b.dataset.cat;
      renderVodCatChips(cats);
      loadMovies(true);
    }));
  }
  function filteredVods() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.movies;
    return state.movies.filter(v => MiTVApi.vodTitle(v).toLowerCase().includes(q));
  }
  function renderMovies() {
    const grid = $('movie-grid');
    const list = filteredVods();
    grid.innerHTML = list.map((v, i) =>
      '<button class="card" data-i="' + i + '">' +
      '<img class="poster" loading="lazy" alt="" src="' + esc(MiTVApi.vodPoster(v)) + '" onerror="this.style.visibility=\'hidden\'">' +
      '<span class="name">' + esc(MiTVApi.vodTitle(v)) + '</span>' +
      (MiTVApi.vodYear(v) ? '<span class="now">' + esc(MiTVApi.vodYear(v)) + '</span>' : '') +
      '</button>').join('') || '<p class="empty">Sin resultados.</p>';
    grid.querySelectorAll('.card').forEach(card => card.addEventListener('click', () => {
      openVodDetail(filteredVods()[parseInt(card.dataset.i, 10)]);
    }));
  }
  function openVodDetail(v) {
    const id = MiTVApi.vodId(v);
    openModal('<div class="detail">' +
      '<img alt="" src="' + esc(MiTVApi.vodPoster(v)) + '" onerror="this.style.display=\'none\'">' +
      '<div><h2>' + esc(MiTVApi.vodTitle(v)) + '</h2>' +
      '<div class="meta">' + esc([MiTVApi.vodYear(v)].filter(Boolean).join(' · ')) + '</div>' +
      '<p>' + esc(MiTVApi.vodDesc(v) || 'Sin sinopsis disponible.') + '</p>' +
      '<div class="actions"><button class="btn primary" id="vod-play">▶ Ver ahora</button></div>' +
      '</div></div>');
    $('vod-play').addEventListener('click', () => {
      closeModal();
      openPlayer({
        title: MiTVApi.vodTitle(v), sub: MiTVApi.vodYear(v), live: false,
        getStream: () => MiTVApi.getVodStream(id),
      });
    });
  }

  /* ---------- series ---------- */
  async function loadSeries(reset) {
    if (reset) { state.series = []; state.seriesPage = 0; state.seriesDone = false; $('series-grid').innerHTML = ''; }
    if (state.seriesDone) return;
    const grid = $('series-grid');
    try {
      const items = await MiTVApi.getTvShows({ count: PAGE_SIZE, page: state.seriesPage, 'sort-by': 'updatedTime', 'sort-order': 'desc' });
      state.seriesPage++;
      if (items.length < PAGE_SIZE) state.seriesDone = true;
      state.series.push(...items);
      renderSeries();
    } catch (err) {
      if (reset) grid.innerHTML = '<p class="empty">' + esc(friendly(err)) + '</p>';
      else toast(friendly(err));
    }
    $('series-more').classList.toggle('hidden', state.seriesDone || !state.series.length);
  }
  function filteredSeries() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.series;
    return state.series.filter(s => MiTVApi.vodTitle(s).toLowerCase().includes(q));
  }
  function renderSeries() {
    const grid = $('series-grid');
    const list = filteredSeries();
    grid.innerHTML = list.map((s, i) =>
      '<button class="card" data-i="' + i + '">' +
      '<img class="poster" loading="lazy" alt="" src="' + esc(MiTVApi.vodPoster(s)) + '" onerror="this.style.visibility=\'hidden\'">' +
      '<span class="name">' + esc(MiTVApi.vodTitle(s)) + '</span></button>').join('') ||
      '<p class="empty">Sin resultados.</p>';
    grid.querySelectorAll('.card').forEach(card => card.addEventListener('click', () => {
      openSeriesDetail(filteredSeries()[parseInt(card.dataset.i, 10)]);
    }));
  }
  async function openSeriesDetail(s) {
    const id = MiTVApi.vodId(s);
    openModal('<div class="detail">' +
      '<img alt="" src="' + esc(MiTVApi.vodPoster(s)) + '" onerror="this.style.display=\'none\'">' +
      '<div><h2>' + esc(MiTVApi.vodTitle(s)) + '</h2>' +
      '<div class="meta">' + esc(MiTVApi.vodYear(s)) + '</div>' +
      '<p>' + esc(MiTVApi.vodDesc(s) || 'Sin sinopsis disponible.') + '</p></div></div>' +
      '<div id="seasons"><p class="hint">Cargando temporadas…</p></div>');
    try {
      const seasons = await MiTVApi.getTvShowSeasons(id);
      const box = $('seasons');
      if (!seasons.length) { box.innerHTML = '<p class="hint">Sin temporadas disponibles.</p>'; return; }
      box.innerHTML = '';
      for (const sn of seasons) {
        const snId = sn.id ?? sn.seasonId;
        const snName = sn.name || sn.title || ('Temporada ' + (sn.seasonNumber || ''));
        const div = document.createElement('div');
        div.className = 'season';
        div.innerHTML = '<h3>' + esc(snName) + '</h3><div class="eps"><p class="hint">Cargando episodios…</p></div>';
        box.appendChild(div);
        try {
          const eps = await MiTVApi.getSeasonEpisodes(id, snId);
          const epsBox = div.querySelector('.eps');
          epsBox.innerHTML = eps.map((e, i) => {
            const num = e.episodeNumber ?? e.episode_number ?? (i + 1);
            const t = e.title || e.name || ('Episodio ' + num);
            return '<button class="ep" data-i="' + i + '"><span class="n">' + esc(num) + '</span>' +
              '<span>' + esc(t) + '</span></button>';
          }).join('') || '<p class="hint">Sin episodios.</p>';
          epsBox.querySelectorAll('.ep').forEach(b => b.addEventListener('click', () => {
            const ep = eps[parseInt(b.dataset.i, 10)];
            const epId = ep.id ?? ep.episodeId;
            closeModal();
            openPlayer({
              title: MiTVApi.vodTitle(s) + ' — ' + (ep.title || ep.name || 'Episodio'),
              sub: snName, live: false,
              getStream: () => MiTVApi.getEpisodeStream(id, snId, epId),
            });
          }));
        } catch (err) {
          div.querySelector('.eps').innerHTML = '<p class="hint">' + esc(friendly(err)) + '</p>';
        }
      }
    } catch (err) {
      $('seasons').innerHTML = '<p class="hint">' + esc(friendly(err)) + '</p>';
    }
  }

  /* ---------- seguir viendo ---------- */
  async function loadContinueWatching() {
    let items = [];
    try { items = await MiTVApi.getContinueWatching(); } catch { return; }
    if (!items.length) return;
    const grid = $('continue-grid');
    const cards = [];
    for (const it of items) {
      const type = it.mediaType || it.type || '';
      const title = it.title || it.name || '';
      const img = it.image || it.poster || it.posterUrl || it.logoUrl || '';
      let play = null;
      if (/TV_CHANNEL/i.test(type) && (it.channelId ?? it.channel_id ?? it.id) != null) {
        const cid = it.channelId ?? it.channel_id ?? it.id;
        play = () => {
          const ch = state.channels.find(x => String(MiTVApi.chId(x)) === String(cid));
          if (ch) playChannel(ch);
          else openPlayer({ title, sub: '', live: true, getStream: () => MiTVApi.getChannelStream(cid) });
        };
      } else if (/VOD/i.test(type) && (it.vodId ?? it.vod_id ?? it.id) != null) {
        const vid = it.vodId ?? it.vod_id ?? it.id;
        play = () => openPlayer({ title, sub: '', live: false, getStream: () => MiTVApi.getVodStream(vid) });
      }
      if (play) cards.push({ title, img, play });
    }
    if (!cards.length) return;
    $('continue-row').classList.remove('hidden');
    grid.innerHTML = cards.map((c, i) =>
      '<button class="card" data-i="' + i + '">' +
      (c.img ? '<img class="logo" loading="lazy" alt="" src="' + esc(c.img) + '" onerror="this.style.visibility=\'hidden\'' + '>' : '') +
      '<span class="name">' + esc(c.title || 'Continuar') + '</span></button>').join('');
    grid.querySelectorAll('.card').forEach(card =>
      card.addEventListener('click', () => cards[parseInt(card.dataset.i, 10)].play()));
  }

  /* ---------- buscador / tabs / init ---------- */
  let searchTimer = null;
  function initSearch() {
    $('search').addEventListener('input', (ev) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = ev.target.value;
        if (state.tab === 'tv') renderChannels();
        else if (state.tab === 'movies') renderMovies();
        else if (state.tab === 'series') renderSeries();
      }, 250);
    });
  }
  function initTabs() {
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      state.search = '';
      $('search').value = '';
      showView(t.dataset.tab);
    }));
    $('movies-more').addEventListener('click', () => loadMovies(false));
    $('series-more').addEventListener('click', () => loadSeries(false));
    $('catchup-back').addEventListener('click', () => {
      $('catchup-programs').classList.add('hidden');
      $('catchup-channels').classList.remove('hidden');
    });
  }

  async function init() {
    $('login-form').addEventListener('submit', doLogin);
    $('btn-logout').addEventListener('click', doLogout);
    $('modal-close').addEventListener('click', closeModal);
    $('modal').addEventListener('click', (ev) => { if (ev.target === $('modal')) closeModal(); });
    initPlayerControls();
    initSearch();
    initTabs();
    const creds = MiTVApi.getCreds();
    if (creds && creds.email) {
      $('login-user').value = creds.email;
      $('login-pass').value = creds.password || '';
    } else {
      // Pre-llenar el último usuario escrito (sin la clave)
      $('login-user').value = MiTVApi.getLastUser();
    }
    if (MiTVApi.signedIn()) {
      // Hay sesión guardada: validar sin mostrar el login de por medio
      showView('loading');
      try {
        await MiTVApi.get('/v3/account');
        enterApp();
        return;
      } catch { /* sesión inválida: mostrar login */ }
    }
    showView('login');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
