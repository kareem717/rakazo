"""Offline safety checks for the optional driver; no SDK or browser is installed."""
import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

loader = importlib.machinery.SourceFileLoader("patchright_browser", str(Path(__file__).with_name("rakazo-patchright-browser")))
spec = importlib.util.spec_from_loader(loader.name, loader)
driver = importlib.util.module_from_spec(spec)
loader.exec_module(driver)


class PatchrightBrowserTest(unittest.TestCase):
    def test_rejects_url_credentials_without_navigating(self):
        page = Mock()
        with patch.object(driver, "select_page", return_value=page):
            with self.assertRaisesRegex(RuntimeError, "without embedded credentials"):
                driver.operate(Mock(), "navigate", {"url": "https://fake:password@example.test"})
        page.goto.assert_not_called()

    def test_ignores_disconnect_cleanup_failure_after_confirmed_result(self):
        page = Mock()
        page.context.new_cdp_session.return_value.detach.side_effect = RuntimeError("disconnected")
        result = {"ok": True, "url": "https://example.test", "title": "Fixture", "tree": "", "elements": []}
        with patch.object(driver, "select_page", return_value=page), patch.object(driver.core, "snapshot", return_value=result):
            self.assertIs(driver.operate(Mock(), "snapshot", {}), result)

    def test_native_click_uses_shared_ref_validation_and_protected_fills_use_shared_policy(self):
        page = Mock()
        fill = {"kind": "fill", "ref": "e2", "text": "fake-password", "origin": "https://example.test"}

        def actions(_session, _id, steps, perform_action):
            perform_action({"kind": "click", "ref": "e1"})
            perform_action(fill)
            return {"ok": True, "completed": 2}

        with patch.object(driver, "select_page", return_value=page), \
                patch.object(driver.core, "act", side_effect=actions), \
                patch.object(driver.core, "eval_json", return_value={"x": 12, "y": 34}) as evaluate, \
                patch.object(driver.core, "apply_action", return_value={}) as apply:
            result = driver.operate(Mock(), "act", {"actions": []})
        self.assertEqual(result["completed"], 2)
        self.assertIn('clickPoint("e1")', evaluate.call_args.args[2])
        page.mouse.click.assert_called_once_with(12, 34)
        self.assertEqual(apply.call_args.args[2], fill)

    def test_refuses_ambiguous_visible_tabs(self):
        pages = [Mock(), Mock()]
        for page in pages:
            page.evaluate.side_effect = [True, False]
        browser = Mock(contexts=[Mock(pages=pages)])
        with self.assertRaisesRegex(RuntimeError, "unambiguous"):
            driver.select_page(browser)


if __name__ == "__main__":
    unittest.main()
