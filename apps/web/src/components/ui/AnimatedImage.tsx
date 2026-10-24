import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { useUI } from '@/stores/ui';
import { getCaps } from '@/lib/memory';
import { isAnimatedUrl, useStill } from './Avatar';

/** Animation slots: only a few animated images run at once (more in view just show their first frame until a slot frees up). */
const slots = new Set<object>();
export const animationSlotsInUse = () => slots.size;
export function acquireSlot(token: object, cap = getCaps().animatedImages): boolean {
  if (slots.has(token)) return true;
  if (slots.size >= cap) return false;
  slots.add(token); return true;
}
export const releaseSlot = (token: object) => { slots.delete(token); };

/**
 * `<img>` that respects Settings > Autoplay GIFs / Reduce motion and the low-memory animation cap.
 * Animated sources (gif/apng/webp) animate only while on screen, with a free slot, and autoplay allowed; otherwise they
 * show their first frame, and hovering or focusing the image plays it. Static images are untouched. Always decodes async.
 */
export function AnimatedImg({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const autoplay = useUI((s) => s.prefs.autoplayGifs && !s.prefs.reducedMotion);
  const animated = isAnimatedUrl(src);
  const ref = useRef<HTMLImageElement>(null); const token = useRef({}).current;
  const [visible, setVisible] = useState(!animated); const [hover, setHover] = useState(false); const [slot, setSlot] = useState(false);
  useEffect(() => {
    if (!animated || !ref.current || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { rootMargin: '50px' });
    io.observe(ref.current); return () => io.disconnect();
  }, [animated]);
  const want = animated && visible && (autoplay || hover);
  useEffect(() => {
    if (!want) { releaseSlot(token); setSlot(false); return; }
    setSlot(acquireSlot(token)); return () => releaseSlot(token);
  }, [want, token]);
  const playing = !animated || (want && slot);
  const still = useStill(src, animated && !playing);
  return <img ref={ref} decoding="async" loading="lazy" {...rest} src={playing ? src : still ?? src} onMouseEnter={animated ? () => setHover(true) : undefined} onMouseLeave={animated ? () => setHover(false) : undefined} />;
}
