/** Tag editors for a gallery card, the bulk selection, and the lightbox. */
import { CONFIG } from './config.js';
import { getCurrentLightboxImage, getImagesByFilenames, getSelectedFilenames, refreshBulkVirtualTags, State } from './state.js';
import { ActiveFlyup, Elements } from './dom.js';
import { esc, formatCount, getDisplayFilename, highlightMatch, isVideo } from './utils.js';
import { showToast } from './ui.js';
import { processBulkTagsFromInput, updateSelectionBar } from './selection.js';
import { addTags, removeTag } from './actions.js';
import { collectTagMutations, getCommonTags, planTagExpression, splitTagTokens, tryTabCompletion } from './tags.js';
import { toggleTagFilter } from './filters.js';
import { renderLightboxTagBar } from './lightbox.js';
import { llmQueueAdd } from './llm.js';
import { getLlmSettings } from './settings.js';

const SINGLE_PLACEHOLDER = 'tag  +new  -remove  old>new';
const BULK_PLACEHOLDER = 'tag  +new  -remove  old>new  =  ++  ?';

export function isGalleryTagFlyupOpen() {
    return Elements.galleryTagFlyup.classList.contains('active');
}

export function isLightboxTagFlyupOpen() {
    return Elements.lightboxTagFlyup.classList.contains('active');
}

let _galleryCloseTimer = 0;

export function openGalleryTagFlyup(img) {
    clearTimeout(_galleryCloseTimer);
    State.bulkTagFlyupMode = false;
    State.currentQuickTagImage = img;
    State.quickTagIndex = -1;
    ActiveFlyup.setGallery();
    const flyup = Elements.galleryTagFlyup;
    flyup.classList.remove('hidden', 'bulk-mode');
    Elements.galleryTagThumb.src = img.thumbnail_url || img.url;
    Elements.galleryTagEyebrow.textContent = 'Tags';
    Elements.galleryTagTitle.textContent = getDisplayFilename(img.filename);
    Elements.bulkTagBtn.classList.remove('active');
    ActiveFlyup.input.value = '';
    ActiveFlyup.input.placeholder = SINGLE_PLACEHOLDER;
    focusFlyupPanel(flyup);
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
    const flyup = Elements.galleryTagFlyup;
    flyup.classList.remove('hidden');
    flyup.classList.add('bulk-mode');
    Elements.galleryTagThumb.removeAttribute('src');
    Elements.galleryTagEyebrow.textContent = 'Bulk tags';
    Elements.galleryTagTitle.textContent = `${State.selectedImages.size} selected`;
    Elements.bulkTagBtn.classList.add('active');
    ActiveFlyup.input.value = '';
    ActiveFlyup.input.placeholder = BULK_PLACEHOLDER;
    focusFlyupPanel(flyup);
    renderActiveQuickTagPanel();
}

export function closeGalleryTagFlyup() {
    if (!isGalleryTagFlyupOpen()) return;
    const flyup = Elements.galleryTagFlyup;
    flyup.classList.remove('active');
    Elements.bulkTagBtn.classList.remove('active');
    const cleanup = () => {
        if (flyup.classList.contains('active')) return;
        flyup.classList.add('hidden');
        flyup.classList.remove('bulk-mode');
        Elements.quickTagInput.placeholder = SINGLE_PLACEHOLDER;
        State.bulkTagFlyupMode = false;
        State.currentQuickTagImage = null;
        State.quickTagIndex = -1;
    };
    flyup.addEventListener('transitionend', cleanup, { once: true });
    clearTimeout(_galleryCloseTimer);
    _galleryCloseTimer = setTimeout(cleanup, CONFIG.FLYUP_CLOSE_DELAY_MS);
}

export function openLightboxTagFlyup() {
    const img = getCurrentLightboxImage();
    if (!img) return;
    ActiveFlyup.setLightbox();
    State.currentQuickTagImage = img;
    State.quickTagIndex = -1;
    Elements.lightboxTagFlyup.classList.remove('hidden');
    Elements.lightboxTagBtn.classList.add('active');
    Elements.lightboxTagTab.classList.add('active');
    ActiveFlyup.input.value = '';
    focusFlyupPanel(Elements.lightboxTagFlyup);
    renderActiveQuickTagPanel();
}

export function closeLightboxTagFlyup() {
    const flyup = Elements.lightboxTagFlyup;
    if (!isLightboxTagFlyupOpen() && flyup.classList.contains('hidden')) return;
    // The lightbox editor sits inline in the details panel, so it closes at once
    flyup.classList.remove('active');
    flyup.classList.add('hidden');
    Elements.lightboxTagBtn.classList.remove('active');
    Elements.lightboxTagTab.classList.remove('active');
    if (document.activeElement === Elements.lightboxTagInput) Elements.lightboxTagInput.blur();
    ActiveFlyup.setGallery();
    State.currentQuickTagImage = null;
    State.quickTagIndex = -1;
}

export function toggleLightboxTagFlyup() {
    if (isLightboxTagFlyupOpen()) closeLightboxTagFlyup();
    else openLightboxTagFlyup();
}

export function refreshLightboxAfterTagEdit() {
    if (!isLightboxTagFlyupOpen()) return;
    const img = getCurrentLightboxImage();
    if (img) renderLightboxTagBar(img.tags || [], img.filename);
}

function focusFlyupPanel(panel) {
    requestAnimationFrame(() => {
        panel.classList.add('active');
        ActiveFlyup.input.focus();
    });
}

/** The files the open editor works on: one file, or the bulk selection. */
function getEditorFiles() {
    const img = State.currentQuickTagImage;
    if (!img) return [];
    return State.bulkTagFlyupMode ? getImagesByFilenames(img._bulkFilenames || []) : [img];
}

function currentPlan() {
    const bulk = State.bulkTagFlyupMode;
    const files = getEditorFiles();
    const s = getLlmSettings();
    const it = bulk && files.length !== 1 ? 'them' : 'it';
    let verbs = `look at ${it} (renaming and tagging are both off in Settings)`;
    if (s.doTags && s.doRename) verbs = `tag and rename ${it}`;
    else if (s.doTags) verbs = `tag ${it}`;
    else if (s.doRename) verbs = `rename ${it}`;
    return planTagExpression(ActiveFlyup.input?.value || '', { bulk, files, llm: { model: s.model, verbs } });
}

/** The preview under the input: what Enter would do with each token. */
function renderQuickTagHint(plan) {
    if (!ActiveFlyup.hint) return;
    ActiveFlyup.hint.innerHTML = plan.rows.length
        ? `<div class="plan">${plan.rows.map(r => `<code class="${r.cls}">${esc(r.code)}</code><span${r.alert ? ' class="warn"' : ''}>${r.html}</span>`).join('')}</div>`
        : '';
}

export function renderActiveQuickTagPanel() {
    if (!State.currentQuickTagImage) return;
    const plan = currentPlan();
    renderQuickTagHint(plan);
    renderQuickTagCurrent(plan);
    renderQuickTagSuggestions();
}

function resetQuickTagInput({ focus = false, lightboxRefresh = false } = {}) {
    ActiveFlyup.input.value = '';
    State.quickTagIndex = -1;
    renderActiveQuickTagPanel();
    if (lightboxRefresh) refreshLightboxAfterTagEdit();
    if (focus) ActiveFlyup.input.focus();
}

function appendSection(container, title, note = '') {
    const section = document.createElement('div');
    section.className = 'flyup-section';
    section.innerHTML = `<div class="flyup-section-title">${esc(title)}${note ? ` <small>${esc(note)}</small>` : ''}</div>`;
    container.appendChild(section);
    return section;
}

/** The tags already on the file or selection, marked with what the typed expression changes. */
function renderQuickTagCurrent(plan) {
    const img = State.currentQuickTagImage;
    const container = ActiveFlyup.current;
    if (!img || !container) return;
    const bulk = State.bulkTagFlyupMode;
    const files = getEditorFiles();
    const tags = img.tags || [];
    const countOf = (t) => files.filter(f => f.tags?.includes(t)).length;
    const ordered = bulk ? [...tags].sort((a, b) => countOf(b) - countOf(a) || a.localeCompare(b)) : tags;

    container.innerHTML = '';
    const section = appendSection(container, bulk ? 'On the selection' : 'On this file', tags.length ? formatCount(tags.length, 'tag') : '');
    const row = document.createElement('div');
    row.className = 'chips';
    plan.adds.forEach(t => {
        if (tags.includes(t)) return;
        const chip = document.createElement('span');
        chip.className = 'chip chip--new';
        chip.textContent = `+ ${t}`;
        row.appendChild(chip);
    });
    ordered.forEach(t => {
        const chip = document.createElement('span');
        chip.className = `chip${plan.removes.has(t) ? ' chip--rm' : ''}`;
        const count = bulk ? countOf(t) : 0;
        chip.innerHTML = `<button class="chip-label" type="button" title="Show files tagged ${esc(t)}">${esc(t)}</button>`
            + (bulk ? `<span class="chip-n" title="On ${formatCount(count, 'file')}">${count}</span>` : '')
            + `<button class="chip-x" type="button" title="Remove" aria-label="Remove ${esc(t)} from ${bulk ? 'the selection' : 'this file'}"><svg class="i" aria-hidden="true"><use href="#i-x"/></svg></button>`;
        chip.querySelector('.chip-label').addEventListener('click', () => {
            toggleTagFilter(t);
            closeGalleryTagFlyup();
        });
        chip.querySelector('.chip-x').addEventListener('click', () => removeQuickTagFromContext(img, t));
        row.appendChild(chip);
    });
    if (!row.children.length) row.innerHTML = `<span class="flyup-empty">${bulk ? 'None of the selected files have tags.' : 'No tags yet.'}</span>`;
    section.appendChild(row);
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

/** Put a tag in place of the token being typed, keeping its - or + prefix. */
function replaceQuickTagLastToken(tag, { trailingSpace = true } = {}) {
    const tokens = ActiveFlyup.input.value.split(/\s+/);
    const last = tokens[tokens.length - 1] || '';
    const prefix = last.startsWith('-') ? '-' : last.startsWith('+') ? '+' : '';
    tokens[tokens.length - 1] = prefix + tag;
    ActiveFlyup.input.value = tokens.join(' ') + (trailingSpace ? ' ' : '');
}

function quickTagInsertSuggestion(tag) {
    replaceQuickTagLastToken(tag);
    State.quickTagIndex = -1;
    renderActiveQuickTagPanel();
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

function insertQuickCommand(command) {
    ActiveFlyup.input.value = command;
    State.quickTagIndex = -1;
    renderActiveQuickTagPanel();
    ActiveFlyup.input.focus();
}

function renderQuickTagSuggestions() {
    const container = ActiveFlyup.suggestions;
    const img = State.currentQuickTagImage;
    const bulk = State.bulkTagFlyupMode;
    const existing = img?.tags || [];
    const { term, isRemove } = getQuickTagLastToken();
    const raw = ActiveFlyup.input.value.trim();
    container.innerHTML = '';

    async function chooseQuickTag(tag) {
        if (!img) return;
        if (bulk) {
            quickTagInsertSuggestion(tag);
            return;
        }
        if (isRemove) {
            await removeQuickTagFromContext(img, tag);
            return;
        }
        await addTags(img.filename, [tag]);
        resetQuickTagInput({ focus: true, lightboxRefresh: true });
    }

    // Commands and renames are explained by the preview above; nothing to suggest
    if (['?', '--', '=', '++'].includes(raw) || term.includes('>')) {
        State.quickTagMatches = [];
        State.quickTagIndex = -1;
        return;
    }

    let matches = [];
    if (term) {
        const pool = isRemove ? existing : bulk ? State.allTags : State.allTags.filter(t => !existing.includes(t));
        const byUse = (a, b) => (State.tagCounts[b] || 0) - (State.tagCounts[a] || 0) || a.localeCompare(b);
        const hits = pool.filter(t => t.toLowerCase().includes(term));
        matches = [
            ...hits.filter(t => t.toLowerCase().startsWith(term)).sort(byUse),
            ...hits.filter(t => !t.toLowerCase().startsWith(term)).sort(byUse)
        ];
    }
    State.quickTagMatches = matches;
    if (State.quickTagIndex >= matches.length) State.quickTagIndex = matches.length - 1;

    if (!term) {
        State.quickTagIndex = -1;
        const files = getEditorFiles();
        const actions = document.createElement('div');
        actions.className = 'chips';
        const addAction = (code, label, { warn = false, disabled = false, title = '' } = {}) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `mini${warn ? ' warn' : ''}`;
            btn.innerHTML = `<code>${esc(code)}</code>${esc(label)}`;
            if (title) btn.title = title;
            btn.disabled = disabled;
            btn.addEventListener('click', () => insertQuickCommand(code));
            actions.appendChild(btn);
        };
        const imageCount = files.filter(f => !isVideo(f.filename)).length;
        if (imageCount) addAction('?', bulk ? `Auto-tag ${imageCount}` : 'Auto-tag', { title: 'Ask the vision LLM for tags and a name' });
        if (bulk) {
            addAction('=', 'Equalize', { title: 'Give every selected file all their tags' });
            addAction('++', 'Group', { disabled: files.length < 2, title: files.length < 2 ? 'Select at least 2 files to group' : 'Group the selected files' });
        }
        if (existing.length) addAction('--', 'Clear all tags', { warn: true });
        if (actions.children.length) appendSection(container, 'Actions').appendChild(actions);

        const common = getCommonTags(8, bulk ? [] : existing);
        if (common.length) {
            const chips = document.createElement('div');
            chips.className = 'chips';
            common.forEach(tag => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'chip chip-pick';
                btn.textContent = tag;
                btn.title = bulk ? `Add ${tag} to the expression` : `Add ${tag}`;
                btn.addEventListener('click', () => chooseQuickTag(tag));
                chips.appendChild(btn);
            });
            appendSection(container, 'Common tags').appendChild(chips);
        }
        return;
    }

    // Nothing matches: the preview above already says what Enter would do
    if (!matches.length) {
        State.quickTagIndex = -1;
        return;
    }

    const section = appendSection(container, isRemove ? `Tags on ${bulk ? 'the selection' : 'this file'}` : 'Matching tags');
    const list = document.createElement('div');
    list.className = 'match-list';
    // Removing from a selection: count the selected files that have the tag, not the whole library
    const selected = bulk && isRemove ? getEditorFiles() : null;
    matches.forEach((t, idx) => {
        const item = document.createElement('div');
        item.className = `match-item${idx === State.quickTagIndex ? ' active' : ''}${isRemove ? ' delete-mode' : ''}`;
        const count = selected ? selected.filter(f => f.tags?.includes(t)).length : State.tagCounts[t] || 0;
        const countTitle = selected ? `On ${count} of ${formatCount(selected.length, 'selected file')}` : formatCount(count, 'file');
        item.innerHTML = `<span>${highlightMatch(t, term)}</span><span class="tag-count-badge" title="${countTitle}">${count}</span>`;
        item.addEventListener('click', () => chooseQuickTag(t));
        list.appendChild(item);
    });
    section.appendChild(list);
    const activeItem = list.children[State.quickTagIndex];
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
}

export function initFlyups() {
    document.addEventListener('mousedown', (e) => {
        if (isGalleryTagFlyupOpen() &&
            !Elements.galleryTagFlyup.contains(e.target) &&
            !e.target.closest('.tag-btn') &&
            !e.target.closest('.selection-bar')) {
            closeGalleryTagFlyup();
        }
        if (isLightboxTagFlyupOpen() &&
            !e.target.closest('.lb-sec-tags') &&
            !e.target.closest('#lightboxTagBtn, #lightboxTagTab')) {
            closeLightboxTagFlyup();
        }
    });

    // Shared handlers for the gallery and lightbox inputs
    function handleQuickTagInput() {
        State.quickTagIndex = -1;
        renderActiveQuickTagPanel();
    }

    async function handleQuickTagBulkMode(rawQVal, img) {
        try {
            await processBulkTagsFromInput(rawQVal.trim());
        } catch (err) {
            console.error('Bulk tag operation failed:', err);
        } finally {
            if (State.currentQuickTagImage === img) {
                refreshBulkVirtualTags(img);
                resetQuickTagInput();
            }
            updateSelectionBar();
        }
    }

    async function handleQuickTagSingleImage(tokens, img) {
        // '?' asks the LLM for tags and a name
        if (tokens.length === 1 && tokens[0] === '?') {
            llmQueueAdd(img.filename);
            resetQuickTagInput();
            return;
        }

        // '--' clears every tag
        if (tokens.length === 1 && tokens[0] === '--') {
            const allImgTags = [...(img.tags || [])];
            if (allImgTags.length === 0) { showToast('No tags to remove'); return; }
            for (const tag of allImgTags) {
                await removeTag(img.filename, tag);
            }
            resetQuickTagInput({ lightboxRefresh: true });
            showToast(`Removed ${formatCount(allImgTags.length, 'tag')}`);
            return;
        }

        const { toAdd, toRemove, toRename } = collectTagMutations(tokens, {
            availableTags: State.allTags,
            existingTags: img.tags || [],
            showUnavailablePlain: false,
            removeMissingMessage: tag => `"${tag}" is not on this file`,
            renameMissingMessage: tag => `"${tag}" is not on this file`
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
            const highlighted = State.quickTagIndex > -1 ? matches[State.quickTagIndex] : null;
            if (highlighted) {
                quickTagInsertSuggestion(highlighted);
                return;
            }
            const rawQVal = ActiveFlyup.input.value;
            if (rawQVal.trim() === '?') return;
            tryTabCompletion(rawQVal, matches, {
                prefixChars: ['-', '+'],
                setValue: v => { ActiveFlyup.input.value = v; },
                onComplete: () => { State.quickTagIndex = -1; renderActiveQuickTagPanel(); }
            });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const img = State.currentQuickTagImage;
            if (!img) return;

            // A highlighted suggestion stands in for the token being typed
            const highlighted = State.quickTagIndex > -1 ? matches[State.quickTagIndex] : null;
            if (highlighted) replaceQuickTagLastToken(highlighted, { trailingSpace: false });

            const rawQVal = ActiveFlyup.input.value;
            const tokens = splitTagTokens(rawQVal, /\s+/);
            if (!State.bulkTagFlyupMode && tokens.includes('=')) { showToast('"=" only works on a selection'); return; }
            if (!State.bulkTagFlyupMode && tokens.includes('++')) { showToast('"++" only works on a selection'); return; }
            if (tokens.includes('?') && tokens.length > 1) { showToast('"?" must be the only token'); return; }

            if (tokens.length === 0) return;

            if (State.bulkTagFlyupMode) {
                await handleQuickTagBulkMode(rawQVal, img);
            } else {
                await handleQuickTagSingleImage(tokens, img);
            }
        } else if (e.key === 'Escape') {
            // Handled here, so the global shortcut doesn't also close the lightbox behind the editor
            e.stopPropagation();
            if (isLightboxTagFlyupOpen()) {
                closeLightboxTagFlyup();
            } else {
                closeGalleryTagFlyup();
            }
            e.target.blur();
        }
    }

    Elements.quickTagInput.addEventListener('input', handleQuickTagInput);
    Elements.quickTagInput.addEventListener('keydown', handleQuickTagKeydown);
    Elements.lightboxTagInput.addEventListener('input', handleQuickTagInput);
    Elements.lightboxTagInput.addEventListener('keydown', handleQuickTagKeydown);
}
