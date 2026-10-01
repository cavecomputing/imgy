/** Parsing for the tag expression syntax shared by the search bar and the tag flyups. */
import { State } from './state.js';
import { showToast } from './ui.js';

export function splitTagTokens(str, separator = /[\s,]+/) {
    return str.split(separator).map(t => t.trim()).filter(Boolean);
}

export function collectTagMutations(tokens, options = {}) {
    const availableTags = options.availableTags ? new Set(options.availableTags) : null;
    const existingTags = options.existingTags ? new Set(options.existingTags) : null;
    const toAdd = [];
    const toRemove = [];
    const toRename = [];

    for (const token of tokens) {
        if (token.includes('>')) {
            const [oldName, newName] = token.split('>').map(s => s.trim().toLowerCase());
            if (!oldName || !newName) {
                showToast('Rename syntax: oldname>newname');
                continue;
            }
            if (existingTags && !existingTags.has(oldName)) {
                showToast(options.renameMissingMessage?.(oldName) || `"${oldName}" is not available`);
                continue;
            }
            toRename.push({ oldName, newName });
        } else if (token.startsWith('-') && token.length > 1) {
            const tag = token.slice(1).toLowerCase();
            if (existingTags && !existingTags.has(tag)) {
                showToast(options.removeMissingMessage?.(tag) || `"${tag}" is not available`);
                continue;
            }
            toRemove.push(tag);
        } else if (token.startsWith('+') && token.length > 1) {
            toAdd.push(token.slice(1).toLowerCase());
        } else {
            const tag = token.toLowerCase();
            if (availableTags && !availableTags.has(tag)) {
                if (options.showUnavailablePlain !== false) {
                    showToast(options.unavailablePlainMessage?.(tag) || `"${tag}" does not exist`);
                }
                continue;
            }
            toAdd.push(tag);
        }
    }

    return { toAdd, toRemove, toRename };
}

export function parseFilterExpressionTokens(tokens) {
    const toDelete = [];
    const toFilter = [];
    const toExclude = [];
    const toRename = [];
    const toCreate = [];

    for (const token of tokens) {
        if (token.includes('>')) {
            const [oldN, newN] = token.split('>').map(s => s.trim().toLowerCase());
            if (oldN && newN) toRename.push({ oldN, newN });
            else showToast('Rename syntax: oldname>newname');
        } else if (token.startsWith('--') && token.length > 2) {
            toDelete.push(token.slice(2).toLowerCase());
        } else if (token.startsWith('-') && token.length > 1) {
            const tagName = token.slice(1).toLowerCase();
            const found = State.allTags.find(t => t.toLowerCase() === tagName);
            if (found) toExclude.push(found);
        } else if (token.startsWith('+') && token.length > 1) {
            const tagName = token.slice(1).toLowerCase();
            if (!State.allTags.find(t => t.toLowerCase() === tagName)) toCreate.push(tagName);
        } else {
            const tagName = token.toLowerCase();
            const found = State.allTags.find(t => t.toLowerCase() === tagName);
            if (found) toFilter.push(found);
        }
    }

    return { toDelete, toFilter, toExclude, toRename, toCreate };
}

export function tryTabCompletion(rawValue, matches, opts) {
    if (rawValue !== rawValue.trimEnd()) return false;
    if (matches.length === 0) return false;
    const toks = rawValue.trimStart().split(/\s+/);
    const last = toks[toks.length - 1] || '';
    if (!last || last.includes('>')) return false;
    const prefixChars = opts.prefixChars || ['-', '+'];
    let prefix = '';
    for (const pc of prefixChars) {
        if (last.startsWith(pc)) { prefix = pc; break; }
    }
    const typed = (prefix ? last.slice(prefix.length) : last).toLowerCase().trim();
    if (!typed) return false;
    const prefixMatches = matches.filter(m => m.toLowerCase().startsWith(typed));
    const pool = prefixMatches.length > 0 ? prefixMatches : matches;
    if (pool.length === 1) {
        toks[toks.length - 1] = prefix + pool[0];
        opts.setValue(toks.join(' ') + ' ');
        opts.onComplete();
        return true;
    }
    if (pool.length > 1) {
        const lcp = longestCommonPrefix(pool);
        if (lcp.length > typed.length) {
            toks[toks.length - 1] = prefix + lcp;
            opts.setValue(toks.join(' '));
            opts.onComplete();
            return true;
        }
    }
    return false;
}

function longestCommonPrefix(arr) {
    if (!arr.length) return '';
    let prefix = arr[0].toLowerCase();
    for (let i = 1; i < arr.length; i++) {
        const s = arr[i].toLowerCase();
        while (s.length < prefix.length || !s.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
            if (!prefix) return '';
        }
    }
    return prefix;
}

export function getCommonTags(limit = 8, exclude = []) {
    const excluded = new Set(exclude);
    return State.allTags
        .filter(t => !excluded.has(t))
        .sort((a, b) => (State.tagCounts[b] || 0) - (State.tagCounts[a] || 0) || a.localeCompare(b))
        .slice(0, limit);
}
