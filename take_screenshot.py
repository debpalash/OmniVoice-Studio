import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=2)
        await page.goto("http://localhost:5173", wait_until="networkidle")
        await asyncio.sleep(2)  # Wait for initial load
        
        # Take screenshot of design layout
        await page.screenshot(path="pics/omnivoice_studio_1.png")
        
        # Click dub tab
        await page.click("button:has-text('Dub')")
        await asyncio.sleep(1)
        await page.screenshot(path="pics/omnivoice_studio_2.png")
        
        await browser.close()

asyncio.run(main())
