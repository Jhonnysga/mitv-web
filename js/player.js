'use strict';
/* MiTV — reproductor HLS con Shaka Player + Widevine/EME.
   El endpoint `/url` devuelve la URL del manifiesto y, si aplica, la info de
   licencia DRM. Todo se configura aquí de forma defensiva. */
const MiTVPlayer = (() => {
  const video = () => document.getElementById('video');
  let shakaPlayer = null;
  let onErrorCb = null;

  function supported() {
    return typeof window.shaka !== 'undefined' &&
           window.shaka.Player.isBrowserSupported();
  }

  function showError(msg) {
    const el = document.getElementById('player-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideError() {
    document.getElementById('player-error').classList.add('hidden');
  }
  function spinner(on) {
    document.getElementById('player-spinner').classList.toggle('hidden', !on);
  }

  async function init() {
    if (shakaPlayer || !supported()) return supported();
    shaka.installPolyfills();
    shakaPlayer = new shaka.Player(video());
    shakaPlayer.addEventListener('error', (e) => {
      const err = e.detail || {};
      const msg = 'Error de reproducción (' + (err.code || '?') + '). ' +
        (err.code === 6001 || err.code === 6010
          ? 'Contenido protegido: no se pudo obtener la licencia DRM.'
          : 'Inténtalo de nuevo en unos segundos.');
      spinner(false);
      showError(msg);
      if (onErrorCb) onErrorCb(err);
    });
    shakaPlayer.addEventListener('buffering', (e) => spinner(!!e.buffering));
    return true;
  }

  // streamInfo: { url, drm: { licenseUrl, headers } | null }
  async function load(streamInfo) {
    hideError();
    if (!streamInfo || !streamInfo.url) {
      showError('No se recibió URL de reproducción del servidor.');
      return false;
    }
    if (!(await init())) {
      showError('Este navegador no soporta la reproducción protegida (Widevine). Prueba con Chrome o Edge.');
      return false;
    }
    const finalUrl = MiTVApi.rewriteStreamUrl(streamInfo.url);
    try {
      shakaPlayer.resetConfiguration();
      const drm = streamInfo.drm || null;
      if (drm && (drm.licenseUrl || drm.license_url)) {
        const licenseUrl = drm.licenseUrl || drm.license_url;
        const cfg = { drm: { servers: { 'com.widevine.alpha': licenseUrl } } };
        shakaPlayer.configure(cfg);
        const headers = drm.headers || drm.licenseHeaders || null;
        if (headers && typeof headers === 'object') {
          shakaPlayer.getNetworkingEngine().registerRequestFilter((_type, request) => {
            if (request.uris[0] === licenseUrl || /license/i.test(request.uris[0])) {
              Object.assign(request.headers, headers);
            }
          });
        }
      }
      spinner(true);
      await shakaPlayer.load(finalUrl);
      spinner(false);
      try { await video().play(); } catch { /* el usuario dará play */ }
      return true;
    } catch (err) {
      spinner(false);
      const code = err && err.code;
      showError(code === 6001 || code === 6010
        ? 'Contenido protegido: falló la licencia Widevine. Verifica tu suscripción.'
        : 'No se pudo cargar el video (' + (code || 'error') + '). Inténtalo de nuevo.');
      if (onErrorCb) onErrorCb(err);
      return false;
    }
  }

  async function unload() {
    hideError();
    try { if (shakaPlayer) await shakaPlayer.unload(); } catch { /* noop */ }
    try { video().removeAttribute('src'); video().load(); } catch { /* noop */ }
  }

  function onError(cb) { onErrorCb = cb; }
  function getVideo() { return video(); }
  function isLive() {
    try { return shakaPlayer ? shakaPlayer.isLive() : false; }
    catch { return false; }
  }

  return { supported, init, load, unload, onError, getVideo, isLive, showError };
})();
