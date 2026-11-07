"""Compare a dumped result grid with the true simulated pile, cell by cell.
Usage: python test/analyze_grid.py grid.json kind
Prints where the volume error comes from: footprint, seen / mirrored / filled
cells, and height bands of the true pile."""
import json, math, sys

def yard_spec(kind):
    t = math.tan(math.radians(35))
    return {'yard': (15, 9, 3.6, False), 'yardpk': (14, 6, 6 * t, True),
            'yardbig': (45, 15, 7, False), 'tall': (30, 25, 10, False),
            'corner': (15, 9, 3.6, False), 'cornerpk': (14, 6, 6 * t, True)}[kind]

def truth_fn(kind):
    a, b, H, peaked = yard_spec(kind)
    t = math.tan(math.radians(35)); run = H / t; pa = a - run; pb = 0 if peaked else b - run
    run_w = 1.5 / t; xw = a - run_w; zw = b - run_w; walled = kind.startswith('corner')
    def h(x, z):
        if walled and (x >= xw or z >= zw): return 0.0   # the wall and beyond are not pile
        dx = max(0, abs(x) - pa); dz = max(0, abs(z) - pb)
        v = H - math.hypot(dx, dz) * t
        if 0 < v < H - 0.05: v += 0.05 * math.sin(0.9 * x + 0.3) * math.cos(1.1 * z) * min(1, v)
        return max(0, min(H, v))
    return h, H

g = json.load(open(sys.argv[1])); kind = sys.argv[2]
h, H = truth_fn(kind)
nx, nz, s, x0, z0 = g['nx'], g['nz'], g['s'], g['x0'], g['z0']
Z, M = g['Z'], g['mask']
cls_err = {'seen': 0, 'mirrored': 0, 'filled': 0}
cls_vol = {'seen': 0, 'mirrored': 0, 'filled': 0}
bands = [(0, 2), (2, 4), (4, 6), (6, 8), (8, H - 0.01), (H - 0.01, H + 1)]
band_err = [0.0] * len(bands); band_n = [0] * len(bands)
miss_vol = extra_vol = 0.0; Vt = Ve = 0.0
for k in range(nz):
    for i in range(nx):
        j = k * nx + i; x = x0 + i * s; z = z0 + k * s
        ht = h(x, z); Vt += ht * s * s
        inreg = M[j] & 1
        if not inreg:
            if ht > 0.06: miss_vol += ht * s * s
            continue
        ze = Z[j] if Z[j] is not None else 0.0
        Ve += max(ze, -0.05) * s * s
        c = 'seen' if M[j] & 2 else ('mirrored' if M[j] & 4 else 'filled')
        cls_err[c] += (ze - ht) * s * s; cls_vol[c] += ze * s * s
        if ht <= 0.06: extra_vol += ze * s * s
        for q, (lo, hi) in enumerate(bands):
            if lo <= ht < hi: band_err[q] += (ze - ht) * s * s; band_n[q] += 1; break
print(f'truth {Vt:.1f} (grid), estimate {Ve:.1f}, error {Ve - Vt:+.1f} ({(Ve / Vt - 1) * 100:+.2f}%)')
print(f'footprint missed (true pile outside region): -{miss_vol:.1f}; region where truth is ground: +{extra_vol:.1f}')
for c in cls_err: print(f'{c:9s} volume {cls_vol[c]:9.1f}  error {cls_err[c]:+8.1f}')
for (lo, hi), e, n in zip(bands, band_err, band_n):
    print(f'true height {lo:4.1f}-{min(hi, H):4.1f} m: cells {n:6d}  error {e:+8.1f} m3  mean {e / max(1, n) / s / s:+.3f} m')
