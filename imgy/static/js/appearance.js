/** Theme (Gruvbox dark or light) and gallery thumbnail size. */
import { Elements } from './dom.js';
import { setPressed } from './ui.js';
import { resizeAllMasonryItems } from './grid.js';
import { saveSetting } from './settings.js';

const GALLERY_DEFAULT_SIZE = window.innerWidth <= 768 ? 140 : 232;
const THEME_COLORS = { dark: '#282828', light: '#fbf1c7' };

export function applyTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    document.documentElement.setAttribute('data-theme', theme);
    // The head script reads this before the first paint, so a reload doesn't flash the other theme
    try { localStorage.setItem('theme', theme); } catch { /* storage blocked */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);

    const next = theme === 'dark' ? 'light' : 'dark';
    Elements.themeToggleBtn.title = `Switch to ${next} theme`;
    Elements.themeToggleBtn.setAttribute('aria-label', Elements.themeToggleBtn.title);
    setPressed(Elements.themeToggleBtn, theme === 'dark');
    Elements.themeIcon.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
    document.querySelectorAll('input[name="themeChoice"]').forEach(radio => { radio.checked = radio.value === theme; });
}

function setTheme(theme) {
    applyTheme(theme);
    saveSetting('theme', theme);
}

function setGalleryColWidth(v) {
    const value = Math.min(400, Math.max(120, parseInt(v, 10) || GALLERY_DEFAULT_SIZE));
    document.documentElement.style.setProperty('--gallery-col-width', value + 'px');
    Elements.gallerySizeSlider.value = value;
    Elements.gallerySizeSetting.value = value;
    Elements.gallerySizeValue.textContent = `${value}px`;
    try { localStorage.setItem('galleryColWidth', value); } catch { /* storage blocked */ }
    resizeAllMasonryItems();
}

export function initGallerySlider() {
    let saved = null;
    try { saved = localStorage.getItem('galleryColWidth'); } catch { /* storage blocked */ }
    setGalleryColWidth(saved || GALLERY_DEFAULT_SIZE);
    Elements.gallerySizeSlider.addEventListener('input', (e) => setGalleryColWidth(e.target.value));
    Elements.gallerySizeSetting.addEventListener('input', (e) => setGalleryColWidth(e.target.value));
    Elements.gallerySizeReset.addEventListener('click', () => setGalleryColWidth(GALLERY_DEFAULT_SIZE));
}

export function initTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    Elements.themeToggleBtn.addEventListener('click', () => {
        setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    document.querySelectorAll('input[name="themeChoice"]').forEach(radio => {
        radio.addEventListener('change', () => { if (radio.checked) setTheme(radio.value); });
    });
}
