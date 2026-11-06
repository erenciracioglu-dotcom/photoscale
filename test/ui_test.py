"""End-to-end UI test in a phone-sized headless Chrome: home, demo walk, result, history, guide, settings.
Screenshots go to test/shots/. Usage: python test/ui_test.py [demo_speed]"""
import asyncio, json, os, sys, time
from playwright.async_api import async_playwright
from helpers import serve, CHROME, CHROME_ARGS, ROOT

OUT = os.path.join(ROOT, 'test', 'shots')

async def main():
    os.makedirs(OUT, exist_ok=True)
    speed = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    base = serve()
    shot = lambda n: os.path.join(OUT, n)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=CHROME_ARGS)
        ctx = await b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = await ctx.new_page()
        errors = []
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        await pg.goto(base + '/index.html')
        await pg.evaluate(f"localStorage.setItem('photoscale.speed', '{speed}')")
        await pg.reload(); await pg.wait_for_timeout(1500)
        await pg.screenshot(path=shot('home.png'))
        await pg.click('#btn-demo')
        await pg.wait_for_timeout(9000)
        await pg.screenshot(path=shot('demo_walk1.png'))
        t0 = time.time(); shot2 = False
        while time.time() - t0 < 1500:
            if await pg.evaluate("document.querySelector('#scr-result').classList.contains('active')"):
                break
            pct = await pg.evaluate("document.getElementById('ov-pct').textContent")
            if not shot2 and pct.endswith('%') and int(pct[:-1]) >= 88:
                await pg.screenshot(path=shot('demo_walk2.png')); shot2 = True
            await pg.wait_for_timeout(2000)
        print('demo finished after', round(time.time() - t0), 's', flush=True)
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=shot('result.png'), full_page=True)
        info = await pg.evaluate("({vol: document.getElementById('res-vol').textContent, range: document.getElementById('res-vol-range').textContent, tonnes: document.getElementById('res-ton').textContent, check: document.getElementById('res-truth').textContent, quality: document.getElementById('res-quality').textContent})")
        print('RESULT UI', json.dumps(info), flush=True)
        await pg.click('#v-top'); await pg.wait_for_timeout(500)
        await pg.locator('#res-3d').screenshot(path=shot('result_top.png'))
        await pg.click('#res-save'); await pg.wait_for_timeout(800)
        await pg.click('[data-go=history]'); await pg.wait_for_timeout(600)
        await pg.screenshot(path=shot('history.png'))
        await pg.click('.hitem'); await pg.wait_for_timeout(1200)
        print('reopened from history:', await pg.evaluate("document.getElementById('res-vol').textContent"), flush=True)
        await pg.click('[data-go=guide]'); await pg.wait_for_timeout(400)
        await pg.screenshot(path=shot('guide.png'), full_page=True)
        await pg.click('[data-go=settings]'); await pg.wait_for_timeout(400)
        await pg.screenshot(path=shot('settings.png'), full_page=True)
        print('ERRORS', json.dumps(errors), flush=True)
        await b.close()

asyncio.run(main())
