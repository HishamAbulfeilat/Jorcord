import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { messages: { schedule: vi.fn().mockResolvedValue({ id: 's1' }) } } }));
import { api } from '@/lib/api';
import { ScheduleModal } from './ScheduleModal';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); vi.mocked(api.messages.schedule).mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const mount = async (props: Partial<React.ComponentProps<typeof ScheduleModal>> = {}) => {
  const done = vi.fn(); const close = vi.fn();
  await act(async () => { root.render(<QueryClientProvider client={new QueryClient()}><ScheduleModal channelId="c1" content="hello later" replyTo="r1" onDone={done} close={close} {...props} /></QueryClientProvider>); });
  return { done, close };
};

describe('ScheduleModal', () => {
  it('schedules the composer text at the chosen time and reports back', async () => {
    const { done, close } = await mount();
    expect(q('[data-testid="schedule-preview"]')?.textContent).toBe('hello later');
    await act(async () => { q('[data-testid="schedule-confirm"]')!.click(); });
    expect(api.messages.schedule).toHaveBeenCalledTimes(1);
    const [cid, body] = vi.mocked(api.messages.schedule).mock.calls[0]!;
    expect(cid).toBe('c1'); expect(body.content).toBe('hello later'); expect(body.replyTo).toBe('r1');
    expect(Date.parse(body.sendAt)).toBeGreaterThan(Date.now()); expect(done).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  });
  it('blocks a time in the past', async () => {
    await mount();
    const input = q('[data-testid="schedule-at"]') as HTMLInputElement;
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(input, '2001-01-01T00:00'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect((q('[data-testid="schedule-confirm"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('Pick a time in the future');
    expect(api.messages.schedule).not.toHaveBeenCalled();
  });
});
