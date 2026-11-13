import asyncio
import os
import sys
from playwright.async_api import async_playwright

async def run_test():
    print("Starting Playwright E2E verification...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--no-sandbox",
                "--disable-setuid-sandbox"
            ]
        )
        context = await browser.new_context(
            viewport={"width": 390, "height": 844},  # iPhone 14/15 size as per Mind specs
            permissions=["camera"]
        )
        page = await context.new_page()

        # Track console messages
        page.on("console", lambda msg: print(f"[BROWSER CONSOLE {msg.type}] {msg.text}"))
        page.on("pageerror", lambda exc: print(f"[BROWSER PAGE ERROR] {exc}"))

        print("Navigating to http://localhost:8000/ ...")
        await page.goto("http://localhost:8000/", wait_until="networkidle")

        # 1. Verify Header and Branding
        brand_title = await page.text_content(".brand-title")
        brand_sub = await page.text_content(".brand-sub")
        print(f"Header title: {brand_title.strip()} {brand_sub.strip()}")
        assert "MIND" in brand_title, f"Unexpected title: {brand_title}"

        # 2. Verify Zoom UI Controls
        zoom_bar = await page.wait_for_selector(".zoom-controls-bar")
        assert zoom_bar is not None, "Zoom controls bar not found!"

        badge_text = await page.text_content("#zoomBadge")
        print(f"Initial zoom badge: {badge_text.strip()}")
        assert "1.0" in badge_text, f"Initial zoom not 1.0x: {badge_text}"

        # Test preset button 2x
        pill_2x = await page.wait_for_selector('button[data-zoom="2"]')
        await pill_2x.click()
        await page.wait_for_timeout(300)
        badge_text_2 = await page.text_content("#zoomBadge")
        print(f"After clicking 2x pill: {badge_text_2.strip()}")
        assert "2.0" in badge_text_2, f"Zoom badge didn't update to 2.0: {badge_text_2}"

        # Test preset button 3x
        pill_3x = await page.wait_for_selector('button[data-zoom="3"]')
        await pill_3x.click()
        await page.wait_for_timeout(300)
        badge_text_3 = await page.text_content("#zoomBadge")
        print(f"After clicking 3x pill: {badge_text_3.strip()}")
        assert "3.0" in badge_text_3, f"Zoom badge didn't update to 3.0: {badge_text_3}"

        # Test stepper buttons
        btn_zoom_out = await page.wait_for_selector("#btnZoomOut")
        await btn_zoom_out.click()
        await page.wait_for_timeout(200)
        badge_text_stepper = await page.text_content("#zoomBadge")
        print(f"After clicking Zoom Out (-): {badge_text_stepper.strip()}")

        # Reset back to 1x
        pill_1x = await page.wait_for_selector('button[data-zoom="1"]')
        await pill_1x.click()
        await page.wait_for_timeout(300)
        badge_text_reset = await page.text_content("#zoomBadge")
        print(f"After resetting to 1x: {badge_text_reset.strip()}")
        assert "1.0" in badge_text_reset

        # 3. Verify Shutter button and preview elements
        shutter = await page.wait_for_selector("#btnManualSnap")
        assert shutter is not None, "Main shutter button not found!"

        # 4. Test Sample Question trigger (simulates full recognition & solver workflow)
        btn_sample = await page.wait_for_selector("#btnSamplePicker")
        print("Clicking Sample Picker to open sample modal...")
        await btn_sample.click()

        # Wait for sample modal and click the first sample card
        sample_card = await page.wait_for_selector(".sample-card", timeout=5000)
        print("Clicking first sample card to trigger photo synthesis and AI solve...")
        await sample_card.click()

        # Wait for drawer solved state to become visible
        print("Waiting for answer drawer to populate...")
        await page.wait_for_selector("#drawerSolved:not(.hidden)", timeout=15000)

        answer_text = await page.text_content("#correctAnswerText")
        print(f"Correct Answer Banner: {answer_text.strip()}")
        assert len(answer_text.strip()) > 3, "Answer banner is empty!"

        question_text = await page.text_content("#questionText")
        print(f"Question Text: {question_text.strip()[:100]}...")
        assert len(question_text.strip()) > 3, "Question text is empty!"

        options = await page.query_selector_all(".option-pill")
        print(f"Rendered options count: {len(options)}")
        assert len(options) >= 2, f"Expected at least 2 options, got {len(options)}"

        # Verify correct option is highlighted
        correct_option = await page.query_selector(".option-pill.correct")
        assert correct_option is not None, "No option marked as .correct!"
        correct_opt_text = await correct_option.text_content()
        print(f"Correct highlighted option: {correct_opt_text.strip()[:80]}...")

        # 5. Verify the 'Сфотографировать следующий вопрос' button exists and is clickable
        btn_next = await page.wait_for_selector("#btnNewPhoto")
        assert btn_next is not None, "Next photo button (#btnNewPhoto) not found!"
        is_visible = await btn_next.is_visible()
        assert is_visible, "#btnNewPhoto is not visible!"

        # Take screenshot of answered state
        screenshot_path = "e2e_answer_drawer.png"
        await page.screenshot(path=screenshot_path)
        print(f"Saved screenshot: {screenshot_path}")

        print("Clicking 'Сфотографировать следующий вопрос'...")
        await btn_next.click()
        await page.wait_for_timeout(500)

        # Verify status label restored
        status_label = await page.text_content("#statusLabel")
        print(f"Status label after reset: {status_label.strip()}")

        # 6. Test manual photo snapshot click with camera stream
        print("Testing manual shutter click on live camera stream...")
        await shutter.click()
        await page.wait_for_timeout(1000)

        # Verify flash triggered or status changed to АНАЛИЗ / СНИМОК
        status_during_snap = await page.text_content("#statusLabel")
        print(f"Status during snap: {status_during_snap.strip()}")

        print(">>> ALL PLAYWRIGHT TESTS PASSED SUCCESSFULLY! <<<")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(run_test())
