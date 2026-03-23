"""
Generator of layer-decomposed assets for Pseudo-Live2D animation.

For each of 11 emotions, generates transparent PNG layers:
  Shared: body, hair_back, hair_front
  Per-emotion: face, eyes_open, eyelids (closed eyes), mouth_closed, mouth_open

Uses A1111 inpainting API + PIL for layer extraction.
"""

import base64
import sys
import time
from io import BytesIO
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFilter

API_URL = "http://127.0.0.1:7860"
AVATARS_DIR = Path(
    "C:/Users/Пользователь/OneDrive/Desktop/Amina-bot/bot/src/telegram/avatars"
)
LAYERS_DIR = AVATARS_DIR / "layers"

EMOTIONS = [
    "base-neutral", "emotion-angry", "emotion-ecstatic", "emotion-flirty",
    "emotion-happy", "emotion-loving", "emotion-sad", "emotion-sleepy",
    "emotion-smirk", "emotion-surprised", "emotion-thinking",
]

# Emotion short names for folder naming
EMOTION_SHORT = {
    "base-neutral": "neutral", "emotion-angry": "angry",
    "emotion-ecstatic": "ecstatic", "emotion-flirty": "flirty",
    "emotion-happy": "happy", "emotion-loving": "loving",
    "emotion-sad": "sad", "emotion-sleepy": "sleepy",
    "emotion-smirk": "smirk", "emotion-surprised": "surprised",
    "emotion-thinking": "thinking",
}

# Region definitions for 832x1216 images
# (x1, y1, x2, y2) - bounding boxes for each anatomical zone
REGIONS = {
    "eye_left":   (255, 425, 405, 520),
    "eye_right":  (425, 425, 585, 520),
    "mouth":      (320, 495, 530, 600),
    "face":       (220, 340, 620, 620),
    "body_top":   580,  # Y coordinate where body starts
    "hair_split": 380,  # Y coordinate separating hair_back from face area
}

# Override regions for specific emotions
EMOTION_REGION_OVERRIDES = {
    "emotion-surprised": {
        "eye_left":  (240, 400, 415, 520),
        "eye_right": (415, 400, 600, 520),
        "mouth":     (310, 480, 540, 610),
    },
    "emotion-sleepy": {
        "eye_left":  (255, 420, 405, 530),
        "eye_right": (425, 420, 585, 530),
    },
}

BASE_PROMPT = (
    "1girl, solo, masterpiece, best quality, ultra detailed, anime, "
    "beautiful detailed face, cute face, long purple hair, "
    "upper body, portrait, from chest up"
)

NEGATIVE_PROMPT = (
    "worst quality, low quality, blurry, bad anatomy, extra fingers, deformed, ugly"
)


def img_to_b64(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def b64_to_img(b64: str) -> Image.Image:
    return Image.open(BytesIO(base64.b64decode(b64)))


def create_ellipse_mask(w: int, h: int, box: tuple, pad: int = 20) -> Image.Image:
    """Black mask with white ellipse at box region."""
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    x1, y1, x2, y2 = box
    draw.ellipse([x1 - pad, y1 - pad, x2 + pad, y2 + pad], fill=255)
    return mask


def create_rect_mask(w: int, h: int, box: tuple, pad: int = 10) -> Image.Image:
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    x1, y1, x2, y2 = box
    draw.rectangle([x1 - pad, y1 - pad, x2 + pad, y2 + pad], fill=255)
    return mask


def inpaint_a1111(
    init_img: Image.Image, mask: Image.Image,
    prompt: str, neg: str, denoising: float = 0.85
) -> Image.Image:
    """Call A1111 img2img inpainting API."""
    # Convert L mask to RGB for API
    mask_rgb = Image.merge("RGB", [mask, mask, mask])
    payload = {
        "init_images": [img_to_b64(init_img)],
        "mask": img_to_b64(mask_rgb),
        "prompt": prompt,
        "negative_prompt": neg,
        "sampler_name": "DPM++ 2M",
        "scheduler": "Automatic",
        "steps": 30,
        "cfg_scale": 7,
        "width": init_img.width,
        "height": init_img.height,
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
    return b64_to_img(resp.json()["images"][0])


def extract_region_as_layer(img: Image.Image, mask: Image.Image) -> Image.Image:
    """Extract a region from image using mask, return RGBA with transparency."""
    rgba = img.convert("RGBA")
    # Apply mask as alpha channel
    result = Image.new("RGBA", img.size, (0, 0, 0, 0))
    result.paste(rgba, mask=mask)
    return result


def create_body_layer(img: Image.Image) -> Image.Image:
    """Extract body (below neck) as RGBA layer."""
    w, h = img.size
    body_y = REGIONS["body_top"]
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    # Soft gradient at neck line
    for y in range(body_y - 30, body_y + 10):
        alpha = int(255 * max(0, min(1, (y - (body_y - 30)) / 40)))
        draw.line([(0, y), (w, y)], fill=alpha)
    draw.rectangle([0, body_y + 10, w, h], fill=255)
    return extract_region_as_layer(img, mask)


def create_face_layer(img: Image.Image, regions: dict) -> Image.Image:
    """Extract face region (without eyes and mouth - those are separate layers)."""
    w, h = img.size
    face_box = regions["face"]

    # Start with face ellipse
    mask = create_ellipse_mask(w, h, face_box, pad=10)

    # Cut out eyes and mouth (they'll be separate layers)
    draw = ImageDraw.Draw(mask)
    for key in ["eye_left", "eye_right", "mouth"]:
        box = regions[key]
        draw.ellipse([box[0] - 5, box[1] - 5, box[2] + 5, box[3] + 5], fill=0)

    # Feather edges
    mask = mask.filter(ImageFilter.GaussianBlur(3))
    return extract_region_as_layer(img, mask)


def create_eyes_layer(img: Image.Image, regions: dict) -> Image.Image:
    """Extract both eyes as a single RGBA layer."""
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    for key in ["eye_left", "eye_right"]:
        box = regions[key]
        eye_mask = create_ellipse_mask(w, h, box, pad=8)
        mask = Image.composite(eye_mask, mask, eye_mask)
    mask = mask.filter(ImageFilter.GaussianBlur(2))
    return extract_region_as_layer(img, mask)


def create_eyelids_layer(img: Image.Image, regions: dict) -> Image.Image:
    """Generate closed eyes via inpainting, extract as RGBA layer."""
    w, h = img.size
    # Create mask covering both eyes
    mask = Image.new("L", (w, h), 0)
    for key in ["eye_left", "eye_right"]:
        box = regions[key]
        m = create_ellipse_mask(w, h, box, pad=12)
        mask = Image.composite(m, mask, m)

    mask_rgb = Image.merge("RGB", [mask, mask, mask])

    # Inpaint closed eyes
    closed_eyes = inpaint_a1111(
        img, mask,
        f"{BASE_PROMPT}, closed eyes, both eyes closed, relaxed eyelids, eyes shut",
        f"{NEGATIVE_PROMPT}, open eyes, visible pupils, visible iris",
        denoising=0.85
    )
    # Extract only the eye region from inpainted result
    mask_feathered = mask.filter(ImageFilter.GaussianBlur(2))
    return extract_region_as_layer(closed_eyes, mask_feathered)


def create_mouth_closed_layer(img: Image.Image, regions: dict) -> Image.Image:
    """Extract closed mouth as RGBA layer."""
    w, h = img.size
    box = regions["mouth"]
    mask = create_ellipse_mask(w, h, box, pad=10)
    mask = mask.filter(ImageFilter.GaussianBlur(2))
    return extract_region_as_layer(img, mask)


def create_mouth_open_layer(img: Image.Image, regions: dict) -> Image.Image:
    """Generate open mouth via inpainting, extract as RGBA layer."""
    w, h = img.size
    box = regions["mouth"]
    mask = create_ellipse_mask(w, h, box, pad=15)

    open_mouth = inpaint_a1111(
        img, mask,
        f"{BASE_PROMPT}, open mouth, wide open mouth, speaking, teeth visible",
        f"{NEGATIVE_PROMPT}, closed mouth, lips together",
        denoising=0.85
    )
    mask_feathered = mask.filter(ImageFilter.GaussianBlur(2))
    return extract_region_as_layer(open_mouth, mask_feathered)


def create_hair_layers(img: Image.Image) -> tuple[Image.Image, Image.Image]:
    """
    Split hair into back and front layers using color segmentation.
    Hair is purple/pink - segment by hue.
    """
    w, h = img.size
    arr = np.array(img.convert("RGB")).astype(float)

    # Detect purple/pink hair pixels by color
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]

    # Purple hair: high R, low-mid G, high B
    is_purple = (
        (r > 100) & (b > 100) & (g < r * 0.85) &
        ((r + b) > (g * 2.5))
    )
    # Pink/light hair: high R, high B, relatively high overall
    is_pink = (
        (r > 150) & (b > 130) & (g < 180) &
        ((r + b) > 350)
    )
    is_hair = is_purple | is_pink

    # Create hair mask
    hair_mask = Image.fromarray((is_hair * 255).astype(np.uint8))
    # Dilate to fill gaps
    hair_mask = hair_mask.filter(ImageFilter.MaxFilter(5))
    hair_mask = hair_mask.filter(ImageFilter.GaussianBlur(3))

    # Split into back (behind face) and front (in front of face)
    face_box = REGIONS["face"]
    face_center_x = (face_box[0] + face_box[2]) // 2

    # Hair back: everything outside the face zone
    hair_back_mask = hair_mask.copy()
    back_arr = np.array(hair_back_mask)
    # Keep hair that's to the sides or behind the head
    face_region = np.zeros_like(back_arr)
    fx1, fy1, fx2, fy2 = face_box
    face_region[fy1:fy2, fx1:fx2] = 255
    back_arr = np.where(face_region > 0, 0, back_arr)
    hair_back_mask = Image.fromarray(back_arr)
    hair_back_mask = hair_back_mask.filter(ImageFilter.GaussianBlur(2))

    # Hair front: bangs/fringe over the face
    hair_front_mask = hair_mask.copy()
    front_arr = np.array(hair_front_mask)
    # Only keep hair that overlaps with upper face area
    front_region = np.zeros_like(front_arr)
    front_region[fy1:fy1 + 120, fx1 - 30:fx2 + 30] = 255  # Bangs area
    front_arr = np.where(front_region > 0, front_arr, 0)
    hair_front_mask = Image.fromarray(front_arr)
    hair_front_mask = hair_front_mask.filter(ImageFilter.GaussianBlur(2))

    hair_back = extract_region_as_layer(img, hair_back_mask)
    hair_front = extract_region_as_layer(img, hair_front_mask)

    return hair_back, hair_front


def get_regions(emotion_name: str) -> dict:
    """Get region definitions, applying emotion-specific overrides."""
    regions = dict(REGIONS)
    if emotion_name in EMOTION_REGION_OVERRIDES:
        regions.update(EMOTION_REGION_OVERRIDES[emotion_name])
    return regions


def generate_layers_for_emotion(emotion_name: str, is_first: bool = False) -> None:
    """Generate all layers for a single emotion."""
    src = AVATARS_DIR / f"{emotion_name}.png"
    if not src.exists():
        print(f"  [SKIP] {src} not found")
        return

    short = EMOTION_SHORT[emotion_name]
    out_dir = LAYERS_DIR / short
    out_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(src).convert("RGB")
    regions = get_regions(emotion_name)

    # Shared layers (only generate once, from neutral)
    if is_first:
        shared_dir = LAYERS_DIR / "shared"
        shared_dir.mkdir(parents=True, exist_ok=True)

        print("  [shared] body")
        body = create_body_layer(img)
        body.save(shared_dir / "body.png")

        print("  [shared] hair_back + hair_front")
        hair_back, hair_front = create_hair_layers(img)
        hair_back.save(shared_dir / "hair_back.png")
        hair_front.save(shared_dir / "hair_front.png")

    # Per-emotion layers
    print(f"  [1/5] face")
    face = create_face_layer(img, regions)
    face.save(out_dir / "face.png")

    print(f"  [2/5] eyes_open")
    eyes = create_eyes_layer(img, regions)
    eyes.save(out_dir / "eyes_open.png")

    print(f"  [3/5] eyelids (inpainting)")
    eyelids = create_eyelids_layer(img, regions)
    eyelids.save(out_dir / "eyelids.png")

    print(f"  [4/5] mouth_closed")
    mouth_closed = create_mouth_closed_layer(img, regions)
    mouth_closed.save(out_dir / "mouth_closed.png")

    print(f"  [5/5] mouth_open (inpainting)")
    mouth_open = create_mouth_open_layer(img, regions)
    mouth_open.save(out_dir / "mouth_open.png")


def main() -> None:
    LAYERS_DIR.mkdir(parents=True, exist_ok=True)

    # Check A1111 API
    try:
        r = requests.get(f"{API_URL}/sdapi/v1/sd-models", timeout=10)
        r.raise_for_status()
        print(f"A1111 API ok. Models: {len(r.json())}")
    except Exception as e:
        print(f"A1111 API error: {e}")
        sys.exit(1)

    targets = EMOTIONS
    if len(sys.argv) > 1:
        targets = [sys.argv[1]]

    start = time.time()
    for i, name in enumerate(targets):
        print(f"\n{'='*50}")
        print(f"[{i+1}/{len(targets)}] {name}")
        print(f"{'='*50}")
        generate_layers_for_emotion(name, is_first=(i == 0))
        elapsed = time.time() - start
        print(f"  Elapsed: {elapsed:.0f}s")

    print(f"\nDone! Layers in {LAYERS_DIR}")


if __name__ == "__main__":
    main()
