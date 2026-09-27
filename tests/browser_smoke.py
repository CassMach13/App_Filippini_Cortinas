import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FIREBASE_MOCKS = PROJECT_ROOT / "tests" / "mocks"
sys.path.insert(0, str(PROJECT_ROOT / ".testdeps"))

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

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


def normalizar(texto):
    return (texto or "").replace("\xa0", " ")


def normalizar_para_busca(texto):
    # Sem acentos e em minúsculas: "Líquido", "LIQUIDO" e "liquido" são o mesmo termo.
    decomposto = unicodedata.normalize("NFKD", normalizar(texto))
    return "".join(caractere for caractere in decomposto if not unicodedata.combining(caractere)).lower()


# Informação econômica interna da Filippini. A aba Proposta Cliente é inteiramente voltada ao cliente:
# nenhum destes termos pode aparecer nela, na tela (inclusive em blocos ocultos e no HTML) ou na impressão.
# Os nomes usados no teste (cliente, produto, ambiente e comissionado) não contêm nenhum destes termos.
TERMOS_INTERNOS = [
    "comissao",
    "comiss",
    "margem",
    "margem liquida",
    "margem com desconto",
    "liquido filippini",
    "liquido",
    "base liquida",
    "sem comissao",
    "custo",
    "informacoes internas",
    "\U0001F512",
    "data-interno",
    "resumointernocomissao",
    "margemcomdesconto",
    "arquiteta parceira",
]
# O relatório ao fornecedor é interno e pode mostrar custo de compra, mas nunca comissão ou margem.
TERMOS_INTERNOS_FORNECEDOR = [termo for termo in TERMOS_INTERNOS if termo != "custo"]
# Valores internos do cenário principal: base 1.000, desconto 10%, comissão 10%, custo 500.
VALORES_INTERNOS_DEZ_PORCENTO = [
    "10,00%", "r$ 1.000,00", "r$ 100,00", "r$ 900,00", "r$ 90,00",
    "r$ 500,00", "r$ 400,00", "50.00%", "50,00%", "44.44%", "44,44%",
]


def verificar_sem_dados_internos(texto, contexto, valores=(), termos=TERMOS_INTERNOS):
    texto_busca = normalizar_para_busca(texto)
    encontrados = [termo for termo in [*termos, *valores] if normalizar_para_busca(termo) in texto_busca]
    assert encontrados == [], f"{contexto}: informação interna exposta {encontrados}"


def verificar_aba_proposta_sem_dados_internos(page, contexto, valores=()):
    # Tela: texto visível, texto de elementos ocultos e o próprio HTML da aba.
    assert page.locator("#tab3").is_visible(), contexto
    assert page.locator("#tab3 #margemComDesconto, #tab3 [data-interno], #tab3 #resumoInternoComissao").count() == 0, contexto
    verificar_sem_dados_internos(page.locator("#tab3").inner_text(), f"{contexto} (texto visível)", valores)
    verificar_sem_dados_internos(page.locator("#tab3").text_content(), f"{contexto} (texto com ocultos)", valores)
    verificar_sem_dados_internos(page.locator("#tab3").inner_html(), f"{contexto} (HTML)", valores)


def verificar_impressao_sem_dados_internos(page, contexto, valores=()):
    page.emulate_media(media="print")
    try:
        texto = normalizar(page.evaluate("document.body.innerText"))
        verificar_sem_dados_internos(texto, contexto, valores)
        assert page.locator("#resumoInternoComissao").evaluate("elemento => elemento.getClientRects().length") == 0
        return texto
    finally:
        page.emulate_media(media="screen")


def aceitar_dialogo(page, mensagens, aceitar=True):
    def tratar(dialog):
        mensagens.append(dialog.message)
        if aceitar:
            dialog.accept()
        else:
            dialog.dismiss()
    page.once("dialog", tratar)


def texto_interno(page, chave):
    return normalizar(page.locator(f'[data-interno="{chave}"]').inner_text())


def itens_do_documento(documento):
    return {
        "itens": documento.get("itens", []),
        "produtos": [produto.get("itens", []) for produto in documento.get("produtosAcabados", [])],
    }


def pedido_participa_financeiro(page, orcamento_id):
    return page.evaluate("""async (id) => {
        const { pedidoParticipaFinanceiro } = await import('/order-domain.js');
        return pedidoParticipaFinanceiro(globalThis.__firestoreMock.lerDiretamente('orcamentos', id));
    }""", orcamento_id)


def notificacao(page):
    return texto_visivel(page.locator("#app-notification"))


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

        assert page.locator('.modal[role="dialog"][aria-modal="true"][aria-labelledby]').count() == 14
        assert page.locator('button.close-button[aria-label]').count() == 14
        unlabeled_controls = page.evaluate("""() => [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
            .filter(element => {
                const labels = element.labels ? [...element.labels] : [];
                return labels.length === 0 && !element.getAttribute('aria-label');
            })
            .map(element => element.id)
        """)
        assert unlabeled_controls == []

        tabs = page.get_by_role("tab")
        assert tabs.count() == 6
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

        # 12. Status e data de confirmação visíveis; a confirmação transacional gera o snapshot v2.
        assert documento_orcamento(page, "ORC-02")["pedido"]["confirmadoEm"]
        assert documento_orcamento(page, "ORC-02")["pedido"]["versaoSnapshot"] == 2
        assert pedido_participa_financeiro(page, "ORC-02")
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
        # Comissão: documento antigo de cliente final mostra 0% e não ganha percentualComissao ao ser percorrido.
        assert not page.locator("#vendaComComissao").is_checked()
        assert page.locator("#percentualComissao").input_value() == "0,00"
        page.locator("#percentualComissao").focus()
        page.locator("#percentualComissao").blur()
        orc01 = documento_orcamento(page, "ORC-01")
        assert "percentualComissao" not in orc01["infoComercial"]
        assert orc01["infoGerais"]["tipoCliente"] == "cliente"

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

        # Etapa 2B: comissão configurável.
        page.set_viewport_size({"width": 1440, "height": 1000})
        venda_com_comissao = page.locator("#vendaComComissao")
        percentual_comissao = page.locator("#percentualComissao")
        ajuda_comissao = page.locator("#ajudaComissao")
        dialogos = []

        # 1. Criar orçamento sem comissão.
        page.locator("#btn-novo-orcamento").click()
        page.wait_for_function("[...document.querySelectorAll('#seletorOrcamento option')].some(opcao => opcao.value === 'ORC-04')")
        seletor.select_option("ORC-04")
        assert page.locator("#orcamentoId").inner_text() == "ORC-04"
        assert not venda_com_comissao.is_checked()
        assert percentual_comissao.input_value() == "0,00"
        assert ajuda_comissao.inner_text() == ""
        orc04 = documento_orcamento(page, "ORC-04")
        assert orc04["infoComercial"]["percentualComissao"] == 0
        assert "tipoCliente" not in orc04["infoGerais"]

        # 2. Cadastrar cliente e comissionado (comissionado com 0% é permitido).
        preencher_e_sair(page.locator("#nomeCliente"), "Cliente Etapa 2B")
        preencher_e_sair(page.locator("#nomeComissionado"), "Arquiteta Parceira")
        page.wait_for_function("document.getElementById('nomeComissionado').value === 'Arquiteta Parceira'")
        assert documento_orcamento(page, "ORC-04")["infoGerais"]["nomeComissionado"] == "Arquiteta Parceira"
        assert documento_orcamento(page, "ORC-04")["infoComercial"]["percentualComissao"] == 0

        # 3. Ativar a comissão: sem itens não há confirmação e o padrão é 10%.
        venda_com_comissao.check()
        page.wait_for_function("document.getElementById('percentualComissao').value === '10,00'")
        assert venda_com_comissao.is_checked()
        assert documento_orcamento(page, "ORC-04")["infoComercial"]["percentualComissao"] == 10
        assert dialogos == []
        # Percentual sem nome do comissionado gera só um aviso discreto.
        page.locator("#nomeComissionado").fill("")
        assert "sem nome do arquiteto" in ajuda_comissao.inner_text()
        page.locator("#nomeComissionado").fill("Arquiteta Parceira")
        assert ajuda_comissao.inner_text() == ""
        page.locator("#nomeComissionado").blur()

        # 4. Adicionar itens: 3 unidades num produto acabado e 2 avulsas (base R$ 200 cada).
        preencher_e_sair(page.locator("#nomeProdutoAcabado"), "Cortina Etapa 2B")
        preencher_e_sair(page.locator("#ambienteProdutoAcabado"), "Sala Etapa 2B")
        page.locator("#btn-criar-produto-acabado").click()
        page.locator(".btn-add-item-to-produto").wait_for(state="visible")
        page.locator(".btn-add-item-to-produto").click()
        page.locator("#modalAdicionarItem").wait_for(state="visible")
        page.locator("#codigoOrcamento").fill("TEST-UNIT")
        page.locator("#codigoOrcamento").press("Escape")
        page.locator("#quantidade").fill("3")
        page.locator("#previewCalculo").wait_for(state="visible")
        assert "660,00" in page.locator("#previewCalculo").inner_text()
        page.locator("#btn-adicionar-item").click()
        page.locator("#modalAdicionarItem").wait_for(state="hidden")

        page.locator("#btn-adicionar-item-avulso").click()
        page.locator("#modalAdicionarItem").wait_for(state="visible")
        page.locator("#codigoOrcamento").fill("TEST-UNIT")
        page.locator("#codigoOrcamento").press("Escape")
        page.locator("#quantidade").fill("2")
        page.locator("#previewCalculo").wait_for(state="visible")
        assert "440,00" in page.locator("#previewCalculo").inner_text()
        page.locator("#btn-adicionar-item").click()
        page.locator("#modalAdicionarItem").wait_for(state="hidden")

        # 5. Conferir valores gravados e exibidos.
        orc04 = documento_orcamento(page, "ORC-04")
        item_produto = orc04["produtosAcabados"][0]["itens"][0]
        item_avulso = orc04["itens"][0]
        for item, sem_comissao, com_comissao in [(item_produto, 600, 660), (item_avulso, 400, 440)]:
            assert item["precoUnitarioBase"] == 200
            assert item["precoTotalSemComissao"] == sem_comissao
            assert item["precoUnitario"] == 220
            assert item["precoTotal"] == com_comissao
            assert [campo for campo in ["valorComissao", "margemLiquida", "margemPercentual"] if campo in item] == []
        itens_com_dez_porcento = itens_do_documento(orc04)
        tabela = normalizar(page.locator("#tabelaOrcamento").text_content())
        for valor in ["R$ 660,00", "R$ 440,00", "R$ 220,00"]:
            assert valor in tabela, valor
        assert texto_interno(page, "percentual") == "10,00%"
        assert texto_interno(page, "subtotal-sem-comissao") == "R$ 1.000,00"
        assert texto_interno(page, "valor-comissao") == "R$ 100,00"
        assert texto_interno(page, "produtos-cobrados") == "R$ 1.100,00"
        assert texto_interno(page, "liquido-filippini") == "R$ 1.000,00"
        assert texto_interno(page, "margem-antes") == "R$ 500,00 (50.00%)"

        # Instalação fica fora da comissão.
        instalacao = page.locator('input[data-ambiente="Sala Etapa 2B"]')
        instalacao.fill("150,00")
        instalacao.blur()
        page.wait_for_function("() => document.querySelector('[data-interno=\"valor-comissao\"]') !== null")

        # 6. Aplicar desconto de 10% na aba Proposta.
        tabs.nth(2).click()
        preencher_e_sair(page.locator("#descontoGlobal"), "10")
        page.wait_for_function("document.getElementById('orcamentoFinal').innerText.includes('990,00')")
        orc04 = documento_orcamento(page, "ORC-04")
        assert orc04["infoComercial"]["descontoGlobal"] == 10
        assert orc04["valoresInstalacao"]["Sala Etapa 2B"] == 150
        # A aba Proposta Cliente não tem indicador de margem, nem na tela.
        assert page.locator("#margemComDesconto").count() == 0

        # 7. Proposta reduzida: valores com a comissão embutida e nenhum dado econômico interno.
        page.locator("#modoProposta").select_option("reduzida")
        proposta = normalizar(page.locator("#orcamentoFinal").inner_text())
        for esperado in ["Cortina Etapa 2B (Sala Etapa 2B)", "R$ 660,00", "R$ 440,00",
                         "Subtotal Geral (Produtos sem desconto):", "R$ 1.100,00", "Desconto (10%):", "- R$ 110,00",
                         "TOTAL DE PRODUTOS (Pago à Filippini):", "R$ 990,00", "R$ 150,00", "R$ 1.140,00"]:
            assert esperado in proposta, esperado
        verificar_aba_proposta_sem_dados_internos(page, "aba Proposta reduzida", VALORES_INTERNOS_DEZ_PORCENTO)

        # 8. Proposta detalhada com valores por item.
        page.locator("#modoProposta").select_option("detalhada")
        page.locator("#mostrarValoresItens").check()
        proposta_detalhada = normalizar(page.locator("#orcamentoFinal").inner_text())
        for esperado in ["Detalhamento dos Itens", "Subtotal do Produto: R$ 660,00", "R$ 440,00", "R$ 1.140,00"]:
            assert esperado in proposta_detalhada, esperado
        verificar_aba_proposta_sem_dados_internos(page, "aba Proposta detalhada", VALORES_INTERNOS_DEZ_PORCENTO)

        # 9. O bloco "🔒 Informações internas" existe uma única vez, dentro da aba Lançamento.
        assert page.evaluate(
            "[...document.querySelectorAll('#resumoInternoComissao')].map(bloco => bloco.closest('[role=\"tabpanel\"]').id)"
        ) == ["tab2"]
        assert "\U0001F512 Informações internas" in normalizar(page.locator("#resumoInternoComissao").text_content())

        # 10. Impressão reduzida e detalhada: nenhum dado interno e paginação preservada.
        page.locator("#modoProposta").select_option("reduzida")
        texto_impresso = verificar_impressao_sem_dados_internos(page, "impressão reduzida", VALORES_INTERNOS_DEZ_PORCENTO)
        assert "R$ 1.140,00" in texto_impresso
        page.emulate_media(media="print")
        assert page.locator("#tab2").evaluate("elemento => getComputedStyle(elemento).display") == "none"
        # A notificação flutuante pode trazer "Comissão alterada para ..." e nunca é impressa.
        assert page.locator("#app-notification").evaluate("elemento => getComputedStyle(elemento).display") == "none"
        pdf_reduzido = page.pdf(format="A4", print_background=True, prefer_css_page_size=True)
        assert len(re.findall(rb"/Type\s*/Page\b", pdf_reduzido)) == 1
        page.emulate_media(media="screen")
        page.locator("#modoProposta").select_option("detalhada")
        texto_impresso_detalhado = verificar_impressao_sem_dados_internos(page, "impressão detalhada", VALORES_INTERNOS_DEZ_PORCENTO)
        assert "Subtotal do Produto: R$ 660,00" in texto_impresso_detalhado
        page.emulate_media(media="print")
        pdf_detalhado = page.pdf(format="A4", print_background=True, prefer_css_page_size=True)
        assert 1 <= len(re.findall(rb"/Type\s*/Page\b", pdf_detalhado)) <= 3
        page.emulate_media(media="screen")

        # 11. Informações internas somente na aba Lançamento.
        tabs.nth(1).click()
        assert page.locator("#resumoInternoComissao").is_visible()
        assert "Não aparecem na proposta nem na impressão" in page.locator("#resumoInternoComissao").inner_text()
        assert texto_interno(page, "desconto-base") == "- R$ 100,00"
        assert texto_interno(page, "base-liquida") == "R$ 900,00"
        assert texto_interno(page, "valor-comissao") == "R$ 90,00"
        assert texto_interno(page, "produtos-cobrados") == "R$ 990,00"
        assert texto_interno(page, "liquido-filippini") == "R$ 900,00"
        assert texto_interno(page, "margem-depois") == "R$ 400,00 (44.44% do líquido)"
        page.locator("#resumoInternoComissao").screenshot(path=str(artifacts / "comissao-resumo-interno.png"))
        page.locator(".grupo-comissionado").screenshot(path=str(artifacts / "comissao-controles-desktop.png"))

        # 12 e 13. Trocar 10% por 5% e aceitar a confirmação.
        mensagem_recalculo = "Alterar o percentual recalculará os preços dos itens deste orçamento. Deseja continuar?"
        aceitar_dialogo(page, dialogos)
        preencher_e_sair(percentual_comissao, "5")
        page.wait_for_function("document.getElementById('percentualComissao').value === '5,00'")
        assert dialogos == [mensagem_recalculo]

        # 14. Novos valores: base, custo e quantidade preservados.
        orc04 = documento_orcamento(page, "ORC-04")
        assert orc04["infoComercial"]["percentualComissao"] == 5
        item_produto = orc04["produtosAcabados"][0]["itens"][0]
        assert item_produto["precoUnitarioBase"] == 200
        assert item_produto["precoTotalSemComissao"] == 600
        assert item_produto["precoUnitario"] == 210
        assert item_produto["precoTotal"] == 630
        assert item_produto["custoReal"] == 300
        assert item_produto["quantidade"] == 3
        assert orc04["itens"][0]["precoTotal"] == 420
        assert venda_com_comissao.is_checked()
        assert texto_interno(page, "valor-comissao") == "R$ 45,00"
        assert texto_interno(page, "produtos-cobrados") == "R$ 945,00"
        assert texto_interno(page, "liquido-filippini") == "R$ 900,00"
        tabs.nth(2).click()
        assert "R$ 1.050,00" in normalizar(page.locator("#orcamentoFinal").inner_text())
        verificar_aba_proposta_sem_dados_internos(page, "aba Proposta com 5%", [
            "5,00%", "r$ 1.000,00", "r$ 900,00", "r$ 45,00", "r$ 500,00", "r$ 400,00", "44.44%", "44,44%",
        ])
        tabs.nth(1).click()

        # 15. Trocar de novo (5 -> 7,5 -> 10) sem acumular: volta exatamente aos itens com 10%.
        aceitar_dialogo(page, dialogos)
        preencher_e_sair(percentual_comissao, "7,5")
        page.wait_for_function("document.getElementById('percentualComissao').value === '7,50'")
        assert documento_orcamento(page, "ORC-04")["itens"][0]["precoTotal"] == 430
        aceitar_dialogo(page, dialogos)
        preencher_e_sair(percentual_comissao, "10")
        page.wait_for_function("document.getElementById('percentualComissao').value === '10,00'")
        orc04 = documento_orcamento(page, "ORC-04")
        assert itens_do_documento(orc04) == itens_com_dez_porcento
        assert texto_interno(page, "valor-comissao") == "R$ 90,00"

        # 16. Cancelar a alteração devolve percentual, itens e totais exatamente como estavam.
        antes_cancelamento = documento_orcamento(page, "ORC-04")
        aceitar_dialogo(page, dialogos, aceitar=False)
        preencher_e_sair(percentual_comissao, "12,34")
        assert dialogos[-1] == mensagem_recalculo
        assert percentual_comissao.input_value() == "10,00"
        assert documento_orcamento(page, "ORC-04") == antes_cancelamento
        aceitar_dialogo(page, dialogos, aceitar=False)
        venda_com_comissao.click()
        assert venda_com_comissao.is_checked()
        assert percentual_comissao.input_value() == "10,00"
        assert documento_orcamento(page, "ORC-04") == antes_cancelamento
        assert texto_interno(page, "valor-comissao") == "R$ 90,00"
        # Valor inválido não gera diálogo nem gravação.
        quantidade_dialogos = len(dialogos)
        preencher_e_sair(percentual_comissao, "150")
        assert len(dialogos) == quantidade_dialogos
        assert percentual_comissao.input_value() == "10,00"
        assert documento_orcamento(page, "ORC-04") == antes_cancelamento

        # 17 e 18. Duplicar: a cópia nasce com o percentual gravado e as mesmas bases.
        page.locator("#btn-duplicar-orcamento").click()
        page.wait_for_function("document.querySelector('#seletorOrcamento').value === 'ORC-05'")
        orc05 = documento_orcamento(page, "ORC-05")
        assert orc05["infoComercial"]["percentualComissao"] == 10
        assert "tipoCliente" not in orc05["infoGerais"]
        assert orc05["infoGerais"]["nomeComissionado"] == "Arquiteta Parceira"
        assert orc05["statusDocumento"] == "orcamento"
        assert itens_do_documento(orc05) == itens_do_documento(antes_cancelamento)
        assert venda_com_comissao.is_checked()
        assert percentual_comissao.input_value() == "10,00"
        assert texto_interno(page, "valor-comissao") == "R$ 90,00"

        # 19. Confirmar o pedido do orçamento original.
        seletor.select_option("ORC-04")
        aceitar_dialogo(page, dialogos)
        page.locator("#btn-confirmar-pedido").click()
        page.wait_for_function("document.getElementById('statusDocumento').textContent.startsWith('Pedido confirmado')")
        pedido04 = documento_orcamento(page, "ORC-04")
        assert pedido04["infoComercial"]["percentualComissao"] == 10
        # Snapshot financeiro v2 congelado em centavos: base 1.000, desconto 10%, comissão 10%, custo 500.
        assert pedido04["pedido"]["versaoSnapshot"] == 2
        assert pedido04["pedido"]["financeiro"] == {
            "dataVenda": hoje,
            "descontoPercentual": 10,
            "percentualComissao": 10,
            "subtotalSemComissaoCentavos": 100000,
            "descontoBaseCentavos": 10000,
            "baseLiquidaCentavos": 90000,
            "valorComissaoCentavos": 9000,
            "valorProdutosCobradoClienteCentavos": 99000,
            "valorLiquidoFilippiniCentavos": 90000,
            "custoProdutosCentavos": 50000,
            "margemCentavos": 40000,
        }
        assert pedido04["pedido"]["proposta"] == {"totalInstalacaoCentavos": 15000, "totalPropostaClienteCentavos": 114000}
        assert pedido04["pedido"]["comissionado"]["nome"] == "Arquiteta Parceira"
        assert pedido04["pedido"]["confirmadoPor"] == "usuario-teste"
        assert pedido_participa_financeiro(page, "ORC-04")
        assert page.evaluate("""async () => {
            const { obterValorReceberCentavos } = await import('/order-domain.js');
            return obterValorReceberCentavos(globalThis.__firestoreMock.lerDiretamente('orcamentos', 'ORC-04').pedido);
        }""") == 99000
        assert "Snapshot financeiro v2" in texto_visivel(page.locator("#infoPedido"))
        assert texto_interno(page, "custo-produtos") == "R$ 500,00"
        assert "Valores congelados na confirmação" in page.locator("#resumoInternoComissao").inner_text()

        # 20. Campo de comissão bloqueado, inclusive se reabilitado à força.
        assert venda_com_comissao.is_disabled()
        assert percentual_comissao.is_disabled()
        quantidade_dialogos = len(dialogos)
        percentual_comissao.evaluate("campo => { campo.disabled = false; campo.value = '5'; campo.dispatchEvent(new Event('change')); }")
        assert "já foi confirmado como pedido" in texto_visivel(page.locator("#app-notification"))
        assert percentual_comissao.input_value() == "10,00"
        assert len(dialogos) == quantidade_dialogos
        assert documento_orcamento(page, "ORC-04") == pedido04

        # Regressão: relatórios do pedido usam só quantidade e custo, sem preço de venda nem comissão.
        page.evaluate("""() => {
            window.__planilhas = [];
            window.print = () => {};
            window.XLSX = {
                utils: {
                    book_new: () => ({}),
                    aoa_to_sheet: linhas => ({ __linhas: linhas }),
                    book_append_sheet: (_livro, aba, nome) => window.__planilhas.push({ nome, linhas: aba.__linhas }),
                    encode_cell: ({ r, c }) => `${r}:${c}`,
                    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } })
                },
                writeFile: () => {}
            };
        }""")
        page.locator("#mostrarCustosFornecedor").check()
        page.locator("#btn-baixar-excel-pedido-ao-fornecedor").click()
        planilhas = page.evaluate("window.__planilhas")
        assert [planilha["nome"] for planilha in planilhas] == ["Fornecedor Teste"]
        linhas_fornecedor = planilhas[0]["linhas"]
        assert linhas_fornecedor[8:] == [
            ["TEST-UNIT", "Produto válido para teste de navegador", "Unidade", 5, 100, 500],
            [],
            ["", "TOTAL", "", "", "", 500],
        ]
        celulas_fornecedor = [celula for linha in linhas_fornecedor for celula in linha]
        verificar_sem_dados_internos(" | ".join(str(celula) for celula in celulas_fornecedor),
                                     "relatório do fornecedor", termos=TERMOS_INTERNOS_FORNECEDOR)
        # Nenhum preço de venda, comissão, base ou líquido; só quantidade e custo de compra.
        assert {660, 440, 1100, 990, 900, 90, 220} & {celula for celula in celulas_fornecedor if isinstance(celula, (int, float))} == set()
        tabs.nth(2).click()
        page.locator("#btn-imprimir-instrucoes-ao-instalador").click()
        relatorio_instalador = normalizar(page.locator("#orcamentoFinal").inner_text())
        assert "Retirada para instalação" in relatorio_instalador
        assert "TEST-UNIT" in relatorio_instalador
        assert "R$" not in relatorio_instalador
        verificar_sem_dados_internos(relatorio_instalador, "relatório do instalador", VALORES_INTERNOS_DEZ_PORCENTO)
        verificar_sem_dados_internos(page.locator("#orcamentoFinal").inner_html(), "HTML do relatório do instalador")
        page.evaluate("window.onafterprint && window.onafterprint()")
        tabs.nth(1).click()

        # Documento antigo de arquiteto: 10% herdados, leitura sem gravação e recálculo sem catálogo.
        orc90 = {
            "id": "ORC-90",
            "statusDocumento": "orcamento",
            "infoGerais": {"nome": "Orçamento ORC-90", "nomeCliente": "Cliente Arquiteto Antigo",
                           "tipoCliente": "arquiteto", "dataOrcamento": "2025-01-01", "prazoEntrega": "30 dias úteis"},
            "infoComercial": {"condicaoPagamento": "À vista", "formaPagamento": "PIX", "descontoGlobal": 0,
                              "observacoesComerciais": ""},
            "itens": [{
                "id": "item-antigo-1", "ambiente": "", "categoria": "Acessórios", "codigo": "CODIGO-FORA-DO-CATALOGO",
                "descricao": "Item antigo", "cor": "Branco", "fornecedor": "Fornecedor Teste", "quantidade": 3,
                "largura": None, "altura": None, "unidadeMedida": "Unidade", "precoUnitario": 220, "precoTotal": 660,
                "custoReal": 300, "quantidadeCompra": 3, "precoCompraUnitario": 100, "margemLiquida": 300,
                "margemPercentual": 45.45, "valorComissao": 60, "observacoes": "",
            }],
            "produtosAcabados": [],
            "valoresInstalacao": {},
        }
        page.evaluate("""async (documento) => {
            const firestore = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js');
            await firestore.setDoc(firestore.doc(null, 'orcamentos', documento.id), documento);
        }""", orc90)
        page.wait_for_function("[...document.querySelectorAll('#seletorOrcamento option')].some(opcao => opcao.value === 'ORC-90')")
        seletor.select_option("ORC-90")
        assert venda_com_comissao.is_checked()
        assert percentual_comissao.input_value() == "10,00"
        assert "herdado do tipo de cliente antigo" in page.locator("#resumoInternoComissao").inner_text()
        assert texto_interno(page, "valor-comissao") == "R$ 60,00"
        assert texto_interno(page, "liquido-filippini") == "R$ 600,00"
        percentual_comissao.focus()
        percentual_comissao.blur()
        tabs.nth(2).click()
        assert "R$ 660,00" in normalizar(page.locator("#orcamentoFinal").inner_text())
        # Base 600, comissão 60, custo 300 e margem 300 são internos.
        verificar_aba_proposta_sem_dados_internos(page, "aba Proposta de documento antigo de arquiteto", [
            "10,00%", "r$ 600,00", "r$ 60,00", "r$ 300,00",
        ])
        tabs.nth(1).click()
        assert documento_orcamento(page, "ORC-90") == orc90
        aceitar_dialogo(page, dialogos)
        preencher_e_sair(percentual_comissao, "5")
        page.wait_for_function("document.getElementById('percentualComissao').value === '5,00'")
        orc90_recalculado = documento_orcamento(page, "ORC-90")
        item_antigo = orc90_recalculado["itens"][0]
        assert orc90_recalculado["infoComercial"]["percentualComissao"] == 5
        assert orc90_recalculado["infoGerais"]["tipoCliente"] == "arquiteto"
        assert item_antigo["precoUnitarioBase"] == 200
        assert item_antigo["precoTotalSemComissao"] == 600
        assert item_antigo["precoTotal"] == 630
        assert item_antigo["custoReal"] == 300
        assert item_antigo["codigo"] == "CODIGO-FORA-DO-CATALOGO"
        assert [campo for campo in ["valorComissao", "margemLiquida", "margemPercentual"] if campo in item_antigo] == []

        # Etapa 3B1: snapshot financeiro v2, transações, cancelamento e compatibilidade.
        firestore_mock = "globalThis.__firestoreMock"

        # A. O bloco interno de um pedido v2 lê o snapshot, não o orçamento vivo.
        seletor.select_option("ORC-04")
        pedido04_original = documento_orcamento(page, "ORC-04")
        page.evaluate(f"""() => {{
            const mock = {firestore_mock};
            const documento = mock.lerDiretamente('orcamentos', 'ORC-04');
            documento.infoComercial.descontoGlobal = 50;
            documento.itens[0].precoTotal = 1;
            documento.itens[0].custoReal = 1;
            mock.escreverDiretamente('orcamentos', 'ORC-04', documento);
        }}""")
        assert texto_interno(page, "valor-comissao") == "R$ 90,00"
        assert texto_interno(page, "liquido-filippini") == "R$ 900,00"
        assert texto_interno(page, "custo-produtos") == "R$ 500,00"
        assert pedido_participa_financeiro(page, "ORC-04")
        page.evaluate("(documento) => globalThis.__firestoreMock.escreverDiretamente('orcamentos', 'ORC-04', documento)", pedido04_original)
        assert documento_orcamento(page, "ORC-04") == pedido04_original

        # B. Aba desatualizada: outro dispositivo confirma ORC-05 enquanto esta aba ainda o vê em negociação.
        # Os cenários de falha B e C registram erros esperados no console; eles são conferidos e retirados abaixo.
        erros_console_antes_das_falhas = len(console_errors)
        seletor.select_option("ORC-05")
        assert status.inner_text() == "Em negociação"
        page.evaluate(f"""() => {{
            // Espelha a regra do Firestore: pedido confirmado não volta a orçamento nem troca de snapshot.
            {firestore_mock}.definirRegraDeEscrita((colecao, id, anterior, novo) => !(
                colecao === 'orcamentos' && anterior?.statusDocumento === 'pedido'
                && (novo.statusDocumento !== 'pedido' || JSON.stringify(novo.pedido) !== JSON.stringify(anterior.pedido))
            ));
            {firestore_mock}.pausarNotificacoes();
        }}""")
        page.evaluate(f"""async () => {{
            const {{ confirmarOrcamentoComoPedido }} = await import('/order-domain.js');
            const mock = {firestore_mock};
            const atual = mock.lerDiretamente('orcamentos', 'ORC-05');
            mock.escreverDiretamente('orcamentos', 'ORC-05', confirmarOrcamentoComoPedido(atual, {{
                confirmadoEm: new Date().toISOString(), confirmadoPor: 'outro-dispositivo'
            }}));
        }}""")
        pedido05_confirmado = page.evaluate(f"() => {firestore_mock}.lerDiretamente('orcamentos', 'ORC-05')")
        assert status.inner_text() == "Em negociação"
        # Gravação do documento inteiro pela aba antiga é recusada e desfeita na tela.
        preencher_e_sair(page.locator("#nomeCliente"), "Cliente da aba antiga")
        page.wait_for_function("document.getElementById('app-notification').textContent.includes('Não foi possível salvar')")
        assert page.evaluate(f"() => {firestore_mock}.lerDiretamente('orcamentos', 'ORC-05')") == pedido05_confirmado
        # A confirmação pela aba antiga lê o servidor na transação e falha sem sobrescrever o pedido.
        aceitar_dialogo(page, dialogos)
        page.locator("#btn-confirmar-pedido").click()
        page.wait_for_function("document.getElementById('app-notification').textContent.includes('já foi confirmado')")
        assert page.evaluate(f"() => {firestore_mock}.lerDiretamente('orcamentos', 'ORC-05')") == pedido05_confirmado
        page.evaluate(f"() => {{ {firestore_mock}.definirRegraDeEscrita(null); {firestore_mock}.retomarNotificacoes(); }}")
        page.wait_for_function("document.getElementById('statusDocumento').textContent.startsWith('Pedido confirmado')")
        assert documento_orcamento(page, "ORC-05")["pedido"]["confirmadoPor"] == "outro-dispositivo"

        # C. Confirmar pedido exige internet: offline, nada é gravado.
        page.locator("#btn-novo-orcamento").click()
        page.wait_for_function("[...document.querySelectorAll('#seletorOrcamento option')].some(opcao => opcao.value === 'ORC-91')")
        seletor.select_option("ORC-91")
        preencher_e_sair(page.locator("#nomeCliente"), "Cliente Snapshot 3B1")
        page.locator("#btn-adicionar-item-avulso").click()
        page.locator("#modalAdicionarItem").wait_for(state="visible")
        page.locator("#codigoOrcamento").fill("TEST-UNIT")
        page.locator("#codigoOrcamento").press("Escape")
        page.locator("#quantidade").fill("1")
        page.locator("#previewCalculo").wait_for(state="visible")
        page.locator("#btn-adicionar-item").click()
        page.locator("#modalAdicionarItem").wait_for(state="hidden")
        assert "Requer conexão com a internet" in page.locator("#btn-confirmar-pedido").get_attribute("title")
        orc91_antes = documento_orcamento(page, "ORC-91")

        page.context.set_offline(True)
        aceitar_dialogo(page, dialogos)
        page.locator("#btn-confirmar-pedido").click()
        page.wait_for_function("document.getElementById('app-notification').textContent.includes('requer internet')")
        page.context.set_offline(False)
        assert documento_orcamento(page, "ORC-91") == orc91_antes
        assert status.inner_text() == "Em negociação"
        assert page.locator("#btn-confirmar-pedido").is_enabled()

        # Falha de conexão durante a transação: mesma resposta, sem pedido.
        page.evaluate(f"() => {firestore_mock}.falharProximaTransacao('unavailable')")
        aceitar_dialogo(page, dialogos)
        page.locator("#btn-confirmar-pedido").click()
        page.wait_for_function("document.getElementById('app-notification').textContent.includes('Sem conexão com a internet')")
        assert documento_orcamento(page, "ORC-91") == orc91_antes
        erros_esperados = console_errors[erros_console_antes_das_falhas:]
        assert [erro.split(':')[0] for erro in erros_esperados] == [
            'Erro ao salvar orçamento no Firestore', 'Falha ao confirmar o pedido', 'Falha ao confirmar o pedido', 'Falha ao confirmar o pedido'
        ], erros_esperados
        assert 'insufficient permissions' in erros_esperados[0]
        assert 'já foi confirmado' in erros_esperados[1]
        assert all('requer internet' in erro for erro in erros_esperados[2:])
        del console_errors[erros_console_antes_das_falhas:]

        aceitar_dialogo(page, dialogos)
        page.locator("#btn-confirmar-pedido").click()
        page.wait_for_function("document.getElementById('statusDocumento').textContent.startsWith('Pedido confirmado')")
        orc91_pedido = documento_orcamento(page, "ORC-91")
        assert orc91_pedido["pedido"]["versaoSnapshot"] == 2
        assert pedido_participa_financeiro(page, "ORC-91")
        # Botão "Transformar em Pedido" permanece bloqueado no pedido.
        assert page.locator("#btn-confirmar-pedido").is_disabled()

        # D. Cancelamento: motivo obrigatório, operação explícita e definitiva.
        botao_cancelar = page.locator("#btn-cancelar-pedido")
        assert botao_cancelar.is_visible()
        botao_cancelar.click()
        modal_cancelar = page.locator("#modalCancelarPedido")
        modal_cancelar.wait_for(state="visible")
        assert page.locator("#cancelarPedidoId").inner_text() == "ORC-91"
        page.locator("#btn-confirmar-cancelamento-pedido").click()
        assert "Informe o motivo" in page.locator("#ajudaMotivoCancelamento").inner_text()
        assert modal_cancelar.is_visible()
        assert documento_orcamento(page, "ORC-91") == orc91_pedido
        # Voltar não cancela.
        page.locator("#btn-voltar-cancelar-pedido").click()
        modal_cancelar.wait_for(state="hidden")
        assert documento_orcamento(page, "ORC-91") == orc91_pedido

        botao_cancelar.click()
        modal_cancelar.wait_for(state="visible")
        page.locator("#motivoCancelamentoPedido").fill("Cliente desistiu (teste 3B1)")
        mensagens_cancelamento = []
        aceitar_dialogo(page, mensagens_cancelamento)
        page.locator("#btn-confirmar-cancelamento-pedido").click()
        page.wait_for_function("document.getElementById('statusDocumento').textContent.startsWith('Pedido cancelado')")
        modal_cancelar.wait_for(state="hidden")
        assert "definitivo" in mensagens_cancelamento[0]
        orc91_cancelado = documento_orcamento(page, "ORC-91")
        cancelamento = orc91_cancelado["pedido"].pop("cancelamento")
        assert cancelamento["motivo"] == "Cliente desistiu (teste 3B1)"
        assert cancelamento["canceladoPor"] == "usuario-teste"
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", cancelamento["canceladoEm"])
        # Cancelar não apaga nem altera itens e valores congelados.
        assert orc91_cancelado == orc91_pedido
        assert not pedido_participa_financeiro(page, "ORC-91")
        assert status.inner_text() == f"Pedido cancelado em {formatar_data(hoje)}"
        assert "[CANCELADO]" in seletor.locator("option:checked").inner_text()
        info_cancelado = texto_visivel(page.locator("#infoPedido"))
        assert "Motivo: Cliente desistiu (teste 3B1)" in info_cancelado
        assert "Fora do controle financeiro" in info_cancelado
        assert "Pedido cancelado: fora do controle financeiro." in page.locator("#resumoInternoComissao").inner_text()
        assert botao_cancelar.is_hidden()
        for seletor_bloqueado in ["#btn-confirmar-pedido", "#btn-marcar-perdido", "#btn-excluir-orcamento",
                                  "#btn-adicionar-item-avulso", "#descontoGlobal", "#percentualComissao"]:
            assert page.locator(seletor_bloqueado).is_disabled(), seletor_bloqueado
        for relatorio in ["#btn-baixar-excel-pedido-ao-fornecedor", "#btn-imprimir-instrucoes-ao-instalador"]:
            assert page.locator(relatorio).is_disabled(), relatorio
            assert "Pedido cancelado" in page.locator(relatorio).get_attribute("title")
        # Mesmo com os botões reabilitados à força, nada é refeito nem gerado.
        planilhas_antes = page.evaluate("window.__planilhas.length")
        page.locator("#btn-baixar-excel-pedido-ao-fornecedor").evaluate("botao => { botao.disabled = false; botao.click(); }")
        assert "Pedido cancelado" in notificacao(page)
        assert page.evaluate("window.__planilhas.length") == planilhas_antes
        botao_cancelar.evaluate("botao => { botao.hidden = false; botao.disabled = false; botao.click(); }")
        assert "já foi cancelado" in notificacao(page)
        assert modal_cancelar.is_hidden()
        documento_cancelado = documento_orcamento(page, "ORC-91")
        assert documento_cancelado["pedido"]["cancelamento"] == cancelamento
        # A aba Proposta mostra a situação, mas não o motivo interno.
        tabs.nth(2).click()
        assert page.locator("#statusDocumentoProposta").inner_text() == f"Pedido cancelado em {formatar_data(hoje)}"
        assert "desistiu" not in normalizar(page.locator("#tab3").text_content())
        verificar_aba_proposta_sem_dados_internos(page, "aba Proposta de pedido cancelado")
        tabs.nth(1).click()

        # E. Duplicar o pedido cancelado gera orçamento editável, sem pedido nem cancelamento.
        page.locator("#btn-duplicar-orcamento").click()
        page.wait_for_function("document.querySelector('#seletorOrcamento').value === 'ORC-92'")
        orc92 = documento_orcamento(page, "ORC-92")
        assert orc92["statusDocumento"] == "orcamento"
        assert "pedido" not in orc92
        assert orc92["itens"] == documento_cancelado["itens"]
        assert status.inner_text() == "Em negociação"
        assert page.locator("#btn-cancelar-pedido").is_hidden()
        assert page.locator("#infoPedido").is_hidden()
        assert page.locator("#btn-confirmar-pedido").is_enabled()

        # F. Pedido v1 existente: operacional, fora do financeiro, cancelável.
        page.evaluate(f"""async () => {{
            const {{ obterItensAtuaisDoOrcamento }} = await import('/order-domain.js');
            const mock = {firestore_mock};
            const base = mock.lerDiretamente('orcamentos', 'ORC-92');
            const v1 = {{
                ...base,
                id: 'ORC-95',
                statusDocumento: 'pedido',
                infoGerais: {{ ...base.infoGerais, nome: 'Orçamento ORC-95', nomeCliente: 'Cliente Pedido Antigo' }},
                pedido: {{
                    versaoSnapshot: 1,
                    orcamentoId: 'ORC-95',
                    confirmadoEm: '2026-09-12T15:00:00.000Z',
                    confirmadoPor: 'usuario-antigo',
                    cliente: {{ nome: 'Cliente Pedido Antigo', endereco: '' }},
                    costureira: {{ nome: '', enderecoEntrega: '' }},
                    itens: obterItensAtuaisDoOrcamento(base)
                }}
            }};
            delete v1.infoComercial.percentualComissao;
            mock.escreverDiretamente('orcamentos', 'ORC-95', v1);
        }}""")
        page.wait_for_function("[...document.querySelectorAll('#seletorOrcamento option')].some(opcao => opcao.value === 'ORC-95')")
        seletor.select_option("ORC-95")
        assert status.inner_text() == "Pedido confirmado em 12/09/2026"
        assert "anterior ao controle financeiro (snapshot v1)" in texto_visivel(page.locator("#infoPedido"))
        assert "Pedido anterior ao controle financeiro" in page.locator("#resumoInternoComissao").inner_text()
        assert not pedido_participa_financeiro(page, "ORC-95")
        assert page.locator("#btn-baixar-excel-pedido-ao-fornecedor").is_enabled()
        page.locator("#btn-baixar-excel-pedido-ao-fornecedor").click()
        assert page.evaluate("window.__planilhas.length") == planilhas_antes + 1
        page.locator("#btn-cancelar-pedido").click()
        page.locator("#modalCancelarPedido").wait_for(state="visible")
        page.locator("#motivoCancelamentoPedido").fill("Pedido antigo cancelado no teste")
        aceitar_dialogo(page, dialogos)
        page.locator("#btn-confirmar-cancelamento-pedido").click()
        page.wait_for_function("document.getElementById('statusDocumento').textContent.startsWith('Pedido cancelado')")
        orc95 = documento_orcamento(page, "ORC-95")
        assert orc95["pedido"]["versaoSnapshot"] == 1
        assert "financeiro" not in orc95["pedido"]
        assert orc95["pedido"]["cancelamento"]["motivo"] == "Pedido antigo cancelado no teste"

        # G. Total da proposta fechado em centavos: produto de R$ 10,10 com 5% de desconto e R$ 100 de instalação.
        page.evaluate(f"""() => {{
            const mock = {firestore_mock};
            const base = mock.lerDiretamente('orcamentos', 'ORC-92');
            mock.escreverDiretamente('orcamentos', 'ORC-96', {{
                ...base,
                id: 'ORC-96',
                infoGerais: {{ ...base.infoGerais, nome: 'Orçamento ORC-96', nomeCliente: 'Cliente Centavo' }},
                infoComercial: {{ ...base.infoComercial, descontoGlobal: 5, percentualComissao: 0 }},
                valoresInstalacao: {{ 'Itens Avulsos': 100 }},
                produtosAcabados: [],
                itens: [{{
                    id: 'item-centavo', ambiente: '', categoria: 'Acessórios', codigo: 'CENTAVO', descricao: 'Item centavo',
                    cor: '-', fornecedor: 'Fornecedor Teste', unidadeMedida: 'Unidade', quantidade: 1, largura: null, altura: null,
                    quantidadeCompra: 1, precoCompraUnitario: 5.05, custoReal: 5.05, precoUnitarioBase: 10.1,
                    precoTotalSemComissao: 10.1, precoUnitario: 10.1, precoTotal: 10.1, observacoes: ''
                }}]
            }});
        }}""")
        page.wait_for_function("[...document.querySelectorAll('#seletorOrcamento option')].some(opcao => opcao.value === 'ORC-96')")
        seletor.select_option("ORC-96")
        tabs.nth(2).click()
        page.locator("#modoProposta").select_option("reduzida")
        proposta_centavo = normalizar(page.locator("#orcamentoFinal").inner_text())
        assert "R$ 9,59" in proposta_centavo
        assert "VALOR TOTAL GERAL DA PROPOSTA:R$ 109,59" in proposta_centavo.replace("\n", "")
        assert "R$ 109,60" not in proposta_centavo

        # H. Celular e impressão: controles do pedido sem rolagem e fora da impressão.
        tabs.nth(1).click()
        seletor.select_option("ORC-04")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        assert sem_rolagem_horizontal(page)
        page.locator("#btn-cancelar-pedido").click()
        page.locator("#modalCancelarPedido").wait_for(state="visible")
        assert sem_rolagem_horizontal(page)
        # Aguarda a animação de abertura (fadeIn de 0,3 s) antes da captura.
        page.wait_for_timeout(400)
        page.locator("#modalCancelarPedido").screenshot(path=str(artifacts / "cancelar-pedido-mobile.png"))
        page.locator("#btn-voltar-cancelar-pedido").click()
        page.locator("#modalCancelarPedido").wait_for(state="hidden")
        assert not pedido_participa_financeiro(page, "ORC-91")
        assert pedido_participa_financeiro(page, "ORC-04")
        seletor.select_option("ORC-91")
        page.wait_for_timeout(100)
        assert sem_rolagem_horizontal(page)
        page.locator(".budget-control").screenshot(path=str(artifacts / "pedido-cancelado-mobile.png"))
        page.emulate_media(media="print")
        assert page.locator("#infoPedido").evaluate("elemento => elemento.getClientRects().length") == 0
        assert page.locator("#btn-cancelar-pedido").evaluate("elemento => elemento.getClientRects().length") == 0
        page.emulate_media(media="screen")
        page.set_viewport_size({"width": 1440, "height": 1000})

        # Celular: controles de comissão e resumo interno sem rolagem horizontal.
        seletor.select_option("ORC-05")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        assert sem_rolagem_horizontal(page)
        page.locator(".grupo-comissionado").screenshot(path=str(artifacts / "comissao-mobile-smoke.png"))
        tabs.nth(2).click()
        page.wait_for_timeout(100)
        assert sem_rolagem_horizontal(page)
        # Mesma garantia de privacidade no layout de celular (ORC-05: cópia com 10%, desconto e instalação).
        verificar_aba_proposta_sem_dados_internos(page, "aba Proposta em 390 px", VALORES_INTERNOS_DEZ_PORCENTO)
        verificar_impressao_sem_dados_internos(page, "impressão em 390 px", VALORES_INTERNOS_DEZ_PORCENTO)
        page.set_viewport_size({"width": 1440, "height": 1000})

        # Etapa 3B2: aba Financeiro / relatório de vendas.
        dia_menos_2 = data_civil_brasilia(page, -2)
        dia_menos_5 = data_civil_brasilia(page, -5)
        dia_menos_8 = data_civil_brasilia(page, -8)
        dia_menos_20 = data_civil_brasilia(page, -20)
        dia_menos_10 = data_civil_brasilia(page, -10)
        dia_menos_1 = data_civil_brasilia(page, -1)
        primeiro_dia_do_mes_atual = f"{hoje[:8]}01"

        # A aba Financeiro existe e é inteiramente interna (não é a Proposta Cliente).
        assert page.locator("#btn-tab-financeiro").is_visible()
        tabs.nth(4).click()
        assert page.locator("#tab-financeiro").is_visible()
        page.locator("#financeiroDataInicial").fill("2000-01-01")
        page.locator("#financeiroDataFinal").fill(hoje)
        page.wait_for_timeout(50)
        info_v1_antes = texto_visivel(page.locator("#financeiroInfoV1"))
        v1_antes = int(re.search(r"\d+", info_v1_antes).group()) if info_v1_antes else 0

        page.evaluate(f"""async () => {{
            const {{ confirmarOrcamentoComoPedido, cancelarPedido, obterItensAtuaisDoOrcamento }} = await import('/order-domain.js');
            const mock = {firestore_mock};

            const itemPadrao = () => ({{
                id: 'item-financeiro', ambiente: '', categoria: 'Acessórios', codigo: 'TEST-UNIT',
                descricao: 'Produto válido para teste de navegador', cor: 'Branco', fornecedor: 'Fornecedor Teste',
                unidadeMedida: 'Unidade', quantidade: 1, largura: null, altura: null, quantidadeCompra: 1,
                precoCompraUnitario: 100, custoReal: 100, precoUnitarioBase: 200, precoTotalSemComissao: 200,
                precoUnitario: 220, precoTotal: 220, observacoes: ''
            }});
            const baseOrcamento = (id, nomeCliente) => ({{
                id, statusDocumento: 'orcamento',
                apresentacao: {{ modo: 'reduzida', mostrarValoresItens: false, mostrarCustosFornecedor: false }},
                infoGerais: {{ nome: `Orçamento ${{id}}`, nomeCliente, celularCliente: '', nomeComissionado: '' }},
                infoComercial: {{ condicaoPagamento: 'À vista', formaPagamento: 'PIX', descontoGlobal: 0, percentualComissao: 10 }},
                valoresInstalacao: {{}},
                itens: [itemPadrao()],
                produtosAcabados: []
            }});

            // Pedido v1 (histórico, fora do financeiro), confirmado há 20 dias.
            const baseV1 = baseOrcamento('ORC-150', 'Cliente Financeiro Histórico');
            const v1 = {{
                ...baseV1,
                statusDocumento: 'pedido',
                pedido: {{
                    versaoSnapshot: 1, orcamentoId: 'ORC-150', confirmadoEm: '{dia_menos_20}T15:00:00.000Z', confirmadoPor: 'usuario-antigo',
                    cliente: {{ nome: baseV1.infoGerais.nomeCliente, endereco: '' }}, costureira: {{ nome: '', enderecoEntrega: '' }},
                    itens: obterItensAtuaisDoOrcamento(baseV1)
                }}
            }};
            mock.escreverDiretamente('orcamentos', 'ORC-150', v1);

            // Pedido v2 válido, mais antigo dos dois ativos (há 8 dias).
            const v2Antigo = confirmarOrcamentoComoPedido(baseOrcamento('ORC-151', 'Cliente Financeiro A'), {{
                confirmadoEm: '{dia_menos_8}T15:00:00.000Z', confirmadoPor: 'usuario-teste'
            }});
            mock.escreverDiretamente('orcamentos', 'ORC-151', v2Antigo);

            // Pedido v2 cancelado (venda há 5 dias, cancelado há 4): fora dos totais, contado à parte.
            const v2ParaCancelar = confirmarOrcamentoComoPedido(baseOrcamento('ORC-152', 'Cliente Financeiro Cancelado'), {{
                confirmadoEm: '{dia_menos_5}T15:00:00.000Z', confirmadoPor: 'usuario-teste'
            }});
            const v2Cancelado = cancelarPedido(v2ParaCancelar, {{
                motivo: 'Cliente desistiu (fixture financeiro)', canceladoEm: '{dia_menos_2}T10:00:00.000Z', canceladoPor: 'usuario-teste'
            }});
            mock.escreverDiretamente('orcamentos', 'ORC-152', v2Cancelado);

            // Pedido v2 válido, mais recente dos dois ativos (há 2 dias).
            const v2Recente = confirmarOrcamentoComoPedido(baseOrcamento('ORC-153', 'Cliente Financeiro B'), {{
                confirmadoEm: '{dia_menos_2}T15:00:00.000Z', confirmadoPor: 'usuario-teste'
            }});
            mock.escreverDiretamente('orcamentos', 'ORC-153', v2Recente);

            // Terceiro pedido v2 participante, confirmado hoje (fora do período do relatório de vendas
            // usado acima, mas dentro de Contas a Receber, que não tem filtro de período). Existe para
            // que a falha de leitura seja testada com três participantes, falhando no do meio.
            // Instalação de R$ 300,00 de propósito: instalação NUNCA entra no recebível, então este
            // pedido deve aparecer com R$ 220,00 a receber (só produtos, comissão inclusa).
            const baseComInstalacao = {{ ...baseOrcamento('ORC-155', 'Cliente Financeiro C'), valoresInstalacao: {{ Sala: 300 }} }};
            const v2SemMovimento = confirmarOrcamentoComoPedido(baseComInstalacao, {{
                confirmadoEm: '{hoje}T15:00:00.000Z', confirmadoPor: 'usuario-teste'
            }});
            mock.escreverDiretamente('orcamentos', 'ORC-155', v2SemMovimento);

            // Orçamento comum, sem pedido: precisa ficar de fora.
            mock.escreverDiretamente('orcamentos', 'ORC-154', baseOrcamento('ORC-154', 'Cliente Sem Pedido'));
        }}""")
        page.wait_for_function("[...document.querySelectorAll('#seletorOrcamento option')].some(opcao => opcao.value === 'ORC-154')")

        # Filtros: padrão é do primeiro dia do mês atual até hoje, em Brasília. Reabrir a aba
        # restaura o comportamento de "campo vazio recebe o padrão" (o teste tinha usado o filtro
        # amplo acima só para medir a linha de base de pedidos v1 históricos).
        campo_inicial = page.locator("#financeiroDataInicial")
        campo_final = page.locator("#financeiroDataFinal")
        campo_inicial.fill("")
        campo_final.fill("")
        tabs.nth(1).click()
        tabs.nth(4).click()
        assert campo_inicial.input_value() == primeiro_dia_do_mes_atual
        assert campo_final.input_value() == hoje

        # Período explícito cobrindo as duas vendas ativas e o cancelamento, mas não o histórico v1
        # nem os pedidos v2 de outras seções deste teste (todos confirmados "hoje").
        page.locator("#financeiroDataInicial").fill(dia_menos_10)
        page.locator("#financeiroDataInicial").dispatch_event("change")
        page.locator("#financeiroDataFinal").fill(dia_menos_1)
        page.locator("#financeiroDataFinal").dispatch_event("change")
        page.wait_for_function("document.querySelector('[data-financeiro=\"pedidos\"]').textContent === '2'")

        # Cards: 2 pedidos ativos, R$ 440,00 cobrados, R$ 40,00 de comissão, R$ 400,00 líquidos.
        assert page.locator('[data-financeiro="pedidos"]').inner_text() == "2"
        assert normalizar(page.locator('[data-financeiro="cobrado"]').inner_text()) == "R$ 440,00"
        assert normalizar(page.locator('[data-financeiro="comissao"]').inner_text()) == "R$ 40,00"
        assert normalizar(page.locator('[data-financeiro="liquido"]').inner_text()) == "R$ 400,00"

        # Tabela: só os dois pedidos v2 ativos, mais recente primeiro; v1 e cancelado ficam de fora.
        linhas_financeiro = page.locator("#financeiroTabelaContainer tbody tr")
        assert linhas_financeiro.count() == 2
        assert linhas_financeiro.nth(0).locator('[data-label="Pedido"]').inner_text() == "ORC-153"
        assert linhas_financeiro.nth(1).locator('[data-label="Pedido"]').inner_text() == "ORC-151"
        assert "ORC-150" not in normalizar(page.locator("#financeiroTabelaContainer").inner_text())
        assert "ORC-152" not in normalizar(page.locator("#financeiroTabelaContainer").inner_text())
        assert linhas_financeiro.nth(0).locator('[data-label="Cliente"]').inner_text() == "Cliente Financeiro B"
        assert normalizar(linhas_financeiro.nth(0).locator('[data-label="Produtos cobrados"]').inner_text()) == "R$ 220,00"
        assert normalizar(linhas_financeiro.nth(0).locator('[data-label="Comissão"]').inner_text()) == "R$ 20,00"
        assert normalizar(linhas_financeiro.nth(0).locator('[data-label="Líquido Filippini"]').inner_text()) == "R$ 200,00"

        # Excluídos, mas informados: histórico v1 (total, não por período) e cancelado no período.
        v1_depois = v1_antes + 1
        assert f"{v1_depois} pedido(s) histórico(s)" in texto_visivel(page.locator("#financeiroInfoV1"))
        assert "não entram neste relatório" in texto_visivel(page.locator("#financeiroInfoV1"))
        assert "1 pedido(s) cancelado(s) no período" in texto_visivel(page.locator("#financeiroInfoCancelados"))
        assert page.locator("#financeiroAvisoInconsistencias").is_hidden()
        assert page.locator("#financeiroVazio").is_hidden()

        # Botão "Abrir" seleciona o orçamento e leva à aba Lançamento, como em Follow-ups.
        linhas_financeiro.nth(0).locator(".btn-abrir-orcamento").click()
        assert page.locator("#tab2").is_visible()
        assert page.locator("#orcamentoId").inner_text() == "ORC-153"
        tabs.nth(4).click()

        # Estado vazio: período sem nenhuma venda v2 (mas o aviso de histórico v1 continua, pois não é por período).
        page.locator("#financeiroDataInicial").fill(data_civil_brasilia(page, -40))
        page.locator("#financeiroDataInicial").dispatch_event("change")
        page.locator("#financeiroDataFinal").fill(data_civil_brasilia(page, -30))
        page.locator("#financeiroDataFinal").dispatch_event("change")
        page.wait_for_function("document.getElementById('financeiroVazio').hidden === false")
        assert texto_visivel(page.locator("#financeiroVazio")) == "Nenhuma venda registrada neste período."
        assert page.locator('[data-financeiro="pedidos"]').inner_text() == "0"
        assert normalizar(page.locator('[data-financeiro="cobrado"]').inner_text()) == "R$ 0,00"
        assert page.locator("#financeiroTabelaContainer tbody").count() == 0
        assert f"{v1_depois} pedido(s) histórico(s)" in texto_visivel(page.locator("#financeiroInfoV1"))
        assert page.locator("#financeiroInfoCancelados").is_hidden()

        # Atalho "Este mês": data final volta a hoje e a inicial ao primeiro dia do mês atual.
        page.locator("#btn-financeiro-este-mes").click()
        page.wait_for_function("document.getElementById('financeiroDataFinal').value !== ''")
        assert campo_inicial.input_value() == primeiro_dia_do_mes_atual
        assert campo_final.input_value() == hoje

        # Privacidade: nada disso vaza para a Proposta Cliente, impressão, instalador ou fornecedor.
        page.locator("#financeiroDataInicial").fill(dia_menos_10)
        page.locator("#financeiroDataInicial").dispatch_event("change")
        tabs.nth(2).click()
        verificar_aba_proposta_sem_dados_internos(page, "aba Proposta com vendas no financeiro")

        # Impressão: a aba Financeiro fica escondida, como Lançamento e Follow-ups.
        tabs.nth(4).click()
        page.emulate_media(media="print")
        assert page.locator("#tab-financeiro").evaluate("elemento => getComputedStyle(elemento).display") == "none"
        page.emulate_media(media="screen")

        # 390 px: filtros, cards e tabela (em cartões) sem rolagem horizontal.
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        assert sem_rolagem_horizontal(page)
        page.locator("#financeiroCards").screenshot(path=str(artifacts / "financeiro-cards-mobile.png"))
        page.set_viewport_size({"width": 1440, "height": 1000})
        tabs.nth(1).click()

        # --- Etapa 4B2A: pagamentos do pedido e Contas a Receber -------------------------------------
        # Termos específicos do financeiro de pagamentos, não os genéricos já usados por outras telas
        # (ex.: "Situação:" já existe na Proposta para o status comercial do pedido, sem ser um leak).
        VALORES_PAGAMENTO = [
            "100,00", "120,00", "80,00", "30,00", "outro-dispositivo", "lançado em duplicidade",
            "registrar recebimento", "registrar reembolso", "contas a receber", "cancelar lançamento",
            "total recebido", "total reembolsado", "valor a receber",
        ]

        # A. Pedido v1 não mostra o bloco financeiro; pedido cancelado mostra, mas só aceita reembolso.
        seletor.select_option("ORC-150")
        assert page.locator("#financeiroPedidoCardContainer").is_hidden()
        seletor.select_option("ORC-152")
        assert page.locator("#financeiroPedidoCardContainer").is_visible()
        assert page.locator("#btn-registrar-recebimento").is_disabled()
        assert page.locator("#btn-registrar-reembolso").is_enabled()
        assert "não aceita novo recebimento" in texto_visivel(page.locator("#financeiroPedidoConteudo"))

        # B. Pedido v2 ativo: valor a receber vem do snapshot, nada recebido ainda.
        seletor.select_option("ORC-151")
        assert page.locator("#financeiroPedidoCardContainer").is_visible()
        assert normalizar(page.locator('[data-financeiro-pedido="valorReceber"]').inner_text()) == "R$ 220,00"
        assert normalizar(page.locator('[data-financeiro-pedido="totalRecebido"]').inner_text()) == "R$ 0,00"
        assert "Em aberto" in texto_visivel(page.locator('[data-financeiro-pedido="situacao"]'))
        assert page.locator("#financeiroPedidoConteudo").get_by_text("Nenhum lançamento registrado ainda.").is_visible()

        def registrar_movimento(valor, forma="PIX", observacao=""):
            page.locator("#movimentoValor").fill(valor)
            if forma:
                page.locator("#movimentoForma").select_option(forma)
            if observacao:
                page.locator("#movimentoObservacao").fill(observacao)
            page.locator("#btn-confirmar-movimento-financeiro").click()
            page.wait_for_function("document.getElementById('modalMovimentoFinanceiro').classList.contains('active') === false")

        # C. Recebimento parcial: R$100,00 de R$220,00 devidos.
        page.locator("#btn-registrar-recebimento").click()
        page.locator("#modalMovimentoFinanceiro").wait_for(state="visible")
        assert page.locator("#tituloMovimentoFinanceiro").inner_text() == "Registrar recebimento"
        assert page.locator("#movimentoData").input_value() == hoje
        assert page.locator("#movimentoData").get_attribute("max") == hoje
        registrar_movimento("100.00", observacao="Sinal")
        page.wait_for_function("document.querySelector('[data-financeiro-pedido=\"totalRecebido\"]').textContent.includes('100,00')")
        assert "Parcialmente pago" in texto_visivel(page.locator('[data-financeiro-pedido="situacao"]'))
        assert page.locator("#financeiroPedidoConteudo tbody tr").count() == 1

        # D. Quitação exata: mais R$120,00 fecha o saldo em zero.
        page.locator("#btn-registrar-recebimento").click()
        page.locator("#modalMovimentoFinanceiro").wait_for(state="visible")
        registrar_movimento("120.00")
        page.wait_for_function("document.querySelector('[data-financeiro-pedido=\"situacao\"]').textContent.includes('Quitado')")
        assert normalizar(page.locator('[data-financeiro-pedido="saldo"]').inner_text()) == "R$ 0,00"

        # E. Excedente: R$50,00 além do valor do pedido pede confirmação explícita, sem bloquear.
        aceitar_dialogo(page, dialogos)
        page.locator("#btn-registrar-recebimento").click()
        page.locator("#modalMovimentoFinanceiro").wait_for(state="visible")
        registrar_movimento("50.00")
        page.wait_for_function("document.querySelector('[data-financeiro-pedido=\"situacao\"]').textContent.includes('Excedente')")
        assert "50,00" in dialogos[-1] and "além do valor do pedido" in dialogos[-1]
        assert "50,00" in normalizar(page.locator('[data-financeiro-pedido="saldo"]').inner_text())

        # F. Editar o lançamento do excedente (ainda gera excedente, então confirma de novo).
        # A tabela ordena por dataMovimento desc e depois criadoEm desc: o lançamento mais recente
        # (o excedente de R$50,00, registrado por último) é a primeira linha.
        linhas_movimento = page.locator("#financeiroPedidoConteudo tbody tr")
        assert linhas_movimento.count() == 3
        linhas_movimento.first.locator(".btn-editar-movimento").click()
        page.locator("#modalMovimentoFinanceiro").wait_for(state="visible")
        assert page.locator("#tituloMovimentoFinanceiro").inner_text() == "Editar recebimento"
        assert page.locator("#movimentoValor").input_value() == "50.00"
        aceitar_dialogo(page, dialogos)
        registrar_movimento("30.00")
        page.wait_for_function("document.querySelector('[data-financeiro-pedido=\"totalRecebido\"]').textContent.includes('250,00')")
        assert "Excedente" in texto_visivel(page.locator('[data-financeiro-pedido="situacao"]'))

        # G. Reembolso: dinheiro devolvido ao cliente, sem confirmação de excedente (não é recebimento).
        page.locator("#btn-registrar-reembolso").click()
        page.locator("#modalMovimentoFinanceiro").wait_for(state="visible")
        assert page.locator("#tituloMovimentoFinanceiro").inner_text() == "Registrar reembolso"
        assert "devolvido ao cliente" in texto_visivel(page.locator("#avisoTipoMovimentoFinanceiro"))
        registrar_movimento("30.00")
        page.wait_for_function("document.querySelector('[data-financeiro-pedido=\"situacao\"]').textContent.includes('Quitado')")
        assert normalizar(page.locator('[data-financeiro-pedido="totalReembolsado"]').inner_text()) == "R$ 30,00"

        # H. Cancelar lançamento: exige motivo, sai dos totais, mas continua no histórico como leitura.
        # O recebimento de R$100,00 foi o primeiro criado, então é o mais antigo: última linha da tabela.
        linhas_movimento = page.locator("#financeiroPedidoConteudo tbody tr")
        linha_r100 = linhas_movimento.last
        assert "R$ 100,00" in normalizar(linha_r100.inner_text())
        linha_r100.locator(".btn-cancelar-movimento").click()
        page.locator("#modalCancelarMovimento").wait_for(state="visible")
        page.locator("#btn-confirmar-cancelamento-movimento").click()
        page.wait_for_function("document.getElementById('ajudaMotivoCancelamentoMovimento').textContent.includes('Informe o motivo')")
        page.locator("#motivoCancelamentoMovimento").fill("Lançado em duplicidade")
        page.locator("#btn-confirmar-cancelamento-movimento").click()
        page.wait_for_function("document.getElementById('modalCancelarMovimento').classList.contains('active') === false")
        page.wait_for_function("document.querySelector('[data-financeiro-pedido=\"totalRecebido\"]').textContent.includes('150,00')")
        assert normalizar(page.locator('[data-financeiro-pedido="saldo"]').inner_text()) == "R$ 100,00"
        assert "Parcialmente pago" in texto_visivel(page.locator('[data-financeiro-pedido="situacao"]'))
        linha_cancelada = page.locator("#financeiroPedidoConteudo tbody tr").filter(has_text="Cancelado")
        assert linha_cancelada.count() == 1
        assert "Lançado em duplicidade" in normalizar(linha_cancelada.inner_text())
        assert linha_cancelada.locator(".btn-editar-movimento").count() == 0
        assert linha_cancelada.locator(".btn-cancelar-movimento").count() == 0

        # I. Conflito: outro dispositivo corrige o mesmo lançamento enquanto o modal de edição está aberto.
        seletor.select_option("ORC-153")
        page.locator("#btn-registrar-recebimento").click()
        page.locator("#modalMovimentoFinanceiro").wait_for(state="visible")
        registrar_movimento("50.00")
        page.wait_for_function("document.querySelector('[data-financeiro-pedido=\"totalRecebido\"]').textContent.includes('50,00')")

        botao_editar_conflito = page.locator(".btn-editar-movimento").first
        pagamento_id_conflito = botao_editar_conflito.get_attribute("data-pagamento-id")
        botao_editar_conflito.click()
        page.locator("#modalMovimentoFinanceiro").wait_for(state="visible")

        page.evaluate(f"""async (pagamentoId) => {{
            const {{ corrigirMovimento, criarEventoAuditoria }} = await import('/payments-domain.js');
            const mock = {firestore_mock};
            const colecao = 'orcamentos/ORC-153/pagamentos';
            const atual = mock.lerDiretamente(colecao, pagamentoId);
            const corrigido = corrigirMovimento(atual, {{
                valorCentavos: 8000, atualizadoEm: new Date().toISOString(), atualizadoPor: 'outro-dispositivo'
            }}, {{ hoje: '{hoje}' }});
            // Um dispositivo real grava movimento + evento juntos (as regras exigem isso); a simulação
            // aqui faz o mesmo, para não deixar uma cadeia de auditoria incompleta como resíduo do teste.
            const evento = criarEventoAuditoria('correcao', atual, corrigido, {{
                registradoEm: corrigido.atualizadoEm, registradoPor: 'outro-dispositivo'
            }});
            mock.escreverDiretamente(colecao, pagamentoId, corrigido);
            mock.escreverDiretamente(`${{colecao}}/${{pagamentoId}}/auditoria`, corrigido.ultimoEventoId, evento);
        }}""", pagamento_id_conflito)
        page.wait_for_function("document.querySelector('[data-financeiro-pedido=\"totalRecebido\"]').textContent.includes('80,00')")

        # Valor escolhido para não gerar excedente (e portanto não abrir um diálogo de confirmação
        # aqui): o que importa neste passo é só o conflito de versão. A falha esperada também loga
        # um console.error (mesmo padrão já usado nos testes de conflito de pedido, acima).
        erros_console_antes_do_conflito = len(console_errors)
        page.locator("#movimentoValor").fill("90.00")
        page.locator("#btn-confirmar-movimento-financeiro").click()
        page.wait_for_function("document.getElementById('ajudaMovimentoFinanceiro').textContent.includes('outro dispositivo')")
        assert page.locator("#modalMovimentoFinanceiro").evaluate("m => m.classList.contains('active')")
        erros_conflito = console_errors[erros_console_antes_do_conflito:]
        assert len(erros_conflito) == 1 and "Falha na operação financeira" in erros_conflito[0], erros_conflito
        assert "alterado em outro dispositivo" in erros_conflito[0]
        del console_errors[erros_console_antes_do_conflito:]
        page.locator("#btn-voltar-movimento-financeiro").click()
        assert normalizar(page.locator('[data-financeiro-pedido="totalRecebido"]').inner_text()) == "R$ 80,00"

        # J. Contas a Receber: pedidos v2 ativos com movimentos, cancelado e v1 ficam fora.
        tabs.nth(4).click()
        page.wait_for_function("document.getElementById('contasReceberCarregando').hidden === true")
        texto_contas = normalizar(page.locator("#contasReceberTabelaContainer").inner_text())
        assert "ORC-151" in texto_contas
        assert "ORC-153" in texto_contas
        assert "ORC-152" not in texto_contas
        assert "ORC-150" not in texto_contas

        linha_151 = page.locator("#contasReceberTabelaContainer tbody tr").filter(has_text="ORC-151")
        assert normalizar(linha_151.locator('[data-label="Saldo"]').inner_text()) == "R$ 100,00"
        assert "Parcialmente pago" in normalizar(linha_151.locator('[data-label="Situação"]').inner_text())
        # Recebível vem do snapshot: comissão inclusa (não descontada) e instalação fora. Recebido e
        # reembolsado saem do domínio, que ignora lançamento cancelado e abate o reembolso no saldo.
        assert normalizar(linha_151.locator('[data-label="Valor a receber"]').inner_text()) == "R$ 220,00"
        assert normalizar(linha_151.locator('[data-label="Recebido"]').inner_text()) == "R$ 150,00"
        assert normalizar(linha_151.locator('[data-label="Reembolsado"]').inner_text()) == "R$ 30,00"

        # ORC-155 tem R$ 300,00 de instalação e nenhum lançamento: instalação não entra no recebível.
        linha_155 = page.locator("#contasReceberTabelaContainer tbody tr").filter(has_text="ORC-155")
        assert normalizar(linha_155.locator('[data-label="Valor a receber"]').inner_text()) == "R$ 220,00"
        assert normalizar(linha_155.locator('[data-label="Saldo"]').inner_text()) == "R$ 220,00"
        assert "Em aberto" in normalizar(linha_155.locator('[data-label="Situação"]').inner_text())

        # Filtros: "Parcialmente pago" mantém os dois; "Quitado" fica vazio (nenhum pedido está quitado agora).
        page.locator("#contasReceberFiltroSituacao").select_option("Parcialmente pago")
        page.wait_for_timeout(50)
        texto_parcial = normalizar(page.locator("#contasReceberTabelaContainer").inner_text())
        assert "ORC-151" in texto_parcial and "ORC-153" in texto_parcial

        page.locator("#contasReceberFiltroSituacao").select_option("Quitado")
        page.wait_for_function("document.getElementById('contasReceberVazio').hidden === false")
        page.locator("#contasReceberFiltroSituacao").select_option("todos")
        page.wait_for_timeout(50)

        # Botão "Abrir" navega para o pedido, sem alterar dados.
        page.locator("#contasReceberTabelaContainer tbody tr").filter(has_text="ORC-153") \
            .locator(".btn-abrir-orcamento").click()
        assert page.locator("#tab2").is_visible()
        assert page.locator("#orcamentoId").inner_text() == "ORC-153"

        # J2. Listener do pedido selecionado: uma assinatura por pedido observado, sem churn.
        colecao_151 = "orcamentos/ORC-151/pagamentos"
        colecao_153 = "orcamentos/ORC-153/pagamentos"

        def assinaturas(colecao):
            return page.evaluate(f"(c) => {firestore_mock}.estatisticasDeAssinatura(c)", colecao)

        seletor.select_option("ORC-151")
        page.wait_for_function("document.getElementById('financeiroPedidoCardContainer').hidden === false")
        base_151 = assinaturas(colecao_151)
        base_153 = assinaturas(colecao_153)
        assert base_151["subscribes"] - base_151["unsubscribes"] == 1, base_151

        # Um snapshot do próprio listener (o mesmo documento regravado, sem mudar nada) repinta a
        # interface e NÃO pode derrubar/reabrir a assinatura.
        pagamento_151 = page.locator(".btn-editar-movimento").first.get_attribute("data-pagamento-id")
        page.evaluate(
            f"""(pagamentoId) => {{
                const mock = {firestore_mock};
                mock.escreverDiretamente('{colecao_151}', pagamentoId, mock.lerDiretamente('{colecao_151}', pagamentoId));
            }}""",
            pagamento_151,
        )
        page.wait_for_timeout(100)
        assert assinaturas(colecao_151) == base_151, "snapshot do próprio listener não deve reassinar"

        # Trocar de pedido: exatamente um unsubscribe em A e um subscribe em B.
        seletor.select_option("ORC-153")
        page.wait_for_function("document.getElementById('orcamentoId').textContent === 'ORC-153'")
        depois_151 = assinaturas(colecao_151)
        depois_153 = assinaturas(colecao_153)
        assert depois_151["unsubscribes"] == base_151["unsubscribes"] + 1, depois_151
        assert depois_151["subscribes"] == base_151["subscribes"], depois_151
        assert depois_153["subscribes"] == base_153["subscribes"] + 1, depois_153

        # J3. Callback atrasado do listener anterior não escreve no estado nem na interface do pedido
        # atual. O disparo ignora o unsubscribe de propósito: o SDK real não promete que um callback já
        # enfileirado nunca chegue, e dinheiro na tela não pode depender dessa suposição.
        assert normalizar(page.locator('[data-financeiro-pedido="totalRecebido"]').inner_text()) == "R$ 80,00"
        linhas_b = page.locator("#financeiroPedidoConteudo tbody tr").count()
        assert page.evaluate(f"() => {firestore_mock}.dispararCallbackTardioDe('{colecao_151}')") is True
        page.wait_for_timeout(100)
        assert page.locator("#orcamentoId").inner_text() == "ORC-153"
        assert normalizar(page.locator('[data-financeiro-pedido="totalRecebido"]').inner_text()) == "R$ 80,00"
        assert page.locator("#financeiroPedidoConteudo tbody tr").count() == linhas_b

        # J4. Sair de um pedido elegível para um orçamento sem pedido (e para um v1): listener desligado,
        # movimentos em memória limpos e nenhum card financeiro anterior permanece na tela.
        antes_saida_153 = assinaturas(colecao_153)
        seletor.select_option("ORC-154")
        assert page.locator("#financeiroPedidoCardContainer").is_hidden()
        assert page.locator("#financeiroPedidoConteudo").inner_html() == ""
        assert assinaturas(colecao_153)["unsubscribes"] == antes_saida_153["unsubscribes"] + 1

        seletor.select_option("ORC-150")
        assert page.locator("#financeiroPedidoCardContainer").is_hidden()
        assert page.locator("#financeiroPedidoConteudo").inner_html() == ""
        assert page.evaluate(f"() => {firestore_mock}.dispararCallbackTardioDe('{colecao_153}')") is True
        page.wait_for_timeout(100)
        assert page.locator("#financeiroPedidoCardContainer").is_hidden(), "callback tardio não pode ressuscitar o bloco"
        assert page.locator("#financeiroPedidoConteudo").inner_html() == ""

        # J5. Contas a Receber falha fechado: leitura indisponível em UM participante não é "zero
        # pagamentos" e não pode virar lista parcial nem saldo em aberto artificial.
        tabs.nth(4).click()
        page.wait_for_function("document.getElementById('contasReceberCarregando').hidden === true")
        page.locator("#contasReceberFiltroSituacao").select_option("todos")
        page.wait_for_timeout(50)
        linhas_completas = page.locator("#contasReceberTabelaContainer tbody tr").count()
        texto_completo = normalizar(page.locator("#contasReceberTabelaContainer").inner_text())
        assert linhas_completas >= 3, linhas_completas
        for pedido_participante in ("ORC-151", "ORC-153", "ORC-155"):
            assert pedido_participante in texto_completo

        erros_antes_das_contas = len(console_errors)
        page.evaluate(f"() => {firestore_mock}.falharLeituraDe('{colecao_153}')")
        page.locator("#btn-atualizar-contas-a-receber").click()
        page.wait_for_function("document.getElementById('contasReceberErro').hidden === false")
        assert "Não foi possível carregar todas as informações de Contas a Receber. Tente novamente." \
            in texto_visivel(page.locator("#contasReceberErro"))
        assert page.locator("#contasReceberTabelaContainer").inner_html() == "", "nenhuma tabela parcial"
        assert page.locator("#contasReceberVazio").is_hidden(), "falha de leitura não é 'nada a receber'"

        # Trocar o filtro não pode ressuscitar a visão (parcial ou vazia) como se fosse válida.
        page.locator("#contasReceberFiltroSituacao").select_option("Em aberto")
        page.wait_for_timeout(50)
        assert page.locator("#contasReceberTabelaContainer").inner_html() == ""
        assert page.locator("#contasReceberVazio").is_hidden()
        page.locator("#contasReceberFiltroSituacao").select_option("Parcialmente pago")
        page.wait_for_timeout(50)
        assert page.locator("#contasReceberTabelaContainer").inner_html() == ""

        # Restabelecida a leitura, a seção volta completa: o bloqueio é da falha, não da seção.
        page.evaluate(f"() => {firestore_mock}.falharLeituraDe(null)")
        page.locator("#btn-atualizar-contas-a-receber").click()
        page.wait_for_function("document.getElementById('contasReceberErro').hidden === true")
        page.locator("#contasReceberFiltroSituacao").select_option("todos")
        page.wait_for_timeout(50)
        assert page.locator("#contasReceberTabelaContainer tbody tr").count() == linhas_completas

        erros_das_contas = console_errors[erros_antes_das_contas:]
        assert len(erros_das_contas) == 1 and "Falha ao carregar Contas a Receber" in erros_das_contas[0], erros_das_contas
        del console_errors[erros_antes_das_contas:]

        tabs.nth(1).click()

        # J6. Financeiro do pedido fail-closed: falha do listener NÃO é "R$ 0,00 recebido" nem saldo
        # integral em aberto. Sem valores, sem situação, sem ações até um snapshot válido chegar.
        mensagem_falha_pedido = "Não foi possível carregar os lançamentos financeiros deste pedido. Tente novamente."
        seletor_falha_pedido = '[data-financeiro-pedido="falha"]'

        def total_recebido_do_pedido():
            return normalizar(page.locator('[data-financeiro-pedido="totalRecebido"]').inner_text())

        def assert_bloco_financeiro_em_falha():
            page.wait_for_function(f"document.querySelector('{seletor_falha_pedido}') !== null")
            assert page.locator("#financeiroPedidoCardContainer").is_visible()
            texto_bloco = texto_visivel(page.locator("#financeiroPedidoConteudo"))
            assert mensagem_falha_pedido in texto_bloco
            assert "R$" not in texto_bloco, "nenhum valor monetário apresentado como válido"
            assert "Situação" not in texto_bloco and "Em aberto" not in texto_bloco
            for seletor_proibido in (
                '[data-financeiro-pedido="totalRecebido"]', '[data-financeiro-pedido="saldo"]',
                '[data-financeiro-pedido="situacao"]', "#btn-registrar-recebimento", "#btn-registrar-reembolso",
                ".btn-editar-movimento", ".btn-cancelar-movimento",
            ):
                assert page.locator(seletor_proibido).count() == 0, seletor_proibido

        erros_antes_da_falha_do_pedido = len(console_errors)
        seletor.select_option("ORC-151")
        page.wait_for_function("document.getElementById('financeiroPedidoCardContainer').hidden === false")
        assert total_recebido_do_pedido() == "R$ 150,00", "o pedido tem recebimentos reais antes da falha"

        # Modal de edição aberto ANTES da falha: a confirmação precisa ser recusada depois dela.
        botao_editar_antes_da_falha = page.locator(".btn-editar-movimento").first
        pagamento_em_edicao = botao_editar_antes_da_falha.get_attribute("data-pagamento-id")
        versao_antes_da_falha = page.evaluate(
            f"(id) => {firestore_mock}.lerDiretamente('{colecao_151}', id).versao", pagamento_em_edicao
        )
        botao_editar_antes_da_falha.click()
        page.locator("#modalMovimentoFinanceiro").wait_for(state="visible")

        assert page.evaluate(f"() => {firestore_mock}.falharListenerDe('{colecao_151}')") == 1
        assert_bloco_financeiro_em_falha()

        page.locator("#movimentoValor").fill("12.34")
        page.locator("#btn-confirmar-movimento-financeiro").click()
        page.wait_for_function(
            f"document.getElementById('ajudaMovimentoFinanceiro').textContent.includes('{mensagem_falha_pedido}')"
        )
        assert page.locator("#modalMovimentoFinanceiro").evaluate("m => m.classList.contains('active')")
        assert page.evaluate(
            f"(id) => {firestore_mock}.lerDiretamente('{colecao_151}', id).versao", pagamento_em_edicao
        ) == versao_antes_da_falha, "nenhuma correção pode partir de estado incompleto"
        page.locator("#btn-voltar-movimento-financeiro").click()
        assert_bloco_financeiro_em_falha()

        # Trocar de pedido descarta a falha do anterior; erro tardio de A não afeta B.
        seletor.select_option("ORC-153")
        page.wait_for_function("document.getElementById('orcamentoId').textContent === 'ORC-153'")
        assert page.locator(seletor_falha_pedido).count() == 0
        assert total_recebido_do_pedido() == "R$ 80,00"
        assert page.evaluate(f"() => {firestore_mock}.dispararErroTardioDe('{colecao_151}')") is True
        page.wait_for_timeout(100)
        assert page.locator(seletor_falha_pedido).count() == 0, "erro tardio de A não pode marcar falha em B"
        assert total_recebido_do_pedido() == "R$ 80,00"
        assert page.locator("#btn-registrar-recebimento").is_enabled()

        # De volta a A: assinatura nova, valores normais.
        seletor.select_option("ORC-151")
        page.wait_for_function("document.getElementById('orcamentoId').textContent === 'ORC-151'")
        assert page.locator(seletor_falha_pedido).count() == 0
        assert total_recebido_do_pedido() == "R$ 150,00"

        # Snapshot válido posterior (mesma assinatura) limpa a falha e volta a renderizar normalmente.
        assert page.evaluate(f"() => {firestore_mock}.falharListenerDe('{colecao_151}')") == 1
        assert_bloco_financeiro_em_falha()
        page.evaluate(
            f"""(id) => {{
                const mock = {firestore_mock};
                mock.escreverDiretamente('{colecao_151}', id, mock.lerDiretamente('{colecao_151}', id));
            }}""",
            pagamento_em_edicao,
        )
        page.wait_for_function(f"document.querySelector('{seletor_falha_pedido}') === null")
        assert total_recebido_do_pedido() == "R$ 150,00"
        assert page.locator("#btn-registrar-recebimento").is_enabled()

        # "Tentar novamente": no SDK real o listener que falhou está encerrado; o botão reassina o MESMO
        # pedido (um unsubscribe + um subscribe) e a falha só sai com o snapshot válido da nova assinatura.
        assert page.evaluate(f"() => {firestore_mock}.falharListenerDe('{colecao_151}')") == 1
        assert_bloco_financeiro_em_falha()
        antes_de_tentar_novamente = assinaturas(colecao_151)
        page.locator("#btn-recarregar-financeiro-pedido").click()
        page.wait_for_function(f"document.querySelector('{seletor_falha_pedido}') === null")
        depois_de_tentar_novamente = assinaturas(colecao_151)
        assert depois_de_tentar_novamente["unsubscribes"] == antes_de_tentar_novamente["unsubscribes"] + 1
        assert depois_de_tentar_novamente["subscribes"] == antes_de_tentar_novamente["subscribes"] + 1
        assert total_recebido_do_pedido() == "R$ 150,00"

        erros_da_falha_do_pedido = console_errors[erros_antes_da_falha_do_pedido:]
        assert len(erros_da_falha_do_pedido) == 3, erros_da_falha_do_pedido
        assert all("Listener de pagamentos do pedido" in erro for erro in erros_da_falha_do_pedido), erros_da_falha_do_pedido
        del console_errors[erros_antes_da_falha_do_pedido:]

        # J7. Contas a Receber: cargas concorrentes. Só a carga mais recente escreve.
        tabs.nth(4).click()
        page.wait_for_function("document.getElementById('contasReceberCarregando').hidden === true")
        page.locator("#contasReceberFiltroSituacao").select_option("todos")
        page.wait_for_timeout(50)
        assert page.locator("#contasReceberTabelaContainer tbody tr").count() == linhas_completas

        def recebido_153_em_contas():
            linha = page.locator("#contasReceberTabelaContainer tbody tr").filter(has_text="ORC-153")
            return normalizar(linha.locator('[data-label="Recebido"]').inner_text())

        def retidas():
            return page.evaluate(f"() => {firestore_mock}.quantidadeDeLeiturasRetidas()")

        botao_atualizar_contas = page.locator("#btn-atualizar-contas-a-receber")

        # Cenário 1: A começa, B começa e termina com sucesso, A termina depois com dado velho -> ignorada.
        page.evaluate(f"() => {firestore_mock}.reterLeiturasDe('{colecao_153}')")
        botao_atualizar_contas.click()
        page.wait_for_function(f"() => {firestore_mock}.quantidadeDeLeiturasRetidas() === 1")
        page.evaluate(f"() => {firestore_mock}.reterLeiturasDe(null)")
        botao_atualizar_contas.click()
        page.wait_for_function("document.getElementById('contasReceberCarregando').hidden === true")
        assert recebido_153_em_contas() == "R$ 80,00"
        assert page.evaluate(f"() => {firestore_mock}.liberarLeituraRetida('vazio')") is True
        page.wait_for_timeout(150)
        assert recebido_153_em_contas() == "R$ 80,00", "resultado velho da carga A não pode sobrescrever B"
        assert page.locator("#contasReceberErro").is_hidden()
        assert page.locator("#contasReceberCarregando").is_hidden()

        # Cenário 2: A começa, B termina com sucesso, A FALHA depois -> o erro antigo não apaga B.
        page.evaluate(f"() => {firestore_mock}.reterLeiturasDe('{colecao_153}')")
        botao_atualizar_contas.click()
        page.wait_for_function(f"() => {firestore_mock}.quantidadeDeLeiturasRetidas() === 1")
        page.evaluate(f"() => {firestore_mock}.reterLeiturasDe(null)")
        botao_atualizar_contas.click()
        page.wait_for_function("document.getElementById('contasReceberCarregando').hidden === true")
        assert page.evaluate(f"() => {firestore_mock}.liberarLeituraRetida('falha')") is True
        page.wait_for_timeout(150)
        assert page.locator("#contasReceberErro").is_hidden(), "falha de carga superada não mostra erro"
        assert page.locator("#contasReceberTabelaContainer tbody tr").count() == linhas_completas
        assert recebido_153_em_contas() == "R$ 80,00"

        # Cenário 3: A e B em voo; A termina primeiro -> o finally de A não esconde o loading de B.
        page.evaluate(f"() => {firestore_mock}.reterLeiturasDe('{colecao_153}')")
        botao_atualizar_contas.click()
        page.wait_for_function(f"() => {firestore_mock}.quantidadeDeLeiturasRetidas() === 1")
        botao_atualizar_contas.click()
        page.wait_for_function(f"() => {firestore_mock}.quantidadeDeLeiturasRetidas() === 2")
        assert page.evaluate(f"() => {firestore_mock}.liberarLeituraRetida('atual')") is True
        page.wait_for_timeout(150)
        assert page.locator("#contasReceberCarregando").is_visible(), "a carga B ainda está lendo"
        page.evaluate(f"() => {firestore_mock}.reterLeiturasDe(null)")
        assert page.evaluate(f"() => {firestore_mock}.liberarLeituraRetida('atual')") is True
        page.wait_for_function("document.getElementById('contasReceberCarregando').hidden === true")
        assert page.locator("#contasReceberErro").is_hidden()
        assert page.locator("#contasReceberTabelaContainer tbody tr").count() == linhas_completas
        assert retidas() == 0

        tabs.nth(1).click()

        # K. Impressão e privacidade: nada do financeiro do pedido vaza para a Proposta Cliente nem para a impressão.
        seletor.select_option("ORC-151")
        verificar_impressao_sem_dados_internos(page, "impressão com pagamentos lançados", VALORES_PAGAMENTO)
        tabs.nth(2).click()
        verificar_aba_proposta_sem_dados_internos(page, "aba Proposta com pagamentos lançados", VALORES_PAGAMENTO)
        tabs.nth(1).click()

        # L. Mobile 390 px: Financeiro do pedido e Contas a Receber sem rolagem horizontal.
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        assert sem_rolagem_horizontal(page)
        page.locator("#financeiroPedidoCardContainer").screenshot(path=str(artifacts / "financeiro-pedido-mobile.png"))
        tabs.nth(4).click()
        page.wait_for_timeout(100)
        assert sem_rolagem_horizontal(page)
        page.set_viewport_size({"width": 1440, "height": 1000})
        tabs.nth(1).click()

        # --- Hardening do contrato de backup: cadeia validada na exportação, ordem determinística e
        # importação fail-closed para pagamentos malformados. ---
        seletor.select_option("ORC-151")
        botao_para_corromper = page.locator(".btn-editar-movimento").first
        pagamento_id_corrompido = botao_para_corromper.get_attribute("data-pagamento-id")

        movimento_original = page.evaluate(
            f"(pagamentoId) => {firestore_mock}.lerDiretamente('orcamentos/ORC-151/pagamentos', pagamentoId)",
            pagamento_id_corrompido,
        )

        # N. Exportação recusa cadeia de auditoria inconsistente: a versão do movimento avança sem que
        # o evento correspondente exista (evento v2 faltante). Nenhum download deve acontecer.
        # O botão de exportar/importar vive na aba Configurações: navega até lá primeiro, e garante que
        # o clique em si seja bem-sucedido ANTES de esperar (ou não) pelo evento de download — assim o
        # timeout do expect_download só pode significar "nenhum download", nunca "botão não clicável".
        tabs.nth(5).click()
        botao_exportar = page.locator("#btn-exportar-dados")
        botao_exportar.wait_for(state="visible")

        erros_console_antes_do_backup = len(console_errors)
        page.evaluate(
            f"""(pagamentoId) => {{
                const mock = {firestore_mock};
                const colecao = 'orcamentos/ORC-151/pagamentos';
                const atual = mock.lerDiretamente(colecao, pagamentoId);
                mock.escreverDiretamente(colecao, pagamentoId, {{ ...atual, versao: atual.versao + 1, ultimoEventoId: 'v' + (atual.versao + 1) }});
            }}""",
            pagamento_id_corrompido,
        )
        try:
            with page.expect_download(timeout=2000):
                botao_exportar.click()
            raise AssertionError("backup com cadeia inconsistente não deveria gerar download")
        except PlaywrightTimeoutError:
            pass
        page.wait_for_function(
            "document.getElementById('app-notification').textContent.includes('Nenhum arquivo foi gerado')"
        )
        notificacao_erro_backup = notificacao(page)
        assert pagamento_id_corrompido in notificacao_erro_backup
        assert "ORC-151" in notificacao_erro_backup
        assert "Nenhum arquivo foi gerado" in notificacao_erro_backup
        erros_backup = console_errors[erros_console_antes_do_backup:]
        assert len(erros_backup) == 1 and "inconsistente" in erros_backup[0], erros_backup
        del console_errors[erros_console_antes_do_backup:]

        # O. Corrigida a cadeia (documento restaurado ao estado válido), a exportação volta a funcionar:
        # a checagem bloqueia o inconsistente, não qualquer exportação.
        page.evaluate(
            f"([pagamentoId, dados]) => {firestore_mock}.escreverDiretamente('orcamentos/ORC-151/pagamentos', pagamentoId, dados)",
            [pagamento_id_corrompido, movimento_original],
        )
        with page.expect_download(timeout=5000) as download_info:
            page.locator("#btn-exportar-dados").click()
        download = download_info.value
        assert download.suggested_filename.startswith("filippini_backup_")
        page.wait_for_function(
            "document.getElementById('app-notification').textContent.includes('Backup concluído com sucesso')"
        )

        # O2. Exportação recusa pagamento cujo PAI não é pedido v2 com snapshot financeiro válido: o
        # backup só pode conter o que uma restauração futura conseguiria associar a um pai legítimo.
        orcamento_151_original = page.evaluate(f"() => {firestore_mock}.lerDiretamente('orcamentos', 'ORC-151')")
        page.evaluate(
            f"""(original) => {{
                const corrompido = structuredClone(original);
                corrompido.pedido.financeiro.valorComissaoCentavos += 1;
                {firestore_mock}.escreverDiretamente('orcamentos', 'ORC-151', corrompido);
            }}""",
            orcamento_151_original,
        )
        # Espera a aplicação absorver o snapshot inválido: o bloco financeiro do pedido desaparece.
        tabs.nth(1).click()
        seletor.select_option("ORC-151")
        page.wait_for_function("document.getElementById('financeiroPedidoCardContainer').hidden === true")

        erros_console_antes_do_pai = len(console_errors)
        tabs.nth(5).click()
        botao_exportar.wait_for(state="visible")
        try:
            with page.expect_download(timeout=2000):
                botao_exportar.click()
            raise AssertionError("backup com pai financeiro inválido não deveria gerar download")
        except PlaywrightTimeoutError:
            pass
        page.wait_for_function(
            "document.getElementById('app-notification').textContent.includes('Nenhum arquivo foi gerado')"
        )
        notificacao_pai = notificacao(page)
        assert "ORC-151" in notificacao_pai
        assert "snapshot financeiro válido" in notificacao_pai
        assert "Nenhum arquivo foi gerado" in notificacao_pai
        erros_pai = console_errors[erros_console_antes_do_pai:]
        assert len(erros_pai) == 1 and "inconsistente" in erros_pai[0], erros_pai
        del console_errors[erros_console_antes_do_pai:]

        # Restaurado o pedido, a exportação volta a funcionar: o bloqueio é do pai inválido.
        page.evaluate(
            f"(original) => {firestore_mock}.escreverDiretamente('orcamentos', 'ORC-151', original)",
            orcamento_151_original,
        )
        tabs.nth(1).click()
        seletor.select_option("ORC-151")
        page.wait_for_function("document.getElementById('financeiroPedidoCardContainer').hidden === false")
        tabs.nth(5).click()
        botao_exportar.wait_for(state="visible")
        with page.expect_download(timeout=5000):
            botao_exportar.click()
        page.wait_for_function(
            "document.getElementById('app-notification').textContent.includes('Backup concluído com sucesso')"
        )

        # P. Importação: contrato de `pagamentos` distingue ausente / vazio / não-vazio / malformado.
        arquivo_pagamentos_objeto = artifacts / "backup-pagamentos-objeto.json"
        arquivo_pagamentos_objeto.write_text(json.dumps({"version": "2.0", "pagamentos": {}}), encoding="utf-8")
        arquivo_pagamentos_texto = artifacts / "backup-pagamentos-texto.json"
        arquivo_pagamentos_texto.write_text(json.dumps({"version": "2.0", "pagamentos": "x"}), encoding="utf-8")
        arquivo_pagamentos_nulo = artifacts / "backup-pagamentos-nulo.json"
        arquivo_pagamentos_nulo.write_text(json.dumps({"version": "2.0", "pagamentos": None}), encoding="utf-8")
        # versaoBackup presente precisa estar entre 1 e a versão suportada: 0 e negativos são inválidos.
        arquivo_versao_zero = artifacts / "backup-versao-zero.json"
        arquivo_versao_zero.write_text(json.dumps({"version": "2.0", "versaoBackup": 0, "pagamentos": []}), encoding="utf-8")
        arquivo_versao_negativa = artifacts / "backup-versao-negativa.json"
        arquivo_versao_negativa.write_text(json.dumps({"version": "2.0", "versaoBackup": -1, "pagamentos": []}), encoding="utf-8")
        arquivo_pagamentos_vazio = artifacts / "backup-pagamentos-vazio.json"
        arquivo_pagamentos_vazio.write_text(json.dumps({"version": "2.0", "pagamentos": []}), encoding="utf-8")

        ids_antes_import = page.evaluate(
            "() => [...document.querySelectorAll('#seletorOrcamento option')].map(o => o.value).sort()"
        )
        erros_console_antes_do_import = len(console_errors)

        for caminho in (
            arquivo_pagamentos_objeto, arquivo_pagamentos_texto, arquivo_pagamentos_nulo,
            arquivo_versao_zero, arquivo_versao_negativa,
        ):
            # Limpa a notificação para que cada espera abaixo corresponda a ESTA importação, não à anterior.
            page.evaluate("() => { document.getElementById('app-notification').textContent = ''; }")
            page.locator("#arquivo-backup").set_input_files(str(caminho))
            page.wait_for_function(
                "document.getElementById('app-notification').textContent.includes('Estrutura de backup inválida')"
            )
            ids_depois = page.evaluate(
                "() => [...document.querySelectorAll('#seletorOrcamento option')].map(o => o.value).sort()"
            )
            assert ids_depois == ids_antes_import, f"{caminho.name}: zero writes esperado, ids mudaram"

        # `pagamentos: []` não é malformado nem bloqueado por conter histórico: segue o fluxo normal
        # (que aqui esbarra, sem problema, na ausência de qualquer outro registro para restaurar).
        page.locator("#arquivo-backup").set_input_files(str(arquivo_pagamentos_vazio))
        page.wait_for_function(
            "document.getElementById('app-notification').textContent.includes('não contém registros para restaurar')"
        )
        ids_depois_vazio = page.evaluate(
            "() => [...document.querySelectorAll('#seletorOrcamento option')].map(o => o.value).sort()"
        )
        assert ids_depois_vazio == ids_antes_import

        erros_import = console_errors[erros_console_antes_do_import:]
        assert len(erros_import) == 6, erros_import
        assert all("Estrutura de backup inválida" in erro for erro in erros_import[:5]), erros_import
        assert "não contém registros para restaurar" in erros_import[5], erros_import
        del console_errors[erros_console_antes_do_import:]

        assert console_errors == [], console_errors
        assert request_failures == [], request_failures
        browser.close()

    if browser_errors:
        raise AssertionError("Erros JavaScript no navegador: " + " | ".join(browser_errors))

    print(
        "Browser smoke test passou: login, prévia com produto válido, salvamento, "
        "duplicação, validade, impressão, proposta detalhada móvel, contatos, WhatsApp, "
        "follow-ups, status perdido/reaberto, pedido confirmado, comissão configurável, snapshot v2, "
        "confirmação transacional, cancelamento, relatório financeiro de vendas, pagamentos do pedido "
        "(recebimento, reembolso, edição, conflito, cancelamento), Contas a Receber fail-closed, "
        "listener sem churn nem callback tardio e backup fail-closed (cadeia, pai financeiro, "
        "importação malformada) validados."
    )


if __name__ == "__main__":
    main()
