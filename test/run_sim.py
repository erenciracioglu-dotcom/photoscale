"""Run the full engine on a rendered, simulated walk-around in headless Chrome.
Usage: python test/run_sim.py '{"kind":"demo","walkTime":60}'
Options: kind (demo|cone|ridge), walkTime (s), depth/camera (bool), scaleErr, drift, yawDrift, flipSim (0-3), seed."""
import asyncio, json, sys
from playwright.async_api import async_playwright
from helpers import serve, CHROME, CHROME_ARGS

async def main():
    opts = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    base = serve()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=CHROME_ARGS)
        pg = await b.new_page()
        pg.on('console', lambda m: print('[console]', m.text, flush=True) if 'GPU stall' not in m.text else None)
        pg.on('pageerror', lambda e: print('[pageerror]', e, flush=True))
        await pg.goto(base + '/test/simtest.html')
        res = await pg.evaluate('o => runTest(o)', opts)
        print('RESULT', json.dumps(opts), json.dumps(res), flush=True)
        await b.close()

asyncio.run(main())
