"""
Generate small overlay crops for PNGTuber v2.

Instead of full 832x1216 sprite replacements, generates:
  - mouth_open crop (~200x120px) - just the mouth area with transparency
  - eyes_closed crop (~380x120px) - just the eyes area with transparency

These tiny overlays are positioned via CSS on top of the original avatar.
No full image replacement = no jitter.
"""

import base64
import json
import sys
import time
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFilter

API_URL = "http://127.0.0.1:7860"
AVATARS_DIR = Path(
    "C:/Users/Пользователь/OneDrive/Desktop/Amina-bot/bot/src/telegram/avatars"
)
OUTPUT_DIR = AVATARS_DIR / "overlays"

EMOTIONS = [
    "base-neutral", "emotion-angry", "emotion-ecstatic", "emotion-flirty",
    "emotion-happy", "emotion-loving", "emotion-sad", "emotion-sleepy",
    "emotion-smirk", "emotion-surprised", "emotion-thinking",
]

EMOTION_SHORT = {
    "base-neutral": "neutral", "emotion-angry": "angry",
    "emotion-ecstatic": "ecstatic", "emotion-flirty": "flirty",
    "emotion-happy": "happy", "emotion-loving": "loving",
    "emotion-sad": "sad", "emotion-sleepy": "sleepy",
    "emotion-smirk": "smirk", "emotion-surprised": "surprised",
    "emotion-thinking": "thinking",
}

# Image dimensions
IMG_W, IMG_H = 832, 1216

# Crop regions (x1, y1, x2, y2) with generous padding for smooth edges
MOUTH_CROP = (280, 470, 560, 620)   # 280px wide, 150px tall
EYES_CROP = (210, 400, 630, 545)    # 420px wide, 145px tall

# Inpainting mask regions (tighter than crop)
MOUTH_MASK = (310, 490, 540, 600)
EYES_MASK = (240, 425, 600, 525)

# Per-emotion overrides
OVERRIDES = {
    "emotion-surprised": {
        "mouth_crop": (270, 455, 570, 630),
        "mouth_mask": (300, 475, 550, 610),
        "eyes_crop": (190, 370, 650, 545),
        "eyes_mask": (220, 400, 620, 520),
    },
    "emotion-ecstatic": {
        "mouth_crop": (275, 460, 565, 625),
        "mouth_mask": (305, 480, 545, 605),
    },
    "emotion-sleepy": {
        "eyes_crop": (210, 395, 630, 555),
        "eyes_mask": (240, 420, 600, 530),
    },
}

BASE_PROMPT = (
    "1girl, solo, masterpiece, best quality, ultra detailed, anime, "
    "beautiful detailed face, cute face, long purple hair, "
    "upper body, portrait, from chest up"
)


def img_to_b64(img):
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def inpaint(init_img, mask_region, prompt, neg, denoising=0.85):
    w, h = init_img.size
    mask = Image.new("RGB", (w, h), (0, 0, 0))
    draw = ImageDraw.Draw(mask)
    x1, y1, x2, y2 = mask_region
    draw.ellipse([x1 - 15, y1 - 15, x2 + 15, y2 + 15], fill=(255, 255, 255))

    payload = {
        "init_images": [img_to_b64(init_img)],
        "mask": img_to_b64(mask),
        "prompt": prompt,
        "negative_prompt": neg,
        "sampler_name": "DPM++ 2M",
        "scheduler": "Automatic",
        "steps": 30,
        "cfg_scale": 7,
        "width": w, "height": h,
        "denoising_strength": denoising,
        "seed": -1,
        "mask_blur": 6,
        "inpainting_fill": 1,
        "inpaint_full_res": True,
        "inpaint_full_res_padding": 48,
        "override_settings": {
            "sd_model_checkpoint": "miaomiaoHarem_v195.safetensors [57f9f07ce9]"
        },
    }
    resp = requests.post(f"{API_URL}/sdapi/v1/img2img", json=payload, timeout=300)
    resp.raise_for_status()
    return Image.open(BytesIO(base64.b64decode(resp.json()["images"][0])))


def extract_crop_with_alpha(original, inpainted, crop_box, mask_region):
    """
    Extract ONLY the changed pixels as a small RGBA crop.
    Alpha = difference between original and inpainted (feathered).
    """
    x1, y1, x2, y2 = crop_box
    mx1, my1, mx2, my2 = mask_region

    # Crop both images to the region
    orig_crop = original.crop(crop_box).convert("RGBA")
    inp_crop = inpainted.crop(crop_box).convert("RGBA")

    # Create alpha mask: white in the inpainted area, feathered edges
    alpha = Image.new("L", (x2 - x1, y2 - y1), 0)
    draw = ImageDraw.Draw(alpha)
    # Mask position relative to crop
    draw.ellipse([
        mx1 - x1 - 5, my1 - y1 - 5,
        mx2 - x1 + 5, my2 - y1 + 5
    ], fill=255)
    alpha = alpha.filter(ImageFilter.GaussianBlur(8))

    # Apply alpha to inpainted crop
    r, g, b, _ = inp_crop.split()
    result = Image.merge("RGBA", (r, g, b, alpha))
    return result


def get_regions(emotion):
    ov = OVERRIDES.get(emotion, {})
    return {
        "mouth_crop": ov.get("mouth_crop", MOUTH_CROP),
        "mouth_mask": ov.get("mouth_mask", MOUTH_MASK),
        "eyes_crop": ov.get("eyes_crop", EYES_CROP),
        "eyes_mask": ov.get("eyes_mask", EYES_MASK),
    }


def generate_for_emotion(emotion):
    src = AVATARS_DIR / f"{emotion}.png"
    if not src.exists():
        print(f"  [SKIP] {src}")
        return

    short = EMOTION_SHORT[emotion]
    img = Image.open(src).convert("RGB")
    regions = get_regions(emotion)

    # 1. Mouth open
    print(f"  mouth_open (inpainting)...")
    mouth_inp = inpaint(
        img, regions["mouth_mask"],
        f"{BASE_PROMPT}, open mouth, wide open mouth, speaking, teeth visible",
        "worst quality, low quality, blurry, closed mouth, lips together",
    )
    mouth_overlay = extract_crop_with_alpha(
        img, mouth_inp, regions["mouth_crop"], regions["mouth_mask"]
    )
    mouth_overlay.save(OUTPUT_DIR / f"{short}_mouth.png")

    # 2. Eyes closed
    print(f"  eyes_closed (inpainting)...")
    eyes_inp = inpaint(
        img, regions["eyes_mask"],
        f"{BASE_PROMPT}, closed eyes, both eyes closed, relaxed eyelids, eyes shut",
        "worst quality, low quality, blurry, open eyes, visible pupils, visible iris",
    )
    eyes_overlay = extract_crop_with_alpha(
        img, eyes_inp, regions["eyes_crop"], regions["eyes_mask"]
    )
    eyes_overlay.save(OUTPUT_DIR / f"{short}_eyes.png")

    # Save crop metadata for CSS positioning
    return {
        "mouth": {
            "file": f"{short}_mouth.png",
            "x": regions["mouth_crop"][0],
            "y": regions["mouth_crop"][1],
            "w": regions["mouth_crop"][2] - regions["mouth_crop"][0],
            "h": regions["mouth_crop"][3] - regions["mouth_crop"][1],
        },
        "eyes": {
            "file": f"{short}_eyes.png",
            "x": regions["eyes_crop"][0],
            "y": regions["eyes_crop"][1],
            "w": regions["eyes_crop"][2] - regions["eyes_crop"][0],
            "h": regions["eyes_crop"][3] - regions["eyes_crop"][1],
        },
    }


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    try:
        r = requests.get(f"{API_URL}/sdapi/v1/sd-models", timeout=10)
        r.raise_for_status()
        print(f"A1111 API ok")
    except Exception as e:
        print(f"A1111 error: {e}")
        sys.exit(1)

    targets = EMOTIONS
    if len(sys.argv) > 1:
        targets = [sys.argv[1]]

    metadata = {}
    start = time.time()

    for i, name in enumerate(targets):
        print(f"\n[{i+1}/{len(targets)}] {name}")
        meta = generate_for_emotion(name)
        if meta:
            metadata[EMOTION_SHORT[name]] = meta

    # Save positioning metadata as JSON
    meta_path = OUTPUT_DIR / "metadata.json"
    with open(meta_path, "w") as f:
        json.dump({"imgWidth": IMG_W, "imgHeight": IMG_H, "emotions": metadata}, f, indent=2)

    print(f"\nDone in {time.time()-start:.0f}s")
    print(f"Overlays: {OUTPUT_DIR}")
    print(f"Metadata: {meta_path}")

    # Show file sizes
    total = 0
    for p in OUTPUT_DIR.glob("*.png"):
        sz = p.stat().st_size
        total += sz
        print(f"  {p.name}: {sz//1024}KB")
    print(f"  Total: {total//1024}KB")


if __name__ == "__main__":
    main()
