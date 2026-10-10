import type React from "react";
export const comboFromEvent = (e: KeyboardEvent | React.KeyboardEvent) => { const k = e.key; if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return ''; return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', k.length === 1 ? k.toUpperCase() : k].filter(Boolean).join('+'); };
