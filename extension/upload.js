// Upload window: shows the image, asks for tags, and sends both to Imgy. This page runs with the
// extension's host permission, so it can fetch an image from any site and post it to Imgy.
const form = document.getElementById('form');
const preview = document.getElementById('preview');
const tagsInput = document.getElementById('tags');
const tagChoices = document.getElementById('tagChoices');
const serverBox = document.getElementById('serverBox');
const serverInput = document.getElementById('server');
const sendButton = document.getElementById('send');
const status = document.getElementById('status');

const src = new URLSearchParams(location.search).get('src');
const extensionOfType = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
};
let knownTags = [];

function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('error', isError);
}

function serverUrl() {
    return serverInput.value.trim().replace(/\/+$/, '');
}

/** The file name Imgy gets: the last part of the URL, with an extension from the content type if it has none. */
function fileNameFor(blob) {
    let name = 'image';
    try { name = decodeURIComponent(new URL(src).pathname.split('/').pop()) || name; } catch {}
    const extension = extensionOfType[blob.type];
    return /\.[a-z0-9]{2,4}$/i.test(name) || !extension ? name : name + extension;
}

async function loadKnownTags() {
    try {
        const response = await fetch(`${serverUrl()}/api/tags`);
        knownTags = response.ok ? await response.json() : [];
    } catch {
        knownTags = [];
    }
}

serverInput.addEventListener('change', loadKnownTags);

// Suggest tags for the word being typed, keeping the ones already typed before it.
tagsInput.addEventListener('input', () => {
    const typed = tagsInput.value.split(',');
    const word = typed.pop().trim().toLowerCase();
    const head = typed.map(tag => `${tag.trim()}, `).join('');
    tagChoices.replaceChildren(...knownTags
        .filter(tag => word && tag.startsWith(word))
        .slice(0, 20)
        .map(tag => new Option(head + tag)));
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    sendButton.disabled = true;
    setStatus('Uploading…');
    try {
        const download = await fetch(src, { credentials: 'include' });
        if (!download.ok) throw new Error(`The image could not be fetched (${download.status})`);
        const blob = await download.blob();
        const body = new FormData();
        body.append('images', blob, fileNameFor(blob));
        for (const tag of tagsInput.value.split(',')) {
            if (tag.trim()) body.append('tags', tag.trim());
        }
        const response = await fetch(`${serverUrl()}/api/upload`, { method: 'POST', body });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            const skipped = result.skipped?.[0]?.reason;
            throw new Error(result.error || skipped || `Imgy answered ${response.status}`);
        }
        await browser.storage.local.set({ server: serverUrl() });
        setStatus(`Uploaded as ${result.uploaded[0].filename}`);
        setTimeout(window.close, 1200);
    } catch (error) {
        setStatus(error.message, true);
        sendButton.disabled = false;
    }
});

(async () => {
    preview.src = src;
    const { server } = await browser.storage.local.get('server');
    serverInput.value = server || '';
    serverBox.open = !server;
    if (server) loadKnownTags();
    else serverInput.focus();
})();
