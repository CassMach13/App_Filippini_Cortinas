import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { cancelarPedido, confirmarOrcamentoComoPedido, obterItensAtuaisDoOrcamento } from '../order-domain.js';
import { calcularDetalhesItem } from '../pricing-domain.js';
import {
    ErroMovimento,
    FORMAS_PAGAMENTO,
    SITUACOES_FINANCEIRAS,
    STATUS_MOVIMENTO,
    TIPOS_MOVIMENTO,
    avaliarRestauracaoMovimento,
    calcularSituacaoFinanceira,
    cancelarMovimento,
    corrigirMovimento,
    criarEventoAuditoria,
    criarMovimento,
    ehDataMovimentoValida,
    obterValorReceberCentavos,
    pedidoAceitaMovimento,
    validarMovimento
} from '../payments-domain.js';

const HOJE = '2026-09-20';
const CANCELAMENTO_PEDIDO = { motivo: 'Cliente desistiu', canceladoEm: '2026-09-19T12:00:00.000Z', canceladoPor: 'usuario' };

function congelarProfundamente(valor) {
    if (valor && typeof valor === 'object') {
        Object.values(valor).forEach(congelarProfundamente);
        Object.freeze(valor);
    }
    return valor;
}

function criarOrcamento({ id = 'ORC-80', percentualComissao = 10 } = {}) {
    const detalhes = calcularDetalhesItem({ unidadeMedida: 'Unidade', precoCompra: 500, markup: 2 }, 1, 0, 0, percentualComissao);
    return {
        id,
        statusDocumento: 'orcamento',
        infoGerais: { nome: `Orçamento ${id}`, nomeCliente: 'Cliente Pagamentos', enderecoCliente: 'Rua A, 1' },
        infoComercial: { condicaoPagamento: 'À vista', descontoGlobal: 0, percentualComissao },
        valoresInstalacao: { Sala: 300 },
        itens: [{
            id: 'item-1', codigo: 'COD-1', fornecedor: 'Fornecedor A', unidadeMedida: 'Unidade', quantidade: 1,
            quantidadeCompra: 1, precoCompraUnitario: 500, custoReal: detalhes.custoReal,
            precoUnitarioBase: detalhes.precoUnitarioBase, precoTotalSemComissao: detalhes.precoTotalSemComissao,
            precoUnitario: detalhes.precoUnitario, precoTotal: detalhes.precoTotal
        }],
        produtosAcabados: []
    };
}

function criarPedidoV2(opcoes = {}) {
    return confirmarOrcamentoComoPedido(criarOrcamento(opcoes), {
        confirmadoEm: '2026-09-15T15:00:00.000Z', confirmadoPor: 'usuario-teste'
    });
}

function criarPedidoV1(id = 'ORC-81') {
    const base = criarOrcamento({ id });
    return {
        ...base,
        statusDocumento: 'pedido',
        pedido: {
            versaoSnapshot: 1, orcamentoId: id, confirmadoEm: '2026-09-01T12:00:00.000Z', confirmadoPor: 'usuario-antigo',
            cliente: { nome: base.infoGerais.nomeCliente, endereco: base.infoGerais.enderecoCliente },
            costureira: { nome: '', enderecoEntrega: '' },
            itens: obterItensAtuaisDoOrcamento(base)
        }
    };
}

function dadosRecebimento(extras = {}) {
    return {
        tipo: TIPOS_MOVIMENTO.RECEBIMENTO,
        dataMovimento: '2026-09-18',
        valorCentavos: 50000,
        formaPagamento: 'PIX',
        observacao: 'Sinal',
        criadoEm: '2026-09-18T14:00:00.000Z',
        criadoPor: 'usuario-teste',
        ...extras
    };
}

const criar = (extras = {}) => criarMovimento(dadosRecebimento(extras), { hoje: HOJE });

// --- Recebível: fonte única e exclusões ---------------------------------------------------------

test('o recebível vem do snapshot v2 e exclui a instalação, sem abater a comissão', () => {
    const pedido = criarPedidoV2();
    const financeiro = pedido.pedido.financeiro;

    assert.equal(obterValorReceberCentavos(pedido), financeiro.valorProdutosCobradoClienteCentavos);
    // A instalação existe no snapshot, mas nunca entra no recebível da Filippini.
    assert.ok(pedido.pedido.proposta.totalInstalacaoCentavos > 0);
    assert.notEqual(obterValorReceberCentavos(pedido), pedido.pedido.proposta.totalPropostaClienteCentavos);
    // A comissão continua embutida no que o cliente paga: o recebível não é o líquido.
    assert.ok(financeiro.valorComissaoCentavos > 0);
    assert.notEqual(obterValorReceberCentavos(pedido), financeiro.valorLiquidoFilippiniCentavos);
});

// --- Elegibilidade do pedido --------------------------------------------------------------------

test('só pedido v2 válido e não cancelado aceita recebimento', () => {
    assert.equal(pedidoAceitaMovimento(criarPedidoV2(), TIPOS_MOVIMENTO.RECEBIMENTO), true);
    assert.equal(pedidoAceitaMovimento(criarOrcamento(), TIPOS_MOVIMENTO.RECEBIMENTO), false, 'orçamento em negociação');
    assert.equal(pedidoAceitaMovimento(criarPedidoV1(), TIPOS_MOVIMENTO.RECEBIMENTO), false, 'pedido v1');

    const invalido = criarPedidoV2();
    invalido.pedido.financeiro.valorComissaoCentavos += 1;
    assert.equal(pedidoAceitaMovimento(invalido, TIPOS_MOVIMENTO.RECEBIMENTO), false, 'snapshot v2 inválido');
});

test('pedido cancelado recusa novo recebimento, mas aceita reembolso', () => {
    const cancelado = cancelarPedido(criarPedidoV2(), CANCELAMENTO_PEDIDO);
    assert.equal(pedidoAceitaMovimento(cancelado, TIPOS_MOVIMENTO.RECEBIMENTO), false);
    assert.equal(pedidoAceitaMovimento(cancelado, TIPOS_MOVIMENTO.REEMBOLSO), true);
});

test('pedido v1 não aceita nem reembolso, e tipo desconhecido é sempre recusado', () => {
    assert.equal(pedidoAceitaMovimento(criarPedidoV1(), TIPOS_MOVIMENTO.REEMBOLSO), false);
    assert.equal(pedidoAceitaMovimento(criarPedidoV2(), 'estorno'), false);
});

// --- Criação e validação ------------------------------------------------------------------------

test('movimento novo nasce ativo, na versão 1, com auditoria de criação', () => {
    const movimento = criar();
    assert.equal(movimento.status, STATUS_MOVIMENTO.ATIVO);
    assert.equal(movimento.versao, 1);
    assert.equal(movimento.atualizadoEm, movimento.criadoEm);
    assert.equal(validarMovimento(movimento, { hoje: HOJE }).valido, true);
    assert.ok(!('canceladoEm' in movimento), 'movimento ativo não carrega campos de cancelamento');

    const evento = criarEventoAuditoria('criacao', null, movimento, { registradoEm: movimento.criadoEm, registradoPor: 'usuario-teste' });
    assert.equal(evento.versaoAnterior, null);
    assert.equal(evento.versaoNova, 1);
    assert.equal(evento.estadoAnterior, null);
    assert.equal(evento.estadoNovo.valorCentavos, 50000);
});

test('valor precisa ser inteiro positivo em centavos', () => {
    assert.throws(() => criar({ valorCentavos: 0 }), ErroMovimento);
    assert.throws(() => criar({ valorCentavos: -100 }), ErroMovimento);
    assert.throws(() => criar({ valorCentavos: 100.5 }), ErroMovimento);
    assert.throws(() => criar({ valorCentavos: '100' }), ErroMovimento);
});

test('forma de pagamento precisa estar na lista fixa', () => {
    FORMAS_PAGAMENTO.forEach(forma => assert.equal(criar({ formaPagamento: forma }).formaPagamento, forma));
    assert.throws(() => criar({ formaPagamento: 'Cheque' }), ErroMovimento);
});

// --- Datas --------------------------------------------------------------------------------------

test('data passada é aceita, inclusive anterior à confirmação do pedido', () => {
    const pedido = criarPedidoV2();
    const anteriorAConfirmacao = '2026-09-10';
    assert.ok(anteriorAConfirmacao < pedido.pedido.financeiro.dataVenda);
    assert.equal(criar({ dataMovimento: anteriorAConfirmacao }).dataMovimento, anteriorAConfirmacao);
    assert.equal(ehDataMovimentoValida(anteriorAConfirmacao, HOJE), true);
});

test('data de hoje é aceita e data futura é recusada', () => {
    assert.equal(ehDataMovimentoValida(HOJE, HOJE), true);
    assert.equal(ehDataMovimentoValida('2026-09-21', HOJE), false);
    assert.throws(() => criar({ dataMovimento: '2026-09-21' }), ErroMovimento);
    assert.equal(ehDataMovimentoValida('20/09/2026', HOJE), false);
});

// --- Correção -----------------------------------------------------------------------------------

test('correção muda o estado efetivo, incrementa a versão e não move dinheiro', () => {
    const original = congelarProfundamente(criar());
    const corrigido = corrigirMovimento(original, {
        valorCentavos: 45000, dataMovimento: '2026-09-17', atualizadoEm: '2026-09-20T10:00:00.000Z', atualizadoPor: 'outro-usuario'
    }, { hoje: HOJE });

    assert.equal(corrigido.versao, 2);
    assert.equal(corrigido.valorCentavos, 45000);
    assert.equal(corrigido.dataMovimento, '2026-09-17');
    assert.equal(corrigido.status, STATUS_MOVIMENTO.ATIVO, 'correção não cancela');
    assert.equal(corrigido.criadoEm, original.criadoEm, 'a criação é preservada');
    // Correção não é reembolso: nenhum movimento novo nasce, e o tipo continua o mesmo.
    assert.equal(corrigido.tipo, TIPOS_MOVIMENTO.RECEBIMENTO);
    assert.equal(original.valorCentavos, 50000, 'o movimento original não é mutado');

    const evento = criarEventoAuditoria('correcao', original, corrigido, { registradoEm: corrigido.atualizadoEm });
    assert.equal(evento.versaoAnterior, 1);
    assert.equal(evento.versaoNova, 2);
    assert.equal(evento.estadoAnterior.valorCentavos, 50000, 'a auditoria preserva a versão anterior');
    assert.equal(evento.estadoNovo.valorCentavos, 45000);
});

test('correção não pode inventar valor inválido nem data futura', () => {
    const original = criar();
    assert.throws(() => corrigirMovimento(original, { valorCentavos: 0 }, { hoje: HOJE }), ErroMovimento);
    assert.throws(() => corrigirMovimento(original, { dataMovimento: '2026-09-25' }, { hoje: HOJE }), ErroMovimento);
});

// --- Cancelamento do lançamento -----------------------------------------------------------------

test('cancelar lançamento exige motivo, é terminal e não gera saída de caixa', () => {
    const original = congelarProfundamente(criar());
    const cancelado = cancelarMovimento(original, {
        motivo: 'Lançado em duplicidade', canceladoEm: '2026-09-20T11:00:00.000Z', canceladoPor: 'usuario-teste'
    });

    assert.equal(cancelado.status, STATUS_MOVIMENTO.CANCELADO);
    assert.equal(cancelado.versao, 2);
    assert.equal(cancelado.motivoCancelamento, 'Lançado em duplicidade');
    assert.equal(cancelado.tipo, TIPOS_MOVIMENTO.RECEBIMENTO, 'cancelar não cria um reembolso');
    assert.equal(validarMovimento(cancelado, { hoje: HOJE }).valido, true);

    assert.throws(() => cancelarMovimento(cancelado, { motivo: 'De novo' }), ErroMovimento);
    assert.throws(() => corrigirMovimento(cancelado, { valorCentavos: 1 }, { hoje: HOJE }), ErroMovimento);
    assert.throws(() => cancelarMovimento(original, { motivo: '   ' }), ErroMovimento);
    assert.throws(() => cancelarMovimento(original, { motivo: 'x'.repeat(501) }), ErroMovimento);
});

test('movimento ativo não pode carregar campos de cancelamento', () => {
    const invalido = { ...criar(), canceladoEm: '2026-09-20T11:00:00.000Z' };
    assert.deepEqual(validarMovimento(invalido, { hoje: HOJE }).erros, ['cancelamento-em-movimento-ativo']);
});

// --- Situação financeira ------------------------------------------------------------------------

function situacao(movimentos, opcoes = {}) {
    return calcularSituacaoFinanceira(criarPedidoV2(opcoes), movimentos);
}

test('sem movimentos o pedido fica em aberto pelo valor cheio', () => {
    const resultado = situacao([]);
    assert.equal(resultado.situacao, SITUACOES_FINANCEIRAS.EM_ABERTO);
    assert.equal(resultado.saldoCentavos, resultado.valorReceberCentavos);
    assert.equal(resultado.excedenteCentavos, 0);
});

test('recebimento parcial, quitação exata e excedente são distinguidos', () => {
    const total = obterValorReceberCentavos(criarPedidoV2());

    const parcial = situacao([criar({ valorCentavos: total - 1 })]);
    assert.equal(parcial.situacao, SITUACOES_FINANCEIRAS.PARCIALMENTE_PAGO);
    assert.equal(parcial.saldoCentavos, 1);
    assert.equal(parcial.excedenteCentavos, 0);

    const quitado = situacao([criar({ valorCentavos: total })]);
    assert.equal(quitado.situacao, SITUACOES_FINANCEIRAS.QUITADO);
    assert.equal(quitado.saldoCentavos, 0);
    assert.equal(quitado.excedenteCentavos, 0);

    const excedente = situacao([criar({ valorCentavos: total + 2500 })]);
    assert.equal(excedente.situacao, SITUACOES_FINANCEIRAS.EXCEDENTE);
    // O saldo negativo não é truncado em zero: o excedente precisa aparecer.
    assert.equal(excedente.saldoCentavos, -2500);
    assert.equal(excedente.excedenteCentavos, 2500);
});

test('as somas fecham em centavos inteiros, sem float', () => {
    const movimentos = [1, 3, 7, 11, 13].map((n, indice) => criar({ valorCentavos: n * 3333, criadoEm: `2026-09-1${indice}T10:00:00.000Z` }));
    const esperado = movimentos.reduce((soma, movimento) => soma + movimento.valorCentavos, 0);
    const resultado = situacao(movimentos);

    assert.equal(resultado.recebidoCentavos, esperado);
    assert.ok(Number.isSafeInteger(resultado.recebidoCentavos));
    assert.ok(Number.isSafeInteger(resultado.saldoCentavos));
    assert.equal(resultado.saldoCentavos, resultado.valorReceberCentavos - esperado);
});

test('movimento cancelado não entra em nenhuma soma', () => {
    const ativo = criar({ valorCentavos: 10000 });
    const cancelado = cancelarMovimento(criar({ valorCentavos: 90000 }), { motivo: 'Erro de digitação' });
    const resultado = situacao([ativo, cancelado]);

    assert.equal(resultado.recebidoCentavos, 10000);
    assert.equal(resultado.situacao, SITUACOES_FINANCEIRAS.PARCIALMENTE_PAGO);
});

test('reembolso reduz o recebido líquido e pode devolver o pedido a "em aberto"', () => {
    const recebimento = criar({ valorCentavos: 30000 });
    const reembolso = criar({ tipo: TIPOS_MOVIMENTO.REEMBOLSO, valorCentavos: 30000, observacao: 'Devolução integral' });
    const resultado = situacao([recebimento, reembolso]);

    assert.equal(resultado.recebidoCentavos, 30000);
    assert.equal(resultado.reembolsadoCentavos, 30000);
    assert.equal(resultado.recebimentosLiquidosCentavos, 0);
    assert.equal(resultado.situacao, SITUACOES_FINANCEIRAS.EM_ABERTO);
    assert.equal(resultado.saldoCentavos, resultado.valorReceberCentavos);
});

test('a situação não muta os movimentos nem o pedido recebidos', () => {
    const pedido = congelarProfundamente(criarPedidoV2());
    const movimentos = congelarProfundamente([criar({ valorCentavos: 12345 })]);
    assert.doesNotThrow(() => calcularSituacaoFinanceira(pedido, movimentos));
});

// --- Restauração de backup ----------------------------------------------------------------------

test('backup não restaura movimento sem um pedido v2 íntegro por trás', () => {
    const movimento = criar();
    const snapshotInvalido = criarPedidoV2();
    snapshotInvalido.pedido.financeiro.valorComissaoCentavos += 1;

    assert.equal(avaliarRestauracaoMovimento(null, movimento, null).motivo, 'pedido-inexistente');
    assert.equal(avaliarRestauracaoMovimento(null, movimento, criarPedidoV1()).motivo, 'pedido-v1');
    assert.equal(avaliarRestauracaoMovimento(null, movimento, criarOrcamento()).motivo, 'pedido-sem-snapshot-v2-valido');
    assert.equal(avaliarRestauracaoMovimento(null, movimento, snapshotInvalido).motivo, 'pedido-sem-snapshot-v2-valido');
});

test('backup nunca sobrescreve movimento existente', () => {
    const existente = criar();
    const antigo = { ...existente, valorCentavos: 999 };
    const avaliacao = avaliarRestauracaoMovimento(existente, antigo, criarPedidoV2());
    assert.equal(avaliacao.gravar, false);
    assert.equal(avaliacao.motivo, 'movimento-ja-existe');
});

test('backup restaura toda a história financeira de pedido posteriormente cancelado', () => {
    // O pedido recebeu dinheiro e só depois foi cancelado. O cancelamento não torna inexistente o que
    // entrou antes dele, então a história inteira precisa voltar num restore.
    const pedidoCancelado = cancelarPedido(criarPedidoV2(), CANCELAMENTO_PEDIDO);

    const recebimentoAtivo = criar();
    const recebimentoCancelado = cancelarMovimento(criar(), { motivo: 'Lançado em duplicidade' });
    const reembolso = criar({ tipo: TIPOS_MOVIMENTO.REEMBOLSO });

    assert.equal(avaliarRestauracaoMovimento(null, recebimentoAtivo, pedidoCancelado).gravar, true, 'recebimento ativo histórico');
    assert.equal(avaliarRestauracaoMovimento(null, recebimentoCancelado, pedidoCancelado).gravar, true, 'recebimento cancelado logicamente');
    assert.equal(avaliarRestauracaoMovimento(null, reembolso, pedidoCancelado).gravar, true, 'reembolso histórico');
});

test('restaurar história e lançar movimento novo são perguntas diferentes', () => {
    // Operacional: pedidoAceitaMovimento responde "posso lançar agora?".
    const pedidoCancelado = cancelarPedido(criarPedidoV2(), CANCELAMENTO_PEDIDO);
    assert.equal(pedidoAceitaMovimento(pedidoCancelado, TIPOS_MOVIMENTO.RECEBIMENTO), false, 'recebimento novo é recusado');
    assert.equal(pedidoAceitaMovimento(pedidoCancelado, TIPOS_MOVIMENTO.REEMBOLSO), true, 'reembolso novo é permitido');

    // Restauração: a mesma situação aceita de volta o recebimento histórico.
    assert.equal(avaliarRestauracaoMovimento(null, criar(), pedidoCancelado).gravar, true, 'recebimento histórico é restaurável');
});

test('backup restaura recebimento, reembolso, cancelado e versão > 1 sob pedido ativo', () => {
    const pedidoAtivo = criarPedidoV2();
    const cancelado = cancelarMovimento(criar(), { motivo: 'Erro de digitação' });

    assert.equal(avaliarRestauracaoMovimento(null, criar(), pedidoAtivo).gravar, true, 'recebimento');
    assert.equal(avaliarRestauracaoMovimento(null, criar({ tipo: TIPOS_MOVIMENTO.REEMBOLSO }), pedidoAtivo).gravar, true, 'reembolso');
    assert.equal(avaliarRestauracaoMovimento(null, cancelado, pedidoAtivo).gravar, true, 'movimento logicamente cancelado');
    assert.equal(cancelado.versao, 2);
    assert.equal(avaliarRestauracaoMovimento(null, cancelado, pedidoAtivo).gravar, true, 'versão > 1 é permitida no domínio');
});

test('BLOQUEADOR DE DEPLOY: o backup ainda não cobre pagamentos, então nenhum write financeiro pode ir a produção', () => {
    // Guarda formal da Etapa 4: enquanto exportarDados/importarDados não incluírem a subcoleção de
    // pagamentos e a auditoria, um pagamento real em produção ficaria fora do backup. Quando a
    // integração da 4B2 existir, este teste deve ser trocado por um de ida e volta do backup real.
    const fonteApps = readFileSync(new URL('../apps.js', import.meta.url), 'utf8');
    const trechoExportacao = fonteApps.slice(fonteApps.indexOf('function exportarDados()'), fonteApps.indexOf('async function gravarDocumentosEmLotes'));

    assert.ok(!trechoExportacao.includes('pagamentos'), 'exportarDados ainda não exporta pagamentos: liberar pagamento em produção é bloqueado');
    assert.ok(!fonteApps.includes('avaliarRestauracaoMovimento'), 'importarDados ainda não restaura pagamentos');
});

test('backup recusa movimento estruturalmente inválido', () => {
    const corrompido = { ...criar(), valorCentavos: -1 };
    const avaliacao = avaliarRestauracaoMovimento(null, corrompido, criarPedidoV2());
    assert.equal(avaliacao.gravar, false);
    assert.match(avaliacao.motivo, /^movimento-invalido:/);
});
