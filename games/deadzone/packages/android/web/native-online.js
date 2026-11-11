/*  ========================= OVERRUN / NATIVE ONLINE =========================

    Injected into the copy of index.html that lives inside the APK. It is not
    part of the web build and never runs in a browser.

    WHY IT EXISTS

    Capacitor serves the bundled game from a local server whose hostname is the
    production hostname (see server.hostname in capacitor.config.json). That is
    deliberate: WebSockets are not routed through the WebView's request
    interceptor, so `wss://<host>/ws` leaves the device and reaches the real
    Cloudflare Worker, which is exactly what online play needs — while every
    page, script, icon and sound still comes off the local disk, so the game
    starts and plays with the radio off.

    The one thing that does NOT work under that arrangement is `fetch('/api/…')`:
    those requests match the local server's authority and get answered from the
    APK's assets, where no /api exists. So the two REST calls the game makes
    (POST /api/quickplay and POST /api/rooms) are routed through Capacitor's
    native HTTP plugin instead, which talks to the network directly and is not
    subject to the interceptor or to CORS.

    Nothing else is touched. If the native plugin is unavailable for any reason
    the call falls through to the ordinary fetch, the request fails, and the
    game does what it already does when there is no server: it plays offline. */

(function () {
  'use strict';

  var HOST = '__OVERRUN_HOST__';
  var ORIGIN = 'https://' + HOST;

  window.OVERRUN_NATIVE = { host: HOST, origin: ORIGIN };

  /* ------------------------------------------------------------ helpers */

  function nativeHttp(options) {
    var cap = window.Capacitor;
    if (!cap) return null;
    try {
      if (cap.Plugins && cap.Plugins.CapacitorHttp && cap.Plugins.CapacitorHttp.request) {
        return cap.Plugins.CapacitorHttp.request(options);
      }
      if (typeof cap.nativePromise === 'function') {
        return cap.nativePromise('CapacitorHttp', 'request', options);
      }
    } catch (e) { /* fall through to the web path */ }
    return null;
  }

  function headerBag(source) {
    var out = {};
    if (!source) return out;
    if (typeof source.forEach === 'function' && !Array.isArray(source)) {
      source.forEach(function (value, key) { out[key] = value; });
      return out;
    }
    Object.keys(source).forEach(function (key) { out[key] = source[key]; });
    return out;
  }

  /* ----------------------------------------------------- /api/* -> native */

  var webFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var raw;
    if (typeof input === 'string') raw = input;
    else if (input instanceof URL) raw = input.href;
    else if (input && typeof input.url === 'string') raw = input.url;
    if (!raw) return webFetch(input, init);

    var target;
    try { target = new URL(raw, window.location.href); }
    catch (e) { return webFetch(input, init); }

    if (target.pathname.indexOf('/api/') !== 0) return webFetch(input, init);

    return (async function () {
      var isRequest = typeof Request !== 'undefined' && input instanceof Request;
      var method = ((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase();

      var headers = headerBag(
        (init && init.headers) || (isRequest ? input.headers : null)
      );

      var body = init && init.body !== undefined ? init.body : null;
      if (body === null && isRequest && method !== 'GET' && method !== 'HEAD') {
        try { body = await input.clone().text(); } catch (e) { body = null; }
      }

      var payload = null;
      if (typeof body === 'string') {
        try { payload = JSON.parse(body); } catch (e) { payload = body; }
      } else if (body && typeof body === 'object' && !(body instanceof Blob)) {
        payload = body;
      }

      var call = nativeHttp({
        url: ORIGIN + target.pathname + target.search,
        method: method,
        headers: headers,
        data: payload,
        connectTimeout: 12000,
        readTimeout: 12000
      });

      // No native plugin: let the normal path try and fail, which the game
      // already treats as "no server, play offline".
      if (!call) return webFetch(input, init);

      var res = await call;
      var status = res && typeof res.status === 'number' ? res.status : 0;
      var data = res ? res.data : null;
      if (data !== null && data !== undefined && typeof data !== 'string') {
        data = JSON.stringify(data);
      }

      var empty = status === 204 || status === 205 || status === 304;
      var type = 'application/json';
      var nativeHeaders = res && res.headers ? res.headers : {};
      Object.keys(nativeHeaders).forEach(function (k) {
        if (k.toLowerCase() === 'content-type') type = nativeHeaders[k];
      });

      return new Response(empty ? null : data, {
        status: status,
        headers: { 'content-type': type }
      });
    })();
  };

  /* ------------------------------------------- websockets -> real server */

  var NativeWebSocket = window.WebSocket;

  function OverrunWebSocket(url, protocols) {
    var fixed = url;
    try {
      var u = new URL(url, window.location.href);
      if (u.protocol === 'ws:' || u.protocol === 'wss:') {
        // location.host is already the production host in the packaged app;
        // this only matters if someone points server.hostname somewhere else.
        if (u.host !== HOST) u.host = HOST;
        u.protocol = 'wss:';
        fixed = u.toString();
      }
    } catch (e) { /* leave the url alone */ }
    return protocols === undefined
      ? new NativeWebSocket(fixed)
      : new NativeWebSocket(fixed, protocols);
  }

  OverrunWebSocket.prototype = NativeWebSocket.prototype;
  OverrunWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  OverrunWebSocket.OPEN = NativeWebSocket.OPEN;
  OverrunWebSocket.CLOSING = NativeWebSocket.CLOSING;
  OverrunWebSocket.CLOSED = NativeWebSocket.CLOSED;

  window.WebSocket = OverrunWebSocket;
})();
