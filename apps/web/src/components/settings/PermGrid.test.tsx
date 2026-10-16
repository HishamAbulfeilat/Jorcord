import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Perm } from '@jorcord/shared';
import { PermGrid } from './PermGrid';
import { PERMISSION_META, hasPermBit, togglePerm } from '@/lib/perms';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const meta = PERMISSION_META.find((p) => p.name === 'SEND_VOICE_MESSAGES');

function ControlledGrid({ initial }: { initial: string }) {
  const [bits, setBits] = useState(initial);
  return <PermGrid bits={bits} onChange={setBits} />;
}

describe('role permissions editor shows voice messages', () => {
  let host: HTMLDivElement; let root: Root;
  const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); };
  const q = (sel: string) => host.querySelector<HTMLButtonElement>(sel);

  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('is listed as a Text permission row in PERMISSION_META', () => {
    expect(meta).toMatchObject({ group: 'Text' });
  });

  it('renders the Send Voice Messages row with an on toggle when the bit is set', async () => {
    await render(<ControlledGrid initial={togglePerm('0', 'SEND_VOICE_MESSAGES', true)} />);
    expect(host.textContent).toContain(meta!.label);
    const toggle = q('button[role=switch][aria-label="' + meta!.label + '"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
  });

  it('toggling writes the SEND_VOICE_MESSAGES bit into the role permission string', async () => {
    expect(BigInt(togglePerm('0', 'SEND_VOICE_MESSAGES', true))).toBe(Perm.SEND_VOICE_MESSAGES);
    await render(<ControlledGrid initial="0" />);
    const toggle = q('button[role=switch][aria-label="' + meta!.label + '"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle!.click());
    const toggle2 = q('button[role=switch][aria-label="' + meta!.label + '"]');
    expect(toggle2?.getAttribute('aria-checked')).toBe('true');
  });

  it('the meta entry matches the shared permission bit', () => {
    expect(hasPermBit(togglePerm('0', 'SEND_VOICE_MESSAGES', true), 'SEND_VOICE_MESSAGES')).toBe(true);
  });
});
