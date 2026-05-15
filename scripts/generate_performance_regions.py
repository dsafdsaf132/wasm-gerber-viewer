#!/usr/bin/env python3
from pathlib import Path

OUT_DIR = Path('demo')
STEP = 20  # 20 * 1e-5 mm = 0.0002 mm


def make_points(target_vertices: int):
    if (target_vertices - 4) % 2 != 0:
        raise ValueError('target_vertices must satisfy (N-4) even')

    rows = (target_vertices - 4) // 2
    width = rows * STEP

    x, y = width, 0
    pts = [(0, 0), (width, 0)]

    for i in range(rows):
        y += STEP
        pts.append((x, y))
        x = 0 if (i % 2 == 0) else width
        pts.append((x, y))

    if x == width:
        pts.append((width, 0))
    pts.append((0, 0))

    if len(pts) != target_vertices:
        raise RuntimeError(f'Vertex mismatch: got {len(pts)} expected {target_vertices}')

    return pts, rows, width, y


def fmt_coord(v: int) -> str:
    sign = '-' if v < 0 else ''
    return f'{sign}{abs(v):08d}'


def write_file(path: Path, target_vertices: int):
    pts, rows, width, height = make_points(target_vertices)

    with path.open('w', encoding='ascii') as f:
        f.write('G04 Performance test generated for WASM Gerber Viewer*\n')
        f.write(f'G04 Single region with {target_vertices} vertices (ramen-style meander)*\n')
        f.write('G04 Pattern: repeated orthogonal L-like turns, then return to start*\n')
        f.write(f'G04 Bounds (approx): {width*1e-5:.4f} mm x {height*1e-5:.4f} mm*\n')
        f.write('%TF.GenerationSoftware,OpenAI,Codex,2026-05-15*%\n')
        f.write('%TF.FileFunction,Drawing,Top*%\n')
        f.write('%TF.Part,Single*%\n')
        f.write('%FSLAX35Y35*%\n')
        f.write('%MOMM*%\n')
        f.write('G75*\nG01*\n%LPD*%\n')
        f.write('%ADD10C,0.010*%\n')
        f.write('D10*\n')
        f.write('G36*\n')
        sx, sy = pts[0]
        f.write(f'X{fmt_coord(sx)}Y{fmt_coord(sy)}D02*\n')
        for x, y in pts[1:]:
            f.write(f'X{fmt_coord(x)}Y{fmt_coord(y)}D01*\n')
        f.write('G37*\n')
        f.write('M02*\n')


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_file(OUT_DIR / 'performance-test-10K_region.gbr', 10_000)
    write_file(OUT_DIR / 'performance-test-100K_region.gbr', 100_000)
    print('Generated demo/performance-test-10K_region.gbr')
    print('Generated demo/performance-test-100K_region.gbr')


if __name__ == '__main__':
    main()
