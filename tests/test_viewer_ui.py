from __future__ import annotations

import tkinter as tk
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image

from pair_change_viewer import LABELS_FILENAME, ROOT, PairChangeViewer


class ButtonStateTests(unittest.TestCase):
    def setUp(self) -> None:
        try:
            self.root = tk.Tk()
        except tk.TclError as exc:
            self.skipTest(f"Tk GUI is unavailable: {exc}")
        self.root.withdraw()
        patchers = [
            patch.object(PairChangeViewer, "load_saved_settings"),
            patch.object(PairChangeViewer, "load_label_config"),
            patch.object(PairChangeViewer, "save_label_config"),
            patch.object(PairChangeViewer, "load_pairs"),
            patch.object(PairChangeViewer, "force_keyboard_focus"),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.viewer = PairChangeViewer(self.root)
        self.addCleanup(self._destroy_root)

    def _destroy_root(self) -> None:
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def assert_active(self, button: tk.Button, color: str, label: str) -> None:
        self.assertEqual(button.cget("bg").upper(), color)
        self.assertEqual(button.cget("relief"), tk.SUNKEN)
        self.assertEqual(button.cget("borderwidth"), 1)
        self.assertTrue(button.cget("text").startswith("● "))
        self.assertIn(label, button.cget("text"))

    def test_all_toggle_buttons_have_unambiguous_active_states(self) -> None:
        self.assert_active(self.viewer.mask_button, "#1976D2", "Mask")
        self.assert_active(self.viewer.mode_button, "#1976D2", "AFTER")

        self.viewer.annotation_mode = True
        self.viewer.annotation_action = "add"
        self.viewer.blinking = True
        self.viewer.view_mode = "compare"
        self.viewer.mode = "before"
        self.viewer.update_button_states()
        self.assert_active(self.viewer.annotation_button, "#008F5A", "彩色标注")
        self.assert_active(self.viewer.blink_button, "#B8860B", "闪烁")
        self.assert_active(self.viewer.compare_button, "#7E57C2", "左右对比")
        self.assert_active(self.viewer.mode_button, "#7E57C2", "BEFORE")

        self.viewer.annotation_action = "erase"
        self.viewer.update_button_states()
        self.assert_active(self.viewer.erase_button, "#E65100", "删标注")

    def test_background_operation_is_visible_on_tool_button(self) -> None:
        self.viewer.annotation_mode = False
        self.viewer._mask_operation_busy = True
        self.viewer._mask_operation_kind = "erase_region"
        self.viewer.update_button_states()
        self.assert_active(self.viewer.erase_button, "#E65100", "处理中")

    def test_label_config_path_is_always_beside_program(self) -> None:
        self.viewer.mask_dir = Path("Z:/some/opened/project/mask")
        self.assertEqual(self.viewer.label_file_path(), ROOT / LABELS_FILENAME)

    def test_pinned_labels_sort_first_and_can_be_unpinned(self) -> None:
        self.viewer.label_definitions[12]["pinned"] = True
        self.viewer.label_definitions[2]["pinned"] = True
        self.viewer.open_label_manager()
        self.viewer.refresh_label_list(12)
        self.assertEqual(self.viewer._label_list_order[:2], [2, 12])
        self.assertEqual(self.viewer.selected_dialog_label_id(), 12)
        self.viewer.toggle_dialog_label_pin()
        self.assertFalse(self.viewer.label_definitions[12]["pinned"])
        self.assertEqual(self.viewer._label_list_order[0], 2)

    def test_c_shortcut_opens_and_closes_label_manager(self) -> None:
        event = SimpleNamespace(
            widget=self.viewer.canvas,
            keysym="c",
            char="c",
            state=0,
        )
        self.assertEqual(self.viewer.on_key_press(event), "break")
        self.assertIsNotNone(self.viewer._label_dialog)
        self.assertTrue(self.viewer._label_dialog.winfo_exists())

        self.assertEqual(self.viewer.on_key_press(event), "break")
        self.assertIsNone(self.viewer._label_dialog)

    def test_label_button_click_opens_and_closes_non_modal_manager(self) -> None:
        self.viewer.label_button.invoke()
        self.root.update_idletasks()
        self.assertIsNotNone(self.viewer._label_dialog)
        self.assertTrue(self.viewer._label_dialog.winfo_exists())
        self.assertIsNone(self.root.grab_current())

        self.viewer.label_button.invoke()
        self.root.update_idletasks()
        self.assertIsNone(self.viewer._label_dialog)

    def test_c_closes_label_manager_while_name_entry_has_focus(self) -> None:
        self.viewer.open_label_manager()
        name_entry = next(
            widget
            for widget in self.viewer._label_dialog.winfo_children()[1].winfo_children()
            if isinstance(widget, tk.Entry)
        )
        event = SimpleNamespace(
            widget=name_entry,
            keysym="c",
            char="c",
            state=0,
        )
        self.assertEqual(self.viewer.on_key_press(event), "break")
        self.assertIsNone(self.viewer._label_dialog)

    def test_navigation_flash_restores_default_button_style(self) -> None:
        for button in (self.viewer.prev_button, self.viewer.next_button):
            with self.subTest(button=button.cget("text")):
                self.viewer.flash_button(button)
                self.assertEqual(button.cget("bg").upper(), "#3677A8")
                self.assertEqual(button.cget("relief"), tk.SUNKEN)
                job = self.viewer._button_flash_jobs[button]
                self.root.after_cancel(job)
                self.viewer._finish_button_flash(button)
                self.assertEqual(button.cget("bg").upper(), "#3C4043")
                self.assertEqual(button.cget("relief"), tk.FLAT)
                self.assertFalse(button.cget("text").startswith("● "))

    def test_repeated_navigation_clicks_keep_pulsing_instead_of_staying_on(self) -> None:
        button = self.viewer.next_button
        self.viewer.flash_button(button)
        self.assertIn(button, self.viewer._button_flash_active)
        self.assertEqual(button.cget("bg").upper(), "#3677A8")

        self.viewer.flash_button(button)
        self.assertIn(button, self.viewer._button_flash_active)
        self.assertEqual(button.cget("bg").upper(), "#6CB6E8")

        self.viewer.flash_button(button)
        self.assertIn(button, self.viewer._button_flash_active)
        self.assertEqual(button.cget("bg").upper(), "#3677A8")
        job = self.viewer._button_flash_jobs[button]
        self.root.after_cancel(job)
        self.viewer._finish_button_flash(button)
        self.assertEqual(button.cget("bg").upper(), "#3C4043")

    def test_s_toggles_mask_without_leaving_annotation_or_losing_points(self) -> None:
        points = [(10, 10), (20, 12), (15, 25)]
        event = SimpleNamespace(
            widget=self.viewer.canvas,
            keysym="s",
            char="s",
            state=0,
        )
        for action in ("add", "erase"):
            with self.subTest(action=action):
                self.viewer.annotation_mode = True
                self.viewer.annotation_action = action
                self.viewer.annotation_points = list(points)
                self.viewer.show_mask = True

                self.assertEqual(self.viewer.on_key_press(event), "break")
                self.assertFalse(self.viewer.show_mask)
                self.assertTrue(self.viewer.annotation_mode)
                self.assertEqual(self.viewer.annotation_points, points)

                self.assertEqual(self.viewer.on_key_press(event), "break")
                self.assertTrue(self.viewer.show_mask)
                self.assertTrue(self.viewer.annotation_mode)
                self.assertEqual(self.viewer.annotation_points, points)

    def test_space_toggles_phase_without_leaving_annotation_or_losing_points(self) -> None:
        points = [(10, 10), (20, 12), (15, 25)]
        self.viewer.pairs = [object()]
        self.viewer.render = lambda: None
        event = SimpleNamespace(
            widget=self.viewer.canvas,
            keysym="space",
            char=" ",
            state=0,
        )
        for action in ("add", "erase"):
            with self.subTest(action=action):
                self.viewer.annotation_mode = True
                self.viewer.annotation_action = action
                self.viewer.annotation_points = list(points)
                self.viewer.mode = "after"

                self.assertEqual(self.viewer.on_key_press(event), "break")
                self.assertEqual(self.viewer.mode, "before")
                self.assertTrue(self.viewer.annotation_mode)
                self.assertEqual(self.viewer.annotation_action, action)
                self.assertEqual(self.viewer.annotation_points, points)

                self.assertEqual(self.viewer.on_key_press(event), "break")
                self.assertEqual(self.viewer.mode, "after")
                self.assertTrue(self.viewer.annotation_mode)
                self.assertEqual(self.viewer.annotation_action, action)
                self.assertEqual(self.viewer.annotation_points, points)

    def test_connected_erase_completes_through_background_queue(self) -> None:
        with TemporaryDirectory(dir=Path.cwd()) as directory:
            directory_path = Path(directory)
            before_path = directory_path / "tile.png"
            after_path = directory_path / "tile_after.png"
            mask_path = directory_path / "tile_mask.png"
            Image.new("RGB", (128, 96), (20, 30, 40)).save(before_path)
            Image.new("RGB", (128, 96), (30, 40, 50)).save(after_path)
            Image.new("RGB", (128, 96), (200, 80, 40)).save(mask_path)
            self.viewer.pairs = [("tile.png", before_path, after_path, mask_path)]
            self.viewer.index = 0
            self.viewer.annotation_mode = True
            self.viewer.annotation_action = "erase"
            self.viewer.annotation_transform_index = 0
            self.viewer.image_transforms = [((128, 96), (128, 96), 64, 48)]

            self.assertTrue(self.viewer.start_connected_mask_erase((10, 10)))
            self.assertTrue(self.viewer._mask_operation_busy)
            self.assertIn("处理中", self.viewer.erase_button.cget("text"))

            deadline = monotonic() + 5
            while self.viewer._mask_operation_busy and monotonic() < deadline:
                self.root.update()
                sleep(0.005)
            self.assertFalse(self.viewer._mask_operation_busy)
            with Image.open(mask_path) as saved:
                self.assertEqual(saved.getpixel((10, 10)), (0, 0, 0))
            self.assertIn("12288 px", self.viewer.status.get())

    def test_polygon_save_writes_selected_label_color_as_mask_category(self) -> None:
        with TemporaryDirectory(dir=Path.cwd()) as directory:
            directory_path = Path(directory)
            before_path = directory_path / "before.png"
            after_path = directory_path / "after.png"
            mask_path = directory_path / "mask.png"
            Image.new("RGB", (64, 48), (20, 30, 40)).save(before_path)
            Image.new("RGB", (64, 48), (30, 40, 50)).save(after_path)
            Image.new("RGB", (64, 48), (0, 0, 0)).save(mask_path)
            self.viewer.pairs = [("tile.png", before_path, after_path, mask_path)]
            self.viewer.index = 0
            self.viewer.active_label_id = 2
            self.viewer.label_definitions[2]["color"] = "#FF2020"
            self.viewer.annotation_mode = True
            self.viewer.annotation_action = "add"
            self.viewer.annotation_points = [(5, 5), (40, 5), (40, 35), (5, 35)]
            self.viewer.annotation_transform_index = 0
            self.viewer.image_transforms = [((64, 48), (64, 48), 32, 24)]

            self.viewer.start_polygon_mask_save()
            deadline = monotonic() + 5
            while self.viewer._mask_operation_busy and monotonic() < deadline:
                self.root.update()
                sleep(0.005)
            self.assertFalse(self.viewer._mask_operation_busy)
            with Image.open(mask_path) as saved:
                self.assertEqual(saved.getpixel((20, 20)), (255, 32, 32))

            self.viewer.active_label_id = 0
            self.viewer.label_definitions[0]["color"] = "#FFFFFF"
            self.viewer.annotation_mode = True
            self.viewer.annotation_action = "add"
            self.viewer.annotation_points = [(8, 8), (30, 8), (30, 30), (8, 30)]
            self.viewer.annotation_transform_index = 0
            self.viewer.start_polygon_mask_save()
            deadline = monotonic() + 5
            while self.viewer._mask_operation_busy and monotonic() < deadline:
                self.root.update()
                sleep(0.005)
            self.assertFalse(self.viewer._mask_operation_busy)
            with Image.open(mask_path) as saved:
                self.assertEqual(saved.getpixel((15, 15)), (255, 255, 255))

            self.viewer.label_definitions[0]["color"] = "#00FF00"
            self.viewer.annotation_mode = True
            self.viewer.annotation_action = "add"
            self.viewer.annotation_points = [(42, 5), (60, 5), (60, 20), (42, 20)]
            self.viewer.annotation_transform_index = 0
            self.viewer.start_polygon_mask_save()
            deadline = monotonic() + 5
            while self.viewer._mask_operation_busy and monotonic() < deadline:
                self.root.update()
                sleep(0.005)
            self.assertFalse(self.viewer._mask_operation_busy)
            with Image.open(mask_path) as saved:
                self.assertEqual(saved.getpixel((50, 10)), (0, 255, 0))


if __name__ == "__main__":
    unittest.main()
