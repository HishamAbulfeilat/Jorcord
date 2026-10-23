import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportReport } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { serverPort: { exportFile: vi.fn(), importFile: vi.fn() } } }));
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { ServerPortTab } from './ServerPortTab';

const exportFile = vi.mocked(api.serverPort.exportFile), importFile = vi.mocked(api.serverPort.importFile);
const report = (o: Partial<ImportReport> = {}): ImportReport => ({ dryRun: true, source: 'discord-template', created: { roles: 3, categories: 2, channels: 7, emoji: 0 }, warnings: ['Channel "x" has an unsupported type: skipped'], ...o });
const pick = (f: File) => fireEvent.change(screen.getByLabelText('Server file to import'), { target: { files: [f] } });

beforeEach(() => {
  exportFile.mockReset(); importFile.mockReset(); useUI.setState({ toasts: [] });
  useData.setState({ guilds: { g1: { guild: { id: 'g1', name: 'My Server!' } } as never } });
  (URL as any).createObjectURL = vi.fn(() => 'blob:x'); (URL as any).revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe('Server Settings > Import & Export', () => {
  it('downloads the JSON and ZIP backups under a safe file name', async () => {
    exportFile.mockResolvedValue(new Blob(['{}']));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ServerPortTab guildId="g1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }));
    await waitFor(() => expect(exportFile).toHaveBeenCalledWith('g1', 'json'));
    fireEvent.click(screen.getByRole('button', { name: 'Download ZIP with emoji' }));
    await waitFor(() => expect(exportFile).toHaveBeenCalledWith('g1', 'zip'));
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it('checks a file first (dry run), shows what would be created and the notes, and only then imports', async () => {
    importFile.mockResolvedValueOnce(report()).mockResolvedValueOnce(report({ dryRun: false }));
    render(<ServerPortTab guildId="g1" />);
    expect(screen.queryByRole('button', { name: 'Import into this server' })).toBeNull();
    pick(new File(['{}'], 'tpl.json', { type: 'application/json' }));
    const r = await screen.findByTestId('import-report');
    expect(importFile).toHaveBeenLastCalledWith('g1', expect.any(File), { dryRun: true, applyEveryone: false });
    expect(r.textContent).toContain('3 roles'); expect(r.textContent).toContain('7 channels'); expect(r.textContent).toContain('unsupported type');
    fireEvent.click(screen.getByRole('button', { name: 'Import into this server' }));
    await waitFor(() => expect(importFile).toHaveBeenLastCalledWith('g1', expect.any(File), { applyEveryone: false }));
    await waitFor(() => expect(screen.getByTestId('import-report').textContent).toContain('Imported.'));
    expect(useUI.getState().toasts.some((x) => x.kind === 'success')).toBe(true);
  });

  it('keeps @everyone untouched unless asked, and shows the server\'s refusal', async () => {
    importFile.mockRejectedValue(new Error('The server would exceed 250 roles'));
    render(<ServerPortTab guildId="g1" />);
    pick(new File(['{}'], 'big.json'));
    await waitFor(() => expect(useUI.getState().toasts.some((x) => x.text === 'The server would exceed 250 roles')).toBe(true));
    expect(screen.queryByTestId('import-report')).toBeNull();
    expect(screen.getByLabelText('Also replace the @everyone permissions').getAttribute('aria-checked')).toBe('false');
  });
});
