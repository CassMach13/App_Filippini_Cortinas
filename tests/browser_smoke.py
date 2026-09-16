import re
import sys
from datetime import date
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIREBASE_MOCKS = PROJECT_ROOT / "tests" / "mocks"
sys.path.insert(0, str(PROJECT_ROOT / ".testdeps"))

from playwright.sync_api import sync_playwright

CAMPOS_NOVOS_INFO_GERAIS = [
    "celularCliente",
    "nomeComissionado",
    "celularComissionado",
    "proximoFollowUp",
    "observacaoFollowUp",
]


def data_civil_brasilia(page, dias=0):
    return page.evaluate("""async (dias) => {
        const { obterDataCivilAtual } = await import('/date-domain.js');
        const [ano, mes, dia] = obterDataCivilAtual().split('-').map(Number);
        const data = new Date(Date.UTC(ano, mes - 1, dia + dias));
        return [data.getUTCFullYear(), data.getUTCMonth() + 1, data.getUTCDate()]
            .map((parte, indice) => String(parte).padStart(indice === 0 ? 4 : 2, '0'))
            .join('-');
    }""", dias)


def formatar_data(data_civil):
    ano, mes, dia = data_civil.split("-")
    return f"{dia}/{mes}/{ano}"


def documento_orcamento(page, orcamento_id):
    # Lê o documento gravado no Firestore simulado, sem passar pela interface.
    return page.evaluate("""async (id) => {
        const firestore = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js');
        const snapshot = await firestore.getDocs(firestore.collection(null, 'orcamentos'));
        return snapshot.docs.find(documento => documento.id === id)?.data() ?? null;
    }""", orcamento_id)


def texto_visivel(locator):
    return locator.inner_text().replace("\xa0", " ")


def preencher_e_sair(locator, valor):
    locator.fill(valor)
    locator.blur()


def sem_rolagem_horizontal(page):
    dimensions = page.evaluate("""({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
    })""")
    return dimensions["scrollWidth"] <= dimensions["clientWidth"] + 1


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
        assert tabs.count() == 5
        tabs.nth(0).focus()
        page.keyboard.press("ArrowRight")
        assert tabs.nth(1).get_attribute("aria-selected") == "true"
        assert page.locator("#tab2").is_visible()

        page.locator("#btn-tab-3").click()
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

        # Etapa 1: contatos, follow-up, WhatsApp e status comercial.
        page.set_viewport_size({"width": 1440, "height": 1000})
        page.context.route(
            "https://wa.me/**",
            lambda route: route.fulfill(body="WhatsApp simulado", content_type="text/plain; charset=utf-8"),
        )
        hoje = data_civil_brasilia(page)
        amanha = data_civil_brasilia(page, 1)
        ontem = data_civil_brasilia(page, -1)
        status = page.locator("#statusDocumento")
        seletor = page.locator("#seletorOrcamento")
        followup = page.locator("#proximoFollowUp")
        resumo_followups = page.locator("#followupsResumo")

        # 1. Criar orçamento.
        tabs.nth(1).click()
        page.locator("#btn-novo-orcamento").click()
        page.wait_for_function("[...document.querySelectorAll('#seletorOrcamento option')].some(opcao => opcao.value === 'ORC-03')")
        seletor.select_option("ORC-03")
        assert page.locator("#orcamentoId").inner_text() == "ORC-03"
        assert status.inner_text() == "Em negociação"
        preencher_e_sair(page.locator("#nomeCliente"), "Cliente Follow-up")

        # 2. Celular do cliente: inválido não gera link; válido é normalizado.
        celular_cliente = page.locator("#celularCliente")
        whatsapp_cliente = page.locator("#whatsappCliente")
        assert whatsapp_cliente.get_attribute("aria-disabled") == "true"
        assert whatsapp_cliente.get_attribute("href") is None
        preencher_e_sair(celular_cliente, "98765-4321")
        assert celular_cliente.get_attribute("aria-invalid") == "true"
        assert "celular válido" in page.locator("#ajudaCelularCliente").inner_text()
        assert whatsapp_cliente.get_attribute("href") is None
        preencher_e_sair(celular_cliente, "(11) 98765-4321")
        page.wait_for_function("document.getElementById('whatsappCliente').getAttribute('href') === 'https://wa.me/5511987654321'")
        assert celular_cliente.input_value() == "(11) 98765-4321"
        assert celular_cliente.get_attribute("aria-invalid") is None
        assert whatsapp_cliente.get_attribute("aria-disabled") is None
        assert whatsapp_cliente.get_attribute("target") == "_blank"
        assert whatsapp_cliente.get_attribute("rel") == "noopener noreferrer"

        # 3. Arquiteto/comissionado com celular próprio.
        preencher_e_sair(page.locator("#nomeComissionado"), "Arquiteta Teste")
        preencher_e_sair(page.locator("#celularComissionado"), "21 99876-5432")
        page.wait_for_function("document.getElementById('whatsappComissionado').getAttribute('href') === 'https://wa.me/5521998765432'")
        assert page.locator("#celularComissionado").input_value() == "(21) 99876-5432"

        # 4. Follow-up para hoje com observação.
        preencher_e_sair(followup, hoje)
        preencher_e_sair(page.locator("#observacaoFollowUp"), "Ligar para saber a decisão")
        info_orc03 = documento_orcamento(page, "ORC-03")["infoGerais"]
        assert info_orc03["nomeCliente"] == "Cliente Follow-up"
        assert info_orc03["celularCliente"] == "5511987654321"
        assert info_orc03["nomeComissionado"] == "Arquiteta Teste"
        assert info_orc03["celularComissionado"] == "5521998765432"
        assert info_orc03["proximoFollowUp"] == hoje
        assert info_orc03["observacaoFollowUp"] == "Ligar para saber a decisão"

        seletor.select_option("ORC-02")
        preencher_e_sair(followup, ontem)

        # 5. Lista de follow-ups separada em vencidos, hoje e próximos.
        tabs.nth(3).click()
        assert texto_visivel(resumo_followups) == "1 vencido(s) · 1 para hoje · 0 próximo(s)"
        linha_hoje = page.locator('[data-grupo="hoje"] tbody tr')
        linha_vencida = page.locator('[data-grupo="vencidos"] tbody tr')
        assert linha_hoje.count() == 1
        assert linha_vencida.count() == 1
        texto_hoje = texto_visivel(linha_hoje)
        for esperado in [formatar_data(hoje), "ORC-03", "Cliente Follow-up", "Arquiteta Teste",
                         "Ligar para saber a decisão", "(11) 98765-4321", "R$ 0,00"]:
            assert esperado in texto_hoje, esperado
        texto_vencido = texto_visivel(linha_vencida)
        # ORC-02 é a cópia com 10 ambientes de R$ 200 e o item avulso de R$ 400.
        for esperado in [formatar_data(ontem), "ORC-02", "Cliente de Teste", "R$ 2.400,00", "Cadastre um celular válido"]:
            assert esperado in texto_vencido, esperado
        assert linha_vencida.locator("a.btn-whatsapp").count() == 0
        assert page.locator('[data-grupo="proximos"] .followup-vazio').is_visible()

        # 6. Link do WhatsApp abre em nova aba, sem enviar mensagem.
        link_cliente = linha_hoje.locator("a.btn-whatsapp", has_text="WhatsApp cliente")
        link_arquiteto = linha_hoje.locator("a.btn-whatsapp", has_text="WhatsApp arquiteto")
        assert link_cliente.get_attribute("href") == "https://wa.me/5511987654321"
        assert link_arquiteto.get_attribute("href") == "https://wa.me/5521998765432"
        with page.expect_popup() as popup_info:
            link_cliente.click()
        popup = popup_info.value
        popup.wait_for_load_state()
        assert popup.url == "https://wa.me/5511987654321"
        assert popup.evaluate("window.opener === null")
        popup.close()

        # 7. Marcar como perdido mantém o histórico.
        tabs.nth(1).click()
        seletor.select_option("ORC-03")
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#btn-marcar-perdido").click()
        page.wait_for_function("document.getElementById('statusDocumento').textContent === 'Perdido / Não fechado'")
        assert page.locator("#btn-marcar-perdido").is_hidden()
        assert page.locator("#btn-reabrir-negociacao").is_visible()
        assert page.locator("#btn-confirmar-pedido").is_disabled()
        assert page.locator("#btn-adicionar-item-avulso").is_disabled()
        assert page.locator("#descontoGlobal").is_disabled()
        assert page.locator("#condicaoPagamento").is_disabled()
        assert followup.is_disabled()
        assert celular_cliente.is_enabled()
        assert "[PERDIDO]" in seletor.locator("option:checked").inner_text()
        orc03_perdido = documento_orcamento(page, "ORC-03")
        assert orc03_perdido["statusDocumento"] == "perdido"
        assert "pedido" not in orc03_perdido
        assert orc03_perdido["infoGerais"]["proximoFollowUp"] == hoje
        assert orc03_perdido["infoGerais"]["celularCliente"] == "5511987654321"

        # Perdido não pode ser excluído: botão bloqueado e regra de domínio no fluxo.
        excluir = page.locator("#btn-excluir-orcamento")
        assert excluir.is_disabled()
        assert "não podem ser excluídos" in excluir.get_attribute("title")
        dialogos_exclusao = []

        def registrar_dialogo_exclusao(dialog):
            dialogos_exclusao.append(dialog.message)
            dialog.dismiss()

        page.on("dialog", registrar_dialogo_exclusao)
        excluir.evaluate("botao => { botao.disabled = false; botao.click(); }")
        page.remove_listener("dialog", registrar_dialogo_exclusao)
        assert dialogos_exclusao == []
        assert "perdidos / não fechados não podem ser excluídos" in texto_visivel(page.locator("#app-notification"))
        assert documento_orcamento(page, "ORC-03")["statusDocumento"] == "perdido"

        # 8. Perdido sai da lista ativa.
        tabs.nth(3).click()
        assert texto_visivel(resumo_followups) == "1 vencido(s) · 0 para hoje · 0 próximo(s)"
        assert "ORC-03" not in texto_visivel(page.locator("#listaFollowUps"))

        # 9 e 10. Reabrir devolve a negociação sem reativar a data antiga; uma nova data volta à lista.
        tabs.nth(1).click()
        page.locator("#btn-reabrir-negociacao").click()
        page.wait_for_function("document.getElementById('statusDocumento').textContent === 'Em negociação'")
        assert page.locator("#btn-reabrir-negociacao").is_hidden()
        assert page.locator("#btn-marcar-perdido").is_enabled()
        assert excluir.is_enabled()
        assert followup.is_enabled()
        assert followup.input_value() == ""
        assert page.locator("#observacaoFollowUp").input_value() == "Ligar para saber a decisão"
        orc03_reaberto = documento_orcamento(page, "ORC-03")
        assert orc03_reaberto["statusDocumento"] == "orcamento"
        assert "pedido" not in orc03_reaberto
        assert orc03_reaberto["infoGerais"]["proximoFollowUp"] == ""
        assert orc03_reaberto["infoGerais"]["observacaoFollowUp"] == "Ligar para saber a decisão"
        assert orc03_reaberto["infoGerais"]["celularCliente"] == "5511987654321"
        assert orc03_reaberto["infoGerais"]["celularComissionado"] == "5521998765432"
        tabs.nth(3).click()
        assert texto_visivel(resumo_followups) == "1 vencido(s) · 0 para hoje · 0 próximo(s)"
        assert "ORC-03" not in texto_visivel(page.locator("#listaFollowUps"))

        tabs.nth(1).click()
        preencher_e_sair(followup, amanha)
        assert documento_orcamento(page, "ORC-03")["infoGerais"]["proximoFollowUp"] == amanha
        tabs.nth(3).click()
        assert texto_visivel(resumo_followups) == "1 vencido(s) · 0 para hoje · 1 próximo(s)"
        assert "ORC-03" in texto_visivel(page.locator('[data-grupo="proximos"]'))

        # 11. Abrir outro orçamento pela lista e transformá-lo em pedido.
        page.locator('[data-grupo="vencidos"] .btn-abrir-orcamento').click()
        assert page.locator("#tab2").is_visible()
        assert page.locator("#orcamentoId").inner_text() == "ORC-02"
        page.once("dialog", lambda dialog: dialog.accept())
        page.locator("#btn-confirmar-pedido").click()
        status_pedido = f"Pedido confirmado em {formatar_data(hoje)}"
        page.wait_for_function("(esperado) => document.getElementById('statusDocumento').textContent === esperado", arg=status_pedido)

        # 12. Status e data de confirmação visíveis.
        assert documento_orcamento(page, "ORC-02")["pedido"]["confirmadoEm"]
        assert "[PEDIDO]" in seletor.locator("option:checked").inner_text()
        tabs.nth(2).click()
        assert page.locator("#statusDocumentoProposta").inner_text() == status_pedido

        # 13. Pedido não pode ser marcado como perdido e continua congelado.
        tabs.nth(1).click()
        assert page.locator("#btn-marcar-perdido").is_disabled()
        assert "não podem ser marcados como perdidos" in page.locator("#btn-marcar-perdido").get_attribute("title")
        assert page.locator("#btn-reabrir-negociacao").is_hidden()
        assert page.locator("#btn-adicionar-item-avulso").is_disabled()
        assert excluir.is_disabled()
        assert "Pedidos confirmados não podem ser excluídos" in excluir.get_attribute("title")
        assert page.locator("#btn-confirmar-pedido").is_disabled()
        assert followup.is_disabled()
        tabs.nth(3).click()
        assert texto_visivel(resumo_followups) == "0 vencido(s) · 0 para hoje · 1 próximo(s)"

        # Documento antigo aberto e percorrido não ganha campos padrão.
        tabs.nth(1).click()
        seletor.select_option("ORC-01")
        for campo in CAMPOS_NOVOS_INFO_GERAIS:
            page.locator(f"#{campo}").focus()
            page.locator(f"#{campo}").blur()
        info_orc01 = documento_orcamento(page, "ORC-01")["infoGerais"]
        assert [campo for campo in CAMPOS_NOVOS_INFO_GERAIS if campo in info_orc01] == []

        # A aba de follow-ups não aparece na impressão.
        tabs.nth(3).click()
        page.emulate_media(media="print")
        assert page.locator("#tab-followups").evaluate("elemento => getComputedStyle(elemento).display") == "none"
        page.emulate_media(media="screen")

        # Celular: sem rolagem horizontal nas telas alteradas.
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        assert page.locator('[data-grupo="proximos"] thead').is_hidden()
        assert sem_rolagem_horizontal(page)
        page.screenshot(path=str(artifacts / "followups-mobile-smoke.png"), full_page=True)
        tabs.nth(1).click()
        page.wait_for_timeout(100)
        assert sem_rolagem_horizontal(page)

        assert console_errors == []
        assert request_failures == []
        browser.close()

    if browser_errors:
        raise AssertionError("Erros JavaScript no navegador: " + " | ".join(browser_errors))

    print(
        "Browser smoke test passou: login, prévia com produto válido, salvamento, "
        "duplicação, validade, impressão, proposta detalhada móvel, contatos, WhatsApp, "
        "follow-ups, status perdido/reaberto e pedido confirmado validados."
    )


if __name__ == "__main__":
    main()
