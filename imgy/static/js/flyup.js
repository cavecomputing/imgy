/** Tag editor flyups for a gallery card, the bulk selection, and the lightbox. */
import { CONFIG } from './config.js';
import { getCurrentLightboxImage, getSelectedFilenames, refreshBulkVirtualTags, State } from './state.js';
import { ActiveFlyup, Elements } from './dom.js';
import { esc, formatCount } from './utils.js';
import { showToast } from './ui.js';
import { processBulkTagsFromInput, updateSelectionBar } from './selection.js';
import { addTags, removeTag } from './actions.js';
import { collectTagMutations, getCommonTags, splitTagTokens, tryTabCompletion } from './tags.js';
import { toggleTagFilter } from './filters.js';
import { renderLightboxTagBar } from './lightbox.js';
import { getLlmActionSummary, llmQueueAdd } from './llm.js';

export function isGalleryTagFlyupOpen() {
    return Elements.galleryTagFlyup.classList.contains('active');
}

export function isLightboxTagFlyupOpen() {
    return Elements.lightboxTagFlyup.classList.contains('active');
}

let _galleryCloseTimer = 0;

let _lightboxCloseTimer = 0;

export function openGalleryTagFlyup(img) {
    clearTimeout(_galleryCloseTimer);
    State.currentQuickTagImage = img;
    State.quickTagIndex = -1;
    ActiveFlyup.setGallery();
    const thumb = document.getElementById('galleryTagThumb');
    if (thumb) thumb.src = img.thumbnail_url || img.url;
    Elements.galleryTagFlyup.classList.remove('hidden');
    ActiveFlyup.input.value = '';
    focusFlyupPanel(Elements.galleryTagFlyup);
    renderActiveQuickTagPanel();
}

export function openBulkTagFlyup() {
    if (State.selectedImages.size === 0) return;
    clearTimeout(_galleryCloseTimer);
    State.bulkTagFlyupMode = true;
    State.currentQuickTagImage = { filename: '__bulk__', _bulkFilenames: getSelectedFilenames() };
    refreshBulkVirtualTags(State.currentQuickTagImage);
    State.quickTagIndex = -1;
    ActiveFlyup.setGallery();
    Elements.galleryTagFlyup.classList.remove('hidden');
    Elements.galleryTagFlyup.classList.add('bulk-mode');
    ActiveFlyup.input.value = '';
    ActiveFlyup.input.placeholder = 'Bulk tags: foo -remove +add = ? --';
    focusFlyupPanel(Elements.galleryTagFlyup);
    renderActiveQuickTagPanel();
}

export function closeGalleryTagFlyup() {
    if (!isGalleryTagFlyupOpen()) return;
    Elements.galleryTagFlyup.classList.remove('active');
    const cleanup = () => {
        if (Elements.galleryTagFlyup.classList.contains('active')) return;
        Elements.galleryTagFlyup.classList.add('hidden');
        Elements.galleryTagFlyup.classList.remove('bulk-mode');
        Elements.quickTagInput.placeholder = 'Tags: foo bar -remove +add';
        State.bulkTagFlyupMode = false;
        State.currentQuickTagImage = null;
        State.quickTagIndex = -1;
    };
    Elements.galleryTagFlyup.addEventListener('transitionend', cleanup, { once: true });
    clearTimeout(_galleryCloseTimer);
    _galleryCloseTimer = setTimeout(cleanup, CONFIG.FLYUP_CLOSE_DELAY_MS);
}

export function openLightboxTagFlyup() {
    clearTimeout(_lightboxCloseTimer);
    const img = getCurrentLightboxImage();
    if (!img) return;
    ActiveFlyup.setLightbox();
    State.currentQuickTagImage = img;
    State.quickTagIndex = -1;
    const tagBar = document.getElementById('lightboxTagBar');
    if (tagBar) {
        const barRect = tagBar.getBoundingClientRect();
        const parentRect = Elements.lightbox.getBoundingClientRect();
        Elements.lightboxTagFlyup.style.bottom = (parentRect.bottom - barRect.top + 8) + 'px';
    }
    Elements.lightboxTagFlyup.classList.remove('hidden');
    ActiveFlyup.input.value = '';
    focusFlyupPanel(Elements.lightboxTagFlyup);
    renderActiveQuickTagPanel();
}

export function closeLightboxTagFlyup() {
    if (!isLightboxTagFlyupOpen()) return;
    Elements.lightboxTagFlyup.classList.remove('active');
    const cleanup = () => {
        if (Elements.lightboxTagFlyup.classList.contains('active')) return;
        Elements.lightboxTagFlyup.classList.add('hidden');
        ActiveFlyup.setGallery();
        State.currentQuickTagImage = null;
        State.quickTagIndex = -1;
    };
    Elements.lightboxTagFlyup.addEventListener('transitionend', cleanup, { once: true });
    clearTimeout(_lightboxCloseTimer);
    _lightboxCloseTimer = setTimeout(cleanup, CONFIG.FLYUP_CLOSE_DELAY_MS);
}

export function refreshLightboxAfterTagEdit() {
    if (!isLightboxTagFlyupOpen()) return;
    const img = getCurrentLightboxImage();
    if (img) renderLightboxTagBar(img.tags || [], img.filename);
}

function getQuickTagModeInfo() {
    const raw = ActiveFlyup.input?.value.trim() || '';
    const scope = State.bulkTagFlyupMode
        ? `${State.selectedImages.size} selected`
        : 'this image';
    if (raw === '?') return { mode: 'LLM', detail: `queue ${scope}` };
    if (raw === '--') return { mode: 'clear', detail: `remove every tag from ${scope}` };
    if (raw === '=' && State.bulkTagFlyupMode) return { mode: 'equalize', detail: 'apply the selected tag union to all selected' };
    if (raw === '++' && State.bulkTagFlyupMode) return { mode: 'group', detail: `group ${State.selectedImages.size} selected images` };
    if (raw.includes('>')) return { mode: 'rename', detail: State.bulkTagFlyupMode ? 'rename within selected tag set' : 'rename a tag on this image' };
    if (raw.split(/\s+/).pop()?.startsWith('-')) return { mode: 'remove', detail: State.bulkTagFlyupMode ? 'remove from selected images that have it' : 'remove from this image' };
    return { mode: 'add', detail: State.bulkTagFlyupMode ? 'add to every selected image' : 'add to this image' };
}

function renderQuickTagHint() {
    if (!ActiveFlyup.hint) return;
    const info = getQuickTagModeInfo();
    ActiveFlyup.hint.innerHTML = `<span>${esc(info.mode)}</span><small>${esc(info.detail)}</small>`;
}

function focusFlyupPanel(panel) {
    requestAnimationFrame(() => {
        panel.classList.add('active');
        ActiveFlyup.input.focus();
    });
}

function renderActiveQuickTagPanel() {
    renderQuickTagCurrent();
    renderQuickTagHint();
    renderQuickTagSuggestions();
}

function resetQuickTagInput({ focus = false, lightboxRefresh = false } = {}) {
    ActiveFlyup.input.value = '';
    State.quickTagIndex = -1;
    refreshQuickTagUI();
    if (lightboxRefresh) refreshLightboxAfterTagEdit();
    if (focus) ActiveFlyup.input.focus();
}

function appendQuickTagSection(title, items, options = {}) {
    if (!items.length) return;
    const section = document.createElement('div');
    section.className = 'quick-tag-section';
    section.innerHTML = `<div class="quick-tag-section-title">${esc(title)}</div>`;
    const chips = document.createElement('div');
    chips.className = 'quick-tag-chip-row';
    items.forEach(tag => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `quick-tag-chip ${options.remove ? 'remove' : ''}`;
        btn.innerHTML = options.remove ? `${esc(tag)} <span>&times;</span>` : esc(tag);
        btn.addEventListener('click', () => options.onClick(tag));
        chips.appendChild(btn);
    });
    section.appendChild(chips);
    ActiveFlyup.suggestions.appendChild(section);
}

export function refreshQuickTagUI() {
    renderQuickTagCurrent();
    renderQuickTagSuggestions();
}

function renderQuickTagCurrent() {
    const img = State.currentQuickTagImage;
    if (!img || !ActiveFlyup.current) return;

    ActiveFlyup.current.innerHTML = '';
    const tags = img.tags || [];

    if (tags.length === 0) {
        ActiveFlyup.current.innerHTML = '<span class="empty-msg quick-tag-empty-msg">No tags assigned</span>';
        return;
    }

    tags.forEach(t => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'tag';
        el.title = `Filter by "${t}"`;
        el.innerHTML = `<span>${esc(t)}</span><span class="remove-tag quick-tag-remove" aria-label="Remove ${esc(t)}">&times;</span>`;
        
        // Click to filter by this tag
        el.onclick = (e) => {
            if (e.target.closest('.remove-tag')) return;
            toggleTagFilter(t);
            closeGalleryTagFlyup();
        };

        el.querySelector('.remove-tag').onclick = async (e) => {
            e.stopPropagation();
            await removeQuickTagFromContext(img, t);
        };
        ActiveFlyup.current.appendChild(el);
    });
}

function getQuickTagLastToken() {
    const val = ActiveFlyup.input.value;
    const tokens = val.split(/\s+/);
    const raw = tokens[tokens.length - 1] || '';
    const isRemove = raw.startsWith('-');
    const isAdd = raw.startsWith('+');
    const term = (isRemove || isAdd ? raw.slice(1) : raw).toLowerCase();
    return { raw, term, isRemove, isAdd };
}

function quickTagInsertSuggestion(tag) {
    const val = ActiveFlyup.input.value;
    const tokens = val.split(/\s+/);
    const last = tokens[tokens.length - 1] || '';
    const prefix = last.startsWith('-') ? '-' : last.startsWith('+') ? '+' : '';
    tokens[tokens.length - 1] = prefix + tag;
    ActiveFlyup.input.value = tokens.join(' ') + ' ';
    State.quickTagIndex = -1;
    renderQuickTagSuggestions();
    ActiveFlyup.input.focus();
}

async function removeQuickTagFromContext(img, tag) {
    if (!img) return;
    if (State.bulkTagFlyupMode) {
        const filenames = img._bulkFilenames || [];
        for (const fn of filenames) {
            const selectedImg = State.imagesByFilename.get(fn);
            if (selectedImg && selectedImg.tags?.includes(tag)) await removeTag(fn, tag);
        }
        refreshBulkVirtualTags(img);
        updateSelectionBar();
    } else {
        await removeTag(img.filename, tag);
    }
    resetQuickTagInput({ focus: true, lightboxRefresh: true });
}

function renderQuickTagSuggestions() {
    renderQuickTagHint();
    const img = State.currentQuickTagImage;
    const existing = img?.tags || [];
    const { term, isRemove } = getQuickTagLastToken();

    async function removeQuickTag(tag) {
        await removeQuickTagFromContext(img, tag);
    }

    async function chooseQuickTag(tag) {
        if (!img) return;
        if (State.bulkTagFlyupMode) {
            quickTagInsertSuggestion(tag);
            return;
        }
        if (isRemove) {
            await removeQuickTag(tag);
            return;
        }
        await addTags(img.filename, [tag]);
        resetQuickTagInput({ focus: true, lightboxRefresh: true });
    }

    function insertQuickCommand(command) {
        ActiveFlyup.input.value = command;
        State.quickTagIndex = -1;
        renderQuickTagHint();
        renderQuickTagSuggestions();
        ActiveFlyup.input.focus();
    }

    // Show hint for '?' LLM analyze
    if (ActiveFlyup.input.value.trim() === '?') {
        ActiveFlyup.suggestions.innerHTML = '';
        const hint = document.createElement('div');
        hint.className = 'quick-tag-suggestion clear-all-hint';
        const llm = getLlmActionSummary();
        if (State.bulkTagFlyupMode) {
            const count = State.selectedImages.size;
            hint.innerHTML = `<span>LLM ${esc(llm.action)} ${formatCount(count, 'image')} using ${esc(llm.model)}</span>`;
        } else {
            hint.innerHTML = `<span>LLM ${esc(llm.action)} this image using ${esc(llm.model)}</span>`;
        }
        ActiveFlyup.suggestions.appendChild(hint);
        State.quickTagMatches = [];
        return;
    }

    // Show warning hint for '--' clear-all
    if (ActiveFlyup.input.value.trim() === '--') {
        ActiveFlyup.suggestions.innerHTML = '';
        const hint = document.createElement('div');
        hint.className = 'quick-tag-suggestion delete-mode clear-all-hint';
        if (State.bulkTagFlyupMode) {
            const count = State.selectedImages.size;
            hint.innerHTML = `<span>Remove all ${formatCount(existing.length, 'tag')} from ${formatCount(count, 'image')}</span>`;
        } else {
            hint.innerHTML = `<span>Remove all ${formatCount(existing.length, 'tag')} from this image</span>`;
        }
        ActiveFlyup.suggestions.appendChild(hint);
        State.quickTagMatches = [];
        return;
    }

    // Show hint for '++' group selected images
    if (ActiveFlyup.input.value.trim() === '++' && State.bulkTagFlyupMode) {
        ActiveFlyup.suggestions.innerHTML = '';
        const hint = document.createElement('div');
        hint.className = 'quick-tag-suggestion clear-all-hint';
        const count = State.selectedImages.size;
        hint.innerHTML = `<span>Group ${formatCount(count, 'image')} together</span>`;
        ActiveFlyup.suggestions.appendChild(hint);
        State.quickTagMatches = [];
        return;
    }

    let matches;
    if (isRemove) {
        matches = existing.filter(t => !term || t.toLowerCase().includes(term));
    } else if (State.bulkTagFlyupMode) {
        // In bulk mode, show all tags (some selected images may not have them yet)
        matches = State.allTags.filter(t => !term || t.toLowerCase().includes(term));
    } else {
        matches = State.allTags.filter(t => !existing.includes(t) && (!term || t.toLowerCase().includes(term)));
    }

    State.quickTagMatches = matches;
    if (State.quickTagIndex >= matches.length) State.quickTagIndex = matches.length - 1;

    ActiveFlyup.suggestions.innerHTML = '';
    if (!term) {
        const actionItems = [
            { label: '? LLM', value: '?' },
            { label: '-- clear', value: '--' }
        ];
        if (State.bulkTagFlyupMode) {
            actionItems.push({ label: '= equalize', value: '=' }, { label: '++ group', value: '++' });
        }
        const section = document.createElement('div');
        section.className = 'quick-tag-section';
        section.innerHTML = '<div class="quick-tag-section-title">Actions</div>';
        const row = document.createElement('div');
        row.className = 'quick-tag-chip-row';
        actionItems.forEach(action => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'quick-tag-chip action';
            btn.textContent = action.label;
            btn.addEventListener('click', () => insertQuickCommand(action.value));
            row.appendChild(btn);
        });
        section.appendChild(row);
        ActiveFlyup.suggestions.appendChild(section);

        appendQuickTagSection(
            State.bulkTagFlyupMode ? 'Selected tag union' : 'Current tags',
            existing.slice(0, 12),
            { remove: true, onClick: removeQuickTag }
        );

        const common = getCommonTags(8, State.bulkTagFlyupMode ? [] : existing);
        appendQuickTagSection('Common tags', common, { onClick: chooseQuickTag });
    }

    if (matches.length) {
        const title = document.createElement('div');
        title.className = 'quick-tag-section-title quick-tag-match-title';
        title.textContent = isRemove ? 'Matching current tags' : 'Matching available tags';
        ActiveFlyup.suggestions.appendChild(title);

        matches.forEach((t, idx) => {
            const item = document.createElement('div');
            item.className = `quick-tag-suggestion match-item ${idx === State.quickTagIndex ? 'active' : ''} ${isRemove ? 'delete-mode' : ''}`;
            const count = State.tagCounts[t] || 0;
            const badgeClass = isRemove ? 'tag-count-badge orphaned' : 'tag-count-badge';
            item.innerHTML = `<span>${esc(t)}</span><span class="${badgeClass}">${count}</span>`;
            item.onclick = () => chooseQuickTag(t);
            ActiveFlyup.suggestions.appendChild(item);
        });
        // Scroll active into view
        if (State.quickTagIndex > -1) {
            const activeItem = ActiveFlyup.suggestions.querySelectorAll('.quick-tag-suggestion.match-item')[State.quickTagIndex];
            if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
        }
    } else if (term) {
        ActiveFlyup.suggestions.innerHTML = '<div class="no-results">No matches</div>';
        State.quickTagIndex = -1;
    } else {
        State.quickTagIndex = -1;
    }
}

export function initFlyups() {
    document.addEventListener('mousedown', (e) => {
        if (isGalleryTagFlyupOpen() &&
            !Elements.galleryTagFlyup.contains(e.target) &&
            !e.target.closest('.btn-add-tag') &&
            !e.target.closest('.selection-bar')) {
            closeGalleryTagFlyup();
        }
        if (isLightboxTagFlyupOpen() &&
            !Elements.lightboxTagFlyup.contains(e.target) &&
            !e.target.closest('#lightboxTagBtn')) {
            closeLightboxTagFlyup();
        }
    });

    // Quick Tag — shared handlers for modal and inline lightbox input
    function handleQuickTagInput() {
        State.quickTagIndex = -1;
        renderQuickTagHint();
        renderQuickTagSuggestions();
    }

    function handleQuickTagAutocomplete(rawQVal, matches) {
        if (rawQVal.trim() === '?') return false;
        return tryTabCompletion(rawQVal, matches, {
            prefixChars: ['-', '+'],
            setValue: v => { ActiveFlyup.input.value = v; },
            onComplete: () => { State.quickTagIndex = -1; renderQuickTagSuggestions(); }
        });
    }

    async function handleQuickTagBulkMode(rawQVal, img) {
        try {
            await processBulkTagsFromInput(rawQVal.trim());
        } catch (err) {
            console.error('Bulk tag operation failed:', err);
        } finally {
            refreshBulkVirtualTags(img);
            resetQuickTagInput();
            updateSelectionBar();
        }
    }

    async function handleQuickTagSingleImage(tokens, img) {
        // Handle '?' LLM analyze
        if (tokens.length === 1 && tokens[0] === '?') {
            llmQueueAdd(img.filename);
            resetQuickTagInput();
            return;
        }

        // Handle '--' clear all tags
        if (tokens.length === 1 && tokens[0] === '--') {
            const allImgTags = [...(img.tags || [])];
            if (allImgTags.length === 0) { showToast('No tags to remove'); return; }
            for (const tag of allImgTags) {
                await removeTag(img.filename, tag);
            }
            resetQuickTagInput({ lightboxRefresh: true });
            showToast(`Cleared all ${formatCount(allImgTags.length, 'tag')}`);
            return;
        }

        // Process token expressions
        const { toAdd, toRemove, toRename } = collectTagMutations(tokens, {
            availableTags: State.allTags,
            existingTags: img.tags || [],
            showUnavailablePlain: false,
            removeMissingMessage: tag => `"${tag}" not on this image`,
            renameMissingMessage: tag => `"${tag}" not on this image`
        });
        for (const { oldName, newName } of toRename) {
            await removeTag(img.filename, oldName);
            await addTags(img.filename, [newName]);
        }
        if (toAdd.length > 0) {
            await addTags(img.filename, toAdd);
        }
        for (const tag of toRemove) {
            if (img.tags?.includes(tag)) {
                await removeTag(img.filename, tag);
            }
        }
        if (toAdd.length === 0 && toRemove.length === 0 && toRename.length === 0) return;

        resetQuickTagInput({ lightboxRefresh: true });
    }

    async function handleQuickTagKeydown(e) {
        const matches = State.quickTagMatches;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (matches.length > 0) {
                State.quickTagIndex = (State.quickTagIndex + 1) % matches.length;
                renderQuickTagSuggestions();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (matches.length > 0) {
                State.quickTagIndex = (State.quickTagIndex - 1 + matches.length) % matches.length;
                renderQuickTagSuggestions();
            }
        } else if (e.key === 'Tab') {
            e.preventDefault();
            const rawQVal = ActiveFlyup.input.value;
            handleQuickTagAutocomplete(rawQVal, matches);
            return;
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const img = State.currentQuickTagImage;
            if (!img) return;

            let rawQVal = ActiveFlyup.input.value;
            const tokens = splitTagTokens(rawQVal, /\s+/);
            if (!State.bulkTagFlyupMode && tokens.includes('=')) { showToast('"=" is only available in selection mode'); return; }
            if (!State.bulkTagFlyupMode && tokens.includes('++')) { showToast('"++" is only available in selection mode'); return; }
            if (tokens.includes('?') && tokens.length > 1) { showToast('"?" must be the only token'); return; }

            if (tokens.length === 0) return;

            if (State.bulkTagFlyupMode) {
                await handleQuickTagBulkMode(rawQVal, img);
            } else {
                await handleQuickTagSingleImage(tokens, img);
            }
        } else if (e.key === 'Escape') {
            if (isLightboxTagFlyupOpen()) {
                closeLightboxTagFlyup();
            } else {
                closeGalleryTagFlyup();
            }
        }
    }

    Elements.quickTagInput.addEventListener('input', handleQuickTagInput);
    Elements.quickTagInput.addEventListener('keydown', handleQuickTagKeydown);
    Elements.lightboxTagInput.addEventListener('input', handleQuickTagInput);
    Elements.lightboxTagInput.addEventListener('keydown', handleQuickTagKeydown);
}
