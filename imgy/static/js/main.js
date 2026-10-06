/** Entry point: wires up event listeners, then loads settings and the library. */
import { abortLoadData, loadData } from './data.js';
import { initGrid } from './grid.js';
import { initReorder } from './reorder.js';
import { initSelection } from './selection.js';
import { initFlyups } from './flyup.js';
import { initFilters } from './filters.js';
import { initLightbox } from './lightbox.js';
import { initLlmSettings, initSettingsModal, loadSettings } from './settings.js';
import { initGallerySlider, initTheme } from './appearance.js';
import { initTrash } from './trash.js';
import { initUpload } from './upload.js';
import { initShortcuts } from './shortcuts.js';

async function start() {
    initGallerySlider();
    initTrash();
    initTheme();
    initSelection();
    initLightbox();
    initShortcuts();
    initFilters();
    initUpload();
    initFlyups();
    initSettingsModal();
    initGrid();
    initReorder();
    // The library downloads while the settings do; it waits for them before it is drawn
    const settingsLoaded = loadSettings();
    const dataLoaded = loadData(settingsLoaded);
    await settingsLoaded;
    initLlmSettings();
    await dataLoaded;
    // Files also arrive from outside (the browser extension, the share sheet, a copied folder),
    // so look again whenever the page comes back in front.
    const refresh = () => loadData(null, { onlyIfChanged: true });
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

start();

// Only exists on HTTPS and localhost; elsewhere the app just isn't installable
navigator.serviceWorker?.register('/sw.js');

// Abort in-flight API requests on page unload to prevent server pile-up
window.addEventListener('beforeunload', abortLoadData);
