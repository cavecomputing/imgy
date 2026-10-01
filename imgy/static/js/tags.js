/** Parsing for the tag expression syntax shared by the search bar and the tag flyups. */
import { State } from './state.js';
import { esc, formatCount } from './utils.js';
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

const strong = (text) => `<strong>${esc(text)}</strong>`;

/**
 * What Enter would do with a tag editor expression, for the preview under the input.
 * `ctx.files` holds the files the editor works on (one, or the bulk selection) and
 * `ctx.llm` describes auto-tagging ({ model, verbs }). Returns { rows, adds, removes }:
 * one row per token ({ code, cls: ''|'add'|'rm'|'warn', html, alert }), plus the tags the
 * expression would add or remove so the current-tag chips can show the change.
 */
export function planTagExpression(raw, ctx) {
    const bulk = !!ctx.bulk;
    const files = ctx.files || [];
    const n = files.length;
    const tokens = splitTagTokens(raw, bulk ? /[\s,]+/ : /\s+/);
    const rows = [];
    const adds = new Set();
    const removes = new Set();
    const result = { rows, adds, removes };
    if (!tokens.length || !n) return result;

    const library = new Set(State.allTags);
    const have = (tag) => files.filter(f => f.tags?.includes(tag)).length;
    const union = [...new Set(files.flatMap(f => f.tags || []))];
    const target = bulk ? `${n === 1 ? 'the file' : `the ${n} files`}` : 'this file';
    const row = (code, cls, html, alert = false) => rows.push({ code, cls, html, alert });

    const special = tokens.find(t => t === '?' || t === '=' || t === '++' || t === '--');
    if (special && tokens.length > 1) {
        row(special, 'warn', `${strong(special)} must be the only token.`, true);
        return result;
    }
    if (special === '?') {
        row('?', '', `Sends ${bulk ? `${strong(formatCount(n, 'file'))}` : 'this file'} to ${strong(ctx.llm?.model || 'the model')} to ${esc(ctx.llm?.verbs || 'tag it')}.`);
        return result;
    }
    if (special === '--') {
        if (!union.length) row('--', 'warn', `${bulk ? 'The selection has' : 'This file has'} no tags.`);
        else {
            row('--', 'rm', `Removes all ${strong(formatCount(union.length, 'tag'))} from ${target}.`);
            union.forEach(t => removes.add(t));
        }
        return result;
    }
    if (special === '=') {
        if (!bulk) row('=', 'warn', 'Only works on a selection.', true);
        else if (!union.length) row('=', 'warn', 'The selection has no tags to share.');
        else row('=', '', `Gives ${n === 1 ? 'the file' : `all ${strong(formatCount(n, 'file'))}`} every tag in the selection (${strong(formatCount(union.length, 'tag'))}).`);
        return result;
    }
    if (special === '++') {
        if (!bulk) row('++', 'warn', 'Only works on a selection.', true);
        else if (n < 2) row('++', 'warn', 'Select at least 2 files to group them.', true);
        else row('++', '', `Groups the ${strong(formatCount(n, 'file'))} so they stay together.`);
        return result;
    }

    for (const token of tokens) {
        if (token.includes('>')) {
            const [oldName, newName] = token.split('>').map(s => s.trim().toLowerCase());
            if (!oldName || !newName) { row(token, 'warn', `Rename needs ${strong('old>new')}.`, true); continue; }
            const k = have(oldName);
            if (!k) { row(token, 'warn', `${strong(oldName)} isn't on ${bulk ? 'any selected file' : 'this file'}.`, true); continue; }
            const where = bulk ? (k === n ? (n === 1 ? 'the file' : `all ${n} files`) : `the ${formatCount(k, 'file')} that have it`) : 'this file';
            row(token, '', `Renames ${strong(oldName)} to ${strong(newName)} on ${esc(where)}.`);
            removes.add(oldName);
            adds.add(newName);
        } else if (token.startsWith('-') && token.length > 1) {
            const tag = token.slice(1).toLowerCase();
            const k = have(tag);
            if (!k) { row(token, 'warn', `Not on ${bulk ? 'any selected file' : 'this file'}.`); continue; }
            const where = bulk ? (k === n ? (n === 1 ? 'the file' : `all ${strong(formatCount(n, 'file'))}`) : `the ${strong(formatCount(k, 'file'))} that have it`) : 'this file';
            row(token, 'rm', `Removes it from ${where}.`);
            removes.add(tag);
        } else if (token === '-' || token === '+') {
            continue; // still typing
        } else {
            const create = token.startsWith('+');
            const tag = (create ? token.slice(1) : token).toLowerCase();
            const exists = library.has(tag);
            if (!exists && !create) { row(token, 'warn', `No tag named ${strong(tag)} yet. ${strong('+' + tag)} creates it.`, true); continue; }
            const missing = n - have(tag);
            if (!missing) { row(token, 'warn', bulk && n > 1 ? `Already on all ${n} files.` : `Already on ${target}.`); continue; }
            const where = bulk ? (missing === n ? (n === 1 ? 'the file' : `all ${strong(formatCount(n, 'file'))}`) : `the ${strong(formatCount(missing, 'file'))} without it`) : 'this file';
            row(token, 'add', `${exists ? '' : 'New tag. '}Adds it to ${where}.`);
            adds.add(tag);
        }
    }
    return result;
}
