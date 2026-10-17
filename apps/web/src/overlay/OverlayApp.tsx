import { useEffect, useRef, useState } from 'react';
import { markOverlayDocument, onOverlayState, onOverlayToast, sendOverlayAction, type OverlayState, type OverlayToast } from '@/lib/overlay';
import { OverlayView } from './OverlayView';

const INITIAL: OverlayState = { active: false, channel: null, guild: null, locked: false, selfMuted: false, selfDeafened: false, participants: [] };
const TOAST_MS = 5000;

/** Root of the overlay window: render only what the main window pushes down, send actions back. */
export function OverlayApp() {
  const [state, setState] = useState<OverlayState>(INITIAL);
  const [toasts, setToasts] = useState<OverlayToast[]>([]);
  useEffect(() => {
    markOverlayDocument();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let offState = () => {}; let offToast = () => {};
    void onOverlayState(setState).then((u) => { offState = u; });
    void onOverlayToast((t) => {
      setToasts((list) => [...list.filter((x) => x.id !== t.id), t].slice(-3));
      timers.push(setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), TOAST_MS));
    }).then((u) => { offToast = u; });
    return () => { offState(); offToast(); timers.forEach(clearTimeout); };
  }, []);
  return <OverlayView state={state} toasts={toasts} onAction={sendOverlayAction} />;
}
