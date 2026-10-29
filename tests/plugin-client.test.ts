/// <reference path="../jellyfin-plugin/client/globals.d.ts" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { interceptMenuLinks } from '../jellyfin-plugin/client/jf-dom';

describe('Watchlists page links in Jellyfin', () => {
  afterEach(() => vi.unstubAllGlobals());

  function page(hash: string) {
    let handler: ((ev: unknown) => void) | null = null;
    const dispatched: string[] = [];
    const location = { hash };
    vi.stubGlobal('document', { addEventListener: (_t: string, fn: (ev: unknown) => void) => (handler = fn) });
    vi.stubGlobal('window', { location, dispatchEvent: (ev: { type: string }) => dispatched.push(ev.type) });
    vi.stubGlobal(
      'HashChangeEvent',
      class {
        constructor(public type: string) {}
      },
    );
    interceptMenuLinks();
    const click = (href: string) => {
      const ev = { defaultPrevented: false, button: 0, target: { closest: () => ({ getAttribute: () => href }) }, preventDefault: () => (ev.defaultPrevented = true) };
      handler!(ev);
      return ev.defaultPrevented;
    };
    return { location, dispatched, click };
  }

  it('goes back to all lists from an open list', () => {
    const p = page('#/jellywatcher?list=3');
    expect(p.click('#/jellywatcher')).toBe(true);
    expect(p.location.hash).toBe('/jellywatcher');
    expect(p.dispatched).toEqual([]);
  });

  it('opens the page in the same tab from elsewhere, and refreshes it when already there', () => {
    const away = page('#/home');
    away.click('https://jf.example/web/#/jellywatcher');
    expect(away.location.hash).toBe('/jellywatcher');
    const here = page('#/jellywatcher');
    here.click('#/jellywatcher');
    expect(here.location.hash).toBe('#/jellywatcher');
    expect(here.dispatched).toEqual(['hashchange']);
  });

  it('leaves other links alone', () => {
    const p = page('#/jellywatcher');
    expect(p.click('#/jellywatcher?list=4')).toBe(false);
    expect(p.location.hash).toBe('#/jellywatcher');
  });
});
