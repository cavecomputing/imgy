/** Theme, accent color, and gallery thumbnail size. */
import { Elements } from './dom.js';
import { esc } from './utils.js';
import { setPressed } from './ui.js';
import { resizeAllMasonryItems } from './grid.js';
import { saveSetting } from './settings.js';

const GALLERY_DEFAULT_SIZE = window.innerWidth <= 768 ? 140 : 200;

const COLOR_PRESETS = [
    { name: 'Indigo', hex: '#6366f1' },
    { name: 'Blue',   hex: '#3b82f6' },
    { name: 'Sky',    hex: '#0ea5e9' },
    { name: 'Teal',   hex: '#14b8a6' },
    { name: 'Green',  hex: '#22c55e' },
    { name: 'Amber',  hex: '#f59e0b' },
    { name: 'Orange', hex: '#f97316' },
    { name: 'Red',    hex: '#ef4444' },
    { name: 'Pink',   hex: '#ec4899' },
    { name: 'Purple', hex: '#a855f7' },
    { name: 'Slate',  hex: '#64748b' },
];

const DEFAULT_COLOR = '#6366f1';

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

function darken([r, g, b], f) {
    return [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
}

function lighten([r, g, b], f) {
    return [Math.round(r + (255 - r) * f), Math.round(g + (255 - g) * f), Math.round(b + (255 - b) * f)];
}

function updateFavicon(hex) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="0" y="0" width="32" height="32" rx="8" fill="${hex}"/>
  <path d="M6 10C6 8.89543 6.89543 8 8 8H13L15 10H24C25.1046 10 26 10.8954 26 12V24C26 25.1046 25.1046 26 24 26H8C6.89543 26 6 25.1046 6 24V10Z" fill="white"/>
</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
    link.type = 'image/svg+xml';
    link.rel = 'icon';
    link.href = url;
    if (!link.parentNode) document.head.appendChild(link);
}

function applyPrimaryColor(hex) {
    updateFavicon(hex);
    const rgb = hexToRgb(hex);
    const hoverRgb = darken(rgb, 0.85);
    const lightRgb = lighten(rgb, 0.88);
    const darkRgb = darken(rgb, 0.7);
    const s = document.documentElement.style;
    s.setProperty('--primary', hex);
    s.setProperty('--primary-hover', rgbToHex(...hoverRgb));
    s.setProperty('--primary-rgb', rgb.join(', '));
    s.setProperty('--primary-light', rgbToHex(...lightRgb));
    s.setProperty('--header-gradient', `linear-gradient(135deg, ${hex} 0%, ${rgbToHex(...hoverRgb)} 50%, ${rgbToHex(...darkRgb)} 100%)`);
    localStorage.setItem('primaryColor', hex);
    // Update swatch active states
    document.querySelectorAll('.color-swatch').forEach(el => {
        el.classList.toggle('active', el.dataset.color === hex);
    });
    const input = document.getElementById('customColorInput');
    if (input) input.value = hex;
}

export function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    setPressed(Elements.themeToggleBtn, theme === 'dark');
    if (Elements.themeToggleBtn) {
        Elements.themeToggleBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
        Elements.themeToggleBtn.setAttribute('aria-label', Elements.themeToggleBtn.title);
    }
    const icon = document.getElementById('themeIcon');
    if (icon) {
        icon.innerHTML = theme === 'dark'
            ? '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>'
            : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    saveSetting('theme', next);
}

export function initColorPicker() {
    const saved = localStorage.getItem('primaryColor') || DEFAULT_COLOR;
    applyPrimaryColor(saved);
    const container = document.getElementById('colorSwatches');
    if (!container) return;
    container.innerHTML = COLOR_PRESETS.map(c =>
        `<div class="color-swatch${c.hex === saved ? ' active' : ''}" data-color="${esc(c.hex)}" style="background:${esc(c.hex)}"></div>`
    ).join('');
    container.addEventListener('click', e => {
        const swatch = e.target.closest('.color-swatch');
        if (swatch) applyPrimaryColor(swatch.dataset.color);
    });
    const input = document.getElementById('customColorInput');
    input.value = saved;
    input.addEventListener('input', () => {
        const v = input.value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(v)) applyPrimaryColor(v);
    });
    document.getElementById('colorReset').addEventListener('click', () => {
        applyPrimaryColor(DEFAULT_COLOR);
    });
}

function setGalleryColWidth(v) {
    document.documentElement.style.setProperty('--gallery-col-width', v + 'px');
    Elements.gallerySizeSlider.value = v;
    localStorage.setItem('galleryColWidth', v);
    resizeAllMasonryItems();
}

export function initGallerySlider() {
    const saved = localStorage.getItem('galleryColWidth');
    const value = saved ? parseInt(saved, 10) : GALLERY_DEFAULT_SIZE;
    setGalleryColWidth(value);
    Elements.gallerySizeSlider.addEventListener('input', (e) => setGalleryColWidth(e.target.value));
    document.getElementById('gallerySizeReset').addEventListener('click', () => setGalleryColWidth(GALLERY_DEFAULT_SIZE));
}

export function initTheme() {
    setPressed(Elements.themeToggleBtn, document.documentElement.getAttribute('data-theme') === 'dark');

    Elements.themeToggleBtn.addEventListener('click', toggleTheme);
}
