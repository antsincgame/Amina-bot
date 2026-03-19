"""Патчи Rudrabha/Wav2Lip: PyTorch 2.6+ (weights_only), опечатка cv2.ROTATE."""

from __future__ import annotations

import sys
from pathlib import Path

_LOAD_OLD = """def _load(checkpoint_path):
 if device == 'cuda':
 checkpoint = torch.load(checkpoint_path)
 else:
 checkpoint = torch.load(checkpoint_path,
 map_location=lambda storage, loc: storage)
 return checkpoint"""

_LOAD_NEW = """def _load(checkpoint_path):
 load_kw = {}
 try:
  import inspect
  sig = inspect.signature(torch.load)
  if "weights_only" in sig.parameters:
   load_kw["weights_only"] = False
 except Exception:
  pass
 if device == 'cuda':
  checkpoint = torch.load(checkpoint_path, **load_kw)
 else:
  checkpoint = torch.load(
   checkpoint_path,
   map_location=lambda storage, loc: storage,
   **load_kw,
  )
 return checkpoint"""

_LOAD_OLD_TABS = (
    b"def _load(checkpoint_path):\n\tif device == 'cuda':\n\t\tcheckpoint = torch.load(checkpoint_path)\n\telse:\n"
    b"\t\tcheckpoint = torch.load(checkpoint_path,\n\t\t\t\t\t\t\t\tmap_location=lambda storage, loc: storage)\n"
    b"\treturn checkpoint"
).decode("ascii")

_LOAD_NEW_TABS = (
    "def _load(checkpoint_path):\n"
    "\tload_kw = {}\n"
    "\ttry:\n"
    "\t\timport inspect\n"
    "\t\tsig = inspect.signature(torch.load)\n"
    '\t\tif "weights_only" in sig.parameters:\n'
    "\t\t\tload_kw['weights_only'] = False\n"
    "\texcept Exception:\n"
    "\t\tpass\n"
    "\tif device == 'cuda':\n"
    "\t\tcheckpoint = torch.load(checkpoint_path, **load_kw)\n"
    "\telse:\n"
    "\t\tcheckpoint = torch.load(\n"
    "\t\t\tcheckpoint_path,\n"
    "\t\t\tmap_location=lambda storage, loc: storage,\n"
    "\t\t\t**load_kw,\n"
    "\t\t)\n"
    "\treturn checkpoint"
)


def main() -> None:
    arg = Path(sys.argv[1]).resolve()
    root = arg if arg.is_dir() else arg.parent
    inf = root / "inference.py" if arg.is_dir() else arg
    if not inf.is_file():
        print(f"[wav2lip-patch] missing {inf}", file=sys.stderr)
        sys.exit(1)

    text = inf.read_text(encoding="utf-8")
    if _LOAD_OLD in text:
        text = text.replace(_LOAD_OLD, _LOAD_NEW, 1)
        print("[wav2lip-patch] ok torch.load (spaces)")
    elif _LOAD_OLD_TABS in text:
        text = text.replace(_LOAD_OLD_TABS, _LOAD_NEW_TABS, 1)
        print("[wav2lip-patch] ok torch.load (tabs)")
    elif "weights_only" in text:
        print("[wav2lip-patch] _load already patched")
    else:
        print("[wav2lip-patch] _load pattern mismatch — проверьте версию Wav2Lip", file=sys.stderr)
        sys.exit(1)

    text = text.replace(
        "cv2.rotate(frame, cv2.cv2.ROTATE_90_CLOCKWISE)",
        "cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)",
    )
    inf.write_text(text, encoding="utf-8")
    print("[wav2lip-patch] ok cv2.ROTATE")


if __name__ == "__main__":
    main()
