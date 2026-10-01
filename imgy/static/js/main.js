/** Entry point: wires up event listeners, then loads settings and the library. */
import { abortLoadData, loadData } from './data.js';
import { initGrid } from './grid.js';
import { initSelection } from './selection.js';
import { initFlyups } from './flyup.js';
import { initFilters } from './filters.js';
import { initLightbox } from './lightbox.js';
import { initLlmSettings, initSettingsModal, loadSettings } from './settings.js';
import { initColorPicker, initGallerySlider, initTheme } from './appearance.js';
import { initTrash } from './trash.js';
import { initUpload } from './upload.js';
import { initShortcuts } from './shortcuts.js';

async function start() {
    initColorPicker();
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
    await loadSettings();
    initLlmSettings();
    await loadData();
}

start();

// Abort in-flight API requests on page unload to prevent server pile-up
window.addEventListener('beforeunload', abortLoadData);
