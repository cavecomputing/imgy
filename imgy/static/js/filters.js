/** Filter bar: include/exclude tag filters, file name search, suggestions, and library-wide tag rename/delete. */
import { CONFIG } from './config.js';
import { State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatCount, highlightMatch, nameContains } from './utils.js';
import { isPhoneLayout, setToggleButtonState, showToast } from './ui.js';
import { api } from './api.js';
import { applyFilters, loadData } from './data.js';
import { parseFilterExpressionTokens, pickSuggestion, splitTagTokens, tryTabCompletion } from './tags.js';
import { getLlmActionSummary } from './llm.js';

const DESKTOP_PLACEHOLDER = 'Filter by tag   -exclude   +create   old>new';
const ROW_HEIGHT = 34;

function getFilterModeInfo(rawTerm) {
    if (splitNameSearch(rawTerm)) return { mode: 'name', label: 'Name', detail: 'show files whose name contains this' };
    const token = rawTerm.trimStart().split(/\s+/).pop() || '';
    if (token.includes('>')) return { mode: 'rename', label: 'Rename', detail: 'old>new renames a tag on every file' };
    if (token.startsWith('--')) return { mode: 'delete', label: 'Delete', detail: token.length > 2 ? 'removes this tag from every file' : 'deletes tags that no file uses' };
    if (token.startsWith('-')) return { mode: 'exclude', label: 'Exclude', detail: 'hide files that have this tag' };
    if (token.startsWith('+')) return { mode: 'create', label: 'Create', detail: 'make a new tag without filtering' };
    return { mode: 'include', label: 'Include', detail: 'show files that have this tag' };
}

function appendSuggestionHeader(container, info) {
    const header = document.createElement('div');
    header.className = 'mode-head';
    header.innerHTML = `<span class="mode-label ${info.mode}">${esc(info.label)}</span><small>${esc(info.detail)}</small>`;
    container.appendChild(header);
}

function showSuggestions() {
    Elements.tagSuggestions.classList.remove('hidden');
}

function hideSuggestions() {
    Elements.tagSuggestions.classList.add('hidden');
    State.suggestionIndex = -1;
}

function resetTagSearch({ focus = false, render = true, clearOrphanedOnly = false } = {}) {
    Elements.tagSearch.value = '';
    State.suggestionIndex = -1;
    if (clearOrphanedOnly) State.showOrphanedOnly = false;
    if (focus) Elements.tagSearch.focus();
    if (render) renderSuggestions();
}

function releaseTagSearchConfirmSoon() {
    setTimeout(() => { State.confirmInProgress = false; }, CONFIG.CONFIRM_RESET_MS);
}

function updateFilterPlaceholder() {
    const hasChips = State.activeTags.size > 0 || State.excludeTags.size > 0 || State.nameTerms.size > 0;
    let placeholder = DESKTOP_PLACEHOLDER;
    if (hasChips) placeholder = '';
    else if (isPhoneLayout()) placeholder = State.images.length ? `Filter ${formatCount(State.images.length, 'file')} by tag` : 'Filter by tag';
    Elements.tagSearch.placeholder = placeholder;
}

/** A chip that drops its filter when clicked. A qualifier ('not' or 'name') shows in bold before the text. */
function createFilterChip(text, qualifier, onRemove) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = qualifier === 'name' ? 'chip chip-name' : 'chip';
    chip.title = 'Remove this filter';
    chip.setAttribute('aria-label', `Remove filter ${qualifier ? `${qualifier} ` : ''}${text}`);
    chip.innerHTML = `<span>${qualifier ? `<b>${qualifier}</b> ` : ''}${esc(text)}</span><span class="chip-x" aria-hidden="true"><svg class="i"><use href="#i-x"/></svg></span>`;
    chip.addEventListener('click', onRemove);
    return chip;
}

export function renderFilterBarTags() {
    const container = Elements.activeTagsContainer;
    container.innerHTML = '';
    State.activeTags.forEach(t => container.appendChild(createFilterChip(t, '', () => toggleTagFilter(t))));
    State.excludeTags.forEach(t => container.appendChild(createFilterChip(t, 'not', () => toggleExcludeTag(t))));
    State.nameTerms.forEach(t => container.appendChild(createFilterChip(t, 'name', () => toggleNameTerm(t))));
    if (State.activeTags.size + State.excludeTags.size + State.nameTerms.size >= 2) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'chip chip-clear';
        clear.textContent = 'Clear';
        clear.title = 'Remove every tag and name filter';
        clear.addEventListener('click', () => {
            State.activeTags.clear();
            State.excludeTags.clear();
            State.nameTerms.clear();
            applyFilters();
            renderFilterBarTags();
            Elements.tagSearch.focus();
        });
        container.appendChild(clear);
    }
    // Keep the newest chip in view when the bar is too narrow for all of them
    container.scrollLeft = container.scrollWidth;
    updateFilterPlaceholder();
}

function leaveUntaggedFilter() {
    if (!State.showUntaggedOnly) return;
    State.showUntaggedOnly = false;
    setToggleButtonState(Elements.untaggedFilterBtn, false);
}

export function toggleTagFilter(t) {
    leaveUntaggedFilter();
    State.activeTags.has(t) ? State.activeTags.delete(t) : State.activeTags.add(t);
    applyFilters(); renderFilterBarTags();
}

function toggleExcludeTag(t) {
    leaveUntaggedFilter();
    State.excludeTags.has(t) ? State.excludeTags.delete(t) : State.excludeTags.add(t);
    applyFilters(); renderFilterBarTags();
}

function toggleNameTerm(t) {
    State.nameTerms.has(t) ? State.nameTerms.delete(t) : State.nameTerms.add(t);
    applyFilters(); renderFilterBarTags();
}

/** Drop the filter whose chip is last in the bar. Returns false when there is none. */
export function removeLastFilter() {
    const names = [...State.nameTerms];
    const excludes = [...State.excludeTags];
    const tags = [...State.activeTags];
    if (names.length) toggleNameTerm(names.at(-1));
    else if (excludes.length) toggleExcludeTag(excludes.at(-1));
    else if (tags.length) toggleTagFilter(tags.at(-1));
    else return false;
    return true;
}

/** Move include and exclude filters on a renamed tag over to its new name. */
function renameTagInFilters(oldName, newName) {
    if (State.activeTags.delete(oldName)) {
        State.excludeTags.delete(newName);
        State.activeTags.add(newName);
    }
    if (State.excludeTags.delete(oldName)) {
        State.activeTags.delete(newName);
        State.excludeTags.add(newName);
    }
}

async function renameTagGlobally(tag) {
    State.confirmInProgress = true;
    const newName = prompt(`Rename "${tag}" on every file to:`, tag);
    if (!newName || newName.trim().toLowerCase() === tag) {
        resetTagSearch({ focus: true, render: true });
        releaseTagSearchConfirmSoon();
        return;
    }
    // Keep confirmInProgress true through the entire async flow to prevent blur from hiding suggestions
    try {
        await api.post('/api/tags/rename', { old_tag: tag, new_tag: newName });
        renameTagInFilters(tag, newName.trim().toLowerCase());
        resetTagSearch({ render: false });
        await loadData();
        showToast(`Renamed "${tag}" to "${newName.trim().toLowerCase()}"`);
    } finally {
        resetTagSearch({ focus: true, render: true });
        releaseTagSearchConfirmSoon();
    }
}

async function deleteTagGlobally(tag) {
    State.confirmInProgress = true;
    const confirmed = confirm(`Remove "${tag}" from every file? This cannot be undone.`);
    if (!confirmed) {
        resetTagSearch({ focus: true, render: true });
        releaseTagSearchConfirmSoon();
        return;
    }
    // Keep confirmInProgress true through the entire async flow to prevent blur from hiding suggestions
    try {
        await api.delete(`/api/tags/remove-all?tag=${encodeURIComponent(tag)}`);
        State.activeTags.delete(tag);
        State.excludeTags.delete(tag);
        resetTagSearch({ render: false });
        await loadData();
        showToast(`Deleted "${tag}"`);
    } finally {
        resetTagSearch({ focus: true, render: true });
        releaseTagSearchConfirmSoon();
    }
}

/** Tags that start with the term come first, then tags that only contain it; each part by use. */
function orderCandidates(tags, term) {
    const byUse = (a, b) => (State.tagCounts[b] || 0) - (State.tagCounts[a] || 0) || a.localeCompare(b);
    if (!term) return { ordered: [...tags].sort(byUse), dividerAt: -1 };
    const prefix = [];
    const rest = [];
    for (const t of tags) (t.toLowerCase().startsWith(term) ? prefix : rest).push(t);
    prefix.sort(byUse);
    rest.sort(byUse);
    return { ordered: [...prefix, ...rest], dividerAt: prefix.length && rest.length ? prefix.length : -1 };
}

function parseLastToken(rawTerm) {
    const lastToken = rawTerm.trimStart().split(/\s+/).pop() || '';
    const isGlobalDelete = lastToken.startsWith('--');
    const isExcludeMode = !isGlobalDelete && lastToken.startsWith('-');
    const isCreateMode = lastToken.startsWith('+');
    const prefix = isGlobalDelete ? '--' : isExcludeMode ? '-' : isCreateMode ? '+' : '';
    return { lastToken, prefix, isGlobalDelete, isExcludeMode, isCreateMode, term: lastToken.slice(prefix.length).toLowerCase().trim() };
}

/**
 * An '@' that starts a word begins a file name search, which runs to the end of the input so it
 * can hold spaces. Returns the expression before it and the search, or null when there is none.
 */
function splitNameSearch(rawTerm) {
    const at = rawTerm.search(/(?:^|\s)@/);
    if (at === -1) return null;
    return { before: rawTerm.slice(0, at), term: rawTerm.slice(rawTerm.indexOf('@', at) + 1).trim().toLowerCase() };
}

function noteRow(html, warn = false) {
    const note = document.createElement('div');
    note.className = `suggestion-note${warn ? ' warn' : ''}`;
    note.innerHTML = html;
    return note;
}

function renderSuggestions() {
    const list = Elements.tagSuggestionList;
    const rawTerm = Elements.tagSearch.value;
    const modeInfo = getFilterModeInfo(rawTerm);
    const { term, isGlobalDelete, isExcludeMode, isCreateMode } = parseLastToken(rawTerm);

    const isOrphaned = t => !(State.tagCounts[t] > 0);
    const orphanedTags = State.allTags.filter(isOrphaned);
    list.innerHTML = '';

    // '?' auto-tags files, which the filter can't do
    if (rawTerm.trim() === '?') {
        appendSuggestionHeader(list, { mode: 'llm', label: 'Auto-tag', detail: 'works on files, not on the filter' });
        const llm = getLlmActionSummary();
        list.appendChild(noteRow(`<span>Select files, then type <code>?</code> in the tag editor to ${esc(llm.action)} them.</span><span class="tag-count-badge">${esc(llm.model)}</span>`));
        State.suggestionMatches = [];
        showSuggestions();
        return;
    }

    // '--' deletes every tag that no file uses
    if (rawTerm.trim() === '--') {
        appendSuggestionHeader(list, modeInfo);
        if (!orphanedTags.length) {
            list.appendChild(noteRow('<span>No unused tags. Every tag is on at least one file.</span>'));
        } else {
            list.appendChild(noteRow(`<span>Enter deletes ${formatCount(orphanedTags.length, 'unused tag')} from the database.</span>`, true));
            for (const t of orphanedTags) {
                const item = document.createElement('div');
                item.className = 'suggestion-item delete-mode';
                item.innerHTML = `<span class="suggestion-label">${esc(t)}</span><span class="tag-count-badge orphaned">0</span>`;
                list.appendChild(item);
            }
        }
        State.suggestionMatches = [];
        showSuggestions();
        return;
    }

    // '@text' filters by file name, so there are no tags to suggest
    const nameSearch = splitNameSearch(rawTerm);
    if (nameSearch) {
        const count = State.filteredImages.filter(img => nameContains(img.filename, nameSearch.term)).length;
        appendSuggestionHeader(list, modeInfo);
        list.appendChild(noteRow(nameSearch.term
            ? `<span>${formatCount(count, 'file')} here ${count === 1 ? 'has' : 'have'} “${esc(nameSearch.term)}” in the name.</span>`
            : '<span>Type part of a file name, spaces and all, like <code>@beach house</code> or <code>@.mp4</code>.</span>'));
        State.suggestionMatches = [];
        showSuggestions();
        return;
    }

    let candidates = State.allTags.filter(t => (!term || t.toLowerCase().includes(term)) && !State.activeTags.has(t) && !State.excludeTags.has(t));
    if (State.showOrphanedOnly) candidates = candidates.filter(isOrphaned);
    const { ordered, dividerAt } = orderCandidates(candidates, term);

    State.suggestionMatches = ordered;
    if (State.suggestionIndex >= ordered.length) State.suggestionIndex = ordered.length - 1;

    const canCreate = isCreateMode && term && !State.allTags.some(t => t.toLowerCase() === term);
    if (!ordered.length && !orphanedTags.length && !canCreate) {
        State.suggestionIndex = -1;
        if (!term && !State.showOrphanedOnly) { hideSuggestions(); return; }
        appendSuggestionHeader(list, modeInfo);
        const hint = !isCreateMode && !isGlobalDelete && term ? ` Type <code>+${esc(term)}</code> to create it.` : '';
        list.insertAdjacentHTML('beforeend', `<div class="no-results">No tag matches “${esc(term)}”.${hint}</div>`);
        showSuggestions();
        return;
    }

    appendSuggestionHeader(list, modeInfo);
    if (orphanedTags.length > 0) {
        const footer = document.createElement('div');
        footer.className = 'suggestions-footer';
        footer.innerHTML = `<span>${formatCount(orphanedTags.length, 'unused tag')}</span><button type="button">${State.showOrphanedOnly ? 'Show all' : 'Show only those'}</button>`;
        footer.querySelector('button').addEventListener('click', () => {
            State.showOrphanedOnly = !State.showOrphanedOnly;
            State.suggestionIndex = -1;
            renderSuggestions();
        });
        list.appendChild(footer);
    }

    const modeClass = isGlobalDelete ? ' delete-mode' : isExcludeMode ? ' exclude-mode' : '';
    ordered.forEach((t, idx) => {
        if (idx === dividerAt) {
            const divider = document.createElement('div');
            divider.className = 'suggestion-divider';
            list.appendChild(divider);
        }
        const item = document.createElement('div');
        item.className = `suggestion-item${idx === State.suggestionIndex ? ' active' : ''}${modeClass}`;
        item.setAttribute('role', 'option');
        const count = State.tagCounts[t] || 0;
        item.innerHTML = `
            <span class="suggestion-label">${highlightMatch(t, term)}</span>
            <span class="suggestion-tools">
                <button class="suggestion-rename" type="button" title="Rename everywhere" aria-label="Rename tag ${esc(t)} everywhere"><svg class="i i-xs" aria-hidden="true"><use href="#i-pencil"/></svg></button>
                <button class="suggestion-delete" type="button" title="Delete everywhere (Del)" aria-label="Delete tag ${esc(t)} everywhere"><svg class="i i-xs" aria-hidden="true"><use href="#i-x"/></svg></button>
            </span>
            <span class="tag-count-badge${count === 0 ? ' orphaned' : ''}" title="${formatCount(count, 'file')}">${count}</span>
        `;
        item.addEventListener('click', (e) => {
            if (!e.target.closest('.suggestion-tools')) chooseSuggestion(t);
        });
        item.querySelector('.suggestion-rename').addEventListener('click', () => renameTagGlobally(t));
        item.querySelector('.suggestion-delete').addEventListener('click', () => deleteTagGlobally(t));
        list.appendChild(item);
    });

    if (canCreate) {
        const createItem = document.createElement('div');
        createItem.className = 'suggestion-item create-mode';
        createItem.innerHTML = `<span class="suggestion-label">Create “${esc(term)}”</span><span class="tag-count-badge">new</span>`;
        createItem.addEventListener('click', async () => {
            await api.post('/api/tags/create', { tag: term });
            showToast(`Created tag "${term}"`);
            resetTagSearch({ render: false });
            await loadData();
            resetTagSearch({ focus: true });
        });
        list.appendChild(createItem);
    }

    // Keep the highlighted row in view inside the list (the list is its offsetParent)
    const activeItem = list.querySelector('.suggestion-item.active');
    if (activeItem) {
        const itemTop = activeItem.offsetTop;
        const itemBottom = itemTop + activeItem.offsetHeight;
        if (itemBottom > list.scrollTop + list.clientHeight) list.scrollTop = itemBottom - list.clientHeight;
        else if (itemTop < list.scrollTop) list.scrollTop = itemTop;
    } else if (State.suggestionIndex < 0) {
        list.scrollTop = 0;
    }

    showSuggestions();
}

/** What clicking a suggestion does: show the tag's files, hide them after a -, or delete the tag after a --. */
function chooseSuggestion(tag) {
    const { isGlobalDelete, isExcludeMode } = parseLastToken(Elements.tagSearch.value);
    if (isGlobalDelete) {
        deleteTagGlobally(tag);
        return;
    }
    if (isExcludeMode) toggleExcludeTag(tag);
    else toggleTagFilter(tag);
    resetTagSearch({ clearOrphanedOnly: true });
}

/** Put a suggestion in place of the token being typed, keeping its - / -- / + prefix. */
function replaceLastToken(tag, { trailingSpace = false } = {}) {
    const toks = Elements.tagSearch.value.trimStart().split(/\s+/);
    toks[toks.length - 1] = parseLastToken(Elements.tagSearch.value).prefix + tag;
    Elements.tagSearch.value = toks.join(' ') + (trailingSpace ? ' ' : '');
}

/** The suggestion Enter takes for a tag to show or hide that is typed in part (never one to create or delete). */
function enterPick() {
    const { lastToken, isGlobalDelete, isCreateMode, term } = parseLastToken(Elements.tagSearch.value);
    if (isGlobalDelete || isCreateMode || lastToken.includes('>')) return null;
    return pickSuggestion(term, State.suggestionMatches);
}

async function applyFilterExpression() {
    let rawTerm = Elements.tagSearch.value;

    const nameSearch = splitNameSearch(rawTerm);
    if (nameSearch) {
        if (nameSearch.term) toggleNameTerm(nameSearch.term);
        rawTerm = nameSearch.before;
        if (!rawTerm.trim()) { resetTagSearch(); return; }
    }

    if (rawTerm.trim() === '?') { showToast('Select files, then type ? in the tag editor to auto-tag them'); resetTagSearch(); return; }

    if (rawTerm.trim() === '--') {
        const orphaned = State.allTags.filter(t => !(State.tagCounts[t] > 0));
        if (orphaned.length === 0) { showToast('No unused tags to delete'); resetTagSearch(); return; }
        State.confirmInProgress = true;
        const confirmed = confirm(`Delete ${formatCount(orphaned.length, 'unused tag')} from the database? This cannot be undone.`);
        if (confirmed) {
            for (const tag of orphaned) {
                await api.delete(`/api/tags/remove-all?tag=${encodeURIComponent(tag)}`);
                State.activeTags.delete(tag);
            }
            resetTagSearch({ render: false });
            await loadData();
            showToast(`Deleted ${formatCount(orphaned.length, 'unused tag')}`);
        }
        resetTagSearch({ focus: true, render: true });
        releaseTagSearchConfirmSoon();
        return;
    }

    if (/\s/.test(rawTerm.trim())) {
        const fTokens = splitTagTokens(rawTerm, /\s+/);
        if (fTokens.includes('=')) { showToast('"=" only works in the bulk tag editor'); resetTagSearch(); return; }
        if (fTokens.includes('++')) { showToast('"++" only works in the bulk tag editor'); resetTagSearch(); return; }
        const { toDelete, toFilter, toExclude, toRename, toCreate } = parseFilterExpressionTokens(fTokens);
        if (toDelete.length > 0) {
            State.confirmInProgress = true;
            const confirmed = confirm(`Remove ${toDelete.map(t => `"${t}"`).join(', ')} from every file? This cannot be undone.`);
            if (confirmed) {
                State.confirmInProgress = false;
                for (const tag of toDelete) {
                    await api.delete(`/api/tags/remove-all?tag=${encodeURIComponent(tag)}`);
                    State.activeTags.delete(tag);
                    State.excludeTags.delete(tag);
                }
            } else {
                releaseTagSearchConfirmSoon();
            }
        }
        for (const { oldN, newN } of toRename) {
            await api.post('/api/tags/rename', { old_tag: oldN, new_tag: newN });
            renameTagInFilters(oldN, newN);
        }
        for (const tag of toCreate) {
            await api.post('/api/tags/create', { tag });
        }
        if (toCreate.length) showToast(`Created ${formatCount(toCreate.length, 'tag')}`);
        for (const tag of toExclude) toggleExcludeTag(tag);
        for (const tag of toFilter) toggleTagFilter(tag);
        resetTagSearch({ render: false });
        if (toDelete.length > 0 || toRename.length > 0 || toCreate.length > 0) await loadData();
        resetTagSearch({ focus: true, render: true });
        return;
    }

    const term = rawTerm.trim();
    if (term === '=') { showToast('"=" only works in the bulk tag editor'); resetTagSearch(); return; }
    if (term === '++') { showToast('"++" only works in the bulk tag editor'); resetTagSearch(); return; }
    if (term.includes('>')) {
        const [oldN, newN] = term.split('>').map(s => s.trim().toLowerCase());
        if (oldN && newN) {
            await api.post('/api/tags/rename', { old_tag: oldN, new_tag: newN });
            renameTagInFilters(oldN, newN);
            resetTagSearch({ render: false });
            await loadData();
            showToast(`Renamed "${oldN}" to "${newN}"`);
            resetTagSearch({ focus: true, render: true });
        } else { showToast('Rename syntax: oldname>newname'); }
        return;
    }
    const { isGlobalDelete, isExcludeMode, isCreateMode, term: searchTerm } = parseLastToken(term);

    if (isCreateMode && searchTerm) {
        if (State.allTags.find(t => t.toLowerCase() === searchTerm)) {
            showToast(`Tag "${searchTerm}" already exists`);
        } else {
            const result = await api.post('/api/tags/create', { tag: searchTerm });
            if (result.success) {
                showToast(`Created tag "${searchTerm}"`);
                await loadData();
            }
        }
        resetTagSearch({ focus: true });
        return;
    }

    const tag = searchTerm ? State.allTags.find(t => t.toLowerCase() === searchTerm) || null : null;
    if (!tag) {
        if (searchTerm) showToast(`No tag named "${searchTerm}"`);
        return;
    }
    if (isGlobalDelete) {
        deleteTagGlobally(tag);
    } else if (isExcludeMode) {
        toggleExcludeTag(tag);
        resetTagSearch();
    } else {
        toggleTagFilter(tag);
        resetTagSearch();
    }
}

/**
 * On phones the filter bar sits at the bottom of the screen. Browsers that overlay the
 * on-screen keyboard instead of resizing the page would hide it, so lift it by the
 * keyboard's height.
 */
function trackKeyboardInset() {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
        // iOS reports a negative offsetTop while the page is pulled down past the top (pull to
        // refresh), which would read as a keyboard that many pixels tall
        const inset = Math.max(0, window.innerHeight - vv.height - Math.max(0, vv.offsetTop));
        document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
}

export function initFilters() {
    setToggleButtonState(Elements.favoriteFilterBtn, false);
    setToggleButtonState(Elements.untaggedFilterBtn, false);
    updateFilterPlaceholder();
    window.matchMedia('(max-width: 768px)').addEventListener('change', updateFilterPlaceholder);
    trackKeyboardInset();

    Elements.favoriteFilterBtn.addEventListener('click', () => {
        State.showFavoritesOnly = !State.showFavoritesOnly;
        setToggleButtonState(Elements.favoriteFilterBtn, State.showFavoritesOnly);
        applyFilters();
    });
    Elements.untaggedFilterBtn.addEventListener('click', () => {
        State.showUntaggedOnly = !State.showUntaggedOnly;
        setToggleButtonState(Elements.untaggedFilterBtn, State.showUntaggedOnly);
        if (State.showUntaggedOnly) { State.activeTags.clear(); State.excludeTags.clear(); }
        applyFilters(); renderFilterBarTags();
    });

    // Clicking the bar around the chips focuses the input
    document.getElementById('filterBar').addEventListener('mousedown', (e) => {
        if (e.target.closest('button, input, .pop')) return;
        e.preventDefault();
        Elements.tagSearch.focus();
    });

    let suggestDebounceTimer = null;
    Elements.tagSearch.addEventListener('input', () => {
        State.suggestionIndex = -1;
        State.showOrphanedOnly = false;
        clearTimeout(suggestDebounceTimer);
        suggestDebounceTimer = setTimeout(renderSuggestions, CONFIG.SUGGEST_DEBOUNCE_MS);
    });
    Elements.tagSearch.addEventListener('focus', renderSuggestions);
    // Keep clicks inside the suggestions from blurring the search input
    Elements.tagSuggestions.addEventListener('mousedown', (e) => e.preventDefault());
    Elements.tagSearch.addEventListener('blur', () => {
        if (State.confirmInProgress) return;
        setTimeout(() => {
            if (document.activeElement !== Elements.tagSearch) hideSuggestions();
        }, 200);
    });
    Elements.tagSearch.addEventListener('keydown', async (e) => {
        const matches = State.suggestionMatches;
        const suggestionsVisible = !Elements.tagSuggestions.classList.contains('hidden') && matches.length > 0;
        const pageSize = () => Math.max(1, Math.floor(Elements.tagSuggestionList.clientHeight / ROW_HEIGHT));
        const from = () => (State.suggestionIndex < 0 ? 0 : State.suggestionIndex);

        if (e.key === 'ArrowDown' && suggestionsVisible) {
            e.preventDefault();
            State.suggestionIndex = (State.suggestionIndex + 1) % matches.length;
            renderSuggestions();
        } else if (e.key === 'ArrowUp' && suggestionsVisible) {
            e.preventDefault();
            State.suggestionIndex = (State.suggestionIndex - 1 + matches.length) % matches.length;
            renderSuggestions();
        } else if (e.key === 'PageDown' && suggestionsVisible) {
            e.preventDefault();
            State.suggestionIndex = Math.min(from() + pageSize(), matches.length - 1);
            renderSuggestions();
        } else if (e.key === 'PageUp' && suggestionsVisible) {
            e.preventDefault();
            State.suggestionIndex = Math.max(from() - pageSize(), 0);
            renderSuggestions();
        } else if (e.key === 'Home' && suggestionsVisible) {
            e.preventDefault();
            State.suggestionIndex = 0;
            renderSuggestions();
        } else if (e.key === 'End' && suggestionsVisible) {
            e.preventDefault();
            State.suggestionIndex = matches.length - 1;
            renderSuggestions();
        } else if (e.key === 'Tab') {
            if (!Elements.tagSearch.value.trim()) return; // let Tab move focus as usual
            e.preventDefault();
            const highlighted = suggestionsVisible && State.suggestionIndex > -1 ? matches[State.suggestionIndex] : null;
            if (highlighted) {
                replaceLastToken(highlighted, { trailingSpace: true });
                State.suggestionIndex = -1;
                renderSuggestions();
                return;
            }
            tryTabCompletion(Elements.tagSearch.value, matches, {
                prefixChars: ['--', '-', '+'],
                setValue: v => { Elements.tagSearch.value = v; },
                onComplete: () => { State.suggestionIndex = -1; renderSuggestions(); }
            });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            // Match what is typed now, not what was typed when the suggestions were last drawn
            clearTimeout(suggestDebounceTimer);
            renderSuggestions();
            // A highlighted suggestion stands in for the token being typed, and so does the one a
            // tag typed in part picks: a phone has no Tab or arrow keys to choose it with
            const pick = State.suggestionIndex > -1 ? State.suggestionMatches[State.suggestionIndex] : enterPick();
            // On its own it does what clicking it does, which keeps a tag with spaces in it whole
            if (pick && !/\s/.test(Elements.tagSearch.value.trim())) { chooseSuggestion(pick); return; }
            if (pick) replaceLastToken(pick);
            await applyFilterExpression();
        } else if (e.key === 'Delete' && suggestionsVisible) {
            e.preventDefault();
            const tag = State.suggestionIndex > -1 ? matches[State.suggestionIndex] : matches[0];
            if (tag) deleteTagGlobally(tag);
        } else if (e.key === 'Escape') {
            hideSuggestions();
            State.showOrphanedOnly = false;
        } else if (e.key === 'Backspace' && !Elements.tagSearch.value) {
            removeLastFilter();
        }
    });
}
