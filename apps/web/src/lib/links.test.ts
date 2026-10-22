import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardFile, guardLink, hasDeceptiveExtension, isRiskyFile, isTrustedHost, linkHost, needsLinkConfirm, trustDomain, untrustDomain } from './links';
import { useUI, defaultPrefs } from '@/stores/ui';
import { setServerUrl } from './server';

beforeEach(() => { useUI.setState({ prefs: { ...defaultPrefs, trustedLinkDomains: [] }, modal: null }); setServerUrl(null); });

describe('external link confirmation', () => {
  it('asks for other sites but not for this app, its server, or relative links', () => {
    setServerUrl('https://chat.example.org');
    expect(needsLinkConfirm('https://evil.test/x')).toBe(true);
    expect(needsLinkConfirm('https://chat.example.org/invite/abc')).toBe(false);
    expect(needsLinkConfirm(`${location.origin}/channels/1`)).toBe(false);
    expect(needsLinkConfirm('/channels/1')).toBe(false);
    expect(needsLinkConfirm('javascript:alert(1)')).toBe(false); // not http(s): the markdown parser never produces it
  });
  it('trusting a domain covers its subdomains and ignores www and case', () => {
    expect(trustDomain('https://WWW.Example.com/some/path')).toBe('example.com');
    expect(useUI.getState().prefs.trustedLinkDomains).toEqual(['example.com']);
    expect(needsLinkConfirm('https://docs.example.com/a')).toBe(false);
    expect(needsLinkConfirm('https://notexample.com/a')).toBe(true); // suffix match must respect the dot
    expect(isTrustedHost('evilexample.com', ['example.com'])).toBe(false);
    untrustDomain('example.com'); expect(needsLinkConfirm('https://example.com')).toBe(true);
  });
  it('rejects things that are not domains', () => { expect(trustDomain('localhost')).toBeNull(); expect(trustDomain('not a domain')).toBeNull(); expect(linkHost('ftp://x.test')).toBeNull(); });
  it('guardLink cancels the navigation and opens the dialog', () => {
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    guardLink(e, 'https://evil.test/'); expect(e.preventDefault).toHaveBeenCalled(); expect(useUI.getState().modal).toEqual({ kind: 'externalLink', url: 'https://evil.test/' });
    useUI.setState({ modal: null }); trustDomain('evil.test'); const e2 = { preventDefault: vi.fn() };
    guardLink(e2, 'https://evil.test/'); expect(e2.preventDefault).not.toHaveBeenCalled(); expect(useUI.getState().modal).toBeNull();
  });
});

describe('risky attachments', () => {
  it('flags executables, scripts and macro documents by the last extension', () => {
    for (const n of ['setup.EXE', 'run.sh', 'a.ps1', 'x.docm', 'page.html', 'photo.jpg.scr', 'app.apk']) expect(isRiskyFile(n)).toBe(true);
    for (const n of ['photo.png', 'notes.txt', 'archive.zip', 'doc.pdf', 'noext']) expect(isRiskyFile(n)).toBe(false);
  });
  it('detects a document name hiding a program', () => { expect(hasDeceptiveExtension('invoice.pdf.exe')).toBe(true); expect(hasDeceptiveExtension('setup.exe')).toBe(false); expect(hasDeceptiveExtension('a.pdf')).toBe(false); });
  it('guardFile only intercepts risky types', () => {
    const safe = { preventDefault: vi.fn() }; guardFile(safe, '/f', 'a.png', true); expect(safe.preventDefault).not.toHaveBeenCalled();
    const bad = { preventDefault: vi.fn() }; guardFile(bad, '/f', 'a.exe', true); expect(bad.preventDefault).toHaveBeenCalled();
    expect(useUI.getState().modal).toEqual({ kind: 'riskyFile', url: '/f', filename: 'a.exe', download: true });
  });
});
