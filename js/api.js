'use strict';
/* MiTV — cliente de la API de Thundernet TV GO (middleware Setplex Nora).
   Contrato verificado el 12/10/2026 (ver ../API.md).
   Las credenciales solo se guardan en el localStorage de ESTE navegador y
   solo se envían a https://app.thundernet.net.ve. Nada sale a otros servidores. */
const MiTVApi = (() => {
  const ORIGIN = 'https://app.thundernet.net.ve';
  const API = ORIGIN + '/wbs/web/api';          // prefijo del cliente oficial
  const AUTH_URL = ORIGIN + '/wbs/web/auth';    // login (verificado en vivo)
  const LOGOUT_URL = ORIGIN + '/wbs/web/logout';
  const GEO_CODES = new Set(['GE001', 'WB0051', 'WB0052', 'WG0062']);

  const LS_SESSION = 'mitv_session_v1';
  const LS_CREDS = 'mitv_creds_v1';
  const LS_DEVICE = 'mitv_device_id_v1';
  const LS_LAST_USER = 'mitv_last_user_v1';

  let session = null;
  try { session = JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch { session = null; }

  class ApiError extends Error {
    constructor(code, message, http) {
      super(message || code || 'Error de API');
      this.name = 'ApiError';
      this.code = code || 'API_ERROR';
      this.http = http || 0;
    }
  }

  function isGeoBlock(err) {
    if (!(err instanceof ApiError)) return false;
    if (GEO_CODES.has(err.code)) return true;
    return /geoblock|no est[aá] disponible en su regi[oó]n/i.test(err.message || '');
  }
  const GEO_MSG = 'Servicio disponible solo en Venezuela. Conéctate desde una red venezolana e inténtalo de nuevo.';

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(LS_SESSION, JSON.stringify(s));
      else localStorage.removeItem(LS_SESSION);
    } catch { /* almacenamiento no disponible */ }
  }
  function getSession() { return session; }
  function signedIn() { return !!(session && session.token); }

  function saveCreds(email, password) {
    try {
      localStorage.setItem(LS_CREDS, JSON.stringify({ email, password }));
    } catch { /* noop */ }
  }
  function getCreds() {
    try { return JSON.parse(localStorage.getItem(LS_CREDS) || 'null'); } catch { return null; }
  }
  function clearCreds() { try { localStorage.removeItem(LS_CREDS); } catch { /* noop */ } }
  // Último usuario escrito (solo el usuario, nunca la clave): se pre-llena
  // en el login aunque "recuérdame" esté desactivado.
  function saveLastUser(email) {
    try { if (email) localStorage.setItem(LS_LAST_USER, email); } catch { /* noop */ }
  }
  function getLastUser() {
    try { return localStorage.getItem(LS_LAST_USER) || ''; } catch { return ''; }
  }

  function deviceId() {
    let id = null;
    try { id = localStorage.getItem(LS_DEVICE); } catch { /* noop */ }
    if (!id) {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
      try { localStorage.setItem(LS_DEVICE, id); } catch { /* noop */ }
    }
    return id;
  }

  async function rawRequest(method, url, { body = null, headers = {} } = {}) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: body == null ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError('NETWORK', 'Sin conexión con el servidor. Revisa tu internet.');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* no-JSON */ }
    if (!res.ok) {
      const code = (json && json.errorCode) || ('HTTP_' + res.status);
      const msg = (json && json.message) || ('Error del servidor (HTTP ' + res.status + ')');
      throw new ApiError(code, msg, res.status);
    }
    if (json && json.status === 'ERROR') {
      throw new ApiError(json.errorCode || 'API_ERROR', json.message || 'Error de la API', res.status);
    }
    if (json && typeof json === 'object' && 'payload' in json) return json.payload;
    return json;
  }

  async function tryRefresh() {
    if (!session) return false;
    try {
      const body = session.refreshToken ? { refreshToken: session.refreshToken } : {};
      const payload = await rawRequest('POST', API + '/v3/session/refresh', { body });
      const token = pickToken(payload);
      if (token) {
        saveSession(Object.assign({}, session, { token, obtainedAt: Date.now() }));
        return true;
      }
    } catch { /* cae al re-login */ }
    return false;
  }

  // El formato exacto del payload de login/refresh no está documentado;
  // se aceptan las variantes habituales.
  function pickToken(payload) {
    if (!payload || typeof payload !== 'object') {
      return typeof payload === 'string' && payload.length > 20 ? payload : null;
    }
    return payload.token || payload.accessToken || payload.access_token ||
           payload.sessionToken || payload.jwt || payload.idToken || null;
  }

  async function call(method, path, { body = null, query = null, auth = true, retry = true } = {}) {
    let url = API + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const headers = {};
    if (auth) {
      if (!session || !session.token) throw new ApiError('NO_SESSION', 'Sesión no iniciada');
      headers['Authorization'] = 'Bearer ' + session.token;
    }
    try {
      return await rawRequest(method, url, { body, headers });
    } catch (err) {
      const expired = err.http === 401 || /invalid[_ ]?token|token[_ ]?expired|unauthorized/i.test(err.code + ' ' + err.message);
      if (auth && retry && expired) {
        if (await tryRefresh()) {
          return call(method, path, { body, query, auth, retry: false });
        }
        // Último recurso: re-login silencioso con credenciales guardadas
        const creds = getCreds();
        if (creds) {
          await login(creds.email, creds.password, true);
          return call(method, path, { body, query, auth, retry: false });
        }
      }
      throw err;
    }
  }
  const get = (path, query) => call('GET', path, { query });
  const post = (path, body, query) => call('POST', path, { body, query });

  /* ---------- autenticación ---------- */
  async function login(email, password, remember) {
    saveLastUser(email);
    const payload = await rawRequest('POST', AUTH_URL, {
      body: { email, password, manualProfileManagement: true, model: 'MiTV Web 1.0' },
      headers: {
        'MW-Paid-Content-Allowed': 'true',
        'MW-InApp-Subscription-Payment-Supported': 'true',
      },
    });
    const token = pickToken(payload);
    if (!token) {
      const keys = payload && typeof payload === 'object' ? Object.keys(payload).join(', ') : typeof payload;
      throw new ApiError('LOGIN_FORMAT', 'Respuesta de login inesperada (campos: ' + keys + ').');
    }
    const refreshToken = (payload && (payload.refreshToken || payload.refresh_token)) || null;
    saveSession({ token, refreshToken, obtainedAt: Date.now(), raw: undefined });
    if (remember) saveCreds(email, password); else clearCreds();
    // Token de cuenta para reproducción (si el endpoint lo exige)
    try {
      const acc = await get('/v3/account/access_token');
      const at = pickToken(acc);
      if (at) saveSession(Object.assign({}, getSession(), { accountToken: at }));
    } catch { /* no fatal */ }
    return getSession();
  }

  async function logout() {
    try { await call('POST', '/logout', { auth: true, retry: false }); } catch { /* noop */ }
    // La ruta real del cliente oficial es /wbs/web/logout (fuera de /api)
    try { await rawRequest('POST', LOGOUT_URL, { headers: authHeaders() }); } catch { /* noop */ }
    saveSession(null);
  }
  function authHeaders() {
    return session && session.token ? { 'Authorization': 'Bearer ' + session.token } : {};
  }

  /* ---------- utilidades de respuesta ---------- */
  function asArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') {
      for (const k of ['content', 'channels', 'items', 'list', 'data', 'results', 'programmes', 'programs']) {
        if (Array.isArray(payload[k])) return payload[k];
      }
    }
    return [];
  }
  const chId = c => c && (c.id ?? c.channelId ?? c.channel_id);
  const chName = c => (c && (c.name || c.title)) || 'Canal';
  const chLogo = c => (c && (c.logoUrl || c.logo || c.image || c.poster)) || '';
  const chNum = c => (c && (c.channelNumber ?? c.number ?? c.channel_number)) || '';
  const chCatId = c => c && (c.categoryId ?? c.category_id);
  const chCatName = c => (c && (c.categoryName || c.category_name)) || '';
  const chEpgId = c => c && (c.epgId ?? c.epg_id);

  const vodId = v => v && (v.id ?? v.vodId);
  const vodTitle = v => (v && (v.title || v.name)) || 'Título';
  const vodPoster = v => (v && (v.posterUrl || v.poster || v.image || v.logoUrl)) || '';
  const vodDesc = v => (v && (v.description || v.plot || v.synopsis)) || '';
  const vodYear = v => (v && (v.year || v.releaseYear)) || '';

  /* ---------- macros STPLX_* de las URLs de stream ---------- */
  function macroValues() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const plat = (navigator.platform || '').toLowerCase();
    const os = plat.includes('android') ? 'Android' : plat.includes('iphone') || plat.includes('ipad') ? 'iOS'
      : plat.includes('mac') ? 'macOS' : plat.includes('win') ? 'Windows' : plat.includes('linux') ? 'Linux' : 'Web';
    return {
      STPLX_DEVICE_ID: deviceId(),
      STPLX_APP_NAME: 'MiTV',
      STPLX_APP_VERSION: '1.0',
      STPLX_DEVICE_TYPE: 'WEB',
      STPLX_DEVICE_MODEL: 'Web',
      STPLX_DEVICE_MANUFACTURER: 'MiTV',
      STPLX_OS: os,
      STPLX_DOMAIN: location.hostname,
      STPLX_DT: d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()),
      STPLX_TM: p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()),
      STPLX_ANM: '', STPLX_AVER: '', STPLX_UPAL: '', STPLX_AD_ID: '',
      STPLX_SESSION_CONTENT_UUID: deviceId(),
      STPLX_PLAYER_W: String(window.innerWidth || 0),
      STPLX_PLAYER_H: String(window.innerHeight || 0),
    };
  }
  function rewriteStreamUrl(url) {
    if (!url) return url;
    const vals = macroValues();
    return String(url).replace(/\[?STPLX_[A-Z_]+\]?/g, m => {
      const key = m.replace(/[\[\]]/g, '');
      return encodeURIComponent(key in vals ? vals[key] : '');
    });
  }

  // Normaliza la respuesta de los endpoints `/url`:
  // { url, drm: { licenseUrl, headers } }. Formato exacto por confirmar en vivo.
  function parseStreamInfo(payload) {
    if (!payload) return null;
    if (typeof payload === 'string') return { url: payload, drm: null, raw: payload };
    const url = payload.url || payload.streamUrl || payload.stream_url ||
                payload.hls || payload.playlist || payload.manifest || null;
    let drm = payload.drm || payload.drmInfo || payload.drm_info || null;
    let licenseUrl = (drm && (drm.licenseUrl || drm.license_url)) ||
                     payload.licenseUrl || payload.license_url || null;
    let licenseHeaders = (drm && (drm.headers || drm.licenseHeaders)) ||
                         payload.licenseHeaders || null;
    if (licenseUrl && !drm) drm = { licenseUrl, headers: licenseHeaders };
    return { url, drm, raw: payload };
  }

  /* ---------- endpoints ---------- */
  const getChannels = (query) => get('/v3/channels/tv', query).then(asArray);
  const getChannelCategories = () => get('/v3/channels/tv/categories').then(asArray);
  const getChannelStream = (id) => get('/v3/channels/tv/' + encodeURIComponent(id) + '/url').then(parseStreamInfo);

  const getVods = (query) => get('/v3/vods', query).then(asArray);
  const getVodCategories = () => get('/v3/vods/categories').then(asArray);
  const getVod = (id) => get('/v3/vods/' + encodeURIComponent(id));
  const getVodStream = (id) => get('/v3/vods/' + encodeURIComponent(id) + '/url').then(parseStreamInfo);

  const getTvShows = (query) => get('/v3/tvshows', query).then(asArray);
  const getTvShowSeasons = (id) => get('/v3/tvshows/' + encodeURIComponent(id) + '/seasons').then(asArray);
  const getSeasonEpisodes = (showId, seasonId) =>
    get('/v3/tvshows/' + encodeURIComponent(showId) + '/seasons/' + encodeURIComponent(seasonId) + '/episodes').then(asArray);
  const getEpisodeStream = (showId, seasonId, epId) =>
    get('/v3/tvshows/' + encodeURIComponent(showId) + '/seasons/' + encodeURIComponent(seasonId) +
        '/episodes/' + encodeURIComponent(epId) + '/url').then(parseStreamInfo);

  const getCatchupIndex = () => get('/v3/channels/tv/catchups');
  const getCatchupProgrammes = (channelId, catchupId) =>
    get('/v3/channels/tv/' + encodeURIComponent(channelId) + '/catchups/' +
        encodeURIComponent(catchupId) + '/programmes').then(asArray);
  const getCatchupProgrammeStream = (channelId, catchupId, programmeId) =>
    get('/v3/channels/tv/' + encodeURIComponent(channelId) + '/catchups/' +
        encodeURIComponent(catchupId) + '/programmes/' + encodeURIComponent(programmeId) + '/url')
      .then(parseStreamInfo);

  // EPG: el cliente oficial pide {epgIds, channels, period:{start,end}} por POST.
  async function getEpg({ epgIds = [], channels = [], start, end } = {}) {
    const body = { epgIds, channels, period: { start, end } };
    try {
      return await post('/media/tv/epg', body);
    } catch (e) {
      // Respaldo: GET con query params
      const qs = { start, end };
      if (epgIds.length) qs.epgIds = epgIds.join(',');
      return get('/media/tv/epg', qs);
    }
  }

  const getContinueWatching = () => get('/v3/continue-watching').then(asArray).catch(() => []);

  function dayBounds(date) {
    const s = new Date(date); s.setHours(0, 0, 0, 0);
    const e = new Date(date); e.setHours(23, 59, 59, 999);
    return { start: s.toISOString(), end: e.toISOString() };
  }

  return {
    ApiError, isGeoBlock, GEO_MSG,
    signedIn, getSession, login, logout, getCreds, getLastUser,
    deviceId, rewriteStreamUrl, parseStreamInfo,
    getChannels, getChannelCategories, getChannelStream,
    getVods, getVodCategories, getVod, getVodStream,
    getTvShows, getTvShowSeasons, getSeasonEpisodes, getEpisodeStream,
    getCatchupIndex, getCatchupProgrammes, getCatchupProgrammeStream,
    getEpg, getContinueWatching, dayBounds,
    asArray, chId, chName, chLogo, chNum, chCatId, chCatName, chEpgId,
    vodId, vodTitle, vodPoster, vodDesc, vodYear,
  };
})();
