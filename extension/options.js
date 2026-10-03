// Where the extension sends images. Saved once; every upload uses it.
const form = document.getElementById('form');
const serverInput = document.getElementById('server');
const status = document.getElementById('status');

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const server = serverInput.value.trim().replace(/\/+$/, '');
    await browser.storage.local.set({ server });
    serverInput.value = server;
    status.classList.remove('error');
    status.textContent = 'Saved.';
    const reachable = await fetch(`${server}/api/tags`).then(response => response.ok, () => false);
    if (!reachable) {
        status.classList.add('error');
        status.textContent = 'Saved, but Imgy did not answer at that address.';
    }
});

browser.storage.local.get('server').then(({ server }) => { serverInput.value = server || ''; });
