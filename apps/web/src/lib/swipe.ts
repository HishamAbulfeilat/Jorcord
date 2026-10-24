/**
 * Swipe gestures on messages (touch devices). Direction is the physical screen direction of the finger, so it behaves
 * the same in right-to-left languages: the user picks what "swipe right" and "swipe left" do in Settings.
 * Defaults: right = reply, left = react. Edit is never the default for either side, so a reply swipe and an edit swipe
 * can no longer fight over the same direction.
 */
export type SwipeAction = 'reply' | 'react' | 'edit' | 'none';
export type SwipeDir = 'left' | 'right';
export interface SwipePrefs { swipeRight: SwipeAction; swipeLeft: SwipeAction }
export const SWIPE_ACTIONS: readonly SwipeAction[] = ['reply', 'react', 'edit', 'none'];
export const DEFAULT_SWIPE: SwipePrefs = { swipeRight: 'reply', swipeLeft: 'react' };

export const SWIPE_THRESHOLD = 64;
export const SWIPE_MAX_MS = 800;
/** The finger must travel this far before the row starts to follow it (and long-press is cancelled). */
export const SWIPE_SLOP = 10;

export const isSwipeAction = (v: unknown): v is SwipeAction => typeof v === 'string' && (SWIPE_ACTIONS as readonly string[]).includes(v);
export function sanitizeSwipe(p: Partial<Record<keyof SwipePrefs, unknown>> | undefined): SwipePrefs {
  return { swipeRight: isSwipeAction(p?.swipeRight) ? p!.swipeRight : DEFAULT_SWIPE.swipeRight, swipeLeft: isSwipeAction(p?.swipeLeft) ? p!.swipeLeft : DEFAULT_SWIPE.swipeLeft };
}

/** Is this touch travel a horizontal swipe? Mostly-vertical drags are scrolling and never count. */
export function isHorizontalDrag(dx: number, dy: number, slop = SWIPE_SLOP): boolean {
  return Math.abs(dx) > slop && Math.abs(dx) > Math.abs(dy) * 1.5;
}

/** Final classification on touch end: a quick, mostly horizontal travel of at least the threshold. */
export function classifySwipe(dx: number, dy: number, elapsedMs: number, threshold = SWIPE_THRESHOLD): SwipeDir | null {
  if (elapsedMs > SWIPE_MAX_MS || Math.abs(dx) < threshold || Math.abs(dy) > Math.abs(dx) * 0.6) return null;
  return dx > 0 ? 'right' : 'left';
}

export interface SwipeCaps { canReply: boolean; canReact: boolean; canEdit: boolean }
/** The action configured for a direction, or 'none' when the viewer may not do it on this message. */
export function actionFor(dir: SwipeDir, prefs: SwipePrefs, caps: SwipeCaps): SwipeAction {
  const a = dir === 'right' ? prefs.swipeRight : prefs.swipeLeft;
  if (a === 'reply') return caps.canReply ? 'reply' : 'none';
  if (a === 'react') return caps.canReact ? 'react' : 'none';
  if (a === 'edit') return caps.canEdit ? 'edit' : 'none';
  return 'none';
}

/** How far the row follows the finger: 1:1 up to the threshold, then a damped stretch, capped. */
export function dragOffset(dx: number, threshold = SWIPE_THRESHOLD): number {
  const a = Math.abs(dx); const s = Math.sign(dx);
  return s * (a <= threshold ? a : Math.min(threshold + (a - threshold) * 0.25, threshold * 1.5));
}

export const SWIPE_LABEL: Record<SwipeAction, string> = { reply: 'Reply', react: 'Add reaction', edit: 'Edit message (your own)', none: 'Nothing' };

/** Targets that handle their own touches (links, buttons, text selection, media scrubbing, code blocks). */
export const SWIPE_IGNORE = 'a,button,input,textarea,select,video,audio,pre,[contenteditable],[data-noswipe],[role=slider]';
