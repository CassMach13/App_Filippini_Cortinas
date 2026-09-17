// apps.js

// --- 1. IMPORTAÇÕES ---
// Importa as instâncias do Firebase
import { auth, db } from './firebase-config.js'; 
// Importa as funções de autenticação e do Firestore
import { onAuthStateChanged, signOut, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { collection, getDocs, addDoc, doc, setDoc, updateDoc, deleteDoc, writeBatch, query, where, onSnapshot, runTransaction } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
    PERCENTUAL_COMISSAO_PADRAO,
    STATUS_DOCUMENTO,
    agruparItensPorFornecedor,
    alterarPercentualComissao,
    calcularIndicadoresDoItem,
    calcularTotaisOrcamento,
    confirmarOrcamentoComoPedido,
    criarOrcamentoDuplicado,
    marcarOrcamentoComoPerdido,
    obterItensDoPedido,
    obterPercentualComissao,
    obterStatusComercial,
    orcamentoEstaPerdido,
    pedidoEstaConfirmado,
    reabrirNegociacao,
    somarIndicadoresDosItens,
    validarExclusaoOrcamento
} from './order-domain.js';
import { formatarCelular, gerarLinkWhatsApp, normalizarCelular } from './contact-domain.js';
import { converterInstanteParaDataCivil, ehDataCivilValida, obterDataCivilAtual } from './date-domain.js';
import { listarFollowUps } from './followup-domain.js';
import {
    arredondamentoFinanceiro,
    calcularDetalhesItem,
    calcularPrecoFinal,
    interpretarPercentualComissao,
    normalizarUnidadeMedida,
    validarParametrosProduto,
    validarParametrosItem
} from './pricing-domain.js';

// --- 2. REFERÊNCIAS DO DOM (Elementos da Página) ---
const loginScreen = document.getElementById('login-screen');
const appContainer = document.getElementById('app-container');
const loginForm = document.getElementById('login-form');
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const feedbackMessageLogin = document.getElementById('feedbackMessageLogin');
const syncStatus = document.getElementById('sync-status');
const appNotification = document.getElementById('app-notification');

// --- VARIÁVEIS GLOBAIS DA APLICAÇÃO ---
// Estas variáveis irão armazenar os dados carregados do Firestore
let precos = [];
let fornecedores = [];
let categorias = [];
let unidadesDeMedida = [];
let orcamentosSalvos = {};
let orcamentosPersistidos = {};
let orcamentoAtualId = null;
let lastOrcamentoId = 0; // Manter se for usado em alguma lógica legada
let unsubscribeListeners = []; // Array para armazenar as funções de unsubscribe
let listaProdutosFiltrada = [];
let paginaAtual = 1;
const itensPorPagina = 10;
let estadoOrdenacao = { coluna: 'codigo', direcao: 'asc' };
const dataVersion = "2.0"; // Versão para controle de backup
const orcamentosComAlteracoesPendentes = new Set();
let temporizadorNotificacao = null;
// Campo de celular -> link de WhatsApp e texto de ajuda correspondentes.
const CONTATOS_WHATSAPP = {
    celularCliente: { link: 'whatsappCliente', ajuda: 'ajudaCelularCliente' },
    celularComissionado: { link: 'whatsappComissionado', ajuda: 'ajudaCelularComissionado' }
};
const MENSAGEM_CELULAR_INVALIDO = 'Cadastre um celular válido com DDD, ex.: (11) 98765-4321, para abrir o WhatsApp.';

function escaparHtml(valor) {
    return String(valor ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function atualizarStatusSincronizacao(mensagem = '', tipo = 'ok') {
    if (!syncStatus) return;
    syncStatus.textContent = mensagem;
    syncStatus.className = `sync-status sync-status-${tipo}`;
    syncStatus.hidden = !mensagem;
}

function mostrarNotificacao(mensagem, tipo) {
    if (!appNotification) return;

    const texto = String(mensagem || '');
    const pareceSucesso = /sucesso|concluíd|gerad|criad|adicionad|atualizad|importad|mesclad/i.test(texto)
        && !/não|falha|erro/i.test(texto);
    const tipoFinal = tipo || (pareceSucesso ? 'sucesso' : 'erro');

    window.clearTimeout(temporizadorNotificacao);
    appNotification.textContent = texto;
    appNotification.className = `app-notification app-notification-${tipoFinal} visible`;
    appNotification.setAttribute('role', tipoFinal === 'erro' ? 'alert' : 'status');
    temporizadorNotificacao = window.setTimeout(() => {
        appNotification.classList.remove('visible');
    }, tipoFinal === 'erro' ? 8000 : 5000);
}

function marcarAlteracaoPendente(id = orcamentoAtualId) {
    if (!id || pedidoEstaConfirmado(orcamentosSalvos[id])) return;
    orcamentosComAlteracoesPendentes.add(id);
    atualizarStatusSincronizacao('Alterações não salvas', 'carregando');
}

function tratarErroListener(nomeColecao, error) {
    console.error(`Erro ao sincronizar ${nomeColecao}:`, error);
    atualizarStatusSincronizacao(`Falha ao sincronizar ${nomeColecao}. Verifique sua conexão.`, 'erro');
}

function obterOrcamentoAtual() {
    return orcamentosSalvos[orcamentoAtualId] || null;
}

function garantirOrcamentoEditavel(acao = 'alterar os itens') {
    const orcamento = obterOrcamentoAtual();
    if (orcamentoEstaPerdido(orcamento)) {
        mostrarNotificacao(`Este orçamento está marcado como perdido / não fechado. Para ${acao}, reabra a negociação.`);
        return false;
    }
    if (!pedidoEstaConfirmado(orcamento)) return true;

    mostrarNotificacao(`Este registro já foi confirmado como pedido. Para ${acao}, duplique-o e crie um novo orçamento.`);
    return false;
}

function descreverStatusComercial(orcamento) {
    const status = obterStatusComercial(orcamento);
    if (status === STATUS_DOCUMENTO.PERDIDO) return 'Perdido / Não fechado';
    if (status !== STATUS_DOCUMENTO.PEDIDO) return 'Em negociação';

    const dataConfirmacao = converterInstanteParaDataCivil(orcamento.pedido.confirmadoEm);
    return dataConfirmacao ? `Pedido confirmado em ${formatarData(dataConfirmacao)}` : 'Pedido confirmado';
}

function atualizarInterfacePedido() {
    const orcamento = obterOrcamentoAtual();
    const statusComercial = obterStatusComercial(orcamento);
    const confirmado = statusComercial === STATUS_DOCUMENTO.PEDIDO;
    const perdido = statusComercial === STATUS_DOCUMENTO.PERDIDO;
    const emNegociacao = Boolean(orcamento) && statusComercial === STATUS_DOCUMENTO.ORCAMENTO;
    const botaoConfirmar = document.getElementById('btn-confirmar-pedido');
    const botaoPerdido = document.getElementById('btn-marcar-perdido');
    const botaoReabrir = document.getElementById('btn-reabrir-negociacao');
    const botaoExcluir = document.getElementById('btn-excluir-orcamento');
    const botaoFornecedor = document.getElementById('btn-baixar-excel-pedido-ao-fornecedor');
    const botaoInstalador = document.getElementById('btn-imprimir-instrucoes-ao-instalador');
    const possuiItens = Boolean(orcamento) && obterItensDoPedido(orcamento).length > 0;

    const textoStatus = descreverStatusComercial(orcamento);
    ['statusDocumento', 'statusDocumentoProposta'].forEach(id => {
        const status = document.getElementById(id);
        if (!status) return;
        status.textContent = textoStatus;
        status.className = `document-status document-status-${statusComercial}`;
    });

    if (botaoConfirmar) {
        botaoConfirmar.disabled = !emNegociacao || !possuiItens;
        botaoConfirmar.textContent = confirmado ? '✓ Pedido confirmado' : '✓ Transformar em Pedido';
        botaoConfirmar.title = !orcamento
            ? 'Selecione um orçamento.'
            : perdido
                ? 'Reabra a negociação antes de transformar em pedido.'
                : !possuiItens
                    ? 'Adicione pelo menos um item antes de transformar em pedido.'
                    : confirmado
                        ? 'Este pedido já foi confirmado.'
                        : '';
    }

    if (botaoPerdido) {
        botaoPerdido.hidden = perdido;
        botaoPerdido.disabled = !emNegociacao;
        botaoPerdido.title = confirmado
            ? 'Pedidos confirmados não podem ser marcados como perdidos.'
            : !orcamento
                ? 'Selecione um orçamento.'
                : '';
    }

    if (botaoReabrir) {
        botaoReabrir.hidden = !perdido;
        botaoReabrir.disabled = !perdido;
    }

    ['proximoFollowUp', 'observacaoFollowUp'].forEach(id => {
        const campo = document.getElementById(id);
        if (!campo) return;
        campo.disabled = !emNegociacao;
        campo.title = emNegociacao ? '' : 'Follow-ups são usados apenas em orçamentos em negociação.';
    });

    if (botaoExcluir) {
        const bloqueioExclusao = validarExclusaoOrcamento(orcamento);
        botaoExcluir.disabled = Boolean(bloqueioExclusao) || !orcamento || Object.keys(orcamentosSalvos).length <= 1;
        botaoExcluir.title = bloqueioExclusao
            || (Object.keys(orcamentosSalvos).length <= 1 ? 'O único orçamento não pode ser excluído.' : '');
    }

    [botaoFornecedor, botaoInstalador].forEach(botao => {
        if (!botao) return;
        botao.disabled = !confirmado || !possuiItens;
        botao.title = !confirmado
            ? 'Transforme o orçamento em pedido para liberar este relatório.'
            : !possuiItens
                ? 'O pedido não possui itens para este relatório.'
                : '';
    });

    const idsBloqueados = [
        'btn-criar-produto-acabado',
        'btn-adicionar-item-avulso',
        'btn-limpar-itens-do-orcamento',
        'vendaComComissao',
        'percentualComissao',
        'condicaoPagamento',
        'formaPagamento',
        'descontoGlobal',
        'observacoesComerciais'
    ];

    // Pedido confirmado mantém o congelamento; orçamento perdido fica somente leitura até ser reaberto.
    const bloqueado = confirmado || perdido;
    idsBloqueados.forEach(id => {
        const elemento = document.getElementById(id);
        if (elemento) elemento.disabled = bloqueado;
    });

    document.querySelectorAll('.btn-item-action, .btn-produto-action, .btn-add-item-to-produto')
        .forEach(botao => { botao.disabled = bloqueado; });
}

async function confirmarPedido() {
    const orcamento = obterOrcamentoAtual();
    if (!orcamento) return;
    if (pedidoEstaConfirmado(orcamento)) {
        mostrarNotificacao('Este orçamento já foi confirmado como pedido.');
        return;
    }
    if (orcamentoEstaPerdido(orcamento)) {
        mostrarNotificacao('Reabra a negociação antes de transformar este orçamento em pedido.');
        return;
    }

    const itens = [...(orcamento.itens || []), ...(orcamento.produtosAcabados || []).flatMap(produto => produto.itens || [])];
    if (itens.length === 0) {
        mostrarNotificacao('Adicione pelo menos um item antes de transformar o orçamento em pedido.');
        return;
    }

    if (!orcamento.infoGerais?.nomeCliente?.trim()) {
        mostrarNotificacao('Informe o nome do cliente antes de transformar o orçamento em pedido.');
        document.getElementById('nomeCliente')?.focus();
        return;
    }

    const confirmado = confirm('Ao transformar em pedido, itens, quantidades e custos serão congelados. Deseja continuar?');
    if (!confirmado) return;

    // A confirmação também registra o percentual de comissão efetivo de documentos antigos.
    const id = orcamentoAtualId;
    try {
        orcamentosSalvos[id] = confirmarOrcamentoComoPedido(orcamento, {
            confirmadoEm: new Date().toISOString(),
            confirmadoPor: auth.currentUser?.uid || null
        });
    } catch (error) {
        mostrarNotificacao(error.message);
        return;
    }

    const salvou = await salvarOrcamentoAtual(id);
    if (!salvou) return;
    atualizarSeletoresOrcamento(id);
    if (id === orcamentoAtualId) preencherInfoOrcamento();
    mostrarNotificacao(`Pedido ${orcamento.id} confirmado com sucesso.`, 'sucesso');
}

async function alterarStatusDoOrcamentoAtual(alterarStatus, mensagemSucesso) {
    const id = orcamentoAtualId;
    const orcamento = obterOrcamentoAtual();
    if (!orcamento) return false;

    let atualizado;
    try {
        atualizado = alterarStatus(orcamento, {
            alteradoEm: new Date().toISOString(),
            alteradoPor: auth.currentUser?.uid || null
        });
    } catch (error) {
        mostrarNotificacao(error.message);
        return false;
    }

    orcamentosSalvos[id] = atualizado;
    const salvou = await salvarOrcamentoAtual(id);
    if (!salvou) return false;

    atualizarSeletoresOrcamento(id);
    atualizarInterfacePedido();
    renderizarFollowUps();
    mostrarNotificacao(mensagemSucesso, 'sucesso');
    return true;
}

async function marcarOrcamentoAtualComoPerdido() {
    const orcamento = obterOrcamentoAtual();
    if (!orcamento) return;
    // A confirmação só é pedida quando a mudança é permitida; nos demais casos a regra de domínio explica o bloqueio.
    if (obterStatusComercial(orcamento) === STATUS_DOCUMENTO.ORCAMENTO
        && !confirm(`Marcar ${orcamento.id} como perdido / não fechado? Itens, valores e histórico serão mantidos, e a negociação poderá ser reaberta.`)) {
        return;
    }
    await alterarStatusDoOrcamentoAtual(marcarOrcamentoComoPerdido, `${orcamento.id} marcado como perdido / não fechado.`);
}

async function reabrirNegociacaoAtual() {
    const orcamento = obterOrcamentoAtual();
    if (!orcamento) return;
    await alterarStatusDoOrcamentoAtual(reabrirNegociacao, `Negociação de ${orcamento.id} reaberta.`);
}

// --- 3. FUNÇÕES DE DADOS (LISTENERS EM TEMPO REAL - FASE 4) ---

/**
 * Fase 4: Funções que "escutam" as coleções do Firestore em tempo real.
 * Elas substituem a necessidade da função `carregarDados()` manual.
 */
function escutarPrecos() {
    const precosRef = collection(db, 'precos');
    const unsubscribe = onSnapshot(precosRef, (snapshot) => {
        precos = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        filtrarProdutos(); // Atualiza a tabela de produtos
        console.log("Listener de Preços: Dados atualizados.");
    }, (error) => tratarErroListener('preços', error));
    unsubscribeListeners.push(unsubscribe);
}

function escutarFornecedores() {
    const fornecedoresRef = collection(db, 'fornecedores');
    const unsubscribe = onSnapshot(fornecedoresRef, (snapshot) => {
        fornecedores = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        atualizarSelects(); // Atualiza os dropdowns de filtro e cadastro
        // CORREÇÃO: Renderiza a lista no modal se ele estiver aberto.
        if (document.getElementById('modalGerenciarFornecedores').classList.contains('active')) renderizarListaFornecedores();
        console.log("Listener de Fornecedores: Dados atualizados.");
    }, (error) => tratarErroListener('fornecedores', error));
    unsubscribeListeners.push(unsubscribe);
}

function escutarCategorias() {
    const categoriasRef = collection(db, 'categorias');
    const unsubscribe = onSnapshot(categoriasRef, (snapshot) => {
        categorias = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        atualizarSelects();
        // CORREÇÃO: Renderiza a lista no modal se ele estiver aberto.
        if (document.getElementById('modalGerenciarCategorias').classList.contains('active')) renderizarListaCategorias();
        console.log("Listener de Categorias: Dados atualizados.");
    }, (error) => tratarErroListener('categorias', error));
    unsubscribeListeners.push(unsubscribe);
}

function escutarUnidadesDeMedida() {
    const unidadesRef = collection(db, 'unidadesDeMedida');
    const unsubscribe = onSnapshot(unidadesRef, (snapshot) => {
        unidadesDeMedida = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        atualizarSelectsUnidadeMedida();
        renderizarListaUnidadesMedida();
        console.log("Listener de Unidades de Medida: Dados atualizados.");
    }, (error) => tratarErroListener('unidades de medida', error));
    unsubscribeListeners.push(unsubscribe);
}

/**
 * NOVA ABORDAGEM: Função chamada uma única vez para garantir que existe pelo menos um orçamento.
 * Se não houver nenhum, cria o primeiro. Isso evita a condição de corrida do listener.
 */
async function inicializarOrcamentos() {
    const orcamentosRef = collection(db, 'orcamentos');
    const snapshot = await getDocs(orcamentosRef);
    if (snapshot.empty) {
        console.log("Nenhum orçamento encontrado. Criando o primeiro...");
        await criarNovoOrcamento();
    } else {
        console.log("Orçamentos existentes encontrados. O sistema iniciará normalmente.");
    }
}

function escutarOrcamentos() {
    const orcamentosRef = collection(db, 'orcamentos');
    const unsubscribe = onSnapshot(orcamentosRef, (snapshot) => {
        // O listener agora apenas sincroniza os dados, sem criar novos orçamentos.
        orcamentosSalvos = {};
        const novosPersistidos = {};
        const orcamentoIdAnterior = orcamentoAtualId;
        snapshot.docs.forEach(documento => {
            const orcamentoData = documento.data();
            const orcamentoCompleto = { ...orcamentoData, firestoreId: documento.id };
            orcamentosSalvos[orcamentoData.id] = orcamentoCompleto;
            novosPersistidos[orcamentoData.id] = documento.metadata.hasPendingWrites && orcamentosPersistidos[orcamentoData.id]
                ? orcamentosPersistidos[orcamentoData.id]
                : structuredClone(orcamentoCompleto);
        });
        orcamentosPersistidos = novosPersistidos;

        const idsOrdenados = Object.keys(orcamentosSalvos).sort();
        orcamentoAtualId = orcamentosSalvos[orcamentoIdAnterior] ? orcamentoIdAnterior : idsOrdenados[0] || null;
        
        atualizarSeletoresOrcamento();
        preencherInfoOrcamento(); // Atualiza a tela de orçamento com os novos dados
        renderizarFollowUps();
        if (orcamentosComAlteracoesPendentes.size === 0) {
            atualizarStatusSincronizacao('Dados sincronizados', 'ok');
        }
        console.log("Listener de Orçamentos: Dados atualizados.");
    }, (error) => tratarErroListener('orçamentos', error));
    unsubscribeListeners.push(unsubscribe);
}

// --- 4. FUNÇÕES DE CONTROLE DA UI (GERAL) ---

// Função para mostrar/esconder a aplicação principal
const toggleAppVisibility = (isLoggedIn) => {
    if (isLoggedIn) {
        loginScreen.style.display = 'none';
        appContainer.style.display = 'block';
    } else {
        loginScreen.style.display = 'flex';
        appContainer.style.display = 'none';
    }
};

// Função para exibir feedback na tela de login
const showLoginFeedback = (message) => {
    feedbackMessageLogin.textContent = message;
    feedbackMessageLogin.style.display = 'block';
};

// --- 5. LÓGICA DE AUTENTICAÇÃO ---

// Função que lida com o clique no botão de login
const handleLogin = async () => {
    const email = loginEmail.value.trim();
    const password = loginPassword.value.trim();

    feedbackMessageLogin.style.display = 'none';

    if (!email || !password) {
        showLoginFeedback("Por favor, preencha e-mail e senha.");
        (email ? loginPassword : loginEmail).focus();
        return;
    }

    if (!loginEmail.validity.valid) {
        showLoginFeedback('Informe um e-mail válido.');
        loginEmail.focus();
        return;
    }

    btnLogin.disabled = true;
    btnLogin.textContent = 'Entrando…';
    loginForm.setAttribute('aria-busy', 'true');
    try {
        await signInWithEmailAndPassword(auth, email, password);
        // O onAuthStateChanged cuidará de mostrar o app.
    } catch (error) {
        console.error("Erro no login:", error.code);
        if (error.code === 'auth/invalid-credential' || error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
            showLoginFeedback("E-mail ou senha incorretos.");
        } else {
            showLoginFeedback("Ocorreu um erro ao tentar fazer login.");
        }
    } finally {
        btnLogin.disabled = false;
        btnLogin.textContent = 'Entrar';
        loginForm.removeAttribute('aria-busy');
    }
};

// Função que lida com o clique no botão de logout
const handleLogout = async () => {
    try {
        await signOut(auth);
        // O onAuthStateChanged cuidará de mostrar a tela de login.
    } catch (error) {
        console.error("Erro ao fazer logout:", error);
    }
};

// Função para desanexar todos os listeners
function detachAllListeners() {
    console.log(`Desanexando ${unsubscribeListeners.length} listeners do Firestore...`);
    unsubscribeListeners.forEach(unsubscribe => unsubscribe());
    unsubscribeListeners = []; // Limpa o array para a próxima sessão de login
}


// --- 6. PONTO DE ENTRADA DA APLICAÇÃO ---

// Observador principal do status de autenticação
onAuthStateChanged(auth, async (user) => {
    if (user) {
        // --- USUÁRIO AUTENTICADO ---
        console.log("Usuário autenticado:", user.uid);

        try {
            detachAllListeners();
            atualizarStatusSincronizacao('Sincronizando dados...', 'carregando');

            // 1. Garante que o estado inicial dos orçamentos está correto.
            await inicializarOrcamentos();

            // 2. Inicia os listeners para manter tudo sincronizado a partir de agora.
            escutarPrecos();
            escutarFornecedores();
            escutarCategorias();
            escutarUnidadesDeMedida();
            escutarOrcamentos();
            ajustarCamposCadastroPorUnidade(); // Garante que o campo Altura Padrão seja ajustado na inicialização

            toggleAppVisibility(true);
        } catch (error) {
            console.error('Falha ao inicializar os dados do sistema:', error);
            toggleAppVisibility(true);
            atualizarStatusSincronizacao('Não foi possível carregar os dados. Verifique sua conexão e tente novamente.', 'erro');
        }

    } else {
        // --- USUÁRIO DESLOGADO ---
        console.log("Nenhum usuário autenticado.");
        // Desanexa os listeners para evitar erros de permissão
        detachAllListeners();
        atualizarStatusSincronizacao();
        toggleAppVisibility(false);
    }
});

// Adiciona os listeners aos botões
loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleLogin();
});
btnLogout.addEventListener('click', handleLogout);

window.addEventListener('beforeunload', (event) => {
    if (orcamentosComAlteracoesPendentes.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
});

    // --- 8. INICIALIZAÇÃO DE EVENT LISTENERS ---
    // Adiciona os listeners aos botões e outros elementos interativos
    // que não são criados dinamicamente.
    const inicializarEventListeners = () => {
        // Abas Principais: o índice segue a ordem das abas no HTML.
        document.querySelectorAll('#main-tabs [role="tab"]').forEach((aba, indice) => {
            aba.addEventListener('click', () => showTab(indice));
        });
        document.getElementById('main-tabs').addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = [...document.querySelectorAll('#main-tabs [role="tab"]')];
            const indiceAtual = tabs.indexOf(document.activeElement);
            if (indiceAtual < 0) return;

            const novoIndice = event.key === 'Home'
                ? 0
                : event.key === 'End'
                    ? tabs.length - 1
                    : (indiceAtual + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            showTab(novoIndice, true);
        });

        // Aba 2: Controles do Orçamento
        document.getElementById('btn-novo-orcamento').addEventListener('click', criarNovoOrcamento);
        document.getElementById('btn-duplicar-orcamento').addEventListener('click', duplicarOrcamento);
        document.getElementById('btn-excluir-orcamento').addEventListener('click', excluirOrcamento);
        document.getElementById('btn-confirmar-pedido').addEventListener('click', confirmarPedido);
        document.getElementById('btn-marcar-perdido').addEventListener('click', marcarOrcamentoAtualComoPerdido);
        document.getElementById('btn-reabrir-negociacao').addEventListener('click', reabrirNegociacaoAtual);
        document.getElementById('listaFollowUps').addEventListener('click', (event) => {
            const botaoAbrir = event.target.closest('.btn-abrir-orcamento');
            if (botaoAbrir) abrirOrcamentoDoFollowUp(botaoAbrir.dataset.orcamentoId);
        });
        document.getElementById('btn-criar-produto-acabado').addEventListener('click', criarProdutoAcabado);
        // Botões movidos para dentro da tabela de orçamento
        document.getElementById('btn-adicionar-item-avulso').addEventListener('click', () => abrirModalAdicionarItem(null));
        document.getElementById('btn-limpar-itens-do-orcamento').addEventListener('click', limparOrcamento);
        // Comissão: o checkbox é só uma projeção de percentualComissao > 0.
        document.getElementById('vendaComComissao').addEventListener('change', (e) => {
            const percentualAtual = obterPercentualComissao(obterOrcamentoAtual());
            const novoPercentual = e.target.checked
                ? (percentualAtual > 0 ? percentualAtual : PERCENTUAL_COMISSAO_PADRAO)
                : 0;
            alterarComissaoPelaTela(novoPercentual);
        });
        document.getElementById('percentualComissao').addEventListener('change', (e) => {
            const percentual = interpretarPercentualComissao(e.target.value);
            if (percentual === null) {
                mostrarNotificacao('Informe um percentual de comissão entre 0 e 100, com até duas casas decimais (ex.: 7,5).');
                atualizarCamposComissao();
                return;
            }
            alterarComissaoPelaTela(percentual);
        });
        document.getElementById('seletorOrcamento').addEventListener('change', (event) => alternarOrcamento(event.target.value));
        // Listeners para o NOVO MODAL de adicionar item
        document.getElementById('btn-adicionar-item').addEventListener('click', adicionarItemAoOrcamento); // Botão "Salvar" do modal
        document.getElementById('btn-fechar-adicionar-item').addEventListener('click', fecharModalAdicionarItem);
        document.getElementById('btn-cancelar-adicionar-item').addEventListener('click', fecharModalAdicionarItem);
        document.getElementById('codigoOrcamento').addEventListener('input', atualizarPreviewCalculo);
        document.getElementById('quantidade').addEventListener('input', atualizarPreviewCalculo);
        document.getElementById('largura').addEventListener('input', atualizarPreviewCalculo);
        document.getElementById('altura').addEventListener('input', atualizarPreviewCalculo);

        // NOVA ABORDAGEM: Delegação de Eventos para a tabela de orçamento.
        // Um único listener na tabela gerencia os cliques em todas as linhas e botões.
        document.getElementById('tabelaOrcamento').addEventListener('click', (e) => {
            const target = e.target;

            // Ação: Editar ou Excluir um item (componente ou avulso)
            const itemAction = target.closest('.btn-item-action');
            if (itemAction) {
                const { produtoId, itemId, action } = itemAction.dataset;
                if (action === 'edit') {
                    abrirModalEdicaoItemOrcamento(produtoId === 'null' ? null : produtoId, itemId);
                } else if (action === 'delete') {
                    removerItem(produtoId === 'null' ? null : produtoId, itemId);
                }
                return; // Ação concluída
            }

            // Ação: Adicionar um item a um produto acabado
            const addItemAction = target.closest('.btn-add-item-to-produto');
            if (addItemAction) {
                abrirModalAdicionarItem(addItemAction.dataset.produtoId);
                return;
            }

            // Ação: Editar ou Excluir um produto acabado (a linha principal)
            const produtoAction = target.closest('.btn-produto-action');
            if (produtoAction) {
                const { produtoId, action } = produtoAction.dataset;
                if (action === 'edit') {
                    abrirModalEdicaoProdutoAcabado(produtoId);
                } else if (action === 'delete') {
                    removerProdutoAcabado(produtoId);
                }
                return; // Ação concluída
            }

            // Ação: Expandir/Recolher a lista de itens
            const produtoRow = target.closest('.produto-acabado-row');
            if (produtoRow) {
                toggleItensVisibilidade(produtoRow.dataset.produtoId);
            }
        });

        // NOVA ABORDAGEM: Delegação de Eventos para os inputs de instalação.
        document.getElementById('resumoAmbientes').addEventListener('blur', (e) => {
            // Verifica se o evento de blur veio de um input de instalação
            if (e.target && e.target.matches('input[data-ambiente]')) {
                const ambiente = e.target.dataset.ambiente;
                atualizarValorInstalacao(ambiente, e.target);
            }
        }, true); // O 'true' usa a fase de captura, garantindo que o evento seja pego.


        // Listeners para os campos de informações gerais do orçamento
        document.getElementById('nomeCliente').addEventListener('blur', (e) => atualizarInfoOrcamento('nomeCliente', e.target.value));
        document.getElementById('enderecoCliente').addEventListener('blur', (e) => atualizarInfoOrcamento('enderecoCliente', e.target.value));
        document.getElementById('dataOrcamento').addEventListener('blur', (e) => atualizarInfoOrcamento('dataOrcamento', e.target.value));
        document.getElementById('prazoValidade').addEventListener('blur', (e) => atualizarInfoOrcamento('prazoValidade', e.target.value));
        document.getElementById('prazoEntrega').addEventListener('blur', (e) => atualizarInfoOrcamento('prazoEntrega', e.target.value));
        document.getElementById('dataInstalacao').addEventListener('blur', (e) => atualizarInfoOrcamento('dataInstalacao', e.target.value));
        document.getElementById('btn-baixar-excel-pedido-ao-fornecedor').addEventListener('click', exportarExcel);
        document.getElementById('nomeCostureira').addEventListener('blur', (e) => atualizarInfoOrcamento('nomeCostureira', e.target.value));
        document.getElementById('enderecoCostureira').addEventListener('blur', (e) => atualizarInfoOrcamento('enderecoCostureira', e.target.value));
        document.getElementById('nomeInstalador').addEventListener('blur', (e) => atualizarInfoOrcamento('nomeInstalador', e.target.value));
        document.getElementById('observacoesGerais').addEventListener('blur', (e) => atualizarInfoOrcamento('observacoesGerais', e.target.value));

        // Contatos e follow-up: campos opcionais, gravados só quando o valor muda.
        Object.keys(CONTATOS_WHATSAPP).forEach(campo => {
            const input = document.getElementById(campo);
            input.addEventListener('input', () => atualizarContatoWhatsApp(campo, input.value));
            input.addEventListener('blur', () => atualizarCelular(campo));
        });
        document.getElementById('nomeComissionado').addEventListener('blur', (e) => atualizarCampoOpcionalOrcamento('nomeComissionado', e.target.value.trim()));
        document.getElementById('nomeComissionado').addEventListener('input', () => atualizarAvisoComissao());
        document.getElementById('proximoFollowUp').addEventListener('blur', (e) => {
            atualizarCampoOpcionalOrcamento('proximoFollowUp', ehDataCivilValida(e.target.value) ? e.target.value : '');
        });
        document.getElementById('observacaoFollowUp').addEventListener('blur', (e) => atualizarCampoOpcionalOrcamento('observacaoFollowUp', e.target.value.trim()));

        [
            'nomeCliente',
            'enderecoCliente',
            'celularCliente',
            'nomeComissionado',
            'celularComissionado',
            'proximoFollowUp',
            'observacaoFollowUp',
            'dataOrcamento',
            'prazoValidade',
            'prazoEntrega',
            'dataInstalacao',
            'nomeCostureira',
            'enderecoCostureira',
            'nomeInstalador',
            'observacoesGerais',
            'observacoesComerciais',
            'descontoGlobal'
        ].forEach(id => {
            document.getElementById(id)?.addEventListener('input', () => marcarAlteracaoPendente());
        });


        // Aba 1: Lista de Preços
        document.getElementById('btn-adicionar-preco').addEventListener('click', adicionarPreco);
        document.getElementById('categoria').addEventListener('change', ajustarCamposCadastroPorUnidade);
        document.getElementById('unidadeMedida').addEventListener('change', ajustarCamposCadastroPorUnidade);
        document.querySelectorAll('.coluna-ordenavel').forEach(th => {
            th.querySelector('.sort-button')?.addEventListener('click', () => ordenarTabela(th.dataset.coluna));
        });
        // Listeners para os filtros da Lista de Produtos
        document.getElementById('buscaProdutos').addEventListener('input', filtrarProdutos);
        document.getElementById('filtroFornecedor').addEventListener('change', filtrarProdutos);
        document.getElementById('filtroCategoria').addEventListener('change', filtrarProdutos);
        document.getElementById('filtroStatus').addEventListener('change', filtrarProdutos);

        // Aba 4: Configurações
        document.getElementById('btn-abrir-gerenciador-de-fornecedores').addEventListener('click', () => gerenciarFornecedores());
        document.getElementById('btn-abrir-gerenciador-de-categorias').addEventListener('click', () => gerenciarCategorias());
        document.getElementById('btn-abrir-gerenciador-de-unidades-de-medida').addEventListener('click', () => gerenciarUnidadesMedida());
        document.getElementById('btn-exportar-dados').addEventListener('click', exportarDados);
        document.getElementById('arquivo-backup').addEventListener('change', importarDados);
        document.getElementById('btn-importar-csv').addEventListener('click', () => importarCSV());
        document.getElementById('btn-baixar-template').addEventListener('click', baixarTemplateCSV);
        // Listeners para o modal de preview do CSV
        document.getElementById('btn-fechar-preview-csv').addEventListener('click', fecharModalPreviewCSV);
        document.getElementById('btn-cancelar-preview-csv').addEventListener('click', fecharModalPreviewCSV);
        document.getElementById('btnImportarValidos').addEventListener('click', () => importarDadosDoPreview(true));
        document.getElementById('btnImportarTodos').addEventListener('click', () => importarDadosDoPreview(false));

        // Aba 3: Proposta
        document.getElementById('btn-imprimir-proposta').addEventListener('click', imprimirPropostaComNomeDinamico);
        document.getElementById('btn-imprimir-instrucoes-ao-instalador').addEventListener('click', imprimirInstrucoesInstalador);
        // Listeners para os campos de dados comerciais
        document.getElementById('condicaoPagamento').addEventListener('change', (e) => atualizarInfoComercial('condicaoPagamento', e.target.value));
        document.getElementById('formaPagamento').addEventListener('change', (e) => atualizarInfoComercial('formaPagamento', e.target.value));
        document.getElementById('descontoGlobal').addEventListener('input', (e) => {
            // A prévia usa o documento em memória, com o mesmo valor que será gravado ao sair do campo;
            // assim a proposta continua vindo de calcularTotaisOrcamento, sem fórmula paralela na tela.
            const orcamento = obterOrcamentoAtual();
            if (orcamento && obterStatusComercial(orcamento) === STATUS_DOCUMENTO.ORCAMENTO) {
                orcamento.infoComercial = { ...(orcamento.infoComercial || {}), descontoGlobal: parseFloat(e.target.value) || 0 };
            }
            atualizarPropostaCliente();
        });
        document.getElementById('descontoGlobal').addEventListener('blur', (e) => atualizarInfoComercial('descontoGlobal', parseFloat(e.target.value) || 0));
        document.getElementById('observacoesComerciais').addEventListener('blur', (e) => atualizarInfoComercial('observacoesComerciais', e.target.value));
        document.getElementById('modoProposta').addEventListener('change', atualizarConfiguracaoProposta);
        document.getElementById('mostrarValoresItens').addEventListener('change', atualizarConfiguracaoProposta);
        document.getElementById('mostrarCustosFornecedor').addEventListener('change', atualizarConfiguracaoProposta);

        inicializarSelectInteligente('codigoOrcamento');
        inicializarSelectInteligente('edicaoCodigoItem');

        // Outros... (adicionar mais listeners conforme necessário)
        // Listeners para Modais de Edição (Fornecedor, Categoria, Unidade)
        document.getElementById('btn-cancelar-edicao-fornecedor').addEventListener('click', fecharModalEdicaoFornecedor);
        document.getElementById('btn-salvar-edicao-fornecedor').addEventListener('click', salvarEdicaoFornecedor);
        document.getElementById('btn-fechar-edicao-fornecedor').addEventListener('click', fecharModalEdicaoFornecedor);

        document.getElementById('btn-cancelar-edicao-categoria').addEventListener('click', fecharModalEdicaoCategoria);
        document.getElementById('btn-salvar-edicao-categoria').addEventListener('click', salvarEdicaoCategoria);
        document.getElementById('btn-fechar-edicao-categoria').addEventListener('click', fecharModalEdicaoCategoria);

        document.getElementById('btn-cancelar-edicao-unidade').addEventListener('click', fecharModalEdicaoUnidadeMedida);
        document.getElementById('btn-salvar-edicao-unidade').addEventListener('click', salvarEdicaoUnidadeMedida);
        document.getElementById('btn-fechar-edicao-unidade').addEventListener('click', fecharModalEdicaoUnidadeMedida);

        // Modais de Gerenciamento
        document.getElementById('btn-fechar-gerenciar-fornecedores').addEventListener('click', () => fecharModal('modalGerenciarFornecedores'));
        document.getElementById('btn-adicionar-fornecedor-modal').addEventListener('click', adicionarFornecedorModal);
        document.getElementById('btn-fechar-gerenciar-categorias').addEventListener('click', () => fecharModal('modalGerenciarCategorias'));
        document.getElementById('btn-adicionar-categoria-modal').addEventListener('click', adicionarCategoriaModal);
        document.getElementById('btn-fechar-gerenciar-unidades').addEventListener('click', () => fecharModal('modalGerenciarUnidadesMedida'));
        document.getElementById('btn-adicionar-unidade-modal').addEventListener('click', adicionarUnidadeMedidaModal);

        // Modal Edição Produto Acabado
        document.getElementById('btn-fechar-edicao-produto-acabado').addEventListener('click', () => fecharModal('modalEdicaoProdutoAcabado'));
        document.getElementById('btn-cancelar-edicao-produto-acabado').addEventListener('click', () => fecharModal('modalEdicaoProdutoAcabado'));
        document.getElementById('btn-salvar-edicao-produto-acabado').addEventListener('click', salvarEdicaoProdutoAcabado);

        // Modal Edição Item Orçamento
        document.getElementById('btn-fechar-edicao-item').addEventListener('click', fecharModalEdicaoItem);
        document.getElementById('btn-cancelar-edicao-item').addEventListener('click', fecharModalEdicaoItem);
        document.getElementById('btn-salvar-edicao-item').addEventListener('click', salvarEdicaoItem);
        // Listeners para os campos do modal de edição de item
        document.getElementById('edicaoCodigoItem').addEventListener('input', atualizarPreviewCalculoEdicao);
        document.getElementById('edicaoQuantidadeItem').addEventListener('input', atualizarPreviewCalculoEdicao);
        document.getElementById('edicaoLarguraItem').addEventListener('input', atualizarPreviewCalculoEdicao);
        document.getElementById('edicaoAlturaItem').addEventListener('input', atualizarPreviewCalculoEdicao);


        // Modal Edição Produto
        document.getElementById('btn-fechar-edicao-produto').addEventListener('click', fecharModalEdicaoProduto);
        document.getElementById('btn-cancelar-edicao-produto').addEventListener('click', fecharModalEdicaoProduto);
        document.getElementById('btn-salvar-edicao-produto').addEventListener('click', salvarEdicaoProduto);
        document.getElementById('edicaoFornecedorProduto').addEventListener('change', ajustarCamposEdicaoProduto);
        document.getElementById('edicaoCategoriaProduto').addEventListener('change', ajustarCamposEdicaoProduto);
        document.getElementById('edicaoUnidadeMedidaProduto').addEventListener('change', ajustarCamposEdicaoProduto);



        console.log("Event listeners inicializados.");
    };

    // Chama a inicialização dos listeners.
    inicializarEventListeners();
    prepararAcessibilidadeModais();
    showTab(0);

    // Funções para controle de abas
    function showTab(index, moverFoco = false) {
        const tabs = document.querySelectorAll('#main-tabs .tab');
        const contents = document.querySelectorAll('.tab-content');
        tabs.forEach((tab, i) => {
            const ativa = i === index;
            tab.classList.toggle('active', ativa);
            tab.setAttribute('aria-selected', String(ativa));
            tab.tabIndex = ativa ? 0 : -1;
            contents[i].classList.toggle('active', ativa);
            contents[i].hidden = !ativa;
        });

        if (moverFoco) tabs[index]?.focus();

        const painelAtivo = contents[index];
        if (painelAtivo?.id === 'tab3') {
            atualizarPropostaCliente();
        } else if (painelAtivo?.id === 'tab-followups') {
            renderizarFollowUps();
        }
    }

    // --- INÍCIO: FUNÇÕES DA ABA DE ORÇAMENTO (MOVENDO PARA CIMA PARA RESOLVER REFERENCEERROR) ---

    // FUNÇÃO ADICIONADA: Estava faltando e causando o erro.
    function toggleItensVisibilidade(id) {
        let rows;
        if (id === 'avulsos') {
            rows = document.querySelectorAll('.componente-row-avulsos');
        } else {
            rows = document.querySelectorAll(`.componente-row-${id}`);
        }

        if (rows.length > 0) {
            const isHidden = rows[0].classList.contains('hidden-row');
            rows.forEach(row => {
                // CORREÇÃO: A lógica estava invertida. Agora, se estiver escondido (isHidden = true), a classe será removida.
                row.classList.toggle('hidden-row', !isHidden);
            });

            const iconElement = document.getElementById(`icon-${id}`);
            if (iconElement) {
                iconElement.textContent = isHidden ? '🔻' : '▶';
            }
        }
    }

    // FUNÇÃO ADICIONADA: Função auxiliar para criar botões com listeners
    function createButton(text, className) {
        const button = document.createElement('button');
        button.className = `btn ${className} btn-sm`;
        button.textContent = text;
        return button;
    }


    function renderizarItensOrcamento() {
        const tabelaOrcamento = document.getElementById('tabelaOrcamento');
        const resumoAmbientesDiv = document.getElementById('resumoAmbientes');
        tabelaOrcamento.innerHTML = '';
        resumoAmbientesDiv.innerHTML = '';
        
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (!orcamento) return;
        // Margens internas (antes do desconto) derivadas pelo domínio; nada é gravado nos itens.
        const percentualComissao = obterPercentualComissao(orcamento);

        // Renderizar Produtos Acabados
        (orcamento.produtosAcabados || []).forEach(produto => {
            const indicadoresProduto = somarIndicadoresDosItens(produto.itens, percentualComissao);
            const valorTotalProduto = indicadoresProduto.precoTotal;
            const margemTotalProduto = indicadoresProduto.margem;
            const margemPercentualProduto = indicadoresProduto.margemPercentual;

            const produtoRow = document.createElement('tr');
            produtoRow.className = 'produto-acabado-row';
            // NOVA ABORDAGEM: O ID é armazenado em um data-attribute para o listener delegado usar.
            produtoRow.dataset.produtoId = produto.id;
            
            produtoRow.innerHTML = `
                <td>
                    <strong>${produto.nome} (${(produto.itens || []).length} itens)</strong> 
                    <span id="icon-${produto.id}" style="cursor: pointer;">▶</span> 
                </td>
                <td>${produto.ambiente}</td>
                <td colspan="8" style="font-weight:normal; font-style:italic; color: #4A4A4A;">${produto.observacoes || ''}</td> 
                <td><strong>${formatarMoeda(valorTotalProduto)}</strong></td>
                <td>
                    <strong>${formatarMoeda(margemTotalProduto)}</strong>
                    <br>
                    <small>(${truncarDecimal(margemPercentualProduto, 2)}%)</small> 
                </td>
                <td style="text-align: center;"></td>
            `;
            // CORREÇÃO: Adicionar botões e seus listeners dinamicamente
            const actionsCell = produtoRow.cells[produtoRow.cells.length - 1]; // Pega a última célula
            const editButton = createButton('Editar', 'btn-warning btn-produto-action');
            editButton.dataset.produtoId = produto.id;
            editButton.dataset.action = 'edit';
            const deleteButton = createButton('Excluir', 'btn-danger btn-produto-action');
            deleteButton.dataset.produtoId = produto.id;
            deleteButton.dataset.action = 'delete';

            actionsCell.appendChild(editButton);
            actionsCell.appendChild(deleteButton);
            tabelaOrcamento.appendChild(produtoRow);

            (produto.itens || []).forEach(item => {
                const itemRow = document.createElement('tr');
                itemRow.className = `componente-row componente-row-${produto.id} hidden-row`; // Itens começam escondidos
                
                let larguraDisplay = item.largura !== null && item.largura !== undefined ? item.largura.toFixed(2) : '-';
                let alturaDisplay = item.altura !== null && item.altura !== undefined ? item.altura.toFixed(2) : '-';

                // CORREÇÃO: Para Metro Linear, a "largura" salva é na verdade a altura padrão.
                // Vamos exibi-la na coluna de altura.
                // A lógica de salvamento foi corrigida para que `item.altura` contenha a altura padrão.
                if (normalizarUnidadeMedida(item.unidadeMedida) === 'MetroLinear') {
                    // Agora lemos diretamente de item.altura, que contém o valor correto.
                    alturaDisplay = item.altura ? item.altura.toFixed(2) : '-';
                    larguraDisplay = '-'; // A coluna Largura fica vazia
                }
                const indicadoresItem = calcularIndicadoresDoItem(item, percentualComissao);

                itemRow.innerHTML = `
                    <td colspan="2" style="padding-left: 40px;">↳ ${item.categoria || 'Componente'}</td>
                    <td>${item.fornecedor || '-'}</td>
                    <td>${item.codigo || ''}</td>
                    <td>${item.descricao || ''}</td>
                    <td>${item.cor || '-'}</td>
                    <td>${item.quantidade || 0}</td>
                    <td>${larguraDisplay}</td>
                    <td>${alturaDisplay}</td>
                    <td>${formatarMoeda(item.precoUnitario || 0)}</td>
                    <td>${formatarMoeda(item.precoTotal || 0)}</td>
                    <td style="color: ${indicadoresItem.margemPercentual >= 30 ? '#6B8E6B' : indicadoresItem.margemPercentual >= 15 ? '#C89F8F' : '#A65555'}; font-weight: bold;">
                        ${formatarMoeda(indicadoresItem.margem)}<br>
                        <small>(${truncarDecimal(indicadoresItem.margemPercentual, 2)}%)</small>
                    </td>
                    <td style="text-align: center;"></td>
                `;
                // CORREÇÃO: Adicionar botões e seus listeners dinamicamente
                const itemActionsCell = itemRow.querySelector('td:last-child');
                const editItemButton = createButton('Editar', 'btn-warning btn-item-action');
                editItemButton.dataset.produtoId = produto.id;
                editItemButton.dataset.itemId = item.id;
                editItemButton.dataset.action = 'edit';
                const deleteItemButton = createButton('Excluir', 'btn-danger btn-item-action');
                deleteItemButton.dataset.produtoId = produto.id;
                deleteItemButton.dataset.itemId = item.id;
                deleteItemButton.dataset.action = 'delete';
                itemActionsCell.appendChild(editItemButton);
                itemActionsCell.appendChild(deleteItemButton);

                tabelaOrcamento.appendChild(itemRow);
            });

            // NOVO: Cria uma linha separada para o botão "Adicionar Item"
            const addButtonItemRow = document.createElement('tr');
            addButtonItemRow.className = `componente-row componente-row-${produto.id} hidden-row`; // Também começa escondida
            addButtonItemRow.innerHTML = `
                <td colspan="13" style="text-align: center; padding: 10px; background-color: #f5f1e8;">
                    <button class="btn btn-success btn-sm btn-add-item-to-produto" data-produto-id="${produto.id}">➕ Adicionar Item a ${produto.nome}</button>
                </td>
            `;
            tabelaOrcamento.appendChild(addButtonItemRow);

        });

        // Renderizar Itens Avulsos
        if(orcamento.itens && orcamento.itens.length > 0) {
            
            const indicadoresAvulsos = somarIndicadoresDosItens(orcamento.itens, percentualComissao);
            const totalItensAvulsos = indicadoresAvulsos.precoTotal;
            const margemTotalAvulsos = indicadoresAvulsos.margem;
            const margemPercentualAvulsos = indicadoresAvulsos.margemPercentual;

            // LINHA DE RESUMO (avulsoSummaryRow)
            const avulsoSummaryRow = document.createElement('tr');
            avulsoSummaryRow.className = 'produto-acabado-row'; 
            // NOVA ABORDAGEM: O ID 'avulsos' é armazenado em um data-attribute.
            avulsoSummaryRow.dataset.produtoId = 'avulsos';
            
            avulsoSummaryRow.innerHTML = `
                <td>
                    <strong>Itens Avulsos (${(orcamento.itens || []).length} itens)</strong> 
                    <span id="icon-avulsos">▶</span> 
                </td>
                <td>Diversos</td> 
                <td colspan="8" style="font-weight:normal; font-style:italic; color: #4A4A4A;">Itens que não fazem parte de um produto acabado.</td> 
                <td><strong>${formatarMoeda(totalItensAvulsos)}</strong></td>
                <td>
                    <strong>${formatarMoeda(margemTotalAvulsos)}</strong>
                    <br>
                    <small>(${truncarDecimal(margemPercentualAvulsos, 2)}%)</small> 
                </td>
                <td style="text-align: center;"></td>
            `;
            // CORREÇÃO: Adicionar botão e listener dinamicamente
            const avulsoActionsCell = avulsoSummaryRow.querySelector('td:last-child');
            // A exclusão de grupo de itens avulsos pode ser feita pelo botão "Limpar Itens"
            // Para manter a consistência, vamos remover este botão específico por enquanto.
            // const deleteGroupButton = createButton('Excluir Grupo', 'btn-danger', (e) => { e.stopPropagation(); removerGrupoItensAvulsos(); });
            // avulsoActionsCell.appendChild(deleteGroupButton);

            tabelaOrcamento.appendChild(avulsoSummaryRow);


            // LINHAS DE DETALHE (Itens Avulsos Detalhados)
            orcamento.itens.forEach(item => {
                const itemRow = document.createElement('tr');
                
                // Garante que a linha comece colapsada (hidden-row) e use a classe correta
                itemRow.className = `componente-row componente-row-avulsos hidden-row`; // Itens começam escondidos

                let larguraDisplay = item.largura !== null && item.largura !== undefined ? item.largura.toFixed(2) : '-';
                let alturaDisplay = item.altura !== null && item.altura !== undefined ? item.altura.toFixed(2) : '-';

                // CORREÇÃO: Para Metro Linear, a "largura" salva é na verdade a altura padrão.
                // Vamos exibi-la na coluna de altura.
                // A lógica de salvamento foi corrigida para que `item.altura` contenha a altura padrão.
                if (normalizarUnidadeMedida(item.unidadeMedida) === 'MetroLinear') {
                    // Agora lemos diretamente de item.altura, que contém o valor correto.
                    alturaDisplay = item.altura ? item.altura.toFixed(2) : '-';
                    larguraDisplay = '-'; // A coluna Largura fica vazia
                }
                const indicadoresItem = calcularIndicadoresDoItem(item, percentualComissao);

                itemRow.innerHTML = `
                    <td colspan="2" style="padding-left: 40px;">↳ ${item.categoria || 'Avulso'}</td>
                    <td>${item.fornecedor || '-'}</td>
                    <td>${item.codigo || ''}</td>
                    <td>${item.descricao || ''}</td>
                    <td>${item.cor || '-'}</td>
                    <td>${item.quantidade || 0}</td>
                    <td>${larguraDisplay}</td>
                    <td>${alturaDisplay}</td>
                    <td>${formatarMoeda(item.precoUnitario || 0)}</td>
                    <td>${formatarMoeda(item.precoTotal || 0)}</td>
                    <td style="color: ${indicadoresItem.margemPercentual >= 30 ? '#6B8E6B' : indicadoresItem.margemPercentual >= 15 ? '#C89F8F' : '#A65555'}; font-weight: bold;">
                        ${formatarMoeda(indicadoresItem.margem)}<br>
                        <small>(${indicadoresItem.margemPercentual.toFixed(1)}%)</small>
                    </td>
                    <td style="text-align: center;"></td>
                `;
                // CORREÇÃO: Adicionar botões e seus listeners dinamicamente
                const avulsoItemActionsCell = itemRow.querySelector('td:last-child');
                const editAvulsoButton = createButton('Editar', 'btn-warning btn-item-action');
                editAvulsoButton.dataset.produtoId = 'null'; // Indica que não pertence a um produto
                editAvulsoButton.dataset.itemId = item.id;
                editAvulsoButton.dataset.action = 'edit';
                const deleteAvulsoButton = createButton('Excluir', 'btn-danger btn-item-action');
                deleteAvulsoButton.dataset.produtoId = 'null';
                deleteAvulsoButton.dataset.itemId = item.id;
                deleteAvulsoButton.dataset.action = 'delete';
                avulsoItemActionsCell.appendChild(editAvulsoButton);
                avulsoItemActionsCell.appendChild(deleteAvulsoButton);
                tabelaOrcamento.appendChild(itemRow);
            });
        }

        // Se houver apenas um produto acabado, expande-o por padrão
        if (orcamento.produtosAcabados && orcamento.produtosAcabados.length === 1 && (!orcamento.itens || orcamento.itens.length === 0)) {
            const primeiroProdutoId = orcamento.produtosAcabados[0].id;
            toggleItensVisibilidade(primeiroProdutoId);
        }

        // --- Lógica de Resumo e Totais (permanece a mesma) ---
        const todosOsItens = [...(orcamento.itens || []), ...(orcamento.produtosAcabados || []).flatMap(p => p.itens || [])];
        
        if (todosOsItens.length === 0) {
            resumoAmbientesDiv.innerHTML = '<p style="text-align: center; color: #777;">Nenhum item no orçamento para exibir o resumo.</p>';
            return;
        }

        // Fonte única dos totais; o cache `orcamento.totais` não é mais lido nem atualizado.
        const totais = calcularTotaisOrcamento(orcamento);

        const itensPorAmbiente = {};
        todosOsItens.forEach(item => {
            const ambiente = item.ambiente || 'Itens Avulsos';
            if (!itensPorAmbiente[ambiente]) itensPorAmbiente[ambiente] = [];
            itensPorAmbiente[ambiente].push(item);
        });

        for (const ambiente in itensPorAmbiente) {
            const indicadoresAmbiente = somarIndicadoresDosItens(itensPorAmbiente[ambiente], percentualComissao);
            const subtotalProdutos = indicadoresAmbiente.precoTotal;
            // CORREÇÃO: Garante que orcamento.valoresInstalacao exista antes de acessá-lo.
            const valorInstalacao = orcamento.valoresInstalacao?.[ambiente] || 0;
            const totalAmbiente = subtotalProdutos + valorInstalacao;

            const resumoCard = document.createElement('div');
            resumoCard.classList.add('summary-card');

            const margemPorcentagemAmbiente = indicadoresAmbiente.margemPercentual;
            resumoCard.innerHTML = `
                <h3>
                    <span>${ambiente}</span> 
                    <span class="price-display">${formatarMoeda(totalAmbiente)}</span>
                </h3>
                <div class="management-item">
                    <span>Total Produtos:</span>
                    <span style="font-weight: normal;">${formatarMoeda(subtotalProdutos)}</span>
                </div>
                <div class="management-item" style="background: linear-gradient(135deg, #E8F5E9 0%, #C8E6C9 100%); padding: 12px; border-radius: 8px; margin-top: 8px;">
                    <span style="font-weight: bold; color: #2E7D32;">💰 Margem do Ambiente:</span>
                    <span style="font-weight: bold; color: #2E7D32; font-size: 1.1em;">
                        ${formatarMoeda(indicadoresAmbiente.margem)}
                        <small style="font-size: 0.9em;">(${truncarDecimal(margemPorcentagemAmbiente, 2)}%)</small>
                    </span>
                </div>
                <div class="management-item" style="border-top: 1px solid #ccc; padding-top: 10px; margin-top: 10px;">
                    <label for="instalacao-${ambiente.replace(/\s/g, '_')}" style="font-weight: bold; color: #A65555;">Valor da Instalação (R$):</label> 
                    <input 
                        type="text" 
                        id="instalacao-${ambiente.replace(/\s/g, '_')}" 
                        class="input-instalacao"
                        data-ambiente="${ambiente}"
                        placeholder="0,00" 
                        value="${(valorInstalacao > 0 ? formatarMoeda(valorInstalacao) : '0,00').replace('R$', '').trim()}" 
                        onfocus="this.select()" 
                        style="text-align: right; font-weight: bold; width: 120px; padding: 5px; color: #A65555;">
                </div>
            `;
            resumoAmbientesDiv.appendChild(resumoCard);
        }
        
        const totaisGeraisDiv = document.createElement('div');
        totaisGeraisDiv.classList.add('summary-card');
        totaisGeraisDiv.style.border = '2px solid #D4AF37';

        totaisGeraisDiv.innerHTML = `
            <h3 style="font-size: 1.5em;">Resumo Geral do Orçamento</h3>
            <div class="management-item">
                <span>Total de Produtos:</span>
                <span style="font-weight: bold;">${formatarMoeda(totais.subtotalProdutos)}</span>
            </div>
            <div class="management-item">
                <span>Total de Instalação:</span>
                <span style="font-weight: bold; color: #A65555;">${formatarMoeda(totais.totalInstalacao)}</span>
            </div>
            ${criarResumoInternoComissao(orcamento, totais)}
            <div class="management-item" style="font-size: 1.2em; border-top: 2px solid #D4AF37; margin-top: 10px; padding-top: 10px;">
                <strong>TOTAL GERAL:</strong>
                <strong class="price-display">${formatarMoeda(totais.subtotalProdutos + totais.totalInstalacao)}</strong>
            </div>
        `;
        resumoAmbientesDiv.appendChild(totaisGeraisDiv);
    }

    function formatarPercentualComissao(percentual) {
        return Number(percentual || 0).toFixed(2).replace('.', ',');
    }

    function descreverAvisoComissao(aviso) {
        if (aviso.codigo === 'percentual-comissao-invalido') {
            return `O percentual de comissão gravado é inválido; foi usado ${formatarPercentualComissao(aviso.percentualUsado)}% pela regra antiga.`;
        }
        if (aviso.codigo === 'residuo-comissao-anormal') {
            return `A soma dos preços não fecha com a comissão calculada (diferença de ${formatarMoeda(aviso.residuo)}). Revise os itens; nenhum valor foi alterado automaticamente.`;
        }
        return '';
    }

    function criarResumoInternoComissao(orcamento, totais) {
        // Somente na aba Lançamento, que não é impressa. A proposta ao cliente nunca recebe estes valores.
        const origemPercentual = totais.percentualComissaoGravado || totais.percentualComissao === 0
            ? ''
            : '<small>Percentual herdado do tipo de cliente antigo (Arquiteto); será gravado se for alterado ou ao confirmar o pedido.</small>';
        const avisos = totais.avisos
            .map(descreverAvisoComissao)
            .filter(Boolean)
            .map(texto => `<p class="resumo-interno-aviso" role="status">${escaparHtml(texto)}</p>`)
            .join('');

        return `
            <section id="resumoInternoComissao" class="resumo-interno" aria-labelledby="tituloResumoInternoComissao">
                <h4 id="tituloResumoInternoComissao">🔒 Informações internas <small>Não aparecem na proposta nem na impressão.</small></h4>
                <div class="management-item"><span>Comissão:</span><span data-interno="percentual">${formatarPercentualComissao(totais.percentualComissao)}%</span></div>
                ${origemPercentual}
                <div class="management-item"><span>Produtos sem comissão:</span><span data-interno="subtotal-sem-comissao">${formatarMoeda(totais.subtotalSemComissao)}</span></div>
                <div class="management-item"><span>Desconto sobre a base (${escaparHtml(totais.descontoPercentual)}%):</span><span data-interno="desconto-base">- ${formatarMoeda(totais.descontoBase)}</span></div>
                <div class="management-item"><span>Base líquida da comissão:</span><span data-interno="base-liquida">${formatarMoeda(totais.centavos.baseLiquida / 100)}</span></div>
                <div class="management-item"><span>Valor da comissão:</span><span data-interno="valor-comissao">${formatarMoeda(totais.valorComissao)}</span></div>
                <div class="management-item"><span>Produtos cobrados do cliente (com desconto):</span><span data-interno="produtos-cobrados">${formatarMoeda(totais.totalProdutos)}</span></div>
                <div class="management-item resumo-interno-destaque"><span>Líquido Filippini:</span><span data-interno="liquido-filippini">${formatarMoeda(totais.liquidoFilippini)}</span></div>
                <div class="management-item"><span>Margem antes do desconto:</span><span data-interno="margem-antes">${formatarMoeda(totais.margemProdutos)} (${truncarDecimal(totais.margemProdutosPercentual, 2)}%)</span></div>
                <div class="management-item resumo-interno-destaque"><span>💎 Margem após o desconto:</span><span data-interno="margem-depois">${formatarMoeda(totais.margemComDesconto)} (${truncarDecimal(totais.margemPercentual, 2)}% do líquido)</span></div>
                ${avisos}
            </section>
        `;
    }

    function atualizarAvisoComissao(orcamento = obterOrcamentoAtual()) {
        // Aviso discreto: percentual sem nome do comissionado não bloqueia nenhuma ação.
        const percentual = orcamento ? obterPercentualComissao(orcamento) : 0;
        const nome = document.getElementById('nomeComissionado').value.trim();
        document.getElementById('ajudaComissao').textContent = percentual > 0 && !nome
            ? 'Venda com comissão sem nome do arquiteto / comissionado. Informe o nome para identificar quem recebe.'
            : '';
    }

    function atualizarCamposComissao(orcamento = obterOrcamentoAtual()) {
        // A tela sempre reflete o percentual efetivo do documento; o checkbox não é gravado.
        const percentual = orcamento ? obterPercentualComissao(orcamento) : 0;
        document.getElementById('vendaComComissao').checked = percentual > 0;
        document.getElementById('percentualComissao').value = formatarPercentualComissao(percentual);
        atualizarAvisoComissao(orcamento);
    }

    async function alterarComissaoPelaTela(novoPercentual) {
        const id = orcamentoAtualId;
        const orcamento = obterOrcamentoAtual();
        if (!orcamento) return false;
        if (!garantirOrcamentoEditavel('alterar a comissão')) {
            atualizarCamposComissao(orcamento);
            return false;
        }

        // Mesmo percentual efetivo: nada muda e documentos antigos não ganham o campo.
        if (novoPercentual === obterPercentualComissao(orcamento)) {
            atualizarCamposComissao(orcamento);
            return true;
        }

        const possuiItens = calcularTotaisOrcamento(orcamento).quantidadeItens > 0;
        if (possuiItens && !confirm('Alterar o percentual recalculará os preços dos itens deste orçamento. Deseja continuar?')) {
            // Cancelado: o documento não foi tocado; apenas a tela volta ao valor gravado.
            atualizarCamposComissao(orcamento);
            return false;
        }

        let atualizado;
        try {
            atualizado = alterarPercentualComissao(orcamento, novoPercentual);
        } catch (error) {
            mostrarNotificacao(error.message);
            atualizarCamposComissao(orcamento);
            return false;
        }

        orcamentosSalvos[id] = atualizado;
        const salvou = await salvarOrcamentoAtual(id);
        if (!salvou) return false;
        if (id === orcamentoAtualId) preencherInfoOrcamento();
        mostrarNotificacao(possuiItens
            ? `Comissão alterada para ${formatarPercentualComissao(novoPercentual)}%. Os preços dos itens foram recalculados.`
            : `Comissão definida em ${formatarPercentualComissao(novoPercentual)}%.`, 'sucesso');
        return true;
    }

    async function atualizarValorInstalacao(ambiente, inputElement) {
        if (!garantirOrcamentoEditavel('alterar o valor de instalação')) {
            preencherInfoOrcamento();
            return;
        }
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (!orcamento) return;
        
        // Converte o valor do input para um número, tratando vírgulas e pontos
        const valorString = inputElement.value.replace('R$', '').trim().replace(/\./g, '').replace(',', '.');
        const valor = parseFloat(valorString) || 0;
        
        if (!orcamento.valoresInstalacao) {
            orcamento.valoresInstalacao = {};
        }
        orcamento.valoresInstalacao[ambiente] = valor;
        
        // Reformata o valor no input para o formato de moeda
        inputElement.value = formatarMoeda(valor).replace('R$', '').trim();
        
        // Salva o orçamento atualizado no Firestore
        await salvarOrcamentoAtual();
    }

    // --- FIM: FUNÇÕES DA ABA DE ORÇAMENTO ---

    // --- INÍCIO: FUNÇÕES DO NOVO FLUXO DE ADIÇÃO DE ITEM ---



    async function adicionarItemAoOrcamento() {
        if (!garantirOrcamentoEditavel('adicionar itens')) return;
        const produtoAcabadoId = document.getElementById('addProdutoAcabadoId').value;
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        const codigo = document.getElementById('codigoOrcamento').value.trim().toUpperCase();
        const produtoBase = precos.find(p => p.codigo === codigo);

        if (!produtoBase || produtoBase.status !== 'Ativo') {
            mostrarNotificacao("O produto com o código inserido não foi encontrado ou está inativo.");
            return;
        }

        const quantidade = parseFloat(document.getElementById('quantidade').value);
        const largura = parseFloat(document.getElementById('largura').value) || 0;
        const altura = parseFloat(document.getElementById('altura').value) || 0;

        const erroValidacao = validarParametrosItem(produtoBase, quantidade, largura, altura);
        if (erroValidacao) {
            mostrarNotificacao(erroValidacao);
            return;
        }

        // NOVA ABORDAGEM: Usa a função centralizada para obter todos os valores,
        // com o percentual de comissão do próprio orçamento.
        const detalhesCalculados = calcularDetalhesItem(
            produtoBase,
            quantidade,
            largura,
            altura, // Para Metro Linear, a altura é a largura do material
            obterPercentualComissao(orcamento)
        );

        const novoItem = {
            id: `item-${crypto.randomUUID()}`,
            ambiente: document.getElementById('ambiente').value.trim(),
            categoria: produtoBase.categoria || 'Não Especificada',
            codigo,
            descricao: produtoBase.descricao,
            cor: produtoBase.cor || '-',
            fornecedor: produtoBase.fornecedor || 'Não Informado',
            quantidade: quantidade, // A quantidade de peças/metros
            
            // CORREÇÃO DEFINITIVA: Garante que a largura e altura sejam salvas corretamente para cada tipo.
            // Para MetroQuadrado, salva largura e altura.
            // Para MetroLinear, salva a alturaPadrão (largura do material) no campo 'altura'.
            // Para Unidade, ambos são null.
            largura: detalhesCalculados.larguraSalva,
            altura: detalhesCalculados.alturaSalva,
            unidadeMedida: produtoBase.unidadeMedida,
            // Valores sem comissão (base) e com a comissão embutida; comissão e margem são derivadas.
            precoUnitarioBase: detalhesCalculados.precoUnitarioBase,
            precoTotalSemComissao: detalhesCalculados.precoTotalSemComissao,
            precoUnitario: detalhesCalculados.precoUnitario,
            precoTotal: detalhesCalculados.precoTotal,
            custoReal: detalhesCalculados.custoReal,
            quantidadeCompra: detalhesCalculados.quantidadeCompra,
            precoCompraUnitario: produtoBase.precoCompra,
            observacoes: document.getElementById('observacoesItem').value.trim()
        };

        // PONTO DE DEPURAÇÃO 1: O que está sendo criado?
        console.log("DEBUG: Objeto 'novoItem' antes de salvar:", JSON.stringify(novoItem, null, 2));

        // Adiciona o item ao produto acabado ou como avulso
        if (produtoAcabadoId) {
            const produtoAcabado = orcamento.produtosAcabados.find(p => p.id === produtoAcabadoId);
            if (produtoAcabado) {
                produtoAcabado.itens.push(novoItem);
            }
        } else {
            if (!orcamento.itens) orcamento.itens = [];
            orcamento.itens.push(novoItem);
        }

        const salvou = await salvarOrcamentoAtual();
        if (!salvou) return;
        fecharModalAdicionarItem(); // Fecha o modal e limpa o formulário
        mostrarNotificacao("Item adicionado ao orçamento com sucesso!", 'sucesso');
        // A UI será atualizada pelo listener
    }

    // Função para limpar o formulário de adição de item (agora dentro do modal)
    function limparFormularioItem() {
        document.getElementById('ambiente').value = '';
        document.getElementById('categoriaItemOrcamento').value = '';
        document.getElementById('corItemOrcamento').value = '';
        document.getElementById('codigoOrcamento').value = '';
        document.getElementById('quantidade').value = '1';
        document.getElementById('largura').value = '';
        document.getElementById('altura').value = '';
        document.getElementById('observacoesItem').value = '';
        document.getElementById('previewCalculo').style.display = 'none';
        document.getElementById('addProdutoAcabadoId').value = ''; // Limpa o ID do produto
    }

    function abrirModalAdicionarItem(produtoAcabadoId) {
        const modal = document.getElementById('modalAdicionarItem');
        const tituloModal = document.getElementById('modalAdicionarItemTitle');
        const inputAmbiente = document.getElementById('ambiente');
        const orcamento = orcamentosSalvos[orcamentoAtualId];

        if (produtoAcabadoId) {
            const produto = orcamento.produtosAcabados.find(p => p.id === produtoAcabadoId);
            if (produto) {
                tituloModal.textContent = `Adicionar Item a: ${produto.nome}`;
                inputAmbiente.value = produto.ambiente;
                inputAmbiente.readOnly = true;
                document.getElementById('addProdutoAcabadoId').value = produtoAcabadoId;
            }
        } else {
            tituloModal.textContent = 'Adicionar Item Avulso';
            inputAmbiente.value = ''; // Permite digitar
            inputAmbiente.readOnly = false;
            document.getElementById('addProdutoAcabadoId').value = ''; // Garante que está vazio
        }

        abrirModal(modal.id);
    }

    function fecharModalAdicionarItem() {
        fecharModal('modalAdicionarItem');
        limparFormularioItem(); // Limpa o formulário ao fechar
    }

    // --- FIM: FUNÇÕES DO NOVO FLUXO ---

    async function atualizarInfoComercial(campo, valor) {
        if (!garantirOrcamentoEditavel('alterar as condições comerciais')) {
            preencherInfoOrcamento();
            return;
        }
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (orcamento) {
            if (!orcamento.infoComercial) orcamento.infoComercial = {};
            orcamento.infoComercial[campo] = valor;
            await salvarOrcamentoAtual();
            atualizarPropostaCliente();
        }
    }
    // CORREÇÃO: A função estava duplicada, removendo a duplicata.
    /* async function atualizarInfoComercial(campo, valor) {
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (orcamento) {
            if (!orcamento.infoComercial) orcamento.infoComercial = {};
            orcamento.infoComercial[campo] = valor;
            await salvarOrcamentoAtual();
            atualizarPropostaCliente();
        }
    } */
    async function removerProdutoAcabado(produtoId) {
        if (!garantirOrcamentoEditavel('excluir produtos acabados')) return;
        if (!confirm("Tem certeza que deseja excluir este produto acabado e todos os seus itens?")) return;
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        orcamento.produtosAcabados = orcamento.produtosAcabados.filter(p => p.id !== produtoId);
        await salvarOrcamentoAtual();
        // A UI será atualizada pelo listener
    }

    async function removerItem(produtoId, itemId) {
        if (!garantirOrcamentoEditavel('excluir itens')) return;
        if (!confirm("Tem certeza que deseja excluir este item?")) return;
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        
        if (produtoId) { // Item de um produto acabado
            const produto = orcamento.produtosAcabados.find(p => p.id === produtoId);
            if (produto) {
                produto.itens = produto.itens.filter(i => i.id !== itemId);
            }
        } else { // Item avulso
            orcamento.itens = orcamento.itens.filter(i => i.id !== itemId);
        }

        await salvarOrcamentoAtual();
        // A UI será atualizada pelo listener
    }

    async function limparOrcamento() {
        if (!garantirOrcamentoEditavel('limpar o orçamento')) return;
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (confirm("Tem certeza que deseja limpar todos os itens e produtos deste orçamento?")) {
            orcamento.itens = [];
            orcamento.produtosAcabados = [];
            await salvarOrcamentoAtual();
            // A UI será atualizada pelo listener
        }
    }

    async function criarProdutoAcabado() {
        if (!garantirOrcamentoEditavel('criar produtos acabados')) return;
        const nome = document.getElementById('nomeProdutoAcabado').value.trim();
        const ambiente = document.getElementById('ambienteProdutoAcabado').value.trim();
        const observacoes = document.getElementById('observacoesProdutoAcabado').value.trim();
        const observacoesCliente = document.getElementById('observacoesClienteProdutoAcabado').value.trim();

        if (!nome || !ambiente) {
            mostrarNotificacao("O Nome e o Ambiente do produto acabado são obrigatórios.");
            return;
        }

        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (!orcamento) return;
        
        const novoProduto = {
            id: `prod-${crypto.randomUUID()}`,
            nome: nome,
            ambiente: ambiente,
            observacoes: observacoes,
            observacoesCliente: observacoesCliente,
            itens: []
        };

        if (!orcamento.produtosAcabados) {
            orcamento.produtosAcabados = [];
        }
        orcamento.produtosAcabados.push(novoProduto);
        const salvou = await salvarOrcamentoAtual();
        if (!salvou) return;
        
        // Limpar campos (a UI será atualizada pelo listener)
        document.getElementById('nomeProdutoAcabado').value = '';
        document.getElementById('ambienteProdutoAcabado').value = '';
        document.getElementById('observacoesProdutoAcabado').value = '';
        document.getElementById('observacoesClienteProdutoAcabado').value = '';
    }

    function abrirModalEdicaoProdutoAcabado(produtoAcabadoId) {
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (!orcamento || !orcamento.produtosAcabados) return;

        const produtoAcabado = orcamento.produtosAcabados.find(p => p.id === produtoAcabadoId);

        if (produtoAcabado) {
            document.getElementById('edicaoProdutoAcabadoId').value = produtoAcabado.id;
            document.getElementById('edicaoNome').value = produtoAcabado.nome;
            document.getElementById('edicaoAmbiente').value = produtoAcabado.ambiente;
            document.getElementById('edicaoObservacoes').value = produtoAcabado.observacoes || '';
            document.getElementById('edicaoObservacoesCliente').value = produtoAcabado.observacoesCliente || '';
            abrirModal('modalEdicaoProdutoAcabado');
        } else {
            mostrarNotificacao("Produto Acabado não encontrado para edição.");
        }
    }

    async function salvarEdicaoProdutoAcabado() {
        if (!garantirOrcamentoEditavel('editar produtos acabados')) return;
        const id = document.getElementById('edicaoProdutoAcabadoId').value;
        const novoNome = document.getElementById('edicaoNome').value.trim();
        const novoAmbiente = document.getElementById('edicaoAmbiente').value.trim();
        const novaObservacoes = document.getElementById('edicaoObservacoes').value.trim();
        const novaObservacoesCliente = document.getElementById('edicaoObservacoesCliente').value.trim();

        if (!novoNome || !novoAmbiente) {
            mostrarNotificacao("Por favor, preencha o nome e o ambiente.");
            return;
        }

        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (!orcamento || !orcamento.produtosAcabados) return;

        const produtoAcabado = orcamento.produtosAcabados.find(p => p.id === id);

        if (produtoAcabado) {
            const ambienteAnterior = produtoAcabado.ambiente;
            
            produtoAcabado.nome = novoNome;
            produtoAcabado.ambiente = novoAmbiente;
            produtoAcabado.observacoes = novaObservacoes; 
            produtoAcabado.observacoesCliente = novaObservacoesCliente;
                           
            // Atualiza o ambiente de todos os sub-itens para manter a consistência
            produtoAcabado.itens.forEach(item => {
                if (item.ambiente === ambienteAnterior) {
                    item.ambiente = novoAmbiente;
                }
            });
            
            const salvou = await salvarOrcamentoAtual();
            if (!salvou) return;
            fecharModal('modalEdicaoProdutoAcabado');
        }
    }

    async function atualizarConfiguracaoProposta() {
        const orcamento = obterOrcamentoAtual();
        if (!orcamento) return;

        orcamento.apresentacao = {
            ...(orcamento.apresentacao || {}),
            modo: document.getElementById('modoProposta').value,
            mostrarValoresItens: document.getElementById('mostrarValoresItens').checked,
            mostrarCustosFornecedor: document.getElementById('mostrarCustosFornecedor').checked
        };

        atualizarEstadoControlesProposta();
        await salvarOrcamentoAtual();
        atualizarPropostaCliente();
    }

    function atualizarEstadoControlesProposta() {
        const modoDetalhado = document.getElementById('modoProposta').value === 'detalhada';
        const mostrarValores = document.getElementById('mostrarValoresItens');
        mostrarValores.disabled = !modoDetalhado;
        mostrarValores.title = modoDetalhado
            ? ''
            : 'A exibição de valores por item está disponível apenas na proposta detalhada.';
    }

    function atualizarPropostaCliente() {
        // Obter os estados dos controles no início da função.
        const modoProposta = document.getElementById('modoProposta').value === 'detalhada' ? 'detalhada' : 'reduzida';
        const mostrarValoresItens = document.getElementById('mostrarValoresItens').checked;
        const mostrarDetalhamentoCompleto = modoProposta === 'detalhada';

        const orcamentoFinalDiv = document.getElementById('orcamentoFinal');
        const orcamento = orcamentosSalvos[orcamentoAtualId];

        if (!orcamento || (!orcamento.itens || orcamento.itens.length === 0) && (!orcamento.produtosAcabados || orcamento.produtosAcabados.length === 0)) {
            orcamentoFinalDiv.innerHTML = '<p style="text-align: center; color: #777;">Adicione itens ao orçamento para visualizar a proposta.</p>';
            return;
        }

        // Fonte única dos totais. A aba Proposta é inteiramente voltada ao cliente, na tela e na impressão:
        // só usa valores cobrados (com a comissão já embutida nas linhas). Comissão, margem, custo, base e
        // líquido Filippini ficam no resumo interno da aba Lançamento.
        const totais = calcularTotaisOrcamento(orcamento);
        const subtotal = totais.subtotalProdutos;
        const totalInstalacaoGeral = totais.totalInstalacao;
        const descontoValor = totais.descontoValor;
        const totalComDesconto = totais.totalProdutos;
        const totalProdutoAcabado = produto => somarIndicadoresDosItens(produto.itens, totais.percentualComissao).precoTotal;

        // LÓGICA DE GERAÇÃO DE HTML RESTAURADA
        const todosOsItens = [...(orcamento.itens || []), ...(orcamento.produtosAcabados || []).flatMap(p => p.itens || [])];

        let html = `
            <div class="proposta-wrapper proposta-${modoProposta}">
                <div class="proposta-header">
                    <div class="logo">
                        <img src="WhatsApp Image 2025-09-17 at 16.56.26.jpeg" alt="Logo Marcello Machado">
                    </div>
                    <div class="company-details">
                        <p><strong>Marcello Machado</strong></p>
                        <p>Celular: (11) 97389-3387</p>
                        <p>WhatsApp: <a href="https://wa.me/5511973893387">Clique para iniciar a conversa</a></p>
                        <p>Email: marcello66machado@gmail.com</p>
                        <p><a href="https://www.facebook.com/filippinicortinas?locale=pt_BR">Facebook</a></p>
                        <p><a href="https://www.instagram.com/filippinicortinas/">Instagram</a></p>
                    </div>
                </div>

                <div class="proposta-info-grid">
                    <div><strong>ID da Proposta:</strong><p>${escaparHtml(orcamentoAtualId)}</p></div>
                    <div><strong>Cliente:</strong><p>${escaparHtml(orcamento.infoGerais?.nomeCliente || 'Não informado')}</p></div>
                    <div><strong>Endereço:</strong><p>${escaparHtml(orcamento.infoGerais?.enderecoCliente || 'Não informado')}</p></div>
                    <div><strong>Data do Orçamento:</strong><p>${escaparHtml(formatarData(orcamento.infoGerais?.dataOrcamento))}</p></div>
                    <div><strong>Validade do Orçamento:</strong><p>${escaparHtml(formatarData(orcamento.infoGerais?.prazoValidade))}</p></div>
                </div>
        `;
        
        html += `<h3 class="proposta-ambiente-title">Resumo dos Produtos</h3>`;
        html += `<table class="proposta-ambiente-table">
                    <thead><tr><th>Produto</th><th style="text-align: right;">Valor Total</th></tr></thead><tbody>`;
        
        (orcamento.produtosAcabados || []).forEach(produto => {
            html += `<tr><td><strong>${escaparHtml(produto.nome)} (${escaparHtml(produto.ambiente)})</strong>${produto.observacoesCliente ? `<span class="proposta-observacao-produto">${escaparHtml(produto.observacoesCliente)}</span>` : ''}</td><td class="item-value">${formatarMoeda(totalProdutoAcabado(produto))}</td></tr>`;
        });

        if (orcamento.itens && orcamento.itens.length > 0) {
             const totalAvulsos = somarIndicadoresDosItens(orcamento.itens, totais.percentualComissao).precoTotal;
             html += `<tr><td>Itens Avulsos</td><td class="item-value">${formatarMoeda(totalAvulsos)}</td></tr>`;
        }

        html += `</tbody></table>`;

        const totalFinalGeral = totais.totalGeral;

        html += `
            <div class="proposta-summary">
                <div class="summary-line"><span>Subtotal Geral (Produtos sem desconto):</span><span>${formatarMoeda(subtotal)}</span></div>`;
        if (descontoValor > 0) {
            html += `<div class="summary-line"><span>Desconto (${escaparHtml(totais.descontoPercentual)}%):</span><span>- ${formatarMoeda(descontoValor)}</span></div>`;
        }
        html += `
                <div class="summary-line" style="border-top: 2px solid #333; padding-top: 10px; font-size: 1.1em; font-weight: bold;">
                    <span>TOTAL DE PRODUTOS (Pago à Filippini):</span><span class="price-display">${formatarMoeda(totalComDesconto)}</span>
                </div>
                <div class="summary-line" style="border-top: 1px dashed #ccc; margin-top: 10px; padding-top: 10px;">
                    <span><strong>TOTAL GERAL DE INSTALAÇÃO:</strong></span><span style="font-size: 1.2em; font-weight: bold; color: #d32f2f;">${formatarMoeda(totalInstalacaoGeral)}</span>
                </div>
                <div class="summary-line" style="font-size: 0.8em; color: #666; padding-bottom: 20px; border-bottom: 2px solid #ccc; line-height: 1.3;">
                    <span colspan="2" style="font-style: italic;">O valor de instalação é pago diretamente ao instalador no momento da instalação. A Filippini Cortinas não fica com nenhum % deste valor em respeito aos nossos profissionais de instalação. </span>
                </div>
                <div class="total-final-box" style="margin-top: 20px;">
                    <strong>VALOR TOTAL GERAL DA PROPOSTA:</strong><span>${formatarMoeda(totalFinalGeral)}</span>
                </div>
            </div>`;

        if (mostrarDetalhamentoCompleto) {
            html += `<h3 class="proposta-ambiente-title" style="margin-top: 40px;">Detalhamento dos Itens</h3>`;
            
            (orcamento.produtosAcabados || []).forEach(produto => {
                html += `
                    <h4 style="color: #333; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px;">${escaparHtml(produto.nome)} (${escaparHtml(produto.ambiente)})</h4>
                    <table class="proposta-ambiente-table proposta-detalhes-table">
                        <thead>
                            <tr>
                                <th style="width: 20%;">Componente</th>
                                <th style="width: 30%;">Descrição</th>
                                <th style="width: 10%;">Cor</th> <th style="width: 10%;">U.M.</th>
                                <th style="width: 10%; text-align: center;">Qtd</th>
                                <th style="width: 20%; text-align: right;">${mostrarValoresItens ? 'Total' : ''}</th>
                            </tr>
                        </thead>
                        <tbody>`;
                produto.itens.forEach(item => {
                    html += `<tr>
                                <td>${escaparHtml(item.codigo || item.item || '')}</td>
                                <td class="item-description">${escaparHtml(item.descricao)} ${item.observacoes ? ` - Obs: ${escaparHtml(item.observacoes)}` : ''}</td>
                                <td>${escaparHtml((item.cor === 'Não Informada' ? '-' : item.cor) || '-')}</td>
                                <td>${escaparHtml(item.unidadeMedida || '')}</td>
                                <td style="text-align: center;">${escaparHtml(item.quantidade || 0)}</td>
                                ${mostrarValoresItens ? `<td class="item-value">${formatarMoeda(item.precoTotal)}</td>` : '<td class="item-value"></td>'}
                            </tr>`;
                });
                html += `</tbody></table>
                    ${mostrarValoresItens ? `<div class="proposta-subtotal">Subtotal do Produto: ${formatarMoeda(totalProdutoAcabado(produto))}</div>` : ''}`;
            });
            
            if(orcamento.itens && orcamento.itens.length > 0) {
                 html += `<h4 style="color: #333; margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 5px;">Itens Avulsos</h4>
                     <table class="proposta-ambiente-table proposta-detalhes-table">
                        <thead>
                            <tr>
                                <th style="width: 20%;">Componente</th>
                                <th style="width: 30%;">Descrição</th>
                                <th style="width: 10%;">Cor</th> <th style="width: 10%;">U.M.</th>
                                <th style="width: 10%; text-align: center;">Qtd</th>
                                <th style="width: 20%; text-align: right;">${mostrarValoresItens ? 'Total' : ''}</th>
                            </tr>
                        </thead>
                        <tbody>`;
                orcamento.itens.forEach(item => {
                    html += `<tr>
                                <td>${escaparHtml(item.codigo || item.item || '')}</td>
                                <td class="item-description">${escaparHtml(item.descricao)} ${item.observacoes ? ` - Obs: ${escaparHtml(item.observacoes)}` : ''}</td>
                                <td>${escaparHtml((item.cor === 'Não Informada' ? '-' : item.cor) || '-')}</td>
                                <td>${escaparHtml(item.unidadeMedida || '')}</td>
                                <td style="text-align: center;">${escaparHtml(item.quantidade || 0)}</td>
                                ${mostrarValoresItens ? `<td class="item-value">${formatarMoeda(item.precoTotal)}</td>` : '<td class="item-value"></td>'}
                            </tr>`;
                });
                 html += `</tbody></table>`;
            }
        }

        const condComerciais = orcamento.infoComercial || {};
        html += `
            <div class="proposta-footer">
                <h4>Condições Comerciais</h4>
                <p><strong>Condição de Pagamento:</strong> ${escaparHtml(condComerciais.condicaoPagamento || 'Não informado')}</p>
                <p><strong>Forma de Pagamento:</strong> ${escaparHtml(condComerciais.formaPagamento || 'Não informado')}</p>
                <p><strong>Prazo de Entrega:</strong> ${escaparHtml(orcamento.infoGerais?.prazoEntrega || 'Não informado')}</p>
                <p><strong>Observações:</strong> ${escaparHtml(condComerciais.observacoesComerciais || orcamento.infoGerais?.observacoesGerais || 'Sem observações.')}</p>
            </div>
        </div>`;
        
        orcamentoFinalDiv.innerHTML = html;
    }

    function abrirModalEdicaoItemOrcamento(produtoAcabadoId, itemId) {
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (!orcamento) return;

        let itemParaEditar = null;
        
        if (produtoAcabadoId) {
            const produto = orcamento.produtosAcabados.find(p => p.id === produtoAcabadoId);
            if (produto) itemParaEditar = produto.itens.find(i => i.id === itemId);
        } else {
            itemParaEditar = orcamento.itens.find(i => i.id === itemId);
        }

        if (!itemParaEditar) {
            mostrarNotificacao("Item não encontrado para edição.");
            return;
        }

        // Preenche os campos do modal com os dados do item
        document.getElementById('edicaoItemId').value = itemId;
        document.getElementById('edicaoProdutoAcabadoIdItem').value = produtoAcabadoId || '';
        document.getElementById('edicaoAmbienteItem').value = itemParaEditar.ambiente || '';
        document.getElementById('edicaoCategoriaItem').value = itemParaEditar.categoria || '';
            document.getElementById('edicaoCorItem').value = itemParaEditar.cor || '-';
        document.getElementById('edicaoCodigoItem').value = itemParaEditar.codigo || '';
        document.getElementById('edicaoQuantidadeItem').value = itemParaEditar.quantidade || 1;
        document.getElementById('edicaoObservacoesItem').value = itemParaEditar.observacoes || '';

        // MODIFICADO: Lógica para popular campos de dimensão
        document.getElementById('edicaoLarguraItem').value = itemParaEditar.largura || '';
        document.getElementById('edicaoAlturaItem').value = itemParaEditar.altura || '';
        
        // NOVO: Ajusta a UI do modal e preenche a largura padrão se necessário
        ajustarCamposEdicaoItem();
        
        // Atualiza o datalist de códigos e o preview
        atualizarPreviewCalculoEdicao();

        // Mostra o modal
        abrirModal('modalEdicaoItem');
    }

    function ajustarCamposEdicaoItem() {
        const codigo = document.getElementById('edicaoCodigoItem').value.trim().toUpperCase();
        const produto = precos.find(p => p.codigo === codigo);

        // Elementos da UI do Modal
        const grupoQtd = document.getElementById('formGroupEdicaoQuantidade');
        const labelQtd = grupoQtd.querySelector('label');
        const inputQtd = document.getElementById('edicaoQuantidadeItem'); // CORREÇÃO: A variável não estava definida nesta função.
        const grupoAlturaPadrao = document.getElementById('formGroupEdicaoAlturaPadraoItem');
        const inputAlturaPadrao = document.getElementById('edicaoAlturaPadraoItem');
        const grupoLargura = document.getElementById('formGroupEdicaoLargura');
        const grupoAltura = document.getElementById('formGroupEdicaoAltura');

        // Reseta a visibilidade de todos os campos para o estado padrão
        grupoQtd.style.display = 'flex';
        grupoLargura.style.display = 'none';
        grupoAltura.style.display = 'none';
        grupoAlturaPadrao.style.display = 'none';
        labelQtd.textContent = 'Qtd:';
        inputQtd.step = "1";

        if (!produto) return; // Se não houver produto, a UI fica no estado padrão (Unidade)

        // Lógica baseada na Unidade de Medida
        switch (normalizarUnidadeMedida(produto.unidadeMedida)) {
            case 'MetroLinear':
                labelQtd.textContent = 'Qtd (metros):';
                inputQtd.step = "0.001";
                grupoAlturaPadrao.style.display = 'flex';
                inputAlturaPadrao.value = produto.alturaPadrao || 0; // CORREÇÃO: Usando a variável e propriedade corretas
                break;
            case 'MetroQuadrado':
                labelQtd.textContent = 'Qtd (peças):';
                grupoLargura.style.display = 'flex';
                grupoAltura.style.display = 'flex';
                break;
            default: // 'Unidade'
                // O estado padrão já foi definido acima, então não precisa de código aqui.
                break;
        }
    }

    function atualizarPreviewCalculoEdicao() {
        ajustarCamposEdicaoItem();

        const codigo = document.getElementById('edicaoCodigoItem').value.trim().toUpperCase();
        const produto = precos.find(p => p.codigo === codigo);
        const previewDiv = document.getElementById('previewCalculoEdicao');

        if (!produto) {
            document.getElementById('edicaoCategoriaItem').value = '';
            document.getElementById('edicaoCorItem').value = '';
            previewDiv.style.display = 'none';
            return;
        }
        
        // Atualiza os campos de categoria e cor em tempo real
        document.getElementById('edicaoCategoriaItem').value = produto.categoria || '';
        document.getElementById('edicaoCorItem').value = produto.cor || '-';

        const quantidade = parseFloat(document.getElementById('edicaoQuantidadeItem').value) || 0;
        const largura = parseFloat(document.getElementById('edicaoLarguraItem').value) || 0;
        const altura = parseFloat(document.getElementById('edicaoAlturaItem').value) || 0;

        // REUTILIZA A LÓGICA CENTRAL: Usa a mesma função que calcula o item final.
        const { precoTotal, calculoTexto } = calcularDetalhesItem(
            produto, quantidade, largura, altura, obterPercentualComissao(obterOrcamentoAtual())
        );

        previewDiv.innerHTML = `
            Cálculo: ${calculoTexto} <br>
            <b>Preço Total Previsto: ${formatarMoeda(precoTotal)}</b>
        `;
        previewDiv.style.display = 'block';
    }

    async function salvarEdicaoItem() {
        if (!garantirOrcamentoEditavel('editar itens')) return;
        const itemId = document.getElementById('edicaoItemId').value;
        const produtoAcabadoId = document.getElementById('edicaoProdutoAcabadoIdItem').value;
        const codigo = document.getElementById('edicaoCodigoItem').value.trim().toUpperCase();
        const produtoBase = precos.find(p => p.codigo === codigo);

        if (!produtoBase || produtoBase.status !== 'Ativo') {
            mostrarNotificacao("O produto com o código inserido não foi encontrado ou está inativo.");
            return;
        }

        const quantidade = parseFloat(document.getElementById('edicaoQuantidadeItem').value);
        const largura = parseFloat(document.getElementById('edicaoLarguraItem').value) || 0;
        const altura = parseFloat(document.getElementById('edicaoAlturaItem').value) || 0;

        const erroValidacao = validarParametrosItem(produtoBase, quantidade, largura, altura);
        if (erroValidacao) {
            mostrarNotificacao(erroValidacao);
            return;           
        }

        const orcamento = orcamentosSalvos[orcamentoAtualId];

        // NOVA ABORDAGEM: Usa a função centralizada para obter todos os valores,
        // com o percentual de comissão do próprio orçamento.
        const detalhesCalculados = calcularDetalhesItem(
            produtoBase,
            quantidade,
            largura,
            altura,
            obterPercentualComissao(orcamento)
        );
        let itemParaAtualizar = null;
        if (produtoAcabadoId) {
            const produto = orcamento.produtosAcabados.find(p => p.id === produtoAcabadoId);
            if (produto) itemParaAtualizar = produto.itens.find(i => i.id === itemId);
        } else {
            itemParaAtualizar = orcamento.itens.find(i => i.id === itemId);
        }

        if (itemParaAtualizar) {
            itemParaAtualizar.ambiente = document.getElementById('edicaoAmbienteItem').value.trim();
            itemParaAtualizar.categoria = produtoBase.categoria || 'Não Especificada';
            itemParaAtualizar.codigo = codigo;
            itemParaAtualizar.descricao = produtoBase.descricao;
            itemParaAtualizar.cor = produtoBase.cor || '-'; // CORREÇÃO: Garante que a cor seja atualizada ao trocar o produto.
            itemParaAtualizar.fornecedor = produtoBase.fornecedor || 'Não Informado';
            itemParaAtualizar.quantidade = quantidade; // A quantidade de peças/metros

            // CORREÇÃO DEFINITIVA: Garante que a largura e altura sejam salvas corretamente para cada tipo.
            // Para MetroQuadrado, salva largura e altura.
            // Para MetroLinear, salva a alturaPadrão (largura do material) no campo 'altura'.
            // Para Unidade, ambos são null.
            itemParaAtualizar.largura = detalhesCalculados.larguraSalva;
            itemParaAtualizar.altura = detalhesCalculados.alturaSalva;
            itemParaAtualizar.unidadeMedida = produtoBase.unidadeMedida;
            itemParaAtualizar.precoUnitarioBase = detalhesCalculados.precoUnitarioBase;
            itemParaAtualizar.precoTotalSemComissao = detalhesCalculados.precoTotalSemComissao;
            itemParaAtualizar.precoUnitario = detalhesCalculados.precoUnitario;
            itemParaAtualizar.precoTotal = detalhesCalculados.precoTotal;
            itemParaAtualizar.observacoes = document.getElementById('edicaoObservacoesItem').value.trim();

            itemParaAtualizar.custoReal = detalhesCalculados.custoReal;
            itemParaAtualizar.quantidadeCompra = detalhesCalculados.quantidadeCompra;
            itemParaAtualizar.precoCompraUnitario = produtoBase.precoCompra;
            // O item editado passa ao formato atual; valores derivados da regra antiga deixam de valer.
            delete itemParaAtualizar.margemLiquida;
            delete itemParaAtualizar.margemPercentual;
            delete itemParaAtualizar.valorComissao;

            // PONTO DE DEPURAÇÃO 2: O que está sendo atualizado?
            console.log("DEBUG: Objeto 'itemParaAtualizar' antes de salvar:", JSON.stringify(itemParaAtualizar, null, 2));

            const salvou = await salvarOrcamentoAtual();
            if (!salvou) return;

            fecharModalEdicaoItem();
            mostrarNotificacao("Item atualizado com sucesso!", 'sucesso');
        } else {
            mostrarNotificacao("Erro: Item não encontrado para atualização.");
        }
    }

    function fecharModalEdicaoItem() {
        fecharModal('modalEdicaoItem');
        
        // Limpar campos
        document.getElementById('edicaoItemId').value = '';
        document.getElementById('edicaoProdutoAcabadoIdItem').value = '';
        document.getElementById('edicaoAmbienteItem').value = '';
        document.getElementById('edicaoCategoriaItem').value = '';
            document.getElementById('edicaoCorItem').value = '';
        document.getElementById('edicaoCodigoItem').value = '';
        document.getElementById('edicaoQuantidadeItem').value = '1';
        document.getElementById('edicaoLarguraItem').value = '';
        document.getElementById('edicaoAlturaItem').value = '';
        document.getElementById('edicaoObservacoesItem').value = '';
        document.getElementById('previewCalculoEdicao').style.display = 'none';
    }

    /**
     * Altera dinamicamente o título do documento antes de imprimir a proposta
     * para gerar um nome de arquivo PDF padronizado e informativo.
     */
    function imprimirPropostaComNomeDinamico() {
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (!orcamento) {
            mostrarNotificacao("Selecione um orçamento para imprimir.");
            return;
        }

        const originalTitle = document.title;
        const id = orcamentoAtualId;
        // Remove caracteres inválidos para nomes de arquivo
        const cliente = (orcamento.infoGerais.nomeCliente || 'Cliente').replace(/[\/\\?%*:|"<>]/g, '-'); 
        const data = formatarData(orcamento.infoGerais.dataOrcamento).replace(/\//g, '-');

        const newTitle = `Orcamento_${id}_${cliente}_${data}`;
        document.title = newTitle;

        // O evento onafterprint é a forma mais confiável de restaurar o título
        // depois que a caixa de diálogo de impressão é fechada.
        window.onafterprint = function() {
            document.title = originalTitle;
            window.onafterprint = null; // Limpa o handler para não interferir em outras impressões
        };

        window.print();
    }

    function imprimirInstrucoesInstaladorLegado() {
        const orcamentoFinalDiv = document.getElementById('orcamentoFinal');
        const orcamento = orcamentosSalvos[orcamentoAtualId];

        if (!orcamento || ((orcamento.itens || []).length === 0 && (orcamento.produtosAcabados || []).length === 0)) {
            mostrarNotificacao("Não há itens no orçamento para gerar as instruções.");
            return;
        }

        // Guarda o conteúdo original para restaurar depois
        const conteudoOriginal = orcamentoFinalDiv.innerHTML;

        // Gera o HTML para o instalador
        let html = `
            <div class="proposta-wrapper">
                <div class="proposta-header">
                    <div class="logo">
                        <img src="WhatsApp Image 2025-09-17 at 16.56.26.jpeg" alt="Logo Marcello Machado">
                    </div>
                    <div class="company-details">
                        <p><strong>Marcello Machado</strong></p>
                        <p>Celular: (11) 97389-3387</p>
                        <p>WhatsApp: <a href="https://wa.me/5511973893387">Clique para iniciar a conversa</a></p>
                        <p>Email: marcello66machado@gmail.com</p>
                        <p><a href="https://www.facebook.com/filippinicortinas?locale=pt_BR">Facebook</a></p>
                        <p><a href="https://www.instagram.com/filippinicortinas/">Instagram</a></p>
                    </div>
                </div>

                <div class="proposta-info-grid">
                    <div><strong>ID do Orçamento:</strong><p>${orcamentoAtualId}</p></div>
                    <div><strong>Cliente:</strong><p>${orcamento.infoGerais.nomeCliente || 'Não informado'}</p></div>
                    <div><strong>Endereço Cliente:</strong><p>${orcamento.infoGerais.enderecoCliente || 'Não informado'}</p></div>
                    <div><strong>Data do Orçamento:</strong><p>${formatarData(orcamento.infoGerais.dataOrcamento)}</p></div>
                    <div><strong>Data da Instalação:</strong><p>${formatarData(orcamento.infoGerais.dataInstalacao)}</p></div>
                    <div><strong>Costureira:</strong><p>${orcamento.infoGerais.nomeCostureira || 'Não informado'}</p></div>
                    <div><strong>Instalador:</strong><p>${orcamento.infoGerais.nomeInstalador || 'Não informado'}</p></div>
                </div>
        `;

        // Agrupa os itens por ambiente
        const itensPorAmbiente = {};
        (orcamento.produtosAcabados || []).forEach(produto => {
            const ambiente = produto.ambiente || 'Ambiente Não Especificado';
            if (!itensPorAmbiente[ambiente]) {
                itensPorAmbiente[ambiente] = [];
            }
            itensPorAmbiente[ambiente].push(produto);
        });

        for (const ambiente in itensPorAmbiente) {
            html += `<h3 class="proposta-ambiente-title">${ambiente}</h3>`;
            
            itensPorAmbiente[ambiente].forEach(produto => {
                html += `
                    <div style="background: #f9f9f9; border: 1px solid #ddd; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                        <h4 style="color: #333; margin-top:0; margin-bottom: 10px; border-bottom: 2px solid #D4AF37; padding-bottom: 5px;">
                            Produto: ${produto.nome}
                        </h4>
                        <p><strong>Instruções para o Instalador:</strong></p>
                        <p style="white-space: pre-wrap; background: #fff; padding: 10px; border-radius: 5px;">${produto.observacoes || 'Nenhuma instrução específica.'}</p>
                        
                        <h5 style="margin-top: 15px;">Componentes:</h5>
                        <table class="proposta-ambiente-table">
                            <thead>
                                <tr>
                                    <th style="width: 15%;">Código/Item</th> 
                                    <th style="width: 35%;">Descrição</th>
                                    <th style="width: 15%;">Cor</th> <th style="width: 10%; text-align: center;">Qtd</th>
                                    <th style="width: 15%; text-align: center;">Largura</th>
                                    <th style="width: 10%; text-align: center;">Altura</th>
                                </tr>
                            </thead>
                            <tbody>`;
                (produto.itens || []).forEach(item => {
                    const largura = item.largura ? `${item.largura.toFixed(2)}m` : '-';
                    const altura = item.altura ? `${item.altura.toFixed(2)}m` : '-';
                    html += `<tr>
                                <td>${item.codigo || ''}</td>
                                <td class="item-description">${item.descricao} ${item.observacoes ? `<br><small><i>Obs: ${item.observacoes}</i></small>` : ''}</td>
                                <td>${(item.cor === 'Não Informada' ? '-' : item.cor) || '-'}</td>
                                <td style="text-align: center;">${item.quantidade}</td>
                                <td style="text-align: center;">${largura}</td>
                                <td style="text-align: center;">${altura}</td>
                            </tr>`;
                });
                html += `       </tbody>
                        </table>
                    </div>`;
            });
        }

        html += `</div>`; // Fecha o proposta-wrapper

        // Substitui o conteúdo, imprime e depois restaura
        orcamentoFinalDiv.innerHTML = html;

        // Define um gatilho para restaurar o conteúdo original após a impressão
        window.onafterprint = function() {
            orcamentoFinalDiv.innerHTML = conteudoOriginal;
            // Limpa o evento para não interferir na impressão normal da proposta
            window.onafterprint = null; 
        };

        window.print();
    }

    function imprimirInstrucoesInstalador() {
        const orcamentoFinalDiv = document.getElementById('orcamentoFinal');
        const orcamento = obterOrcamentoAtual();

        if (!orcamento || !pedidoEstaConfirmado(orcamento)) {
            mostrarNotificacao('Transforme o orçamento em pedido antes de gerar o relatório do instalador.');
            return;
        }

        const itens = obterItensDoPedido(orcamento);
        if (itens.length === 0) {
            mostrarNotificacao('O pedido confirmado não possui itens para retirada.');
            return;
        }

        const pedido = orcamento.pedido || {};
        const cliente = pedido.cliente || {};
        const conteudoOriginal = orcamentoFinalDiv.innerHTML;
        const tituloOriginal = document.title;
        const linhas = itens.map(item => `
            <tr>
                <td>${escaparHtml(item.ambiente || '-')}</td>
                <td>${escaparHtml(item.produtoAcabadoNome || 'Item avulso')}</td>
                <td>${escaparHtml(item.codigo || '-')}</td>
                <td>${escaparHtml(item.descricao || '-')}</td>
                <td>${escaparHtml(item.unidadeMedida || 'Unidade')}</td>
                <td class="numero">${escaparHtml(Number(item.quantidadeCompra || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 }))}</td>
            </tr>
        `).join('');

        orcamentoFinalDiv.innerHTML = `
            <div class="proposta-wrapper proposta-reduzida relatorio-instalador">
                <h2>Retirada para instalação</h2>
                <div class="proposta-info-grid">
                    <div><strong>Pedido</strong><p>${escaparHtml(orcamento.id || orcamentoAtualId)}</p></div>
                    <div><strong>Cliente</strong><p>${escaparHtml(cliente.nome || orcamento.infoGerais?.nomeCliente || 'Não informado')}</p></div>
                    <div class="campo-endereco"><strong>Endereço do cliente</strong><p>${escaparHtml(cliente.endereco || orcamento.infoGerais?.enderecoCliente || 'Não informado')}</p></div>
                </div>
                <table class="proposta-ambiente-table">
                    <thead>
                        <tr>
                            <th>Ambiente</th>
                            <th>Produto</th>
                            <th>Código</th>
                            <th>Item a retirar</th>
                            <th>Unidade</th>
                            <th>Qtd.</th>
                        </tr>
                    </thead>
                    <tbody>${linhas}</tbody>
                </table>
            </div>
        `;

        document.title = `Retirada_Instalador_${orcamento.id || orcamentoAtualId}`;
        window.onafterprint = function() {
            orcamentoFinalDiv.innerHTML = conteudoOriginal;
            document.title = tituloOriginal;
            window.onafterprint = null;
        };

        window.print();
    }

    function exportarDados() {
        const data = {
            version: dataVersion,
            exportadoEm: new Date().toISOString(),
            precos: precos,
            fornecedores: fornecedores,
            categorias: categorias,
            unidadesDeMedida: unidadesDeMedida,
            orcamentosSalvos: orcamentosSalvos
        };
        const dataStr = JSON.stringify(data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `filippini_backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        mostrarNotificacao("Backup concluído com sucesso!");
    }

    async function gravarDocumentosEmLotes(documentos) {
        const tamanhoLote = 400;
        for (let inicio = 0; inicio < documentos.length; inicio += tamanhoLote) {
            const batch = writeBatch(db);
            documentos.slice(inicio, inicio + tamanhoLote).forEach(({ colecao, id, dados }) => {
                batch.set(doc(db, colecao, id), dados, { merge: true });
            });
            await batch.commit();
        }
    }

    async function importarDados(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const importedData = JSON.parse(await file.text());
            const colecoesArray = ['precos', 'fornecedores', 'categorias', 'unidadesDeMedida'];
            const estruturaValida = importedData
                && typeof importedData === 'object'
                && colecoesArray.every(nome => importedData[nome] === undefined || Array.isArray(importedData[nome]))
                && (importedData.orcamentosSalvos === undefined || typeof importedData.orcamentosSalvos === 'object');

            if (!estruturaValida) {
                throw new Error('Estrutura de backup inválida.');
            }

            if (importedData.version !== dataVersion && importedData.version !== '1.0') {
                const continuar = confirm(`O backup é da versão ${importedData.version || 'desconhecida'} e o sistema usa ${dataVersion}. Deseja tentar a mesclagem mesmo assim?`);
                if (!continuar) return;
            }

            const documentos = [];
            colecoesArray.forEach(nomeColecao => {
                (importedData[nomeColecao] || []).forEach((registro, indice) => {
                    const id = String(registro?.id || `importado-${crypto.randomUUID()}-${indice}`);
                    const { id: _idIgnorado, ...dados } = registro || {};
                    documentos.push({ colecao: nomeColecao, id, dados });
                });
            });
            Object.entries(importedData.orcamentosSalvos || {}).forEach(([id, dados]) => {
                documentos.push({ colecao: 'orcamentos', id, dados: { ...dados, id } });
            });

            if (documentos.length === 0) {
                throw new Error('O arquivo não contém registros para restaurar.');
            }

            const confirmarMesclagem = confirm(`Mesclar ${documentos.length} registro(s) deste backup no Firebase? Registros com o mesmo ID serão atualizados; nenhum registro atual será apagado.`);
            if (!confirmarMesclagem) return;

            atualizarStatusSincronizacao('Restaurando backup…', 'loading');
            await gravarDocumentosEmLotes(documentos);

            const maiorNumeroOrcamento = Object.keys(importedData.orcamentosSalvos || {})
                .map(id => id.match(/^ORC-(\d+)$/))
                .filter(Boolean)
                .reduce((maior, match) => Math.max(maior, Number(match[1])), 0);
            if (maiorNumeroOrcamento > 0) {
                await runTransaction(db, async transaction => {
                    const contadorRef = doc(db, 'contadores', 'orcamentos');
                    const snapshot = await transaction.get(contadorRef);
                    const atual = snapshot.exists() ? Number(snapshot.data().ultimoNumero || 0) : 0;
                    transaction.set(contadorRef, {
                        ultimoNumero: Math.max(atual, maiorNumeroOrcamento),
                        atualizadoEm: new Date().toISOString()
                    }, { merge: true });
                });
            }

            atualizarStatusSincronizacao('Backup restaurado', 'ok');
            mostrarNotificacao(`${documentos.length} registro(s) mesclado(s) com sucesso.`);
        } catch (error) {
            console.error('Erro na restauração do backup:', error);
            atualizarStatusSincronizacao('Falha ao restaurar backup', 'error');
            mostrarNotificacao(`Não foi possível restaurar o backup: ${error.message}`);
        } finally {
            event.target.value = '';
        }
    }

    /**
     * Função centralizada para salvar o estado atual do orçamento no Firestore.
     */
    async function salvarOrcamentoAtual(id = orcamentoAtualId) {
        const orcamento = orcamentosSalvos[id];
        if (!id || !orcamento) {
            console.warn("Tentativa de salvar um orçamento inválido ou não selecionado.");
            return false;
        }

        atualizarStatusSincronizacao('Salvando alterações…', 'carregando');
        try {
            const orcamentoRef = doc(db, "orcamentos", id);
            // Usamos `setDoc` para sobrescrever o documento inteiro com os dados atualizados em memória.
            // O `merge: true` é uma segurança para não destruir o documento se ele for recriado.
            await updateDoc(orcamentoRef, orcamento);
            orcamentosPersistidos[id] = structuredClone(orcamento);
            orcamentosComAlteracoesPendentes.delete(id);
            atualizarStatusSincronizacao('Alterações salvas', 'ok');
            return true;
        } catch (error) {
            console.error("Erro ao salvar orçamento no Firestore:", error);
            if (orcamentosPersistidos[id]) {
                orcamentosSalvos[id] = structuredClone(orcamentosPersistidos[id]);
                if (id === orcamentoAtualId) preencherInfoOrcamento();
            }
            orcamentosComAlteracoesPendentes.delete(id);
            atualizarStatusSincronizacao('Falha ao salvar. As alterações foram desfeitas.', 'erro');
            mostrarNotificacao('Não foi possível salvar. As alterações foram desfeitas; verifique sua conexão e tente novamente.', 'erro');
            return false;
        }
    }

    // Função para atualizar campos de texto/data do orçamento e salvar
    async function atualizarInfoOrcamento(campo, valor) {
        const id = orcamentoAtualId;
        if (!id) return false;
        const orcamento = orcamentosSalvos[id];
        
        if (!orcamento.infoGerais) {
            orcamento.infoGerais = {};
        }
        orcamento.infoGerais[campo] = valor;
        
        if (campo === 'nomeCliente') {
            renderizarOrcamentos(); // Atualiza o texto no seletor de orçamentos
        }
        return salvarOrcamentoAtual(id);
    }

    async function atualizarCampoOpcionalOrcamento(campo, valor) {
        // Campos novos só são gravados quando o valor muda, sem criar valores padrão em orçamentos antigos.
        const id = orcamentoAtualId;
        const orcamento = orcamentosSalvos[id];
        if (!id || !orcamento) return false;

        if ((orcamento.infoGerais?.[campo] ?? '') === valor) {
            // Nada a gravar. O aviso de pendência só é removido se nenhum celular inválido ficou sem salvar.
            const celularInvalidoNaTela = Object.keys(CONTATOS_WHATSAPP)
                .some(campoCelular => document.getElementById(campoCelular).getAttribute('aria-invalid') === 'true');
            if (!celularInvalidoNaTela && orcamentosComAlteracoesPendentes.delete(id) && orcamentosComAlteracoesPendentes.size === 0) {
                atualizarStatusSincronizacao('Dados sincronizados', 'ok');
            }
            return true;
        }
        return atualizarInfoOrcamento(campo, valor);
    }

    async function atualizarCelular(campo) {
        const input = document.getElementById(campo);
        const celular = normalizarCelular(input.value);
        atualizarContatoWhatsApp(campo, input.value, { validar: true });
        // Número inválido continua na tela para correção e não é gravado.
        if (celular === null) return false;

        input.value = formatarCelular(celular);
        return atualizarCampoOpcionalOrcamento(campo, celular);
    }

    function atualizarContatoWhatsApp(campo, valor, { validar = false } = {}) {
        const { link, ajuda } = CONTATOS_WHATSAPP[campo];
        const input = document.getElementById(campo);
        const elementoLink = document.getElementById(link);
        const elementoAjuda = document.getElementById(ajuda);
        const url = gerarLinkWhatsApp(valor);
        const invalido = normalizarCelular(valor) === null;

        // Durante a digitação o aviso só é removido; ele aparece ao sair do campo ou ao abrir o orçamento.
        if (!invalido || validar) {
            elementoAjuda.textContent = invalido ? MENSAGEM_CELULAR_INVALIDO : '';
            if (invalido) input.setAttribute('aria-invalid', 'true');
            else input.removeAttribute('aria-invalid');
        }

        if (url) {
            elementoLink.href = url;
            elementoLink.removeAttribute('aria-disabled');
            elementoLink.title = 'Abrir conversa no WhatsApp em nova aba';
        } else {
            elementoLink.removeAttribute('href');
            elementoLink.setAttribute('aria-disabled', 'true');
            elementoLink.title = MENSAGEM_CELULAR_INVALIDO;
        }
    }

    function criarLinkWhatsAppDaLista(celular, rotulo, descricao) {
        const url = gerarLinkWhatsApp(celular);
        if (!url) return '';
        return `<a class="btn btn-whatsapp btn-sm" href="${escaparHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escaparHtml(descricao)}">${rotulo}</a>`;
    }

    function criarLinhaFollowUp(registro) {
        const nomeCliente = registro.nomeCliente || 'Não informado';
        const linkCliente = criarLinkWhatsAppDaLista(
            registro.celularCliente,
            'WhatsApp cliente',
            `Abrir WhatsApp do cliente ${nomeCliente} (${registro.id})`
        );
        const linkComissionado = criarLinkWhatsAppDaLista(
            registro.celularComissionado,
            'WhatsApp arquiteto',
            `Abrir WhatsApp do arquiteto/comissionado ${registro.nomeComissionado || ''} (${registro.id})`
        );
        const avisoSemCelular = linkCliente ? '' : '<span class="acao-indisponivel">Cadastre um celular válido do cliente</span>';
        const celularComissionado = registro.celularComissionado
            ? `<span class="followup-comissionado">Arquiteto: <span class="followup-sem-quebra">${escaparHtml(formatarCelular(registro.celularComissionado))}</span></span>`
            : '';

        return `
            <tr>
                <td data-label="Data" class="followup-sem-quebra">${escaparHtml(formatarData(registro.dataFollowUp))}</td>
                <td data-label="Orçamento" class="followup-sem-quebra">${escaparHtml(registro.id)}</td>
                <td data-label="Cliente">${escaparHtml(nomeCliente)}${registro.nomeComissionado ? `<span class="followup-comissionado">Arquiteto: ${escaparHtml(registro.nomeComissionado)}</span>` : ''}</td>
                <td data-label="Observação" class="followup-observacao">${escaparHtml(registro.observacao || '-')}</td>
                <td data-label="Celular"><span class="followup-sem-quebra">${escaparHtml(formatarCelular(registro.celularCliente) || '-')}</span>${celularComissionado}</td>
                <td data-label="Valor da proposta" class="followup-sem-quebra">${formatarMoeda(registro.totalPropostaCliente)}</td>
                <td data-label="Ações">
                    <div class="followup-acoes">
                        ${linkCliente}${linkComissionado}${avisoSemCelular}
                        <button type="button" class="btn btn-secondary btn-sm btn-abrir-orcamento" data-orcamento-id="${escaparHtml(registro.id)}">Abrir orçamento</button>
                    </div>
                </td>
            </tr>`;
    }

    function renderizarFollowUps() {
        const container = document.getElementById('listaFollowUps');
        const resumo = document.getElementById('followupsResumo');
        if (!container || !resumo) return;

        const grupos = listarFollowUps(orcamentosSalvos, obterDataCivilAtual());
        const secoes = [
            { chave: 'vencidos', titulo: 'Vencidos', vazio: 'Nenhum follow-up vencido.' },
            { chave: 'hoje', titulo: 'Hoje', vazio: 'Nenhum follow-up para hoje.' },
            { chave: 'proximos', titulo: 'Próximos', vazio: 'Nenhum follow-up agendado para os próximos dias.' }
        ];

        resumo.textContent = `${grupos.vencidos.length} vencido(s) · ${grupos.hoje.length} para hoje · ${grupos.proximos.length} próximo(s)`;
        container.innerHTML = secoes.map(({ chave, titulo, vazio }) => {
            const registros = grupos[chave];
            const conteudo = registros.length === 0
                ? `<p class="followup-vazio">${vazio}</p>`
                : `<table class="followups-table">
                        <thead>
                            <tr>
                                <th scope="col">Data</th>
                                <th scope="col">Orçamento</th>
                                <th scope="col">Cliente</th>
                                <th scope="col">Observação</th>
                                <th scope="col">Celular</th>
                                <th scope="col">Valor da proposta</th>
                                <th scope="col">Ações</th>
                            </tr>
                        </thead>
                        <tbody>${registros.map(criarLinhaFollowUp).join('')}</tbody>
                    </table>`;

            return `
                <section class="followup-grupo followup-grupo-${chave}" data-grupo="${chave}" aria-labelledby="followups-titulo-${chave}">
                    <h3 id="followups-titulo-${chave}">${titulo} (${registros.length})</h3>
                    ${conteudo}
                </section>`;
        }).join('');
    }

    function abrirOrcamentoDoFollowUp(id) {
        if (!orcamentosSalvos[id]) {
            mostrarNotificacao('Orçamento não encontrado. A lista de follow-ups foi atualizada.');
            renderizarFollowUps();
            return;
        }

        alternarOrcamento(id);
        atualizarSeletoresOrcamento(id);
        const indiceLancamento = [...document.querySelectorAll('.tab-content')].findIndex(painel => painel.id === 'tab2');
        showTab(indiceLancamento, true);
    }

    function inicializarSelectInteligente(inputId) {
        const input = document.getElementById(inputId);
        if (!input) {
            console.error(`Elemento #${inputId} não encontrado.`);
            return;
        }

        input.removeAttribute('list');

        const wrapper = document.createElement('div');
        wrapper.className = 'select-inteligente-wrapper';

        const dropdown = document.createElement('div');
        dropdown.className = 'select-inteligente-dropdown';
        dropdown.style.display = 'none';
        dropdown.id = `${inputId}-opcoes`;
        dropdown.setAttribute('role', 'listbox');

        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', dropdown.id);

        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);
        wrapper.appendChild(dropdown);

        let indiceAtivo = -1;

        const obterItens = () => [...dropdown.querySelectorAll('.select-inteligente-item:not(.sem-resultado)')];

        const fecharDropdown = () => {
            dropdown.style.display = 'none';
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            indiceAtivo = -1;
        };

        const destacarItem = (novoIndice) => {
            const itens = obterItens();
            if (itens.length === 0) return;

            indiceAtivo = (novoIndice + itens.length) % itens.length;
            itens.forEach((item, indice) => {
                const ativo = indice === indiceAtivo;
                item.classList.toggle('ativo', ativo);
                item.setAttribute('aria-selected', String(ativo));
            });
            input.setAttribute('aria-activedescendant', itens[indiceAtivo].id);
            itens[indiceAtivo].scrollIntoView({ block: 'nearest' });
        };

        const selecionarItem = (item) => {
            if (!item || item.classList.contains('sem-resultado')) return;
            const codigo = item.dataset.codigo;
            input.value = codigo;
            fecharDropdown();

            const produto = precos.find(p => p.codigo === codigo);
            if (produto && inputId === 'codigoOrcamento') {
                document.getElementById('categoriaItemOrcamento').value = produto.categoria || '';
                document.getElementById('corItemOrcamento').value = produto.cor || '-';
            } else if (produto && inputId === 'edicaoCodigoItem') {
                document.getElementById('edicaoCategoriaItem').value = produto.categoria || '';
                document.getElementById('edicaoCorItem').value = produto.cor || '-';
            }

            input.dispatchEvent(new Event('input', { bubbles: true }));
        };

        input.addEventListener('input', function() {
            const termoBusca = this.value.toLowerCase().trim();

            if (termoBusca.length < 2) {
                fecharDropdown();
                return;
            }

            const resultados = precos.filter(p => 
                p.status === 'Ativo' && (
                    p.codigo.toLowerCase().includes(termoBusca) ||
                    p.descricao.toLowerCase().includes(termoBusca) ||
                    (p.cor && p.cor.toLowerCase().includes(termoBusca)) ||
                    (p.fornecedor && p.fornecedor.toLowerCase().includes(termoBusca)) ||
                    (p.categoria && p.categoria.toLowerCase().includes(termoBusca))
                )
            );

            dropdown.replaceChildren();
            indiceAtivo = -1;

            if (resultados.length > 0) {
                resultados.slice(0, 10).forEach((produto, indice) => {
                    const item = document.createElement('div');
                    item.className = 'select-inteligente-item';
                    item.dataset.codigo = produto.codigo;
                    item.id = `${inputId}-opcao-${indice}`;
                    item.setAttribute('role', 'option');
                    item.setAttribute('aria-selected', 'false');

                    const codigo = document.createElement('strong');
                    codigo.textContent = produto.codigo;
                    item.append(codigo, document.createTextNode(` - ${produto.descricao}`));

                    const infoExtras = [produto.cor, produto.fornecedor, produto.categoria].filter(Boolean);
                    if (infoExtras.length > 0) {
                        const info = document.createElement('span');
                        info.className = 'select-info';
                        info.textContent = infoExtras.join(' | ');
                        item.append(document.createElement('br'), info);
                    }

                    dropdown.appendChild(item);
                });
            } else {
                const semResultado = document.createElement('div');
                semResultado.className = 'select-inteligente-item sem-resultado';
                semResultado.textContent = 'Nenhum produto encontrado';
                dropdown.appendChild(semResultado);
            }

            dropdown.style.display = 'block';
            input.setAttribute('aria-expanded', 'true');
        });

        dropdown.addEventListener('click', function(e) {
            const item = e.target.closest('.select-inteligente-item');
            selecionarItem(item);
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                if (dropdown.style.display !== 'none') event.stopPropagation();
                fecharDropdown();
                return;
            }

            if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || dropdown.style.display === 'none') return;
            const itens = obterItens();
            if (itens.length === 0) return;

            event.preventDefault();
            if (event.key === 'ArrowDown') destacarItem(indiceAtivo + 1);
            if (event.key === 'ArrowUp') destacarItem(indiceAtivo <= 0 ? itens.length - 1 : indiceAtivo - 1);
            if (event.key === 'Enter') selecionarItem(itens[indiceAtivo >= 0 ? indiceAtivo : 0]);
        });

        document.addEventListener('click', function(e) {
            if (!wrapper.contains(e.target)) {
                fecharDropdown();
            }
        });
    }

    function atualizarPreviewCalculo() {
        ajustarCamposOrcamentoPorProduto();

        const codigo = document.getElementById('codigoOrcamento').value.trim().toUpperCase();
        const produto = precos.find(p => p.codigo === codigo);
        const previewDiv = document.getElementById('previewCalculo');
        
        if (!produto) {
            document.getElementById('categoriaItemOrcamento').value = '';
            document.getElementById('corItemOrcamento').value = '';
            previewDiv.style.display = 'none';
            return;
        }
        const quantidade = parseFloat(document.getElementById('quantidade').value) || 0;
        const largura = parseFloat(document.getElementById('largura').value) || 0;
        const altura = parseFloat(document.getElementById('altura').value) || 0;

        const { precoTotal, calculoTexto } = calcularDetalhesItem(
            produto, quantidade, largura, altura, obterPercentualComissao(obterOrcamentoAtual())
        );
        previewDiv.innerHTML = `Cálculo: ${calculoTexto} <br><b>Preço Total Previsto: ${formatarMoeda(precoTotal)}</b>`;
        previewDiv.style.display = 'block';
    }

    function ajustarCamposOrcamentoPorProduto() {
        const codigo = document.getElementById('codigoOrcamento').value.trim().toUpperCase();
        const produto = precos.find(p => p.codigo === codigo);

        // Elementos da UI
        const grupoQtd = document.getElementById('formGroupQuantidade');
        const labelQtd = grupoQtd.querySelector('label');
        const inputQtd = document.getElementById('quantidade');
        const grupoAlturaPadrao = document.getElementById('formGroupAlturaPadraoItem');
        const inputAlturaPadrao = document.getElementById('alturaPadraoItem'); // CORREÇÃO: ID e nome da variável
        const grupoLargura = document.getElementById('formGroupLargura');
        const grupoAltura = document.getElementById('formGroupAltura');

        // Primeiro, reseta a UI para o estado padrão (como se fosse 'Unidade')
        labelQtd.textContent = 'Qtd:';
        inputQtd.step = "1";
        grupoQtd.style.display = 'flex';
        grupoLargura.style.display = 'none';
        grupoAltura.style.display = 'none';
        grupoAlturaPadrao.style.display = 'none';

        if (!produto) return; // Se o produto não for encontrado, a UI permanece como 'Unidade'

        document.getElementById('categoriaItemOrcamento').value = produto.categoria || '';
        document.getElementById('corItemOrcamento').value = produto.cor || '-';

        // Lógica de UI baseada na Unidade de Medida
        switch (normalizarUnidadeMedida(produto.unidadeMedida)) {
            case 'MetroLinear':
                labelQtd.textContent = 'Qtd (metros):';
                inputQtd.step = "0.001"; // Permite 3 casas decimais
                grupoAlturaPadrao.style.display = 'flex';
                inputAlturaPadrao.value = produto.alturaPadrao || 0; // CORREÇÃO: Usando a variável correta
                break;
            case 'MetroQuadrado':
                labelQtd.textContent = 'Qtd (peças):';
                grupoLargura.style.display = 'flex';
                grupoAltura.style.display = 'flex';
                break;
            default: // 'Unidade'
                // O estado padrão já foi definido, não precisa de código aqui.
                break;
        }
    }
    
    // Funções de formatação
    function formatarMoeda(valor) {
        return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
    }

    function truncarDecimal(valor, casas) {
        // 1. Cria o fator de multiplicação (ex: 100 para 2 casas)
        const fator = Math.pow(10, casas);
        const num = parseFloat(valor);
        
        if (isNaN(num)) {
            // Retorna "0.00" (ou 0.00... com 'casas' decimais) se o valor não for um número
            return (0).toFixed(casas);
        }
        
        // 2. Multiplica o número pelo fator, arredonda para baixo (Math.floor)
        // isso remove os decimais que você não quer, realizando a truncagem.
        // 3. Divide pelo fator novamente.
        const valorTruncado = Math.floor(num * fator) / fator;

        // 4. Usa toFixed() apenas para garantir que haverá as 'casas' decimais, 
        // preenchendo com zeros se necessário (ex: 37.98 vira "37.98").
        return valorTruncado.toFixed(casas);
    }

    async function adicionarPreco() {
        const codigo = document.getElementById('codigo').value.trim().toUpperCase();
        const descricao = document.getElementById('descricao').value.trim();
        const cor = document.getElementById('cor').value.trim();
        const fornecedor = document.getElementById('fornecedor').value;
        const unidadeMedida = document.getElementById('unidadeMedida').value;
        const categoria = document.getElementById('categoria').value;
        const precoCompra = parseFloat(document.getElementById('precoCompra').value);
        const markup = parseFloat(document.getElementById('markup').value);
        const statusProduto = document.getElementById('statusProduto').value;

        if (!codigo || !descricao || isNaN(precoCompra) || isNaN(markup)) {
            mostrarNotificacao("Por favor, preencha todos os campos obrigatórios.");
            return;
        }
        
        // LÓGICA DE VALIDAÇÃO DA ALTURA PADRÃO CORRIGIDA
        const alturaPadraoInput = document.getElementById('alturaPadrao');
        let alturaPadrao = null;
        if (normalizarUnidadeMedida(unidadeMedida) === 'MetroLinear') {
            alturaPadrao = parseFloat(alturaPadraoInput.value);
        }

        const erroValidacaoProduto = validarParametrosProduto({ precoCompra, markup, unidadeMedida, alturaPadrao });
        if (erroValidacaoProduto) {
            mostrarNotificacao(erroValidacaoProduto);
            const campoInvalido = precoCompra <= 0
                ? document.getElementById('precoCompra')
                : markup <= 0
                    ? document.getElementById('markup')
                    : alturaPadraoInput;
            campoInvalido.focus();
            return;
        }

        const precoFinal = calcularPrecoFinal(precoCompra, markup);

        const produtoData = {
            codigo,
            descricao,
            cor,
            fornecedor,
            categoria,
            unidadeMedida,
            alturaPadrao: alturaPadrao,
            precoCompra,
            markup,
            precoFinal,
            status: statusProduto
        };

        const produtoExistente = precos.find(p => p.codigo === codigo);

        try {
            if (produtoExistente) {
                // --- ATUALIZAR PRODUTO (UPDATE) ---
                const produtoRef = doc(db, "precos", produtoExistente.id);
                await updateDoc(produtoRef, produtoData);

                // Atualiza o array local
                const index = precos.findIndex(p => p.id === produtoExistente.id);
                precos[index] = { ...precos[index], ...produtoData };

                mostrarNotificacao("Produto atualizado com sucesso!");
            } else {
                // --- ADICIONAR NOVO PRODUTO (CREATE) ---
                const docRef = await addDoc(collection(db, "precos"), produtoData);
                
                // Adiciona o novo produto com seu ID do Firestore ao array local
                precos.push({ id: docRef.id, ...produtoData });

                mostrarNotificacao("Produto adicionado com sucesso!");
            }
            
            limparFormularioPreco(); // O listener irá atualizar a UI

        } catch (error) {
            console.error("Erro ao salvar produto no Firestore: ", error);
            mostrarNotificacao("Ocorreu um erro ao salvar o produto. Tente novamente.");
        }
    }

    // Esta função agora abre o modal de edição
    function editarPreco(id) {
        abrirModalEdicaoProduto(id); // Corrigido para passar o ID do documento
    }

    async function excluirPreco(id) {
        if (confirm("Tem certeza que deseja excluir este produto?")) {
            try {
                // --- EXCLUIR PRODUTO (DELETE) ---
                await deleteDoc(doc(db, "precos", id));

                // Remove do array local
                precos = precos.filter(p => p.id !== id);

                // O listener irá atualizar a UI
                mostrarNotificacao("Produto excluído com sucesso!");

            } catch (error) {
                console.error("Erro ao excluir produto do Firestore: ", error);
                mostrarNotificacao("Ocorreu um erro ao excluir o produto. Tente novamente.");
            }
        }
    }

    function limparFormularioPreco() {
        document.getElementById('codigo').value = '';
        document.getElementById('descricao').value = '';
        document.getElementById('unidadeMedida').value = 'Unidade';
        document.getElementById('precoCompra').value = '';
        document.getElementById('markup').value = '2.5';
        document.getElementById('statusProduto').value = 'Ativo';
        
        document.getElementById('alturaPadrao').value = '';
        document.getElementById('cor').value = '';

        // Garante que a visibilidade do campo Altura Padrão seja resetada
        ajustarCamposCadastroPorUnidade();
    }

    function renderizarTabela() {
        const tabelaPrecos = document.getElementById('tabelaPrecos');
        tabelaPrecos.innerHTML = '';

        const inicio = (paginaAtual - 1) * itensPorPagina;
        const fim = inicio + itensPorPagina;
        const produtosParaRenderizar = listaProdutosFiltrada.slice(inicio, fim);

        produtosParaRenderizar.forEach(produto => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${produto.codigo}</td>
                            <td>${produto.descricao}</td>
                            <td>${produto.cor || '-'}</td>
                            <td>${produto.fornecedor || '-'}</td>
                            <td>${produto.categoria || '-'}</td>
                            <td>${produto.unidadeMedida}</td>
                            <td>${formatarMoeda(produto.precoCompra)}</td>
                            <td>${produto.markup}x</td>
                            <td>${formatarMoeda(produto.precoFinal)}</td>
                            <td class="status-${produto.status?.toLowerCase() || 'inativo'}">${produto.status || 'Inativo'}</td>`;
            
            const actionsTd = document.createElement('td');
            actionsTd.style.textAlign = 'center';

            const editButton = document.createElement('button');
            editButton.className = 'btn btn-warning btn-sm';
            editButton.textContent = 'Editar';
            editButton.addEventListener('click', () => editarPreco(produto.id));

            const deleteButton = document.createElement('button');
            deleteButton.className = 'btn btn-danger btn-sm';
            deleteButton.textContent = 'Excluir';
            deleteButton.addEventListener('click', () => excluirPreco(produto.id));

            actionsTd.appendChild(editButton);
            actionsTd.appendChild(deleteButton);
            tr.appendChild(actionsTd);

            tabelaPrecos.appendChild(tr);
        });

        renderizarPaginacao();
    }

    function filtrarProdutos() {
        const busca = document.getElementById('buscaProdutos').value.toLowerCase();
        const filtroFornecedor = document.getElementById('filtroFornecedor').value;
        const filtroCategoria = document.getElementById('filtroCategoria').value;
        const filtroStatus = document.getElementById('filtroStatus').value;
        listaProdutosFiltrada = precos.filter(produto => {
            const matchBusca = (
                produto.codigo.toLowerCase().includes(busca) ||
                produto.descricao.toLowerCase().includes(busca) ||
                (produto.cor && produto.cor.toLowerCase().includes(busca)) ||
                (produto.fornecedor && produto.fornecedor.toLowerCase().includes(busca)) ||
                (produto.categoria && produto.categoria.toLowerCase().includes(busca))
            );
            const matchFornecedor = (filtroFornecedor === '' || produto.fornecedor === filtroFornecedor);
            const matchCategoria = (filtroCategoria === '' || produto.categoria === filtroCategoria);
            const matchStatus = (filtroStatus === '' || produto.status === filtroStatus);
            return matchBusca && matchFornecedor && matchCategoria && matchStatus;
        });
        paginaAtual = 1;
        renderizarTabela();
    }

    function renderizarPaginacao() {
        const paginationContainer = document.getElementById('paginationContainer');
        paginationContainer.innerHTML = '';
        
        const totalPaginas = Math.ceil(listaProdutosFiltrada.length / itensPorPagina);

        if (totalPaginas > 1) {
            const prevButton = document.createElement('button');
            prevButton.textContent = '◀️ Anterior';
            prevButton.classList.add('btn', 'btn-info', 'btn-sm');
            prevButton.disabled = paginaAtual === 1;
            prevButton.onclick = () => { paginaAtual--; renderizarTabela(); };
            paginationContainer.appendChild(prevButton);

            const infoSpan = document.createElement('span');
            infoSpan.textContent = `Página ${paginaAtual} de ${totalPaginas}`;
            infoSpan.classList.add('pagination-info');
            paginationContainer.appendChild(infoSpan);

            const nextButton = document.createElement('button');
            nextButton.textContent = 'Próximo ▶️';
            nextButton.classList.add('btn', 'btn-info', 'btn-sm');
            nextButton.disabled = paginaAtual === totalPaginas;
            nextButton.onclick = () => { paginaAtual++; renderizarTabela(); };
            paginationContainer.appendChild(nextButton);
        }
    }

    function atualizarSelects() {
        const selects = {
            fornecedor: document.getElementById('fornecedor'),
            categoria: document.getElementById('categoria'),
            filtroFornecedor: document.getElementById('filtroFornecedor'),
            filtroCategoria: document.getElementById('filtroCategoria')
        };

        // Populando Fornecedores
        selects.fornecedor.innerHTML = `<option value="">Selecione</option>`;
        selects.filtroFornecedor.innerHTML = `<option value="">Todos</option>`;
        fornecedores.filter(f => f.status === 'Ativo').forEach(f => {
            const option = document.createElement('option');
            option.value = f.nome;
            option.textContent = f.nome;
            selects.fornecedor.appendChild(option.cloneNode(true));
            selects.filtroFornecedor.appendChild(option);
        });

        // Populando Categorias
        selects.categoria.innerHTML = `<option value="">Selecione</option>`;
        selects.filtroCategoria.innerHTML = `<option value="">Todas</option>`;
        categorias.filter(c => c.status === 'Ativo').forEach(c => {
            const option = document.createElement('option');
            option.value = c.nome;
            option.textContent = c.nome;
            selects.categoria.appendChild(option.cloneNode(true));
            selects.filtroCategoria.appendChild(option);
        });
    }

    function atualizarSelectsUnidadeMedida() {
        const selects = [
            document.getElementById('unidadeMedida'),
            document.getElementById('edicaoUnidadeMedidaProduto')
        ];

        selects.forEach(select => {
            if (select) {
                const valorAtual = select.value;
                select.innerHTML = '';
                // FILTRA apenas unidades ativas antes de criar as opções
                unidadesDeMedida.filter(u => u.status === 'Ativo').forEach(u => {
                    const option = document.createElement('option');
                    option.value = u.nome;
                    option.textContent = u.nome;
                    select.appendChild(option);
                });
                select.value = valorAtual;
            }
            // Dispara o evento 'change' programaticamente após popular o select.
            // Isso garante que a função de ajuste de campos (ajustarCamposCadastroPorUnidade ou ajustarCamposEdicaoProduto)
            // seja chamada e atualize a UI corretamente, mesmo na carga inicial ou após a população.
            if (select.id === 'unidadeMedida' || select.id === 'edicaoUnidadeMedidaProduto') {
                const event = new Event('change', { bubbles: true });
                select.dispatchEvent(event);
            }
        });
    }

    function ordenarTabela(coluna) {
        let direcao = 'asc';
        if (estadoOrdenacao.coluna === coluna && estadoOrdenacao.direcao === 'asc') {
            direcao = 'desc';
        }

        listaProdutosFiltrada.sort((a, b) => {
            const aVal = a[coluna] === undefined || a[coluna] === null ? '' : a[coluna];
            const bVal = b[coluna] === undefined || b[coluna] === null ? '' : b[coluna];

            if (coluna === 'precoCompra' || coluna === 'markup' || coluna === 'precoFinal') {
                const aNum = parseFloat(aVal) || 0;
                const bNum = parseFloat(bVal) || 0;
                if (aNum < bNum) return direcao === 'asc' ? -1 : 1;
                if (aNum > bNum) return direcao === 'asc' ? 1 : -1;
                return 0;
            }
            else {
                const aStr = String(aVal);
                const bStr = String(bVal);
                
                // Usa localeCompare para ordenação de texto robusta e case-insensitive
                const resultadoComparacao = aStr.localeCompare(bStr, 'pt', { sensitivity: 'base' });
                
                // Retorna o resultado baseado na direção (ASC ou DESC)
                return direcao === 'asc' ? resultadoComparacao : resultadoComparacao * -1;
            }                
        });

        estadoOrdenacao.coluna = coluna;
        estadoOrdenacao.direcao = direcao;

        atualizarIndicadoresOrdenacao();
        renderizarTabela();
        
        paginaAtual = 1; 
    }

    function atualizarIndicadoresOrdenacao() {
        // 1. Remove classes de todas as colunas
        document.querySelectorAll('.coluna-ordenavel').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            th.setAttribute('aria-sort', 'none');
        });

        // 2. Adiciona a classe de ordenação na coluna que foi clicada
        const th = document.querySelector(`th[data-coluna="${estadoOrdenacao.coluna}"]`);
        if (th) {
            th.classList.add(`sorted-${estadoOrdenacao.direcao}`);
            th.setAttribute('aria-sort', estadoOrdenacao.direcao === 'asc' ? 'ascending' : 'descending');
        }
    }

    function popularSelect(selectId, options, selectedValue) {
        const select = document.getElementById(selectId);
        if (!select) return;

        // Adiciona a opção padrão 'Selecione...'
        select.innerHTML = '<option value="">Selecione...</option>'; 
        
        if (options && options.length) {
            // Mapeia para um array de strings se for um array de objetos com a propriedade 'nome'
            let optionsToIterate = options;

            if (options.length > 0 && typeof options[0] === 'object' && options[0] !== null && 'nome' in options[0]) {
                // Se for um array de objetos (como fornecedores/categorias), mapeia para um array de nomes (strings)
                optionsToIterate = options.map(item => item.nome);
            }
            
            // Remove duplicatas e garante que a lista esteja em ordem
            const uniqueOptions = [...new Set(optionsToIterate)].sort();
            
            uniqueOptions.forEach(option => {
                // Agora 'option' é sempre uma string (o nome ou a própria string)
                if (option) { 
                    const element = document.createElement('option');
                    element.value = option;
                    element.textContent = option;
                    
                    // Comparação é feita com a string (nome do fornecedor/categoria)
                    if (String(option) === String(selectedValue)) {
                        element.selected = true;
                    }
                    select.appendChild(element);
                }
            });
        }
    }

    function abrirModalEdicaoProduto(id) {
        const produto = precos.find(p => p.id === id);

        if (!produto) {
            mostrarNotificacao('Erro: Produto não encontrado com o ID: ' + id);
            return;
        }

        // Usando o operador de coalescência nula (?? []) para garantir que é sempre um array
        const listaFornecedores = fornecedores ?? [];
        const listaCategorias = categorias ?? [];


        // 1. FILTRA e MAPEIA os Fornecedores para um array de strings (nomes)
        // Se listaFornecedores for vazia, nomesFornecedoresAtivos será [] (vazia), o que é seguro.
        const nomesFornecedoresAtivos = listaFornecedores
            .filter(f => f.status === 'Ativo')
            .map(f => f.nome);

        // 2. FILTRA e MAPEIA as Categorias para um array de strings (nomes)
        const nomesCategoriasAtivas = listaCategorias
            .filter(c => c.status === 'Ativo')
            .map(c => c.nome);

        // Popula os selects com os arrays de nomes (strings)
        // CORREÇÃO: A função popularSelect foi removida para usar a função padrão que já lida com o status 'Ativo'
        atualizarSelects(); // Garante que os selects de fornecedor/categoria estejam atualizados
        atualizarSelectsUnidadeMedida(); // Garante que o select de unidade de medida esteja atualizado

        popularSelect('edicaoFornecedorProduto', nomesFornecedoresAtivos, produto.fornecedor);
        popularSelect('edicaoCategoriaProduto', nomesCategoriasAtivas, produto.categoria);
        popularSelect('edicaoStatusProduto', ['Ativo', 'Inativo'], produto.status);

        // Popula os campos de texto
        document.getElementById('edicaoCodigoProdutoHidden').value = produto.id; // Armazena o ID do Firestore
        document.getElementById('edicaoCodigoProduto').value = produto.codigo;
        document.getElementById('edicaoDescricaoProduto').value = produto.descricao;
        document.getElementById('edicaoCorProduto').value = produto.cor || '';
        document.getElementById('edicaoPrecoCompraProduto').value = produto.precoCompra;
        // CORREÇÃO CRÍTICA: Define o valor da unidade de medida antes de ajustar os campos
        document.getElementById('edicaoUnidadeMedidaProduto').value = produto.unidadeMedida;

        document.getElementById('edicaoMarkupProduto').value = produto.markup;
        
        // Popula o novo campo de Largura Padrão no modal
        const alturaPadraoModalInput = document.getElementById('edicaoAlturaPadraoProduto');
        alturaPadraoModalInput.value = produto.alturaPadrao || ''; // CORREÇÃO: Garante que o valor salvo seja carregado
        
        // NOVO: Chama a função para ajustar a visibilidade dos campos no momento em que o modal é aberto
        ajustarCamposEdicaoProduto();

        abrirModal('modalEdicaoProduto');
    }

    async function salvarEdicaoProduto() {
        const id = document.getElementById('edicaoCodigoProdutoHidden').value; // Este é o ID do documento do Firestore
        const codigo = document.getElementById('edicaoCodigoProduto').value.trim().toUpperCase();
        const descricao = document.getElementById('edicaoDescricaoProduto').value.trim();
        const cor = document.getElementById('edicaoCorProduto').value.trim();
        const fornecedor = document.getElementById('edicaoFornecedorProduto').value;
        const categoria = document.getElementById('edicaoCategoriaProduto').value;
        const precoCompra = parseFloat(document.getElementById('edicaoPrecoCompraProduto').value);
        const markup = parseFloat(document.getElementById('edicaoMarkupProduto').value);
        const status = document.getElementById('edicaoStatusProduto').value;

        const unidadeMedida = document.getElementById('edicaoUnidadeMedidaProduto').value;
        let alturaPadrao = null;
        if (normalizarUnidadeMedida(unidadeMedida) === 'MetroLinear') {
            const alturaPadraoInput = document.getElementById('edicaoAlturaPadraoProduto');
            alturaPadrao = parseFloat(alturaPadraoInput.value);
        }

        if (!id || !codigo || !descricao || isNaN(precoCompra) || isNaN(markup)) {
            mostrarNotificacao('Preencha todos os campos obrigatórios corretamente.');
            return;
        }

        const erroValidacaoProduto = validarParametrosProduto({ precoCompra, markup, unidadeMedida, alturaPadrao });
        if (erroValidacaoProduto) {
            mostrarNotificacao(erroValidacaoProduto);
            const campoInvalido = precoCompra <= 0
                ? document.getElementById('edicaoPrecoCompraProduto')
                : markup <= 0
                    ? document.getElementById('edicaoMarkupProduto')
                    : document.getElementById('edicaoAlturaPadraoProduto');
            campoInvalido.focus();
            return;
        }

        const produtoData = {
            codigo,
            descricao,
            cor,
            fornecedor,
            categoria,
            unidadeMedida,
            alturaPadrao,
            precoCompra,
            markup,
            precoFinal: calcularPrecoFinal(precoCompra, markup),
            status
        };

        try {
            // --- ATUALIZAR PRODUTO (UPDATE) ---
            const produtoRef = doc(db, "precos", id);
            await updateDoc(produtoRef, produtoData);

            fecharModalEdicaoProduto(); // O listener irá atualizar a UI
            mostrarNotificacao(`Produto ${codigo} atualizado com sucesso!`);

        } catch (error) {
            console.error("Erro ao atualizar produto no Firestore: ", error);
            mostrarNotificacao("Ocorreu um erro ao salvar as alterações. Tente novamente.");
        }
    }

    function fecharModalEdicaoProduto() {
        // 1. Remove a classe active para ocultar o modal
        fecharModal('modalEdicaoProduto');
        
        // 2. Limpa os campos do formulário
        document.getElementById('edicaoCodigoProdutoHidden').value = '';
        document.getElementById('edicaoCodigoProduto').value = '';
        document.getElementById('edicaoDescricaoProduto').value = '';
        document.getElementById('edicaoPrecoCompraProduto').value = '';
        document.getElementById('edicaoMarkupProduto').value = '';
        document.getElementById('edicaoCorProduto').value = '';

        // Opcional: Reseta selects para a primeira opção (ou 'Selecione...')
        document.getElementById('edicaoFornecedorProduto').selectedIndex = 0;
        document.getElementById('edicaoCategoriaProduto').selectedIndex = 0;
        document.getElementById('edicaoUnidadeMedidaProduto').selectedIndex = 0;
        document.getElementById('edicaoStatusProduto').selectedIndex = 0;
    }

    function ajustarCamposCadastroPorUnidade() {
        const unidadeMedida = document.getElementById('unidadeMedida').value;
        const formGroupAlturaPadrao = document.getElementById('formGroupAlturaPadrao');
        const alturaPadraoInput = document.getElementById('alturaPadrao');

        // O campo "Altura Padrão" deve aparecer se a unidade for "MetroLinear" OU a categoria for "Tecidos".
        if (normalizarUnidadeMedida(unidadeMedida) === 'MetroLinear') {
            formGroupAlturaPadrao.style.display = 'flex';
            alturaPadraoInput.required = true; 
        } else {
            formGroupAlturaPadrao.style.display = 'none';
            alturaPadraoInput.required = false;
            alturaPadraoInput.value = ''; // Limpa o valor para evitar envio acidental
        }
    }

    function ajustarCamposEdicaoProduto() {
        const unidadeMedida = document.getElementById('edicaoUnidadeMedidaProduto').value;
        const formGroupAlturaPadrao = document.getElementById('formGroupEdicaoAlturaPadrao');
        const alturaPadraoInput = document.getElementById('edicaoAlturaPadraoProduto');

        // O campo "Altura Padrão" deve aparecer se a unidade for "MetroLinear" OU a categoria for "Tecidos".
        if (normalizarUnidadeMedida(unidadeMedida) === 'MetroLinear') {
            formGroupAlturaPadrao.style.display = 'flex';
        } else {
            formGroupAlturaPadrao.style.display = 'none';
            alturaPadraoInput.required = false;
            alturaPadraoInput.value = '';
        }
    }

    // Adiciona as funções ao escopo global para que o onchange do HTML possa encontrá-las
    window.ajustarCamposCadastroPorUnidade = ajustarCamposCadastroPorUnidade;
    window.ajustarCamposEdicaoProduto = ajustarCamposEdicaoProduto;
    window.atualizarPreviewCalculoEdicao = atualizarPreviewCalculoEdicao; // CORREÇÃO: Expõe a função para o HTML
    // Funções de Gerenciamento (Modais)
    const focoAnteriorPorModal = new WeakMap();

    function abrirModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;

        focoAnteriorPorModal.set(modal, document.activeElement);
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');

        window.requestAnimationFrame(() => {
            const primeiroCampo = modal.querySelector('input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)')
                || modal.querySelector('button:not(:disabled)');
            primeiroCampo?.focus();
        });
    }

    function fecharModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;

        modal.classList.remove('active');
        modal.removeAttribute('style');
        modal.setAttribute('aria-hidden', 'true');

        const focoAnterior = focoAnteriorPorModal.get(modal);
        if (focoAnterior instanceof HTMLElement && document.contains(focoAnterior)) focoAnterior.focus();
        focoAnteriorPorModal.delete(modal);
    }

    function prepararAcessibilidadeModais() {
        document.querySelectorAll('.modal').forEach((modal, indice) => {
            modal.setAttribute('aria-hidden', 'true');
            const titulo = modal.querySelector('h2');
            if (titulo) {
                titulo.id ||= `titulo-modal-${indice + 1}`;
                modal.setAttribute('aria-labelledby', titulo.id);
            }
        });

        document.addEventListener('keydown', (event) => {
            const modaisAbertos = [...document.querySelectorAll('.modal.active')];
            const modal = modaisAbertos.at(-1);
            if (!modal) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                modal.querySelector('.close-button')?.click();
                return;
            }

            if (event.key !== 'Tab') return;
            const elementosFocaveis = [...modal.querySelectorAll(
                'button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
            )].filter(elemento => elemento.offsetParent !== null);

            if (elementosFocaveis.length === 0) {
                event.preventDefault();
                return;
            }

            const primeiro = elementosFocaveis[0];
            const ultimo = elementosFocaveis.at(-1);
            if (event.shiftKey && document.activeElement === primeiro) {
                event.preventDefault();
                ultimo.focus();
            } else if (!event.shiftKey && document.activeElement === ultimo) {
                event.preventDefault();
                primeiro.focus();
            }
        });
    }

    // --- INÍCIO: CRUD DE FORNECEDORES (FASE 3.2) ---

    function gerenciarFornecedores() {
        abrirModal('modalGerenciarFornecedores');
        renderizarListaFornecedores();
    }

    async function toggleStatusFornecedor(id) {
        const fornecedor = fornecedores.find(f => f.id === id);
        if (fornecedor) {
            const novoStatus = fornecedor.status === 'Ativo' ? 'Inativo' : 'Ativo';
            try {
                const fornecedorRef = doc(db, "fornecedores", id);
                await updateDoc(fornecedorRef, { status: novoStatus });
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao atualizar status do fornecedor:", error);
                mostrarNotificacao("Não foi possível atualizar o status do fornecedor.");
            }
        }
    }

    async function adicionarFornecedorModal() {
        const nome = document.getElementById('novoFornecedorModal').value.trim();
        if (nome && !fornecedores.some(f => f.nome.toLowerCase() === nome.toLowerCase())) {
            const novoFornecedor = { nome: nome, status: 'Ativo' };
            try {
                await addDoc(collection(db, "fornecedores"), novoFornecedor);
                document.getElementById('novoFornecedorModal').value = '';
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao adicionar fornecedor:", error);
                mostrarNotificacao("Não foi possível adicionar o novo fornecedor.");
            }
        } else {
            mostrarNotificacao("O nome do fornecedor não pode ser vazio ou já existe.");
        }
    }

    function abrirModalEdicaoFornecedor(id, nomeAtual) {
        document.getElementById('edicaoFornecedorNomeAntigo').setAttribute('data-id', id);
        document.getElementById('edicaoFornecedorNomeAntigo').value = nomeAtual;
        document.getElementById('edicaoFornecedorNomeNovo').value = nomeAtual;
        abrirModal('modalEdicaoFornecedor');
    }

    function fecharModalEdicaoFornecedor() {            
        document.getElementById('edicaoFornecedorNomeAntigo').removeAttribute('data-id');
        document.getElementById('edicaoFornecedorNomeAntigo').value = '';
        document.getElementById('edicaoFornecedorNomeNovo').value = '';
        fecharModal('modalEdicaoFornecedor');
    }

    async function salvarEdicaoFornecedor() {
        const id = document.getElementById('edicaoFornecedorNomeAntigo').getAttribute('data-id');
        const nomeAntigo = document.getElementById('edicaoFornecedorNomeAntigo').value; 
        const nomeNovo = document.getElementById('edicaoFornecedorNomeNovo').value.trim();

        if (!nomeNovo) {
            mostrarNotificacao('O novo nome do fornecedor não pode ser vazio.');
            return;
        }
        if (nomeAntigo.toLowerCase() === nomeNovo.toLowerCase()) {
            fecharModalEdicaoFornecedor();
            return;
        }

        try {
            // 1. Atualiza o nome no documento do fornecedor
            const fornecedorRef = doc(db, "fornecedores", id);
            await updateDoc(fornecedorRef, { nome: nomeNovo });

            // 2. Atualiza o nome em todos os produtos que usam este fornecedor (operação em lote)
            const batch = writeBatch(db);
            const q = query(collection(db, "precos"), where("fornecedor", "==", nomeAntigo));
            const querySnapshot = await getDocs(q);
            querySnapshot.forEach((doc) => {
                batch.update(doc.ref, { fornecedor: nomeNovo });
            });
            await batch.commit();

            // 3. Atualiza os dados locais para refletir na UI
            const fornecedorLocal = fornecedores.find(f => f.id === id);
            if (fornecedorLocal) fornecedorLocal.nome = nomeNovo;
            precos.forEach(p => { if (p.fornecedor === nomeAntigo) p.fornecedor = nomeNovo; });

            fecharModalEdicaoFornecedor();
            mostrarNotificacao(`Fornecedor "${nomeAntigo}" alterado para "${nomeNovo}" com sucesso!`);
        } catch (error) {
            console.error("Erro ao salvar edição do fornecedor:", error);
            mostrarNotificacao("Ocorreu um erro ao salvar as alterações.");
        }
    }

    async function removerFornecedorModal(id, nome) {
        const produtosUsando = precos.filter(p => p.fornecedor === nome);
        if (produtosUsando.length > 0) {
            mostrarNotificacao(`Não é possível excluir o fornecedor "${nome}", pois ele está sendo usado em ${produtosUsando.length} produto(s). Por favor, inative-o ou altere os produtos primeiro.`);
            return;
        }

        if (confirm(`Tem certeza que deseja excluir o fornecedor "${nome}"? Esta ação não pode ser desfeita.`)) {
            try {
                await deleteDoc(doc(db, "fornecedores", id));
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao remover fornecedor:", error);
                mostrarNotificacao("Não foi possível remover o fornecedor.");
            }
        }
    }

    function renderizarListaFornecedores() {
        const lista = document.getElementById('listaFornecedoresModal'); 
        if (!lista) {
            console.error("Elemento 'listaFornecedoresModal' não encontrado.");
            return;
        }
        lista.innerHTML = '';
        
        fornecedores.forEach(f => {
            const isAtivo = f.status === 'Ativo';
            const statusClass = isAtivo ? 'status-ativo' : 'status-inativo';
            const buttonText = isAtivo ? 'Inativar' : 'Ativar';
            const buttonClass = isAtivo ? 'btn-secondary' : 'btn-success';
            
            const li = document.createElement('li');
            const itemDiv = document.createElement('div');
            itemDiv.className = 'management-item';
            itemDiv.innerHTML = `<span class="${statusClass}" style="font-weight: bold;">${f.nome}</span>`;

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'management-actions';
            actionsDiv.appendChild(createButton(buttonText, buttonClass, () => toggleStatusFornecedor(f.id)));
            actionsDiv.appendChild(createButton('Editar', 'btn-warning', () => abrirModalEdicaoFornecedor(f.id, f.nome)));
            actionsDiv.appendChild(createButton('Excluir', 'btn-danger', () => removerFornecedorModal(f.id, f.nome)));

            itemDiv.appendChild(actionsDiv);
            li.appendChild(itemDiv);
            lista.appendChild(li);
        });
    }

    // --- FIM: CRUD DE FORNECEDORES ---

    // --- INÍCIO: CRUD DE CATEGORIAS (FASE 3.2) ---

    function gerenciarCategorias() {
        abrirModal('modalGerenciarCategorias');
        renderizarListaCategorias(); 
    }

    async function toggleStatusCategoria(id) {
        const categoria = categorias.find(c => c.id === id);
        if (categoria) {
            const novoStatus = categoria.status === 'Ativo' ? 'Inativo' : 'Ativo';
            try {
                await updateDoc(doc(db, "categorias", id), { status: novoStatus });
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao atualizar status da categoria:", error);
                mostrarNotificacao("Não foi possível atualizar o status da categoria.");
            }
        }
    }

    async function adicionarCategoriaModal() {
        const nome = document.getElementById('novaCategoriaModal').value.trim();
        if (nome && !categorias.some(c => c.nome.toLowerCase() === nome.toLowerCase())) {
            const novaCategoria = { nome: nome, status: 'Ativo' };
            try {
                await addDoc(collection(db, "categorias"), novaCategoria);
                document.getElementById('novaCategoriaModal').value = '';
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao adicionar categoria:", error);
                mostrarNotificacao("Não foi possível adicionar a nova categoria.");
            }
        } else {
            mostrarNotificacao('O nome da categoria não pode ser vazio ou já existe.');
        }
    }

    function abrirModalEdicaoCategoria(id, nomeAtual) {
        document.getElementById('edicaoCategoriaNomeAntigo').setAttribute('data-id', id);
        document.getElementById('edicaoCategoriaNomeAntigo').value = nomeAtual;
        document.getElementById('edicaoCategoriaNomeNovo').value = nomeAtual;
        abrirModal('modalEdicaoCategoria');
    }

    function fecharModalEdicaoCategoria() {            
        document.getElementById('edicaoCategoriaNomeAntigo').removeAttribute('data-id');
        document.getElementById('edicaoCategoriaNomeAntigo').value = '';
        document.getElementById('edicaoCategoriaNomeNovo').value = '';
        fecharModal('modalEdicaoCategoria');
    }

    async function salvarEdicaoCategoria() {
        const id = document.getElementById('edicaoCategoriaNomeAntigo').getAttribute('data-id');
        const nomeAntigo = document.getElementById('edicaoCategoriaNomeAntigo').value;
        const nomeNovo = document.getElementById('edicaoCategoriaNomeNovo').value.trim();

        if (!nomeNovo) {
            mostrarNotificacao('O novo nome da categoria não pode ser vazio.');
            return;
        }
        if (nomeAntigo.toLowerCase() === nomeNovo.toLowerCase()) {
            fecharModalEdicaoCategoria();
            return;
        }

        try {
            const batch = writeBatch(db);
            const categoriaRef = doc(db, "categorias", id);
            batch.update(categoriaRef, { nome: nomeNovo });

            const q = query(collection(db, "precos"), where("categoria", "==", nomeAntigo));
            const querySnapshot = await getDocs(q);
            querySnapshot.forEach((doc) => {
                batch.update(doc.ref, { categoria: nomeNovo });
            });
            await batch.commit();

            const categoriaLocal = categorias.find(c => c.id === id);
            if (categoriaLocal) categoriaLocal.nome = nomeNovo;
            precos.forEach(p => { if (p.categoria === nomeAntigo) p.categoria = nomeNovo; });

            fecharModalEdicaoCategoria();
            mostrarNotificacao(`Categoria "${nomeAntigo}" alterada para "${nomeNovo}" com sucesso!`);
        } catch (error) {
            console.error("Erro ao salvar edição da categoria:", error);
            mostrarNotificacao("Ocorreu um erro ao salvar as alterações.");
        }
    }

    async function removerCategoriaModal(id, nome) {
        const produtosUsando = precos.filter(p => p.categoria === nome);
        if (produtosUsando.length > 0) {
            mostrarNotificacao(`Não é possível excluir a categoria "${nome}", pois ela está sendo usada em ${produtosUsando.length} produto(s). Por favor, inative-a ou altere os produtos primeiro.`);
            return;
        }
        if (confirm(`Tem certeza que deseja excluir a categoria "${nome}"?`)) {
            try {
                await deleteDoc(doc(db, "categorias", id));
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao remover categoria:", error);
                mostrarNotificacao("Não foi possível remover a categoria.");
            }
        }
    }

    function renderizarListaCategorias() {
        const lista = document.getElementById('listaCategoriasModal');
        
        if (!lista) {
            console.error("ERRO DE ID: Elemento 'listaCategoriasModal' não encontrado.");
            return; 
        }
        
        lista.innerHTML = '';
        
        categorias.forEach(c => {
            const isAtivo = c.status === 'Ativo';
            const statusClass = isAtivo ? 'status-ativo' : 'status-inativo';
            const buttonText = isAtivo ? 'Inativar' : 'Ativar';
            const buttonClass = isAtivo ? 'btn-secondary' : 'btn-success';

                const li = document.createElement('li');
                const itemDiv = document.createElement('div');
                itemDiv.className = 'management-item';
                itemDiv.innerHTML = `<span class="${statusClass}" style="font-weight: bold;">${c.nome}</span>`;

                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'management-actions';
                actionsDiv.appendChild(createButton(buttonText, buttonClass, () => toggleStatusCategoria(c.id)));
                actionsDiv.appendChild(createButton('Editar', 'btn-warning', () => abrirModalEdicaoCategoria(c.id, c.nome)));
                actionsDiv.appendChild(createButton('Excluir', 'btn-danger', () => removerCategoriaModal(c.id, c.nome)));

                itemDiv.appendChild(actionsDiv);
                li.appendChild(itemDiv);
            lista.appendChild(li);
        });
    }

    // --- FIM: CRUD DE CATEGORIAS ---

    // --- INÍCIO: CRUD DE UNIDADES DE MEDIDA (FASE 3.2) ---

    function renderizarListaUnidadesMedida() {
        const lista = document.getElementById('listaUnidadesMedidaModal');
        if (!lista) {
            console.error("Elemento 'listaUnidadesMedidaModal' não encontrado.");
            return;
        }
        lista.innerHTML = '';
        
        const unidadesOrdenadas = [...unidadesDeMedida].sort((a, b) => {
            if (a.status === b.status) return a.nome.localeCompare(b.nome);
            return a.status === 'Ativo' ? -1 : 1;
        });

        unidadesOrdenadas.forEach(u => {
            const isAtivo = u.status === 'Ativo';
            const statusClass = isAtivo ? 'status-ativo' : 'status-inativo';
            const buttonText = isAtivo ? 'Inativar' : 'Ativar';
            const buttonClass = isAtivo ? 'btn-secondary' : 'btn-success';

                const li = document.createElement('li');
                const itemDiv = document.createElement('div');
                itemDiv.className = 'management-item';
                itemDiv.innerHTML = `<span class="${statusClass}" style="font-weight: bold;">${u.nome}</span>`;

                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'management-actions';
                actionsDiv.appendChild(createButton(buttonText, buttonClass, () => toggleStatusUnidadeMedida(u.id)));
                actionsDiv.appendChild(createButton('Editar', 'btn-warning', () => abrirModalEdicaoUnidadeMedida(u.id, u.nome)));
                actionsDiv.appendChild(createButton('Excluir', 'btn-danger', () => removerUnidadeMedidaModal(u.id, u.nome)));

                itemDiv.appendChild(actionsDiv);
                li.appendChild(itemDiv);
            lista.appendChild(li);
        });
    }

    async function toggleStatusUnidadeMedida(id) {
        const unidade = unidadesDeMedida.find(u => u.id === id);
        if (unidade) {
            const novoStatus = unidade.status === 'Ativo' ? 'Inativo' : 'Ativo';
            try {
                await updateDoc(doc(db, "unidadesDeMedida", id), { status: novoStatus });
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao atualizar status da unidade:", error);
                mostrarNotificacao("Não foi possível atualizar o status da unidade.");
            }
        }
    }

    async function adicionarUnidadeMedidaModal() {
        const nome = document.getElementById('novaUnidadeMedidaModal').value.trim();
        if (nome && !unidadesDeMedida.some(u => u.nome.toLowerCase() === nome.toLowerCase())) {
            const novaUnidade = { nome: nome, status: 'Ativo' };
            try {
                await addDoc(collection(db, "unidadesDeMedida"), novaUnidade);
                document.getElementById('novaUnidadeMedidaModal').value = '';
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao adicionar unidade:", error);
                mostrarNotificacao("Não foi possível adicionar a nova unidade.");
            }
        } else {
            mostrarNotificacao("A unidade de medida não pode ser vazia ou já existe.");
        }
    }

    async function removerUnidadeMedidaModal(id, nome) {
        const produtosUsando = precos.filter(p => p.unidadeMedida === nome);
        if (produtosUsando.length > 0) {
            mostrarNotificacao(`Não é possível excluir a unidade "${nome}", pois ela está sendo usada em ${produtosUsando.length} produto(s). Por favor, inative-a ou altere os produtos primeiro.`);
            return;
        }
        if (confirm(`Tem certeza que deseja excluir a unidade "${nome}"?`)) {
            try {
                await deleteDoc(doc(db, "unidadesDeMedida", id));
                // O listener irá atualizar a UI
            } catch (error) {
                console.error("Erro ao remover unidade:", error);
                mostrarNotificacao("Não foi possível remover a unidade.");
            }
        }
    }

    function gerenciarUnidadesMedida() {
        abrirModal('modalGerenciarUnidadesMedida');
        renderizarListaUnidadesMedida();
    }

    function abrirModalEdicaoUnidadeMedida(id, nomeAntigo) {
        document.getElementById('edicaoUnidadeMedidaNomeAntigo').setAttribute('data-id', id);
        document.getElementById('edicaoUnidadeMedidaNomeAntigo').value = nomeAntigo;
        document.getElementById('edicaoUnidadeMedidaNomeNovo').value = nomeAntigo;
        abrirModal('modalEdicaoUnidadeMedida');
    }

    function fecharModalEdicaoUnidadeMedida() {
        document.getElementById('edicaoUnidadeMedidaNomeAntigo').removeAttribute('data-id');
        document.getElementById('edicaoUnidadeMedidaNomeAntigo').value = '';
        document.getElementById('edicaoUnidadeMedidaNomeNovo').value = '';
        fecharModal('modalEdicaoUnidadeMedida');
    }

    async function salvarEdicaoUnidadeMedida() {
        const id = document.getElementById('edicaoUnidadeMedidaNomeAntigo').getAttribute('data-id');
        const nomeAntigo = document.getElementById('edicaoUnidadeMedidaNomeAntigo').value;
        const nomeNovo = document.getElementById('edicaoUnidadeMedidaNomeNovo').value.trim();

        if (!nomeNovo) {
            mostrarNotificacao('O novo nome da unidade não pode ser vazio.');
            return;
        }
        if (nomeAntigo.toLowerCase() === nomeNovo.toLowerCase()) {
            fecharModalEdicaoUnidadeMedida();
            return;
        }

        try {
            const batch = writeBatch(db);
            const unidadeRef = doc(db, "unidadesDeMedida", id);
            batch.update(unidadeRef, { nome: nomeNovo });

            const q = query(collection(db, "precos"), where("unidadeMedida", "==", nomeAntigo));
            const querySnapshot = await getDocs(q);
            querySnapshot.forEach((doc) => {
                batch.update(doc.ref, { unidadeMedida: nomeNovo });
            });
            await batch.commit();

            const unidadeLocal = unidadesDeMedida.find(u => u.id === id);
            if (unidadeLocal) unidadeLocal.nome = nomeNovo;
            precos.forEach(p => { if (p.unidadeMedida === nomeAntigo) p.unidadeMedida = nomeNovo; });

            fecharModalEdicaoUnidadeMedida();
            mostrarNotificacao(`Unidade "${nomeAntigo}" alterada para "${nomeNovo}" com sucesso!`);
        } catch (error) {
            console.error("Erro ao salvar edição da unidade:", error);
            mostrarNotificacao("Ocorreu um erro ao salvar as alterações.");
        }
    }
    // --- FIM: CRUD DE UNIDADES DE MEDIDA ---
    
    // --- INÍCIO: FUNÇÕES DE IMPORTAÇÃO CSV ---

    let csvDataParaImportar = [];

    function handleCSVFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            const text = e.target.result;
            const parsedData = parseCSV(text);
            if (parsedData.length > 0) {
                abrirModalPreviewCSV(parsedData);
            } else {
                mostrarNotificacao("O arquivo CSV está vazio ou em um formato inválido.");
            }
        };
        reader.readAsText(file, 'UTF-8');
        event.target.value = ''; // Permite selecionar o mesmo arquivo novamente
    }

    function parseCSV(text) {
        const lines = text.replace(/\r/g, '').split('\n');
        if (lines.length < 2) return [];

        const headers = lines[0].split(';').map(h => h.trim());
        const data = [];

        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '') continue;
            const values = lines[i].split(';');
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index] ? values[index].trim() : '';
            });
            data.push(row);
        }
        return data;
    }

    function validarLinhaCSV(rowData, index, allData, existingCodes) {
        let errors = [];
        const validUnidades = unidadesDeMedida.map(u => u.nome); // Pega unidades do sistema
        const validUnidadesNormalizadas = new Set(validUnidades.map(normalizarUnidadeMedida));
        const validStatus = ['Ativo', 'Inativo'];
        const precoCompra = parseFloat(String(rowData.precoCompra || '').replace(',', '.'));
        const markup = parseFloat(String(rowData.markup || '').replace(',', '.'));
        
        if (!rowData.codigo) errors.push("'codigo' é obrigatório.");
        if (!rowData.descricao) errors.push("'descricao' é obrigatória.");
        if (!rowData.precoCompra) errors.push("'precoCompra' é obrigatório.");
        if (!rowData.markup) errors.push("'markup' é obrigatório.");
        if (isNaN(precoCompra)) errors.push("'precoCompra' deve ser um número.");
        else if (precoCompra <= 0) errors.push("'precoCompra' deve ser maior que zero.");
        if (isNaN(markup)) errors.push("'markup' deve ser um número.");
        else if (markup <= 0) errors.push("'markup' deve ser maior que zero.");
        if (rowData.unidadeMedida && !validUnidadesNormalizadas.has(normalizarUnidadeMedida(rowData.unidadeMedida))) errors.push(`'unidadeMedida' inválida.`);
        if (rowData.status && !validStatus.includes(rowData.status)) errors.push(`'status' inválido. Use 'Ativo' ou 'Inativo'.`);
        if (normalizarUnidadeMedida(rowData.unidadeMedida) === 'MetroLinear') {
            if (!rowData.alturaPadrao) {
                errors.push("'alturaPadrao' é obrigatória para MetroLinear.");
            } else if (isNaN(parseFloat(rowData.alturaPadrao.replace(',', '.'))) || parseFloat(rowData.alturaPadrao.replace(',', '.')) <= 0) {
                errors.push("'alturaPadrao' deve ser um número maior que zero.");
            }
        }

        let action = 'create'; // Ação padrão é criar
        if (rowData.codigo) {
            const codigoUpper = rowData.codigo.toUpperCase();
            if (existingCodes.has(codigoUpper)) {
                action = 'update'; // Se o código existe, a ação será atualizar
            }
            if (allData.filter(d => d.codigo && d.codigo.toUpperCase() === codigoUpper).length > 1) {
                errors.push(`Código '${rowData.codigo}' está duplicado no CSV.`);
            }
        }

        return { isValid: errors.length === 0, errors: errors, action: action };
    }

    function abrirModalPreviewCSV(data) {
        const modal = document.getElementById('modalCSVPreview');
        const tableHead = modal.querySelector('#csvPreviewTable thead');
        const tableBody = modal.querySelector('#csvPreviewTable tbody');
        const summaryDiv = document.getElementById('csvValidationSummary');

        tableHead.innerHTML = '';
        tableBody.innerHTML = '';
        csvDataParaImportar = [];

        if (data.length === 0) return;

        const headers = Object.keys(data[0]);
        let headerRow = '<tr>';
        headers.forEach(h => headerRow += `<th>${h}</th>`);
        headerRow += '<th>Ação</th><th>Erros</th></tr>'; // Adiciona coluna "Ação"
        tableHead.innerHTML = headerRow;

        const existingCodes = new Set(precos.map(p => p.codigo.toUpperCase()));
        let totalValidos = 0;
        let totalInvalidos = 0;

        data.forEach((row, index) => {
            const validation = validarLinhaCSV(row, index, data, existingCodes);
            
            let dataRow = { ...row, validation, originalIndex: index };
            csvDataParaImportar.push(dataRow);
            
            const tr = document.createElement('tr');
            tr.id = `preview-row-${index}`;
            if (!validation.isValid) {
                tr.classList.add('invalid-row');
                totalInvalidos++;
            } else {
                totalValidos++;
            }

            let rowHtml = '';
            headers.forEach(header => {
                rowHtml += `<td contenteditable="true" onblur="atualizarLinhaPreview(this, ${index}, '${header}')">${row[header] || ''}</td>`;
            });

            // Coluna de Ação (Criar ou Atualizar)
            let actionHtml = '<td>';
            if (validation.action === 'update') {
                actionHtml += '<span class="badge badge-warning">Atualizar</span>';
            } else {
                actionHtml += '<span class="badge badge-success">Criar Novo</span>';
            }
            actionHtml += '</td>';

            let errorHtml = '<td class="error-cell">';
            if (!validation.isValid) {
                errorHtml += '<ul>' + validation.errors.map(e => `<li>${e}</li>`).join('') + '</ul>';
            }
            errorHtml += '</td>';
            tr.innerHTML = rowHtml + actionHtml + errorHtml;
            tableBody.appendChild(tr);
        });

        summaryDiv.style.display = 'block';
        summaryDiv.innerHTML = `Foram encontradas <strong>${data.length}</strong> linhas.<ul><li style="color: #1b5e20;"><strong>${totalValidos}</strong> linhas válidas.</li><li style="color: #c62828;"><strong>${totalInvalidos}</strong> linhas com erros.</li></ul>`;
        document.getElementById('btnImportarTodos').disabled = totalInvalidos > 0;
        abrirModal(modal.id);
    }

    function fecharModalPreviewCSV() {
        fecharModal('modalCSVPreview');
    }

    function atualizarLinhaPreview(cell, index, header) {
        const dataRow = csvDataParaImportar.find(d => d.originalIndex === index);
        dataRow[header] = cell.textContent.trim();

        const existingCodes = new Set(precos.map(p => p.codigo.toUpperCase()));
        const allCsvData = csvDataParaImportar.map(d => ({codigo: d.codigo}));
        const validation = validarLinhaCSV(dataRow, index, allCsvData, existingCodes);

        dataRow.validation = validation;
        
        const tr = document.getElementById(`preview-row-${index}`);
        const actionCell = tr.querySelector('td:nth-last-child(2)'); // A penúltima célula é a de Ação
        const errorCell = tr.querySelector('.error-cell');
        
        errorCell.innerHTML = '';
        if (!validation.isValid) {
            tr.classList.add('invalid-row');
            errorCell.innerHTML = '<ul>' + validation.errors.map(e => `<li>${e}</li>`).join('') + '</ul>';
        } else {
            tr.classList.remove('invalid-row');
        }

        // Atualiza a célula de Ação
        if (validation.action === 'update') {
            actionCell.innerHTML = '<span class="badge badge-warning">Atualizar</span>';
        } else {
            actionCell.innerHTML = '<span class="badge badge-success">Criar Novo</span>';
        }

        const totalInvalidos = csvDataParaImportar.filter(d => !d.validation.isValid).length;
        document.getElementById('btnImportarTodos').disabled = totalInvalidos > 0;
    }

    function importarCSV() {
        let fileInput = document.getElementById('importarCSVInput');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'importarCSVInput';
            fileInput.accept = '.csv';
            fileInput.style.display = 'none';
            fileInput.addEventListener('change', handleCSVFileSelect);
            document.body.appendChild(fileInput);
        }
        fileInput.click();
    }

    function baixarTemplateCSV() {
        const headers = "codigo;descricao;cor;fornecedor;categoria;unidadeMedida;alturaPadrao;precoCompra;markup;status";
        const exampleData = [
            "VL-01;Voil Liso Branco;Branco Gelo;Fornecedor A;Tecidos;MetroQuadrado;;28.50;3.0;Ativo",
            "RL-BLACKOUT;Rolô Blackout 100%;Cinza Escuro;Fornecedor B;Persianas;Unidade;;110.00;2.5;Ativo",
            "TR-SUISSO-MAX;Trilho Suísso Maxi Simples;Alumínio;Fornecedor C;Acessórios;MetroLinear;2.8;15.75;2.0;Ativo"
        ];
        
        const csvContent = headers + "\n" + exampleData.join("\n");

        const bom = "\uFEFF";
        const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
        
        const link = document.createElement("a");
        if (link.download !== undefined) { 
            const url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", "template_produtos_filippini.csv");
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
    }

    async function importarDadosDoPreview(importarApenasValidos = false) {
        const dadosParaProcessar = importarApenasValidos 
            ? csvDataParaImportar.filter(d => d.validation.isValid) 
            : csvDataParaImportar;

        if (!importarApenasValidos && dadosParaProcessar.some(d => !d.validation.isValid)) {
            mostrarNotificacao("Ainda existem linhas com erros. Corrija-as ou use 'Importar Apenas Válidos'.");
            return;
        }

        if (dadosParaProcessar.length === 0) {
            mostrarNotificacao("Nenhum produto válido para importar.");
            return;
        }

        try {
            const batch = writeBatch(db);
            let importados = 0;
            let atualizados = 0;
            let novosFornecedores = 0;
            let novasCategorias = 0;

            const fornecedoresExistentes = new Set(fornecedores.map(f => f.nome.toUpperCase()));
            const categoriasExistentes = new Set(categorias.map(c => c.nome.toUpperCase()));

            dadosParaProcessar.forEach(itemData => {
                const fornecedorNovo = itemData.fornecedor && itemData.fornecedor.trim();
                if (fornecedorNovo && !fornecedoresExistentes.has(fornecedorNovo.toUpperCase())) {
                    const novoFornecedorRef = doc(collection(db, "fornecedores"));
                    batch.set(novoFornecedorRef, { nome: fornecedorNovo, status: 'Ativo' });
                    fornecedoresExistentes.add(fornecedorNovo.toUpperCase());
                    novosFornecedores++;
                }

                const categoriaNova = itemData.categoria && itemData.categoria.trim();
                if (categoriaNova && !categoriasExistentes.has(categoriaNova.toUpperCase())) {
                    const novaCategoriaRef = doc(collection(db, "categorias"));
                    batch.set(novaCategoriaRef, { nome: categoriaNova, status: 'Ativo' });
                    categoriasExistentes.add(categoriaNova.toUpperCase());
                    novasCategorias++;
                }
                
                const precoCompraNum = parseFloat(itemData.precoCompra.replace(',','.'));
                const markupNum = parseFloat(itemData.markup.replace(',','.'));
                const alturaPadraoNum = itemData.alturaPadrao ? parseFloat(itemData.alturaPadrao.replace(',', '.')) : null;

                const dadosProduto = {
                    codigo: itemData.codigo.toUpperCase(), descricao: itemData.descricao, cor: itemData.cor || '',
                    fornecedor: fornecedorNovo || '', categoria: categoriaNova || '', unidadeMedida: itemData.unidadeMedida || 'Unidade',
                    alturaPadrao: alturaPadraoNum, precoCompra: precoCompraNum, markup: markupNum,
                    precoFinal: calcularPrecoFinal(precoCompraNum, markupNum), status: itemData.status || 'Ativo'
                };

                // LÓGICA DE ATUALIZAÇÃO OU CRIAÇÃO
                if (itemData.validation.action === 'update') {
                    // Encontra o produto existente para obter seu ID do Firestore
                    const produtoExistente = precos.find(p => p.codigo.toUpperCase() === dadosProduto.codigo);
                    if (produtoExistente) {
                        const produtoRef = doc(db, "precos", produtoExistente.id);
                        batch.update(produtoRef, dadosProduto);
                        atualizados++;
                    }
                } else { // action === 'create'
                    const novoProdutoRef = doc(collection(db, "precos"));
                    batch.set(novoProdutoRef, dadosProduto);
                    importados++;
                }
            });

            await batch.commit();
            let mensagem = `${importados} produto(s) criado(s) com sucesso!\n`;
            mensagem += `${atualizados} produto(s) atualizado(s) com sucesso!\n`;
            if (novosFornecedores > 0) mensagem += `${novosFornecedores} novo(s) fornecedor(es) cadastrado(s).\n`;
            if (novasCategorias > 0) mensagem += `${novasCategorias} nova(s) categoria(s) cadastrada(s).\n`;
            mostrarNotificacao(mensagem);
            fecharModalPreviewCSV();
        } catch (error) {
            console.error("Erro ao importar dados para o Firestore:", error);
            mostrarNotificacao("Ocorreu um erro durante a importação. Verifique o console para mais detalhes.");
        }
    }

    function limparDadosDoSistema() {
        if (confirm("ATENÇÃO! Esta ação irá apagar TODOS os dados do sistema. Esta ação não pode ser desfeita. Deseja continuar?")) {
            localStorage.clear();
            precos = [];
            fornecedores = [];
            categorias = [];
            orcamentosSalvos = {};
            orcamentoAtualId = null;
            mostrarNotificacao("Todos os dados do sistema foram apagados.");
            window.location.reload();
        }
    }

    function encontrarProximoIdSequencial(listaOrcamentos) {
        // 1. Checagem de segurança.
        if (typeof listaOrcamentos !== 'object' || listaOrcamentos === null) {
            return 'ORC-01';
        }

        // 2. Converte o objeto 'orcamentosSalvos' em um array para podermos iterar.
        const orcamentosArray = Object.values(orcamentosSalvos);

        if (orcamentosArray.length === 0) {
            return 'ORC-01';
        }

        // 3. Coleta, Filtra e Ordena os números dos IDs existentes
        const idsExistentes = orcamentosArray
            .map(o => {
                if (o && typeof o.id === 'string') {
                    const match = o.id.match(/^ORC-(\d+)$/);
                    return match ? parseInt(match[1], 10) : null;
                }
                return null;
            })
            .filter(n => n !== null)
            .sort((a, b) => a - b);

        let proximoNumero = 1;

        // 4. Procura pela lacuna (reutilização)
        for (const id of idsExistentes) {
            if (id === proximoNumero) {
                proximoNumero++;
            } else if (id > proximoNumero) {
                break;
            }
        }

        // 5. Formata o ID para ORC-XX
        return 'ORC-' + String(proximoNumero).padStart(2, '0');
    }

    async function reservarProximoIdSequencial() {
        const maiorNumeroLocal = Object.values(orcamentosSalvos)
            .map(orcamento => String(orcamento?.id || '').match(/^ORC-(\d+)$/))
            .filter(Boolean)
            .reduce((maior, match) => Math.max(maior, Number(match[1])), 0);
        const contadorRef = doc(db, 'contadores', 'orcamentos');

        return runTransaction(db, async transaction => {
            const snapshot = await transaction.get(contadorRef);
            const ultimoNumeroPersistido = snapshot.exists()
                ? Number(snapshot.data().ultimoNumero || 0)
                : 0;
            const proximoNumero = Math.max(ultimoNumeroPersistido, maiorNumeroLocal) + 1;

            transaction.set(contadorRef, {
                ultimoNumero: proximoNumero,
                atualizadoEm: new Date().toISOString()
            }, { merge: true });

            return `ORC-${String(proximoNumero).padStart(2, '0')}`;
        });
    }

    async function criarNovoOrcamento() {
        let newId;
        try {
            newId = await reservarProximoIdSequencial();
        } catch (error) {
            console.error('Erro ao reservar o número do orçamento:', error);
            mostrarNotificacao('Não foi possível reservar um número para o orçamento. Verifique a conexão e tente novamente.');
            return;
        }

        const dataAtual = new Date().toISOString().split('T')[0];

        const novoOrcamento = {
            id: newId,
            statusDocumento: 'orcamento',
            apresentacao: {
                modo: 'reduzida',
                mostrarValoresItens: false,
                mostrarCustosFornecedor: false
            },
            infoGerais: {
                "nome": `Orçamento ${newId}`, 
                "nomeCliente": "",
                "enderecoCliente": "",
                "celularCliente": "",
                "nomeComissionado": "",
                "celularComissionado": "",
                "dataOrcamento": dataAtual,
                "dataInstalacao": "", 
                "nomeCostureira": "",
                "enderecoCostureira": "",
                "nomeInstalador": "",
                "prazoValidade": "",
                "prazoEntrega": "30 dias úteis",
                "proximoFollowUp": "",
                "observacaoFollowUp": "",
                "observacoesGerais": ""
            },
            infoComercial: {
                "condicaoPagamento": "À vista",
                "formaPagamento": "PIX",
                "descontoGlobal": 0,
                // Fonte única da comissão; o tipo de cliente não é mais gravado.
                "percentualComissao": 0,
                "observacoesComerciais": ""
            },
            itens: [],
            produtosAcabados: []
        };
        
        try {
            // CORREÇÃO: Usar setDoc para definir nosso próprio ID sequencial como ID do documento.
            const orcamentoRef = doc(db, "orcamentos", newId);
            await setDoc(orcamentoRef, novoOrcamento);

            mostrarNotificacao(`Novo orçamento criado com ID: ${newId}.`);
            // O listener irá atualizar a UI
        } catch (error) {
            console.error("Erro ao criar novo orçamento no Firestore:", error);
            mostrarNotificacao("Falha ao criar novo orçamento. Tente novamente.");
        }
    }

    async function duplicarOrcamento() {
        if (!orcamentoAtualId) {
            mostrarNotificacao("Não há orçamento selecionado para duplicar.");
            return;
        }
        
        const orcamentoOriginal = orcamentosSalvos[orcamentoAtualId];
        
        if (orcamentoOriginal) {
            let newId;
            try {
                newId = await reservarProximoIdSequencial();
            } catch (error) {
                console.error('Erro ao reservar o número da cópia:', error);
                mostrarNotificacao('Não foi possível reservar um número para a cópia. Verifique a conexão e tente novamente.');
                return;
            }
            
            const novoOrcamento = criarOrcamentoDuplicado(orcamentoOriginal, {
                novoId: newId,
                dataOrcamento: new Date().toISOString().split('T')[0]
            });
            
            try {
                const orcamentoRef = doc(db, "orcamentos", newId);
                await setDoc(orcamentoRef, novoOrcamento);

                orcamentosSalvos[newId] = novoOrcamento;
                orcamentosPersistidos[newId] = structuredClone(novoOrcamento);
                orcamentoAtualId = newId;
                atualizarSeletoresOrcamento(newId);
                preencherInfoOrcamento();

                mostrarNotificacao(`Orçamento duplicado com sucesso para o novo ID: ${newId}.`);
            } catch (error) {
                console.error("Erro ao duplicar orçamento no Firestore:", error);
                mostrarNotificacao("Falha ao duplicar o orçamento. Tente novamente.");
            }
        } else {
            mostrarNotificacao("Erro ao encontrar o orçamento original para cópia.");
        }
    }

    async function excluirOrcamento() {
        // LÓGICA DE EXCLUSÃO ESTÁVEL: Impede a exclusão do último orçamento.
        if (!orcamentoAtualId || Object.keys(orcamentosSalvos).length <= 1) {
            mostrarNotificacao("Não é possível excluir o único orçamento existente.");
            return;
        }
        // Pedidos confirmados e orçamentos perdidos não são excluídos, mesmo que o botão seja acionado.
        const bloqueioExclusao = validarExclusaoOrcamento(orcamentosSalvos[orcamentoAtualId]);
        if (bloqueioExclusao) {
            mostrarNotificacao(bloqueioExclusao);
            return;
        }
        if (confirm("Tem certeza que deseja excluir este orçamento? Esta ação não pode ser desfeita.")) {
            try {
                await deleteDoc(doc(db, "orcamentos", orcamentoAtualId));
                
                // O listener irá remover o item do objeto local e atualizar a UI
                mostrarNotificacao("Orçamento excluído com sucesso!");
            } catch (error) {
                console.error("Erro ao excluir orçamento do Firestore:", error);
                mostrarNotificacao("Falha ao excluir o orçamento. Tente novamente.");
            }
        }
    }

    function exportarExcelLegado() {
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (!orcamento || (orcamento.itens.length === 0 && orcamento.produtosAcabados.length === 0)) {
            mostrarNotificacao("Nenhum item no orçamento para exportar.");
            return;
        }

        // Preparar dados agrupados por fornecedor
        const dadosProcessados = prepararDadosParaExportacao(orcamento);
        
        if (Object.keys(dadosProcessados).length === 0) {
            mostrarNotificacao("Nenhum fornecedor encontrado nos itens do orçamento.");
            return;
        }

        // Criar workbook
        const workbook = XLSX.utils.book_new();
        
        // Criar uma aba para cada fornecedor
        for (const fornecedor in dadosProcessados) {
            const dadosFornecedor = dadosProcessados[fornecedor];
            
            // Criar worksheet com formatação aprimorada
            const worksheet = criarWorksheetComFormatacaoAvancada(fornecedor, dadosFornecedor, orcamento);
            
            // Limitar nome da aba a 31 caracteres (limite do Excel)
            const nomeAba = fornecedor.length > 31 ? fornecedor.substring(0, 28) + '...' : fornecedor;
            XLSX.utils.book_append_sheet(workbook, worksheet, nomeAba);
        }

        // Gerar arquivo com nome padronizado
        const nomeCliente = orcamento.infoGerais.nomeCliente || 'Cliente';
        const dataAtual = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
        const nomeArquivo = `Pedido_Fornecedor_${orcamentoAtualId}_${dataAtual}.xlsx`;
        
        XLSX.writeFile(workbook, nomeArquivo);
        
        mostrarNotificacao(`Planilha Excel com formatação profissional gerada!\n${Object.keys(dadosProcessados).length} fornecedor(es) processado(s).`);
    }

    function prepararDadosParaExportacaoLegado(orcamento) {
        const todosOsItens = [];
        
        // Coletar itens dos produtos acabados
        orcamento.produtosAcabados.forEach(produto => {
            produto.itens.forEach(item => {
                todosOsItens.push(item);
            });
        });
        
        // Coletar itens avulsos
        if (orcamento.itens) {
            orcamento.itens.forEach(item => {
                todosOsItens.push(item);
            });
        }

        // Agrupar e somar por fornecedor e código
        const itensPorFornecedor = {};
        
        todosOsItens.forEach(item => {
            const produtoBase = precos.find(p => p.codigo === item.codigo);
            const fornecedor = produtoBase ? (produtoBase.fornecedor || 'Fornecedor Não Informado') : 'Produto Não Encontrado';
            const precoCompraUnitario = produtoBase ? parseFloat(produtoBase.precoCompra) : 0;
            
            // Calcular quantidade de compra baseada na unidade de medida
            const detalhes = calcularDetalhesItem(
                produtoBase,
                item.quantidade,
                item.largura,
                item.altura
            );
            const quantidadeCompra = detalhes.quantidadeCompra;

            // Chave única por fornecedor e código
            const chaveItem = `${fornecedor}|${item.codigo}`;
            
            if (!itensPorFornecedor[fornecedor]) {
                itensPorFornecedor[fornecedor] = {
                    itens: {},
                    totalCusto: 0
                };
            }

            if (itensPorFornecedor[fornecedor].itens[chaveItem]) {
                // Somar quantidades se o item já existe
                itensPorFornecedor[fornecedor].itens[chaveItem].quantidadeCompra += quantidadeCompra;
                itensPorFornecedor[fornecedor].itens[chaveItem].custoTotal = 
                    itensPorFornecedor[fornecedor].itens[chaveItem].quantidadeCompra * precoCompraUnitario;
            } else {
                // Criar novo item
                itensPorFornecedor[fornecedor].itens[chaveItem] = {
                    fornecedor: fornecedor,
                    codigo: item.codigo,
                    descricao: item.descricao,
                    unidadeMedida: produtoBase ? produtoBase.unidadeMedida : 'N/A',
                    quantidadeCompra: quantidadeCompra,
                    precoCompraUnitario: precoCompraUnitario,
                    custoTotal: quantidadeCompra * precoCompraUnitario
                };
            }

            // Recalcular total do fornecedor
            itensPorFornecedor[fornecedor].totalCusto = 
                Object.values(itensPorFornecedor[fornecedor].itens)
                    .reduce((sum, item) => sum + item.custoTotal, 0);
        });

        return itensPorFornecedor;
    }

    function criarWorksheetComFormatacaoAvancadaLegado(fornecedor, dadosFornecedor, orcamento) {
        // Calcular prazo de entrega para fornecedor
        function calcularPrazoFornecedor(prazoOriginal) {
            if (!prazoOriginal) return "A definir";
            const match = prazoOriginal.match(/(\d+)/);
            if (match) {
                const dias = parseInt(match[1]);
                const diasFornecedor = Math.max(1, dias - 10);
                return `${diasFornecedor} dias corridos`;
            }
            return "A definir";
        }

        const prazoFornecedor = calcularPrazoFornecedor(orcamento.infoGerais.prazoEntrega);

        // Preparar dados completos
        const dadosCompletos = [];
        
        // Cabeçalho da empresa com visual melhorado
        dadosCompletos.push(['🏢 FILIPPINI CORTINAS E DECORAÇÕES LTDA - ME', '', '', '', '', '', '']);
        dadosCompletos.push(['📋 CNPJ: 43.908.316/0001-99', '', '', '', '', '', '']);
        dadosCompletos.push(['👤 Contato: Marcello Machado', '', '', '', '', '', '']);
        dadosCompletos.push(['📱 Celular/WhatsApp: (11) 97389-3387', '', '', '', '', '', '']);
        dadosCompletos.push(['📧 E-mail: marcello66machado@gmail.com', '', '', '', '', '', '']);
        dadosCompletos.push(['👥 Facebook: https://www.facebook.com/filippinicortinas?locale=pt_BR', '', '', '', '', '', '']);
        dadosCompletos.push(['📸 Instagram: @filippinicortinas', '', '', '', '', '', '']);
        dadosCompletos.push(['🔖 Orçamento: ' + orcamentoAtualId, '', '', '', '', '', '']);
        dadosCompletos.push(['⏰ Prazo de Entrega: ' + prazoFornecedor, '', '', '', '', '', '']);
        dadosCompletos.push(['🏠 Endereço de entrega:', '', '', '', '', '', '']);
        dadosCompletos.push(['', '', '', '', '', '', '']); // Linha vazia
        dadosCompletos.push(['🎯 ═══ PEDIDO PARA: ' + fornecedor + ' ═══', '', '', '', '', '', '']);
        dadosCompletos.push(['', '', '', '', '', '', '']); // Linha vazia

        const headerRowIndex = dadosCompletos.length;

        // Cabeçalho da tabela
        dadosCompletos.push([
            'FORNECEDOR', 'CÓDIGO', 'DESCRIÇÃO', 'UNIDADE', 
            'QTD SOLICITADA', 'PREÇO UNITÁRIO', 'CUSTO TOTAL'
        ]);

        // Dados da tabela
        const itensArray = Object.values(dadosFornecedor.itens);
        const dataStartIndex = dadosCompletos.length;
        
        itensArray.forEach(item => {
            dadosCompletos.push([
                item.fornecedor,
                item.codigo,
                item.descricao,
                item.unidadeMedida,
                parseFloat(item.quantidadeCompra.toFixed(3)),
                parseFloat(item.precoCompraUnitario.toFixed(2)),
                parseFloat(item.custoTotal.toFixed(2))
            ]);
        });

        // Linhas vazias e total
        dadosCompletos.push(['', '', '', '', '', '', '']);
        const totalRowIndex = dadosCompletos.length;
        dadosCompletos.push([
            '💰 *** TOTAL GERAL ***',
            '',
            '🧮 Total de compra para ' + fornecedor,
            '',
            '',
            '',
            parseFloat(dadosFornecedor.totalCusto.toFixed(2))
        ]);

        // Criar worksheet
        const worksheet = XLSX.utils.aoa_to_sheet(dadosCompletos);

        // Aplicar formatação com abordagem mais robusta
        const range = XLSX.utils.decode_range(worksheet['!ref']);

        // Criar objeto de estilos que será aplicado após a criação
        const cellStyles = {};

        // Formatação do cabeçalho da empresa (0-9)
        for (let R = 0; R <= 10; R++) {
            for (let C = 0; C < 7; C++) {
                const addr = XLSX.utils.encode_cell({ r: R, c: C });
                if (worksheet[addr]) {
                    cellStyles[addr] = {
                        font: { bold: true, size: 11, color: { rgb: "1B5E20" } },
                        alignment: { horizontal: "left", vertical: "center" },
                        fill: { fgColor: { rgb: "F1F8E9" } }
                    };
                }
            }
        }

        // Formatação especial da linha do fornecedor
        for (let C = 0; C < 7; C++) {
            const addr = XLSX.utils.encode_cell({ r: 11, c: C });
            if (worksheet[addr] && C === 0) {
                cellStyles[addr] = {
                    font: { bold: true, size: 13, color: { rgb: "FFFFFF" } },
                    fill: { fgColor: { rgb: "2E7D32" } },
                    alignment: { horizontal: "center", vertical: "center" },
                    border: {
                        top: { style: "thick", color: { rgb: "1B5E20" } },
                        bottom: { style: "thick", color: { rgb: "1B5E20" } },
                        left: { style: "thick", color: { rgb: "1B5E20" } },
                        right: { style: "thick", color: { rgb: "1B5E20" } }
                    }
                };
            } else if (worksheet[addr]) {
                cellStyles[addr] = {
                    fill: { fgColor: { rgb: "2E7D32" } },
                    border: {
                        top: { style: "thick", color: { rgb: "1B5E20" } },
                        bottom: { style: "thick", color: { rgb: "1B5E20" } }
                    }
                };
            }
        }

        // Formatação do cabeçalho da tabela
        for (let C = 0; C < 7; C++) {
            const addr = XLSX.utils.encode_cell({ r: headerRowIndex, c: C });
            if (worksheet[addr]) {
                cellStyles[addr] = {
                    font: { bold: true, size: 11, color: { rgb: "FFFFFF" } },
                    fill: { fgColor: { rgb: "00695C" } },
                    alignment: { horizontal: "center", vertical: "center" },
                    border: {
                        top: { style: "thick", color: { rgb: "004D40" } },
                        bottom: { style: "thick", color: { rgb: "004D40" } },
                        left: { style: "medium", color: { rgb: "004D40" } },
                        right: { style: "medium", color: { rgb: "004D40" } }
                    }
                };
            }
        }

        // Formatação das linhas de dados com alternância
        for (let R = dataStartIndex; R < totalRowIndex - 1; R++) {
            const isEvenRow = (R - dataStartIndex) % 2 === 0;
            const bgColor = isEvenRow ? "FFFFFF" : "F8F9FA";
            
            for (let C = 0; C < 7; C++) {
                const addr = XLSX.utils.encode_cell({ r: R, c: C });
                if (worksheet[addr]) {
                    let style = {
                        fill: { fgColor: { rgb: bgColor } },
                        border: {
                            top: { style: "thin", color: { rgb: "E0E0E0" } },
                            bottom: { style: "thin", color: { rgb: "E0E0E0" } },
                            left: { style: "thin", color: { rgb: "E0E0E0" } },
                            right: { style: "thin", color: { rgb: "E0E0E0" } }
                        },
                        alignment: { vertical: "center" }
                    };

                    // Formatação específica por coluna
                    if (C === 0 || C === 1) { // Fornecedor e Código
                        style.font = { bold: true, size: 10 };
                        style.alignment.horizontal = "left";
                    } else if (C === 2) { // Descrição
                        style.alignment.horizontal = "left";
                    } else if (C === 3) { // Unidade
                        style.alignment.horizontal = "center";
                    } else if (C === 4) { // Quantidade
                        style.alignment.horizontal = "right";
                        worksheet[addr].z = "0.00";
                    } else if (C === 5 || C === 6) { // Valores monetários
                        style.alignment.horizontal = "right";
                        worksheet[addr].z = "R$ #,##0.00";
                    }

                    cellStyles[addr] = style;
                }
            }
        }

        // Formatação da linha de total
        for (let C = 0; C < 7; C++) {
            const addr = XLSX.utils.encode_cell({ r: totalRowIndex, c: C });
            if (worksheet[addr]) {
                cellStyles[addr] = {
                    font: { bold: true, size: 12, color: { rgb: "1B5E20" } },
                    fill: { fgColor: { rgb: "C8E6C9" } },
                    border: {
                        top: { style: "thick", color: { rgb: "2E7D32" } },
                        bottom: { style: "thick", color: { rgb: "2E7D32" } },
                        left: { style: "thick", color: { rgb: "2E7D32" } },
                        right: { style: "thick", color: { rgb: "2E7D32" } }
                    },
                    alignment: { vertical: "center" }
                };

                if (C === 6) { // Valor total
                    cellStyles[addr].alignment.horizontal = "right";
                    worksheet[addr].z = "R$ #,##0.00";
                } else if (C === 0 || C === 2) {
                    cellStyles[addr].alignment.horizontal = "center";
                }
            }
        }

        // Aplicar todos os estilos
        for (const addr in cellStyles) {
            if (worksheet[addr]) {
                worksheet[addr].s = cellStyles[addr];
            }
        }

        // Configurações de coluna otimizadas
        worksheet['!cols'] = [
            { wch: 28 }, // Fornecedor
            { wch: 20 }, // Código
            { wch: 55 }, // Descrição
            { wch: 18 }, // Unidade
            { wch: 18 }, // Quantidade
            { wch: 25 }, // Preço Unitário
            { wch: 20 }  // Custo Total
        ];

        // Alturas de linha para melhor apresentação
        const rowHeights = Array(totalRowIndex + 1).fill({ hpt: 16 });
        rowHeights[9] = { hpt: 28 }; // Linha do fornecedor
        rowHeights[headerRowIndex] = { hpt: 24 }; // Cabeçalho da tabela
        rowHeights[totalRowIndex] = { hpt: 28 }; // Linha total
        worksheet['!rows'] = rowHeights;

        return worksheet;
    }
    
    function prepararDadosParaExportacao(orcamento) {
        return agruparItensPorFornecedor(obterItensDoPedido(orcamento));
    }

    function criarWorksheetPedidoFornecedor(fornecedor, dadosFornecedor, orcamento, incluirCustos) {
        const pedido = orcamento.pedido || {};
        const cliente = pedido.cliente || {};
        const costureira = pedido.costureira || {};
        const colunas = incluirCustos
            ? ['CÓDIGO', 'DESCRIÇÃO', 'UNIDADE', 'QTD SOLICITADA', 'CUSTO UNITÁRIO', 'CUSTO TOTAL']
            : ['CÓDIGO', 'DESCRIÇÃO', 'UNIDADE', 'QTD SOLICITADA'];

        const dados = [
            ['PEDIDO AO FORNECEDOR'],
            ['Pedido', orcamento.id || orcamentoAtualId],
            ['Fornecedor', fornecedor],
            ['Cliente', cliente.nome || orcamento.infoGerais?.nomeCliente || 'Não informado'],
            ['Costureira', costureira.nome || orcamento.infoGerais?.nomeCostureira || 'Não informado'],
            ['Endereço de entrega', costureira.enderecoEntrega || orcamento.infoGerais?.enderecoCostureira || 'Não informado'],
            [],
            colunas
        ];

        Object.values(dadosFornecedor.itens).forEach(item => {
            const linha = [
                item.codigo,
                item.descricao,
                item.unidadeMedida,
                Number(item.quantidadeCompra.toFixed(3))
            ];
            if (incluirCustos) {
                linha.push(
                    Number(item.precoCompraUnitario.toFixed(2)),
                    Number(item.custoTotal.toFixed(2))
                );
            }
            dados.push(linha);
        });

        if (incluirCustos) {
            dados.push([]);
            dados.push(['', 'TOTAL', '', '', '', Number(dadosFornecedor.totalCusto.toFixed(2))]);
        }

        const worksheet = XLSX.utils.aoa_to_sheet(dados);
        worksheet['!cols'] = incluirCustos
            ? [{ wch: 18 }, { wch: 58 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }]
            : [{ wch: 18 }, { wch: 68 }, { wch: 18 }, { wch: 18 }];

        const cabecalhoTabela = 7;
        const totalColunas = colunas.length;
        worksheet['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: totalColunas - 1 } }
        ];

        for (let coluna = 0; coluna < totalColunas; coluna++) {
            const endereco = XLSX.utils.encode_cell({ r: cabecalhoTabela, c: coluna });
            if (worksheet[endereco]) {
                worksheet[endereco].s = {
                    font: { bold: true, color: { rgb: 'FFFFFF' } },
                    fill: { fgColor: { rgb: '2E7D32' } },
                    alignment: { horizontal: 'center' }
                };
            }
        }

        if (worksheet.A1) {
            worksheet.A1.s = {
                font: { bold: true, size: 15, color: { rgb: '1B5E20' } },
                alignment: { horizontal: 'center' }
            };
        }

        const inicioItens = cabecalhoTabela + 1;
        const fimItens = inicioItens + Object.keys(dadosFornecedor.itens).length;
        for (let linha = inicioItens; linha < fimItens; linha++) {
            const celulaQuantidade = worksheet[XLSX.utils.encode_cell({ r: linha, c: 3 })];
            if (celulaQuantidade) celulaQuantidade.z = '0.###';
            if (incluirCustos) {
                const custoUnitario = worksheet[XLSX.utils.encode_cell({ r: linha, c: 4 })];
                const custoTotal = worksheet[XLSX.utils.encode_cell({ r: linha, c: 5 })];
                if (custoUnitario) custoUnitario.z = 'R$ #,##0.00';
                if (custoTotal) custoTotal.z = 'R$ #,##0.00';
            }
        }

        return worksheet;
    }

    function normalizarNomeAbaExcel(nome) {
        const nomeSeguro = String(nome || 'Fornecedor')
            .replace(/[\\/?*\[\]:]/g, '-')
            .trim() || 'Fornecedor';
        return nomeSeguro.substring(0, 31);
    }

    function exportarExcel() {
        const orcamento = obterOrcamentoAtual();
        if (!orcamento || !pedidoEstaConfirmado(orcamento)) {
            mostrarNotificacao('Transforme o orçamento em pedido antes de gerar o relatório para fornecedores.');
            return;
        }

        const dadosProcessados = prepararDadosParaExportacao(orcamento);
        if (Object.keys(dadosProcessados).length === 0) {
            mostrarNotificacao('O pedido confirmado não possui itens para fornecedores.');
            return;
        }

        const incluirCustos = document.getElementById('mostrarCustosFornecedor')?.checked === true;
        const workbook = XLSX.utils.book_new();
        const nomesUsados = new Set();

        Object.entries(dadosProcessados).forEach(([fornecedor, dadosFornecedor], indice) => {
            const worksheet = criarWorksheetPedidoFornecedor(
                fornecedor,
                dadosFornecedor,
                orcamento,
                incluirCustos
            );
            let nomeAba = normalizarNomeAbaExcel(fornecedor);
            if (nomesUsados.has(nomeAba)) {
                const sufixo = `-${indice + 1}`;
                nomeAba = `${nomeAba.substring(0, 31 - sufixo.length)}${sufixo}`;
            }
            nomesUsados.add(nomeAba);
            XLSX.utils.book_append_sheet(workbook, worksheet, nomeAba);
        });

        const dataAtual = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
        XLSX.writeFile(workbook, `Pedido_${orcamento.id || orcamentoAtualId}_${dataAtual}.xlsx`);
        mostrarNotificacao(`Relatório gerado para ${Object.keys(dadosProcessados).length} fornecedor(es).`);
    }

    function alternarOrcamento(id) {
        orcamentoAtualId = id;
        // Não precisa salvar, apenas carregar os dados do novo orçamento selecionado
        preencherInfoOrcamento();
    }

    function atualizarSeletoresOrcamento(idPreferencial = null) {
        const seletor = document.getElementById('seletorOrcamento');
        const idSalvo = seletor.value;
        seletor.innerHTML = ''; // Limpa as opções existentes
        const idsOrdenados = Object.keys(orcamentosSalvos).sort();

        idsOrdenados.forEach(id => {
            const orcamento = orcamentosSalvos[id];
            if (!orcamento) return;

            const option = document.createElement('option');
            option.value = id;

            const nomeBase = orcamento.infoGerais?.nome || `Orçamento ${id}`;
            const nomeCliente = orcamento.infoGerais?.nomeCliente ? ` - ${orcamento.infoGerais.nomeCliente.trim()}` : '';
            const statusComercial = obterStatusComercial(orcamento);
            const tipoDocumento = statusComercial === STATUS_DOCUMENTO.PEDIDO
                ? '[PEDIDO] '
                : statusComercial === STATUS_DOCUMENTO.PERDIDO
                    ? '[PERDIDO] '
                    : '';
            option.textContent = `${tipoDocumento}${nomeBase}${nomeCliente}`;

            seletor.appendChild(option);
        });

        // Restaura a seleção para o orçamento que estava sendo editado ou o atual
        seletor.value = idPreferencial && orcamentosSalvos[idPreferencial]
            ? idPreferencial
            : idSalvo && orcamentosSalvos[idSalvo]
                ? idSalvo
                : orcamentoAtualId;
    }

    // Renomeia a função para manter consistência, já que ela é chamada por atualizarInfoOrcamento
    const renderizarOrcamentos = atualizarSeletoresOrcamento;

    function formatarData(data) {
        if (!data || data.length < 10) {
            return 'Não informado';
        }
        const partes = data.split('-');
        if (partes.length === 3) {
            return `${partes[2]}/${partes[1]}/${partes[0]}`;
        }
        return data; // Retorna a data original se não for possível formatar
    }
    
    function preencherInfoOrcamento() {
        const orcamento = orcamentosSalvos[orcamentoAtualId];
        if (orcamento) {
            const infoGerais = orcamento.infoGerais || {};
            const infoComercial = orcamento.infoComercial || {};

            document.getElementById('orcamentoId').textContent = orcamentoAtualId;
            document.getElementById('nomeCliente').value = infoGerais.nomeCliente || '';
            document.getElementById('enderecoCliente').value = infoGerais.enderecoCliente || ''; // CORREÇÃO: Esta linha estava faltando.
            document.getElementById('dataOrcamento').value = infoGerais.dataOrcamento || '';
            document.getElementById('prazoValidade').value = infoGerais.prazoValidade || '';
            document.getElementById('prazoEntrega').value = infoGerais.prazoEntrega || '';
            document.getElementById('observacoesGerais').value = infoGerais.observacoesGerais || '';  
            document.getElementById('condicaoPagamento').value = infoComercial.condicaoPagamento || 'À vista';
            document.getElementById('formaPagamento').value = infoComercial.formaPagamento || 'PIX';
            document.getElementById('observacoesComerciais').value = infoComercial.observacoesComerciais || '';
            document.getElementById('dataInstalacao').value = infoGerais.dataInstalacao || '';
            document.getElementById('nomeCostureira').value = infoGerais.nomeCostureira || '';
            document.getElementById('enderecoCostureira').value = infoGerais.enderecoCostureira || '';
            document.getElementById('nomeInstalador').value = infoGerais.nomeInstalador || '';
            document.getElementById('descontoGlobal').value = infoComercial.descontoGlobal || 0;
            document.getElementById('nomeComissionado').value = infoGerais.nomeComissionado || '';
            atualizarCamposComissao(orcamento);
            Object.keys(CONTATOS_WHATSAPP).forEach(campo => {
                document.getElementById(campo).value = formatarCelular(infoGerais[campo]);
                atualizarContatoWhatsApp(campo, infoGerais[campo], { validar: true });
            });
            document.getElementById('proximoFollowUp').value = ehDataCivilValida(infoGerais.proximoFollowUp) ? infoGerais.proximoFollowUp : '';
            document.getElementById('observacaoFollowUp').value = infoGerais.observacaoFollowUp || '';

            const apresentacao = orcamento.apresentacao || {};
            document.getElementById('modoProposta').value = apresentacao.modo || 'reduzida';
            document.getElementById('mostrarValoresItens').checked = apresentacao.mostrarValoresItens === true;
            document.getElementById('mostrarCustosFornecedor').checked = apresentacao.mostrarCustosFornecedor === true;
            atualizarEstadoControlesProposta();
            
            renderizarItensOrcamento();
            atualizarPropostaCliente();
            atualizarInterfacePedido();
        }
    }
