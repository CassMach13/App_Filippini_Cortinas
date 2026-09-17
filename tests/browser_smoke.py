import re
import sys
import unicodedata
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
        assert pedido04["pedido"]["versaoSnapshot"] == 1
        assert pedido04["infoComercial"]["percentualComissao"] == 10

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

        assert console_errors == []
        assert request_failures == []
        browser.close()

    if browser_errors:
        raise AssertionError("Erros JavaScript no navegador: " + " | ".join(browser_errors))

    print(
        "Browser smoke test passou: login, prévia com produto válido, salvamento, "
        "duplicação, validade, impressão, proposta detalhada móvel, contatos, WhatsApp, "
        "follow-ups, status perdido/reaberto, pedido confirmado e comissão configurável validados."
    )


if __name__ == "__main__":
    main()
