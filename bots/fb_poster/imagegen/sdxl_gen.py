#!/usr/bin/env python3
"""Local SDXL scene generator for the 3060 Ti (8GB). Loads once, generates 1024x1024 photos.
Commercially-licensed model: stabilityai/stable-diffusion-xl-base-1.0 (SDXL 1.0 license permits commercial use)."""
import torch
from diffusers import StableDiffusionXLPipeline

MODEL = "stabilityai/stable-diffusion-xl-base-1.0"
NEG = ("person, people, human, man, woman, worker, crew, hands, fingers, arm, face, "
       "figure, silhouette of a person, crowd, "
       "text, watermark, signature, logo, letters, words, caption, brand name, "
       "blurry, low quality, jpeg artifacts, distorted, deformed, disfigured, "
       "extra limbs, bad anatomy, cartoon, illustration, drawing, cgi, 3d render")

_pipe = None
def pipe():
    global _pipe
    if _pipe is None:
        p = StableDiffusionXLPipeline.from_pretrained(
            MODEL, torch_dtype=torch.float16, variant="fp16", use_safetensors=True)
        p.enable_model_cpu_offload()   # fits 8GB VRAM
        p.enable_vae_tiling()
        _pipe = p
    return _pipe

def gen(prompt, seed=0, steps=30, guidance=6.5):
    g = torch.Generator(device="cuda").manual_seed(seed)
    img = pipe()(prompt=prompt, negative_prompt=NEG, num_inference_steps=steps,
                 guidance_scale=guidance, width=1024, height=1024, generator=g).images[0]
    return img

if __name__ == "__main__":
    import os, overlay
    OUT = os.path.dirname(os.path.abspath(__file__))
    samples = [
        ("ts_bucket",
         "professional advertising photograph, a tree service worker in a white bucket truck cherry picker "
         "trimming a large oak tree, wearing an orange safety helmet and hi-vis vest, chainsaw, golden hour "
         "sunlight, residential neighborhood, sharp focus, high detail, commercial photography, 35mm",
         ["Snap it.","Price it.","Win it."], "FOR TREE PROS", ("TreeSnap",".cloud"),
         dict(chip=("Oak removal + stump","$2,200"), badge_fill=overlay.ORANGE)),
        ("ts_storm",
         "professional photograph of a large storm-damaged oak tree with a broken branch hanging over a "
         "suburban house roof, dramatic overcast stormy sky, wet, realistic, commercial advertising photography, "
         "high detail",
         ["Storm hit.","Book it fast."], "STORM SEASON", ("TreeSnap",".cloud"),
         dict(chip=("Emergency limb removal","$1,800"), badge_fill=overlay.ORANGE)),
        ("gr_owner",
         "professional advertising photograph of a smiling confident local tradesman plumber in a clean uniform "
         "holding a smartphone, standing in front of his service van, bright natural daylight, commercial "
         "photography, sharp focus, high detail",
         ["More 5-star","reviews.","On autopilot."], "GOOGLE REVIEWS", ("GrowReviews",".pro"),
         dict(badge_fill=overlay.GOLD, badge_ink=(30,18,0))),
    ]
    for name, prompt, head, badge_t, brand, kw in samples:
        print("generating", name, flush=True)
        scene = gen(prompt, seed=7)
        scene.save(os.path.join(OUT, f"raw_{name}.png"))
        overlay.compose(scene, head, badge_t, brand, os.path.join(OUT, f"sample_{name}.png"), **kw)
        print("  done", name, flush=True)
    print("ALL SAMPLES DONE")
