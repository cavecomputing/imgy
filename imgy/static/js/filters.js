/** Search bar: include/exclude tag filters, suggestions, and library-wide tag rename/delete. */
import { CONFIG } from './config.js';
import { State } from './state.js';
import { Elements } from './dom.js';
import { esc, formatCount } from './utils.js';
import { setToggleButtonState, showToast } from './ui.js';
import { api } from './api.js';
import { applyFilters, loadData } from './data.js';
import { parseFilterExpressionTokens, splitTagTokens, tryTabCompletion } from './tags.js';
import { getLlmActionSummary } from './llm.js';

function getFilterModeInfo(rawTerm) {
    const token = rawTerm.trimStart().split(/\s+/).pop() || '';
    if (token.includes('>')) return { mode: 'rename', detail: 'old>new renames a tag everywhere' };
    if (token.startsWith('--')) return { mode: 'delete', detail: token.length > 2 ? 'remove this tag from all files' : 'remove unused tags' };
    if (token.startsWith('-')) return { mode: 'exclude', detail: 'hide files with this tag' };
    if (token.startsWith('+')) return { mode: 'create', detail: 'create a tag without filtering' };
    return { mode: 'include', detail: 'show files that have this tag' };
}

function appendSuggestionHeader(container, info) {
    const header = document.createElement('div');
    header.className = `suggestions-mode-header ${info.mode}`;
    header.innerHTML = `<span>${esc(info.mode)}</span><small>${esc(info.detail)}</small>`;
    container.appendChild(header);
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

export function renderFilterBarTags() {
    Elements.activeTagsContainer.innerHTML = '';
    const hasFilters = State.activeTags.size > 0 || State.excludeTags.size > 0;
    State.activeTags.forEach(t => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'tag active filter-chip';
        el.title = `Remove include filter "${t}"`;
        el.innerHTML = `<span>${esc(t)}</span><span class="remove-tag" aria-hidden="true">&times;</span>`;
        el.onclick = () => toggleTagFilter(t);
        Elements.activeTagsContainer.appendChild(el);
    });
    State.excludeTags.forEach(t => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'tag exclude filter-chip';
        el.title = `Remove exclude filter "${t}"`;
        el.innerHTML = `<span>not ${esc(t)}</span><span class="remove-tag" aria-hidden="true">&times;</span>`;
        el.onclick = () => toggleExcludeTag(t);
        Elements.activeTagsContainer.appendChild(el);
    });
    if (hasFilters) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'tag clear-filter-chip';
        clear.innerHTML = 'clear filters <span class="remove-tag" aria-hidden="true">&times;</span>';
        clear.onclick = () => {
            State.activeTags.clear();
            State.excludeTags.clear();
            applyFilters();
            renderFilterBarTags();
            Elements.tagSearch.focus();
        };
        Elements.activeTagsContainer.appendChild(clear);
    }
}

export function toggleTagFilter(t) {
    if (State.showUntaggedOnly) {
        State.showUntaggedOnly = false;
        setToggleButtonState(Elements.untaggedFilterBtn, false, 'Filter untagged');
    }
    State.activeTags.has(t) ? State.activeTags.delete(t) : State.activeTags.add(t);
    applyFilters(); renderFilterBarTags();
}

export function toggleExcludeTag(t) {
    if (State.showUntaggedOnly) {
        State.showUntaggedOnly = false;
        setToggleButtonState(Elements.untaggedFilterBtn, false, 'Filter untagged');
    }
    State.excludeTags.has(t) ? State.excludeTags.delete(t) : State.excludeTags.add(t);
    applyFilters(); renderFilterBarTags();
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
    const newName = prompt(`Rename "${tag}" to:`, tag);
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
        showToast(`Renamed "${tag}" → "${newName.trim().toLowerCase()}"`);
    } finally {
        resetTagSearch({ focus: true, render: true });
        releaseTagSearchConfirmSoon();
    }
}

async function deleteTagGlobally(tag) {
    State.confirmInProgress = true;
    const confirmed = confirm(`Remove "${tag}" from all images? This cannot be undone.`);
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
    } finally {
        resetTagSearch({ focus: true, render: true });
        releaseTagSearchConfirmSoon();
    }
}

function renderSuggestions() {
    const rawTerm = Elements.tagSearch.value;
    const modeInfo = getFilterModeInfo(rawTerm);
    // For multi-token expressions, look at the last token for suggestions
    const lastToken = rawTerm.trimStart().split(/\s+/).pop() || '';
    const isGlobalDelete = lastToken.startsWith('--');
    const isExcludeMode = !isGlobalDelete && lastToken.startsWith('-');
    const isCreateMode = lastToken.startsWith('+');
    const term = (isGlobalDelete ? lastToken.slice(2) : isExcludeMode ? lastToken.slice(1) : isCreateMode ? lastToken.slice(1) : lastToken).toLowerCase().trim();

    const isOrphaned = t => !(State.tagCounts[t] > 0);
    const orphanedTags = State.allTags.filter(isOrphaned);

    // Show hint for '?' LLM analyze
    if (rawTerm.trim() === '?') {
        Elements.tagSuggestions.innerHTML = '';
        appendSuggestionHeader(Elements.tagSuggestions, modeInfo);
        const hint = document.createElement('div');
        hint.className = 'quick-tag-suggestion clear-all-hint';
        const llm = getLlmActionSummary();
        hint.innerHTML = `<span>LLM ${esc(llm.action)} — select images first, then use ? in the tag flyup</span><span class="tag-count-badge">${esc(llm.model)}</span>`;
        hint.onmousedown = (e) => e.preventDefault();
        Elements.tagSuggestions.appendChild(hint);
        Elements.tagSuggestions.classList.remove('hidden');
        State.suggestionMatches = [];
        return;
    }

    // Show warning hint for '--' remove unused tags
    if (rawTerm.trim() === '--') {
        Elements.tagSuggestions.innerHTML = '';
        appendSuggestionHeader(Elements.tagSuggestions, modeInfo);
        const hint = document.createElement('div');
        hint.className = 'quick-tag-suggestion delete-mode clear-all-hint';
        hint.innerHTML = `<span>Remove ${formatCount(orphanedTags.length, 'unused tag')} from the database</span>`;
        hint.onmousedown = (e) => e.preventDefault();
        Elements.tagSuggestions.appendChild(hint);
        for (const t of orphanedTags) {
            const item = document.createElement('div');
            item.className = 'suggestion-item delete-mode';
            item.innerHTML = `<span class="suggestion-label">${esc(t)}</span>`;
            item.onmousedown = (e) => e.preventDefault();
            Elements.tagSuggestions.appendChild(item);
        }
        Elements.tagSuggestions.classList.remove('hidden');
        State.suggestionMatches = [];
        return;
    }

    let candidates = State.allTags.filter(t => (!term || t.toLowerCase().includes(term)) && !State.activeTags.has(t) && !State.excludeTags.has(t));
    if (State.showOrphanedOnly) candidates = candidates.filter(isOrphaned);

    State.suggestionMatches = candidates;
    if (State.suggestionIndex >= candidates.length) State.suggestionIndex = candidates.length - 1;

    Elements.tagSuggestions.innerHTML = '';
    if (candidates.length || orphanedTags.length || (isCreateMode && term)) {
        appendSuggestionHeader(Elements.tagSuggestions, modeInfo);
        // Header: orphaned tags count / toggle (rendered first so it appears at top)
        if (orphanedTags.length > 0) {
            const footer = document.createElement('div');
            footer.className = 'suggestions-footer';
            if (State.showOrphanedOnly) {
                footer.innerHTML = `<span>${formatCount(orphanedTags.length, 'unused tag')}</span><button>Show all</button>`;
            } else {
                footer.innerHTML = `<span>${formatCount(orphanedTags.length, 'unused tag')}</span><button>Show only</button>`;
            }
            const btn = footer.querySelector('button');
            // mousedown prevention keeps the search input focused
            btn.addEventListener('mousedown', (e) => e.preventDefault());
            btn.addEventListener('click', () => {
                State.showOrphanedOnly = !State.showOrphanedOnly;
                renderSuggestions();
            });
            Elements.tagSuggestions.appendChild(footer);
        }

        candidates.forEach((t, idx) => {
            const item = document.createElement('div');
            const modeClass = isGlobalDelete ? 'delete-mode' : isExcludeMode ? 'exclude-mode' : '';
            item.className = `suggestion-item ${idx === State.suggestionIndex ? 'active' : ''} ${modeClass}`;
            const count = State.tagCounts[t] || 0;
            const badgeClass = count === 0 ? 'tag-count-badge orphaned' : 'tag-count-badge';
            item.innerHTML = `<span class="suggestion-label">${esc(t)}</span><button class="suggestion-rename">✎</button><button class="suggestion-delete">&times;</button><span class="${badgeClass}">${count}</span>`;
            item.addEventListener('click', (e) => {
                if (e.target.closest('.suggestion-delete') || e.target.closest('.suggestion-rename')) return;
                if (isGlobalDelete) {
                    deleteTagGlobally(t);
                } else if (isExcludeMode) {
                    toggleExcludeTag(t);
                } else {
                    toggleTagFilter(t);
                }
                resetTagSearch({ clearOrphanedOnly: true });
            });
            item.querySelector('.suggestion-rename').addEventListener('click', (e) => {
                e.stopPropagation();
                renameTagGlobally(t);
            });
            item.querySelector('.suggestion-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                deleteTagGlobally(t);
            });
            Elements.tagSuggestions.appendChild(item);
        });

        if (isCreateMode && term && !State.allTags.find(t => t.toLowerCase() === term)) {
            const createItem = document.createElement('div');
            createItem.className = 'suggestion-item create-mode';
            createItem.innerHTML = `<span class="suggestion-label">Create "${esc(term)}"</span><span class="tag-count-badge">new</span>`;
            createItem.addEventListener('click', async () => {
                await api.post('/api/tags/create', { tag: term });
                showToast(`Created tag "${term}"`);
                resetTagSearch({ render: false });
                await loadData();
                resetTagSearch({ focus: true });
            });
            Elements.tagSuggestions.appendChild(createItem);
        }

        // Scroll active item into view within the container
        if (State.suggestionIndex > -1) {
            const activeItem = Elements.tagSuggestions.querySelector('.suggestion-item.active');
            if (activeItem) {
                const c = Elements.tagSuggestions;
                const itemTop = activeItem.offsetTop;
                const itemBottom = itemTop + activeItem.offsetHeight;
                if (itemBottom > c.scrollTop + c.clientHeight) {
                    c.scrollTop = itemBottom - c.clientHeight;
                } else if (itemTop < c.scrollTop) {
                    c.scrollTop = itemTop;
                }
            }
        }

        Elements.tagSuggestions.classList.remove('hidden');
    } else {
        Elements.tagSuggestions.classList.toggle('hidden', !term && !State.showOrphanedOnly);
        if (term) {
            appendSuggestionHeader(Elements.tagSuggestions, modeInfo);
            Elements.tagSuggestions.insertAdjacentHTML('beforeend', '<div class="no-results">No results</div>');
        }
        State.suggestionIndex = -1;
    }
}

export function initFilters() {
    setToggleButtonState(Elements.favoriteFilterBtn, false, 'Filter favorites');
    setToggleButtonState(Elements.untaggedFilterBtn, false, 'Filter untagged');

    Elements.favoriteFilterBtn.addEventListener('click', () => {
        State.showFavoritesOnly = !State.showFavoritesOnly;
        setToggleButtonState(
            Elements.favoriteFilterBtn,
            State.showFavoritesOnly,
            State.showFavoritesOnly ? 'Show all files' : 'Filter favorites'
        );
        applyFilters();
    });
    Elements.untaggedFilterBtn.addEventListener('click', () => {
        State.showUntaggedOnly = !State.showUntaggedOnly;
        setToggleButtonState(
            Elements.untaggedFilterBtn,
            State.showUntaggedOnly,
            State.showUntaggedOnly ? 'Show tagged and untagged' : 'Filter untagged'
        );
        if (State.showUntaggedOnly) { State.activeTags.clear(); State.excludeTags.clear(); }
        applyFilters(); renderFilterBarTags();
    });
    let suggestDebounceTimer = null;
    Elements.tagSearch.addEventListener('input', () => {
        State.suggestionIndex = -1;
        State.showOrphanedOnly = false;
        clearTimeout(suggestDebounceTimer);
        suggestDebounceTimer = setTimeout(renderSuggestions, CONFIG.SUGGEST_DEBOUNCE_MS);
    });
    Elements.tagSearch.addEventListener('focus', renderSuggestions);
    // Prevent any click inside the suggestions from blurring the search input
    Elements.tagSuggestions.addEventListener('mousedown', (e) => e.preventDefault());
    Elements.tagSearch.addEventListener('blur', () => {
        if (State.confirmInProgress) return;
        setTimeout(() => {
            Elements.tagSuggestions.classList.add('hidden');
            State.suggestionIndex = -1;
        }, 200);
    });
    Elements.tagSearch.addEventListener('keydown', async (e) => {
        const matches = State.suggestionMatches;
        const suggestionsVisible = !Elements.tagSuggestions.classList.contains('hidden') && matches.length > 0;

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
            const pageSize = Math.max(1, Math.floor(Elements.tagSuggestions.clientHeight / 38));
            State.suggestionIndex = Math.min((State.suggestionIndex < 0 ? 0 : State.suggestionIndex) + pageSize, matches.length - 1);
            renderSuggestions();
        } else if (e.key === 'PageUp' && suggestionsVisible) {
            e.preventDefault();
            const pageSize = Math.max(1, Math.floor(Elements.tagSuggestions.clientHeight / 38));
            State.suggestionIndex = Math.max((State.suggestionIndex < 0 ? 0 : State.suggestionIndex) - pageSize, 0);
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
            e.preventDefault();
            tryTabCompletion(Elements.tagSearch.value, matches, {
                prefixChars: ['--', '-', '+'],
                setValue: v => { Elements.tagSearch.value = v; },
                onComplete: () => { State.suggestionIndex = -1; renderSuggestions(); }
            });
            return;
        } else if (e.key === 'Enter') {
            e.preventDefault();
            let rawTerm = Elements.tagSearch.value;

            if (rawTerm.trim() === '?') { showToast('"?" LLM analyze is available in the tag flyup (select images first)'); Elements.tagSearch.value = ''; renderSuggestions(); return; }

            if (rawTerm.trim() === '--') {
                const orphaned = State.allTags.filter(t => !(State.tagCounts[t] > 0));
                if (orphaned.length === 0) { showToast('No unused tags to remove'); resetTagSearch(); return; }
                State.confirmInProgress = true;
                const confirmed = confirm(`Remove ${formatCount(orphaned.length, 'unused tag')} from the database? This cannot be undone.`);
                if (confirmed) {
                    for (const tag of orphaned) {
                        await api.delete(`/api/tags/remove-all?tag=${encodeURIComponent(tag)}`);
                        State.activeTags.delete(tag);
                    }
                    resetTagSearch({ render: false });
                    await loadData();
                }
                resetTagSearch({ focus: true, render: true });
                releaseTagSearchConfirmSoon();
                return;
            }

            if (/\s/.test(rawTerm)) {
                const fTokens = splitTagTokens(rawTerm, /\s+/);
                if (fTokens.includes('=')) { showToast('"=" is only available in selection mode'); resetTagSearch(); return; }
                if (fTokens.includes('++')) { showToast('"++" is only available in selection mode'); resetTagSearch(); return; }
                const { toDelete, toFilter, toExclude, toRename, toCreate } = parseFilterExpressionTokens(fTokens);
                if (toDelete.length > 0) {
                    State.confirmInProgress = true;
                    const confirmed = confirm(`Remove ${toDelete.map(t => `"${t}"`).join(', ')} from all images? This cannot be undone.`);
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
            if (rawTerm.trim() === '=') { showToast('"=" is only available in selection mode'); resetTagSearch(); return; }
            if (rawTerm.trim() === '++') { showToast('"++" is only available in selection mode'); resetTagSearch(); return; }
            if (rawTerm.includes('>')) {
                const [oldN, newN] = rawTerm.split('>').map(s => s.trim().toLowerCase());
                if (oldN && newN) {
                    await api.post('/api/tags/rename', { old_tag: oldN, new_tag: newN });
                    renameTagInFilters(oldN, newN);
                    resetTagSearch({ render: false });
                    await loadData();
                    resetTagSearch({ focus: true, render: true });
                } else { showToast('Rename syntax: oldname>newname'); }
                return;
            }
            const isGlobalDelete = rawTerm.startsWith('--');
            const isExclude = !isGlobalDelete && rawTerm.startsWith('-');
            const isCreateMode = rawTerm.startsWith('+');
            const searchTerm = (isGlobalDelete ? rawTerm.slice(2) : isExclude || isCreateMode ? rawTerm.slice(1) : rawTerm).trim().toLowerCase();

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

            let tag = null;
            if (searchTerm) {
                tag = State.allTags.find(t => t.toLowerCase() === searchTerm) || null;
            }
            if (tag) {
                if (isGlobalDelete) {
                    deleteTagGlobally(tag);
                } else if (isExclude) {
                    toggleExcludeTag(tag);
                    resetTagSearch();
                } else {
                    toggleTagFilter(tag);
                    resetTagSearch();
                }
            }
        } else if (e.key === 'Delete' && suggestionsVisible) {
            e.preventDefault();
            const tag = State.suggestionIndex > -1 ? matches[State.suggestionIndex] : matches[0];
            if (tag) deleteTagGlobally(tag);
        } else if (e.key === 'Escape') {
            Elements.tagSuggestions.classList.add('hidden');
            State.suggestionIndex = -1;
            State.showOrphanedOnly = false;
        } else if (e.key === 'Backspace' && !Elements.tagSearch.value) {
            const excludes = [...State.excludeTags];
            if (excludes.length) {
                toggleExcludeTag(excludes[excludes.length - 1]);
            } else {
                const tags = [...State.activeTags];
                if (tags.length) {
                    toggleTagFilter(tags[tags.length - 1]);
                }
            }
        }
    });
}
