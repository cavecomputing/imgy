"""LLM auto-tagging. The browser sends the endpoint, model, and secret from its settings."""
import json
import logging
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse

from flask import Blueprint, abort

from .. import llm
from ..db import active_tag_names, get_db
from ..media import is_video
from .common import active_file, json_body
from .settings import load_tag_groups

logger = logging.getLogger(__name__)

bp = Blueprint('llm', __name__)


def _endpoint(data):
    """(api_url, model, api_secret) from the request, defaulting to a local Ollama."""
    api_url = data.get('api_url', llm.DEFAULT_API_URL)
    if not isinstance(api_url, str) or urlparse(api_url).scheme not in ('http', 'https'):
        abort(400, 'The LLM API URL must start with http:// or https://')
    return api_url, str(data.get('model', llm.DEFAULT_MODEL)), str(data.get('api_secret') or '')


@bp.post('/llm/test')
def test_connection():
    api_url, model, api_secret = _endpoint(json_body())
    payload = {
        'model': model,
        'messages': [{'role': 'user', 'content': 'Respond with only the word "ok".'}],
        'max_tokens': 16,
        'temperature': 0,
    }
    try:
        result = json.loads(llm.post_chat(api_url, api_secret, payload, timeout=15))
        try:
            text = llm.message_text(result).strip()
        except (AttributeError, KeyError, IndexError, TypeError):
            logger.error(f'Unexpected LLM response structure: {result}')
            return {'error': 'Unexpected response format from LLM API'}, 502
        return {'success': True, 'response': text, 'model': model}
    except HTTPError as e:
        error_body = e.read().decode(errors='replace')[:500]
        logger.error(f'LLM test returned HTTP {e.code}: {error_body}')
        return {'error': f'LLM API returned HTTP {e.code}: {error_body or e.reason}'}, 502
    except URLError as e:
        logger.error(f'LLM test connection failed: {e.reason}')
        return {'error': f'LLM API connection failed: {e.reason}'}, 502
    except Exception as e:
        logger.error(f'LLM test failed: {e}')
        return {'error': 'LLM connection test failed'}, 502


@bp.post('/llm/analyze/<path:filename>')
def analyze_image(filename):
    """Suggest a filename and tags for an image. The browser applies the suggestions."""
    filename, source_path = active_file(filename)
    if is_video(filename):
        abort(400, 'LLM analysis is not supported for video files')
    api_url, model, api_secret = _endpoint(json_body())

    with get_db() as conn:
        all_tags = active_tag_names(conn)
        tag_groups = llm.usable_groups(load_tag_groups(conn), all_tags)
    payload = llm.image_payload(model, llm.build_prompt(all_tags, tag_groups), source_path)

    logger.info(f'LLM analyze: sending {source_path.name} to {api_url} model={model}')
    try:
        raw_body = llm.post_chat(api_url, api_secret, payload, timeout=120)
        logger.info(f'LLM raw response: {raw_body[:1000]}')
        result = json.loads(raw_body)
    except HTTPError as e:
        error_body = e.read().decode(errors='replace')[:500]
        logger.error(f'LLM API returned HTTP {e.code}: {error_body}')
        return {'error': f'LLM API returned HTTP {e.code}'}, 502
    except URLError as e:
        logger.error(f'LLM API connection failed: {e.reason}')
        return {'error': 'LLM API connection failed'}, 502
    except Exception as e:
        logger.error(f'LLM API request failed: {type(e).__name__}: {e}')
        return {'error': 'LLM API request failed'}, 502

    try:
        if result['choices'][0].get('finish_reason') == 'length':
            logger.error(f'LLM response truncated (finish_reason=length), raw: {raw_body[:500]}')
            return {'error': 'LLM response was cut off — try a non-reasoning model or increase max_tokens'}, 502
        out_filename, out_tags = llm.parse_suggestion(llm.message_text(result), all_tags, tag_groups)
    except (AttributeError, KeyError, IndexError, TypeError, ValueError) as e:
        logger.error(f'Failed to parse LLM response: {e}, raw: {raw_body[:500]}')
        return {'error': 'Failed to parse LLM response'}, 502
    logger.info(f'LLM final result: filename={out_filename!r}, tags={out_tags}')
    return {'filename': out_filename, 'tags': out_tags}
