import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { QrCode } from './QrCode';

describe('QrCode', () => {
  it('renders an SVG with dark modules and changes with the text', () => {
    const a = render(<QrCode text="jorcord://qr-login?i=1&c=aaaaaaaaaaaaaaaaaaaaaaaa" />).container.querySelector('path')!.getAttribute('d')!;
    const b = render(<QrCode text="jorcord://qr-login?i=2&c=bbbbbbbbbbbbbbbbbbbbbbbb" />).container.querySelector('path')!.getAttribute('d')!;
    expect(a.length).toBeGreaterThan(200); expect(a).not.toBe(b);
  });
});
