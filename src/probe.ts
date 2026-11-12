import type { Page } from 'playwright';

export interface RuntimeProbe {
  engines: string[];
  netLibs: string[];
  serviceGlobals: string[];
  canvases: { width: number; height: number }[];
  webgl: { version: string; renderer: string } | null;
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  indexedDB: string[];
  jsHeapMB: number | null;
}

/** Runs inside the game page. Collects names only, never storage values. */
export async function probe(page: Page): Promise<RuntimeProbe> {
  // tsx/esbuild injects a __name() helper into serialized functions; provide it in the page.
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  return page.evaluate(async () => {
    const w = window as any;
    const pick = (list: [string, unknown][]) => list.filter(([, v]) => !!v).map(([n]) => n);
    const engines = pick([
      ['Unity WebGL', typeof w.createUnityInstance === 'function' || w.UnityLoader],
      ['Godot', w.Godot || (w.Engine && w.Engine.getMissingFeatures)],
      ['Phaser', w.Phaser], ['PixiJS', w.PIXI], ['Three.js', w.THREE], ['Babylon.js', w.BABYLON],
      ['PlayCanvas', w.pc && w.pc.Application], ['Cocos', w.cc && w.cc.game], ['Construct', w.c3_runtimeInterface || w.C3],
      ['Kaboom/Kaplay', w.kaboom || w.kaplay], ['p5.js', w.p5], ['Matter.js', w.Matter], ['Planck/Box2D', w.planck || w.Box2D],
      ['Emscripten', w.Module && w.Module.canvas],
    ]);
    const netLibs = pick([
      ['Socket.IO', w.io && w.io.Manager], ['Colyseus', w.Colyseus], ['Photon', w.Photon], ['PeerJS', w.Peer],
      ['Geckos.io', w.geckos], ['Nakama', w.nakamajs], ['SimplePeer', w.SimplePeer],
    ]);
    const serviceGlobals = pick([
      ['Firebase', w.firebase || w.__FIREBASE_DEFAULTS__], ['Netlify', w.netlifyIdentity], ['Supabase', w.supabase && w.supabase.createClient],
      ['PlayFab', w.PlayFab],
    ]);
    const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => ({ width: c.width, height: c.height }));
    let webgl: { version: string; renderer: string } | null = null;
    try {
      const c = document.createElement('canvas');
      const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        webgl = {
          version: String(gl.getParameter(gl.VERSION)),
          renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
        };
      }
    } catch { /* no webgl */ }
    let idb: string[] = [];
    try {
      const dbs = await (indexedDB as any).databases?.();
      idb = (dbs ?? []).map((d: { name?: string }) => d.name ?? '?');
    } catch { /* unsupported */ }
    const mem = (performance as any).memory;
    return {
      engines, netLibs, serviceGlobals, canvases, webgl,
      localStorageKeys: Object.keys(localStorage),
      sessionStorageKeys: Object.keys(sessionStorage),
      indexedDB: idb,
      jsHeapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    };
  });
}
