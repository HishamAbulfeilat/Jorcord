/** Push-to-talk: framework-agnostic key listener with release delay. Works for keyboard `code`s (e.g. "KeyV", "Backquote"). */
export interface PttOptions {
  code: string;
  releaseDelayMs?: number;
  /** Ignore key presses while typing in inputs. Default true. */
  ignoreEditable?: boolean;
  onChange: (active: boolean) => void;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !('tagName' in el)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function createPushToTalk(o: PttOptions): () => void {
  const target = o.target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!target) return () => {};
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (v: boolean) => { if (v !== active) { active = v; o.onChange(v); } };
  const down = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.code !== o.code || ke.repeat) return;
    if ((o.ignoreEditable ?? true) && isEditableTarget(ke.target)) return;
    if (timer) { clearTimeout(timer); timer = undefined; }
    set(true);
  };
  const up = (e: Event) => {
    if ((e as KeyboardEvent).code !== o.code) return;
    if (o.releaseDelayMs) timer = setTimeout(() => set(false), o.releaseDelayMs);
    else set(false);
  };
  const blur = () => set(false);
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', blur);
    if (timer) clearTimeout(timer);
    set(false);
  };
}
