import { describe, expect, it } from 'vitest';
import { sanitizeLottie } from './lottie';

const base = () => ({ v: '5.7.0', fr: 30, ip: 0, op: 60, w: 512, h: 512, layers: [{ ty: 4, ks: { o: { a: 0, k: 100 } } }], assets: [] as unknown[] });

describe('sanitizeLottie', () => {
  it('accepts a plain animation unchanged', () => { expect(sanitizeLottie(base())).toEqual(base()); });
  it('strips expression strings (key "x")', () => {
    const a = base() as any; a.layers[0].ks.o.x = "var $bm_rt = thisComp.layer('x').transform; fetch('https://evil')";
    const out = sanitizeLottie(a) as any;
    expect(out.layers[0].ks.o.x).toBeUndefined();
    expect(out.layers[0].ks.o.k).toBe(100);
  });
  it('refuses external image assets but allows embedded raster data', () => {
    const ext = base(); ext.assets = [{ id: 'i', w: 1, h: 1, u: 'https://evil.example/', p: 'a.png' }];
    expect(sanitizeLottie(ext)).toBeNull();
    const rel = base(); rel.assets = [{ id: 'i', w: 1, h: 1, u: '', p: 'https://evil.example/a.png' }];
    expect(sanitizeLottie(rel)).toBeNull();
    const emb = base(); emb.assets = [{ id: 'i', w: 1, h: 1, u: '', p: 'data:image/png;base64,iVBORw0KGgo=', e: 1 }];
    expect(sanitizeLottie(emb)).not.toBeNull();
  });
  it('refuses malformed, oversized and hostile documents', () => {
    expect(sanitizeLottie(null)).toBeNull();
    expect(sanitizeLottie([])).toBeNull();
    expect(sanitizeLottie({ ...base(), layers: 'x' })).toBeNull();
    expect(sanitizeLottie({ ...base(), w: 99999 })).toBeNull();
    expect(sanitizeLottie({ ...base(), layers: Array.from({ length: 301 }, () => ({})) })).toBeNull();
    expect(sanitizeLottie(JSON.parse('{"w":10,"h":10,"layers":[],"__proto__":{"x":1}}'))).toBeNull();
    const deep: any = {}; let cur = deep; for (let i = 0; i < 60; i++) { cur.n = {}; cur = cur.n; }
    expect(sanitizeLottie({ ...base(), meta: deep })).toBeNull();
    expect(sanitizeLottie({ ...base(), nm: 'javascript:alert(1)' })).toBeNull();
  });
});
