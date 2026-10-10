// Where the extension sends images, and the password if Imgy has one. Saved once; every upload uses them.
const form = document.getElementById('form');
const serverInput = document.getElementById('server');
const passwordInput = document.getElementById('password');
const status = document.getElementById('status');
const themeButton = document.getElementById('theme');

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const server = serverInput.value.trim().replace(/\/+$/, '');
    const password = passwordInput.value;
    await browser.storage.local.set({ server, password });
    serverInput.value = server;
    status.classList.remove('error');
    status.textContent = 'Saved.';
    // Imgy reads the password percent-encoded, since a header can't carry every character.
    const headers = password ? { 'X-Imgy-Password': encodeURIComponent(password) } : {};
    const answer = await fetch(`${server}/api/tags`, { headers }).then(response => response.status, () => 0);
    if (answer !== 200) {
        status.classList.add('error');
        status.textContent = answer === 401 ? 'Saved, but Imgy refused the password.'
            : answer === 429 ? 'Saved, but Imgy is holding off sign-ins after a wrong password. Save again in a moment.'
            : 'Saved, but Imgy did not answer at that address.';
    }
});

browser.storage.local.get(['server', 'password']).then(({ server, password }) => {
    serverInput.value = server || '';
    passwordInput.value = password || '';
});

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
