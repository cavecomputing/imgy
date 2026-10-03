// Applies the saved theme before the page paints much: dark unless the user chose light.
browser.storage.local.get('theme').then(({ theme }) => { document.documentElement.dataset.theme = theme || 'dark'; });
