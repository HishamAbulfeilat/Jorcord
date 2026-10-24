import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Report } from '@jorcord/shared';
import { ReportRow } from './ReportRow';

afterEach(cleanup);
const target = { id: 'u2', username: 'bob', discriminator: '0', avatar: null } as never;
const rep = (o: Partial<Report> = {}): Report => ({ id: 'r1', guildId: 'g', channelId: 'c', messageId: 'm', reporterId: 'u1', targetUserId: 'u2', reason: 'spam', status: 'open', createdAt: new Date().toISOString(),
  message: { content: 'look', attachments: [{ id: 'a', url: '/f/x.png', filename: 'x.png' } as never] }, reportCount: 1, anonymous: false, blurMedia: true, ...o });
const mount = (r: Report, props: Partial<Parameters<typeof ReportRow>[0]> = {}) => render(<ul><ReportRow r={r} target={target} reporterName="alice" channelName="general" canAct onResolve={vi.fn()} onDismiss={vi.fn()} {...props} /></ul>);

describe('ReportRow', () => {
  it('blurs media until clicked when blur is on, and not when it is off', () => {
    mount(rep());
    expect(screen.getByTestId('report-media').className).toContain('blur-md');
    fireEvent.click(screen.getByTestId('reveal-media'));
    expect(screen.getByTestId('report-media').className).not.toContain('blur-md');
    expect(screen.queryByTestId('reveal-media')).toBeNull();
    cleanup(); mount(rep({ blurMedia: false }));
    expect(screen.queryByTestId('reveal-media')).toBeNull();
  });
  it('shows the duplicate count and hides an anonymous reporter', () => {
    mount(rep({ reportCount: 3, anonymous: true, reporterId: null }), { reporterName: null });
    expect(screen.getByTestId('report-count').textContent).toBe('3 reports');
    expect(screen.getByTestId('anon-reporter')).toBeTruthy();
    expect(screen.queryByText('alice')).toBeNull();
  });
  it('resolves with the chosen canned action and dismisses without one', () => {
    const onResolve = vi.fn(), onDismiss = vi.fn();
    mount(rep(), { onResolve, onDismiss });
    fireEvent.change(screen.getByLabelText('Action when resolving'), { target: { value: 'mark_sensitive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResolve).toHaveBeenCalledWith('mark_sensitive');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
  it('a handled report shows the action taken and no buttons', () => {
    mount(rep({ status: 'resolved', actionTaken: 'warn', handledBy: 'u9' }), { handlerName: 'mod' });
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(screen.getByText(/Warn member/).textContent).toContain('mod');
  });
});
