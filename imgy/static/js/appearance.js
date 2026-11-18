/** Theme (dark or light) and gallery thumbnail size. */
import { Elements } from './dom.js';
import { resizeAllMasonryItems } from './grid.js';
import { saveSetting } from './settings.js';

const GALLERY_DEFAULT_SIZE = window.innerWidth <= 768 ? 150 : 232;
const GALLERY_MIN_SIZE = 150;
const GALLERY_MAX_SIZE = 400;
const THEME_COLORS = { dark: '#282828', light: '#f9f5ea' };

export function applyTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    document.documentElement.setAttribute('data-theme', theme);
    // The head script reads this before the first paint, so a reload doesn't flash the other theme
    try { localStorage.setItem('theme', theme); } catch { /* storage blocked */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
    document.querySelectorAll('input[name="themeChoice"]').forEach(radio => { radio.checked = radio.value === theme; });
}

function setTheme(theme) {
    applyTheme(theme);
    saveSetting('theme', theme);
}

function setGalleryColWidth(v) {
    const value = Math.min(GALLERY_MAX_SIZE, Math.max(GALLERY_MIN_SIZE, parseInt(v, 10) || GALLERY_DEFAULT_SIZE));
    document.documentElement.style.setProperty('--gallery-col-width', value + 'px');
    Elements.gallerySizeSetting.value = value;
    Elements.gallerySizeValue.textContent = `${value}px`;
    try { localStorage.setItem('galleryColWidth', value); } catch { /* storage blocked */ }
    resizeAllMasonryItems();
}

export function initGallerySlider() {
    let saved = null;
    try { saved = localStorage.getItem('galleryColWidth'); } catch { /* storage blocked */ }
    setGalleryColWidth(saved || GALLERY_DEFAULT_SIZE);
    Elements.gallerySizeSetting.addEventListener('input', (e) => setGalleryColWidth(e.target.value));
    Elements.gallerySizeReset.addEventListener('click', () => setGalleryColWidth(GALLERY_DEFAULT_SIZE));
}

export function initTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    document.querySelectorAll('input[name="themeChoice"]').forEach(radio => {
        radio.addEventListener('change', () => { if (radio.checked) setTheme(radio.value); });
    });
}
