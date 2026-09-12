import re
import sys
from datetime import date
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIREBASE_MOCKS = PROJECT_ROOT / "tests" / "mocks"
sys.path.insert(0, str(PROJECT_ROOT / ".testdeps"))

from playwright.sync_api import sync_playwright


def main():
    artifacts = PROJECT_ROOT / "tests" / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    browser_errors = []
    console_errors = []
    request_failures = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            args=["--no-sandbox"],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 1000})

        def serve_firebase_mock(route, request):
            module_name = request.url.rsplit("/", 1)[-1]
            mock_path = FIREBASE_MOCKS / module_name
            if not mock_path.is_file():
                route.abort()
                return
            route.fulfill(
                path=str(mock_path),
                content_type="text/javascript; charset=utf-8",
                headers={"Access-Control-Allow-Origin": "*"},
            )

        page.route(
            "https://www.gstatic.com/firebasejs/11.6.1/firebase-*.js",
            serve_firebase_mock,
        )
        page.route(
            "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
            lambda route: route.fulfill(
                body="window.XLSX = {};",
                content_type="text/javascript; charset=utf-8",
            ),
        )
        page.route(
            "https://fonts.googleapis.com/**",
            lambda route: route.fulfill(body="", content_type="text/css; charset=utf-8"),
        )
        page.on("pageerror", lambda error: browser_errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("requestfailed", lambda request: request_failures.append(f"{request.url}: {request.failure}"))
        page.goto("http://127.0.0.1:4178", wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle", timeout=30_000)

        page.locator("#login-email").wait_for(state="visible", timeout=15_000)
        assert page.locator("#login-password").is_visible()
        assert page.locator("#btn-login").is_visible()
        assert "Filippini Cortinas" in page.title()
        if browser_errors:
            raise AssertionError("Erros JavaScript durante a carga: " + " | ".join(browser_errors))
        if console_errors or request_failures:
            raise AssertionError(
                "Falhas durante a carga: "
                + " | ".join(console_errors + request_failures)
            )

        page.locator("#login-email").fill("teste@example.com")
        page.locator("#login-password").press("Enter")
        page.locator("#feedbackMessageLogin").wait_for(state="visible")
        assert page.locator("#login-password").evaluate("element => element === document.activeElement")

        page.locator("#login-email").fill("email-invalido")
        page.locator("#login-password").fill("senha-de-teste")
        page.locator("#login-password").press("Enter")
        assert "e-mail válido" in page.locator("#feedbackMessageLogin").inner_text().lower()

        page.screenshot(path=str(artifacts / "login-smoke.png"), full_page=True)

        page.locator("#login-email").fill("teste@example.com")
        page.locator("#login-password").fill("senha-valida")
        page.locator("#login-password").press("Enter")
        page.locator("#app-container").wait_for(state="visible")
        page.locator("#sync-status").wait_for(state="visible")

        assert page.locator('.modal[role="dialog"][aria-modal="true"][aria-labelledby]').count() == 11
        assert page.locator('button.close-button[aria-label]').count() == 11
        unlabeled_controls = page.evaluate("""() => [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
            .filter(element => {
                const labels = element.labels ? [...element.labels] : [];
                return labels.length === 0 && !element.getAttribute('aria-label');
            })
            .map(element => element.id)
        """)
        assert unlabeled_controls == []

        tabs = page.get_by_role("tab")
        assert tabs.count() == 4
        tabs.nth(0).focus()
        page.keyboard.press("ArrowRight")
        assert tabs.nth(1).get_attribute("aria-selected") == "true"
        assert page.locator("#tab2").is_visible()

        tabs.nth(3).click()
        open_suppliers = page.locator("#btn-abrir-gerenciador-de-fornecedores")
        open_suppliers.click()
        supplier_modal = page.locator("#modalGerenciarFornecedores")
        assert supplier_modal.get_attribute("aria-hidden") == "false"
        assert page.locator("#novoFornecedorModal").evaluate("element => element === document.activeElement")
        page.keyboard.press("Escape")
        assert supplier_modal.get_attribute("aria-hidden") == "true"
        assert open_suppliers.evaluate("element => element === document.activeElement")

        tabs.nth(0).click()
        sort_code = page.locator('th[data-coluna="codigo"] .sort-button')
        sort_code.click()
        assert page.locator('th[data-coluna="codigo"]').get_attribute("aria-sort") == "descending"
        assert page.locator("#btn-adicionar-item-avulso").evaluate(
            "element => element.parentElement.classList.contains('table-toolbar')"
        )

        tabs.nth(1).click()
        page.locator("#btn-adicionar-item-avulso").click()
        product_search = page.locator("#codigoOrcamento")
        product_search.fill("xx")
        assert product_search.get_attribute("aria-expanded") == "true"
        product_search.press("Escape")
        assert product_search.get_attribute("aria-expanded") == "false"

        product_search.fill("TEST-UNIT")
        page.locator("#quantidade").fill("2")
        preview = page.locator("#previewCalculo")
        preview.wait_for(state="visible")
        preview_text = preview.inner_text()
        assert "2 unidade(s)" in preview_text
        assert "400,00" in preview_text
        assert browser_errors == []
        assert console_errors == []

        page.locator("#btn-adicionar-item").click()
        page.locator("#modalAdicionarItem").wait_for(state="hidden")
        assert "Itens Avulsos (1 itens)" in page.locator("#tabelaOrcamento").inner_text()

        page.locator("#btn-duplicar-orcamento").click()
        page.wait_for_function("document.querySelector('#seletorOrcamento').value === 'ORC-02'")
        assert page.locator("#orcamentoId").inner_text() == "ORC-02"
        assert page.locator("#dataOrcamento").input_value() == date.today().isoformat()
        assert page.locator("#prazoValidade").input_value() == ""

        tabs.nth(2).click()
        page.locator("#modoProposta").select_option("reduzida")
        page.emulate_media(media="print")
        reduced_pdf = page.pdf(format="A4", print_background=True, prefer_css_page_size=True)
        reduced_pages = len(re.findall(rb"/Type\s*/Page\b", reduced_pdf))
        assert reduced_pages == 1

        page.emulate_media(media="screen")
        page.locator("#modoProposta").select_option("detalhada")
        page.locator("#mostrarValoresItens").check()
        page.emulate_media(media="print")
        detailed_pdf = page.pdf(format="A4", print_background=True, prefer_css_page_size=True)
        detailed_pages = len(re.findall(rb"/Type\s*/Page\b", detailed_pdf))
        assert 1 <= detailed_pages <= 3

        page.emulate_media(media="screen")

        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        dimensions = page.evaluate("""({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth
        })""")
        assert dimensions["scrollWidth"] <= dimensions["clientWidth"] + 1
        page.screenshot(path=str(artifacts / "app-mobile-smoke.png"), full_page=True)
        browser.close()

    if browser_errors:
        raise AssertionError("Erros JavaScript no navegador: " + " | ".join(browser_errors))

    print(
        "Browser smoke test passou: login, prévia com produto válido, salvamento, "
        "duplicação, validade, impressão e proposta detalhada móvel validados."
    )


if __name__ == "__main__":
    main()
