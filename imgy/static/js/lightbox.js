/** Full-screen viewer with a details panel, zoom, pan, pinch, and swipe navigation. */
import { getCurrentLightboxImage, State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatCount, formatFileSize, formatShortDate, getDisplayFilename, getExtension, getImageBaseName, isVideo } from './utils.js';
import { setToggleButtonState, showToast } from './ui.js';
import { applyFilters } from './data.js';
import { startHeaderInlineRename } from './rename.js';
import { deleteImage, removeTag, replaceImage, toggleFavorite, updateLocalState } from './actions.js';
import { closeLightboxTagFlyup, openLightboxTagFlyup, toggleLightboxTagFlyup } from './flyup.js';
import { toggleTagFilter } from './filters.js';
import { clearCardFocus } from './navigation.js';

const FILE_TYPES = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', bmp: 'BMP' };

// Originals downloading in the background: the one on screen and, once it has arrived, the files
// on either side, so arrowing to them is instant (they stay in the browser's cache afterwards).
// Moving on or closing stops them, so nothing keeps downloading or holds memory for the viewer.
let loaders = [];

function loadInBackground(url) {
    const loader = new Image();
    loader.src = url;
    loaders.push(loader);
    return loader;
}

function stopBackgroundLoads() {
    for (const loader of loaders) {
        loader.onload = loader.onerror = null;
        loader.removeAttribute('src'); // aborts a download still in flight
    }
    loaders = [];
}

function preloadNeighbours() {
    const files = State.filteredImages;
    for (const dir of [1, -1]) {
        const img = files[(State.currentImageIndex + dir + files.length) % files.length];
        // Videos stream when played, so only images are fetched ahead
        if (img !== getCurrentLightboxImage() && !isVideo(img.filename)) loadInBackground(img.url);
    }
}

export function openLightbox(idx) {
    State.lightboxScrollY = window.scrollY;
    State.currentImageIndex = idx;
    updateLightboxContent();
    Elements.lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
}

export function closeLightbox() {
    const video = Elements.lightboxContent.querySelector('video.lightbox-video');
    if (video) { video.pause(); video.remove(); }
    Elements.lightboxExif.textContent = '';
    closeLightboxTagFlyup();
    stopBackgroundLoads();
    Elements.lightboxImage.removeAttribute('src'); // lets the browser drop the decoded original
    const restoreFilename = getCurrentLightboxImage()?.filename;
    Elements.lightbox.classList.remove('active');
    document.body.style.overflow = '';
    resetZoom();
    clearCardFocus(); // the redraw may leave the old outline on a card that keys no longer act on
    applyFilters();
    if (restoreFilename) {
        // focusedCardIndex counts DOM cards, so look the card up by filename
        const cards = [...Elements.imageGrid.querySelectorAll('.image-card')];
        State.focusedCardIndex = cards.findIndex(c => c.dataset.filename === restoreFilename);
    }
    if (State.lightboxScrollY != null) {
        window.scrollTo(0, State.lightboxScrollY);
        State.lightboxScrollY = null;
    }
}

export function setLightboxFavoriteState(isFavorite) {
    setToggleButtonState(Elements.lightboxFavoriteBtn, isFavorite);
    setToggleButtonState(Elements.lightboxFavoriteTab, isFavorite);
}

export function updateLightboxContent() {
    const img = getCurrentLightboxImage();
    if (!img) return;

    const targetUrl = img.url;
    const videoMode = isVideo(img.filename);
    stopBackgroundLoads();

    // Remove any existing video element
    const existingVideo = Elements.lightboxContent.querySelector('video.lightbox-video');
    if (existingVideo) { existingVideo.pause(); existingVideo.remove(); }

    if (videoMode) {
        Elements.lightboxImage.style.display = 'none';
        Elements.resetZoomBtn.style.display = 'none';

        const video = document.createElement('video');
        video.className = 'lightbox-video';
        video.controls = true;
        video.autoplay = true;
        video.src = targetUrl;
        video.poster = img.thumbnail_url;
        video.onerror = () => showToast('This video format may not be supported by your browser');
        Elements.lightboxContent.insertBefore(video, Elements.prevImageBtn);
    } else {
        Elements.lightboxImage.style.display = '';
        Elements.resetZoomBtn.style.display = '';
        Elements.lightboxImage.alt = getImageBaseName(img.filename);

        // Set dimensions immediately to prevent layout shift
        if (img.width && img.height) {
            Elements.lightboxImage.width = img.width;
            Elements.lightboxImage.height = img.height;
            Elements.lightboxImage.style.aspectRatio = `${img.width} / ${img.height}`;
        } else {
            Elements.lightboxImage.removeAttribute('width');
            Elements.lightboxImage.removeAttribute('height');
            Elements.lightboxImage.style.aspectRatio = '';
        }

        // 1. Show thumbnail as fast placeholder
        Elements.lightboxImage.classList.add('switching');
        Elements.lightboxImage.src = img.thumbnail_url;

        // 2. Preload full image in background, then the files next to it
        const fullImg = loadInBackground(targetUrl);
        fullImg.onload = () => {
            const currentImg = State.filteredImages[State.currentImageIndex];
            if (currentImg && currentImg.url === targetUrl) {
                Elements.lightboxImage.src = targetUrl;
                preloadNeighbours();
            }
        };
        fullImg.onerror = () => {
            console.error("Failed to load full image:", targetUrl);
            Elements.lightboxImage.classList.remove('switching');
        };
    }

    Elements.lightboxHeaderFilename.textContent = getImageBaseName(img.filename);
    Elements.lightboxHeaderExt.textContent = getExtension(img.filename);
    Elements.lightboxPosition.innerHTML = `${State.currentImageIndex + 1} of ${State.filteredImages.length}<span class="lb-pos-hint"> · swipe to browse</span>`;
    setLightboxFavoriteState(!!img.is_favorite);

    for (const link of [Elements.lightboxDownloadBtn, Elements.lightboxDownloadTab]) {
        link.href = img.url;
        link.download = getDisplayFilename(img.filename);
    }

    renderLightboxTagBar(img.tags || [], img.filename);
    renderLightboxMeta(img);
    renderLightboxExif(img.filename);
    resetZoom();
}

function describeType(filename) {
    const ext = getExtension(filename).slice(1).toLowerCase();
    if (isVideo(filename)) return `${ext.toUpperCase()} video`;
    return FILE_TYPES[ext] || ext.toUpperCase() || 'Unknown';
}

function formatLongDate(seconds) {
    const d = new Date(seconds * 1000);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function groupSize(filename) {
    const gid = State.filenameToGroup[filename];
    if (!gid) return 0;
    return State.images.filter(i => State.filenameToGroup[i.filename] === gid).length;
}

export function renderLightboxMeta(img) {
    const rows = [
        ['Type', esc(describeType(img.filename))],
        ['Size', esc(formatFileSize(img.size) || '—')],
        ['Dimensions', img.width && img.height ? `${img.width} × ${img.height}` : '—'],
        ['Added', esc(img.modified ? formatLongDate(img.modified) : '—')],
        ['Group', groupSize(img.filename) > 1 ? esc(formatCount(groupSize(img.filename), 'file')) : '—'],
        ['Path', `<code>${esc(img.filename)}</code>`]
    ];
    Elements.lightboxMeta.innerHTML = rows.map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('');

    // The one-line summary the phone sheet shows while collapsed
    const parts = [describeType(img.filename)];
    if (img.width && img.height) parts.push(`${img.width} × ${img.height}`);
    if (img.size) parts.push(formatFileSize(img.size));
    if (img.modified) parts.push(formatShortDate(img.modified));
    Elements.lightboxMetaLine.textContent = parts.join(' · ');
}

async function renderLightboxExif(filename) {
    const el = Elements.lightboxExif;
    el.textContent = '';
    Elements.lightboxMeta.querySelectorAll('tr.exif').forEach(tr => tr.remove());
    if (isVideo(filename)) return;
    // Responses can arrive after the user has moved to another file or closed the lightbox
    const isStale = () => getCurrentLightboxImage()?.filename !== filename || !Elements.lightbox.classList.contains('active');
    try {
        const res = await fetch(`/api/exif/${encodeURIComponent(filename)}`);
        if (!res.ok || isStale()) return;
        const data = await res.json();
        if (isStale()) return;
        const rows = [];
        if (data.date) {
            // EXIF date format: "YYYY:MM:DD HH:MM:SS"
            const parts = data.date.split(' ');
            const datePart = parts[0]?.replace(/:/g, '-');
            const d = new Date(datePart + (parts[1] ? 'T' + parts[1] : ''));
            if (!isNaN(d)) rows.push(['Taken', d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })]);
        }
        if (data.camera) rows.push(['Camera', data.camera]);
        const exposure = [data.aperture, data.shutter, data.iso].filter(Boolean).join(' · ');
        if (exposure) rows.push(['Exposure', exposure]);
        if (data.focal_length) rows.push(['Focal length', data.focal_length]);
        if (!rows.length) {
            el.textContent = 'No camera data (EXIF) in this file.';
            return;
        }
        Elements.lightboxMeta.insertAdjacentHTML('beforeend', rows.map(([label, value]) => `<tr class="exif"><td>${esc(label)}</td><td>${esc(value)}</td></tr>`).join(''));
    } catch (e) {
        // EXIF unavailable — silently skip
    }
}

export function renderLightboxTagBar(tags, filename) {
    const container = Elements.lightboxTagBarTags;
    container.innerHTML = '';
    if (!tags.length) container.insertAdjacentHTML('beforeend', '<span class="lb-empty">No tags yet.</span>');
    tags.forEach(t => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `<button class="chip-label" type="button" title="Show files tagged ${esc(t)}">${esc(t)}</button><button class="chip-x" type="button" title="Remove" aria-label="Remove tag ${esc(t)}"><svg class="i" aria-hidden="true"><use href="#i-x"/></svg></button>`;
        chip.querySelector('.chip-label').addEventListener('click', () => {
            const showing = !State.activeTags.has(t);
            toggleTagFilter(t);
            closeLightbox();
            showToast(showing ? `Showing files tagged "${t}"` : `Removed the "${t}" filter`);
        });
        chip.querySelector('.chip-x').addEventListener('click', () => removeTag(filename, t));
        container.appendChild(chip);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip chip-add';
    add.title = 'Edit tags (T)';
    add.innerHTML = '+ Add<kbd class="kbd kbd-sm">T</kbd>';
    add.addEventListener('click', openLightboxTagFlyup);
    container.appendChild(add);
}

function updateCachedDimensions() {
    State.dimensions = {
        imgWidth: Elements.lightboxImage.offsetWidth,
        imgHeight: Elements.lightboxImage.offsetHeight,
        contWidth: Elements.lightboxContent.offsetWidth,
        contHeight: Elements.lightboxContent.offsetHeight
    };
}

// Core transform: clamp + apply. Call directly (from rAF) or via updateTransform().
function applyTransform() {
    const { scale, translateX, translateY } = State.zoom;
    let tx = translateX, ty = translateY;
    const zoomedWidth = State.dimensions.imgWidth * scale;
    const zoomedHeight = State.dimensions.imgHeight * scale;
    if (scale <= 1) {
        tx = 0; ty = 0;
    } else {
        const limX = Math.max(0, (zoomedWidth - State.dimensions.contWidth) / 2);
        const limY = Math.max(0, (zoomedHeight - State.dimensions.contHeight) / 2);
        tx = Math.max(Math.min(tx, limX), -limX);
        ty = Math.max(Math.min(ty, limY), -limY);
    }
    State.zoom.translateX = tx; State.zoom.translateY = ty;
    Elements.lightbox.classList.toggle('zoomed-view', scale > 1);
    Elements.resetZoomBtn.classList.toggle('visible', scale !== 1 || tx !== 0 || ty !== 0);
    Elements.lightboxImage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

// Deferred version for event handlers (panning, pinch) that fire outside rAF.
function updateTransform() {
    if (State.transformPending) return;
    State.transformPending = true;
    requestAnimationFrame(() => {
        applyTransform();
        State.transformPending = false;
    });
}

// Zoom at least 10x, and far enough that a big image's own pixels can reach 4 screen pixels
function maxZoom() {
    return Math.max(10, 4 * Elements.lightboxImage.naturalWidth / (State.dimensions.imgWidth || Infinity));
}

function zoomToward(newScale, focalX, focalY) {
    const oldScale = State.zoom.scale;
    newScale = Math.min(Math.max(1, newScale), maxZoom());
    if (newScale === oldScale) return;
    const rect = Elements.lightboxContent.getBoundingClientRect();
    const cx = focalX - rect.left - rect.width / 2;
    const cy = focalY - rect.top - rect.height / 2;
    const ratio = newScale / oldScale;
    State.zoom.translateX = cx - ratio * (cx - State.zoom.translateX);
    State.zoom.translateY = cy - ratio * (cy - State.zoom.translateY);
    State.zoom.scale = newScale;
}

// Smooth wheel zoom: accumulate target, lerp in log-space each frame.
function startSmoothZoom(factor, focalX, focalY) {
    const sz = State.zoom;
    if (!sz._smoothTarget) sz._smoothTarget = sz.scale;
    sz._smoothTarget = Math.min(Math.max(1, sz._smoothTarget * factor), maxZoom());
    sz._focalX = focalX;
    sz._focalY = focalY;
    if (sz._smoothRAF) return;
    Elements.lightboxImage.classList.add('zooming');
    const animate = () => {
        const logCur = Math.log(sz.scale);
        const logTgt = Math.log(sz._smoothTarget);
        const logDiff = logTgt - logCur;
        if (Math.abs(logDiff) < 0.003) {
            zoomToward(sz._smoothTarget, sz._focalX, sz._focalY);
            applyTransform();
            sz._smoothRAF = 0;
            sz._smoothTarget = null;
            Elements.lightboxImage.classList.remove('zooming');
            return;
        }
        const next = Math.exp(logCur + logDiff * 0.2);
        zoomToward(next, sz._focalX, sz._focalY);
        applyTransform();
        sz._smoothRAF = requestAnimationFrame(animate);
    };
    sz._smoothRAF = requestAnimationFrame(animate);
}

export function resetZoom() {
    Elements.lightboxImage.classList.remove('zooming');
    if (State.zoom._smoothRAF) cancelAnimationFrame(State.zoom._smoothRAF);
    State.zoom = { scale: 1, translateX: 0, translateY: 0, isDragging: false, startX: 0, startY: 0, lastTouchDist: 0 };
    applyTransform();
}

export function navigateImage(dir) {
    if (State.filteredImages.length <= 1) return;
    closeLightboxTagFlyup();

    // filteredImages is already in grid order, with group members next to each other
    State.currentImageIndex = (State.currentImageIndex + dir + State.filteredImages.length) % State.filteredImages.length;

    updateLightboxContent();
}

export function initLightbox() {
    setLightboxFavoriteState(false);

    Elements.closeLightboxBtn.addEventListener('click', closeLightbox);
    Elements.lightboxBackBtn.addEventListener('click', closeLightbox);
    Elements.prevImageBtn.addEventListener('click', () => navigateImage(-1));
    Elements.nextImageBtn.addEventListener('click', () => navigateImage(1));
    Elements.resetZoomBtn.addEventListener('click', resetZoom);

    const startRename = () => {
        const img = getCurrentLightboxImage();
        if (img) startHeaderInlineRename(img, Elements.lightboxHeaderFilename);
    };
    Elements.lightboxHeaderFilename.addEventListener('click', startRename);
    Elements.lightboxHeaderFilename.addEventListener('keydown', e => { if (e.key === 'Enter') startRename(); });

    const trash = () => deleteImage(State.currentImageIndex);
    const favorite = async () => {
        const img = getCurrentLightboxImage();
        if (!img) return;
        const isFav = await toggleFavorite(img.filename);
        updateLocalState(img.filename, { is_favorite: isFav });
    };
    Elements.lightboxHeaderDeleteBtn.addEventListener('click', trash);
    Elements.lightboxDeleteTab.addEventListener('click', trash);
    Elements.lightboxTagBtn.addEventListener('click', toggleLightboxTagFlyup);
    Elements.lightboxTagTab.addEventListener('click', toggleLightboxTagFlyup);
    Elements.lightboxFavoriteBtn.addEventListener('click', favorite);
    Elements.lightboxFavoriteTab.addEventListener('click', favorite);
    const pickReplacement = () => Elements.replaceInput.click();
    Elements.lightboxReplaceBtn.addEventListener('click', pickReplacement);
    Elements.lightboxReplaceTab.addEventListener('click', pickReplacement);
    Elements.replaceInput.addEventListener('change', () => {
        const file = Elements.replaceInput.files[0];
        Elements.replaceInput.value = ''; // so picking the same file again still fires a change
        const img = getCurrentLightboxImage();
        if (file && img) replaceImage(img.filename, file);
    });

    Elements.lightboxContent.addEventListener('wheel', (e) => {
        if (!Elements.lightbox.classList.contains('active')) return;
        if (Elements.lightboxImage.style.display === 'none') return;
        e.preventDefault();
        updateCachedDimensions();
        // Normalize deltaY across input devices (trackpad vs notched wheel)
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;       // line mode → pixels
        else if (e.deltaMode === 2) dy *= 100;  // page mode → pixels
        // Scale factor proportional to scroll amount: ~12% per 100px notch
        const factor = Math.exp(-dy * 0.0012);
        startSmoothZoom(factor, e.clientX, e.clientY);
    }, { passive: false });

    Elements.lightboxContent.addEventListener('mousedown', (e) => {
        if (State.zoom.scale <= 1) return;
        State.zoom.isDragging = true;
        State.zoom.startX = e.clientX - State.zoom.translateX;
        State.zoom.startY = e.clientY - State.zoom.translateY;
        Elements.lightboxContent.style.cursor = 'grabbing';
        Elements.lightboxImage.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
        if (!State.zoom.isDragging) return;
        State.zoom.translateX = e.clientX - State.zoom.startX;
        State.zoom.translateY = e.clientY - State.zoom.startY;
        updateTransform();
    });

    window.addEventListener('mouseup', () => {
        State.zoom.isDragging = false;
        Elements.lightboxContent.style.cursor = '';
        Elements.lightboxImage.classList.remove('dragging');
    });

    // Touch support for panning & pinch-to-zoom
    Elements.lightboxContent.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            State.zoom.swipeStartX = e.touches[0].clientX;
            if (State.zoom.scale > 1) {
                State.zoom.isDragging = true;
                State.zoom.startX = e.touches[0].clientX - State.zoom.translateX;
                State.zoom.startY = e.touches[0].clientY - State.zoom.translateY;
                Elements.lightboxImage.classList.add('dragging');
            }
        } else if (e.touches.length === 2) {
            State.zoom.isDragging = false;
            Elements.lightboxImage.classList.add('dragging');
            updateCachedDimensions();
            State.zoom.lastTouchDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
        }
    }, { passive: true });

    Elements.lightboxContent.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1 && State.zoom.isDragging) {
            State.zoom.translateX = e.touches[0].clientX - State.zoom.startX;
            State.zoom.translateY = e.touches[0].clientY - State.zoom.startY;
            updateTransform();
        } else if (e.touches.length === 2) {
            Elements.lightboxImage.classList.add('zooming');
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            if (State.zoom.lastTouchDist > 0) {
                const ratio = dist / State.zoom.lastTouchDist;
                if (Math.abs(ratio - 1) > 0.01) {
                    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                    zoomToward(State.zoom.scale * ratio, midX, midY);
                    updateTransform();
                    State.zoom.lastTouchDist = dist;
                }
            }
        }
    }, { passive: true });

    Elements.lightboxContent.addEventListener('touchend', (e) => {
        if (e.changedTouches.length === 1 && State.zoom.scale === 1) {
            const deltaX = e.changedTouches[0].clientX - State.zoom.swipeStartX;
            if (Math.abs(deltaX) > 50) {
                navigateImage(deltaX > 0 ? -1 : 1);
            }
        }
        // Seamless pinch→pan: if one finger remains while zoomed, start panning
        if (e.touches.length === 1 && State.zoom.scale > 1) {
            State.zoom.isDragging = true;
            State.zoom.startX = e.touches[0].clientX - State.zoom.translateX;
            State.zoom.startY = e.touches[0].clientY - State.zoom.translateY;
            State.zoom.lastTouchDist = 0;
            Elements.lightboxImage.classList.remove('zooming');
            return;
        }
        State.zoom.isDragging = false;
        State.zoom.lastTouchDist = 0;
        Elements.lightboxImage.classList.remove('dragging');
        Elements.lightboxImage.classList.remove('zooming');
    });

    Elements.lightboxImage.addEventListener('load', () => {
        Elements.lightboxImage.classList.remove('switching');
        updateCachedDimensions();
    });

    window.addEventListener('resize', () => {
        if (Elements.lightbox.classList.contains('active')) {
            updateCachedDimensions();
            updateTransform();
        }
    });
    Elements.lightboxImage.addEventListener('error', () => {
        Elements.lightboxImage.classList.remove('switching');
        showToast('Failed to load file');
    });
}
