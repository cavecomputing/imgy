// The right-click item on images. The upload window does the rest.
browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({ id: 'imgy', title: 'Set tags and upload to Imgy', contexts: ['image'] });
});

browser.contextMenus.onClicked.addListener((info) => {
    browser.windows.create({
        url: `${browser.runtime.getURL('upload.html')}?src=${encodeURIComponent(info.srcUrl)}`,
        type: 'popup',
        width: 420,
        height: 440,
    });
});
