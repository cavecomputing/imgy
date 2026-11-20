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

let galleryColWidth = GALLERY_DEFAULT_SIZE;

/** The gallery's width plus one gap, and the gap: n columns of width w fit when n * (w + gap) <= span. */
function gallerySpan() {
    const gap = parseFloat(window.getComputedStyle(Elements.imageGrid).columnGap) || 0;
    return [Elements.imageGrid.getBoundingClientRect().width + gap, gap];
}

/** How many columns the gallery shows when they are at least `width` wide. */
function columnsAt(width) {
    const [span, gap] = gallerySpan();
    return Math.max(1, Math.floor(span / (width + gap)));
}

/**
 * The columns stretch to fill the row, so two widths that give the same count look the same:
 * the slider picks a count instead, one column a step, more to the right.
 */
function syncGallerySlider() {
    const slider = Elements.gallerySizeSetting;
    const columns = columnsAt(galleryColWidth);
    const text = columns === 1 ? '1 column' : `${columns} columns`;
    slider.min = columnsAt(GALLERY_MAX_SIZE);
    slider.max = columnsAt(GALLERY_MIN_SIZE);
    slider.value = columns;
    slider.disabled = slider.min === slider.max;
    slider.setAttribute('aria-valuetext', text);
    Elements.gallerySizeValue.textContent = text;
}

function setGalleryColWidth(v) {
    galleryColWidth = Math.min(GALLERY_MAX_SIZE, Math.max(GALLERY_MIN_SIZE, parseInt(v, 10) || GALLERY_DEFAULT_SIZE));
    document.documentElement.style.setProperty('--gallery-col-width', galleryColWidth + 'px');
    try { localStorage.setItem('galleryColWidth', galleryColWidth); } catch { /* storage blocked */ }
    resizeAllMasonryItems();
    syncGallerySlider();
}

/**
 * Store the width halfway between the narrowest and widest that give this many columns, so a
 * small change to the window keeps the count. The clamp to the size limits stays within that range.
 */
function setGalleryColumns(columns) {
    const [span, gap] = gallerySpan();
    setGalleryColWidth((span / columns + span / (columns + 1)) / 2 - gap);
}

export function initGallerySlider() {
    let saved = null;
    try { saved = localStorage.getItem('galleryColWidth'); } catch { /* storage blocked */ }
    setGalleryColWidth(saved || GALLERY_DEFAULT_SIZE);
    Elements.gallerySizeSetting.addEventListener('input', (e) => setGalleryColumns(Number(e.target.value)));
    Elements.gallerySizeReset.addEventListener('click', () => setGalleryColWidth(GALLERY_DEFAULT_SIZE));
    new ResizeObserver(syncGallerySlider).observe(Elements.imageGrid);
}

export function initTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');
    document.querySelectorAll('input[name="themeChoice"]').forEach(radio => {
        radio.addEventListener('change', () => { if (radio.checked) setTheme(radio.value); });
    });
}
