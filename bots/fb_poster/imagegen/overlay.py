#!/usr/bin/env python3
"""Composite crisp brand text over an AI-generated photo (1024x1024).
Keeps type razor-sharp (AI never renders the text) with a legibility scrim."""
import os, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def _resolve(cands):
    for c in cands:
        if os.path.exists(c): return c
    return None
BLACK=_resolve(["C:/Windows/Fonts/seguibl.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"])
BOLD =_resolve(["C:/Windows/Fonts/segoeuib.ttf","/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"])
W=H=1024
GREEN=(34,197,94); ORANGE=(249,146,34); GOLD=(251,191,36); WHITE=(255,255,255); INK=(22,28,26)

def fnt(p,s): return ImageFont.truetype(p,s)

def left_scrim(img, width=0.66, strength=225):
    """Dark gradient heavy on the left (where text sits), clear on the right."""
    sc=Image.new("L",(W,1),0); px=sc.load()
    cut=int(W*width)
    for x in range(W):
        px[x,0]=int(strength*max(0,(cut-x)/cut))**1 if x<cut else 0
    sc=sc.resize((W,H))
    black=Image.new("RGB",(W,H),(6,10,10))
    return Image.composite(black,img,sc)

def bottom_scrim(img, h=190, strength=200):
    sc=Image.new("L",(1,H),0); px=sc.load()
    for y in range(H):
        px[0,y]=int(strength*max(0,(y-(H-h))/h)) if y>H-h else 0
    sc=sc.resize((W,H))
    return Image.composite(Image.new("RGB",(W,H),(6,10,10)),img,sc)

def badge(d,x,y,text,fill,ink):
    bf=fnt(BOLD,28); bw=d.textlength(text,font=bf)
    d.rounded_rectangle([x,y,x+bw+40,y+52],26,fill=fill); d.text((x+20,y+11),text,font=bf,fill=ink)

def _star(d,cx,cy,r,c):
    p=[]
    for k in range(10):
        a=-math.pi/2+k*math.pi/5; rad=r if k%2==0 else r*0.42
        p.append((cx+rad*math.cos(a),cy+rad*math.sin(a)))
    d.polygon(p,fill=c)

def review_chip(d,x,y,rating,count):
    """Crisp Google-review chip: rating + 5 gold stars + review count."""
    w=330
    d.rounded_rectangle([x,y,x+w,y+128],16,fill=(248,250,252))
    d.ellipse([x+18,y+20,x+62,y+64],fill=(66,133,244)); d.text((x+31,y+26),"G",font=fnt(BLACK,30),fill=WHITE)
    d.text((x+74,y+20),"Google rating",font=fnt(BOLD,20),fill=(120,130,140))
    d.text((x+74,y+46),rating,font=fnt(BLACK,34),fill=(30,38,50))
    for i in range(5): _star(d,x+150+i*34,y+62,15,(251,191,36))
    d.text((x+18,y+92),f"{count} Google reviews  ·  trending up",font=fnt(BOLD,20),fill=(90,100,112))

def estimate_chip(d,x,y,label,total):
    d.rounded_rectangle([x,y,x+312,y+150],16,fill=(248,250,252))
    d.text((x+18,y+14),"AI ESTIMATE",font=fnt(BOLD,18),fill=(120,130,140))
    d.text((x+18,y+40),label,font=fnt(BOLD,22),fill=INK)
    d.line([(x+18,y+80),(x+294,y+80)],fill=(224,228,234),width=2)
    d.text((x+18,y+92),"Total",font=fnt(BOLD,24),fill=INK)
    tw=d.textlength(total,font=fnt(BLACK,34)); d.text((x+294-tw,y+88),total,font=fnt(BLACK,34),fill=(34,150,70))

def compose(scene, headline_lines, badge_text, brand, out,
            badge_fill=ORANGE, badge_ink=(40,22,0), chip=None, review=None):
    """brand: ('TreeSnap','.cloud'). chip=(label,total) TS estimate; review=(rating,count) GR review chip."""
    img=scene.convert("RGB").resize((W,H))
    img=left_scrim(img); img=bottom_scrim(img)
    d=ImageDraw.Draw(img)
    badge(d,64,72,badge_text,badge_fill,badge_ink)
    if chip: estimate_chip(d,616,120,chip[0],chip[1])
    if review: review_chip(d,616,120,review[0],review[1])
    # headline auto-fit, lower-left, with shadow
    size=94
    while size>56:
        hf=fnt(BLACK,size)
        if max(d.textlength(l,font=hf) for l in headline_lines)<=560: break
        size-=4
    hf=fnt(BLACK,size); lh=int(size*1.05); y=752-len(headline_lines)*lh
    for l in headline_lines:
        d.text((67,y+3),l,font=hf,fill=(0,0,0)); d.text((64,y),l,font=hf,fill=WHITE); y+=lh
    # wordmark
    name,tld=brand
    wf=fnt(BOLD,40); nw=d.textlength(name,font=wf)
    d.text((64,H-84),name,font=wf,fill=WHITE); d.text((64+nw,H-84),tld,font=wf,fill=GREEN)
    img.save(out)
    return out

if __name__=="__main__":
    # smoke test with a placeholder gradient (no torch needed)
    g=Image.new("RGB",(W,H),(40,70,50))
    compose(g,["Snap it.","Price it.","Win it."],"FOR TREE PROS",("TreeSnap",".cloud"),
            "overlay_test.png",chip=("Oak removal + stump","$2,200"))
    print("ok")
