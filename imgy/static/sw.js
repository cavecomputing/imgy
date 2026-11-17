// Imgy's service worker. Browsers want one before they offer to install the app. It caches nothing:
// the library lives on the server, and cached scripts would outlive an update. Its one job is
// receiving files and links from the phone's share sheet (the manifest's share_target).
self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method === 'POST' && new URL(request.url).pathname === '/share') {
        event.respondWith(uploadShared(request));
    }
});

// The shared files are posted to the page address, which has no route of its own, so the worker
// forwards them to the upload API and sends the browser on to the gallery with the count. A shared
// link (apps put it in text or url) goes to the download API instead, and the gallery shows its progress.
async function uploadShared(request) {
    const form = await request.formData();
    const link = `${form.get('url') || ''} ${form.get('text') || ''}`.match(/https?:\/\/\S+/)?.[0];
    if (link && !form.getAll('images').length) {
        const response = await fetch('/api/downloads', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link })
        }).catch(() => null);
        return Response.redirect(new URL(`/?shared=${response?.ok ? 'link' : 0}`, self.location.origin), 303);
    }
    const response = await fetch('/api/upload', { method: 'POST', body: form })
        .catch(() => null);
    const count = response?.ok ? (await response.json()).count : 0;
    return Response.redirect(new URL(`/?shared=${count}`, self.location.origin), 303);
}
