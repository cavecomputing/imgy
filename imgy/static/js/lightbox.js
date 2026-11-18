/** Full-screen viewer with a details panel, zoom, pan, pinch, and swipe navigation. */
import { getCurrentLightboxImage, State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatCount, formatFileSize, formatShortDate, getDisplayFilename, getExtension, getImageBaseName, isVideo } from './utils.js';
import { setToggleButtonState, showToast } from './ui.js';
import { applyFilters } from './data.js';
import { startHeaderInlineRename } from './rename.js';
import { deleteImage, removeTags, replaceImage, toggleFavorite, updateLocalState } from './actions.js';
import { closeLightboxTagFlyup, openLightboxTagFlyup, toggleLightboxTagFlyup } from './flyup.js';
import { toggleTagFilter } from './filters.js';
import { clearCardFocus } from './navigation.js';

const FILE_TYPES = { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', bmp: 'BMP' };
const STRIP_REACH = 4; // files the strip shows on each side of the open one

// Images loading in the background: the original on screen (and its thumbnail while that stands in)
// and, once it is up, the originals on either side, downloaded and decoded so arrowing to them shows
// them at once (they stay in the browser's cache afterwards). Moving on or closing drops them, so
// the viewer never holds more than three originals.
let loaders = [];
const decoded = new WeakSet(); // the neighbours whose original has decoded, so it draws at once
let shownVersion = 0; // bumped for each file shown and on closing, so a load that finishes late knows it is stale
let fadingAmbient = null; // a copy of the last file's glow, fading out over the new one

// A finger down on the image that may turn out to be a tap, and the last tap, so a double tap can
// reset the zoom. The second tap must start within DOUBLE_TAP_MS of the first and DOUBLE_TAP_PX of it.
let tapStart = null;
let lastTap = null;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 40;

// A one-finger drag on an unzoomed file: sideways the file follows the finger with its neighbour
// coming in beside it ('browse'), downwards it shrinks away as the viewer fades ('close'). `peeks`
// are the neighbours drawn for it; `arriving` is the one left standing in for the new file until
// the viewer puts that file up.
let drag = null;
let arriving = null;
const PEEK_GAP = 16; // between a file and its neighbour while they slide
const SETTLE_MS = 220;

function loadInBackground(url) {
    const loader = new Image();
    loader.src = url;
    loaders.push(loader);
    return loader;
}

/** Drop every background load but `keep`, aborting downloads still in flight. */
function stopBackgroundLoads(keep) {
    for (const loader of loaders) {
        if (loader !== keep) loader.removeAttribute('src');
    }
    loaders = keep ? [keep] : [];
}

function preloadNeighbours() {
    const files = State.filteredImages;
    for (const dir of [1, -1]) {
        const img = files[(State.currentImageIndex + dir + files.length) % files.length];
        // Videos stream when played, so only images are fetched ahead
        if (img === getCurrentLightboxImage() || isVideo(img.filename)) continue;
        const loader = loadInBackground(img.url);
        loader.decode().then(() => decoded.add(loader), () => {}); // decode() waits for the download
    }
}

/**
 * Put `src` up for the file `img`, in the file's own size fitted to the viewer, so the thumbnail
 * standing in for the original fills the same box. It goes up blurred, and the blur fades out when
 * the original replaces it; anything else goes up as it is, unzoomed, with nothing fading or
 * zooming over from the last file.
 */
/** Give a picture or video the file's own shape and size, fitted to the viewer, before any of it has loaded. */
function fitToFile(el, img) {
    const sized = img.width && img.height;
    el.style.width = sized ? `min(${img.width}px, 100cqw, ${img.width / img.height} * 100cqh)` : '';
    el.style.aspectRatio = sized ? `${img.width} / ${img.height}` : '';
}

function showImage(img, src) {
    const el = Elements.lightboxImage;
    const sharpening = src === img.url && el.getAttribute('src') === img.thumbnail_url;
    fitToFile(el, img);
    el.style.display = '';
    el.alt = getImageBaseName(img.filename);
    el.classList.toggle('switching', src !== img.url);
    el.src = src;
    // After a swipe the neighbour that slid in stands in until the img can draw the new file: until
    // then the img would go on drawing the last one (Safari does, for as long as a big original
    // takes to decode, even one decoded ahead in another Image)
    if (arriving) {
        el.decode().catch(() => {}).then(() => {
            if (el.getAttribute('src') !== src) return; // a later call has it
            dropArriving();
            el.style.visibility = '';
        });
    }
    if (sharpening) return;
    resetZoom();
    el.style.transition = 'none';
    getComputedStyle(el).opacity; // applies the changes while transitions are off
    el.style.transition = '';
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
    shownVersion++;
    stopBackgroundLoads();
    Elements.lightboxImage.removeAttribute('src'); // lets the browser drop the decoded original
    Elements.lightboxAmbient.removeAttribute('src');
    fadingAmbient?.remove();
    Elements.lightboxStrip.textContent = '';
    const restoreFilename = getCurrentLightboxImage()?.filename;
    cancelDrag();
    dropArriving();
    Elements.lightboxImage.style.visibility = '';
    Elements.lightbox.classList.remove('active');
    document.body.style.overflow = '';
    resetZoom();
    clearCardFocus(); // the redraw may leave the old outline on a card that keys no longer act on
    applyFilters();
    // Arrow keys carry on from the file that was open (the redraw may have moved it)
    if (restoreFilename) State.focusedCardIndex = State.filteredImages.findIndex(img => img.filename === restoreFilename);
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
    // An original fetched ahead is kept: it goes straight up if decoded, else it is waited for
    const original = loaders.find(loader => loader.getAttribute('src') === targetUrl);
    stopBackgroundLoads(original);
    const version = ++shownVersion;

    // Remove any existing video element
    const existingVideo = Elements.lightboxContent.querySelector('video.lightbox-video');
    if (existingVideo) { existingVideo.pause(); existingVideo.remove(); }

    if (videoMode) {
        Elements.lightboxImage.style.display = 'none';
        Elements.lightboxImage.removeAttribute('src'); // drops the last picture while the video plays
        Elements.resetZoomBtn.style.display = 'none';
        resetZoom();
        dropArriving();
        Elements.lightboxImage.style.visibility = '';

        const video = document.createElement('video');
        video.className = 'lightbox-video';
        video.controls = true;
        video.autoplay = true;
        video.src = targetUrl;
        video.poster = img.thumbnail_url;
        fitToFile(video, img); // else it opens at the poster's size and grows once the video's own size is known
        video.onerror = () => showToast('This video format may not be supported by your browser');
        // Once it has a first frame, the files on either side load ahead as they do for an image
        video.addEventListener('loadeddata', () => { if (version === shownVersion) preloadNeighbours(); }, { once: true });
        Elements.lightboxContent.insertBefore(video, Elements.prevImageBtn);
    } else {
        Elements.resetZoomBtn.style.display = '';
        // The original goes up once it has loaded and decoded, so it draws at once. Until then its
        // thumbnail stands in, from when that can draw; until then the last file stays up, so no frame
        // shows an empty box or the last picture squeezed into this file's box.
        const loader = original ?? loadInBackground(targetUrl);
        const stillShown = () => version === shownVersion; // not moved on or closed
        // The neighbours wait for this file's first frame, so their decoding doesn't hold it up
        const preloadAfterFrame = () => requestAnimationFrame(() => setTimeout(() => { if (stillShown()) preloadNeighbours(); }));
        if (decoded.has(loader) || Elements.lightboxImage.getAttribute('src') === targetUrl) { // or already up, on a redraw
            showImage(img, targetUrl);
            preloadAfterFrame();
        } else {
            const thumbnail = loadInBackground(img.thumbnail_url);
            let settled = false; // the original is up, or failed to load
            const showThumbnail = () => { if (stillShown() && !settled) showImage(img, img.thumbnail_url); };
            if (thumbnail.complete && thumbnail.naturalWidth) showThumbnail();
            else thumbnail.decode().then(showThumbnail, () => {});
            loader.decode().catch(() => {}).then(() => {
                if (!stillShown()) return;
                settled = true;
                // An original that didn't load leaves its thumbnail up, unblurred
                showImage(img, loader.naturalWidth ? targetUrl : img.thumbnail_url);
                Elements.lightboxImage.classList.remove('switching');
                preloadAfterFrame();
            });
        }
    }

    showAmbient(img.thumbnail_url);
    renderLightboxStrip();
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
}

/** The blurred glow behind the file: the last file's fades out over it instead of the whole room changing colour in one frame. */
function showAmbient(url) {
    const ambient = Elements.lightboxAmbient;
    const last = ambient.getAttribute('src');
    if (last === url) return;
    fadingAmbient?.remove(); // arrowing quickly fades from the newest glow only
    if (last && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const fading = fadingAmbient = ambient.cloneNode();
        fading.removeAttribute('id');
        ambient.after(fading);
        fading.animate({ opacity: 0 }, { duration: 400, easing: 'ease' }).finished.then(() => fading.remove(), () => {});
    }
    ambient.src = url;
}

/** The thumbnails of the files on either side, to jump to; hidden when the file is alone. */
function renderLightboxStrip() {
    const files = State.filteredImages;
    const current = State.currentImageIndex;
    const first = Math.max(0, current - STRIP_REACH);
    const near = files.length > 1 ? files.slice(first, current + STRIP_REACH + 1) : [];
    Elements.lightboxStrip.innerHTML = near.map((file, i) => `<button type="button" role="listitem" data-idx="${first + i}" aria-label="${esc(getDisplayFilename(file.filename))}"${first + i === current ? ' aria-current="true"' : ''}><img src="${esc(file.thumbnail_url)}" alt="" draggable="false"></button>`).join('');
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
    if (tags.length) Elements.lightboxTagTab.dataset.count = tags.length; // phones show it on the Tags tab
    else delete Elements.lightboxTagTab.dataset.count;
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
        chip.querySelector('.chip-x').addEventListener('click', () => removeTags([filename], [t]));
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

/** The picture or video on show, which a drag moves. */
function shownMedia() {
    return Elements.lightboxContent.querySelector('video.lightbox-video') || Elements.lightboxImage;
}

function dropArriving() {
    arriving?.remove();
    arriving = null;
}

/** The file `dir` steps away, drawn centred where the shown file is, ready to slide in. */
function makePeek(dir) {
    const files = State.filteredImages;
    const file = files[(State.currentImageIndex + dir + files.length) % files.length];
    const peek = document.createElement('img');
    peek.className = 'lb-peek';
    peek.alt = '';
    peek.draggable = false;
    // The original if it has been fetched ahead, else the thumbnail the gallery already has
    peek.src = loaders.some(l => decoded.has(l) && l.getAttribute('src') === file.url) ? file.url : file.thumbnail_url;
    fitToFile(peek, file);
    Elements.lightboxContent.append(peek);
    const media = shownMedia();
    peek.style.left = `${media.offsetLeft + (media.offsetWidth - peek.offsetWidth) / 2}px`;
    peek.style.top = `${media.offsetTop + (media.offsetHeight - peek.offsetHeight) / 2}px`;
    return peek;
}

/** Draw the drag with the finger (dx, dy) from where it went down: the files slid sideways, or the file pulled down. */
function drawDrag(dx, dy) {
    drag.dx = dx;
    drag.dy = dy;
    const media = shownMedia();
    media.style.transition = 'none'; // the img's transform transition would trail the finger (and outlast the touch)
    if (drag.mode === 'browse') {
        const span = Elements.lightboxContent.clientWidth + PEEK_GAP;
        const x = State.filteredImages.length > 1 ? dx : dx * 0.3; // nothing to slide in: it gives a little and comes back
        media.style.transform = `translateX(${x}px)`;
        for (const [dir, peek] of drag.peeks) peek.style.transform = `translateX(${x + dir * span}px)`;
    } else {
        const progress = Math.min(Math.max(dy / Elements.lightboxContent.clientHeight, 0), 1);
        media.style.transform = `translate(${dx}px, ${dy < 0 ? dy * 0.3 : dy}px) scale(${1 - progress * 0.4})`;
        Elements.lightbox.style.setProperty('--dismiss', Math.min(progress * 2, 1));
    }
}

/** Glide the drag from where it is to (toX, toY), then call `done`. */
function settleDrag(toX, toY, done) {
    const fromX = drag.dx, fromY = drag.dy;
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : SETTLE_MS;
    const start = performance.now();
    const step = now => {
        const t = duration ? Math.min((now - start) / duration, 1) : 1;
        const eased = 1 - (1 - t) ** 3;
        drawDrag(fromX + (toX - fromX) * eased, fromY + (toY - fromY) * eased);
        if (t < 1) drag.frame = requestAnimationFrame(step);
        else done();
    };
    drag.frame = requestAnimationFrame(step);
}

/** Put everything a drag moved back as it was, at once. */
function cancelDrag() {
    if (!drag) return;
    cancelAnimationFrame(drag.frame);
    for (const [, peek] of drag.peeks) peek.remove();
    const media = shownMedia();
    media.style.transform = media === Elements.lightboxImage ? 'translate(0px, 0px) scale(1)' : '';
    getComputedStyle(media).transform; // applies it while transitions are still off
    media.style.transition = '';
    Elements.lightboxImage.classList.remove('dragging');
    Elements.lightbox.style.removeProperty('--dismiss');
    drag = null;
}

/** Let go of a drag: on to the next file, closed, or back where it started, by how far and how fast it went. */
function endDrag() {
    const { mode, dx, dy, vx, vy } = drag;
    const content = Elements.lightboxContent;
    if (mode === 'browse' && State.filteredImages.length > 1) {
        const dir = dx < 0 ? 1 : -1;
        const flung = Math.abs(vx) > 0.4 && Math.sign(vx) === Math.sign(dx);
        if (Math.abs(dx) > content.clientWidth * 0.2 || flung) {
            settleDrag(-dir * (content.clientWidth + PEEK_GAP), 0, () => {
                // The neighbour stays in the middle until the viewer has the file up, so no frame shows the last one
                arriving = drag.peeks.get(dir);
                drag.peeks.delete(dir);
                Elements.lightboxImage.style.visibility = 'hidden';
                cancelDrag();
                navigateImage(dir);
            });
            return;
        }
    } else if (mode === 'close' && (dy > content.clientHeight * 0.15 || vy > 0.5)) {
        settleDrag(dx, content.clientHeight, closeLightbox);
        return;
    }
    settleDrag(0, 0, cancelDrag);
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
    Elements.lightboxStrip.addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (!button || button.hasAttribute('aria-current')) return;
        closeLightboxTagFlyup();
        State.currentImageIndex = Number(button.dataset.idx);
        updateLightboxContent();
    });
    Elements.prevImageBtn.addEventListener('click', () => navigateImage(-1));
    Elements.nextImageBtn.addEventListener('click', () => navigateImage(1));
    Elements.resetZoomBtn.addEventListener('click', resetZoom);
    Elements.lightboxImage.addEventListener('dblclick', () => { if (State.zoom.scale > 1) resetZoom(); });

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
        if (drag?.frame || arriving) return; // still gliding from the last drag, or waiting on its file
        if (e.touches.length === 1) {
            const t = e.touches[0];
            if (State.zoom.scale === 1) drag = { x: t.clientX, y: t.clientY, time: e.timeStamp, mode: null, dx: 0, dy: 0, vx: 0, vy: 0, peeks: new Map() };
            tapStart = e.target === Elements.lightboxImage ? { x: t.clientX, y: t.clientY, time: e.timeStamp } : null;
            if (State.zoom.scale > 1) {
                State.zoom.isDragging = true;
                State.zoom.startX = e.touches[0].clientX - State.zoom.translateX;
                State.zoom.startY = e.touches[0].clientY - State.zoom.translateY;
                Elements.lightboxImage.classList.add('dragging');
            }
        } else if (e.touches.length === 2) {
            cancelDrag(); // a pinch is not a swipe
            tapStart = lastTap = null; // nor a tap
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
        if (e.touches.length === 1 && drag && !drag.frame) {
            const t = e.touches[0];
            const dx = t.clientX - drag.x, dy = t.clientY - drag.y;
            if (!drag.mode) {
                if (Math.hypot(dx, dy) < 10) return;
                drag.mode = Math.abs(dx) > Math.abs(dy) ? 'browse' : dy > 0 ? 'close' : 'none';
                if (drag.mode === 'browse' && State.filteredImages.length > 1) {
                    for (const dir of [1, -1]) drag.peeks.set(dir, makePeek(dir));
                }
                Elements.lightboxImage.classList.add('dragging');
            }
            if (drag.mode === 'none') return;
            const elapsed = e.timeStamp - drag.time;
            if (elapsed > 0) { // pixels per ms, mostly the last few moves
                drag.vx = drag.vx * 0.5 + (dx - drag.dx) / elapsed * 0.5;
                drag.vy = drag.vy * 0.5 + (dy - drag.dy) / elapsed * 0.5;
            }
            drag.time = e.timeStamp;
            drawDrag(dx, dy);
        } else if (e.touches.length === 1 && State.zoom.isDragging) {
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
        if (e.touches.length === 0 && tapStart) {
            const t = e.changedTouches[0];
            const isTap = e.timeStamp - tapStart.time < DOUBLE_TAP_MS && Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) < 10;
            const isDoubleTap = isTap && lastTap && tapStart.time - lastTap.time < DOUBLE_TAP_MS
                && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < DOUBLE_TAP_PX;
            if (isDoubleTap && State.zoom.scale > 1) resetZoom();
            lastTap = isTap && !isDoubleTap ? { x: t.clientX, y: t.clientY, time: e.timeStamp } : null;
            tapStart = null;
        }
        if (e.touches.length === 0 && drag && !drag.frame) {
            if (drag.mode === 'browse' || drag.mode === 'close') endDrag();
            else drag = null;
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

    Elements.lightboxContent.addEventListener('touchcancel', () => { if (!drag?.frame) cancelDrag(); });
    Elements.lightboxImage.addEventListener('load', updateCachedDimensions);

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
