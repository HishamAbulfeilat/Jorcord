import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UserFlags } from '@jorcord/shared';
import { UserBadges } from './UserBadges';

afterEach(cleanup);

describe('UserBadges', () => {
  it('renders nothing without flags', () => {
    const { container } = render(<UserBadges flags={0} />);
    expect(container.innerHTML).toBe('');
    expect(render(<UserBadges flags={undefined} />).container.innerHTML).toBe('');
  });
  it('renders one labelled badge per flag, in catalogue order', () => {
    render(<UserBadges flags={UserFlags.EARLY_SUPPORTER | UserFlags.STAFF} />);
    const items = screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'));
    expect(items).toEqual(['Staff', 'Early Supporter']);
  });
});
