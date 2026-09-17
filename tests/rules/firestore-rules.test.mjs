import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cancelarPedido,
    confirmarOrcamentoComoPedido,
    obterItensAtuaisDoOrcamento
} from '../../order-domain.js';
import { calcularDetalhesItem } from '../../pricing-domain.js';

// Testes das regras do Firestore contra o emulador, pela API REST (sem dependências extras).
// Execute com: npm run test:rules  (firebase emulators:exec com um projeto "demo-", sem acesso à produção).
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJETO = process.env.GCLOUD_PROJECT || 'demo-filippini-regras';
const USUARIO = 'usuario-regras';
const OUTRO_USUARIO = 'outro-usuario';
const BASE = `http://${HOST}/v1/projects/${PROJETO}/databases/(default)/documents`;

test('ambiente do emulador', () => {
    assert.ok(HOST, 'FIRESTORE_EMULATOR_HOST ausente: execute com "npm run test:rules".');
    assert.match(PROJETO, /^demo-/, 'os testes de regras só podem rodar em projeto demo do emulador');
});

// --- Conversão para o formato REST do Firestore -------------------------------------------------

function paraValor(valor) {
    if (valor === null || valor === undefined) return { nullValue: null };
    if (typeof valor === 'boolean') return { booleanValue: valor };
    // Mesma regra do SDK web: inteiros seguros viram integerValue; o resto, doubleValue.
    if (typeof valor === 'number') {
        return Number.isSafeInteger(valor) && !Object.is(valor, -0) ? { integerValue: String(valor) } : { doubleValue: valor };
    }
    if (typeof valor === 'string') return { stringValue: valor };
    if (Array.isArray(valor)) return { arrayValue: { values: valor.map(paraValor) } };
    return { mapValue: { fields: paraCampos(valor) } };
}

function paraCampos(objeto) {
    return Object.fromEntries(Object.entries(objeto).filter(([, valor]) => valor !== undefined)
        .map(([chave, valor]) => [chave, paraValor(valor)]));
}

function segmento(chave) {
    return /^[A-Za-z_][A-Za-z_0-9]*$/.test(chave) ? chave : `\`${chave.replace(/[`\\]/g, '\\$&')}\``;
}

function montarCorpo(dados) {
    // Caminhos com ponto ("pedido.cancelamento") viram mapas aninhados, como no update() do SDK.
    const corpo = {};
    for (const [caminho, valor] of Object.entries(dados)) {
        const partes = caminho.split('.');
        let alvo = corpo;
        partes.slice(0, -1).forEach(parte => { alvo = alvo[parte] ??= {}; });
        alvo[partes.at(-1)] = valor;
    }
    return corpo;
}

function caminhosFolha(objeto, prefixo = '') {
    // set(..., { merge: true }) do SDK envia todos os caminhos de folha dos mapas.
    return Object.entries(objeto).flatMap(([chave, valor]) => {
        const caminho = prefixo ? `${prefixo}.${segmento(chave)}` : segmento(chave);
        return valor && typeof valor === 'object' && !Array.isArray(valor) && Object.keys(valor).length > 0
            ? caminhosFolha(valor, caminho)
            : [caminho];
    });
}

function base64Url(objeto) {
    return Buffer.from(JSON.stringify(objeto)).toString('base64url');
}

function tokenDe(uid) {
    const agora = Math.floor(Date.now() / 1000);
    const payload = {
        iss: `https://securetoken.google.com/${PROJETO}`, aud: PROJETO, iat: agora, exp: agora + 3600, auth_time: agora,
        sub: uid, user_id: uid, firebase: { sign_in_provider: 'custom', identities: {} }
    };
    return `${base64Url({ alg: 'none', type: 'JWT' })}.${base64Url(payload)}.`;
}

async function requisitar(metodo, url, { uid, admin = false, corpo } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (admin) headers.Authorization = 'Bearer owner';
    else if (uid) headers.Authorization = `Bearer ${tokenDe(uid)}`;
    const resposta = await fetch(url, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
    const texto = await resposta.text();
    return { permitido: resposta.ok, status: resposta.status, texto };
}

function urlDocumento(colecao, id, { mascara, existe } = {}) {
    const parametros = new URLSearchParams();
    (mascara || []).forEach(caminho => parametros.append('updateMask.fieldPaths', caminho));
    if (existe !== undefined) parametros.append('currentDocument.exists', String(existe));
    const consulta = parametros.toString();
    return `${BASE}/${colecao}/${encodeURIComponent(id)}${consulta ? `?${consulta}` : ''}`;
}

async function limpar() {
    const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
    assert.ok(resposta.ok, 'não foi possível limpar o emulador');
}

async function semear(id, dados, colecao = 'orcamentos') {
    const resultado = await requisitar('PATCH', urlDocumento(colecao, id), { admin: true, corpo: { fields: paraCampos(dados) } });
    assert.ok(resultado.permitido, resultado.texto);
}

// setDoc(ref, dados): grava o documento inteiro (criação quando não existe).
const gravarDocumento = (uid, id, dados, colecao = 'orcamentos') =>
    requisitar('PATCH', urlDocumento(colecao, id), { uid, corpo: { fields: paraCampos(dados) } });

// updateDoc(ref, dados) e transaction.update(ref, dados): altera só os caminhos informados.
const atualizar = (uid, id, dados) => requisitar('PATCH', urlDocumento('orcamentos', id, {
    mascara: Object.keys(dados).map(caminho => caminho.split('.').map(segmento).join('.')), existe: true
}), { uid, corpo: { fields: paraCampos(montarCorpo(dados)) } });

// set(ref, dados, { merge: true }): usado pela restauração de backup.
const mesclar = (uid, id, dados) => requisitar('PATCH', urlDocumento('orcamentos', id, { mascara: caminhosFolha(dados) }),
    { uid, corpo: { fields: paraCampos(dados) } });

const excluir = (uid, id) => requisitar('DELETE', urlDocumento('orcamentos', id), { uid });

// --- Dados --------------------------------------------------------------------------------------

function criarOrcamento(id = 'ORC-50') {
    const detalhes = calcularDetalhesItem({ unidadeMedida: 'Unidade', precoCompra: 500, markup: 2 }, 1, 0, 0, 10);
    return {
        id,
        firestoreId: id,
        statusDocumento: 'orcamento',
        apresentacao: { modo: 'reduzida', mostrarValoresItens: false, mostrarCustosFornecedor: false },
        infoGerais: { nome: `Orçamento ${id}`, nomeCliente: 'Cliente Regras', celularCliente: '', nomeComissionado: 'Arquiteta' },
        infoComercial: { condicaoPagamento: 'À vista', formaPagamento: 'PIX', descontoGlobal: 10, percentualComissao: 10 },
        valoresInstalacao: { Sala: 150, 'Itens Avulsos': 0 },
        itens: [{
            id: 'item-1', ambiente: 'Sala', codigo: 'COD-1', descricao: 'Item', cor: '-', fornecedor: 'Fornecedor A',
            unidadeMedida: 'Unidade', quantidade: 1, largura: null, altura: null, quantidadeCompra: 1,
            precoCompraUnitario: 500, custoReal: detalhes.custoReal, precoUnitarioBase: detalhes.precoUnitarioBase,
            precoTotalSemComissao: detalhes.precoTotalSemComissao, precoUnitario: detalhes.precoUnitario,
            precoTotal: detalhes.precoTotal, observacoes: ''
        }],
        produtosAcabados: []
    };
}

function confirmar(orcamento, uid = USUARIO) {
    return confirmarOrcamentoComoPedido(orcamento, { confirmadoEm: '2026-09-17T15:00:00.000Z', confirmadoPor: uid });
}

function camposDaConfirmacao(confirmado) {
    return {
        statusDocumento: confirmado.statusDocumento,
        pedido: confirmado.pedido,
        'infoComercial.percentualComissao': confirmado.infoComercial.percentualComissao
    };
}

function pedidoV1(orcamento) {
    return {
        ...structuredClone(orcamento),
        statusDocumento: 'pedido',
        pedido: {
            versaoSnapshot: 1,
            orcamentoId: orcamento.id,
            confirmadoEm: '2026-09-12T15:00:00.000Z',
            confirmadoPor: 'usuario-antigo',
            cliente: { nome: orcamento.infoGerais.nomeCliente, endereco: '' },
            costureira: { nome: '', enderecoEntrega: '' },
            itens: obterItensAtuaisDoOrcamento(orcamento)
        }
    };
}

const CANCELAMENTO = { motivo: 'Cliente desistiu', canceladoEm: '2026-09-18T12:00:00.000Z', canceladoPor: USUARIO };

// --- Testes ---------------------------------------------------------------------------------------

test('orçamento normal continua livre para usuário autenticado e fechado para anônimos', async () => {
    await limpar();
    const orcamento = criarOrcamento();
    assert.equal((await gravarDocumento(USUARIO, 'ORC-50', orcamento)).permitido, true);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { 'infoComercial.descontoGlobal': 15, itens: [] })).permitido, true);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { statusDocumento: 'perdido' })).permitido, true);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { statusDocumento: 'orcamento' })).permitido, true);
    assert.equal((await excluir(USUARIO, 'ORC-50')).permitido, true);
    assert.equal((await gravarDocumento(null, 'ORC-51', criarOrcamento('ORC-51'))).permitido, false);
    // As demais coleções não mudaram.
    assert.equal((await gravarDocumento(USUARIO, 'produto-1', { codigo: 'X', status: 'Ativo' }, 'precos')).permitido, true);
    assert.equal((await gravarDocumento(USUARIO, 'x', { a: 1 }, 'colecao-desconhecida')).permitido, false);
});

test('confirmação v2 válida é aceita somente como transição íntegra', async () => {
    await limpar();
    const orcamento = criarOrcamento();
    await semear('ORC-50', orcamento);
    const confirmado = confirmar(orcamento);

    assert.equal((await atualizar(USUARIO, 'ORC-50', camposDaConfirmacao(confirmado))).permitido, true);

    const casosRecusados = [
        ['auditoria de outro usuário', confirmar(orcamento, OUTRO_USUARIO), campos => campos],
        ['comissão +1 centavo', confirmado, campos => { campos.pedido.financeiro.valorComissaoCentavos += 1; return campos; }],
        ['total da proposta +1 centavo', confirmado, campos => { campos.pedido.proposta.totalPropostaClienteCentavos += 1; return campos; }],
        ['centavos fracionários', confirmado, campos => {
            campos.pedido.financeiro.custoProdutosCentavos += 0.5;
            campos.pedido.financeiro.margemCentavos -= 0.5;
            return campos;
        }],
        ['instalação dentro do financeiro', confirmado, campos => {
            campos.pedido.financeiro.valorProdutosCobradoClienteCentavos += 15000;
            return campos;
        }],
        ['campo genérico total', confirmado, campos => { campos.pedido.financeiro.total = 1; return campos; }],
        ['cancelado já na confirmação', confirmado, campos => { campos.pedido.cancelamento = CANCELAMENTO; return campos; }],
        ['snapshot de outro documento', confirmado, campos => { campos.pedido.orcamentoId = 'ORC-99'; return campos; }],
        ['percentual divergente do orçamento', confirmado, campos => { campos['infoComercial.percentualComissao'] = 5; return campos; }],
        ['itens alterados junto', confirmado, campos => ({ ...campos, itens: [] })]
    ];
    for (const [nome, base, alterar] of casosRecusados) {
        await limpar();
        await semear('ORC-50', orcamento);
        const resultado = await atualizar(USUARIO, 'ORC-50', alterar(structuredClone(camposDaConfirmacao(base))));
        assert.equal(resultado.permitido, false, nome);
    }

    await limpar();
    await semear('ORC-50', { ...orcamento, statusDocumento: 'perdido' });
    assert.equal((await atualizar(USUARIO, 'ORC-50', camposDaConfirmacao(confirmado))).permitido, false, 'perdido não vira pedido');
});

test('aba antiga não confirma pedido v1 por update', async () => {
    await limpar();
    const orcamento = criarOrcamento();
    await semear('ORC-50', orcamento);
    const antigo = pedidoV1(orcamento);

    // Código anterior: updateDoc com o documento inteiro.
    assert.equal((await atualizar(USUARIO, 'ORC-50', antigo)).permitido, false);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { statusDocumento: 'pedido', pedido: antigo.pedido })).permitido, false);
    assert.equal((await gravarDocumento(USUARIO, 'ORC-50', antigo)).permitido, false);
});

test('pedido confirmado não volta a orçamento nem perdido, nem por gravação desatualizada', async () => {
    await limpar();
    const orcamento = criarOrcamento();
    const confirmado = confirmar(orcamento);
    await semear('ORC-50', confirmado);

    assert.equal((await atualizar(USUARIO, 'ORC-50', { statusDocumento: 'orcamento' })).permitido, false);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { statusDocumento: 'perdido' })).permitido, false);
    // Aba desatualizada: regrava o documento inteiro como ainda estava em negociação.
    const { pedido: _pedido, ...estadoAntigo } = orcamento;
    assert.equal((await atualizar(USUARIO, 'ORC-50', estadoAntigo)).permitido, false);
    assert.equal((await gravarDocumento(USUARIO, 'ORC-50', orcamento)).permitido, false);
});

test('itens, preços, comercial, instalação e snapshot ficam imutáveis após a confirmação', async () => {
    await limpar();
    const confirmado = confirmar(criarOrcamento());
    await semear('ORC-50', confirmado);

    const alteracoes = [
        { itens: [] },
        { 'infoComercial.descontoGlobal': 50 },
        { 'infoComercial.percentualComissao': 5 },
        { valoresInstalacao: { Sala: 999 } },
        { produtosAcabados: [{ id: 'novo' }] },
        { 'pedido.financeiro.valorComissaoCentavos': 1 },
        { 'pedido.itens': [] },
        { 'pedido.versaoSnapshot': 1 },
        { pedido: { versaoSnapshot: 1 } },
        { campoNovo: 'x' }
    ];
    for (const alteracao of alteracoes) {
        assert.equal((await atualizar(USUARIO, 'ORC-50', alteracao)).permitido, false, JSON.stringify(Object.keys(alteracao)));
    }
});

test('contatos, dados gerais e apresentação continuam editáveis em pedidos v1 e v2', async () => {
    await limpar();
    const orcamento = criarOrcamento();
    const confirmado = confirmar(orcamento);
    await semear('ORC-50', confirmado);
    await semear('ORC-60', pedidoV1(criarOrcamento('ORC-60')));

    assert.equal((await atualizar(USUARIO, 'ORC-50', { 'infoGerais.celularCliente': '5511987654321' })).permitido, true);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { 'apresentacao.modo': 'detalhada' })).permitido, true);
    // Gravação do documento inteiro pela interface, só com contatos alterados.
    const salvoPelaTela = { ...structuredClone(confirmado), infoGerais: { ...confirmado.infoGerais, celularCliente: '5511987654321', nomeComissionado: 'Outra arquiteta' } };
    assert.equal((await atualizar(USUARIO, 'ORC-50', salvoPelaTela)).permitido, true);
    assert.equal((await atualizar(USUARIO, 'ORC-60', { 'infoGerais.nomeCliente': 'Cliente v1 atualizado', firestoreId: 'ORC-60' })).permitido, true);
});

test('cancelamento é aceito uma única vez e não pode ser editado nem removido', async () => {
    await limpar();
    const confirmado = confirmar(criarOrcamento());
    await semear('ORC-50', confirmado);
    const cancelado = cancelarPedido(confirmado, CANCELAMENTO);

    const recusados = [
        ['motivo vazio', { ...cancelado.pedido.cancelamento, motivo: '   ' }],
        ['sem motivo', { canceladoEm: CANCELAMENTO.canceladoEm, canceladoPor: USUARIO }],
        ['outro usuário', { ...cancelado.pedido.cancelamento, canceladoPor: OUTRO_USUARIO }],
        ['data fora do formato', { ...cancelado.pedido.cancelamento, canceladoEm: '18/09/2026' }],
        ['campo extra', { ...cancelado.pedido.cancelamento, estornado: true }]
    ];
    for (const [nome, cancelamento] of recusados) {
        assert.equal((await atualizar(USUARIO, 'ORC-50', { 'pedido.cancelamento': cancelamento })).permitido, false, nome);
    }

    assert.equal((await atualizar(USUARIO, 'ORC-50', { 'pedido.cancelamento': cancelado.pedido.cancelamento })).permitido, true);
    // Cancelado continua congelado e o registro é definitivo.
    assert.equal((await atualizar(USUARIO, 'ORC-50', { 'pedido.cancelamento.motivo': 'Outro motivo' })).permitido, false);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { 'pedido.cancelamento': { ...cancelado.pedido.cancelamento, motivo: 'Outro' } })).permitido, false);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { pedido: confirmado.pedido })).permitido, false, 'remover cancelamento');
    assert.equal((await atualizar(USUARIO, 'ORC-50', { statusDocumento: 'orcamento' })).permitido, false);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { itens: [] })).permitido, false);
    assert.equal((await atualizar(USUARIO, 'ORC-50', { 'infoGerais.celularCliente': '5511911112222' })).permitido, true);

    // Pedido v1 também pode ser cancelado uma vez (efeito apenas operacional).
    const v1 = pedidoV1(criarOrcamento('ORC-60'));
    await semear('ORC-60', v1);
    assert.equal((await atualizar(USUARIO, 'ORC-60', { 'pedido.cancelamento': cancelado.pedido.cancelamento })).permitido, true);
    assert.equal((await atualizar(USUARIO, 'ORC-60', { 'pedido.cancelamento.motivo': 'Mudança' })).permitido, false);
});

test('pedidos v1, v2 e cancelados não podem ser excluídos', async () => {
    await limpar();
    const confirmado = confirmar(criarOrcamento());
    await semear('ORC-50', confirmado);
    await semear('ORC-60', pedidoV1(criarOrcamento('ORC-60')));
    await semear('ORC-70', cancelarPedido(confirmar(criarOrcamento('ORC-70')), CANCELAMENTO));

    assert.equal((await excluir(USUARIO, 'ORC-50')).permitido, false);
    assert.equal((await excluir(USUARIO, 'ORC-60')).permitido, false);
    assert.equal((await excluir(USUARIO, 'ORC-70')).permitido, false);
});

test('restauração de backup: cria pedido v1 íntegro ou v2 válido, sem sobrescrever pedidos', async () => {
    await limpar();
    const v1 = pedidoV1(criarOrcamento('ORC-60'));
    const v2 = confirmar(criarOrcamento('ORC-61'), 'usuario-que-confirmou-originalmente');

    // Exceção documentada: criação direta de pedido v1 (backup histórico) é aceita.
    assert.equal((await mesclar(USUARIO, 'ORC-60', v1)).permitido, true);
    // Pedido v2 restaurado mantém a auditoria original, desde que o contrato seja válido.
    assert.equal((await mesclar(USUARIO, 'ORC-61', v2)).permitido, true);
    const invalido = structuredClone(v2);
    invalido.id = 'ORC-62';
    invalido.pedido.orcamentoId = 'ORC-62';
    invalido.pedido.financeiro.margemCentavos += 1;
    assert.equal((await mesclar(USUARIO, 'ORC-62', invalido)).permitido, false);
    const v1SemItens = pedidoV1(criarOrcamento('ORC-63'));
    delete v1SemItens.pedido.itens;
    assert.equal((await mesclar(USUARIO, 'ORC-63', v1SemItens)).permitido, false);
    assert.equal((await mesclar(USUARIO, 'ORC-64', { ...criarOrcamento('ORC-64'), statusDocumento: 'pedido' })).permitido, false);

    // Sobre pedido existente: backup idêntico passa; versão anterior (orçamento) é recusada.
    assert.equal((await mesclar(USUARIO, 'ORC-61', v2)).permitido, true);
    assert.equal((await mesclar(USUARIO, 'ORC-61', criarOrcamento('ORC-61'))).permitido, false);
    // Orçamento existente não vira pedido por restauração.
    await semear('ORC-65', criarOrcamento('ORC-65'));
    assert.equal((await mesclar(USUARIO, 'ORC-65', pedidoV1(criarOrcamento('ORC-65')))).permitido, false);
});
