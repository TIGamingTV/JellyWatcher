import { render } from 'preact';
import css from './styles.css';
import { App } from './App';
import { hostPage, interceptMenuLinks, onOurRoute, overlayHost, removeOverlayHost } from './jf-dom';

/**
 * Entry point, loaded on every jellyfin-web page by the plugin. It only does something while the
 * Watchlists route (#/jellywatcher) is open.
 */

const ROOT_ID = 'jw-root';
let root: HTMLElement | null = null;
let fallbackTimer = 0;

function mount(host: HTMLElement) {
  if (root && root.parentElement === host) return;
  unmount();
  root = document.createElement('div');
  root.id = ROOT_ID;
  host.classList.add('jw-host');
  host.appendChild(root);
  render(<App />, root);
}

function unmount() {
  if (!root) return;
  render(null, root);
  root.parentElement?.classList.remove('jw-host');
  root.remove();
  root = null;
  removeOverlayHost();
}

function sync() {
  if (!onOurRoute()) {
    window.clearTimeout(fallbackTimer);
    fallbackTimer = 0;
    unmount();
    return;
  }
  const host = hostPage();
  if (host) {
    window.clearTimeout(fallbackTimer);
    fallbackTimer = 0;
    if (root?.parentElement?.id === 'jw-overlay') removeOverlayHost();
    mount(host);
    return;
  }
  if (!root && !fallbackTimer) {
    // Jellyfin's page did not appear (a layout without it): show the page on a layer instead.
    fallbackTimer = window.setTimeout(() => {
      fallbackTimer = 0;
      if (onOurRoute() && !hostPage()) mount(overlayHost());
    }, 1200);
  }
}

function start() {
  if (window.__jellyWatcherLoaded) return;
  window.__jellyWatcherLoaded = true;
  const style = document.createElement('style');
  style.id = 'jw-style';
  style.textContent = css;
  document.head.appendChild(style);
  interceptMenuLinks();
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // Jellyfin re-renders pages; put the Watchlists page back when its host appears or changes.
      if (onOurRoute() ? !root || !root.isConnected || (hostPage() !== null && root.parentElement !== hostPage()) : root !== null) sync();
    });
  }).observe(document.body, { childList: true, subtree: true });
  sync();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
