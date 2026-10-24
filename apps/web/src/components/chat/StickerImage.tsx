import { useEffect, useRef, useState } from 'react';
import { fileUrl } from '@/lib/format';
import { LOTTIE_MAX_BYTES, sanitizeLottie } from '@/lib/lottie';
import { useUI } from '@/stores/ui';

type Sticker = { id: string; name: string; url: string; format?: string };

/** Lottie sticker: lottie-web (light build, no expressions) is loaded on first use, and only for sanitized JSON. Falls back to the sticker name on any problem. */
function LottieSticker({ sticker, className }: { sticker: Sticker; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const reduce = useUI((s) => s.prefs.reducedMotion);
  useEffect(() => {
    let anim: { destroy(): void } | null = null, alive = true;
    (async () => {
      try {
        const res = await fetch(fileUrl(sticker.url) ?? sticker.url, { credentials: 'omit' });
        const len = Number(res.headers.get('content-length') ?? 0);
        if (!res.ok || len > LOTTIE_MAX_BYTES) throw new Error('bad sticker');
        const text = await res.text();
        if (text.length > LOTTIE_MAX_BYTES) throw new Error('too large');
        const data = sanitizeLottie(JSON.parse(text));
        if (!data) throw new Error('rejected');
        const lottie = (await import('lottie-web/build/player/lottie_light')).default;
        if (!alive || !box.current) return;
        anim = lottie.loadAnimation({ container: box.current, renderer: 'svg', loop: !reduce, autoplay: !reduce, animationData: data, rendererSettings: { progressiveLoad: true } });
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; anim?.destroy(); };
  }, [sticker.url, reduce]);
  if (failed) return <span className={className} title={sticker.name}>{sticker.name}</span>;
  return <div ref={box} role="img" aria-label={sticker.name} title={sticker.name} className={className} />;
}

/** Any sticker: PNG/APNG/GIF/SVG through <img>, Lottie through the sandboxed player above. */
export function StickerImage({ sticker, className, loading = 'lazy' }: { sticker: Sticker; className?: string; loading?: 'lazy' | 'eager' }) {
  if (sticker.format === 'lottie') return <LottieSticker sticker={sticker} className={className} />;
  return <img loading={loading} decoding="async" src={fileUrl(sticker.url) ?? sticker.url} alt={sticker.name} title={sticker.name} className={className} />;
}
