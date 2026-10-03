// Where the extension sends images. Saved once; every upload uses it.
const form = document.getElementById('form');
const serverInput = document.getElementById('server');
const status = document.getElementById('status');
const themeButton = document.getElementById('theme');

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

function showTheme() {
    const theme = document.documentElement.dataset.theme || 'dark';
    themeButton.textContent = theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
}

themeButton.addEventListener('click', async () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    await browser.storage.local.set({ theme });
    showTheme();
});

browser.storage.local.get('theme').then(({ theme }) => {
    document.documentElement.dataset.theme = theme || 'dark';
    showTheme();
});
