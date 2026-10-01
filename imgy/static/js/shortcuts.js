/** Global keyboard shortcuts (the in-app ? dialog lists them). */
import { State } from './state.js';
import { Elements } from './dom.js';
import { startInlineRename } from './rename.js';
import { clearCardFocus, deleteSelectedOrFocusedImage, getFocusedCard, getFocusedFilteredIndex, getFocusedImage, navigateGrid } from './navigation.js';
import { bulkToggleFavorites, clearSelection, toggleImageSelection, toggleSelectionMode } from './selection.js';
import { deleteImage, toggleFavorite, updateLocalState } from './actions.js';
import { closeGalleryTagFlyup, closeLightboxTagFlyup, isGalleryTagFlyupOpen, isLightboxTagFlyupOpen, openBulkTagFlyup, openGalleryTagFlyup } from './flyup.js';
import { toggleExcludeTag, toggleTagFilter } from './filters.js';
import { closeLightbox, navigateImage, openLightbox, resetZoom } from './lightbox.js';
import { closeShortcutsModal, toggleShortcutsModal } from './settings.js';

export function initShortcuts() {
    document.addEventListener('keydown', async (e) => {
        const target = document.activeElement;
        if (target && (target.matches('input, textarea, select') || target.isContentEditable)) {
            if (e.key === 'Escape') target.blur();
            return;
        }
        // Leave Ctrl/Cmd/Alt combinations (Ctrl+D, Cmd+F, ...) to the browser. AltGr still
        // counts as typing, since some keyboard layouts need it for keys like / or ?
        if ((e.ctrlKey || e.metaKey || e.altKey) && !e.getModifierState('AltGraph')) return;

        // ? and x always work regardless of modal state
        if (e.key === '?') { e.preventDefault(); toggleShortcutsModal(); return; }
        if (e.key === 'x') { e.preventDefault(); Elements.trashBtn.click(); return; }

        // Check if a modal is open — if so only Escape works
        const shortcutsOpen = Elements.shortcutsModal.open;
        const trashOpen = Elements.trashModal.open;
        const galleryTagOpen = isGalleryTagFlyupOpen();
        const lightboxTagOpen = isLightboxTagFlyupOpen();
        const anyModalOpen = shortcutsOpen || trashOpen || galleryTagOpen || lightboxTagOpen;

        if (e.key === 'Escape') {
            if (shortcutsOpen) { closeShortcutsModal(); return; }
            if (trashOpen) { Elements.trashModal.close(); return; }
            if (galleryTagOpen) { closeGalleryTagFlyup(); return; }
            if (lightboxTagOpen) { closeLightboxTagFlyup(); return; }
            if (Elements.lightbox.classList.contains('active')) { closeLightbox(); return; }
            if (State.selectionMode) { clearSelection(); return; }
            if (State.cardFocusActive) { clearCardFocus(); return; }
        }

        if (e.key === '/' && (galleryTagOpen || lightboxTagOpen)) {
            e.preventDefault();
            closeGalleryTagFlyup();
            closeLightboxTagFlyup();
            if (Elements.lightbox.classList.contains('active')) closeLightbox();
            Elements.tagSearch.focus();
            return;
        }

        if (anyModalOpen) return;

        const inLightbox = Elements.lightbox.classList.contains('active');

        if (inLightbox) {
            if (e.key === 'ArrowLeft') { navigateImage(-1); return; }
            if (e.key === 'ArrowRight') { navigateImage(1); return; }
            if (e.key === 'f') { e.preventDefault(); Elements.lightboxFavoriteBtn?.click(); return; }
            if (e.key === 't') { e.preventDefault(); Elements.lightboxTagBtn?.click(); return; }
            if (e.key === 'd' || e.key === 'Delete') { e.preventDefault(); deleteImage(State.currentImageIndex); return; }
            if (e.key === 'r') { e.preventDefault(); document.getElementById('lightboxHeaderFilename')?.click(); return; }
            if (e.key === '0') { e.preventDefault(); resetZoom(); return; }
            if (e.key === '/') { e.preventDefault(); Elements.lightboxTagBtn?.click(); return; }
        } else {
            // Gallery keyboard navigation
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                const dir = e.key.replace('Arrow', '').toLowerCase();
                navigateGrid(dir);
                return;
            }
            if (e.key === 'Enter' && State.cardFocusActive) {
                e.preventDefault();
                const fi = getFocusedFilteredIndex();
                if (fi >= 0) openLightbox(fi);
                return;
            }
            if (e.key === ' ' && State.cardFocusActive) {
                e.preventDefault();
                const img = getFocusedImage();
                const card = getFocusedCard();
                if (img && card) {
                    if (!State.selectionMode) toggleSelectionMode();
                    toggleImageSelection(img.filename, card);
                }
                return;
            }
            if (e.key === 't') {
                if (State.selectedImages.size > 0) {
                    e.preventDefault();
                    openBulkTagFlyup();
                    return;
                }
                if (State.cardFocusActive) {
                    e.preventDefault();
                    const img = getFocusedImage();
                    if (img) openGalleryTagFlyup(img);
                    return;
                }
            }
            if (e.key === 'Backspace') {
                const excludes = [...State.excludeTags];
                if (excludes.length) {
                    e.preventDefault();
                    toggleExcludeTag(excludes[excludes.length - 1]);
                } else {
                    const tags = [...State.activeTags];
                    if (tags.length) {
                        e.preventDefault();
                        toggleTagFilter(tags[tags.length - 1]);
                    }
                }
                return;
            }
            if (e.key === 'Delete') {
                e.preventDefault();
                deleteSelectedOrFocusedImage();
                return;
            }
            if (e.key === 'd' && State.cardFocusActive) {
                e.preventDefault();
                deleteSelectedOrFocusedImage();
                return;
            }

            if (e.key === '/') {
                e.preventDefault();
                if (State.selectionMode && State.selectedImages.size > 0) {
                    openBulkTagFlyup();
                } else if (State.cardFocusActive) {
                    const img = getFocusedImage();
                    if (img) openGalleryTagFlyup(img);
                } else {
                    Elements.tagSearch.focus();
                }
                return;
            }
            if (e.key === 's') { e.preventDefault(); toggleSelectionMode(); return; }
            if (e.key === 'f') {
                e.preventDefault();
                if (State.cardFocusActive) {
                    if (State.selectedImages.size > 0) {
                        await bulkToggleFavorites();
                    } else {
                        const img = getFocusedImage();
                        if (img) {
                            const isFav = await toggleFavorite(img.filename);
                            updateLocalState(img.filename, { is_favorite: isFav });
                        }
                    }
                } else {
                    Elements.favoriteFilterBtn.click();
                }
                return;
            }
            if (e.key === 'r' && State.cardFocusActive) {
                e.preventDefault();
                const img = getFocusedImage();
                const card = getFocusedCard();
                const titleText = card?.querySelector('.card-title-text');
                if (img && titleText && card) {
                    startInlineRename(img, titleText, card);
                }
                return;
            }
            if (e.key === 'u') { e.preventDefault(); Elements.untaggedFilterBtn.click(); return; }
        }
    });
}
