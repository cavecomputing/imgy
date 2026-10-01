"""Client for an OpenAI-compatible chat completions API (Ollama, OpenRouter, ...) used to
suggest a filename and tags for an image."""
import base64
import json
import logging
import mimetypes
import re
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

DEFAULT_API_URL = 'http://localhost:11434/v1/chat/completions'
DEFAULT_MODEL = 'gemma3'

# First {...} object in the reply, allowing one level of nesting. Models often wrap JSON
# in markdown fences or add chatter around it.
_JSON_OBJECT = re.compile(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}')


def build_headers(api_url, api_secret=''):
    headers = {'Content-Type': 'application/json'}
    secret = (api_secret or '').strip()
    if secret:
        headers['Authorization'] = secret if secret.lower().startswith('bearer ') else f'Bearer {secret}'
    if 'openrouter.ai' in (api_url or ''):
        headers['HTTP-Referer'] = 'http://localhost'
        headers['X-OpenRouter-Title'] = 'Imgy'
    return headers


def post_chat(api_url, api_secret, payload, timeout):
    """POST a chat completion request and return the raw response body.

    Raises urllib's HTTPError / URLError (or ValueError for a malformed URL).
    """
    req = Request(api_url, data=json.dumps(payload).encode(), headers=build_headers(api_url, api_secret), method='POST')
    with urlopen(req, timeout=timeout) as resp:
        return resp.read().decode()


def message_text(result):
    """The assistant's reply text, falling back to reasoning_content for reasoning models."""
    message = result['choices'][0]['message']
    return message.get('content') or message.get('reasoning_content') or ''


def usable_groups(tag_groups, all_tags):
    """Groups worth enforcing: at least two tags that still exist. Unnamed ones get a label."""
    existing = set(all_tags)
    groups = []
    for group in tag_groups:
        tags = [t for t in group['tags'] if t in existing]
        if len(tags) >= 2:
            groups.append({'name': group['name'] or 'Group', 'tags': tags})
    return groups


def build_prompt(all_tags, tag_groups):
    """Ask for a filename plus tags, restricted to existing tags once the library has some."""
    if not all_tags:
        return (
            'Analyze this image. Respond with ONLY valid JSON in this exact format:\n'
            '{"filename": "descriptive-name", "tags": ["tag1", "tag2", ...]}\n'
            'For filename: a short, descriptive kebab-case name (no extension).\n'
            'For tags: 3-8 lowercase single-word or hyphenated tags describing '
            'the content, style, colors, subjects, and mood.'
        )
    prompt = (
        'Analyze this image. Respond with ONLY valid JSON in this exact format:\n'
        '{"filename": "descriptive-name", "tags": ["tag1", "tag2", ...]}\n\n'
        'For filename: a short, descriptive kebab-case name (no extension).\n\n'
        'For tags: select ONLY from this list of allowed tags. Do NOT invent new tags.\n'
        f'Allowed tags: {", ".join(all_tags)}\n'
    )
    if tag_groups:
        prompt += '\nEXCLUSIVE GROUPS (pick exactly ONE tag from each applicable group):\n'
        for group in tag_groups:
            prompt += f'- {group["name"]}: {", ".join(group["tags"])}\n'
    prompt += '\nSelect 3-10 tags that describe the content, subjects, style, and mood of the image.'
    return prompt


def image_payload(model, prompt, image_path):
    content_type = mimetypes.guess_type(str(image_path))[0] or 'image/jpeg'
    b64 = base64.b64encode(image_path.read_bytes()).decode()
    return {
        'model': model,
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'text', 'text': prompt},
                {'type': 'image_url', 'image_url': {'url': f'data:{content_type};base64,{b64}'}},
            ],
        }],
        'temperature': 0.3,
    }


def parse_suggestion(text, all_tags, tag_groups):
    """Extract (filename, tags) from the model's reply.

    Tags are limited to existing tags (unless the library has none yet) and to one tag per
    exclusive group. Raises ValueError / KeyError / TypeError on unusable replies.
    """
    if not text:
        raise ValueError('LLM returned empty content')
    match = _JSON_OBJECT.search(text)
    if not match:
        raise ValueError('No JSON object found in response')
    parsed = json.loads(match.group(0))
    filename = parsed.get('filename', '')
    tags = parsed.get('tags', [])
    if not isinstance(filename, str) or not isinstance(tags, list):
        raise ValueError('Expected a string filename and a list of tags')
    # Collapse whitespace (including newlines and tabs) and keep tags api/tags.py would accept.
    tags = (' '.join(t.split()).lower() for t in tags if isinstance(t, str))
    tags = list(dict.fromkeys(t for t in tags if 0 < len(t) <= 100 and all(ord(c) >= 32 and ord(c) != 127 for c in t)))
    logger.info(f'LLM parsed result (raw): filename={filename!r}, tags={tags}')

    if all_tags:
        existing = set(all_tags)
        tags = [t for t in tags if t in existing]
        for group in tag_groups:
            members = set(group['tags'])
            for extra in [t for t in tags if t in members][1:]:
                tags.remove(extra)
    return filename, tags
