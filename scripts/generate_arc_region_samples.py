#!/usr/bin/env python3
from __future__ import annotations

from collections import defaultdict
from pathlib import Path


CELL_SIZE_MM = 0.5
OUTER_CORNER_RADIUS_MM = CELL_SIZE_MM * 0.4
INNER_CORNER_RADIUS_MM = OUTER_CORNER_RADIUS_MM * 0.5
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "demo"
OUTPUT_PREFIX = "performance-test-arc-region"
TEMP_OUTPUT_PATH = OUTPUT_DIR / f"{OUTPUT_PREFIX}-tmp.gbr"
PILLAR_COUNT = 10
PILLAR_GAP = 1
BLOCK_COUNT = 10
BLOCK_GAP = 3
ROW_COUNT = 10
ROW_GAP = 3
HUGE_BLOCK_COUNT = 3
HUGE_BLOCK_GAP = 12

BASE_PILLAR_PATTERN = (
    "###",
    "..#",
    "###",
    "#..",
    "###",
    "..#",
    "###",
    "#..",
    "###",
    "..#",
    "###",
    "#..",
    "###",
    "..#",
    "###",
    "#..",
    "###",
    "..#",
    "###",
    "#..",
    "###",
    "..#",
    "###",
    "#..",
    "###",
    "..#",
    "###",
    "#..",
    "###",
    "..#",
    "###",
    "#..",
    "###",
    "..#",
    "###",
    "#..",
    "###",
)

Point = tuple[int, int]


def build_block_pattern() -> tuple[str, ...]:
    pillar_width = len(BASE_PILLAR_PATTERN[0])
    height = len(BASE_PILLAR_PATTERN)
    width = PILLAR_COUNT * pillar_width + (PILLAR_COUNT - 1) * PILLAR_GAP
    rows = [["." for _ in range(width)] for _ in range(height)]

    for pillar_index in range(PILLAR_COUNT):
        origin_x = pillar_index * (pillar_width + PILLAR_GAP)
        mirrored = pillar_index % 2 == 1

        for y, base_row in enumerate(BASE_PILLAR_PATTERN):
            row = base_row[::-1] if mirrored else base_row
            for x, value in enumerate(row):
                if value == "#":
                    rows[y][origin_x + x] = "#"

    bottom_y = height - 1
    for pillar_index in range(PILLAR_COUNT - 1):
        left_origin_x = pillar_index * (pillar_width + PILLAR_GAP)
        gap_x = left_origin_x + pillar_width
        connect_y = bottom_y if pillar_index % 2 == 0 else 0
        rows[connect_y][gap_x] = "#"

    return tuple("".join(row) for row in rows)


BLOCK_PATTERN = build_block_pattern()


def build_row_pattern() -> tuple[str, ...]:
    block_width = len(BLOCK_PATTERN[0])
    height = len(BLOCK_PATTERN)
    width = BLOCK_COUNT * block_width + (BLOCK_COUNT - 1) * BLOCK_GAP
    rows = [["." for _ in range(width)] for _ in range(height)]

    for block_index in range(BLOCK_COUNT):
        origin_x = block_index * (block_width + BLOCK_GAP)
        for y, block_row in enumerate(BLOCK_PATTERN):
            for x, value in enumerate(block_row):
                if value == "#":
                    rows[y][origin_x + x] = "#"

    for block_index in range(BLOCK_COUNT - 1):
        left_origin_x = block_index * (block_width + BLOCK_GAP)
        gap_start_x = left_origin_x + block_width
        for x in range(gap_start_x, gap_start_x + BLOCK_GAP):
            rows[0][x] = "#"

    return tuple("".join(row) for row in rows)


ROW_PATTERN = build_row_pattern()


def build_huge_block_pattern() -> tuple[str, ...]:
    row_width = len(ROW_PATTERN[0])
    row_height = len(ROW_PATTERN)
    width = row_width
    height = ROW_COUNT * row_height + (ROW_COUNT - 1) * ROW_GAP
    rows = [["." for _ in range(width)] for _ in range(height)]

    for row_index in range(ROW_COUNT):
        origin_y = row_index * (row_height + ROW_GAP)
        for y, row_pattern in enumerate(ROW_PATTERN):
            for x, value in enumerate(row_pattern):
                if value == "#":
                    rows[origin_y + y][x] = "#"

    connector_x = width - 1
    for row_index in range(ROW_COUNT - 1):
        gap_start_y = row_index * (row_height + ROW_GAP) + row_height
        for y in range(gap_start_y, gap_start_y + ROW_GAP):
            rows[y][connector_x] = "#"

    return tuple("".join(row) for row in rows)


HUGE_BLOCK_PATTERN = build_huge_block_pattern()


def fill_horizontal(rows: list[list[str]], y: int, start_x: int, end_x: int) -> None:
    for x in range(min(start_x, end_x), max(start_x, end_x) + 1):
        rows[y][x] = "#"


def fill_vertical(rows: list[list[str]], x: int, start_y: int, end_y: int) -> None:
    for y in range(min(start_y, end_y), max(start_y, end_y) + 1):
        rows[y][x] = "#"


def build_sample_pattern() -> tuple[str, ...]:
    huge_width = len(HUGE_BLOCK_PATTERN[0])
    huge_height = len(HUGE_BLOCK_PATTERN)
    width = HUGE_BLOCK_COUNT * huge_width + (HUGE_BLOCK_COUNT - 1) * HUGE_BLOCK_GAP
    height = HUGE_BLOCK_COUNT * huge_height + (HUGE_BLOCK_COUNT - 1) * HUGE_BLOCK_GAP
    rows = [["." for _ in range(width)] for _ in range(height)]

    for huge_y in range(HUGE_BLOCK_COUNT):
        origin_y = huge_y * (huge_height + HUGE_BLOCK_GAP)
        for huge_x in range(HUGE_BLOCK_COUNT):
            origin_x = huge_x * (huge_width + HUGE_BLOCK_GAP)
            for y, huge_row in enumerate(HUGE_BLOCK_PATTERN):
                for x, value in enumerate(huge_row):
                    if value == "#":
                        rows[origin_y + y][origin_x + x] = "#"

    for huge_y in range(HUGE_BLOCK_COUNT):
        origin_y = huge_y * (huge_height + HUGE_BLOCK_GAP)
        for huge_x in range(HUGE_BLOCK_COUNT - 1):
            left_origin_x = huge_x * (huge_width + HUGE_BLOCK_GAP)
            right_origin_x = (huge_x + 1) * (huge_width + HUGE_BLOCK_GAP)
            fill_horizontal(rows, origin_y, left_origin_x + huge_width - 1, right_origin_x)

    connector_x = width - 1
    for huge_y in range(HUGE_BLOCK_COUNT - 1):
        top_origin_y = huge_y * (huge_height + HUGE_BLOCK_GAP)
        bottom_origin_y = (huge_y + 1) * (huge_height + HUGE_BLOCK_GAP)
        fill_vertical(rows, connector_x, top_origin_y + huge_height - 1, bottom_origin_y)

    return tuple("".join(row) for row in rows)


SAMPLE_PATTERN = build_sample_pattern()


def allocate_grid() -> tuple[list[bytearray], int, int]:
    width = len(SAMPLE_PATTERN[0])
    height = len(SAMPLE_PATTERN)
    grid = [bytearray(width) for _ in range(height)]

    for y, row in enumerate(SAMPLE_PATTERN):
        if len(row) != width:
            raise ValueError("sample rows must have the same width")
        for x, value in enumerate(row):
            if value == "#":
                grid[y][x] = 1

    return grid, width, height


def occupied(grid: list[bytearray], width: int, height: int, x: int, y: int) -> bool:
    return 0 <= x < width and 0 <= y < height and grid[y][x] == 1


def iter_component_cells(
    grid: list[bytearray],
    visited: list[bytearray],
    width: int,
    height: int,
    start_x: int,
    start_y: int,
) -> list[Point]:
    stack = [(start_x, start_y)]
    visited[start_y][start_x] = 1
    cells: list[Point] = []

    while stack:
        x, y = stack.pop()
        cells.append((x, y))

        for next_x, next_y in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (
                0 <= next_x < width
                and 0 <= next_y < height
                and grid[next_y][next_x] == 1
                and visited[next_y][next_x] == 0
            ):
                visited[next_y][next_x] = 1
                stack.append((next_x, next_y))

    return cells


def remove_collinear(loop: list[Point]) -> list[Point]:
    points = loop
    changed = True

    while changed and len(points) > 2:
        changed = False
        compacted: list[Point] = []
        count = len(points)

        for idx, point in enumerate(points):
            prev_point = points[(idx - 1) % count]
            next_point = points[(idx + 1) % count]
            if (
                prev_point[0] == point[0] == next_point[0]
                or prev_point[1] == point[1] == next_point[1]
            ):
                changed = True
            else:
                compacted.append(point)

        points = compacted

    return points


def boundary_loops(
    grid: list[bytearray],
    width: int,
    height: int,
    cells: list[Point],
) -> list[list[Point]]:
    edges: dict[Point, list[Point]] = defaultdict(list)

    for x, y in cells:
        if not occupied(grid, width, height, x, y - 1):
            edges[(x, y)].append((x + 1, y))
        if not occupied(grid, width, height, x + 1, y):
            edges[(x + 1, y)].append((x + 1, y + 1))
        if not occupied(grid, width, height, x, y + 1):
            edges[(x + 1, y + 1)].append((x, y + 1))
        if not occupied(grid, width, height, x - 1, y):
            edges[(x, y + 1)].append((x, y))

    loops: list[list[Point]] = []
    while edges:
        start = min(edges)
        current = start
        loop = [start]

        while True:
            next_points = edges[current]
            next_point = next_points.pop()
            if not next_points:
                del edges[current]

            if next_point == start:
                break

            loop.append(next_point)
            current = next_point

        loops.append(remove_collinear(loop))

    return loops


def grid_graph_stats(grid: list[bytearray], width: int, height: int) -> tuple[int, int, int]:
    cells = {(x, y) for y in range(height) for x in range(width) if grid[y][x] == 1}
    edges = 0
    for x, y in cells:
        if (x + 1, y) in cells:
            edges += 1
        if (x, y + 1) in cells:
            edges += 1
    return len(cells), edges, edges - (len(cells) - 1)


def unit_direction(start: Point, end: Point) -> Point:
    dx = end[0] - start[0]
    dy = end[1] - start[1]

    if dx > 0:
        return 1, 0
    if dx < 0:
        return -1, 0
    if dy > 0:
        return 0, 1
    if dy < 0:
        return 0, -1
    raise ValueError("zero-length edge")


def scaled_point(point: tuple[float, float]) -> tuple[float, float]:
    return point[0] * CELL_SIZE_MM, point[1] * CELL_SIZE_MM


def fmt(value_mm: float) -> str:
    scaled = round(value_mm * 10_000)
    if scaled < 0:
        return f"-{abs(scaled):07d}"
    return f"{scaled:07d}"


def command_xy(point: tuple[float, float], d_code: str) -> str:
    x_mm, y_mm = scaled_point(point)
    return f"X{fmt(x_mm)}Y{fmt(y_mm)}{d_code}*"


def command_arc(
    end: tuple[float, float],
    center: tuple[float, float],
    start: tuple[float, float],
    d_code: str,
) -> str:
    end_x_mm, end_y_mm = scaled_point(end)
    center_x_mm, center_y_mm = scaled_point(center)
    start_x_mm, start_y_mm = scaled_point(start)
    i_mm = center_x_mm - start_x_mm
    j_mm = center_y_mm - start_y_mm
    return f"X{fmt(end_x_mm)}Y{fmt(end_y_mm)}I{fmt(i_mm)}J{fmt(j_mm)}{d_code}*"


def contour_commands(loop: list[Point]) -> list[str]:
    count = len(loop)
    corners: list[tuple[tuple[float, float], tuple[float, float], tuple[float, float], str]] = []

    for idx, point in enumerate(loop):
        prev_point = loop[(idx - 1) % count]
        next_point = loop[(idx + 1) % count]
        in_dir = unit_direction(prev_point, point)
        out_dir = unit_direction(point, next_point)
        cross = in_dir[0] * out_dir[1] - in_dir[1] * out_dir[0]
        radius_mm = OUTER_CORNER_RADIUS_MM if cross > 0 else INNER_CORNER_RADIUS_MM
        radius = radius_mm / CELL_SIZE_MM

        start = (point[0] - in_dir[0] * radius, point[1] - in_dir[1] * radius)
        end = (point[0] + out_dir[0] * radius, point[1] + out_dir[1] * radius)
        center = (
            point[0] - in_dir[0] * radius + out_dir[0] * radius,
            point[1] - in_dir[1] * radius + out_dir[1] * radius,
        )
        g_code = "G03" if cross > 0 else "G02"
        corners.append((start, end, center, g_code))

    commands = [command_xy(corners[0][1], "D02"), "G01*"]
    mode = "G01"

    for idx in range(1, count + 1):
        corner_idx = idx % count
        start, end, center, g_code = corners[corner_idx]

        commands.append(command_xy(start, "D01"))
        if mode != g_code:
            commands.append(f"{g_code}*")
            mode = g_code
        commands.append(command_arc(end, center, start, "D01"))

        if mode != "G01":
            commands.append("G01*")
            mode = "G01"

    return commands


def segment_count_label(segment_count: int) -> str:
    if segment_count >= 1_000_000:
        value = segment_count / 1_000_000
        label = f"{value:.1f}M"
        return label.replace(".0M", "M")

    return f"{round(segment_count / 1_000)}K"


def write_sample() -> None:
    grid, width, height = allocate_grid()
    visited = [bytearray(width) for _ in range(height)]
    component_count = 0
    contour_count = 0
    command_count = 0
    segment_count = 0

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with TEMP_OUTPUT_PATH.open("w", encoding="ascii", newline="\n") as file:
        file.write("G04 Performance test arc region sample*\n")
        file.write("%FSLAX44Y44*%\n")
        file.write("%MOMM*%\n")
        file.write("%LPD*%\n")
        file.write("G75*\n")
        file.write("G36*\n")

        for y in range(height):
            for x in range(width):
                if grid[y][x] == 0 or visited[y][x] != 0:
                    continue

                cells = iter_component_cells(grid, visited, width, height, x, y)
                component_count += 1
                for loop in boundary_loops(grid, width, height, cells):
                    contour_count += 1
                    commands = contour_commands(loop)
                    command_count += len(commands)
                    segment_count += sum(1 for command in commands if command.endswith("D01*"))
                    file.write("\n".join(commands))
                    file.write("\n")

        file.write("G37*\n")
        file.write("M02*\n")

    output_path = OUTPUT_DIR / f"{OUTPUT_PREFIX}-{segment_count_label(segment_count)}.gbr"
    if output_path.exists():
        output_path.unlink()
    TEMP_OUTPUT_PATH.replace(output_path)

    vertex_count, edge_count, cycle_count = grid_graph_stats(grid, width, height)
    print(
        f"{output_path.name}: grid={width}x{height}, cells={vertex_count}, edges={edge_count}, "
        f"cycles={cycle_count}, components={component_count}, contours={contour_count}, "
        f"segments={segment_count}, commands={command_count}, size={output_path.stat().st_size} bytes"
    )


def main() -> None:
    write_sample()


if __name__ == "__main__":
    main()
