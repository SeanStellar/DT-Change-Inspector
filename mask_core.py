from __future__ import annotations

from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw, ImageFilter


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}
MASK_WHITE_THRESHOLD = 200
LEGACY_MASK_FILL_RGBA = (255, 40, 40, 105)
COLOR_MASK_ALPHA = 118
DISPLAY_MASK_EDGE_RGBA = (255, 0, 0, 255)
LABEL_COUNT = 256
LABEL_MIN = 0
LABEL_MAX = 255


def default_label_color(label_id: int) -> tuple[int, int, int]:
    """Return one of 256 deterministic, unique, non-black class colors."""
    if not LABEL_MIN <= label_id <= LABEL_MAX:
        raise ValueError("标签编号必须在 0 到 255 之间")
    code = (label_id * 73) % LABEL_COUNT
    return (
        48 + (code & 0b111) * 29,
        48 + ((code >> 3) & 0b111) * 29,
        64 + ((code >> 6) & 0b11) * 60,
    )


def make_default_label_definitions() -> dict[int, dict[str, str]]:
    return {
        label_id: {
            "name": f"标签 {label_id}",
            "color": rgb_to_hex(default_label_color(label_id)),
            "pinned": False,
        }
        for label_id in range(LABEL_MIN, LABEL_MAX + 1)
    }


def normalize_label_definitions(raw) -> dict[int, dict[str, str]]:
    """Normalize persisted label data and guarantee 256 distinct colors."""
    defaults = make_default_label_definitions()
    raw = raw if isinstance(raw, dict) else {}
    # Version 2.2 used IDs 1..256. Preserve all entries when migrating to a
    # byte-sized 0..255 table by mapping the former 256 entry to ID 0.
    legacy_256 = (
        ("256" in raw or 256 in raw)
        and "0" not in raw
        and 0 not in raw
    )
    normalized: dict[int, dict[str, str]] = {}
    used_colors: set[tuple[int, int, int]] = set()
    for label_id in range(LABEL_MIN, LABEL_MAX + 1):
        source_id = 256 if legacy_256 and label_id == 0 else label_id
        value = raw.get(str(source_id), raw.get(source_id, {}))
        value = value if isinstance(value, dict) else {}
        name = value.get("name")
        if not isinstance(name, str) or not name.strip():
            name = defaults[label_id]["name"]
        name = name.strip()[:64]
        try:
            color = hex_to_rgb(value.get("color", defaults[label_id]["color"]))
        except (TypeError, ValueError):
            color = default_label_color(label_id)
        if color == (0, 0, 0) or color in used_colors:
            for offset in range(LABEL_COUNT):
                fallback_id = (label_id + offset) % LABEL_COUNT
                fallback = default_label_color(fallback_id)
                if fallback not in used_colors:
                    color = fallback
                    break
        used_colors.add(color)
        normalized[label_id] = {
            "name": name,
            "color": rgb_to_hex(color),
            "pinned": bool(value.get("pinned", False)),
        }
    return normalized


def find_pairs(
    before_dir: Path,
    after_dir: Path,
    mask_dir: Path | None = None,
) -> list[tuple[str, Path, Path, Path | None]]:
    """Return exact-name before/after pairs and their best matching mask."""
    after = {
        path.name: path
        for path in after_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTS
    }
    before = {
        path.name: path
        for path in before_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTS
    }

    mask_by_name: dict[str, Path] = {}
    mask_by_stem: dict[str, Path] = {}
    if mask_dir and mask_dir.exists():
        for path in sorted(mask_dir.iterdir()):
            if not path.is_file() or path.suffix.lower() not in IMAGE_EXTS:
                continue
            mask_by_name[path.name] = path
            mask_by_stem.setdefault(path.stem, path)

    pairs: list[tuple[str, Path, Path, Path | None]] = []
    for name in sorted(after.keys() & before.keys()):
        stem = Path(name).stem
        mask_path = mask_by_name.get(name)
        if not mask_path:
            for candidate in (
                stem,
                f"{stem}_mask",
                f"{stem}-mask",
                f"{stem}_label",
                f"{stem}-label",
                f"mask_{stem}",
            ):
                mask_path = mask_by_stem.get(candidate)
                if mask_path:
                    break
        pairs.append((name, before[name], after[name], mask_path))
    return pairs


def file_cache_key(path: Path) -> tuple[str, int, int]:
    stat = path.stat()
    return str(path.resolve()), stat.st_mtime_ns, stat.st_size


def is_grayscale_mask(mask: Image.Image) -> bool:
    return mask.mode in {"1", "L", "LA", "I", "I;16", "F"}


def _max_channel(image: Image.Image) -> Image.Image:
    red, green, blue = image.convert("RGB").split()
    return ImageChops.lighter(ImageChops.lighter(red, green), blue)


def _make_red_outline(
    edge_strength: Image.Image,
    output_size: tuple[int, int],
) -> Image.Image:
    """Return a solid red, screen-space outline without modifying mask pixels."""
    edge_alpha = edge_strength.point(
        lambda pixel: DISPLAY_MASK_EDGE_RGBA[3] if pixel else 0
    )
    edge_alpha = edge_alpha.filter(ImageFilter.MaxFilter(3))
    edge = Image.new("RGBA", output_size, DISPLAY_MASK_EDGE_RGBA[:3] + (0,))
    edge.putalpha(edge_alpha)
    return edge


def _transform_extent(
    image: Image.Image,
    output_size: tuple[int, int],
    source_box: tuple[float, float, float, float],
    resample: Image.Resampling,
) -> Image.Image:
    return image.transform(
        output_size,
        Image.Transform.EXTENT,
        source_box,
        resample=resample,
    )


def render_image_viewport(
    image: Image.Image,
    output_size: tuple[int, int],
    source_box: tuple[float, float, float, float],
    *,
    fast: bool = False,
) -> Image.Image:
    """Render only the visible source rectangle instead of resizing the full image."""
    resample = Image.Resampling.BILINEAR if fast else Image.Resampling.BICUBIC
    return _transform_extent(image, output_size, source_box, resample)


def render_mask_viewport(
    mask: Image.Image,
    source_size: tuple[int, int],
    output_size: tuple[int, int],
    source_box: tuple[float, float, float, float],
    *,
    fast: bool = False,
    label_colors: dict[int, tuple[int, int, int]] | None = None,
) -> Image.Image:
    """Render a binary or multi-color mask as a transparent RGBA overlay."""
    grayscale = is_grayscale_mask(mask) and "A" not in mask.getbands()
    has_alpha = not grayscale and "A" in mask.getbands()
    working = mask.convert("L" if grayscale else "RGB")
    coverage = mask.getchannel("A") if has_alpha else None
    if working.size != source_size:
        working = working.resize(source_size, Image.Resampling.NEAREST)
        if coverage is not None:
            coverage = coverage.resize(source_size, Image.Resampling.NEAREST)
    working = _transform_extent(
        working,
        output_size,
        source_box,
        Image.Resampling.NEAREST,
    )
    if coverage is not None:
        coverage = _transform_extent(
            coverage,
            output_size,
            source_box,
            Image.Resampling.NEAREST,
        )

    if grayscale and label_colors is not None:
        palette = []
        for label_id in range(LABEL_COUNT):
            palette.extend(label_colors.get(label_id, (label_id, label_id, label_id)))
        indexed = working.convert("P")
        indexed.putpalette(palette)
        overlay = indexed.convert("RGBA")
        alpha = working.point(lambda pixel: COLOR_MASK_ALPHA if pixel else 0)
        overlay.putalpha(alpha)
        if fast:
            return overlay
        edge = _make_red_outline(
            working.filter(ImageFilter.FIND_EDGES),
            output_size,
        )
        return Image.alpha_composite(overlay, edge)

    if grayscale:
        alpha = working.point(
            lambda pixel: LEGACY_MASK_FILL_RGBA[3]
            if pixel >= MASK_WHITE_THRESHOLD
            else 0
        )
        solid = alpha.point(lambda pixel: 255 if pixel else 0)
        overlay = Image.new("RGBA", output_size, LEGACY_MASK_FILL_RGBA[:3] + (0,))
        overlay.putalpha(alpha)
        if fast:
            return overlay
        edge = _make_red_outline(
            solid.filter(ImageFilter.FIND_EDGES),
            output_size,
        )
        return Image.alpha_composite(overlay, edge)

    rgb = working.convert("RGB")
    if label_colors is not None:
        red, green, blue = rgb.split()
        channel_difference = ImageChops.lighter(
            ImageChops.difference(red, green),
            ImageChops.difference(red, blue),
        )
        encoded = channel_difference.point(lambda pixel: 255 if pixel == 0 else 0)
        encoded_pixels = coverage or red.point(lambda pixel: 255 if pixel else 0)
        encoded = ImageChops.multiply(encoded, encoded_pixels)
        palette = []
        for label_id in range(LABEL_COUNT):
            palette.extend(label_colors.get(label_id, (label_id, label_id, label_id)))
        indexed = red.convert("P")
        indexed.putpalette(palette)
        rgb.paste(indexed.convert("RGB"), (0, 0), encoded)
    foreground = coverage or _max_channel(rgb).point(lambda pixel: 255 if pixel else 0)
    alpha = foreground.point(lambda pixel: COLOR_MASK_ALPHA if pixel else 0)
    overlay = rgb.convert("RGBA")
    overlay.putalpha(alpha)
    if fast:
        return overlay

    # FIND_EDGES on each color channel retains boundaries between adjacent labels.
    edge_strength = _max_channel(rgb.filter(ImageFilter.FIND_EDGES))
    if coverage is not None:
        edge_strength = ImageChops.lighter(
            edge_strength,
            coverage.filter(ImageFilter.FIND_EDGES),
        )
    edge = _make_red_outline(edge_strength, output_size)
    return Image.alpha_composite(overlay, edge)


def load_mask_for_edit(path: Path, source_size: tuple[int, int]) -> Image.Image:
    with Image.open(path) as opened:
        if "A" in opened.getbands():
            mode = "RGBA"
        else:
            mode = "L" if is_grayscale_mask(opened) else "RGB"
        mask = opened.convert(mode)
        mask.load()
    if mask.size != source_size:
        mask = mask.resize(source_size, Image.Resampling.NEAREST)
    return mask


def save_mask_atomic(mask: Image.Image, target: Path) -> None:
    """Save a mask through a sibling temporary file, then replace atomically."""
    temporary = target.with_name(f".{target.stem}.masktool_tmp{target.suffix}")
    save_options = {}
    if target.suffix.lower() == ".png":
        # Level 1 is substantially faster on large masks and remains lossless.
        save_options = {"compress_level": 1, "optimize": False}
    try:
        mask.save(temporary, **save_options)
        temporary.replace(target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def paint_polygon(
    mask: Image.Image,
    points: Iterable[tuple[int, int]],
    color: tuple[int, int, int],
    *,
    erase: bool = False,
) -> Image.Image:
    """Paint a class-color polygon; adding color upgrades legacy masks to RGB."""
    if erase:
        fill: int | tuple[int, int, int] | tuple[int, int, int, int]
        if "A" in mask.getbands():
            output = mask.convert("RGB")
            fill = (0, 0, 0)
        else:
            fill = 0 if is_grayscale_mask(mask) else (0, 0, 0)
            output = mask.copy()
    else:
        # Always flatten to RGB: transparent pixels from an older/broken Mask
        # become their stored black background, while only this polygon gets
        # the selected category color.
        output = mask.convert("RGB")
        fill = color
    ImageDraw.Draw(output).polygon(list(points), fill=fill)
    return output


def erase_connected_region(
    mask: Image.Image,
    point: tuple[int, int],
) -> tuple[Image.Image, int]:
    """Erase the four-connected binary region or exact RGB label at point."""
    has_alpha = "A" in mask.getbands()
    grayscale = is_grayscale_mask(mask) and not has_alpha
    if has_alpha:
        output = mask.convert("RGB")
        has_alpha = False
    else:
        output = mask.convert("L" if grayscale else "RGB")
    width, height = output.size
    start_x, start_y = point
    if not (0 <= start_x < width and 0 <= start_y < height):
        return output, 0

    pixels = output.load()
    target = pixels[start_x, start_y]
    if grayscale:
        if target == 0:
            return output, 0
        empty: int | tuple[int, int, int] = 0
    else:
        if target == (0, 0, 0):
            return output, 0
        empty = (0, 0, 0)

    # Scanline flood fill processes horizontal runs instead of queueing every
    # pixel. On large solid regions this is over twice as fast and uses much
    # less Python-object memory than a pixel-by-pixel breadth-first search.
    stack = [(start_x, start_y)]
    deleted = 0
    while stack:
        x, y = stack.pop()
        while x >= 0 and pixels[x, y] == target:
            x -= 1
        x += 1
        span_above = False
        span_below = False
        while x < width and pixels[x, y] == target:
            pixels[x, y] = empty
            deleted += 1
            if y > 0:
                matches_above = pixels[x, y - 1] == target
                if matches_above and not span_above:
                    stack.append((x, y - 1))
                span_above = matches_above
            if y + 1 < height:
                matches_below = pixels[x, y + 1] == target
                if matches_below and not span_below:
                    stack.append((x, y + 1))
                span_below = matches_below
            x += 1
    return output, deleted


def contrasting_text_color(rgb: tuple[int, int, int]) -> str:
    luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    return "#111111" if luminance >= 150 else "#ffffff"


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.strip().lstrip("#")
    if len(value) != 6:
        raise ValueError("颜色必须是 #RRGGBB 格式")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def rgb_to_hex(value: tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(*value)
