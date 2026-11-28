"""Turn actual UI captures into captioned, smoothly focused teaching GIFs.

Requires Pillow; source pixels are never redrawn as a fake application.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets/tutorials'
manifest = json.loads((OUT / 'manifest.json').read_text(encoding='utf-8'))
WIDTH, HEIGHT, HEADER = 1120, 700, 92
font_path = Path('C:/Windows/Fonts/msyh.ttc')
if not font_path.exists():
    raise SystemExit('Install Microsoft YaHei or set font_path to a Chinese font before recording.')
font = ImageFont.truetype(str(font_path), 24)
small = ImageFont.truetype(str(font_path), 15)


def frame(source, tutorial, step, index, zoom):
    sw, sh = source.size
    cx, cy, _ = step['focus']
    cw, ch = sw / zoom, sh / zoom
    left = max(0, min(cx - cw / 2, sw - cw))
    top = max(0, min(cy - ch / 2, sh - ch))
    view = source.crop((left, top, left + cw, top + ch)).resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    canvas = Image.new('RGB', (WIDTH, HEIGHT + HEADER), '#f1f5ef')
    canvas.paste(view, (0, HEADER))
    draw = ImageDraw.Draw(canvas)
    draw.text((24, 10), f"PELLO  /  {tutorial['title']}", fill='#385744', font=small)
    caption = step['caption']
    size = 24
    while draw.textlength(caption, font=ImageFont.truetype(str(font_path), size)) > WIDTH - 48:
        size -= 1
    draw.text((24, 39), caption, fill='#193d2b', font=ImageFont.truetype(str(font_path), size))
    draw.line((0, HEADER - 1, WIDTH, HEADER - 1), fill='#b9caba', width=1)
    draw.rectangle((0, HEIGHT + HEADER - 4, int(WIDTH * (index + 1) / len(tutorial['steps'])), HEIGHT + HEADER), fill='#4c7b58')
    return canvas


def encode(tutorial):
    frames, durations = [], []
    # One stable palette per clip prevents text and UI colors from flickering.
    sources = [Image.open(OUT / step['file']).convert('RGB') for step in tutorial['steps']]
    sheet = Image.new('RGB', (WIDTH, (HEIGHT + HEADER) * len(sources)))
    for i, (source, step) in enumerate(zip(sources, tutorial['steps'])):
        sheet.paste(frame(source, tutorial, step, i, step['focus'][2]), (0, (HEIGHT + HEADER) * i))
    palette = sheet.quantize(colors=192, method=Image.Quantize.MEDIANCUT)
    for i, (source, step) in enumerate(zip(sources, tutorial['steps'])):
        target = step['focus'][2]
        for n in range(6):
            t = n / 5
            eased = t * t * (3 - 2 * t)
            image = frame(source, tutorial, step, i, 1 + (target - 1) * eased)
            frames.append(image.quantize(palette=palette, dither=Image.Dither.NONE))
            durations.append(700 if n == 0 else 2800 if n == 5 else 100)
    frames[0].save(OUT / f"{tutorial['id']}.gif", save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True, disposal=1)
    # A PNG contact sheet is review evidence, outside the published assets.
    evidence = ROOT / 'output/playwright/documentation'
    evidence.mkdir(parents=True, exist_ok=True)
    sheet.resize((560, (HEIGHT + HEADER) * len(sources) // 2)).save(evidence / f"{tutorial['id']}-review.png")
    print(tutorial['id'], (OUT / f"{tutorial['id']}.gif").stat().st_size, flush=True)


for tutorial in manifest['tutorials']:
    if tutorial['steps'] and (len(sys.argv) == 1 or tutorial['id'] in sys.argv[1:]):
        encode(tutorial)

text = '# 按自己的速度，跟着做\n\n这些是动图使用的原始静帧，没有镜头运动。每一步对应一次实际操作。点击图片打开 1440×900 原图，使用浏览器放大查看；动图的聚焦放大与步骤字幕在后期添加。\n\n'
for tutorial in manifest['tutorials']:
    text += f"- [{tutorial['title']}](#{tutorial['id']})\n"
for tutorial in manifest['tutorials']:
    text += f"\n<a id=\"{tutorial['id']}\"></a>\n\n## {tutorial['title']}\n\n"
    text += f"[操作指南](https://github.com/FangYang970206/Pello/wiki/{tutorial['wiki']})"
    if tutorial['steps']:
        text += f" · [播放聚焦动图]({tutorial['id']}.gif)"
    text += '\n\n'
    if tutorial.get('note'):
        text += tutorial['note'] + '\n\n'
    for step in tutorial['steps']:
        text += f"### {step['caption']}\n\n[![{step['caption']}]({step['file']})]({step['file']})\n\n"
(OUT / 'STEPS.md').write_text(text.rstrip() + '\n', encoding='utf-8')
