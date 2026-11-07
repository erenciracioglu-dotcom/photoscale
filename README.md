# Photoscale — pile volume with your phone

Walk one loop around a stockpile with your Android phone and get its **volume (m³)** and **tonnage (t)**. Everything runs in the browser on the phone: no app to install, no upload, no server.

![Photoscale capture and result](screenshot.png)

**Open it:** https://erenciracioglu-dotcom.github.io/photoscale/ (Chrome on an ARCore Android phone). On any other device you can run the **demo**, which walks a virtual phone around a simulated gravel pile of known volume.

## How to measure
1. Choose the material (or type a bulk density) and tap **Start AR measurement**.
2. Move the phone gently until dots appear, aim the centre dot at the middle of the pile and tap **START**.
3. Walk slowly around the pile, about 2–5 m from its foot, keeping the whole pile and a strip of ground in view.
4. When the ring is almost full the app asks you to slow down; walk a few steps past the yellow start flag until **Loop closed ✓**, then tap **FINISH**.
5. Optional **tape check**: put two markers 5–10 m apart, tape the distance, and tap *Mark A* / *Mark B* on them during the walk. The result page then corrects the phone's scale.

Dots: red = new detail, blue = 3D position being worked out, green = fixed in 3D.

## Pile setup options
- **How can you walk?** *All the way round* (default), or *Only 1–2 sides* for piles against a shed wall or in a corner. With a partial walk, walk the full length of one long side and, if you can, one end. The sides you could not reach are filled in as a mirror image of the measured ones, so this assumes a symmetrical pile. The pile's axes come from the direction of your walk. The centre line comes from the walked end, where both toes are seen; failing that, from a base width you enter, or for peaked piles from the crest.
- **Top you can't see:** *Rounded / peaked* continues the slopes into a peak (cones, ridges). *Flat* continues the measured slopes straight up at their own angle until they meet a flat top, for tall stacker piles whose top cannot be seen from the ground.
- **Tall piles (over about 5 m):** the phone measures the surface only up to roughly 8–10 m away, so it may not reach the top edge. Tap **Top edge** two or three times during the walk while aiming the centre dot at the pile's skyline: the measured slope, continued upwards, meets that sight line at the top edge, which gives the height. A known height can be entered instead (*Pile height*).
- **Pile length:** *up to 25 m* (10 cm grid), *25–80 m* (25 cm grid), *80–300 m* (50 cm grid, covers a 500 m square), so long stockyard piles fit.

## How it works
- **Real-world scale** comes from ARCore motion tracking (WebXR `immersive-ar`, `local` space, gravity aligned).
- **3D points:** FAST corners + pyramidal Lucas–Kanade tracking on a small grey image of the camera feed (WebXR `camera-access`), triangulated with the ARCore camera poses. The engine checks by itself which way up the GPU camera image is.
- **Depth:** ARCore depth-from-motion (`depth-sensing`) is fused in for the near field.
- **Surface and volume:** points go into a height grid (10, 25 or 50 cm cells, by pile size). The ground plane is fitted (RANSAC) to the ground around the pile, and gaps are filled with a thin-plate (biharmonic) surface. For a flat top, or when the top height is known, the measured slopes are continued straight up at their own angle until they meet the top. The volume is the space between surface and ground.
- **Partial walks:** the pile's axes come from the walking direction, the centre line from the walked end (both toes seen) or the entered base width, and the middle of the length from the walked side's corners. The unseen sides are a mirror image of the measured ones.
- **Top edge taps:** each tap is a sight line through the centre dot. The measured slope beneath it, continued upwards, meets that line at the top edge; the median of the taps gives the top height.
- **Error estimate:** phone scale (±1.5% in length → ±4.5% in volume, or ±0.3% with a tape check), unseen areas, ground level spread, and drift where the loop closes.
- The engine runs in a Web Worker; the whole app is one HTML file.

## Accuracy so far (simulated piles)
| Test | True m³ | Measured | Error |
|---|---|---|---|
| Irregular heap, camera + depth | 65.83 | 64.94 | −1.4% |
| Cone with phone scale error +1%, drift and yaw drift | 83.95 | 85.06 | +1.3% |
| Irregular heap, camera dots only (no depth) | 65.83 | 64.99 | −1.3% |
| 14 m ridge, mirrored camera image | 156.94 | 156.46 | −0.3% |
| Stockyard pile 30 × 18 m, 3.6 m, flat top: one long side + one end walked, 3 top-edge taps | 1155.28 | 1148.36 | −0.6% |
| Same pile, one long side only, base width 18 m entered, 3 taps | 1155.28 | 1147.26 | −0.7% |
| Same pile, walked all round, *Flat*, 3 taps | 1155.28 | 1161.15 | +0.5% |
| Same pile, walked all round but left on *Rounded* (the app warns to choose *Flat*) | 1155.28 | 1219.2 | +5.5% |
| Ridge 28 × 12 m, 4.2 m: one long side + one end walked | 561.79 | 558.30 | −0.6% |
| Big pile 90 × 30 m, 7 m, flat top: one long side + one end, 3 taps, *80–300 m* | 11234.9 | 11283.6 | +0.4% |
| Tall pile 60 × 50 m, 10 m, flat top: one long side + one end, 3 taps | 16426.3 | 16378.2 | −0.3% |

Without top-edge taps the flat top is set by the highest point the phone measured. On the simulated piles that gave −12% to +4%; each time the app warned that the top was near the phone's measuring range. A ridge walked on one long side only, with no base width entered, is reported as incomplete (the hidden half cannot be placed) instead of giving a wrong number.

These are synthetic tests of the algorithms. Real piles add things the simulation cannot: lighting, dust, phone-specific tracking quality. Field tests against known volumes are the next step.

## Limits
- Needs Chrome on Android with ARCore. iPhone Safari does not support WebXR AR.
- Free-standing piles, walked all the way round or, if symmetrical, on 1–2 sides. A pile that touches a wall is not handled yet: mirroring would leave out the part against the wall. The base is assumed to continue the ground level around the pile.
- ARCore depth reaches roughly 5–8 m; beyond that only the tracked dots measure the surface, so stay reasonably close.

## Development
Sources are in `src/`; `python build.py` inlines them into the single published file `index.html`.

Tests (Node 18+, Python 3 with `pip install playwright` and `playwright install chromium`):
- `node test/node_depth_test.js` — depth fusion, ground fit and volume on ray-cast cones and heaps.
- `python test/run_sim.py '{"kind":"demo","walkTime":60}'` — the full engine on a rendered walk-around in headless Chrome.
- `python test/ui_test.py` — end-to-end UI with the demo; screenshots in `test/shots/`.
- Pile-setup scenarios: `python test/run_sim.py '{"kind":"tall","path":"L","walk":"partial","top":"flat","size":"medium","topTaps":3,"dump":"grid.json"}'` (kinds: demo, cone, ridge, yard, yardpk, yardbig, tall; paths: circle, rect, L, side), then `python test/analyze_grid.py grid.json tall` to see where any volume error sits.

---

**Türkçe:** Telefonla bir yığının etrafında bir tur yürüyerek hacmini (m³) ve tonajını (t) ölçen web uygulaması. ARCore hareket takibi gerçek ölçeği verir, kamera görüntüsündeki noktalar 3B'ye yerleştirilir, derinlik verisi eklenir ve zeminle yüzey arasındaki hacim hesaplanır. Her şey telefonda çalışır; kurulum ve yükleme yok. Daha doğru sonuç için iki işaret arasını şeritmetreyle ölçüp "Mark A / Mark B" ile ölçek düzeltmesi yapılabilir.
