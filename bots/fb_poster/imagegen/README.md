# TreeSnap FB image generator

Generates the photographic ad cards in `../assets/` locally with Stable Diffusion XL,
then composites the crisp brand text on top. **The photo is AI; the text is not** — that's
why the headlines/estimates stay razor-sharp (letting the model render text produces garbled
words).

## Design rules
- **No people.** AI can't be trusted with hands, poses, or safety gear — every card is trees,
  aftermath (stumps, log rounds), storm damage, or *parked* equipment. No operators.
- Each post gets its own scene (5 types rotate: bucket truck, oak canopy, log pile, stump,
  storm-damaged tree) with varied lighting and a per-post AI-estimate chip.
- Model: `stabilityai/stable-diffusion-xl-base-1.0` (SDXL 1.0 license permits commercial use).

## Setup (one time, on a machine with an NVIDIA GPU)
```
python -m venv imggen-venv
imggen-venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu124
imggen-venv/Scripts/python -m pip install diffusers transformers accelerate safetensors pillow
```
~8GB VRAM is enough (the pipeline uses model CPU offload + VAE tiling). First run downloads the
model (~7GB).

## Usage
```
imggen-venv/Scripts/python bots/fb_poster/imagegen/generate_cards.py          # fill in any missing images
imggen-venv/Scripts/python bots/fb_poster/imagegen/generate_cards.py --force  # regenerate everything
imggen-venv/Scripts/python bots/fb_poster/imagegen/generate_cards.py 233 258  # regenerate specific post ids
```

## Files
- `sdxl_gen.py` — loads the SDXL pipeline (8GB-friendly), `gen(prompt, seed)` -> PIL image
- `overlay.py` — composites headline / badge / estimate chip / wordmark with a legibility scrim
- `generate_cards.py` — the per-post scene table + prompts; writes `treesnap_<id>_<slug>.png`

The card table in `generate_cards.py` mirrors the post ids in `../config/fb_post_queue.json`.
When you add posts to the queue, add matching rows here and re-run.
