import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

const STILL = 'data:image/png;base64,STILL';
let n = 0;
const gifUrl = () => `https://cdn.example/anim-${++n}.gif`;
const user = (avatar: string | null) => ({ id: `u${n}`, username: 'u', displayName: 'U', avatar });

let origImage: unknown, origGetContext: unknown, origToDataURL: unknown;
beforeEach(() => {
  origImage = (globalThis as any).Image;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  // jsdom cannot decode images: a fake Image fires onload so `useStill` can capture the first frame.
  (globalThis as any).Image = class { onload: (() => void) | null = null; onerror: (() => void) | null = null; crossOrigin = ''; naturalWidth = 2; naturalHeight = 2; set src(_v: string) { queueMicrotask(() => this.onload?.()); } };
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => {} })) as never;
  HTMLCanvasElement.prototype.toDataURL = (() => STILL) as never;
});
afterEach(() => {
  (globalThis as any).Image = origImage;
  HTMLCanvasElement.prototype.getContext = origGetContext as never;
  HTMLCanvasElement.prototype.toDataURL = origToDataURL as never;
  cleanup();
});

describe('Avatar animated handling', () => {
  it('renders a static first frame, swaps to the GIF on hover and back on leave', async () => {
    const url = gifUrl();
    const { container } = render(<Avatar user={user(url)} />);
    const root = container.firstChild as Element;
    const img = () => container.querySelector('img') as HTMLImageElement;
    expect(container.querySelector('[data-animated]')).toBeTruthy();
    await waitFor(() => expect(img().getAttribute('src')).toBe(STILL)); // first frame until hover
    fireEvent.mouseEnter(root);
    await waitFor(() => expect(img().getAttribute('src')).toBe(url)); // animates on hover
    fireEvent.mouseLeave(root);
    await waitFor(() => expect(img().getAttribute('src')).toBe(STILL)); // back to the still frame
  });

  it('leaves a static avatar on its own image and does not mark it animated', async () => {
    const url = `https://cdn.example/static-${++n}.png`;
    const { container } = render(<Avatar user={user(url)} />);
    expect(container.querySelector('[data-animated]')).toBeNull();
    await waitFor(() => expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe(url));
  });
});
