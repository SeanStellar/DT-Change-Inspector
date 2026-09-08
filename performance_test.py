from __future__ import annotations

from statistics import mean
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

from PIL import Image, ImageDraw

from mask_core import (
    erase_connected_region,
    paint_polygon,
    render_image_viewport,
    render_mask_viewport,
    save_mask_atomic,
)


SOURCE_SIZE = (6000, 4000)
VIEW_SIZE = (1600, 900)


def timed_many(callback, count: int) -> list[float]:
    samples: list[float] = []
    for index in range(count):
        started = perf_counter()
        callback(index)
        samples.append((perf_counter() - started) * 1000)
    return samples


def report(label: str, samples: list[float]) -> None:
    ordered = sorted(samples)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    print(
        f"{label}: avg={mean(samples):.1f} ms, "
        f"p95={p95:.1f} ms, max={max(samples):.1f} ms"
    )


def main() -> None:
    source = Image.new("RGB", SOURCE_SIZE, (54, 78, 96))
    source_draw = ImageDraw.Draw(source)
    for index in range(0, SOURCE_SIZE[0], 300):
        source_draw.line((index, 0, SOURCE_SIZE[0] - index, SOURCE_SIZE[1]), fill=(90, 130, 75), width=12)

    mask = Image.new("RGB", SOURCE_SIZE, (0, 0, 0))
    mask_draw = ImageDraw.Draw(mask)
    colors = ((255, 64, 64), (64, 220, 100), (40, 140, 255), (255, 180, 30))
    for index, color in enumerate(colors):
        left = 350 + index * 1250
        mask_draw.rectangle((left, 500, left + 900, 3200), fill=color)

    boxes = [
        (index * 85.0, index * 45.0, 4200 + index * 85.0, 2400 + index * 45.0)
        for index in range(12)
    ]
    image_samples = timed_many(
        lambda index: render_image_viewport(
            source,
            VIEW_SIZE,
            boxes[index % len(boxes)],
            fast=index % 2 == 0,
        ),
        24,
    )
    mask_samples = timed_many(
        lambda index: render_mask_viewport(
            mask,
            SOURCE_SIZE,
            VIEW_SIZE,
            boxes[index % len(boxes)],
            fast=index % 2 == 0,
        ),
        16,
    )
    polygon_samples = timed_many(
        lambda index: paint_polygon(
            mask,
            ((100, 100), (2000 + index, 180), (1900, 1400), (150, 1300)),
            colors[index % len(colors)],
        ),
        8,
    )
    connected_mask = Image.new("RGB", (1500, 1500), (30, 180, 90))
    connected_samples = timed_many(
        lambda _index: erase_connected_region(connected_mask, (0, 0)),
        3,
    )
    with TemporaryDirectory(dir=Path.cwd()) as directory:
        save_target = Path(directory) / "large_mask.png"
        save_samples = timed_many(
            lambda _index: save_mask_atomic(mask, save_target),
            3,
        )

    report("6000x4000 image viewport", image_samples)
    report("6000x4000 color-mask overlay", mask_samples)
    report("6000x4000 polygon paint", polygon_samples)
    report("1500x1500 connected-label erase", connected_samples)
    report("6000x4000 fast atomic PNG save", save_samples)


if __name__ == "__main__":
    main()
