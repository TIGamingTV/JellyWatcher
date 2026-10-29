/**
 * Everything that depends on jellyfin-web's page structure lives here, so a jellyfin-web update
 * only ever needs changes in this file.
 */

/** Hash route of the Watchlists page (the menu link from config.json points here). */
export const ROUTE = '/jellywatcher';

export function onOurRoute(): boolean {
  const h = window.location.hash;
  return h === `#${ROUTE}` || h.startsWith(`#${ROUTE}?`) || h.startsWith(`#${ROUTE}/`);
}

/** Query parameters of the page (e.g. ?list=3). */
export function routeParams(): URLSearchParams {
  const h = window.location.hash;
  const q = h.indexOf('?');
  return new URLSearchParams(q >= 0 ? h.slice(q + 1) : '');
}

/** Moves inside the page; adds a browser history entry so Back works. */
export function navigate(params: Record<string, string | number | null>): void {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  window.location.hash = `${ROUTE}${s ? `?${s}` : ''}`;
}

/** Opens an item's page in Jellyfin. */
export function openJellyfinItem(itemId: string): void {
  const serverId = window.ApiClient?.serverId();
  window.location.hash = `/details?id=${encodeURIComponent(itemId)}${serverId ? `&serverId=${encodeURIComponent(serverId)}` : ''}`;
}

/**
 * Jellyfin draws custom menu links with target="_blank". Links to our page open in the same tab
 * instead (the click still reaches Jellyfin, which closes its menu). From inside the page (a list
 * is open) the link leads back to all lists, so the address must change, not just be re-announced.
 */
export function interceptMenuLinks(): void {
  document.addEventListener(
    'click',
    (ev) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = (ev.target as Element | null)?.closest?.('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (href !== `#${ROUTE}` && !href.endsWith(`/web/#${ROUTE}`)) return;
      ev.preventDefault();
      if (window.location.hash !== `#${ROUTE}`) window.location.hash = ROUTE;
      else window.dispatchEvent(new HashChangeEvent('hashchange'));
    },
    true,
  );
}

/**
 * Jellyfin shows its "page not found" page for routes it does not know. The Watchlists page is
 * mounted inside it, so Jellyfin's header, menu and spacing stay as they are.
 */
export function hostPage(): HTMLElement | null {
  const pages = [...document.querySelectorAll<HTMLElement>('#fallbackPage')];
  return pages.find((p) => !p.classList.contains('hide')) ?? pages[0] ?? null;
}

/** Fallback when the not-found page is missing: a layer below Jellyfin's header. */
export function overlayHost(): HTMLElement {
  let el = document.getElementById('jw-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'jw-overlay';
    document.body.appendChild(el);
  }
  const header = document.querySelector<HTMLElement>('.skinHeader, header.MuiAppBar-root, .MuiAppBar-root');
  el.style.top = `${Math.max(0, Math.round(header?.getBoundingClientRect().bottom ?? 0))}px`;
  return el;
}

export function removeOverlayHost(): void {
  document.getElementById('jw-overlay')?.remove();
}

/** Sets the browser tab title and, in the classic layout, the header title. */
export function setTitle(title: string): void {
  document.title = title;
  const header = document.querySelector('.skinHeader .pageTitle');
  if (header && header.textContent !== title) header.textContent = title;
}
