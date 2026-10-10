// Upload window: shows the image, asks for tags, and sends both to Imgy. This page runs with the
// extension's host permission, so it can fetch an image from any site and post it to Imgy.
const form = document.getElementById('form');
const preview = document.getElementById('preview');
const tagsInput = document.getElementById('tags');
const tagChoices = document.getElementById('tagChoices');
const sendButton = document.getElementById('send');
const settingsButton = document.getElementById('settings');
const status = document.getElementById('status');

const src = new URLSearchParams(location.search).get('src');
const extensionOfType = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
};
let server = '';
let headers = {}; // the password, when Imgy has one (see options.js)
let knownTags = [];

function setStatus(text, isError = false) {
    status.textContent = text;
    status.classList.toggle('error', isError);
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
        const response = await fetch(`${server}/api/tags`, { headers });
        knownTags = response.ok ? await response.json() : [];
    } catch {
        knownTags = [];
    }
}

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
        const response = await fetch(`${server}/api/upload`, { method: 'POST', body, headers });
        const result = await response.json().catch(() => ({}));
        if (response.status === 401) {
            settingsButton.hidden = false;
            throw new Error('Imgy refused the password. Check it in the extension settings.');
        }
        if (!response.ok) {
            const skipped = result.skipped?.[0]?.reason;
            throw new Error(result.error || skipped || `Imgy answered ${response.status}`);
        }
        setStatus(`Uploaded as ${result.uploaded[0].filename}`);
        setTimeout(window.close, 1200);
    } catch (error) {
        setStatus(error.message, true);
        sendButton.disabled = false;
    }
});

settingsButton.addEventListener('click', () => browser.runtime.openOptionsPage());

(async () => {
    preview.src = src;
    const { password } = await browser.storage.local.get('password');
    if (password) headers = { 'X-Imgy-Password': encodeURIComponent(password) };
    ({ server = '' } = await browser.storage.local.get('server'));
    if (server) {
        loadKnownTags();
        return;
    }
    sendButton.disabled = true;
    settingsButton.hidden = false;
    setStatus('Set your Imgy address in the extension settings first.', true);
})();
