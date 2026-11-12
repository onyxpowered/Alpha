// Injected into every page BEFORE game code runs (plain JS on purpose: no build helpers).
// Wraps RTCPeerConnection / data channels / getUserMedia to report to ZERO through the
// __zeroRtcReport binding. Never records TURN credentials or IP addresses.
(() => {
  if (window.__zeroRtcInstalled) return;
  window.__zeroRtcInstalled = true;
  const ALLOWED = __ALLOWED_HOSTS__; // hostnames the user authorized (lowercase)
  const report = (e) => { try { window.__zeroRtcReport(e); } catch (_) { /* binding not ready */ } };
  const hostOf = (u) => {
    const m = /^(?:stuns?|turns?):(?:\/\/)?([^:?\/]+|\[[^\]]+\])/i.exec(u);
    return m ? m[1].toLowerCase() : '';
  };
  const b64 = (u8) => {
    let s = '';
    const n = Math.min(u8.length, 512);
    for (let i = 0; i < n; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  };
  const enc = new TextEncoder();
  function frame(kind, url, d) {
    if (typeof d === 'string') return { kind, url, size: enc.encode(d).length, binary: false, payload: d.slice(0, 512) };
    if (d instanceof ArrayBuffer) return { kind, url, size: d.byteLength, binary: true, payload: b64(new Uint8Array(d)) };
    if (ArrayBuffer.isView(d)) return { kind, url, size: d.byteLength, binary: true, payload: b64(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) };
    if (typeof Blob !== 'undefined' && d instanceof Blob) return { kind, url, size: d.size, binary: true };
    return { kind, url, size: 0, binary: true };
  }
  function track(ch, id) {
    const base = 'rtc:' + id + '/' + ch.label;
    report({
      kind: 'rtc-channel', url: base,
      payload: JSON.stringify({ ordered: ch.ordered, maxRetransmits: ch.maxRetransmits, maxPacketLifeTime: ch.maxPacketLifeTime, protocol: ch.protocol, negotiated: ch.negotiated }),
    });
    ch.addEventListener('message', (e) => report(frame('rtc-recv', base, e.data)));
    ch.addEventListener('close', () => report({ kind: 'rtc-state', url: base, payload: 'channel-closed' }));
    ch.addEventListener('error', () => report({ kind: 'rtc-state', url: base, payload: 'channel-error' }));
    const send = ch.send.bind(ch);
    ch.send = (d) => { report(frame('rtc-sent', base, d)); return send(d); };
  }

  const Native = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (Native) {
    let seq = 0;
    class ZeroPC extends Native {
      constructor(config, ...rest) {
        const id = 'pc' + (++seq);
        const cfg = config ? Object.assign({}, config) : {};
        const kept = [];
        if (Array.isArray(cfg.iceServers)) {
          cfg.iceServers = cfg.iceServers.map((s) => {
            const urls = [].concat(s.urls || s.url || []);
            const keep = [];
            for (const u of urls) {
              if (ALLOWED.includes(hostOf(String(u)))) { keep.push(u); kept.push(String(u)); }
              else report({ kind: 'blocked', url: String(u).slice(0, 200), reason: 'ice server not allowed' });
            }
            const c = Object.assign({}, s);
            delete c.url;
            c.urls = keep;
            return c;
          }).filter((s) => s.urls.length);
        }
        super(cfg, ...rest);
        this.__zid = id;
        report({ kind: 'rtc-open', url: 'rtc:' + id, payload: JSON.stringify({ iceServers: kept, requested: [].concat(config && config.iceServers || []).flatMap((s) => [].concat(s.urls || s.url || [])).map(String) }) });
        this.addEventListener('connectionstatechange', () => report({ kind: 'rtc-state', url: 'rtc:' + id, payload: this.connectionState }));
        this.addEventListener('iceconnectionstatechange', () => report({ kind: 'rtc-state', url: 'rtc:' + id, payload: 'ice:' + this.iceConnectionState }));
        this.addEventListener('icecandidate', (e) => {
          if (!e.candidate || !e.candidate.candidate) return;
          const t = /typ (\w+)/.exec(e.candidate.candidate);
          const p = /\b(udp|tcp)\b/i.exec(e.candidate.candidate);
          report({ kind: 'rtc-ice', url: 'rtc:' + id, payload: (t ? t[1] : '?') + '/' + (p ? p[1].toLowerCase() : '?') });
        });
        this.addEventListener('datachannel', (e) => track(e.channel, id));
      }
      createDataChannel(label, opts) {
        const ch = super.createDataChannel(label, opts);
        track(ch, this.__zid);
        return ch;
      }
    }
    window.RTCPeerConnection = ZeroPC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = ZeroPC;
  }

  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const g = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      report({ kind: 'rtc-media', url: 'rtc:media', payload: JSON.stringify({ audio: !!(c && c.audio), video: !!(c && c.video) }) });
      return g(c);
    };
  }
})();
