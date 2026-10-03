// Imgy's service worker. Browsers want one before they offer to install the app. It caches nothing:
// the library lives on the server, and cached scripts would outlive an update.
self.addEventListener('fetch', () => {});
