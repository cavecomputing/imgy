/** Full-screen viewer with zoom, pan, pinch, and swipe navigation. */
import { getCurrentLightboxImage, State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatFileSize, getDisplayFilename, getImageBaseName, isVideo } from './utils.js';
import { setToggleButtonState, showToast } from './ui.js';
import { applyFilters } from './data.js';
import { startHeaderInlineRename } from './rename.js';
import { deleteImage, toggleFavorite, updateLocalState } from './actions.js';
import { closeLightboxTagFlyup, openLightboxTagFlyup } from './flyup.js';
import { toggleTagFilter } from './filters.js';
import { llmQueueAdd, llmQueueSyncLightbox } from './llm.js';

export function openLightbox(idx) {
    State.lightboxScrollY = window.scrollY;
    State.currentImageIndex = idx;
    updateLightboxContent();
    Elements.lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
    
    Elements.lightboxTagBtn?.classList.remove('active');
}

export function closeLightbox() {
    const video = Elements.lightboxContent.querySelector('video.lightbox-video');
    if (video) { video.pause(); video.remove(); }
    const exifEl = document.getElementById('lightboxExif');
    if (exifEl) { exifEl.classList.add('hidden'); exifEl.innerHTML = ''; }
    closeLightboxTagFlyup();
    const restoreFilename = getCurrentLightboxImage()?.filename;
    Elements.lightbox.classList.remove('active');
    document.body.style.overflow = '';
    resetZoom();
    State.cardFocusActive = false;
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

export function updateLightboxContent() {
    const img = getCurrentLightboxImage();
    if (!img) return;

    const targetUrl = img.url;
    const videoMode = isVideo(img.filename);

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
        Elements.lightboxContent.insertBefore(video, document.getElementById('lightboxOverlayTags'));
    } else {
        Elements.lightboxImage.style.display = '';
        Elements.resetZoomBtn.style.display = '';

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

        // 2. Preload full image in background
        const fullImg = new Image();
        fullImg.onload = () => {
            const currentImg = State.filteredImages[State.currentImageIndex];
            if (currentImg && currentImg.url === targetUrl) {
                Elements.lightboxImage.src = targetUrl;
            }
        };
        fullImg.onerror = () => {
            console.error("Failed to load full image:", targetUrl);
            Elements.lightboxImage.classList.remove('switching');
        };
        fullImg.src = targetUrl;
    }

    const baseName = getImageBaseName(img.filename);
    const headerFilename = document.getElementById('lightboxHeaderFilename');
    if (headerFilename) {
        headerFilename.textContent = baseName;
    }
    setToggleButtonState(Elements.lightboxFavoriteBtn, !!img.is_favorite);

    if (Elements.lightboxDownloadBtn) {
        Elements.lightboxDownloadBtn.href = img.url;
        Elements.lightboxDownloadBtn.download = getDisplayFilename(img.filename);
    }

    // Hide LLM button for videos
    if (Elements.llmAnalyzeBtn) {
        Elements.llmAnalyzeBtn.style.display = videoMode ? 'none' : '';
    }

    renderLightboxTagBar(img.tags || [], img.filename);
    renderLightboxMeta(img);
    renderLightboxExif(img.filename);
    resetZoom();
    llmQueueSyncLightbox();
}

export function renderLightboxMeta(img) {
    const el = document.getElementById('lightboxMeta');
    if (!el) return;
    const parts = [];
    const ext = img.filename.split('.').pop().toUpperCase();
    if (ext) parts.push(ext);
    if (img.width && img.height) parts.push(`${img.width} × ${img.height}`);
    if (img.size) parts.push(formatFileSize(img.size));
    if (img.modified) {
        const d = new Date(img.modified * 1000);
        parts.push(d.toLocaleDateString());
    }
    el.innerHTML = parts.map(p => `<span class="lightbox-meta-item">${esc(p)}</span>`).join('');
}

async function renderLightboxExif(filename) {
    const el = document.getElementById('lightboxExif');
    if (!el) return;
    el.classList.add('hidden');
    el.innerHTML = '';
    if (isVideo(filename)) return;
    // Responses can arrive after the user has moved to another image or closed the lightbox
    const isStale = () => getCurrentLightboxImage()?.filename !== filename || !Elements.lightbox.classList.contains('active');
    try {
        const res = await fetch(`/api/exif/${encodeURIComponent(filename)}`);
        if (!res.ok || isStale()) return;
        const data = await res.json();
        if (isStale()) return;
        const fields = [];
        if (data.date) {
            // EXIF date format: "YYYY:MM:DD HH:MM:SS"
            const parts = data.date.split(' ');
            const datePart = parts[0]?.replace(/:/g, '-');
            const d = new Date(datePart + (parts[1] ? 'T' + parts[1] : ''));
            if (!isNaN(d)) fields.push(d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
        }
        if (data.camera) fields.push(data.camera);
        if (data.focal_length) fields.push(data.focal_length);
        if (data.aperture) fields.push(data.aperture);
        if (data.shutter) fields.push(data.shutter);
        if (data.iso) fields.push(data.iso);
        if (fields.length === 0) return;
        el.innerHTML = `
            <span class="lightbox-exif-icon">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
            </span>
            ${fields.map(f => `<span class="lightbox-exif-item">${esc(f)}</span>`).join('')}
        `;
        el.classList.remove('hidden');
    } catch (e) {
        // EXIF unavailable — silently skip
    }
}

export function renderLightboxTagBar(tags, filename) {
    const container = document.getElementById('lightboxTagBarTags');
    if (!container) return;
    container.innerHTML = '';
    if (!tags.length) {
        container.innerHTML = '<span class="lightbox-tag-bar-empty">No tags</span>';
        return;
    }
    tags.forEach(t => {
        const el = document.createElement('span');
        el.className = 'lightbox-tag-bar-tag';
        el.textContent = t;
        el.onclick = () => {
            toggleTagFilter(t);
            closeLightbox();
        };
        container.appendChild(el);
    });
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
    Elements.lightboxImage.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
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

function zoomToward(newScale, focalX, focalY) {
    const oldScale = State.zoom.scale;
    newScale = Math.min(Math.max(1, newScale), 10);
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
    sz._smoothTarget = Math.min(Math.max(1, sz._smoothTarget * factor), 10);
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
    setToggleButtonState(Elements.lightboxFavoriteBtn, false);

    Elements.closeLightboxBtn.addEventListener('click', closeLightbox);
    Elements.prevImageBtn.addEventListener('click', () => navigateImage(-1));
    Elements.nextImageBtn.addEventListener('click', () => navigateImage(1));
    Elements.resetZoomBtn.addEventListener('click', resetZoom);

    document.getElementById('lightboxTagBar')?.addEventListener('click', (e) => {
        const span = e.target.closest('.editable-header-filename');
        if (!span) return;
        const img = getCurrentLightboxImage();
        if (img) startHeaderInlineRename(img, span);
    });
    Elements.llmAnalyzeBtn?.addEventListener('click', () => {
        const img = getCurrentLightboxImage();
        if (img) llmQueueAdd(img.filename);
    });
    Elements.lightboxHeaderDeleteBtn?.addEventListener('click', () => deleteImage(State.currentImageIndex));
    Elements.lightboxTagBtn?.addEventListener('click', () => {
        openLightboxTagFlyup();
    });
    Elements.lightboxFavoriteBtn?.addEventListener('click', async () => {
        const img = getCurrentLightboxImage();
        if (img) {
            const isFav = await toggleFavorite(img.filename);
            updateLocalState(img.filename, { is_favorite: isFav });
        }
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
