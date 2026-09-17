import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cancelarPedido,
    confirmarOrcamentoComoPedido,
    marcarOrcamentoComoPerdido,
    obterItensAtuaisDoOrcamento
} from '../order-domain.js';
import { calcularDetalhesItem } from '../pricing-domain.js';
import { gerarRelatorioVendas } from '../sales-report-domain.js';

const PRODUTO_UNIDADE = { unidadeMedida: 'Unidade', precoCompra: 500, markup: 2 };
const CANCELAMENTO = { motivo: 'Cliente desistiu da compra', canceladoEm: '2026-09-18T12:00:00.000Z', canceladoPor: 'usuario-teste' };

function congelarProfundamente(valor) {
    if (valor && typeof valor === 'object') {
        Object.values(valor).forEach(congelarProfundamente);
        Object.freeze(valor);
    }
    return valor;
}

function criarItem(id, percentual, extras = {}) {
    const detalhes = calcularDetalhesItem(PRODUTO_UNIDADE, 1, 0, 0, percentual);
    return {
        id,
        codigo: `COD-${id}`,
        fornecedor: 'Fornecedor A',
        unidadeMedida: 'Unidade',
        quantidade: 1,
        quantidadeCompra: 1,
        precoCompraUnitario: PRODUTO_UNIDADE.precoCompra,
        custoReal: detalhes.custoReal,
        precoUnitarioBase: detalhes.precoUnitarioBase,
        precoTotalSemComissao: detalhes.precoTotalSemComissao,
        precoUnitario: detalhes.precoUnitario,
        precoTotal: detalhes.precoTotal,
        ...extras
    };
}

function criarOrcamento({ id = 'ORC-70', percentualComissao = 0, nomeCliente = 'Cliente Vendas' } = {}) {
    return {
        id,
        statusDocumento: 'orcamento',
        infoGerais: { nome: `Orçamento ${id}`, nomeCliente, enderecoCliente: 'Rua A, 1' },
        infoComercial: { condicaoPagamento: 'À vista', descontoGlobal: 0, percentualComissao },
        itens: [criarItem('a', percentualComissao)]
    };
}

function confirmar(orcamento, confirmadoEm = '2026-09-17T15:00:00.000Z', confirmadoPor = 'usuario-teste') {
    return confirmarOrcamentoComoPedido(orcamento, { confirmadoEm, confirmadoPor });
}

// Pedido no formato histórico v1. O sistema não gera mais esse formato; existe só para os testes de
// compatibilidade, que devem excluí-lo do relatório sem nenhum cálculo monetário.
function criarPedidoV1(orcamento, confirmadoEm = '2026-09-01T12:00:00.000Z') {
    return {
        ...structuredClone(orcamento),
        statusDocumento: 'pedido',
        pedido: {
            versaoSnapshot: 1,
            orcamentoId: orcamento.id,
            confirmadoEm,
            confirmadoPor: 'usuario-antigo',
            cliente: { nome: orcamento.infoGerais.nomeCliente, endereco: orcamento.infoGerais.enderecoCliente },
            costureira: { nome: '', enderecoEntrega: '' },
            itens: obterItensAtuaisDoOrcamento(orcamento)
        }
    };
}

const MES_SETEMBRO = { dataInicial: '2026-09-01', dataFinal: '2026-09-30' };

test('relatório vazio: sem orçamentos ou sem nenhum pedido v2 no período', () => {
    const vazio1 = gerarRelatorioVendas([], MES_SETEMBRO);
    assert.deepEqual(vazio1.vendas, []);
    assert.deepEqual(vazio1.totais, {
        quantidadePedidos: 0, valorProdutosCobradoClienteCentavos: 0, valorComissaoCentavos: 0, valorLiquidoFilippiniCentavos: 0
    });
    assert.equal(vazio1.quantidadePedidosV1, 0);
    assert.deepEqual(vazio1.inconsistencias, []);

    const soOrcamentos = [criarOrcamento({ id: 'ORC-01' }), criarOrcamento({ id: 'ORC-02' })];
    assert.deepEqual(gerarRelatorioVendas(soOrcamentos, MES_SETEMBRO).vendas, []);
    assert.deepEqual(gerarRelatorioVendas(null, MES_SETEMBRO).vendas, []);
    assert.deepEqual(gerarRelatorioVendas(undefined, MES_SETEMBRO).vendas, []);
});

test('um pedido v2 válido aparece com os valores do snapshot, não do orçamento vivo', () => {
    const orcamento = criarOrcamento({ id: 'ORC-01', percentualComissao: 10 });
    const pedido = confirmar(orcamento, '2026-09-15T15:00:00.000Z');
    congelarProfundamente(pedido);

    const relatorio = gerarRelatorioVendas([pedido], MES_SETEMBRO);
    assert.equal(relatorio.vendas.length, 1);
    const venda = relatorio.vendas[0];
    assert.equal(venda.orcamentoId, 'ORC-01');
    assert.equal(venda.dataVenda, '2026-09-15');
    assert.equal(venda.clienteNome, 'Cliente Vendas');
    assert.equal(venda.produtosCobradoClienteCentavos, 110000);
    assert.equal(venda.comissaoCentavos, 10000);
    assert.equal(venda.liquidoFilippiniCentavos, 100000);
    assert.equal(venda.produtosCobradoClienteCentavos - venda.comissaoCentavos, venda.liquidoFilippiniCentavos);
    assert.deepEqual(relatorio.totais, {
        quantidadePedidos: 1, valorProdutosCobradoClienteCentavos: 110000, valorComissaoCentavos: 10000, valorLiquidoFilippiniCentavos: 100000
    });
});

test('instalação fica fora do relatório mesmo quando o snapshot tem valor de instalação congelado', () => {
    const orcamento = criarOrcamento({ id: 'ORC-01', percentualComissao: 10 });
    orcamento.valoresInstalacao = { Sala: 500 };
    const pedido = confirmar(orcamento, '2026-09-15T15:00:00.000Z');
    assert.ok(pedido.pedido.proposta.totalInstalacaoCentavos > 0, 'pré-condição: instalação foi congelada no snapshot');

    const relatorio = gerarRelatorioVendas([pedido], MES_SETEMBRO);
    const venda = relatorio.vendas[0];
    assert.equal(venda.produtosCobradoClienteCentavos, pedido.pedido.financeiro.valorProdutosCobradoClienteCentavos);
    assert.equal(relatorio.totais.valorProdutosCobradoClienteCentavos, pedido.pedido.financeiro.valorProdutosCobradoClienteCentavos);
});

test('vários pedidos v2 somam exatamente em centavos, sem float', () => {
    const percentuais = [0, 5, 10, 7.5, 12.34];
    const pedidos = percentuais.map((percentual, indice) =>
        confirmar(criarOrcamento({ id: `ORC-${indice + 1}`, percentualComissao: percentual }), `2026-09-1${indice}T12:00:00.000Z`));

    const relatorio = gerarRelatorioVendas(pedidos, MES_SETEMBRO);
    assert.equal(relatorio.vendas.length, 5);
    assert.equal(relatorio.totais.quantidadePedidos, 5);

    const somaEsperadaCobrado = pedidos.reduce((soma, p) => soma + p.pedido.financeiro.valorProdutosCobradoClienteCentavos, 0);
    const somaEsperadaComissao = pedidos.reduce((soma, p) => soma + p.pedido.financeiro.valorComissaoCentavos, 0);
    const somaEsperadaLiquido = pedidos.reduce((soma, p) => soma + p.pedido.financeiro.valorLiquidoFilippiniCentavos, 0);
    assert.equal(relatorio.totais.valorProdutosCobradoClienteCentavos, somaEsperadaCobrado);
    assert.equal(relatorio.totais.valorComissaoCentavos, somaEsperadaComissao);
    assert.equal(relatorio.totais.valorLiquidoFilippiniCentavos, somaEsperadaLiquido);
    assert.equal(
        relatorio.totais.valorProdutosCobradoClienteCentavos - relatorio.totais.valorComissaoCentavos,
        relatorio.totais.valorLiquidoFilippiniCentavos
    );
    [...Array.from({ length: percentuais.length }).keys()].forEach(indice => {
        assert.ok(Number.isInteger(relatorio.vendas[indice].produtosCobradoClienteCentavos));
    });
});

test('pedido v1 é excluído das vendas e contado só como histórico informativo', () => {
    const orcamentoV1 = criarOrcamento({ id: 'ORC-06' });
    const pedidoV1 = criarPedidoV1(orcamentoV1, '2026-09-12T15:00:00.000Z');
    const pedidoV2 = confirmar(criarOrcamento({ id: 'ORC-07' }), '2026-09-15T15:00:00.000Z');

    const relatorio = gerarRelatorioVendas([pedidoV1, pedidoV2], MES_SETEMBRO);
    assert.equal(relatorio.vendas.length, 1);
    assert.equal(relatorio.vendas[0].orcamentoId, 'ORC-07');
    assert.equal(relatorio.quantidadePedidosV1, 1);
    assert.deepEqual(relatorio.inconsistencias, []);

    // v1 não é contado nem quando confirmadoEm cai fora do período: a contagem é sempre total, não por período.
    const v1ForaDoPeriodo = criarPedidoV1(criarOrcamento({ id: 'ORC-08' }), '2026-01-01T12:00:00.000Z');
    const relatorio2 = gerarRelatorioVendas([pedidoV1, v1ForaDoPeriodo], MES_SETEMBRO);
    assert.equal(relatorio2.quantidadePedidosV1, 2);
    assert.equal(relatorio2.vendas.length, 0);
});

test('orçamento em negociação e perdido são excluídos', () => {
    const emNegociacao = criarOrcamento({ id: 'ORC-01' });
    const perdido = marcarOrcamentoComoPerdido(criarOrcamento({ id: 'ORC-02' }), { alteradoEm: '2026-09-10T12:00:00.000Z' });
    const pedidoV2 = confirmar(criarOrcamento({ id: 'ORC-03' }), '2026-09-15T15:00:00.000Z');

    const relatorio = gerarRelatorioVendas([emNegociacao, perdido, pedidoV2], MES_SETEMBRO);
    assert.deepEqual(relatorio.vendas.map(v => v.orcamentoId), ['ORC-03']);
});

test('pedido v2 cancelado é excluído das somas e contado só se a venda caiu no período', () => {
    const pedido = confirmar(criarOrcamento({ id: 'ORC-01' }), '2026-09-15T15:00:00.000Z');
    const cancelado = cancelarPedido(pedido, CANCELAMENTO);
    congelarProfundamente(cancelado);

    const relatorio = gerarRelatorioVendas([cancelado], MES_SETEMBRO);
    assert.deepEqual(relatorio.vendas, []);
    assert.deepEqual(relatorio.totais, {
        quantidadePedidos: 0, valorProdutosCobradoClienteCentavos: 0, valorComissaoCentavos: 0, valorLiquidoFilippiniCentavos: 0
    });
    assert.equal(relatorio.quantidadeCanceladosNoPeriodo, 1);
    assert.deepEqual(relatorio.inconsistencias, []);

    // Cancelado com a venda fora do período consultado não é contado nem aqui.
    const relatorioAgosto = gerarRelatorioVendas([cancelado], { dataInicial: '2026-08-01', dataFinal: '2026-08-31' });
    assert.equal(relatorioAgosto.quantidadeCanceladosNoPeriodo, 0);
    assert.deepEqual(relatorioAgosto.vendas, []);

    // Misturado com um pedido ativo: só o ativo entra nas somas.
    const ativo = confirmar(criarOrcamento({ id: 'ORC-02' }), '2026-09-16T15:00:00.000Z');
    const relatorioMisto = gerarRelatorioVendas([cancelado, ativo], MES_SETEMBRO);
    assert.deepEqual(relatorioMisto.vendas.map(v => v.orcamentoId), ['ORC-02']);
    assert.equal(relatorioMisto.quantidadeCanceladosNoPeriodo, 1);
});

test('snapshot v2 inválido é excluído e reportado como inconsistência, nunca recalculado', () => {
    const pedido = confirmar(criarOrcamento({ id: 'ORC-01' }), '2026-09-15T15:00:00.000Z');
    const invalido = structuredClone(pedido);
    invalido.pedido.financeiro.valorComissaoCentavos += 1; // quebra a relação líquido = cobrado - comissão

    const relatorio = gerarRelatorioVendas([invalido], MES_SETEMBRO);
    assert.deepEqual(relatorio.vendas, []);
    assert.deepEqual(relatorio.inconsistencias, [{ orcamentoId: 'ORC-01', tipo: 'snapshot-v2-invalido' }]);
    assert.deepEqual(relatorio.totais, {
        quantidadePedidos: 0, valorProdutosCobradoClienteCentavos: 0, valorComissaoCentavos: 0, valorLiquidoFilippiniCentavos: 0
    });

    // Snapshot copiado para outro documento (orcamentoId divergente) também é inconsistência, não fallback.
    const copiado = { ...structuredClone(pedido), id: 'ORC-99' };
    const relatorio2 = gerarRelatorioVendas([copiado], MES_SETEMBRO);
    assert.deepEqual(relatorio2.inconsistencias, [{ orcamentoId: 'ORC-99', tipo: 'snapshot-v2-invalido' }]);

    // Misturado com um pedido válido: o válido entra normalmente, o inválido só aparece como inconsistência.
    const valido = confirmar(criarOrcamento({ id: 'ORC-02' }), '2026-09-16T15:00:00.000Z');
    const relatorioMisto = gerarRelatorioVendas([invalido, valido], MES_SETEMBRO);
    assert.deepEqual(relatorioMisto.vendas.map(v => v.orcamentoId), ['ORC-02']);
    assert.deepEqual(relatorioMisto.inconsistencias, [{ orcamentoId: 'ORC-01', tipo: 'snapshot-v2-invalido' }]);
});

test('período inclusivo: venda exatamente na data inicial e na data final entram', () => {
    const naInicial = confirmar(criarOrcamento({ id: 'ORC-01' }), '2026-09-01T03:00:00.000Z'); // 2026-09-01 em Brasília
    const naFinal = confirmar(criarOrcamento({ id: 'ORC-02' }), '2026-09-30T23:00:00.000Z'); // 2026-09-30 em Brasília
    assert.equal(naInicial.pedido.financeiro.dataVenda, '2026-09-01');
    assert.equal(naFinal.pedido.financeiro.dataVenda, '2026-09-30');

    const relatorio = gerarRelatorioVendas([naInicial, naFinal], MES_SETEMBRO);
    assert.deepEqual(relatorio.vendas.map(v => v.orcamentoId).sort(), ['ORC-01', 'ORC-02']);
});

test('vendas fora do período, antes ou depois, não entram', () => {
    const antes = confirmar(criarOrcamento({ id: 'ORC-01' }), '2026-08-31T12:00:00.000Z');
    const depois = confirmar(criarOrcamento({ id: 'ORC-02' }), '2026-10-01T12:00:00.000Z');
    const dentro = confirmar(criarOrcamento({ id: 'ORC-03' }), '2026-09-15T12:00:00.000Z');

    const relatorio = gerarRelatorioVendas([antes, depois, dentro], MES_SETEMBRO);
    assert.deepEqual(relatorio.vendas.map(v => v.orcamentoId), ['ORC-03']);
});

test('período de um único dia funciona e data inicial maior que a final lança erro', () => {
    const venda = confirmar(criarOrcamento({ id: 'ORC-01' }), '2026-09-15T15:00:00.000Z');
    const relatorio = gerarRelatorioVendas([venda], { dataInicial: '2026-09-15', dataFinal: '2026-09-15' });
    assert.equal(relatorio.vendas.length, 1);

    assert.throws(() => gerarRelatorioVendas([venda], { dataInicial: '2026-09-16', dataFinal: '2026-09-15' }), RangeError);
    assert.throws(() => gerarRelatorioVendas([venda], { dataInicial: '2026-09-15', dataFinal: '2026-09-15X' }), TypeError);
    assert.throws(() => gerarRelatorioVendas([venda], { dataInicial: '', dataFinal: '2026-09-15' }), TypeError);
    assert.throws(() => gerarRelatorioVendas([venda], {}), TypeError);
});

test('virada de mês e de ano: a data civil de Brasília decide, não o instante em UTC', () => {
    // 2026-09-01T02:59:59.999Z ainda é 31/08 em Brasília (UTC-3): fora de setembro.
    const antesDaVirada = confirmar(criarOrcamento({ id: 'ORC-01' }), '2026-09-01T02:59:59.999Z');
    const naVirada = confirmar(criarOrcamento({ id: 'ORC-02' }), '2026-09-01T03:00:00.000Z');
    assert.equal(antesDaVirada.pedido.financeiro.dataVenda, '2026-08-31');
    assert.equal(naVirada.pedido.financeiro.dataVenda, '2026-09-01');

    const relatorioSetembro = gerarRelatorioVendas([antesDaVirada, naVirada], MES_SETEMBRO);
    assert.deepEqual(relatorioSetembro.vendas.map(v => v.orcamentoId), ['ORC-02']);
    const relatorioAgosto = gerarRelatorioVendas([antesDaVirada, naVirada], { dataInicial: '2026-08-01', dataFinal: '2026-08-31' });
    assert.deepEqual(relatorioAgosto.vendas.map(v => v.orcamentoId), ['ORC-01']);

    // Virada de ano.
    const antesDoAno = confirmar(criarOrcamento({ id: 'ORC-03' }), '2027-01-01T02:59:59.999Z');
    const noAnoNovo = confirmar(criarOrcamento({ id: 'ORC-04' }), '2027-01-01T03:00:00.000Z');
    assert.equal(antesDoAno.pedido.financeiro.dataVenda, '2026-12-31');
    assert.equal(noAnoNovo.pedido.financeiro.dataVenda, '2027-01-01');
    const relatorioDezembro = gerarRelatorioVendas([antesDoAno, noAnoNovo], { dataInicial: '2026-12-01', dataFinal: '2026-12-31' });
    assert.deepEqual(relatorioDezembro.vendas.map(v => v.orcamentoId), ['ORC-03']);
});

test('comissão 0%, 5% e 10% aparecem corretas na linha e nos totais', () => {
    const casos = [[0, 100000, 0, 100000], [5, 105000, 5000, 100000], [10, 110000, 10000, 100000]];
    casos.forEach(([percentual, cobrado, comissao, liquido], indice) => {
        const pedido = confirmar(criarOrcamento({ id: `ORC-${indice}`, percentualComissao: percentual }), '2026-09-15T15:00:00.000Z');
        const relatorio = gerarRelatorioVendas([pedido], MES_SETEMBRO);
        const venda = relatorio.vendas[0];
        assert.equal(venda.produtosCobradoClienteCentavos, cobrado, `percentual ${percentual}`);
        assert.equal(venda.comissaoCentavos, comissao, `percentual ${percentual}`);
        assert.equal(venda.liquidoFilippiniCentavos, liquido, `percentual ${percentual}`);
    });
});

test('cliente vem do snapshot; alterar infoGerais.nomeCliente depois não muda o relatório', () => {
    const orcamento = criarOrcamento({ id: 'ORC-01', nomeCliente: 'Cliente Original' });
    const pedido = confirmar(orcamento, '2026-09-15T15:00:00.000Z');

    pedido.infoGerais.nomeCliente = 'Nome Trocado Depois';
    const relatorio = gerarRelatorioVendas([pedido], MES_SETEMBRO);
    assert.equal(relatorio.vendas[0].clienteNome, 'Cliente Original');
});

test('alteração posterior no orçamento vivo (itens, desconto, instalação) não muda os valores do relatório', () => {
    const pedido = confirmar(criarOrcamento({ id: 'ORC-01', percentualComissao: 10 }), '2026-09-15T15:00:00.000Z');
    const relatorioAntes = gerarRelatorioVendas([pedido], MES_SETEMBRO);

    pedido.infoComercial.descontoGlobal = 90;
    pedido.itens[0].precoTotal = 1;
    pedido.itens[0].custoReal = 1;
    pedido.valoresInstalacao = { Sala: 99999 };

    const relatorioDepois = gerarRelatorioVendas([pedido], MES_SETEMBRO);
    assert.deepEqual(relatorioDepois.vendas, relatorioAntes.vendas);
    assert.deepEqual(relatorioDepois.totais, relatorioAntes.totais);
});

test('ordenação é determinística: dataVenda desc, depois confirmadoEm desc, depois ID', () => {
    const p1 = confirmar(criarOrcamento({ id: 'ORC-05' }), '2026-09-10T12:00:00.000Z');
    const p2 = confirmar(criarOrcamento({ id: 'ORC-01' }), '2026-09-15T09:00:00.000Z');
    const p3 = confirmar(criarOrcamento({ id: 'ORC-02' }), '2026-09-15T18:00:00.000Z'); // mesmo dataVenda que p2, confirmadoEm depois
    const p4 = confirmar(criarOrcamento({ id: 'ORC-03' }), '2026-09-20T12:00:00.000Z');

    const relatorio = gerarRelatorioVendas([p1, p2, p3, p4], MES_SETEMBRO);
    assert.deepEqual(relatorio.vendas.map(v => v.orcamentoId), ['ORC-03', 'ORC-02', 'ORC-01', 'ORC-05']);

    // Mesmo dataVenda e mesmo confirmadoEm: desempate pelo ID, de forma determinística e repetível.
    const a = confirmar(criarOrcamento({ id: 'ORC-20' }), '2026-09-10T12:00:00.000Z');
    const b = confirmar(criarOrcamento({ id: 'ORC-09' }), '2026-09-10T12:00:00.000Z');
    const primeiraOrdem = gerarRelatorioVendas([a, b], MES_SETEMBRO).vendas.map(v => v.orcamentoId);
    const segundaOrdem = gerarRelatorioVendas([b, a], MES_SETEMBRO).vendas.map(v => v.orcamentoId);
    assert.deepEqual(primeiraOrdem, segundaOrdem);
    assert.deepEqual(primeiraOrdem, ['ORC-09', 'ORC-20']);
});

test('a função não muta os documentos de entrada', () => {
    const pedidoV2 = confirmar(criarOrcamento({ id: 'ORC-01', percentualComissao: 10 }), '2026-09-15T15:00:00.000Z');
    const pedidoV1 = criarPedidoV1(criarOrcamento({ id: 'ORC-02' }), '2026-09-10T12:00:00.000Z');
    const cancelado = cancelarPedido(confirmar(criarOrcamento({ id: 'ORC-03' }), '2026-09-16T15:00:00.000Z'), CANCELAMENTO);
    const invalido = structuredClone(pedidoV2);
    invalido.id = 'ORC-04';
    invalido.pedido.financeiro.margemCentavos += 1;

    const entrada = [pedidoV2, pedidoV1, cancelado, invalido];
    congelarProfundamente(entrada);

    // congelarProfundamente já faria a função explodir em modo estrito se tentasse escrever;
    // a chamada abaixo é a prova definitiva de que nada é mutado.
    assert.doesNotThrow(() => gerarRelatorioVendas(entrada, MES_SETEMBRO));
    const relatorio = gerarRelatorioVendas(entrada, MES_SETEMBRO);
    assert.equal(relatorio.vendas.length, 1);
    assert.equal(relatorio.quantidadePedidosV1, 1);
    assert.equal(relatorio.quantidadeCanceladosNoPeriodo, 1);
    assert.equal(relatorio.inconsistencias.length, 1);
});
