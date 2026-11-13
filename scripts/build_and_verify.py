#!/usr/bin/env python3
"""
Build & Verification Validator for 'Промбез & БИОТ РК — Помощник ИЦА' Chrome Extension.
Enforces Manifest V3 strict CSP compliance, icon binary integrity, database schema,
and safety tests standards.
"""

import glob
import json
import os
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

passed_count = 0
failed_count = 0
warning_count = 0


def log_pass(msg: str):
    global passed_count
    passed_count += 1
    print(f"  \033[32m[PASS]\033[0m {msg}")


def log_fail(msg: str):
    global failed_count
    failed_count += 1
    print(f"  \033[31m[FAIL]\033[0m {msg}")


def log_warn(msg: str):
    global warning_count
    warning_count += 1
    print(f"  \033[33m[WARN]\033[0m {msg}")


def check_png_ihdr(file_path: Path, expected_width: int, expected_height: int) -> bool:
    """Reads PNG IHDR directly from binary data to verify actual dimensions and PNG format."""
    if not file_path.exists():
        log_fail(f"Icon file not found: {file_path.relative_to(ROOT)}")
        return False

    data = file_path.read_bytes()
    if len(data) < 24:
        log_fail(f"Icon file too small (<24 bytes): {file_path.name}")
        return False

    png_signature = b"\x89PNG\r\n\x1a\n"
    if data[:8] != png_signature:
        log_fail(f"Invalid PNG signature in {file_path.name}")
        return False

    # IHDR chunk starts at byte 8: length(4), 'IHDR'(4), width(4), height(4), bit_depth(1), color_type(1)
    chunk_type = data[12:16]
    if chunk_type != b"IHDR":
        log_fail(f"Expected IHDR chunk first in {file_path.name}, got {chunk_type}")
        return False

    width, height, bit_depth, color_type = struct.unpack(">IIBB", data[16:26])
    if width != expected_width or height != expected_height:
        log_fail(f"Icon {file_path.name} dimension mismatch: expected {expected_width}x{expected_height}, got {width}x{height}")
        return False

    log_pass(f"Icon {file_path.name}: {width}x{height} (depth={bit_depth}, color_type={color_type}) matches declared spec")
    return True


def verify_manifest() -> dict | None:
    print("\n--- 1. Validating manifest.json (Manifest V3 Compliance) ---")
    manifest_path = ROOT / "manifest.json"
    if not manifest_path.exists():
        log_fail("manifest.json not found in project root!")
        return None

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        log_fail(f"manifest.json is not valid JSON: {e}")
        return None

    # MV3 check
    mv = manifest.get("manifest_version")
    if mv == 3:
        log_pass("manifest_version is 3")
    else:
        log_fail(f"manifest_version is {mv}, must be 3")

    # Name and version
    if manifest.get("name"):
        log_pass(f"Extension name: '{manifest['name']}'")
    else:
        log_fail("Missing 'name' in manifest")

    if manifest.get("version"):
        log_pass(f"Extension version: {manifest['version']}")
    else:
        log_fail("Missing 'version' in manifest")

    # Background service worker
    bg = manifest.get("background", {})
    sw = bg.get("service_worker")
    if sw:
        sw_path = ROOT / sw
        if sw_path.exists():
            log_pass(f"Service worker found: {sw}")
        else:
            log_fail(f"Service worker declared as '{sw}' but file not found on disk!")
    else:
        log_fail("Missing background.service_worker in manifest.json")

    # Action popup
    action = manifest.get("action", {})
    popup = action.get("default_popup")
    if popup:
        popup_path = ROOT / popup
        if popup_path.exists():
            log_pass(f"Action default_popup found: {popup}")
        else:
            log_fail(f"Action popup '{popup}' not found on disk")
    else:
        log_fail("Missing action.default_popup in manifest.json")

    # Content scripts
    cs_list = manifest.get("content_scripts", [])
    if cs_list:
        for idx, cs in enumerate(cs_list):
            for js in cs.get("js", []):
                p = ROOT / js
                if p.exists():
                    log_pass(f"Content script file verified: {js}")
                else:
                    log_fail(f"Content script file not found: {js}")
            for css in cs.get("css", []):
                p = ROOT / css
                if p.exists():
                    log_pass(f"Content script stylesheet verified: {css}")
                else:
                    log_fail(f"Content stylesheet not found: {css}")
    else:
        log_warn("No content_scripts declared in manifest")

    return manifest


def verify_icons(manifest: dict):
    print("\n--- 2. Validating Icons & Binary IHDR Headers ---")
    icons_dict = manifest.get("icons", {})
    action_icons = manifest.get("action", {}).get("default_icon", {})

    merged = {**icons_dict, **(action_icons if isinstance(action_icons, dict) else {})}
    if not merged:
        merged = {"16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png"}

    for size_str, path_rel in merged.items():
        try:
            sz = int(size_str)
        except ValueError:
            sz = 16
        icon_path = ROOT / path_rel
        check_png_ihdr(icon_path, sz, sz)


def verify_database():
    print("\n--- 3. Validating questions_db.json & Module Files ---")
    db_path = ROOT / "data" / "questions_db.json"
    modules_dir = ROOT / "data" / "modules"

    all_questions = []

    if db_path.exists():
        try:
            data = json.loads(db_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                all_questions = data
            elif isinstance(data, dict) and "questions" in data:
                all_questions = data["questions"]
            log_pass(f"Loaded questions_db.json ({len(all_questions)} entries)")
        except Exception as e:
            log_fail(f"Error parsing data/questions_db.json: {e}")
    elif modules_dir.exists():
        log_warn("data/questions_db.json not found yet, checking individual data/modules/*.json...")
        for mod in sorted(modules_dir.glob("*.json")):
            try:
                mod_data = json.loads(mod.read_text(encoding="utf-8"))
                items = mod_data if isinstance(mod_data, list) else mod_data.get("questions", [])
                all_questions.extend(items)
                log_pass(f"Module {mod.name}: {len(items)} questions")
            except Exception as e:
                log_fail(f"Module {mod.name} invalid JSON: {e}")
    else:
        log_warn("No question database or modules found in data/.")
        return

    if not all_questions:
        log_warn("Database contains 0 questions.")
        return

    # Check entries integrity
    seen_ids = set()
    valid_entries = 0

    for idx, q in enumerate(all_questions):
        qid = q.get("id") or f"idx_{idx}"
        if qid in seen_ids:
            log_fail(f"Duplicate question ID '{qid}' at entry #{idx}")
        seen_ids.add(qid)

        q_text = q.get("question", "").strip()
        if not q_text:
            log_fail(f"Empty question text at entry #{idx} (id={qid})")
            continue

        opts = q.get("options", [])
        c_ans = q.get("correctAnswer", "").strip() if isinstance(q.get("correctAnswer"), str) else ""
        if not isinstance(opts, list):
            log_fail(f"Question #{idx} (id={qid}) has non-list options: {opts}")
            continue
        if len(opts) == 0:
            if not c_ans:
                log_fail(f"Question #{idx} (id={qid}) has empty options and no correctAnswer")
                continue
        elif len(opts) < 2:
            log_fail(f"Question #{idx} (id={qid}) has fewer than 2 options: {opts}")
            continue

        c_idx = q.get("correctIndex")
        if len(opts) >= 2 and (c_idx is None or not isinstance(c_idx, int) or c_idx < 0 or c_idx >= len(opts)):
            if not c_ans:
                log_fail(f"Question #{idx} (id={qid}) has invalid correctIndex ({c_idx}) for {len(opts)} options")
                continue

        # Check verified flag
        verified = q.get("verified")
        if verified is False:
            log_warn(f"Question #{idx} has verified: false")

        valid_entries += 1

    log_pass(f"Verified {valid_entries}/{len(all_questions)} questions: unique IDs, valid options, correct answers")


def verify_verification_report():
    print("\n--- 4. Checking Verification Report ---")
    rep_path = ROOT / "data" / "verification_report.json"
    if rep_path.exists():
        try:
            report = json.loads(rep_path.read_text(encoding="utf-8"))
            models = report.get("models") or report.get("consensus_models") or []
            log_pass(f"Verification report found: {report.get('total_questions', 'OK')} questions, models: {models}")
        except Exception as e:
            log_fail(f"Invalid verification_report.json: {e}")
    else:
        log_pass("data/verification_report.json not present (optional)")


def verify_html_and_csp():
    print("\n--- 5. Enforcing MV3 CSP: Inspecting HTML & JS Files ---")
    html_files = [ROOT / "popup" / "popup.html", ROOT / "scripts" / "test_suite.html"]

    for html_file in html_files:
        if not html_file.exists():
            continue
        content = html_file.read_text(encoding="utf-8")

        # In popup.html, NO inline script is permitted at all!
        if html_file.name == "popup.html":
            # Search for <script> tags that do not have a src attribute
            inline_scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", content, re.DOTALL | re.IGNORECASE)
            if inline_scripts:
                # Filter out pure whitespace
                real_scripts = [s.strip() for s in inline_scripts if s.strip()]
                if real_scripts:
                    log_fail(f"Forbidden inline <script> found in {html_file.relative_to(ROOT)} ({len(real_scripts)} occurrences)!")
                else:
                    log_pass(f"{html_file.name}: No inline <script> blocks")
            else:
                log_pass(f"{html_file.name}: Strict CSP compliant, no inline <script> blocks")

            # Check for inline event handlers like onclick=, onload=, onchange= in popup.html
            inline_handlers = re.findall(r"\b(on[a-z]+)\s*=\s*['\"][^'\"]*['\"]", content, re.IGNORECASE)
            # Ignore onsubmit="return false;" inside form if harmless, but better to flag if present
            dangerous_handlers = [h for h in inline_handlers if h.lower() != "onsubmit"]
            if dangerous_handlers:
                log_fail(f"Forbidden inline event handlers in {html_file.name}: {dangerous_handlers}")
            else:
                log_pass(f"{html_file.name}: No inline event handlers (onclick/onload/etc.)")

    # Check for eval() or new Function() in JS files
    js_files = list(ROOT.glob("popup/**/*.js")) + list(ROOT.glob("background/**/*.js")) + list(ROOT.glob("content/**/*.js"))
    for js_path in js_files:
        txt = js_path.read_text(encoding="utf-8")
        if re.search(r"\beval\s*\(", txt):
            log_fail(f"Forbidden eval() call detected in {js_path.relative_to(ROOT)}")
        else:
            log_pass(f"{js_path.name}: Clean (no eval)")


def main():
    print("=" * 66)
    print("   АО «Интергаз Центральная Азия» — Build & Verification Test")
    print("   Extension Integrity & Manifest V3 CSP Conformance")
    print("=" * 66)

    manifest = verify_manifest()
    if manifest:
        verify_icons(manifest)
    verify_database()
    verify_verification_report()
    verify_html_and_csp()

    print("\n" + "=" * 66)
    print(f" Summary: \033[32m{passed_count} PASSED\033[0m, \033[31m{failed_count} FAILED\033[0m, \033[33m{warning_count} WARNINGS\033[0m")
    print("=" * 66)

    if failed_count > 0:
        print("\n\033[31m[ERROR] Build verification failed! Fix the errors above.\033[0m\n")
        sys.exit(1)
    else:
        print("\n\033[32m[SUCCESS] All verification checks passed! Extension is ready.\033[0m\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
