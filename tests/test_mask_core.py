from __future__ import annotations

import unittest
from unittest.mock import MagicMock
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image, ImageDraw

from mask_core import (
    LABEL_COUNT,
    LABEL_MAX,
    LABEL_MIN,
    default_label_color,
    erase_connected_region,
    find_pairs,
    hex_to_rgb,
    make_default_label_definitions,
    normalize_label_definitions,
    paint_polygon,
    render_mask_viewport,
    rgb_to_hex,
    save_mask_atomic,
)


class PairingTests(unittest.TestCase):
    def test_exact_pair_and_mask_aliases(self) -> None:
        def fake_file(name: str):
            path = MagicMock()
            path.name = name
            path.stem = name.rsplit(".", 1)[0]
            path.suffix = "." + name.rsplit(".", 1)[1]
            path.is_file.return_value = True
            path.__lt__ = lambda left, right: left.name < right.name
            return path

        before_file = fake_file("tile.png")
        after_file = fake_file("tile.png")
        mask_file = fake_file("tile_mask.png")
        before = MagicMock()
        after = MagicMock()
        mask = MagicMock()
        before.iterdir.return_value = [before_file]
        after.iterdir.return_value = [after_file]
        mask.exists.return_value = True
        mask.iterdir.return_value = [mask_file]
        pairs = find_pairs(before, after, mask)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0][0], "tile.png")
        self.assertIs(pairs[0][3], mask_file)


class ColorMaskTests(unittest.TestCase):
    def test_256_default_label_colors_are_unique_and_non_black(self) -> None:
        labels = make_default_label_definitions()
        self.assertEqual(len(labels), LABEL_COUNT)
        colors = {hex_to_rgb(value["color"]) for value in labels.values()}
        self.assertEqual(len(colors), LABEL_COUNT)
        self.assertNotIn((0, 0, 0), colors)
        self.assertEqual(set(labels), set(range(LABEL_MIN, LABEL_MAX + 1)))
        self.assertEqual(hex_to_rgb(labels[0]["color"]), default_label_color(0))
        self.assertEqual(hex_to_rgb(labels[255]["color"]), default_label_color(255))

    def test_label_names_are_customizable_and_duplicate_colors_are_repaired(self) -> None:
        labels = normalize_label_definitions(
            {
                "1": {"name": "建筑", "color": "#123456"},
                "2": {"name": "水体", "color": "#123456"},
            }
        )
        self.assertEqual(labels[1]["name"], "建筑")
        self.assertEqual(labels[2]["name"], "水体")
        self.assertEqual(labels[1]["color"], "#123456")
        colors = [value["color"] for value in labels.values()]
        self.assertEqual(len(set(colors)), LABEL_COUNT)

    def test_legacy_1_to_256_labels_migrate_256_to_zero(self) -> None:
        labels = normalize_label_definitions(
            {
                "1": {"name": "建筑", "color": "#123456", "pinned": True},
                "256": {"name": "旧标签256", "color": "#ABCDEF"},
            }
        )
        self.assertEqual(labels[1]["name"], "建筑")
        self.assertTrue(labels[1]["pinned"])
        self.assertEqual(labels[0]["name"], "旧标签256")
        self.assertNotIn(256, labels)

    def test_custom_white_label_region_stays_white_in_overlay(self) -> None:
        mask = Image.new("RGB", (12, 12), (0, 0, 0))
        ImageDraw.Draw(mask).rectangle((2, 2, 9, 9), fill=(255, 255, 255))
        overlay = render_mask_viewport(
            mask,
            mask.size,
            mask.size,
            (0, 0, 12, 12),
            fast=True,
        )
        self.assertEqual(overlay.getpixel((5, 5))[:3], (255, 255, 255))
        self.assertGreater(overlay.getpixel((5, 5))[3], 0)

    def test_multiple_colors_are_preserved(self) -> None:
        mask = Image.new("RGB", (64, 64), (0, 0, 0))
        mask = paint_polygon(mask, [(2, 2), (30, 2), (30, 30)], (255, 0, 0))
        mask = paint_polygon(mask, [(34, 34), (62, 34), (62, 62)], (0, 255, 0))
        self.assertEqual(mask.getpixel((10, 10)), (255, 0, 0))
        self.assertEqual(mask.getpixel((50, 50)), (0, 255, 0))

        overlay = render_mask_viewport(mask, mask.size, mask.size, (0, 0, 64, 64))
        self.assertGreater(overlay.getpixel((10, 10))[3], 0)
        self.assertEqual(overlay.getpixel((10, 10))[:3], (255, 0, 0))
        self.assertGreater(overlay.getpixel((55, 45))[3], 0)
        self.assertEqual(overlay.getpixel((55, 45))[:3], (0, 255, 0))

    def test_display_overlay_adds_red_outline_without_changing_mask(self) -> None:
        mask = Image.new("RGB", (24, 24), (0, 0, 0))
        ImageDraw.Draw(mask).rectangle((5, 5, 18, 18), fill=(40, 200, 80))
        original = mask.tobytes()

        overlay = render_mask_viewport(
            mask,
            mask.size,
            mask.size,
            (0, 0, 24, 24),
        )

        self.assertEqual(overlay.getpixel((5, 12)), (255, 0, 0, 255))
        self.assertEqual(overlay.getpixel((4, 12)), (255, 0, 0, 255))
        self.assertEqual(overlay.getpixel((2, 12))[3], 0)
        self.assertEqual(overlay.getpixel((12, 12))[:3], (40, 200, 80))
        self.assertGreater(overlay.getpixel((12, 12))[3], 0)
        self.assertEqual(overlay.getpixel((0, 0))[3], 0)
        self.assertEqual(mask.tobytes(), original)

    def test_legacy_binary_mask_is_supported(self) -> None:
        mask = Image.new("L", (32, 32), 0)
        ImageDraw.Draw(mask).rectangle((5, 5, 20, 20), fill=255)
        overlay = render_mask_viewport(mask, mask.size, mask.size, (0, 0, 32, 32))
        self.assertEqual(overlay.getpixel((10, 10))[:3], (255, 40, 40))
        self.assertGreater(overlay.getpixel((10, 10))[3], 0)
        self.assertEqual(overlay.getpixel((0, 0))[3], 0)

    def test_connected_erase_stops_at_another_color(self) -> None:
        mask = Image.new("RGB", (30, 20), (0, 0, 0))
        draw = ImageDraw.Draw(mask)
        draw.rectangle((1, 1, 14, 18), fill=(255, 0, 0))
        draw.rectangle((15, 1, 28, 18), fill=(0, 255, 0))
        erased, count = erase_connected_region(mask, (5, 5))
        self.assertEqual(count, 14 * 18)
        self.assertEqual(erased.getpixel((5, 5)), (0, 0, 0))
        self.assertEqual(erased.getpixel((20, 5)), (0, 255, 0))

    def test_connected_erase_handles_disconnected_legacy_regions(self) -> None:
        mask = Image.new("L", (40, 20), 0)
        draw = ImageDraw.Draw(mask)
        draw.rectangle((1, 1, 10, 10), fill=255)
        draw.rectangle((25, 1, 34, 10), fill=255)
        erased, count = erase_connected_region(mask, (5, 5))
        self.assertEqual(count, 100)
        self.assertEqual(erased.getpixel((5, 5)), 0)
        self.assertEqual(erased.getpixel((30, 5)), 255)

    def test_connected_erase_supports_low_grayscale_label_ids(self) -> None:
        mask = Image.new("L", (30, 12), 0)
        draw = ImageDraw.Draw(mask)
        draw.rectangle((1, 1, 12, 10), fill=2)
        draw.rectangle((14, 1, 28, 10), fill=3)
        erased, count = erase_connected_region(mask, (5, 5))
        self.assertEqual(count, 120)
        self.assertEqual(erased.getpixel((5, 5)), 0)
        self.assertEqual(erased.getpixel((20, 5)), 3)

    def test_connected_erase_flattens_rgba_to_black_rgb_background(self) -> None:
        mask = Image.new("RGBA", (20, 12), (0, 0, 0, 0))
        ImageDraw.Draw(mask).rectangle((2, 2, 10, 9), fill=(255, 40, 20, 255))
        erased, count = erase_connected_region(mask, (5, 5))
        self.assertEqual(count, 72)
        self.assertEqual(erased.mode, "RGB")
        self.assertEqual(erased.getpixel((5, 5)), (0, 0, 0))
        self.assertEqual(erased.getpixel((0, 0)), (0, 0, 0))

    def test_polygon_on_rgba_mask_preserves_black_background(self) -> None:
        mask = Image.new("RGBA", (24, 18), (0, 0, 0, 0))
        painted = paint_polygon(
            mask,
            ((4, 4), (18, 4), (18, 14), (4, 14)),
            (255, 255, 255),
        )
        self.assertEqual(painted.mode, "RGB")
        self.assertEqual(painted.getpixel((0, 0)), (0, 0, 0))
        self.assertEqual(painted.getpixel((10, 10)), (255, 255, 255))

    def test_color_round_trip(self) -> None:
        self.assertEqual(hex_to_rgb("#12A0ff"), (18, 160, 255))
        self.assertEqual(rgb_to_hex((18, 160, 255)), "#12A0FF")

    def test_atomic_mask_save_replaces_file_and_cleans_temporary_file(self) -> None:
        with TemporaryDirectory(dir=Path.cwd()) as directory:
            target = Path(directory) / "tile_mask.png"
            save_mask_atomic(Image.new("RGB", (32, 24), (12, 34, 56)), target)
            save_mask_atomic(Image.new("RGB", (32, 24), (90, 120, 150)), target)
            with Image.open(target) as saved:
                self.assertEqual(saved.getpixel((10, 10)), (90, 120, 150))
            self.assertFalse(any("masktool_tmp" in path.name for path in target.parent.iterdir()))


if __name__ == "__main__":
    unittest.main()
