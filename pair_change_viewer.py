from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
import json
import os
from queue import Empty, Queue
import shutil
import sys
from threading import Thread
import tkinter as tk
from tkinter import colorchooser, filedialog, messagebox

from PIL import Image, ImageTk

from mask_core import (
    IMAGE_EXTS,
    LABEL_COUNT,
    LABEL_MAX,
    LABEL_MIN,
    contrasting_text_color,
    erase_connected_region,
    file_cache_key,
    find_pairs,
    hex_to_rgb,
    load_mask_for_edit,
    make_default_label_definitions,
    normalize_label_definitions,
    paint_polygon,
    render_image_viewport,
    render_mask_viewport,
    rgb_to_hex,
    save_mask_atomic,
)


def app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = app_root()
SETTINGS_DIR = Path(os.environ.get("LOCALAPPDATA", str(ROOT))) / "双时相变化检查工具"
SETTINGS_PATH = SETTINGS_DIR / "settings.json"
DEFAULT_AFTER_DIR = ROOT / "a"
DEFAULT_BEFORE_DIR = ROOT / "before"
FALLBACK_AFTER_DIR = ROOT / "数据" / "第二批" / "a"
FALLBACK_BEFORE_DIR = ROOT / "数据" / "第二批" / "before"

ANNOTATION_LINE_COLOR = "#00e5ff"
ANNOTATION_POINT_COLOR = "#ffffff"
ERASE_LINE_COLOR = "#ff7043"
LABELS_FILENAME = "mask_labels.json"


class PairChangeViewer:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("双时相变化检查工具")
        self.root.geometry("1280x900")
        self.root.configure(bg="#202124")

        self.after_dir = DEFAULT_AFTER_DIR if DEFAULT_AFTER_DIR.exists() else FALLBACK_AFTER_DIR
        self.before_dir = DEFAULT_BEFORE_DIR if DEFAULT_BEFORE_DIR.exists() else FALLBACK_BEFORE_DIR
        self.mask_dir = self.default_mask_dir()
        self.label_definitions = make_default_label_definitions()
        self.active_label_id = 1
        self.load_saved_settings()
        self.load_label_config()
        self.deleted_root = self.default_deleted_root()

        self.pairs: list[tuple[str, Path, Path, Path | None]] = []
        self.index = 0
        self.mode = "after"
        self.view_mode = "single"
        self.blinking = False
        self.show_mask = True
        self.annotation_mode = False
        self.annotation_action = "add"
        self.annotation_points: list[tuple[int, int]] = []
        self.image_transform: tuple[tuple[int, int], tuple[int, int], float, float] | None = None
        self.image_transforms: list[tuple[tuple[int, int], tuple[int, int], float, float]] = []
        self.annotation_transform_index: int | None = None
        self.zoom = 1.0
        self.pan_x = 0.0
        self.pan_y = 0.0
        self.drag_start: tuple[int, int, float, float] | None = None
        self._fast_render = False
        self._render_job: str | None = None
        self._quality_job: str | None = None
        self._pan_job: str | None = None
        self._blink_job: str | None = None
        self._label_dialog: tk.Toplevel | None = None
        self._button_flash_jobs: dict[tk.Button, str] = {}
        self._button_flash_active: set[tk.Button] = set()
        self._button_flash_phases: dict[tk.Button, int] = {}
        self._mask_operation_busy = False
        self._mask_operation_kind = ""
        self._mask_operation_queue: Queue = Queue()
        self._mask_operation_poll_job: str | None = None
        self._mask_operation_context: dict | None = None
        self.last_deleted: tuple[
            tuple[str, Path, Path, Path | None],
            list[tuple[Path, Path]],
            int,
        ] | None = None

        self._source_cache: OrderedDict[tuple, Image.Image] = OrderedDict()
        self._photo_cache: OrderedDict[tuple, ImageTk.PhotoImage] = OrderedDict()
        self.photos: list[ImageTk.PhotoImage] = []

        self.before_var = tk.StringVar(value=str(self.before_dir))
        self.after_var = tk.StringVar(value=str(self.after_dir))
        self.mask_var = tk.StringVar(value=str(self.mask_dir) if self.mask_dir else "")
        self.status = tk.StringVar()

        self.build_ui()
        self.update_button_states()
        self.bind_keys()
        self.load_pairs()
        self.root.protocol("WM_DELETE_WINDOW", self.close_app)
        self.root.after(200, self.force_keyboard_focus)

    # ---------- settings and paths ----------

    def current_label(self) -> dict[str, str | bool]:
        return self.label_definitions[self.active_label_id]

    def current_label_color(self) -> tuple[int, int, int]:
        return hex_to_rgb(self.current_label()["color"])

    def current_label_mask_color(self) -> tuple[int, int, int]:
        return self.current_label_color()

    def current_label_description(self) -> str:
        label = self.current_label()
        return f"标签 {self.active_label_id:03d}：{label['name']} {label['color']}"

    def load_saved_settings(self) -> None:
        try:
            data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return
        before = data.get("before_dir")
        after = data.get("after_dir")
        mask = data.get("mask_dir")
        color = data.get("mask_color")
        labels = data.get("mask_labels")
        active_label = data.get("active_label_id")
        if isinstance(before, str) and before.strip():
            self.before_dir = Path(before).expanduser()
        if isinstance(after, str) and after.strip():
            self.after_dir = Path(after).expanduser()
        if isinstance(mask, str):
            self.mask_dir = Path(mask).expanduser() if mask.strip() else None
        if isinstance(labels, dict):
            self.label_definitions = normalize_label_definitions(labels)
        elif isinstance(color, str):
            try:
                legacy_color = hex_to_rgb(color)
                if legacy_color != (0, 0, 0):
                    self.label_definitions[1]["color"] = rgb_to_hex(legacy_color)
            except ValueError:
                pass
        if isinstance(active_label, int):
            if active_label == 256:
                active_label = 0
            if LABEL_MIN <= active_label <= LABEL_MAX:
                self.active_label_id = active_label

    def save_settings(self) -> None:
        data = {
            "before_dir": str(self.before_dir),
            "after_dir": str(self.after_dir),
            "mask_dir": str(self.mask_dir) if self.mask_dir else "",
            "active_label_id": self.active_label_id,
        }
        temp_path = SETTINGS_PATH.with_suffix(".tmp")
        try:
            SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
            temp_path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temp_path.replace(SETTINGS_PATH)
        except OSError:
            temp_path.unlink(missing_ok=True)

    def close_app(self) -> None:
        if self._mask_operation_busy:
            messagebox.showinfo(
                "Mask 正在处理",
                "正在后台保存 Mask，请等待“处理完成”后再关闭程序，以免丢失本次标注。",
                parent=self.root,
            )
            return
        self.save_settings()
        self.save_label_config()
        self.root.destroy()

    def label_file_path(self) -> Path:
        return ROOT / LABELS_FILENAME

    def legacy_label_file_path(self) -> Path | None:
        return self.mask_dir / LABELS_FILENAME if self.mask_dir else None

    def load_label_config(self) -> None:
        label_path = self.label_file_path()
        source_path = label_path
        migrate_to_program_directory = not label_path.exists()
        if migrate_to_program_directory:
            legacy_path = self.legacy_label_file_path()
            if legacy_path and legacy_path.exists():
                source_path = legacy_path
            else:
                self.save_label_config()
                return
        try:
            data = json.loads(source_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return
        labels = data.get("labels") if isinstance(data, dict) else None
        self.label_definitions = normalize_label_definitions(labels)
        active_label = data.get("active_label_id") if isinstance(data, dict) else None
        if isinstance(active_label, int):
            if active_label == 256:
                active_label = 0
            if LABEL_MIN <= active_label <= LABEL_MAX:
                self.active_label_id = active_label
        if migrate_to_program_directory:
            self.save_label_config()

    def save_label_config(self) -> None:
        label_path = self.label_file_path()
        if not label_path.parent.exists():
            return
        payload = {
            "version": 2,
            "label_range": [LABEL_MIN, LABEL_MAX],
            "mask_encoding": "RGB stores selected label color",
            "active_label_id": self.active_label_id,
            "labels": {
                str(label_id): value for label_id, value in self.label_definitions.items()
            },
        }
        temp_path = label_path.with_suffix(".tmp")
        try:
            temp_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            temp_path.replace(label_path)
        except OSError:
            temp_path.unlink(missing_ok=True)

    def default_deleted_root(self) -> Path:
        if self.before_dir.parent == self.after_dir.parent:
            return self.before_dir.parent / "deleted_pairs"
        return ROOT / "deleted_pairs"

    def default_mask_dir(self) -> Path:
        for candidate in (
            self.before_dir.parent / "mask",
            self.before_dir.parent / "masks",
            ROOT / "mask",
            ROOT / "masks",
        ):
            if candidate.exists():
                return candidate
        return self.before_dir.parent / "mask"

    # ---------- UI ----------

    def build_ui(self) -> None:
        top = tk.Frame(self.root, bg="#202124", padx=4, pady=3)
        top.pack(fill=tk.X)
        self.add_path_row(top, 0, "Before", self.before_var, self.choose_before_dir)
        self.add_path_row(top, 1, "After", self.after_var, self.choose_after_dir)
        self.add_path_row(top, 2, "Mask", self.mask_var, self.choose_mask_dir)

        self.canvas = tk.Canvas(self.root, bg="#111315", highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        self.canvas.bind("<Configure>", lambda _event: self.schedule_render(80))
        self.canvas.bind("<ButtonPress-1>", self.start_pan)
        self.canvas.bind("<B1-Motion>", self.pan)
        self.canvas.bind("<ButtonRelease-1>", self.finish_pan)
        self.canvas.bind("<ButtonPress-3>", self.finish_annotation)
        self.canvas.bind("<Double-Button-1>", lambda _event: self.reset_view())
        self.canvas.bind("<MouseWheel>", self.on_mousewheel)
        self.canvas.bind("<Button-1>", self.force_keyboard_focus, add="+")

        controls = tk.Frame(self.root, bg="#202124", padx=3, pady=3)
        controls.pack(fill=tk.X)
        self.mask_button = self.make_button(controls, "Mask [S]", self.toggle_mask)
        self.label_button = self.make_button(controls, "标签 001 [C]", self.toggle_label_manager)
        self.annotation_button = self.make_button(controls, "彩色标注 [Q]", self.toggle_annotation_mode)
        self.erase_button = self.make_button(controls, "删标注 [E]", self.toggle_erase_annotation_mode)
        self.prev_button = self.make_button(controls, "←上一张 [A]", self.prev_image)
        self.next_button = self.make_button(controls, "下一张 [D]→", self.next_image)
        self.mode_button = self.make_button(controls, "切时相 [空格]", self.toggle_mode)
        self.blink_button = self.make_button(controls, "闪烁 [B]", self.toggle_blink)
        self.compare_button = self.make_button(controls, "左右对比 [V]", self.toggle_compare)
        self.delete_button = self.make_button(controls, "删除 [Del]", self.delete_pair, "#8b2d2d")
        self.permanent_delete_button = self.make_button(
            controls, "彻删 [Shift+Del]", self.permanent_delete_pair, "#5f1b1b"
        )
        self.undo_button = self.make_button(controls, "撤销 [U/Ctrl+Z]", self.undo_delete)
        self.reset_button = self.make_button(controls, "重置 [R/0]", self.reset_view)
        for button in (
            self.mask_button,
            self.label_button,
            self.annotation_button,
            self.erase_button,
            self.prev_button,
            self.next_button,
            self.mode_button,
            self.blink_button,
            self.compare_button,
            self.delete_button,
            self.permanent_delete_button,
            self.undo_button,
            self.reset_button,
        ):
            button.pack(side=tk.LEFT, padx=2)

        status_bar = tk.Label(
            self.root,
            textvariable=self.status,
            anchor="w",
            bg="#17191c",
            fg="#e8eaed",
            padx=5,
            pady=3,
            font=("Microsoft YaHei UI", 9),
        )
        status_bar.pack(fill=tk.X)

    def add_path_row(
        self,
        parent: tk.Frame,
        row: int,
        label: str,
        var: tk.StringVar,
        command,
    ) -> None:
        tk.Label(
            parent,
            text=label,
            width=7,
            anchor="e",
            bg="#202124",
            fg="#e8eaed",
            font=("Microsoft YaHei UI", 8),
        ).grid(row=row, column=0, padx=(0, 3), pady=1, sticky="ew")
        entry = tk.Entry(
            parent,
            textvariable=var,
            bg="#2b2f33",
            fg="#e8eaed",
            insertbackground="#e8eaed",
            relief=tk.FLAT,
            font=("Consolas", 8),
        )
        entry.grid(row=row, column=1, padx=2, pady=1, sticky="ew")
        self.make_button(parent, "选择", command, compact=True).grid(
            row=row, column=2, padx=2, pady=1
        )
        self.make_button(parent, "载入", self.apply_paths, compact=True).grid(
            row=row, column=3, padx=2, pady=1
        )
        parent.grid_columnconfigure(1, weight=1)

    def make_button(
        self,
        parent: tk.Misc,
        text: str,
        command,
        bg: str = "#3c4043",
        compact: bool = False,
    ) -> tk.Button:
        button = tk.Button(
            parent,
            text=text,
            command=lambda: self.run_button_command(command),
            takefocus=0,
            bg=bg,
            fg="#f1f3f4",
            activebackground="#5f6368",
            activeforeground="#ffffff",
            relief=tk.FLAT,
            borderwidth=0,
            padx=4 if compact else 5,
            pady=1 if compact else 3,
            font=("Microsoft YaHei UI", 8 if compact else 9),
        )
        button._base_text = text
        button._default_bg = bg
        return button

    def run_button_command(self, command) -> None:
        command()
        if not (self._label_dialog and self._label_dialog.winfo_exists()):
            self.force_keyboard_focus()

    def force_keyboard_focus(self, _event=None) -> None:
        try:
            self.root.focus_force()
            self.canvas.focus_set()
        except tk.TclError:
            pass

    def update_button_states(self) -> None:
        def state(
            button: tk.Button,
            active: bool,
            color: str,
            *,
            text: str | None = None,
        ) -> None:
            if button not in self._button_flash_jobs:
                label = text if text is not None else button._base_text
                button.configure(
                    bg=color if active else "#3c4043",
                    activebackground=color if active else "#5f6368",
                    fg="#ffffff" if active else "#f1f3f4",
                    activeforeground="#ffffff",
                    relief=tk.SUNKEN if active else tk.FLAT,
                    borderwidth=1 if active else 0,
                    text=f"● {label}" if active else label,
                )

        busy_add = self._mask_operation_busy and self._mask_operation_kind == "add"
        busy_erase = self._mask_operation_busy and self._mask_operation_kind.startswith("erase")
        state(self.mask_button, self.show_mask, "#1976D2")
        state(
            self.annotation_button,
            busy_add or (self.annotation_mode and self.annotation_action == "add"),
            "#008F5A",
            text="处理中…" if busy_add else None,
        )
        state(
            self.erase_button,
            busy_erase or (self.annotation_mode and self.annotation_action == "erase"),
            "#E65100",
            text="处理中…" if busy_erase else None,
        )
        state(self.blink_button, self.blinking, "#B8860B")
        state(self.compare_button, self.view_mode == "compare", "#7E57C2")
        state(
            self.mode_button,
            True,
            "#1976D2" if self.mode == "after" else "#7E57C2",
            text=f"时相 {'AFTER' if self.mode == 'after' else 'BEFORE'} [空格]",
        )
        color = self.current_label_color()
        color_hex = rgb_to_hex(color)
        self.label_button.configure(
            text=f"标签 {self.active_label_id:03d} [C]",
            bg=color_hex,
            activebackground=color_hex,
            fg=contrasting_text_color(color),
            activeforeground=contrasting_text_color(color),
            relief=tk.SUNKEN,
            borderwidth=1,
        )

    def flash_button(self, button: tk.Button, color: str = "#3677a8") -> None:
        old_job = self._button_flash_jobs.pop(button, None)
        if old_job:
            try:
                self.root.after_cancel(old_job)
            except tk.TclError:
                pass
        phase = self._button_flash_phases.get(button, 0) + 1
        self._button_flash_phases[button] = phase
        pulse_color = color if phase % 2 else "#6CB6E8"
        self._button_flash_active.add(button)
        button.configure(
            bg=pulse_color,
            activebackground=pulse_color,
            fg="#ffffff",
            relief=tk.SUNKEN,
            borderwidth=1,
            text=f"● {button._base_text}",
        )
        self._button_flash_jobs[button] = self.root.after(
            105, lambda: self._finish_button_flash(button)
        )

    def _finish_button_flash(self, button: tk.Button) -> None:
        self._button_flash_jobs.pop(button, None)
        self._button_flash_active.discard(button)
        self._restore_button_after_flash(button)
        self.update_button_states()

    @staticmethod
    def _restore_button_after_flash(button: tk.Button) -> None:
        button.configure(
            bg=button._default_bg,
            activebackground="#5f6368",
            fg="#f1f3f4",
            relief=tk.FLAT,
            borderwidth=0,
            text=button._base_text,
        )

    def choose_before_dir(self) -> None:
        if not self.mask_operation_guard("更换目录"):
            return
        selected = filedialog.askdirectory(
            title="选择 Before 图像目录",
            initialdir=str(self.before_dir if self.before_dir.exists() else ROOT),
        )
        if selected:
            self.before_var.set(selected)
            self.apply_paths()

    def choose_after_dir(self) -> None:
        if not self.mask_operation_guard("更换目录"):
            return
        selected = filedialog.askdirectory(
            title="选择 After 图像目录",
            initialdir=str(self.after_dir if self.after_dir.exists() else ROOT),
        )
        if selected:
            self.after_var.set(selected)
            self.apply_paths()

    def choose_mask_dir(self) -> None:
        if not self.mask_operation_guard("更换目录"):
            return
        selected = filedialog.askdirectory(
            title="选择 Mask 图像目录",
            initialdir=str(self.mask_dir if self.mask_dir and self.mask_dir.exists() else ROOT),
        )
        if selected:
            self.mask_var.set(selected)
            self.apply_paths()

    def toggle_label_manager(self) -> None:
        if self._label_dialog and self._label_dialog.winfo_exists():
            self.close_label_manager()
        else:
            self.open_label_manager()

    def open_label_manager(self) -> None:
        if self._label_dialog and self._label_dialog.winfo_exists():
            self._label_dialog.deiconify()
            self._label_dialog.lift()
            self._label_dialog.focus_force()
            return

        dialog = tk.Toplevel(self.root)
        self._label_dialog = dialog
        dialog.title("Mask 标签管理（0–255）")
        dialog.geometry("560x650")
        dialog.minsize(500, 520)
        dialog.configure(bg="#202124")
        dialog.transient(self.root)
        dialog.protocol("WM_DELETE_WINDOW", self.close_label_manager)

        list_frame = tk.Frame(dialog, bg="#202124")
        list_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(10, 8))
        scrollbar = tk.Scrollbar(list_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.label_listbox = tk.Listbox(
            list_frame,
            yscrollcommand=scrollbar.set,
            exportselection=False,
            bg="#2b2f33",
            fg="#ffffff",
            selectbackground="#ffffff",
            selectforeground="#111111",
            relief=tk.FLAT,
            font=("Consolas", 10),
            activestyle="none",
        )
        self.label_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.configure(command=self.label_listbox.yview)
        self.label_listbox.bind("<<ListboxSelect>>", self.on_label_list_select)
        self.label_listbox.bind(
            "<Double-Button-1>", lambda _event: self.save_dialog_label(use_label=True)
        )

        editor = tk.Frame(dialog, bg="#202124", padx=10, pady=6)
        editor.pack(fill=tk.X)
        self.dialog_label_number_var = tk.StringVar(value=str(self.active_label_id))
        self.dialog_label_name_var = tk.StringVar()
        tk.Label(
            editor,
            text="标签编号",
            width=10,
            anchor="w",
            bg="#202124",
            fg="#e8eaed",
            font=("Microsoft YaHei UI", 10, "bold"),
        ).grid(row=0, column=0, padx=(0, 6), sticky="w")
        label_spinbox = tk.Spinbox(
            editor,
            from_=LABEL_MIN,
            to=LABEL_MAX,
            textvariable=self.dialog_label_number_var,
            width=8,
            bg="#2b2f33",
            fg="#e8eaed",
            buttonbackground="#3c4043",
            insertbackground="#ffffff",
            relief=tk.FLAT,
            command=self.jump_to_dialog_label,
            font=("Consolas", 10),
        )
        label_spinbox.grid(row=0, column=1, padx=4, sticky="w")
        label_spinbox.bind("<Return>", lambda _event: self.jump_to_dialog_label())
        self.make_button(
            editor, "跳转", self.jump_to_dialog_label, compact=True
        ).grid(row=0, column=2, padx=(6, 0), sticky="w")
        tk.Label(
            editor,
            text="标签名称",
            width=10,
            anchor="w",
            bg="#202124",
            fg="#e8eaed",
            font=("Microsoft YaHei UI", 10, "bold"),
        ).grid(row=1, column=0, padx=(0, 6), pady=(6, 0), sticky="w")
        tk.Entry(
            editor,
            textvariable=self.dialog_label_name_var,
            bg="#2b2f33",
            fg="#e8eaed",
            insertbackground="#ffffff",
            relief=tk.FLAT,
            font=("Microsoft YaHei UI", 10),
        ).grid(row=1, column=1, padx=4, pady=(6, 0), sticky="ew")
        self.dialog_color_button = self.make_button(
            editor, "选择颜色", self.choose_dialog_label_color, compact=True
        )
        self.dialog_color_button.grid(row=1, column=2, padx=(6, 0), pady=(6, 0))
        editor.grid_columnconfigure(1, weight=1)

        actions = tk.Frame(dialog, bg="#202124", padx=10, pady=2)
        actions.pack(fill=tk.X, pady=(0, 8))
        self.make_button(
            actions, "保存标签", lambda: self.save_dialog_label(use_label=False)
        ).pack(side=tk.LEFT, padx=2)
        self.make_button(
            actions, "保存并设为当前", lambda: self.save_dialog_label(use_label=True), "#2f7d5b"
        ).pack(side=tk.LEFT, padx=2)
        self.pin_label_button = self.make_button(
            actions, "置顶标签", self.toggle_dialog_label_pin, "#6b5b20"
        )
        self.pin_label_button.pack(side=tk.LEFT, padx=2)
        self.make_button(actions, "关闭", self.close_label_manager).pack(side=tk.RIGHT, padx=2)

        self.refresh_label_list(self.active_label_id)
        dialog.focus_force()

    def refresh_label_list(self, selected_label_id: int) -> None:
        self.label_listbox.delete(0, tk.END)
        self._label_list_order = sorted(
            range(LABEL_MIN, LABEL_MAX + 1),
            key=lambda label_id: (
                not bool(self.label_definitions[label_id].get("pinned", False)),
                label_id,
            ),
        )
        for row_index, label_id in enumerate(self._label_list_order):
            label = self.label_definitions[label_id]
            marker = "▶" if label_id == self.active_label_id else " "
            pin_marker = "★" if label.get("pinned", False) else " "
            self.label_listbox.insert(
                tk.END,
                f"{marker}{pin_marker} {label_id:03d}  {label['name']:<24.24}  "
                f"{label['color']}",
            )
            color = hex_to_rgb(label["color"])
            self.label_listbox.itemconfig(
                row_index,
                bg=label["color"],
                fg=contrasting_text_color(color),
            )
        selected_label_id = min(LABEL_MAX, max(LABEL_MIN, selected_label_id))
        selected_index = self._label_list_order.index(selected_label_id)
        self.label_listbox.selection_clear(0, tk.END)
        self.label_listbox.selection_set(selected_index)
        self.label_listbox.activate(selected_index)
        self.label_listbox.see(selected_index)
        self.load_dialog_label(selected_label_id)

    def selected_dialog_label_id(self) -> int:
        selection = self.label_listbox.curselection()
        if selection and hasattr(self, "_label_list_order"):
            return self._label_list_order[int(selection[0])]
        return self.active_label_id

    def on_label_list_select(self, _event=None) -> None:
        self.load_dialog_label(self.selected_dialog_label_id())

    def jump_to_dialog_label(self) -> None:
        try:
            label_id = int(self.dialog_label_number_var.get())
        except (TypeError, ValueError):
            label_id = self.active_label_id
        label_id = min(LABEL_MAX, max(LABEL_MIN, label_id))
        selected_index = self._label_list_order.index(label_id)
        self.label_listbox.selection_clear(0, tk.END)
        self.label_listbox.selection_set(selected_index)
        self.label_listbox.activate(selected_index)
        self.label_listbox.see(selected_index)
        self.load_dialog_label(label_id)

    def load_dialog_label(self, label_id: int) -> None:
        label = self.label_definitions[label_id]
        self.dialog_label_number_var.set(str(label_id))
        self.dialog_label_name_var.set(label["name"])
        self._dialog_label_color = hex_to_rgb(label["color"])
        self.update_dialog_color_button()
        if hasattr(self, "pin_label_button"):
            self.pin_label_button.configure(
                text="取消置顶" if label.get("pinned", False) else "置顶标签"
            )

    def update_dialog_color_button(self) -> None:
        color_hex = rgb_to_hex(self._dialog_label_color)
        foreground = contrasting_text_color(self._dialog_label_color)
        self.dialog_color_button.configure(
            text=color_hex,
            bg=color_hex,
            activebackground=color_hex,
            fg=foreground,
            activeforeground=foreground,
        )

    def choose_dialog_label_color(self) -> None:
        _selected, color_hex = colorchooser.askcolor(
            color=rgb_to_hex(self._dialog_label_color),
            title="选择标签颜色",
            parent=self._label_dialog,
        )
        if color_hex:
            self._dialog_label_color = hex_to_rgb(color_hex)
            self.update_dialog_color_button()

    def save_dialog_label(self, *, use_label: bool) -> None:
        label_id = self.selected_dialog_label_id()
        name = self.dialog_label_name_var.get().strip() or f"标签 {label_id}"
        name = name[:64]
        color = self._dialog_label_color
        if color == (0, 0, 0):
            messagebox.showinfo(
                "颜色不可用",
                "黑色用于表示未标注背景，请选择其他颜色。",
                parent=self._label_dialog,
            )
            return
        for other_id, other in self.label_definitions.items():
            if other_id != label_id and hex_to_rgb(other["color"]) == color:
                messagebox.showinfo(
                    "颜色重复",
                    f"该颜色已被标签 {other_id:03d}“{other['name']}”使用，请选择其他颜色。",
                    parent=self._label_dialog,
                )
                return
        pinned = bool(self.label_definitions[label_id].get("pinned", False))
        self.label_definitions[label_id] = {
            "name": name,
            "color": rgb_to_hex(color),
            "pinned": pinned,
        }
        if use_label:
            self.active_label_id = label_id
        self.save_settings()
        self.save_label_config()
        self.update_button_states()
        self.clear_caches()
        self.refresh_label_list(label_id)
        self.status.set(
            f"已保存{'并启用' if use_label else ''} {self.label_definitions[label_id]['name']}："
            f"标签 {label_id:03d} {rgb_to_hex(color)}"
        )
        if self.pairs:
            self.render()

    def toggle_dialog_label_pin(self) -> None:
        label_id = self.selected_dialog_label_id()
        label = self.label_definitions[label_id]
        label["pinned"] = not bool(label.get("pinned", False))
        self.save_label_config()
        self.refresh_label_list(label_id)
        state = "已置顶" if label["pinned"] else "已取消置顶"
        self.status.set(f"{state}标签 {label_id:03d}：{label['name']}")

    def close_label_manager(self) -> None:
        if self._label_dialog and self._label_dialog.winfo_exists():
            try:
                self._label_dialog.grab_release()
            except tk.TclError:
                pass
            self._label_dialog.destroy()
        self._label_dialog = None
        self.force_keyboard_focus()

    def apply_paths(self) -> None:
        if not self.mask_operation_guard("载入其他目录"):
            return
        self.save_label_config()
        self.before_dir = Path(self.before_var.get()).expanduser()
        self.after_dir = Path(self.after_var.get()).expanduser()
        mask_text = self.mask_var.get().strip()
        self.mask_dir = Path(mask_text).expanduser() if mask_text else None
        self.deleted_root = self.default_deleted_root()
        self.index = 0
        self.last_deleted = None
        self.cancel_annotation(render=False)
        self.reset_view(render=False)
        self.clear_caches()
        self.load_pairs()

    # ---------- pairing and cache ----------

    def load_pairs(self) -> None:
        if not self.before_dir.exists() or not self.after_dir.exists():
            self.pairs = []
            self.canvas.delete("all")
            self.status.set("目录不存在，请重新选择 Before 和 After 图像目录。")
            return
        self.pairs = find_pairs(self.before_dir, self.after_dir, self.mask_dir)
        if not self.pairs:
            self.canvas.delete("all")
            self.status.set("没有找到同名配对图像。请确认两个目录里的文件名一致。")
            return
        self.render()

    def current_paths(self) -> tuple[str, Path, Path, Path | None]:
        return self.pairs[self.index]

    def current_image_path(self) -> Path:
        _name, before_path, after_path, _mask_path = self.current_paths()
        return after_path if self.mode == "after" else before_path

    @staticmethod
    def _cache_put(cache: OrderedDict, key, value, limit: int):
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > limit:
            cache.popitem(last=False)
        return value

    def clear_caches(self) -> None:
        self._source_cache.clear()
        self._photo_cache.clear()

    def _load_source(self, path: Path, mode: str | None) -> Image.Image:
        key = (file_cache_key(path), mode)
        cached = self._source_cache.get(key)
        if cached is not None:
            self._source_cache.move_to_end(key)
            return cached
        with Image.open(path) as opened:
            image = opened.convert(mode) if mode else opened.copy()
            image.load()
        return self._cache_put(self._source_cache, key, image, 4)

    @staticmethod
    def _visible_extent(
        source_size: tuple[int, int],
        display_size: tuple[int, int],
        x: float,
        y: float,
        clip_rect: tuple[float, float, float, float],
    ) -> tuple[tuple[int, int], tuple[float, float, float, float], tuple[float, float]] | None:
        source_w, source_h = source_size
        display_w, display_h = display_size
        left = x - display_w / 2
        top = y - display_h / 2
        visible_left = max(left, clip_rect[0])
        visible_top = max(top, clip_rect[1])
        visible_right = min(left + display_w, clip_rect[2])
        visible_bottom = min(top + display_h, clip_rect[3])
        if visible_right <= visible_left or visible_bottom <= visible_top:
            return None
        output_size = (
            max(1, int(round(visible_right - visible_left))),
            max(1, int(round(visible_bottom - visible_top))),
        )
        source_box = (
            (visible_left - left) * source_w / display_w,
            (visible_top - top) * source_h / display_h,
            (visible_right - left) * source_w / display_w,
            (visible_bottom - top) * source_h / display_h,
        )
        draw_position = (
            (visible_left + visible_right) / 2,
            (visible_top + visible_bottom) / 2,
        )
        return output_size, source_box, draw_position

    def _draw_image_layer(
        self,
        path: Path,
        image: Image.Image,
        source_size: tuple[int, int],
        display_size: tuple[int, int],
        x: float,
        y: float,
        clip_rect: tuple[float, float, float, float],
    ) -> None:
        extent = self._visible_extent(source_size, display_size, x, y, clip_rect)
        if not extent:
            return
        output_size, source_box, draw_position = extent
        rounded_box = tuple(round(value, 2) for value in source_box)
        key = ("image", file_cache_key(path), output_size, rounded_box, self._fast_render)
        photo = self._photo_cache.get(key)
        if photo is None:
            viewport = render_image_viewport(
                image,
                output_size,
                source_box,
                fast=self._fast_render,
            )
            photo = ImageTk.PhotoImage(viewport)
            self._cache_put(self._photo_cache, key, photo, 18)
        else:
            self._photo_cache.move_to_end(key)
        self.photos.append(photo)
        self.canvas.create_image(
            *draw_position,
            image=photo,
            anchor=tk.CENTER,
            tags=("scene",),
        )

    def _draw_mask_layer(
        self,
        mask_path: Path | None,
        source_size: tuple[int, int],
        display_size: tuple[int, int],
        x: float,
        y: float,
        clip_rect: tuple[float, float, float, float],
    ) -> None:
        if not self.show_mask or not mask_path or not mask_path.exists():
            return
        extent = self._visible_extent(source_size, display_size, x, y, clip_rect)
        if not extent:
            return
        output_size, source_box, draw_position = extent
        try:
            mask = self._load_source(mask_path, None)
            rounded_box = tuple(round(value, 2) for value in source_box)
            key = (
                "mask",
                file_cache_key(mask_path),
                source_size,
                output_size,
                rounded_box,
                self._fast_render,
            )
            photo = self._photo_cache.get(key)
            if photo is None:
                overlay = render_mask_viewport(
                    mask,
                    source_size,
                    output_size,
                    source_box,
                    fast=self._fast_render,
                )
                photo = ImageTk.PhotoImage(overlay)
                self._cache_put(self._photo_cache, key, photo, 18)
            else:
                self._photo_cache.move_to_end(key)
            self.photos.append(photo)
            self.canvas.create_image(
                *draw_position,
                image=photo,
                anchor=tk.CENTER,
                tags=("scene",),
            )
        except Exception as exc:
            self.mask_error = f"Mask error: {mask_path.name}: {exc}"

    # ---------- rendering ----------

    def schedule_render(self, delay: int = 16) -> None:
        if self._render_job:
            try:
                self.root.after_cancel(self._render_job)
            except tk.TclError:
                pass
        self._render_job = self.root.after(delay, self._run_scheduled_render)

    def _run_scheduled_render(self) -> None:
        self._render_job = None
        self.render()

    def render(self) -> None:
        if self._render_job:
            try:
                self.root.after_cancel(self._render_job)
            except tk.TclError:
                pass
            self._render_job = None
        self.update_button_states()
        if not self.pairs:
            self.canvas.delete("all")
            return
        if self.view_mode == "compare":
            self.render_compare()
            return

        path = self.current_image_path()
        try:
            image = self._load_source(path, "RGB")
        except Exception as exc:
            self.status.set(f"无法打开 {path.name}: {exc}")
            return

        self.canvas.delete("all")
        self.photos = []
        self.mask_error = ""
        source_size = image.size
        canvas_w = max(self.canvas.winfo_width(), 1)
        canvas_h = max(self.canvas.winfo_height(), 1)
        fit = min(canvas_w / image.width, canvas_h / image.height)
        scale = max(0.02, fit * self.zoom)
        display_size = (
            max(1, int(image.width * scale)),
            max(1, int(image.height * scale)),
        )
        x = canvas_w // 2 + self.pan_x
        y = canvas_h // 2 + self.pan_y
        self.image_transform = (source_size, display_size, x, y)
        self.image_transforms = [self.image_transform]
        clip_rect = (0, 0, canvas_w, canvas_h)
        self._draw_image_layer(path, image, source_size, display_size, x, y, clip_rect)
        _name, _before, _after, mask_path = self.current_paths()
        self._draw_mask_layer(mask_path, source_size, display_size, x, y, clip_rect)
        self.draw_annotation_preview()
        mode_label = "AFTER" if self.mode == "after" else "BEFORE"
        blink_label = " | 闪烁中" if self.blinking else ""
        name = self.current_paths()[0]
        self.root.title(f"{self.index + 1}/{len(self.pairs)} - {mode_label} - {name}")
        self.status.set(
            f"{self.index + 1}/{len(self.pairs)} | {mode_label}{blink_label} | {name}"
            " | A/D切图 空格切换 B闪烁 V对比 S掩膜 C标签 Q画多边形 E删标注 +/-缩放"
        )
        self.append_mask_status(mask_path)

    def render_compare(self) -> None:
        name, before_path, after_path, mask_path = self.current_paths()
        try:
            before_image = self._load_source(before_path, "RGB")
            after_image = self._load_source(after_path, "RGB")
        except Exception as exc:
            self.status.set(f"无法打开配对图像 {name}: {exc}")
            return

        self.canvas.delete("all")
        self.photos = []
        self.mask_error = ""
        canvas_w = max(self.canvas.winfo_width(), 1)
        canvas_h = max(self.canvas.winfo_height(), 1)
        pane_w = max(canvas_w // 2, 1)
        fit = min(
            pane_w / before_image.width,
            canvas_h / before_image.height,
            pane_w / after_image.width,
            canvas_h / after_image.height,
        )
        scale = max(0.02, fit * self.zoom)
        before_size = (
            max(1, int(before_image.width * scale)),
            max(1, int(before_image.height * scale)),
        )
        after_size = (
            max(1, int(after_image.width * scale)),
            max(1, int(after_image.height * scale)),
        )
        left_x = pane_w // 2 + self.pan_x
        right_x = pane_w + pane_w // 2 + self.pan_x
        y = canvas_h // 2 + self.pan_y
        self.image_transform = None
        self.image_transforms = [
            (before_image.size, before_size, left_x, y),
            (after_image.size, after_size, right_x, y),
        ]
        left_clip = (0, 0, pane_w, canvas_h)
        right_clip = (pane_w, 0, canvas_w, canvas_h)
        self._draw_image_layer(
            before_path, before_image, before_image.size, before_size, left_x, y, left_clip
        )
        self._draw_image_layer(
            after_path, after_image, after_image.size, after_size, right_x, y, right_clip
        )
        self._draw_mask_layer(mask_path, before_image.size, before_size, left_x, y, left_clip)
        self._draw_mask_layer(mask_path, after_image.size, after_size, right_x, y, right_clip)
        self.canvas.create_line(pane_w, 0, pane_w, canvas_h, fill="#3c4043", width=2, tags=("static",))
        self.canvas.create_text(
            14,
            14,
            text="BEFORE",
            fill="#f1f3f4",
            anchor="nw",
            font=("Microsoft YaHei UI", 12, "bold"),
            tags=("static",),
        )
        self.canvas.create_text(
            pane_w + 14,
            14,
            text="AFTER",
            fill="#f1f3f4",
            anchor="nw",
            font=("Microsoft YaHei UI", 12, "bold"),
            tags=("static",),
        )
        self.draw_annotation_preview()
        self.root.title(f"{self.index + 1}/{len(self.pairs)} - 左右对比 - {name}")
        self.status.set(
            f"{self.index + 1}/{len(self.pairs)} | 左右对比 | {name}"
            " | 左Before右After V返回单图 A/D切图 S掩膜 C标签 Q画多边形 E删标注"
        )
        self.append_mask_status(mask_path)

    def append_mask_status(self, mask_path: Path | None) -> None:
        if self.mask_error:
            mask_status = self.mask_error
        elif not self.show_mask:
            mask_status = "MASK OFF"
        elif mask_path and mask_path.exists():
            mask_status = f"MASK ON: {mask_path.name}"
        elif self.mask_dir and self.mask_dir.exists():
            mask_status = "NO MASK"
        else:
            mask_status = "MASK DIR MISSING"
        self.status.set(f"{self.status.get()} | {mask_status} | {self.current_label_description()}")
        if self._mask_operation_busy:
            operation = "保存标注" if self._mask_operation_kind == "add" else "删除标注"
            self.status.set(f"{self.status.get()} | {operation}正在后台处理中…")
        if self.annotation_mode:
            self.append_annotation_status()

    # ---------- annotation ----------

    def mask_operation_guard(self, action: str) -> bool:
        if not self._mask_operation_busy:
            return True
        operation = "保存标注" if self._mask_operation_kind == "add" else "删除标注"
        self.status.set(f"{operation}正在后台处理中，请完成后再{action}。")
        return False

    def start_mask_operation(self, kind: str, worker, context: dict) -> None:
        self._mask_operation_busy = True
        self._mask_operation_kind = kind
        self._mask_operation_context = context
        self.annotation_mode = False
        self.annotation_points = []
        self.annotation_transform_index = None
        self.update_button_states()
        operation = "保存标注" if kind == "add" else "删除标注"
        self.status.set(f"{operation}正在后台处理中…窗口仍可缩放和查看。")
        Thread(
            target=self._run_mask_operation_worker,
            args=(worker,),
            daemon=True,
            name="mask-operation",
        ).start()
        self._mask_operation_poll_job = self.root.after(30, self.poll_mask_operation)

    def _run_mask_operation_worker(self, worker) -> None:
        try:
            result = worker()
        except Exception as exc:
            self._mask_operation_queue.put(("error", f"{type(exc).__name__}: {exc}"))
        else:
            self._mask_operation_queue.put(("success", result))

    def poll_mask_operation(self) -> None:
        self._mask_operation_poll_job = None
        try:
            result_type, payload = self._mask_operation_queue.get_nowait()
        except Empty:
            if self._mask_operation_busy:
                self._mask_operation_poll_job = self.root.after(30, self.poll_mask_operation)
            return

        context = self._mask_operation_context or {}
        self._mask_operation_busy = False
        self._mask_operation_kind = ""
        self._mask_operation_context = None

        if result_type == "error":
            self._restore_annotation_after_mask_error(context)
            self.render()
            self.status.set(f"Mask 处理失败，标注点已保留，可重试：{payload}")
            return

        result = payload
        target_path = result.get("target_path")
        deleted_pixels = result.get("deleted_pixels")
        if target_path is not None:
            pair_index = context["pair_index"]
            if 0 <= pair_index < len(self.pairs):
                current = self.pairs[pair_index]
                if current[:3] == context["pair"][:3]:
                    self.pairs[pair_index] = (*current[:3], target_path)
            self.clear_caches()

        if context.get("operation") == "erase_region" and not deleted_pixels:
            self.annotation_action = "erase"
            self.annotation_mode = True
            self.annotation_points = [context["point"]]
            self.annotation_transform_index = context["transform_index"]
            self.render()
            self.status.set(
                "点击处没有可删除的连通颜色区域，已改为多边形删除；"
                "继续左键加点，右键/Enter 保存。"
            )
            return

        self.show_mask = True
        self.render()
        if context["action"] == "erase":
            if deleted_pixels is not None:
                self.status.set(
                    f"已删除 Mask 连通颜色区域: {target_path.name} ({deleted_pixels} px)"
                )
            else:
                self.status.set(f"已从 Mask 删除标注区域: {target_path.name}")
        else:
            self.status.set(
                f"已用 {context['label_description']} 标注到 Mask: {target_path.name}"
            )

    def _restore_annotation_after_mask_error(self, context: dict) -> None:
        self.annotation_action = context.get("action", "add")
        self.annotation_mode = True
        self.annotation_points = list(context.get("points", []))
        self.annotation_transform_index = context.get("transform_index")

    def toggle_annotation_mode(self) -> None:
        if not self.mask_operation_guard("切换标注工具"):
            return
        if not self.pairs:
            return
        if self.annotation_mode and self.annotation_action == "add":
            self.annotation_mode = False
        else:
            self.annotation_action = "add"
            self.annotation_mode = True
        self.annotation_points = []
        self.annotation_transform_index = None
        self.update_button_states()
        self.render()

    def toggle_erase_annotation_mode(self) -> None:
        if not self.mask_operation_guard("切换删除工具"):
            return
        if not self.pairs:
            return
        mask_path = self.current_paths()[3]
        if not mask_path or not mask_path.exists():
            self.status.set("当前图片没有 Mask，无法删除标注区域。")
            return
        if self.annotation_mode and self.annotation_action == "erase":
            self.annotation_mode = False
        else:
            self.annotation_action = "erase"
            self.annotation_mode = True
        self.annotation_points = []
        self.annotation_transform_index = None
        self.update_button_states()
        self.render()

    def cancel_annotation(self, *, render: bool = True) -> None:
        self.annotation_mode = False
        self.annotation_points = []
        self.annotation_transform_index = None
        if render and hasattr(self, "canvas"):
            self.render()

    def undo_annotation_point(self) -> None:
        if self.annotation_points:
            self.annotation_points.pop()
        if not self.annotation_points:
            self.annotation_transform_index = None
        self.render()

    def add_annotation_point(self, event) -> str:
        if self._mask_operation_busy:
            return "break"
        point = self.canvas_to_image_point(event.x, event.y)
        if point is None:
            self.status.set("点在图像外，未添加。")
            self.append_annotation_status()
            return "break"
        if self.annotation_action == "erase" and not self.annotation_points:
            if self.start_connected_mask_erase(point):
                return "break"
        self.annotation_points.append(point)
        self.render()
        return "break"

    def finish_annotation(self, _event=None) -> str | None:
        if not self.mask_operation_guard("保存另一个标注"):
            return "break"
        if not self.annotation_mode:
            return None
        if len(self.annotation_points) < 3:
            self.status.set("至少需要 3 个点；Esc 取消，Backspace 撤回点。")
            return "break"
        try:
            self.start_polygon_mask_save()
        except Exception as exc:
            self.status.set(f"保存多边形失败: {exc}")
        return "break"

    def start_connected_mask_erase(self, point: tuple[int, int]) -> bool:
        name, before_path, after_path, mask_path = self.current_paths()
        transform = self.current_annotation_transform()
        if not mask_path or not mask_path.exists() or not transform:
            return False
        source_size = transform[0]
        pair = (name, before_path, after_path, mask_path)
        context = {
            "operation": "erase_region",
            "action": "erase",
            "point": point,
            "points": [],
            "transform_index": self.annotation_transform_index,
            "pair_index": self.index,
            "pair": pair,
        }

        def worker():
            mask = load_mask_for_edit(mask_path, source_size)
            output, deleted_pixels = erase_connected_region(mask, point)
            if deleted_pixels:
                save_mask_atomic(output, mask_path)
            return {"target_path": mask_path if deleted_pixels else None, "deleted_pixels": deleted_pixels}

        self.start_mask_operation("erase_region", worker, context)
        return True

    def start_polygon_mask_save(self) -> None:
        name, before_path, after_path, mask_path = self.current_paths()
        transform = self.current_annotation_transform()
        if not transform:
            raise RuntimeError("没有可用的图像坐标，无法保存标注。")
        source_size = transform[0]
        action = self.annotation_action
        existing_mask = mask_path if mask_path and mask_path.exists() else None
        if not existing_mask:
            if action == "erase":
                raise RuntimeError("当前图片没有 Mask，无法删除标注区域。")
            if not self.mask_dir:
                self.mask_dir = self.default_mask_dir()
                self.mask_var.set(str(self.mask_dir))
            self.mask_dir.mkdir(parents=True, exist_ok=True)
            target_path = self.mask_dir / f"{Path(name).stem}_mask.png"
        else:
            target_path = existing_mask

        points = tuple(self.annotation_points)
        storage_color = self.current_label_mask_color()
        context = {
            "operation": "polygon",
            "action": action,
            "points": points,
            "transform_index": self.annotation_transform_index,
            "pair_index": self.index,
            "pair": (name, before_path, after_path, mask_path),
            "label_description": self.current_label_description(),
        }
        self.save_label_config()

        def worker():
            if existing_mask:
                mask = load_mask_for_edit(existing_mask, source_size)
            else:
                mask = Image.new("RGB", source_size, (0, 0, 0))
            output = paint_polygon(
                mask,
                points,
                storage_color,
                erase=action == "erase",
            )
            save_mask_atomic(output, target_path)
            return {"target_path": target_path, "deleted_pixels": None}

        self.start_mask_operation("add" if action == "add" else "erase_polygon", worker, context)

    def canvas_to_image_point(self, canvas_x: float, canvas_y: float) -> tuple[int, int] | None:
        transforms = self.image_transforms or ([self.image_transform] if self.image_transform else [])
        if not transforms:
            return None
        if self.annotation_transform_index is not None:
            if self.annotation_transform_index >= len(transforms):
                self.annotation_transform_index = None
            else:
                return self.canvas_to_transform_point(
                    canvas_x, canvas_y, transforms[self.annotation_transform_index]
                )
        for index, transform in enumerate(transforms):
            point = self.canvas_to_transform_point(canvas_x, canvas_y, transform)
            if point is not None:
                self.annotation_transform_index = index
                return point
        return None

    @staticmethod
    def canvas_to_transform_point(
        canvas_x: float,
        canvas_y: float,
        transform: tuple[tuple[int, int], tuple[int, int], float, float],
    ) -> tuple[int, int] | None:
        source_size, display_size, image_x, image_y = transform
        source_w, source_h = source_size
        display_w, display_h = display_size
        left = image_x - display_w / 2
        top = image_y - display_h / 2
        if not (left <= canvas_x <= left + display_w and top <= canvas_y <= top + display_h):
            return None
        image_px = round((canvas_x - left) * source_w / display_w)
        image_py = round((canvas_y - top) * source_h / display_h)
        return (
            min(source_w - 1, max(0, int(image_px))),
            min(source_h - 1, max(0, int(image_py))),
        )

    def current_annotation_transform(self):
        transforms = self.image_transforms or ([self.image_transform] if self.image_transform else [])
        if not transforms:
            return None
        if self.annotation_transform_index is not None and self.annotation_transform_index < len(transforms):
            return transforms[self.annotation_transform_index]
        return transforms[0]

    def image_to_canvas_point(self, image_px: int, image_py: int) -> tuple[float, float] | None:
        transform = self.current_annotation_transform()
        if not transform:
            return None
        source_size, display_size, image_x, image_y = transform
        source_w, source_h = source_size
        display_w, display_h = display_size
        left = image_x - display_w / 2
        top = image_y - display_h / 2
        return (
            left + image_px * display_w / source_w,
            top + image_py * display_h / source_h,
        )

    def draw_annotation_preview(self) -> None:
        if not self.annotation_mode or not self.annotation_points:
            return
        canvas_points = [self.image_to_canvas_point(*point) for point in self.annotation_points]
        canvas_points = [point for point in canvas_points if point is not None]
        line_color = (
            ERASE_LINE_COLOR
            if self.annotation_action == "erase"
            else self.current_label()["color"]
        )
        if len(canvas_points) >= 2:
            coords = [value for point in canvas_points for value in point]
            self.canvas.create_line(*coords, fill=line_color, width=2, tags=("scene",))
        for x, y in canvas_points:
            radius = 4
            self.canvas.create_oval(
                x - radius,
                y - radius,
                x + radius,
                y + radius,
                fill=ANNOTATION_POINT_COLOR,
                outline=line_color,
                width=2,
                tags=("scene",),
            )

    def append_annotation_status(self) -> None:
        mode_label = (
            "删除标注区域"
            if self.annotation_action == "erase"
            else self.current_label_description()
        )
        self.status.set(
            f"{self.status.get()} | {mode_label}: 左键加点，右键/Enter保存，"
            f"Backspace撤回，Esc取消 | 点数 {len(self.annotation_points)}"
        )

    def erase_connected_mask_region(self, point: tuple[int, int]) -> tuple[Path | None, int]:
        name, before_path, after_path, mask_path = self.current_paths()
        if not mask_path or not mask_path.exists():
            return None, 0
        transform = self.current_annotation_transform()
        if not transform:
            return None, 0
        source_size = transform[0]
        mask = load_mask_for_edit(mask_path, source_size)
        mask, deleted_pixels = erase_connected_region(mask, point)
        if not deleted_pixels:
            return None, 0
        save_mask_atomic(mask, mask_path)
        self.pairs[self.index] = (name, before_path, after_path, mask_path)
        self.clear_caches()
        return mask_path, deleted_pixels

    def save_annotation_polygon(self) -> Path:
        name, before_path, after_path, mask_path = self.current_paths()
        transform = self.current_annotation_transform()
        if not transform:
            raise RuntimeError("没有可用的图像坐标，无法保存标注。")
        source_size = transform[0]
        if mask_path and mask_path.exists():
            target_path = mask_path
            mask = load_mask_for_edit(mask_path, source_size)
        else:
            if self.annotation_action == "erase":
                raise RuntimeError("当前图片没有 Mask，无法删除标注区域。")
            if not self.mask_dir:
                self.mask_dir = self.default_mask_dir()
                self.mask_var.set(str(self.mask_dir))
            self.mask_dir.mkdir(parents=True, exist_ok=True)
            target_path = self.mask_dir / f"{Path(name).stem}_mask.png"
            mask = Image.new("RGB", source_size, (0, 0, 0))
        mask = paint_polygon(
            mask,
            self.annotation_points,
            self.current_label_mask_color(),
            erase=self.annotation_action == "erase",
        )
        save_mask_atomic(mask, target_path)
        self.save_label_config()
        self.pairs[self.index] = (name, before_path, after_path, target_path)
        self.clear_caches()
        return target_path

    # ---------- navigation, view, deletion ----------

    def reset_tool_after_image_switch(self) -> None:
        self.annotation_mode = False
        self.annotation_action = "add"
        self.annotation_points = []
        self.annotation_transform_index = None
        self.drag_start = None
        self._fast_render = False
        for job_name in ("_render_job", "_quality_job", "_pan_job"):
            job = getattr(self, job_name)
            if job:
                try:
                    self.root.after_cancel(job)
                except tk.TclError:
                    pass
                setattr(self, job_name, None)

    def next_image(self) -> None:
        if not self.mask_operation_guard("切换图片"):
            return
        if not self.pairs:
            return
        self.flash_button(self.next_button)
        self.reset_tool_after_image_switch()
        self.index = (self.index + 1) % len(self.pairs)
        self.reset_view(render=False)
        self.render()

    def prev_image(self) -> None:
        if not self.mask_operation_guard("切换图片"):
            return
        if not self.pairs:
            return
        self.flash_button(self.prev_button)
        self.reset_tool_after_image_switch()
        self.index = (self.index - 1) % len(self.pairs)
        self.reset_view(render=False)
        self.render()

    def toggle_mode(self) -> None:
        if self.pairs:
            self.mode = "before" if self.mode == "after" else "after"
            self.update_button_states()
            self.render()

    def toggle_blink(self) -> None:
        self.blinking = not self.blinking
        if self.blinking:
            self.blink()
        else:
            if self._blink_job:
                try:
                    self.root.after_cancel(self._blink_job)
                except tk.TclError:
                    pass
                self._blink_job = None
            self.render()

    def blink(self) -> None:
        if not self.blinking:
            return
        self.toggle_mode()
        self._blink_job = self.root.after(350, self.blink)

    def toggle_compare(self) -> None:
        if not self.mask_operation_guard("切换对比模式"):
            return
        self.cancel_annotation(render=False)
        self.view_mode = "compare" if self.view_mode == "single" else "single"
        if self.view_mode == "compare" and self.blinking:
            self.blinking = False
        self.render()

    def toggle_mask(self) -> None:
        self.show_mask = not self.show_mask
        self.update_button_states()
        self.render()

    def unique_dest(self, path: Path) -> Path:
        if not path.exists():
            return path
        for index in range(1, 10000):
            candidate = path.with_name(f"{path.stem}_{index}{path.suffix}")
            if not candidate.exists():
                return candidate
        raise RuntimeError(f"无法创建唯一删除目标路径: {path}")

    def delete_pair(self) -> None:
        if not self.mask_operation_guard("删除图片"):
            return
        if not self.pairs:
            return
        original_pair = self.pairs[self.index]
        _name, before_path, after_path, mask_path = original_pair
        deleted_before = self.deleted_root / self.before_dir.name
        deleted_after = self.deleted_root / self.after_dir.name
        deleted_before.mkdir(parents=True, exist_ok=True)
        deleted_after.mkdir(parents=True, exist_ok=True)
        moves = [
            (before_path, self.unique_dest(deleted_before / before_path.name)),
            (after_path, self.unique_dest(deleted_after / after_path.name)),
        ]
        if mask_path and mask_path.exists():
            deleted_mask = self.deleted_root / (self.mask_dir.name if self.mask_dir else "mask")
            deleted_mask.mkdir(parents=True, exist_ok=True)
            moves.append((mask_path, self.unique_dest(deleted_mask / mask_path.name)))

        completed: list[tuple[Path, Path]] = []
        try:
            for source, dest in moves:
                shutil.move(str(source), str(dest))
                completed.append((source, dest))
        except Exception as exc:
            for source, dest in reversed(completed):
                if dest.exists() and not source.exists():
                    shutil.move(str(dest), str(source))
            self.status.set(f"删除移动失败，已回滚: {exc}")
            return

        old_index = self.index
        self.last_deleted = (original_pair, [(dest, source) for source, dest in moves], old_index)
        self.pairs.pop(self.index)
        self.index = min(self.index, max(0, len(self.pairs) - 1))
        self.clear_caches()
        self.reset_view(render=False)
        self.render()

    def permanent_delete_pair(self) -> None:
        if not self.mask_operation_guard("彻底删除图片"):
            return
        if not self.pairs:
            return
        name, before_path, after_path, mask_path = self.current_paths()
        paths = [before_path, after_path]
        if mask_path and mask_path.exists():
            paths.append(mask_path)
        file_list = "\n".join(str(path) for path in paths)
        if not messagebox.askyesno(
            "确认彻底删除",
            f"将永久删除这组文件，无法撤销：\n\n{name}\n\n{file_list}\n\n确定继续吗？",
            icon="warning",
        ):
            return
        try:
            for path in paths:
                if path.exists():
                    path.unlink()
        except Exception as exc:
            self.status.set(f"彻底删除失败: {exc}")
            return
        self.cancel_annotation(render=False)
        self.pairs.pop(self.index)
        self.index = min(self.index, max(0, len(self.pairs) - 1))
        self.clear_caches()
        self.reset_view(render=False)
        self.render()
        if self.pairs:
            self.status.set(f"已彻底删除: {name}")
        else:
            self.canvas.delete("all")
            self.status.set(f"已彻底删除: {name}；没有剩余配对图像。")

    def undo_delete(self) -> None:
        if not self.mask_operation_guard("撤销删除"):
            return
        if not self.last_deleted:
            self.status.set("没有可撤销的删除。")
            return
        original_pair, moves, old_index = self.last_deleted
        try:
            for dest, source in moves:
                source.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(dest), str(source))
        except Exception as exc:
            self.status.set(f"撤销删除失败: {exc}")
            return
        insert_at = min(old_index, len(self.pairs))
        self.pairs.insert(insert_at, original_pair)
        self.index = insert_at
        self.last_deleted = None
        self.clear_caches()
        self.reset_view(render=False)
        self.render()

    def zoom_by(self, factor: float) -> None:
        self.zoom = min(20.0, max(0.05, self.zoom * factor))
        self._fast_render = True
        self.schedule_render(12)
        if self._quality_job:
            try:
                self.root.after_cancel(self._quality_job)
            except tk.TclError:
                pass
        self._quality_job = self.root.after(220, self._finish_quality_render)

    def _finish_quality_render(self) -> None:
        self._quality_job = None
        self._fast_render = False
        self.render()

    def reset_view(self, *, render: bool = True) -> None:
        self.zoom = 1.0
        self.pan_x = 0.0
        self.pan_y = 0.0
        if render:
            self.render()

    def start_pan(self, event) -> str | None:
        if self.annotation_mode:
            return self.add_annotation_point(event)
        self._fast_render = True
        self.drag_start = (event.x, event.y, self.pan_x, self.pan_y)
        return None

    def pan(self, event) -> None:
        if self.annotation_mode or not self.drag_start:
            return
        start_x, start_y, old_pan_x, old_pan_y = self.drag_start
        new_pan_x = old_pan_x + event.x - start_x
        new_pan_y = old_pan_y + event.y - start_y
        delta_x = new_pan_x - self.pan_x
        delta_y = new_pan_y - self.pan_y
        self.pan_x = new_pan_x
        self.pan_y = new_pan_y
        self.canvas.move("scene", delta_x, delta_y)
        if self.image_transform:
            source_size, display_size, image_x, image_y = self.image_transform
            self.image_transform = (
                source_size,
                display_size,
                image_x + delta_x,
                image_y + delta_y,
            )
            self.image_transforms = [self.image_transform]
        elif self.image_transforms:
            self.image_transforms = [
                (source, display, x + delta_x, y + delta_y)
                for source, display, x, y in self.image_transforms
            ]
        if self._pan_job:
            try:
                self.root.after_cancel(self._pan_job)
            except tk.TclError:
                pass
        self._pan_job = self.root.after(70, self._refresh_pan)

    def _refresh_pan(self) -> None:
        self._pan_job = None
        self.render()

    def finish_pan(self, _event) -> None:
        if self.annotation_mode:
            return
        self.drag_start = None
        if self._pan_job:
            try:
                self.root.after_cancel(self._pan_job)
            except tk.TclError:
                pass
            self._pan_job = None
        self._fast_render = False
        self.render()

    def on_mousewheel(self, event) -> None:
        self.zoom_by(1.1 if event.delta > 0 else 1 / 1.1)

    # ---------- keyboard ----------

    def bind_keys(self) -> None:
        self.root.bind_all("<KeyPress>", self.on_key_press)

    def on_key_press(self, event):
        key = event.keysym.lower()
        char = (event.char or "").lower()
        shortcut = key if len(key) == 1 else char
        if shortcut == "c" and self._label_dialog and self._label_dialog.winfo_exists():
            self.close_label_manager()
            return "break"
        if isinstance(event.widget, tk.Entry):
            return None
        if key == "right" or shortcut == "d":
            self.next_image()
            return "break"
        if key == "left" or shortcut == "a":
            self.prev_image()
            return "break"
        if self.annotation_mode:
            if key in {"space", "tab"}:
                self.toggle_mode()
                return "break"
            if key in {"return", "enter"}:
                return self.finish_annotation()
            if key == "backspace":
                self.undo_annotation_point()
                return "break"
            if key == "escape":
                self.cancel_annotation()
                return "break"
            if shortcut == "q":
                self.toggle_annotation_mode()
                return "break"
            if shortcut == "e":
                self.toggle_erase_annotation_mode()
                return "break"
            if shortcut == "s":
                self.toggle_mask()
                return "break"
            if shortcut == "c":
                self.toggle_label_manager()
                return "break"
            return "break"
        if key in {"space", "tab"}:
            self.toggle_mode()
        elif shortcut == "b":
            self.toggle_blink()
        elif shortcut == "v":
            self.toggle_compare()
        elif shortcut == "s":
            self.toggle_mask()
        elif shortcut == "c":
            self.toggle_label_manager()
            return "break"
        elif shortcut == "q":
            self.toggle_annotation_mode()
        elif shortcut == "e":
            self.toggle_erase_annotation_mode()
        elif key == "delete":
            if event.state & 1:
                self.permanent_delete_pair()
            else:
                self.delete_pair()
        elif shortcut == "u" or (shortcut == "z" and event.state & 4):
            self.undo_delete()
        elif shortcut in {"+", "="}:
            self.zoom_by(1.2)
        elif shortcut == "-":
            self.zoom_by(1 / 1.2)
        elif shortcut in {"0", "r"}:
            self.reset_view()
        elif key == "escape":
            self.close_app()
        return None


def main() -> None:
    if "--self-test" in sys.argv or os.environ.get("PAIR_CHANGE_SELF_TEST") == "1":
        labels = make_default_label_definitions()
        label_colors = {value["color"] for value in labels.values()}
        if (
            set(labels) != set(range(LABEL_MIN, LABEL_MAX + 1))
            or len(label_colors) != LABEL_COUNT
        ):
            raise RuntimeError("0–255 标签色板自检失败")
        source = Image.new("RGB", (320, 240), (30, 50, 70))
        mask = Image.new("RGB", source.size, (0, 0, 0))
        mask = paint_polygon(
            mask,
            ((10, 10), (200, 20), (180, 160)),
            (255, 0, 128),
        )
        viewport = render_image_viewport(source, (160, 120), (0, 0, 320, 240))
        overlay = render_mask_viewport(
            mask,
            mask.size,
            (160, 120),
            (0, 0, 320, 240),
        )
        if viewport.size != (160, 120) or overlay.getbbox() is None:
            raise RuntimeError("内置图像或 Mask 自检失败")
        return
    root = tk.Tk()
    PairChangeViewer(root)
    root.mainloop()


if __name__ == "__main__":
    main()
