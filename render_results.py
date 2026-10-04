"""Create an inspectable image sheet from the saved predictions, including failures."""
import json
import textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',18)
title_font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',22)
annotations=json.loads((ROOT/'samples/annotations.json').read_text())['images']
qwen={r['image']:r for r in json.loads((ROOT/'results/qwen.json').read_text())['results']}
siglip={r['image']:r for r in json.loads((ROOT/'results/siglip.json').read_text())['results']}
mobileclip={r['image']:r for r in json.loads((ROOT/'results/mobileclip.json').read_text())['results']}
review={r['image']:r for r in json.loads((ROOT/'results/review.json').read_text())['results']}
for sheet in range(2):
    canvas=Image.new('RGB',(1400,1920),'white')
    draw=ImageDraw.Draw(canvas)
    draw.text((20,12),f'Random photos: {sheet*10+1:02d}-{sheet*10+10:02d} | Qwen3-VL-2B, SigLIP 2, MobileCLIP2 | CPU',font=title_font,fill='black')
    for cell,reference in enumerate(annotations[sheet*10:sheet*10+10]):
        index=reference['index']; name=f'{index:02d}.jpg'
        x,y=(cell%2)*700+20,(cell//2)*372+55
        image=Image.open(ROOT/'samples'/name); image.thumbnail((300,225))
        canvas.paste(image,(x,y+28))
        draw.text((x,y),f'{index:02d}  {reference["category"]}',font=title_font,fill='black')
        row=qwen[name]
        parsed=row['parsed'] or {}
        lines=['Qwen tags:']+textwrap.wrap(', '.join(parsed.get('tags',[])),width=32)
        lines+=['']+textwrap.wrap(parsed.get('caption',row['raw']),width=32)
        draw.multiline_text((x+315,y+28),'\n'.join(lines),font=font,fill='black',spacing=4)
        status=review[name]
        summary='Review: '+status['verdict']+'. '+status['note']
        text_lines=textwrap.wrap(summary,width=66)
        pred=siglip[name]['predictions'][0]['label']
        text_lines+=['SigLIP category: '+pred]
        text_lines+=['MobileCLIP category: '+mobileclip[name]['predictions'][0]['label']]
        draw.multiline_text((x,y+263),'\n'.join(text_lines),font=font,
            fill='#17613c' if status['verdict']=='Pass' else '#993c20',spacing=4)
    canvas.save(ROOT/f'results/predictions-{sheet+1}.jpg',quality=94)
print('Created results/predictions-1.jpg and predictions-2.jpg')
