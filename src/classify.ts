export type Kind = 'image' | 'texture' | 'audio' | 'video' | 'model' | 'wasm' | 'shader' | 'font' | 'script' | 'style' | 'data' | 'other';

const EXT: Record<string, Kind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', bmp: 'image', ico: 'image',
  ktx: 'texture', ktx2: 'texture', basis: 'texture', dds: 'texture', pvr: 'texture', astc: 'texture', tga: 'texture', hdr: 'texture', exr: 'texture',
  mp3: 'audio', ogg: 'audio', oga: 'audio', wav: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio', aif: 'audio', aiff: 'audio', mid: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', ogv: 'video',
  glb: 'model', gltf: 'model', obj: 'model', fbx: 'model', dae: 'model', stl: 'model', bin: 'model', mesh: 'model', usdz: 'model',
  wasm: 'wasm',
  glsl: 'shader', frag: 'shader', vert: 'shader', wgsl: 'shader', shader: 'shader', fx: 'shader',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', fnt: 'font',
  js: 'script', mjs: 'script', cjs: 'script',
  css: 'style',
  json: 'data', xml: 'data', csv: 'data', tmx: 'data', tsx: 'data', atlas: 'data', plist: 'data', yaml: 'data', yml: 'data', data: 'data', pck: 'data', unityweb: 'data', mtl: 'data', txt: 'data',
};

export function classify(url: URL, contentType: string): Kind {
  const last = url.pathname.split('/').pop() ?? '';
  const ext = last.includes('.') ? last.split('.').pop()!.toLowerCase() : '';
  if (EXT[ext]) return EXT[ext]!;
  const ct = contentType.toLowerCase();
  if (ct.includes('wasm')) return 'wasm';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('font/') || ct.includes('font')) return 'font';
  if (ct.includes('javascript')) return 'script';
  if (ct.includes('css')) return 'style';
  if (ct.includes('json') || ct.includes('xml')) return 'data';
  return 'other';
}
