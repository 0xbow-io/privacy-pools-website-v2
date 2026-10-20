"""Regenerate complete WOFF2 fonts: pip install 'fonttools[woff]==4.60.2'."""
import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
output = root / "assets/fonts"
output.mkdir(parents=True, exist_ok=True)
geist = root / "node_modules/@expo-google-fonts/geist"
icons = root / "node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts"
sources = [geist / weight / f"Geist_{weight}.ttf" for weight in (
    "400Regular", "500Medium", "600SemiBold", "700Bold",
)] + [icons / name for name in ("Ionicons.ttf", "MaterialIcons.ttf")]

manifest = []
for source in sources:
    original = TTFont(source, recalcTimestamp=False)
    destination = output / f"{source.stem}.woff2"
    original.flavor = "woff2"
    original.save(destination)
    compressed = TTFont(destination)
    # Compression must retain every character and its advance width.
    assert compressed.getBestCmap() == original.getBestCmap()
    assert compressed["hmtx"].metrics == original["hmtx"].metrics
    assert compressed.getGlyphOrder() == original.getGlyphOrder()
    manifest.append({
        "source": str(source.relative_to(root)),
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "woff2": destination.name,
        "bytes": destination.stat().st_size,
        "glyphs": len(original.getGlyphOrder()),
    })

(output / "sources.json").write_text(json.dumps(manifest, indent=2) + "\n")
