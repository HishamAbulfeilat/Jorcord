import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUI } from '@/stores/ui';

vi.mock('@/lib/api', () => ({ api: { messages: { report: vi.fn() } } }));
import { api } from '@/lib/api';
import { ReportModal } from './SocialModals';

const report = vi.mocked(api.messages.report);

afterEach(cleanup);

beforeEach(() => {
  useUI.setState({ toasts: [] });
  report.mockReset();
});

describe('ReportModal', () => {
  it('renders the reason radio list and the details field', () => {
    render(<ReportModal messageId="m1" guildId="g1" channelId="ch1" close={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Report Message' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect((radios[0] as HTMLInputElement).checked).toBe(true); // spam is pre-selected
    expect(screen.getByLabelText('harassment')).toBeTruthy();
    expect(screen.getByLabelText('Additional details (optional)')).toBeTruthy();
    expect(screen.getByText('Your report will be reviewed by the server moderators.')).toBeTruthy();
  });

  it('submits the picked reason and details, toasts success and closes', async () => {
    report.mockResolvedValue({ id: 'r1' } as never);
    const close = vi.fn();
    render(<ReportModal messageId="m1" guildId="g1" channelId="ch1" close={close} />);
    fireEvent.click(screen.getByLabelText('harassment'));
    fireEvent.change(screen.getByLabelText('Additional details (optional)'), { target: { value: 'please look' } });
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(report).toHaveBeenCalledWith('ch1', 'm1', { reason: 'harassment', description: 'please look' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(useUI.getState().toasts.some((tx) => tx.text === 'Message reported' && tx.kind === 'success')).toBe(true);
  });

  it('submits without details as undefined, keeps the modal open on server error', async () => {
    report.mockRejectedValue(new Error('boom'));
    const close = vi.fn();
    render(<ReportModal messageId="m1" guildId="g1" channelId="ch1" close={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(report).toHaveBeenCalledWith('ch1', 'm1', { reason: 'spam', description: undefined }));
    await waitFor(() => expect(useUI.getState().toasts.some((tx) => tx.text === 'boom' && tx.kind === 'error')).toBe(true));
    expect(close).not.toHaveBeenCalled();
  });

  it('anonymous: off by default, sends nothing extra, and sends anonymous: true when ticked', async () => {
    report.mockResolvedValue({ id: 'r1' } as never);
    render(<ReportModal messageId="m1" guildId="g1" channelId="ch1" close={vi.fn()} />);
    const box = screen.getByLabelText(/Hide my name from the moderators too/) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    await waitFor(() => expect(report).toHaveBeenCalledWith('ch1', 'm1', { reason: 'spam', description: undefined, anonymous: true }));
  });
});
