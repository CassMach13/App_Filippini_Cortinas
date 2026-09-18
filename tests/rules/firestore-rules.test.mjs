import assert from 'node:assert/strict';
import test from 'node:test';

import {
    TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO,
    avaliarRestauracaoOrcamento,
    cancelarPedido,
    confirmarOrcamentoComoPedido,
    obterItensAtuaisDoOrcamento,
    validarCancelamentoPedido
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

test('motivo do cancelamento segue o contrato do domínio: até 500 caracteres e sem espaços nas pontas', async () => {
    const confirmado = confirmar(criarOrcamento());
    const cancelamentoCom = motivo => ({ ...CANCELAMENTO, motivo });
    const tentar = async motivo => {
        await limpar();
        await semear('ORC-50', confirmado);
        return (await atualizar(USUARIO, 'ORC-50', { 'pedido.cancelamento': cancelamentoCom(motivo) })).permitido;
    };

    assert.equal(TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO, 500);
    assert.equal(await tentar('x'.repeat(500)), true, '500 caracteres');
    assert.equal(await tentar('é'.repeat(500)), true, '500 caracteres acentuados');
    assert.equal(await tentar('x'.repeat(501)), false, '501 caracteres');
    assert.equal(await tentar(' motivo '), false, 'espaços nas extremidades');
    assert.equal(await tentar('motivo '), false, 'espaço no fim');
    assert.equal(await tentar(''), false, 'vazio');
    assert.equal(await tentar('   '), false, 'só espaços');

    // O domínio aceita e recusa exatamente os mesmos motivos.
    assert.deepEqual(validarCancelamentoPedido(cancelamentoCom('x'.repeat(500))), []);
    assert.deepEqual(validarCancelamentoPedido(cancelamentoCom('é'.repeat(500))), []);
    ['x'.repeat(501), ' motivo ', 'motivo ', '', '   '].forEach(motivo => {
        assert.ok(validarCancelamentoPedido(cancelamentoCom(motivo)).length > 0, JSON.stringify(motivo));
    });
});

test('documento que não é pedido não carrega snapshot, nem na criação nem antes da confirmação', async () => {
    await limpar();
    const orcamento = criarOrcamento();
    const snapshotV2 = confirmar(orcamento).pedido;
    const snapshotV1 = pedidoV1(orcamento).pedido;

    // 1. Orçamento novo não nasce com pedido.
    assert.equal((await gravarDocumento(USUARIO, 'ORC-50', { ...orcamento, pedido: snapshotV2 })).permitido, false, 'criação com snapshot v2');
    assert.equal((await gravarDocumento(USUARIO, 'ORC-50', { ...orcamento, pedido: snapshotV1 })).permitido, false, 'criação com snapshot v1');
    assert.equal((await mesclar(USUARIO, 'ORC-50', { ...orcamento, pedido: snapshotV2 })).permitido, false, 'restauração de orçamento com snapshot');
    assert.equal((await gravarDocumento(USUARIO, 'ORC-50', orcamento)).permitido, true, 'criação normal');

    // 2. Orçamento existente não recebe pedido sem mudar o status.
    assert.equal((await atualizar(USUARIO, 'ORC-50', { pedido: snapshotV2 })).permitido, false, 'plantar snapshot por update');
    assert.equal((await atualizar(USUARIO, 'ORC-50', { ...orcamento, pedido: snapshotV2 })).permitido, false, 'plantar snapshot regravando o documento');
    assert.equal((await mesclar(USUARIO, 'ORC-50', { pedido: snapshotV2 })).permitido, false, 'plantar snapshot por merge');

    // 3. Como o passo 2 falha, trocar só o status não encontra snapshot e é recusado.
    assert.equal((await atualizar(USUARIO, 'ORC-50', { statusDocumento: 'pedido' })).permitido, false, 'trocar só o status');
    // Mesmo um snapshot válido já gravado (dado inconsistente) não permite confirmar.
    const plantado = confirmar(criarOrcamento('ORC-51'));
    await semear('ORC-51', { ...criarOrcamento('ORC-51'), pedido: plantado.pedido });
    assert.equal((await atualizar(USUARIO, 'ORC-51', { statusDocumento: 'pedido' })).permitido, false, 'status sobre snapshot plantado');
    assert.equal((await atualizar(USUARIO, 'ORC-51', camposDaConfirmacao(plantado))).permitido, false, 'confirmação sobre snapshot plantado');
    assert.equal((await atualizar(USUARIO, 'ORC-51', { 'infoGerais.nomeCliente': 'Outro' })).permitido, false, 'orçamento com snapshot não aceita edição');

    // 4. A confirmação transacional normal continua permitida.
    assert.equal((await atualizar(USUARIO, 'ORC-50', camposDaConfirmacao(confirmar(orcamento)))).permitido, true, 'confirmação v2');

    // 5. Perdido não carrega pedido.
    await semear('ORC-52', { ...criarOrcamento('ORC-52'), statusDocumento: 'perdido' });
    assert.equal((await atualizar(USUARIO, 'ORC-52', { pedido: snapshotV2 })).permitido, false, 'perdido recebe snapshot');
    assert.equal((await gravarDocumento(USUARIO, 'ORC-53', { ...criarOrcamento('ORC-53'), statusDocumento: 'perdido', pedido: snapshotV2 })).permitido, false, 'perdido nasce com snapshot');
    await semear('ORC-54', criarOrcamento('ORC-54'));
    assert.equal((await atualizar(USUARIO, 'ORC-54', { statusDocumento: 'perdido', pedido: snapshotV2 })).permitido, false, 'marcar perdido com snapshot');
    assert.equal((await atualizar(USUARIO, 'ORC-54', { statusDocumento: 'perdido' })).permitido, true, 'marcar perdido normal');
    assert.equal((await atualizar(USUARIO, 'ORC-52', { statusDocumento: 'orcamento', 'infoGerais.celularCliente': '5511987654321' })).permitido, true, 'reabrir perdido');
});

test('restauração de pedido v1 exige o contrato histórico completo', async () => {
    const completo = pedidoV1(criarOrcamento('ORC-60'));
    const snapshotV2 = confirmar(criarOrcamento('ORC-60')).pedido;
    const casosRecusados = [
        ['orcamentoId divergente', p => { p.orcamentoId = 'ORC-99'; }],
        ['sem cliente', p => { delete p.cliente; }],
        ['sem costureira', p => { delete p.costureira; }],
        ['sem itens', p => { delete p.itens; }],
        ['itens vazios', p => { p.itens = []; }],
        ['campo extra no snapshot', p => { p.observacao = 'extra'; }],
        ['financeiro em v1', p => { p.financeiro = snapshotV2.financeiro; }],
        ['proposta em v1', p => { p.proposta = snapshotV2.proposta; }],
        ['cliente com campo extra', p => { p.cliente.telefone = '11999999999'; }],
        ['costureira sem endereço de entrega', p => { delete p.costureira.enderecoEntrega; }],
        ['confirmadoPor numérico', p => { p.confirmadoPor = 42; }],
        ['sem confirmadoPor', p => { delete p.confirmadoPor; }],
        ['confirmadoEm fora do formato', p => { p.confirmadoEm = '12/09/2026'; }],
        ['cancelamento com 501 caracteres', p => { p.cancelamento = { ...CANCELAMENTO, motivo: 'x'.repeat(501) }; }],
        ['cancelamento com espaços nas pontas', p => { p.cancelamento = { ...CANCELAMENTO, motivo: ' Cancelado ' }; }]
    ];
    for (const [nome, alterar] of casosRecusados) {
        await limpar();
        const documento = structuredClone(completo);
        alterar(documento.pedido);
        assert.equal((await mesclar(USUARIO, 'ORC-60', documento)).permitido, false, nome);
        // Regras e domínio (avaliarRestauracaoOrcamento) concordam.
        assert.equal(avaliarRestauracaoOrcamento(null, documento).gravar, false, nome);
    }

    await limpar();
    assert.equal((await mesclar(USUARIO, 'ORC-60', completo)).permitido, true, 'backup v1 completo');
    assert.deepEqual(avaliarRestauracaoOrcamento(null, completo), { gravar: true });

    const cancelado = pedidoV1(criarOrcamento('ORC-61'));
    cancelado.pedido.cancelamento = { ...CANCELAMENTO, motivo: 'Pedido antigo cancelado' };
    assert.equal((await mesclar(USUARIO, 'ORC-61', cancelado)).permitido, true, 'backup v1 cancelado');
    assert.deepEqual(avaliarRestauracaoOrcamento(null, cancelado), { gravar: true });

    const confirmadoPorNulo = pedidoV1(criarOrcamento('ORC-62'));
    confirmadoPorNulo.pedido.confirmadoPor = null;
    assert.equal((await mesclar(USUARIO, 'ORC-62', confirmadoPorNulo)).permitido, true, 'confirmadoPor nulo');
    assert.deepEqual(avaliarRestauracaoOrcamento(null, confirmadoPorNulo), { gravar: true });
});

// --- Movimentos financeiros (subcoleção pagamentos) ---------------------------------------------
// O pagamento e o evento de auditoria são gravados numa única operação atômica (:commit). As regras
// exigem isso via getAfter(): sem o evento da versão, a escrita do pagamento é recusada.

const nomeDocumento = caminho => `projects/${PROJETO}/databases/(default)/documents/${caminho}`;
const caminhoPag = (orcamentoId, pagamentoId) => `orcamentos/${orcamentoId}/pagamentos/${pagamentoId}`;
const caminhoAud = (orcamentoId, pagamentoId, eventoId) => `${caminhoPag(orcamentoId, pagamentoId)}/auditoria/${eventoId}`;

function escrita(caminho, dados, existe) {
    return {
        update: { name: nomeDocumento(caminho), fields: paraCampos(dados) },
        ...(existe === undefined ? {} : { currentDocument: { exists: existe } })
    };
}

const commitAtomico = (uid, writes) => requisitar('POST', `${BASE}:commit`, { uid, corpo: { writes } });

function movimento(extras = {}) {
    return {
        tipo: 'recebimento',
        dataMovimento: '2026-09-18',
        valorCentavos: 50000,
        formaPagamento: 'PIX',
        observacao: 'Sinal',
        status: 'ativo',
        versao: 1,
        ultimoEventoId: 'v1',
        criadoEm: '2026-09-18T14:00:00.000Z',
        criadoPor: USUARIO,
        atualizadoEm: '2026-09-18T14:00:00.000Z',
        atualizadoPor: USUARIO,
        ...extras
    };
}

const CANCELAMENTO_MOVIMENTO = {
    status: 'cancelado',
    canceladoEm: '2026-09-19T10:00:00.000Z',
    canceladoPor: USUARIO,
    motivoCancelamento: 'Lancado em duplicidade'
};

const estadoDe = m => (m == null ? null : {
    tipo: m.tipo, dataMovimento: m.dataMovimento, valorCentavos: m.valorCentavos,
    formaPagamento: m.formaPagamento, observacao: m.observacao, status: m.status
});

function eventoDe(novo, { evento = 'criacao', anterior = null, motivo = null, registradoPor = USUARIO, ...extras } = {}) {
    return {
        evento,
        versaoAnterior: anterior ? anterior.versao : null,
        versaoNova: novo.versao,
        estadoAnterior: estadoDe(anterior),
        estadoNovo: estadoDe(novo),
        motivo,
        // As regras amarram o instante do evento ao atualizadoEm do movimento daquela versão.
        registradoEm: novo.atualizadoEm,
        registradoPor,
        ...extras
    };
}

// Grava movimento + evento na mesma operação atômica, como o payment-transactions.js faz.
function lancar(uid, orcamentoId, pagamentoId, novo, opcoesEvento = {}, { existe, eventoId, semEvento = false, eventoEm } = {}) {
    const evento = eventoDe(novo, opcoesEvento);
    const writes = [escrita(caminhoPag(orcamentoId, pagamentoId), novo, existe)];
    if (!semEvento) {
        writes.push(escrita(eventoEm || caminhoAud(orcamentoId, pagamentoId, eventoId || novo.ultimoEventoId), evento));
    }
    return commitAtomico(uid, writes);
}

async function semearPedidoV2(id) {
    await semear(id, confirmar(criarOrcamento(id)));
}

test('movimento financeiro só existe sob pedido v2 válido', async () => {
    await limpar();
    await semearPedidoV2('ORC-70');

    assert.equal((await lancar(USUARIO, 'ORC-70', 'pag-1', movimento())).permitido, true, 'pedido v2 aceita recebimento');
    assert.equal((await requisitar('GET', urlDocumento('orcamentos/ORC-70/pagamentos', 'pag-1'), { uid: USUARIO })).permitido, true, 'leitura autenticada');
    assert.equal((await lancar(null, 'ORC-70', 'pag-anon', movimento())).permitido, false, 'anônimo não lança');

    // Pai inexistente: o get() das regras não encontra o pedido.
    assert.equal((await lancar(USUARIO, 'ORC-404', 'pag-2', movimento())).permitido, false, 'pedido inexistente');

    await semear('ORC-71', criarOrcamento('ORC-71'));
    assert.equal((await lancar(USUARIO, 'ORC-71', 'pag-3', movimento())).permitido, false, 'orçamento em negociação');

    // Pedido v1 nunca movimenta dinheiro: não tem snapshot financeiro.
    await semear('ORC-72', pedidoV1(criarOrcamento('ORC-72')));
    assert.equal((await lancar(USUARIO, 'ORC-72', 'pag-4', movimento())).permitido, false, 'pedido v1');

    // Snapshot v2 corrompido: as relações em centavos não fecham.
    const corrompido = confirmar(criarOrcamento('ORC-73'));
    corrompido.pedido.financeiro.valorLiquidoFilippiniCentavos += 1;
    await semear('ORC-73', corrompido);
    assert.equal((await lancar(USUARIO, 'ORC-73', 'pag-5', movimento())).permitido, false, 'snapshot v2 inválido');
});

test('pai inexistente é fail-closed: movimento sob orçamento que não existe é recusado', async () => {
    await limpar();
    // Nada é semeado: o documento pai simplesmente não existe. O comportamento provado aqui é o
    // fechamento, não a premissa de que get() devolve null.
    assert.equal(
        (await lancar(USUARIO, 'ORC-INEXISTENTE', 'pag-1', movimento())).permitido,
        false,
        'recebimento sob pai inexistente'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-INEXISTENTE', 'pag-2', movimento({ tipo: 'reembolso' }))).permitido,
        false,
        'reembolso sob pai inexistente'
    );
    // E o evento de auditoria sozinho também não cria trilha órfã sem o movimento.
    assert.equal(
        (await commitAtomico(USUARIO, [escrita(caminhoPag('ORC-INEXISTENTE', 'pag-3'), movimento())])).permitido,
        false,
        'movimento isolado sob pai inexistente'
    );
});

test('pai que não é pedido é recusado mesmo carregando estrutura v2 de aparência válida', async () => {
    await limpar();
    // Estado que as próprias regras de /orcamentos jamais permitiriam criar (documento em negociação
    // com bloco `pedido`), montado por fixture administrativa. Prova que a subcoleção não depende só
    // da impossibilidade histórica de produzir esse pai pela interface.
    const disfarçado = confirmar(criarOrcamento('ORC-85'));
    disfarçado.statusDocumento = 'orcamento';
    await semear('ORC-85', disfarçado);

    assert.equal((await lancar(USUARIO, 'ORC-85', 'pag-1', movimento())).permitido, false, 'recebimento em pai não-pedido');
    assert.equal(
        (await lancar(USUARIO, 'ORC-85', 'pag-2', movimento({ tipo: 'reembolso' }))).permitido,
        false,
        'reembolso em pai não-pedido'
    );

    // Controle: o mesmo documento, agora efetivamente como pedido, aceita o lançamento.
    await semear('ORC-85', confirmar(criarOrcamento('ORC-85')));
    assert.equal((await lancar(USUARIO, 'ORC-85', 'pag-3', movimento())).permitido, true, 'controle: pedido de verdade aceita');
});

test('pedido cancelado bloqueia recebimento novo e continua aceitando reembolso', async () => {
    await limpar();
    const cancelado = confirmar(criarOrcamento('ORC-74'));
    cancelado.pedido.cancelamento = CANCELAMENTO;
    await semear('ORC-74', cancelado);

    assert.equal((await lancar(USUARIO, 'ORC-74', 'pag-1', movimento())).permitido, false, 'recebimento em pedido cancelado');
    assert.equal(
        (await lancar(USUARIO, 'ORC-74', 'pag-2', movimento({ tipo: 'reembolso' }))).permitido,
        true,
        'reembolso continua possível depois do cancelamento'
    );
});

test('pedido cancelado: movimento histórico continua corrigível e cancelável', async () => {
    await limpar();
    // O pedido recebe enquanto está ativo e só depois é cancelado.
    await semearPedidoV2('ORC-79');
    const original = movimento();
    assert.equal((await lancar(USUARIO, 'ORC-79', 'pag-1', original)).permitido, true);

    const pedidoCancelado = confirmar(criarOrcamento('ORC-79'));
    pedidoCancelado.pedido.cancelamento = CANCELAMENTO;
    await semear('ORC-79', pedidoCancelado);

    // Recebimento novo continua proibido...
    assert.equal((await lancar(USUARIO, 'ORC-79', 'pag-novo', movimento())).permitido, false, 'recebimento novo proibido');

    // ...mas corrigir um erro de digitação no histórico continua permitido.
    const corrigido = { ...original, valorCentavos: 45000, versao: 2, ultimoEventoId: 'v2', atualizadoEm: '2026-09-19T09:00:00.000Z' };
    assert.equal(
        (await lancar(USUARIO, 'ORC-79', 'pag-1', corrigido, { evento: 'correcao', anterior: original }, { existe: true })).permitido,
        true,
        'correção de movimento histórico'
    );

    const canceladoLogicamente = { ...corrigido, ...CANCELAMENTO_MOVIMENTO, versao: 3, ultimoEventoId: 'v3', atualizadoEm: CANCELAMENTO_MOVIMENTO.canceladoEm };
    assert.equal(
        (await lancar(USUARIO, 'ORC-79', 'pag-1', canceladoLogicamente,
            { evento: 'cancelamento', anterior: corrigido, motivo: CANCELAMENTO_MOVIMENTO.motivoCancelamento }, { existe: true })).permitido,
        true,
        'cancelamento lógico de movimento histórico'
    );
});

test('o contrato do movimento é exigido pelas regras', async () => {
    await limpar();
    await semearPedidoV2('ORC-75');

    const semStatus = movimento();
    delete semStatus.status;
    const semUltimoEvento = movimento();
    delete semUltimoEvento.ultimoEventoId;

    const recusados = [
        ['tipo desconhecido', movimento({ tipo: 'estorno' })],
        ['valor zero', movimento({ valorCentavos: 0 })],
        ['valor negativo', movimento({ valorCentavos: -100 })],
        ['valor fracionário', movimento({ valorCentavos: 100.5 })],
        ['valor como texto', movimento({ valorCentavos: '50000' })],
        ['forma de pagamento fora da lista', movimento({ formaPagamento: 'Cheque' })],
        ['data fora do formato civil', movimento({ dataMovimento: '18/09/2026' })],
        ['versão zero', movimento({ versao: 0 })],
        ['criadoEm fora do formato ISO', movimento({ criadoEm: '2026-09-18' })],
        ['observação com 501 caracteres', movimento({ observacao: 'x'.repeat(501) })],
        ['campo extra', movimento({ conciliado: true })],
        ['sem status', semStatus],
        ['sem ultimoEventoId', semUltimoEvento],
        ['ultimoEventoId vazio', movimento({ ultimoEventoId: '' })],
        ['ativo com campos de cancelamento', movimento({ canceladoEm: '2026-09-19T10:00:00.000Z' })],
        ['cancelado sem motivo', movimento({ status: 'cancelado', canceladoEm: '2026-09-19T10:00:00.000Z', canceladoPor: USUARIO })],
        ['motivo de cancelamento vazio', movimento({ ...CANCELAMENTO_MOVIMENTO, motivoCancelamento: '' })],
        ['motivo com 501 caracteres', movimento({ ...CANCELAMENTO_MOVIMENTO, motivoCancelamento: 'x'.repeat(501) })],
        ['motivo com espaços nas pontas', movimento({ ...CANCELAMENTO_MOVIMENTO, motivoCancelamento: ' Duplicado ' })]
    ];

    for (const [indice, [nome, dados]] of recusados.entries()) {
        assert.equal((await lancar(USUARIO, 'ORC-75', `pag-r${indice}`, dados)).permitido, false, nome);
    }
});

test('a criação financeira só aceita versão 1 ativa: não há exceção de restauração na 4B1', async () => {
    await limpar();
    await semearPedidoV2('ORC-75');

    // Enquanto o backup da aplicação não gravar pagamentos + auditoria, aceitar história pronta
    // permitiria uma trilha truncada (v1..vN com buracos). A exceção fica para a 4B2.
    const historico = movimento({ ...CANCELAMENTO_MOVIMENTO, versao: 3, ultimoEventoId: 'v3' });
    const anteriorFicticio = movimento({ versao: 2 });

    assert.equal(
        (await lancar(USUARIO, 'ORC-75', 'pag-sem-trilha', historico, {}, { semEvento: true })).permitido,
        false,
        'movimento histórico sem evento é recusado'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-75', 'pag-restaurado', historico,
            { evento: 'cancelamento', anterior: anteriorFicticio, motivo: CANCELAMENTO_MOVIMENTO.motivoCancelamento })).permitido,
        false,
        'nem mesmo com o evento daquela versão: create exige versao == 1'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-75', 'pag-v2', movimento({ versao: 2, ultimoEventoId: 'v2' }),
            { evento: 'correcao', anterior: movimento() })).permitido,
        false,
        'create na versão 2 é recusado'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-75', 'pag-cancelado-de-nascenca', movimento({ ...CANCELAMENTO_MOVIMENTO }))).permitido,
        false,
        'movimento não nasce cancelado'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-75', 'pag-id-divergente', movimento({ ultimoEventoId: 'evento-1' }))).permitido,
        false,
        'o evento da criação é sempre v1'
    );

    assert.equal((await lancar(USUARIO, 'ORC-75', 'pag-ok', movimento())).permitido, true, 'criação normal segue permitida');
});

test('correção não pode mudar tipo, autoria de criação nem introduzir cancelamento', async () => {
    await limpar();
    await semearPedidoV2('ORC-83');
    const original = movimento();
    assert.equal((await lancar(USUARIO, 'ORC-83', 'pag-1', original)).permitido, true);

    const base = { ...original, valorCentavos: 40000, versao: 2, ultimoEventoId: 'v2', atualizadoEm: '2026-09-19T09:00:00.000Z' };
    const recusados = [
        ['muda tipo recebimento→reembolso', { ...base, tipo: 'reembolso' }],
        ['muda criadoPor', { ...base, criadoPor: OUTRO_USUARIO }],
        ['muda criadoEm', { ...base, criadoEm: '2026-09-19T14:00:00.000Z' }],
        ['inclui canceladoEm sem cancelar', { ...base, canceladoEm: '2026-09-19T10:00:00.000Z' }],
        ['inclui motivoCancelamento sem cancelar', { ...base, motivoCancelamento: 'Duplicado' }]
    ];
    for (const [nome, dados] of recusados) {
        assert.equal(
            (await lancar(USUARIO, 'ORC-83', 'pag-1', dados, { evento: 'correcao', anterior: original }, { existe: true })).permitido,
            false,
            nome
        );
    }

    assert.equal(
        (await lancar(USUARIO, 'ORC-83', 'pag-1', base, { evento: 'correcao', anterior: original }, { existe: true })).permitido,
        true,
        'correção legítima permitida'
    );
});

test('cancelamento lógico preserva os valores do movimento: nada de cancelar e corrigir junto', async () => {
    await limpar();
    await semearPedidoV2('ORC-84');
    const original = movimento();
    assert.equal((await lancar(USUARIO, 'ORC-84', 'pag-1', original)).permitido, true);

    const cancelado = { ...original, ...CANCELAMENTO_MOVIMENTO, versao: 2, ultimoEventoId: 'v2', atualizadoEm: CANCELAMENTO_MOVIMENTO.canceladoEm };
    const opcoesEvento = { evento: 'cancelamento', anterior: original, motivo: CANCELAMENTO_MOVIMENTO.motivoCancelamento };

    const hibridos = [
        ['muda valorCentavos ao cancelar', { ...cancelado, valorCentavos: 1 }],
        ['muda dataMovimento ao cancelar', { ...cancelado, dataMovimento: '2026-09-10' }],
        ['muda formaPagamento ao cancelar', { ...cancelado, formaPagamento: 'Dinheiro' }],
        ['muda observacao ao cancelar', { ...cancelado, observacao: 'Outra coisa' }],
        ['muda tipo ao cancelar', { ...cancelado, tipo: 'reembolso' }],
        ['canceladoPor de outro usuário', { ...cancelado, canceladoPor: OUTRO_USUARIO }]
    ];
    for (const [nome, dados] of hibridos) {
        assert.equal(
            (await lancar(USUARIO, 'ORC-84', 'pag-1', dados, { ...opcoesEvento, anterior: original }, { existe: true })).permitido,
            false,
            nome
        );
    }

    assert.equal(
        (await lancar(USUARIO, 'ORC-84', 'pag-1', cancelado, opcoesEvento, { existe: true })).permitido,
        true,
        'cancelamento legítimo permitido'
    );

    // Movimento já cancelado é imutável.
    const reativado = { ...original, versao: 3, ultimoEventoId: 'v3', atualizadoEm: '2026-09-20T10:00:00.000Z' };
    assert.equal(
        (await lancar(USUARIO, 'ORC-84', 'pag-1', reativado, { evento: 'correcao', anterior: cancelado }, { existe: true })).permitido,
        false,
        'movimento cancelado não é reativado'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-84', 'pag-1', { ...cancelado, versao: 3, ultimoEventoId: 'v3' },
            { ...opcoesEvento, anterior: cancelado }, { existe: true })).permitido,
        false,
        'movimento cancelado não é cancelado de novo'
    );
});

// --- Auditoria obrigatória (getAfter) -----------------------------------------------------------

test('não existe movimento sem o evento de auditoria na mesma operação', async () => {
    await limpar();
    await semearPedidoV2('ORC-80');
    const original = movimento();

    assert.equal(
        (await lancar(USUARIO, 'ORC-80', 'pag-1', original, {}, { semEvento: true })).permitido,
        false,
        'criar pagamento sem auditoria'
    );
    // Escrever só o pagamento, mesmo fora de lote, continua recusado: getAfter não encontra o evento.
    assert.equal(
        (await requisitar('PATCH', urlDocumento('orcamentos/ORC-80/pagamentos', 'pag-1'),
            { uid: USUARIO, corpo: { fields: paraCampos(original) } })).permitido,
        false,
        'criar pagamento por escrita isolada'
    );

    assert.equal((await lancar(USUARIO, 'ORC-80', 'pag-1', original)).permitido, true, 'pagamento + auditoria válidos');

    const corrigido = { ...original, valorCentavos: 40000, versao: 2, ultimoEventoId: 'v2', atualizadoEm: '2026-09-19T09:00:00.000Z' };
    assert.equal(
        (await lancar(USUARIO, 'ORC-80', 'pag-1', corrigido, {}, { existe: true, semEvento: true })).permitido,
        false,
        'corrigir sem auditoria'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-80', 'pag-1', corrigido, { evento: 'correcao', anterior: original }, { existe: true })).permitido,
        true,
        'correção com auditoria'
    );

    const cancelado = { ...corrigido, ...CANCELAMENTO_MOVIMENTO, versao: 3, ultimoEventoId: 'v3', atualizadoEm: CANCELAMENTO_MOVIMENTO.canceladoEm };
    assert.equal(
        (await lancar(USUARIO, 'ORC-80', 'pag-1', cancelado, {}, { existe: true, semEvento: true })).permitido,
        false,
        'cancelar sem auditoria'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-80', 'pag-1', cancelado,
            { evento: 'cancelamento', anterior: corrigido, motivo: CANCELAMENTO_MOVIMENTO.motivoCancelamento }, { existe: true })).permitido,
        true,
        'cancelamento com auditoria'
    );
});

test('o evento de auditoria precisa corresponder exatamente à operação', async () => {
    await limpar();
    await semearPedidoV2('ORC-81');
    const original = movimento();

    // Controle positivo: o mesmo lançamento, com o evento correto, é aceito.
    assert.equal((await lancar(USUARIO, 'ORC-81', 'pag-controle', original)).permitido, true, 'controle: o caso válido passa');

    const recusados = [
        ['evento errado na criação', original, { evento: 'correcao' }, {}],
        ['versaoNova divergente', original, { versaoNova: 2 }, {}],
        ['estadoNovo divergente do pagamento', original, { estadoNovo: { ...estadoDe(original), valorCentavos: 1 } }, {}],
        ['estadoAnterior preenchido na criação', original, { anterior: movimento({ versao: 0 }) }, {}],
        ['registradoEm fora do formato', original, { registradoEm: '2026-09-18' }, {}],
        ['evento gravado sob outro pagamento', original, {}, { eventoEm: caminhoAud('ORC-81', 'pag-outro', 'v1') }],
        ['ultimoEventoId apontando evento inexistente', movimento({ ultimoEventoId: 'v9' }), {}, { eventoId: 'v1' }]
    ];

    for (const [indice, [nome, dados, opcoesEvento, opcoes]] of recusados.entries()) {
        assert.equal((await lancar(USUARIO, 'ORC-81', `pag-e${indice}`, dados, opcoesEvento, opcoes)).permitido, false, nome);
    }
});

test('a correção precisa registrar o estado anterior verdadeiro e o usuário da operação', async () => {
    await limpar();
    await semearPedidoV2('ORC-82');
    const original = movimento();
    assert.equal((await lancar(USUARIO, 'ORC-82', 'pag-1', original)).permitido, true);

    const corrigido = { ...original, valorCentavos: 40000, versao: 2, ultimoEventoId: 'v2', atualizadoEm: '2026-09-19T09:00:00.000Z' };
    const outroEstado = movimento({ valorCentavos: 12345 });

    const recusados = [
        ['estadoAnterior não corresponde ao documento atual', corrigido, { evento: 'correcao', anterior: outroEstado }, { existe: true }],
        ['versaoAnterior divergente', corrigido, { evento: 'correcao', anterior: { ...original, versao: 5 } }, { existe: true }],
        ['evento de cancelamento para movimento que segue ativo', corrigido, { evento: 'cancelamento', anterior: original }, { existe: true }],
        ['registradoPor de outro usuário', corrigido, { evento: 'correcao', anterior: original, registradoPor: OUTRO_USUARIO }, { existe: true }],
        ['ultimoEventoId repetido', { ...corrigido, ultimoEventoId: 'v1' }, { evento: 'correcao', anterior: original }, { existe: true }]
    ];
    for (const [indice, [nome, dados, opcoesEvento, opcoes]] of recusados.entries()) {
        assert.equal((await lancar(USUARIO, 'ORC-82', 'pag-1', dados, opcoesEvento, opcoes)).permitido, false, `${indice}: ${nome}`);
    }

    assert.equal(
        (await lancar(USUARIO, 'ORC-82', 'pag-1', corrigido, { evento: 'correcao', anterior: original }, { existe: true })).permitido,
        true,
        'correção íntegra'
    );
});

test('correção e cancelamento exigem versão seguinte e preservam tipo e criação', async () => {
    await limpar();
    await semearPedidoV2('ORC-76');
    const original = movimento();
    assert.equal((await lancar(USUARIO, 'ORC-76', 'pag-1', original)).permitido, true);

    const recusados = [
        ['mesma versão', { ...original, valorCentavos: 40000, ultimoEventoId: 'v1b' }],
        ['versão pulada', { ...original, valorCentavos: 40000, versao: 3, ultimoEventoId: 'v3' }],
        ['versão regredida', { ...original, valorCentavos: 40000, versao: 0, ultimoEventoId: 'v0' }],
        ['tipo alterado', { ...original, tipo: 'reembolso', versao: 2, ultimoEventoId: 'v2' }],
        ['criadoEm reescrito', { ...original, criadoEm: '2026-09-19T14:00:00.000Z', versao: 2, ultimoEventoId: 'v2' }],
        ['criadoPor reescrito', { ...original, criadoPor: OUTRO_USUARIO, versao: 2, ultimoEventoId: 'v2' }],
        ['atualizadoPor de outro usuário', { ...original, valorCentavos: 40000, versao: 2, ultimoEventoId: 'v2', atualizadoPor: OUTRO_USUARIO }]
    ];
    for (const [nome, dados] of recusados) {
        assert.equal(
            (await lancar(USUARIO, 'ORC-76', 'pag-1', dados, { evento: 'correcao', anterior: original }, { existe: true })).permitido,
            false,
            nome
        );
    }

    const corrigido = { ...original, valorCentavos: 40000, versao: 2, ultimoEventoId: 'v2', atualizadoEm: '2026-09-19T09:00:00.000Z' };
    assert.equal(
        (await lancar(USUARIO, 'ORC-76', 'pag-1', corrigido, { evento: 'correcao', anterior: original }, { existe: true })).permitido,
        true,
        'correção válida'
    );

    const cancelado = { ...corrigido, ...CANCELAMENTO_MOVIMENTO, versao: 3, ultimoEventoId: 'v3', atualizadoEm: CANCELAMENTO_MOVIMENTO.canceladoEm };
    assert.equal(
        (await lancar(USUARIO, 'ORC-76', 'pag-1', cancelado,
            { evento: 'cancelamento', anterior: corrigido, motivo: CANCELAMENTO_MOVIMENTO.motivoCancelamento }, { existe: true })).permitido,
        true,
        'cancelamento válido'
    );

    // Cancelado é terminal: nem correção nem novo cancelamento.
    assert.equal(
        (await lancar(USUARIO, 'ORC-76', 'pag-1', { ...cancelado, valorCentavos: 1, versao: 4, ultimoEventoId: 'v4' },
            { evento: 'correcao', anterior: cancelado }, { existe: true })).permitido,
        false,
        'movimento cancelado não é corrigido'
    );
});

test('movimento financeiro nunca é excluído', async () => {
    await limpar();
    await semearPedidoV2('ORC-77');
    assert.equal((await lancar(USUARIO, 'ORC-77', 'pag-1', movimento())).permitido, true);
    assert.equal(
        (await requisitar('DELETE', urlDocumento('orcamentos/ORC-77/pagamentos', 'pag-1'), { uid: USUARIO })).permitido,
        false,
        'delete é sempre recusado'
    );
});

test('evento de auditoria não nasce sozinho: exige transição do movimento na mesma operação', async () => {
    await limpar();
    await semearPedidoV2('ORC-86');
    const original = movimento();

    // Evento de criação solto, antes de existir qualquer pagamento.
    const soltoEm = (pagamentoId, eventoId, dados) =>
        commitAtomico(USUARIO, [escrita(caminhoAud('ORC-86', pagamentoId, eventoId), dados)]);

    assert.equal(
        (await soltoEm('pag-1', 'v1', eventoDe(original))).permitido,
        false,
        'evento de criação v1 solto, antes do pagamento'
    );

    // Agora o pagamento existe, gravado junto com o evento v1.
    assert.equal((await lancar(USUARIO, 'ORC-86', 'pag-1', original)).permitido, true, 'pagamento + evento v1 no mesmo commit');

    const corrigido = { ...original, valorCentavos: 40000, versao: 2, ultimoEventoId: 'v2', atualizadoEm: '2026-09-19T09:00:00.000Z' };
    assert.equal(
        (await soltoEm('pag-1', 'v2', eventoDe(corrigido, { evento: 'correcao', anterior: original }))).permitido,
        false,
        'evento v2 solto sob pagamento existente, sem o pagamento mudar'
    );
    assert.equal(
        (await soltoEm('pag-1', 'v999', eventoDe(corrigido, { evento: 'correcao', anterior: original }))).permitido,
        false,
        'evento arbitrário v999 solto'
    );

    // Com o pagamento transicionando junto, a correção passa.
    assert.equal(
        (await lancar(USUARIO, 'ORC-86', 'pag-1', corrigido, { evento: 'correcao', anterior: original }, { existe: true })).permitido,
        true,
        'correção + evento v2 no mesmo commit'
    );

    const cancelado = { ...corrigido, ...CANCELAMENTO_MOVIMENTO, versao: 3, ultimoEventoId: 'v3', atualizadoEm: CANCELAMENTO_MOVIMENTO.canceladoEm };
    const eventoCancelamento = { evento: 'cancelamento', anterior: corrigido, motivo: CANCELAMENTO_MOVIMENTO.motivoCancelamento };
    assert.equal(
        (await soltoEm('pag-1', 'v3', eventoDe(cancelado, eventoCancelamento))).permitido,
        false,
        'evento de cancelamento solto'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-86', 'pag-1', cancelado, eventoCancelamento, { existe: true })).permitido,
        true,
        'cancelamento + evento vN no mesmo commit'
    );
});

test('criação financeira exige autoria do usuário autenticado', async () => {
    await limpar();
    await semearPedidoV2('ORC-87');

    const recusados = [
        ['criadoPor nulo', movimento({ criadoPor: null })],
        ['atualizadoPor nulo', movimento({ atualizadoPor: null })],
        ['criadoPor de outro usuário', movimento({ criadoPor: OUTRO_USUARIO })],
        ['atualizadoPor de outro usuário', movimento({ atualizadoPor: OUTRO_USUARIO })],
        ['criadoEm diferente de atualizadoEm', movimento({ atualizadoEm: '2026-09-19T08:00:00.000Z' })]
    ];
    for (const [indice, [nome, dados]] of recusados.entries()) {
        assert.equal((await lancar(USUARIO, 'ORC-87', `pag-a${indice}`, dados)).permitido, false, nome);
    }

    assert.equal(
        (await lancar(USUARIO, 'ORC-87', 'pag-registrador', movimento(), { registradoPor: OUTRO_USUARIO })).permitido,
        false,
        'registradoPor do evento de criação precisa ser o usuário autenticado'
    );
    assert.equal((await lancar(USUARIO, 'ORC-87', 'pag-ok', movimento())).permitido, true, 'criação com autoria correta');
});

test('o id do evento é derivado da versão: "v" + versao, imposto pelo servidor', async () => {
    await limpar();
    await semearPedidoV2('ORC-88');
    const original = movimento();

    assert.equal(
        (await lancar(USUARIO, 'ORC-88', 'pag-id', movimento({ ultimoEventoId: 'evento-inicial' }))).permitido,
        false,
        'criação com id fora do padrão'
    );
    assert.equal((await lancar(USUARIO, 'ORC-88', 'pag-1', original)).permitido, true);

    const corrigido = { ...original, valorCentavos: 40000, versao: 2, atualizadoEm: '2026-09-19T09:00:00.000Z' };
    assert.equal(
        (await lancar(USUARIO, 'ORC-88', 'pag-1', { ...corrigido, ultimoEventoId: 'v7' },
            { evento: 'correcao', anterior: original }, { existe: true })).permitido,
        false,
        'update com id que não corresponde à versão'
    );
    assert.equal(
        (await lancar(USUARIO, 'ORC-88', 'pag-1', { ...corrigido, ultimoEventoId: 'v2' },
            { evento: 'correcao', anterior: original }, { existe: true })).permitido,
        true,
        'update com id derivado da versão'
    );
});

test('a trilha de auditoria é imutável depois de gravada', async () => {
    await limpar();
    await semearPedidoV2('ORC-78');
    assert.equal((await lancar(USUARIO, 'ORC-78', 'pag-1', movimento())).permitido, true);

    const urlEvento = urlDocumento(`orcamentos/ORC-78/pagamentos/pag-1/auditoria`, 'v1');
    assert.equal(
        (await requisitar('PATCH', `${urlEvento}?updateMask.fieldPaths=motivo`,
            { uid: USUARIO, corpo: { fields: paraCampos({ motivo: 'reescrito' }) } })).permitido,
        false,
        'evento de auditoria não é alterado'
    );
    assert.equal((await requisitar('DELETE', urlEvento, { uid: USUARIO })).permitido, false, 'nem excluído');

    // Eventos malformados são recusados pela própria regra da subcoleção de auditoria.
    const eventoSolto = (id, dados) => commitAtomico(USUARIO, [escrita(caminhoAud('ORC-78', 'pag-1', id), dados)]);
    assert.equal((await eventoSolto('extra', { ...eventoDe(movimento()), passo: 1 })).permitido, false, 'campo extra');
    assert.equal((await eventoSolto('desconhecido', eventoDe(movimento(), { evento: 'ajuste' }))).permitido, false, 'evento desconhecido');
    assert.equal((await eventoSolto('instante', { ...eventoDe(movimento()), registradoEm: '2026-09-18' })).permitido, false, 'instante fora do formato');
});
