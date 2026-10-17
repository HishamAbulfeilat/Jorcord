import { describe, expect, it } from 'vitest';
import { favoriteCandidate } from './gifFavorites';

const att = (o: object) => ({ id: '1', filename: 'cat.gif', contentType: 'image/gif', size: 1, url: `/api/v1/files/${'a'.repeat(48)}/cat.gif`, width: 10, height: 20, spoiler: false, ...o });
describe('favoriteCandidate', () => {
  it('prefers an uploaded image', () => { expect(favoriteCandidate({ attachments: [att({})], embeds: [] })).toMatchObject({ url: `/api/v1/files/${'a'.repeat(48)}/cat.gif`, title: 'cat', width: 10 }); });
  it('falls back to an https embed image and ignores unsafe or non-image things', () => {
    expect(favoriteCandidate({ attachments: [att({ contentType: 'application/zip' })], embeds: [{ type: 'image', image: 'https://x.example/a.gif', thumbnail: 'https://x.example/t.gif' }] })).toMatchObject({ url: 'https://x.example/a.gif', preview: 'https://x.example/t.gif' });
    expect(favoriteCandidate({ attachments: [], embeds: [{ type: 'image', image: 'http://insecure/a.gif' }] })).toBeNull();
    expect(favoriteCandidate({ attachments: [], embeds: [] })).toBeNull();
  });
});
