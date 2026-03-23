"""
Генератор PNGTuber спрайтов для Амины через A1111 Inpainting API.

Для каждого из 11 аватаров создаёт 3 варианта:
  - mouth-open (рот открыт, глаза как на оригинале)
  - eyes-closed (глаза закрыты, рот как на оригинале)
  - mouth-open-eyes-closed (рот открыт + глаза закрыты)

Итого: 11 x 3 = 33 новых спрайта.
"""

import base64
import sys
import time
from io import BytesIO
from pathlib import Path

import requests
from PIL import Image, ImageDraw

API_URL = "http://127.0.0.1:7860"
AVATARS_DIR = Path(
    "C:/Users/Пользователь/OneDrive/Desktop/Amina-bot/bot/src/telegram/avatars"
)
OUTPUT_DIR = AVATARS_DIR / "pngtuber"

AVATAR_FILES = [
    "base-neutral",
    "emotion-angry",
    "emotion-ecstatic",
    "emotion-flirty",
    "emotion-happy",
    "emotion-loving",
    "emotion-sad",
    "emotion-sleepy",
    "emotion-smirk",
    "emotion-surprised",
    "emotion-thinking",
]

BASE_PROMPT_PREFIX = (
    "1girl, solo, masterpiece, best quality, ultra detailed, anime, "
    "beautiful detailed face, cute face, "
    "long purple hair, looking at viewer, "
    "upper body, portrait, from chest up"
)

NEGATIVE_BASE = (
    "worst quality, low quality, blurry, bad anatomy, extra fingers, deformed, ugly"
)

EMOTION_PROMPTS = {
    "base-neutral": "neutral expression, calm face",
    "emotion-angry": "angry expression, furrowed brows, fierce look",
    "emotion-ecstatic": "ecstatic expression, very happy, wide smile",
    "emotion-flirty": "flirty expression, playful smile",
    "emotion-happy": "happy expression, warm smile",
    "emotion-loving": "loving expression, dreamy look, blushing",
    "emotion-sad": "sad expression, tearful eyes, frowning",
    "emotion-sleepy": "sleepy expression, drowsy look",
    "emotion-smirk": "smirk expression, sly look",
    "emotion-surprised": "surprised expression, wide eyes",
    "emotion-thinking": "thinking expression, contemplative look",
}

# --- Маски: координаты для 832x1216 ---
MOUTH_REGION = (310, 490, 540, 600)
EYES_REGION = (240, 425, 600, 525)

EMOTION_MOUTH_OVERRIDES = {
    "emotion-surprised": (300, 475, 550, 610),
    "emotion-ecstatic": (305, 480, 545, 605),
    "emotion-angry": (315, 495, 535, 595),
}
EMOTION_EYES_OVERRIDES = {
    "emotion-surprised": (220, 400, 620, 520),
    "emotion-sleepy": (240, 420, 600, 530),
}


def img_to_b64(img: Image.Image) -> str:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def create_mask(
    width: int, height: int, regions: list[tuple[int, int, int, int]]
) -> Image.Image:
    mask = Image.new("RGB", (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(mask)
    for x1, y1, x2, y2 in regions:
        pad = 12
        draw.ellipse(
            [x1 - pad, y1 - pad, x2 + pad, y2 + pad], fill=(255, 255, 255)
        )
    return mask


def inpaint(
    init_image: Image.Image,
    mask: Image.Image,
    prompt: str,
    negative: str,
    denoising: float = 0.85,
) -> Image.Image:
    payload = {
        "init_images": [img_to_b64(init_image)],
        "mask": img_to_b64(mask),
        "prompt": prompt,
        "negative_prompt": negative,
        "sampler_name": "DPM++ 2M",
        "scheduler": "Automatic",
        "steps": 30,
        "cfg_scale": 7,
        "width": init_image.width,
        "height": init_image.height,
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


def generate_sprites_for_avatar(name: str) -> None:
    src_path = AVATARS_DIR / f"{name}.png"
    if not src_path.exists():
        print(f"  [SKIP] {src_path} not found")
        return

    img = Image.open(src_path).convert("RGB")
    w, h = img.size

    emotion_prompt = EMOTION_PROMPTS.get(name, "neutral expression")
    mouth_box = EMOTION_MOUTH_OVERRIDES.get(name, MOUTH_REGION)
    eyes_box = EMOTION_EYES_OVERRIDES.get(name, EYES_REGION)

    # --- 1. Mouth open ---
    print(f"  [1/3] {name} -> mouth-open")
    mouth_mask = create_mask(w, h, [mouth_box])
    mouth_prompt = (
        f"{BASE_PROMPT_PREFIX}, {emotion_prompt}, "
        "open mouth, wide open mouth, speaking loudly, teeth visible, tongue visible"
    )
    mouth_neg = f"{NEGATIVE_BASE}, closed mouth, lips together, sealed lips"
    mouth_img = inpaint(img, mouth_mask, mouth_prompt, mouth_neg, denoising=0.85)
    mouth_img.save(OUTPUT_DIR / f"{name}_mouth-open.png")

    # --- 2. Eyes closed ---
    print(f"  [2/3] {name} -> eyes-closed")
    eyes_mask = create_mask(w, h, [eyes_box])
    eyes_prompt = (
        f"{BASE_PROMPT_PREFIX}, {emotion_prompt}, "
        "closed eyes, both eyes closed, relaxed closed eyelids, eyes shut tight"
    )
    eyes_neg = f"{NEGATIVE_BASE}, open eyes, wide eyes, glowing eyes, visible pupils, visible iris"
    eyes_img = inpaint(img, eyes_mask, eyes_prompt, eyes_neg, denoising=0.85)
    eyes_img.save(OUTPUT_DIR / f"{name}_eyes-closed.png")

    # --- 3. Mouth open + eyes closed ---
    print(f"  [3/3] {name} -> mouth-open+eyes-closed")
    combo_mask = create_mask(w, h, [mouth_box, eyes_box])
    combo_prompt = (
        f"{BASE_PROMPT_PREFIX}, {emotion_prompt}, "
        "open mouth, wide open mouth, teeth visible, "
        "closed eyes, both eyes closed, relaxed closed eyelids"
    )
    combo_neg = (
        f"{NEGATIVE_BASE}, closed mouth, lips together, "
        "open eyes, wide eyes, visible pupils"
    )
    combo_img = inpaint(img, combo_mask, combo_prompt, combo_neg, denoising=0.85)
    combo_img.save(OUTPUT_DIR / f"{name}_mouth-open_eyes-closed.png")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    try:
        r = requests.get(f"{API_URL}/sdapi/v1/sd-models", timeout=10)
        r.raise_for_status()
        print(f"A1111 API ok. Models: {len(r.json())}")
    except Exception as e:
        print(f"A1111 API error: {e}")
        sys.exit(1)

    targets = AVATAR_FILES
    if len(sys.argv) > 1:
        targets = [sys.argv[1]]

    total = len(targets) * 3
    done = 0
    start = time.time()

    for name in targets:
        print(f"\n{'='*50}")
        print(f"Avatar: {name}")
        print(f"{'='*50}")
        generate_sprites_for_avatar(name)
        done += 3
        elapsed = time.time() - start
        per_sprite = elapsed / done if done else 0
        remaining = (total - done) * per_sprite
        print(f"  Done {done}/{total} | ~{remaining:.0f}s remaining")

    print(f"\nComplete! {done} sprites in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
