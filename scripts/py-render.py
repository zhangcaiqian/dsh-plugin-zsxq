#!/usr/bin/env python3
"""开发用：用 Python 版 skill 渲染参考输出，供 golden.mjs 做逐字对比。

用法:
    ZSXQ_PY_SCRIPTS=/path/to/skills/zsxq-knowledge/scripts \
    python3 scripts/py-render.py /path/to/knowledge-base > /tmp/py-render.json

说明: 这是迁移验证脚本，不参与插件运行；插件本身不需要 Python。
"""
import json
import os
import sys
from pathlib import Path

data_dir = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
scripts_dir = os.environ.get('ZSXQ_PY_SCRIPTS')
if data_dir is None or not scripts_dir:
    print(__doc__)
    sys.exit(2)

sys.path.insert(0, scripts_dir)
import sync  # noqa: E402
from utils import (  # noqa: E402
    extract_docx_images, extract_docx_text, extract_pdf_images, extract_pdf_text, format_date_path,
)

config = json.load(open(data_dir / 'config.json', encoding='utf-8'))
out = {}
for raw in sorted((data_dir / 'data/raw').rglob('*.json')):
    topic = json.loads(raw.read_text(encoding='utf-8'))
    topic_id = str(topic['topic_id'])
    channel_key = raw.relative_to(data_dir / 'data/raw').parts[0]
    channel_name = config['channels'][channel_key]['name']
    date_path = format_date_path(topic['create_time'])
    ttype = topic.get('type', 'talk')
    if ttype == 'talk':
        files = (topic.get('talk') or {}).get('files') or []
    elif ttype == 'q&a':
        files = ((topic.get('question') or {}).get('files') or []) + ((topic.get('answer') or {}).get('files') or [])
    else:
        files = []

    file_results = {}
    for idx, f in enumerate(files, start=1):
        name = f.get('name', '')
        local = data_dir / 'assets' / channel_key / date_path / name
        text, images = '', []
        try:
            suffix = Path(name).suffix.lower()
            if suffix == '.docx':
                text = extract_docx_text(str(local))
                images = extract_docx_images(str(local), '/tmp/zsxq-py-render-images')
            elif suffix == '.pdf':
                text = extract_pdf_text(str(local))
                images = extract_pdf_images(str(local), '/tmp/zsxq-py-render-images')
        except Exception:
            continue
        md_images = []
        for j, image_path in enumerate(images, start=1):
            suffix = Path(image_path).suffix.lower() or '.png'
            md_images.append(f'embedded-{idx:02d}-{j:02d}{suffix}')
        file_results[name] = {
            'local_path': str(local.relative_to(data_dir)),
            'extracted_text': text,
            'extracted_images': images,
            'markdown_images': md_images,
        }

    voice_path = ''
    cv = topic.get('content_voice')
    if cv:
        candidate = data_dir / 'assets' / channel_key / date_path / cv.get('name', '')
        if candidate.exists():
            voice_path = str(candidate.relative_to(data_dir))

    out[topic_id] = sync.topic_to_markdown(
        topic, channel_key, channel_name, config,
        file_results=file_results, voice_path=voice_path, article_text='',
    )

json.dump(out, sys.stdout, ensure_ascii=False)
