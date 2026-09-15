// Register the service worker for offline support (if the browser supports it).
export function registerServiceWorker(): void {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[offline] Service worker registration failed', err);
      });
    });
  }
}
