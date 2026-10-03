// Imgy's service worker. Browsers want one before they offer to install the app. It caches nothing:
// the library lives on the server, and cached scripts would outlive an update. Its one job is
// receiving files from the phone's share sheet (the manifest's share_target).
self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method === 'POST' && new URL(request.url).pathname === '/share') {
        event.respondWith(uploadShared(request));
    }
});

// The shared files are posted to the page address, which has no route of its own, so the worker
// forwards them to the upload API and sends the browser on to the gallery with the count.
async function uploadShared(request) {
    const response = await fetch('/api/upload', { method: 'POST', body: await request.formData() })
        .catch(() => null);
    const count = response?.ok ? (await response.json()).count : 0;
    return Response.redirect(new URL(`/?shared=${count}`, self.location.origin), 303);
}
