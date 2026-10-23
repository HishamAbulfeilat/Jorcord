import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountAge, LinkWarningBanner } from './TrustBits';

afterEach(cleanup);
const NOW = Date.parse('2026-02-01T00:00:00Z');

describe('AccountAge', () => {
  it('flags accounts younger than a week as new', () => {
    render(<AccountAge createdAt="2026-01-31T12:00:00Z" now={NOW} />);
    expect(screen.getByText('New account')).toBeTruthy();
    expect(screen.getByTestId('account-age').textContent).toContain('Created 12h ago');
  });
  it('shows only the age for established accounts', () => {
    render(<AccountAge createdAt="2024-01-01T00:00:00Z" now={NOW} />);
    expect(screen.queryByText('New account')).toBeNull();
    expect(screen.getByTestId('account-age').textContent).toContain('years ago');
  });
});

describe('LinkWarningBanner', () => {
  it('renders nothing without warnings', () => {
    const { container } = render(<LinkWarningBanner warnings={[]} />);
    expect(container.firstChild).toBeNull();
  });
  it('explains dangerous links with the host and the reasons', () => {
    render(<LinkWarningBanner warnings={[{ host: 'dlscord.com', level: 'dangerous', score: 90, reasons: ['lookalike_brand', 'free_nitro'] }]} />);
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('Likely scam link.');
    expect(note.textContent).toContain('dlscord.com');
    expect(note.textContent).toContain('Imitates a well-known site');
  });
  it('uses softer wording for suspicious links', () => {
    render(<LinkWarningBanner warnings={[{ host: 'x.example', level: 'suspicious', score: 55, reasons: ['shortener'] }]} />);
    expect(screen.getByRole('note').textContent).toContain('This link looks suspicious.');
  });
});
