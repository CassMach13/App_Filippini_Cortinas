import assert from 'node:assert/strict';
import test from 'node:test';

import {
    TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO,
    VERSAO_SNAPSHOT_FINANCEIRO,
    agruparItensPorFornecedor,
    alterarPercentualComissao,
    avaliarRestauracaoOrcamento,
    calcularFinanceiroDoOrcamento,
    calcularTotaisOrcamento,
    cancelarPedido,
    confirmarOrcamentoComoPedido,
    criarOrcamentoDuplicado,
    marcarOrcamentoComoPerdido,
    obterItensAtuaisDoOrcamento,
    obterItensDoPedido,
    obterTotaisDoPedido,
    obterValorReceberCentavos,
    pedidoEstaAtivo,
    pedidoEstaCancelado,
    pedidoEstaConfirmado,
    pedidoParticipaFinanceiro,
    validarCancelamentoPedido,
    validarExclusaoOrcamento,
    validarSnapshotPedidoV2
} from '../order-domain.js';
import { calcularDetalhesItem, converterValorParaCentavos } from '../pricing-domain.js';

const CONFIRMACAO = { confirmadoEm: '2026-09-17T15:00:00.000Z', confirmadoPor: 'usuario-teste' };
const CANCELAMENTO = { motivo: 'Cliente desistiu da compra', canceladoEm: '2026-09-18T12:00:00.000Z', canceladoPor: 'usuario-teste' };
const PRODUTO_UNIDADE = { unidadeMedida: 'Unidade', precoCompra: 500, markup: 2 };
const PRODUTO_M2 = { unidadeMedida: 'MetroQuadrado', precoCompra: 38.73, markup: 2.35 };
const PRODUTO_LINEAR = { unidadeMedida: 'MetroLinear', precoCompra: 24.99, markup: 2.3, alturaPadrao: 2.8 };

const CAMPOS_PEDIDO = ['versaoSnapshot', 'orcamentoId', 'confirmadoEm', 'confirmadoPor', 'cliente', 'costureira',
    'comissionado', 'itens', 'financeiro', 'proposta'];
const CAMPOS_FINANCEIRO = ['dataVenda', 'descontoPercentual', 'percentualComissao', 'subtotalSemComissaoCentavos',
    'descontoBaseCentavos', 'baseLiquidaCentavos', 'valorComissaoCentavos', 'valorProdutosCobradoClienteCentavos',
    'valorLiquidoFilippiniCentavos', 'custoProdutosCentavos', 'margemCentavos'];
const CAMPOS_PROPOSTA = ['totalInstalacaoCentavos', 'totalPropostaClienteCentavos'];

function congelarProfundamente(valor) {
    if (valor && typeof valor === 'object') {
        Object.values(valor).forEach(congelarProfundamente);
        Object.freeze(valor);
    }
    return valor;
}

function criarGeradorAleatorio(semente) {
    let estado = semente >>> 0;
    return () => {
        estado = (estado + 0x6D2B79F5) >>> 0;
        let t = estado;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function criarItem(id, produto, quantidade, largura, altura, percentual, extras = {}) {
    const detalhes = calcularDetalhesItem(produto, quantidade, largura, altura, percentual);
    return {
        id,
        codigo: `COD-${id}`,
        descricao: `Item ${id}`,
        fornecedor: extras.fornecedor || 'Fornecedor A',
        unidadeMedida: produto.unidadeMedida,
        quantidade,
        largura: detalhes.larguraSalva,
        altura: detalhes.alturaSalva,
        quantidadeCompra: detalhes.quantidadeCompra,
        precoCompraUnitario: produto.precoCompra,
        custoReal: detalhes.custoReal,
        precoUnitarioBase: detalhes.precoUnitarioBase,
        precoTotalSemComissao: detalhes.precoTotalSemComissao,
        precoUnitario: detalhes.precoUnitario,
        precoTotal: detalhes.precoTotal
    };
}

// Item com preço de linha fixo, sem comissão: usado para reproduzir cenários exatos de centavos.
function criarItemComPreco(id, precoTotal, custoReal = precoTotal / 2) {
    return {
        id,
        codigo: `COD-${id}`,
        fornecedor: 'Fornecedor A',
        unidadeMedida: 'Unidade',
        quantidade: 1,
        quantidadeCompra: 1,
        precoCompraUnitario: custoReal,
        custoReal,
        precoUnitarioBase: precoTotal,
        precoTotalSemComissao: precoTotal,
        precoUnitario: precoTotal,
        precoTotal
    };
}

function criarOrcamento({ id = 'ORC-70', itens, produtosAcabados, descontoGlobal = 0, percentualComissao = 0, valoresInstalacao, tipoCliente } = {}) {
    const orcamento = {
        id,
        statusDocumento: 'orcamento',
        infoGerais: {
            nome: `Orçamento ${id}`,
            nomeCliente: 'Cliente Financeiro',
            enderecoCliente: 'Rua A, 1',
            nomeCostureira: 'Costureira',
            enderecoCostureira: 'Rua B, 2',
            nomeComissionado: 'Arquiteta Parceira',
            celularComissionado: '5521998765432'
        },
        infoComercial: { condicaoPagamento: 'À vista', formaPagamento: 'PIX', descontoGlobal, percentualComissao },
        itens: itens ?? [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, percentualComissao)]
    };
    if (produtosAcabados !== undefined) orcamento.produtosAcabados = produtosAcabados;
    if (valoresInstalacao !== undefined) orcamento.valoresInstalacao = valoresInstalacao;
    if (tipoCliente !== undefined) {
        orcamento.infoGerais.tipoCliente = tipoCliente;
        delete orcamento.infoComercial.percentualComissao;
    }
    return orcamento;
}

function confirmar(orcamento, auditoria = CONFIRMACAO) {
    return confirmarOrcamentoComoPedido(orcamento, auditoria);
}

// Pedido no formato histórico v1 (antes da Etapa 3). O sistema não gera mais esse formato.
function criarPedidoV1(orcamento) {
    return {
        ...structuredClone(orcamento),
        statusDocumento: 'pedido',
        pedido: {
            versaoSnapshot: 1,
            orcamentoId: orcamento.id,
            confirmadoEm: '2026-09-12T15:00:00.000Z',
            confirmadoPor: 'usuario-antigo',
            cliente: { nome: orcamento.infoGerais.nomeCliente, endereco: orcamento.infoGerais.enderecoCliente },
            costureira: { nome: orcamento.infoGerais.nomeCostureira, enderecoEntrega: orcamento.infoGerais.enderecoCostureira },
            itens: obterItensAtuaisDoOrcamento(orcamento)
        }
    };
}

function comAlteracao(pedidoConfirmado, alterar) {
    const copia = structuredClone(pedidoConfirmado);
    alterar(copia.pedido);
    return copia;
}

test('confirmação gera exatamente o snapshot v2 com o contrato completo', () => {
    const orcamento = criarOrcamento({ descontoGlobal: 10, percentualComissao: 10, valoresInstalacao: { Sala: 150 } });
    congelarProfundamente(orcamento);
    const confirmado = confirmar(orcamento);
    const pedido = confirmado.pedido;

    assert.equal(VERSAO_SNAPSHOT_FINANCEIRO, 2);
    assert.equal(confirmado.statusDocumento, 'pedido');
    assert.equal(pedido.versaoSnapshot, 2);
    assert.deepEqual(Object.keys(pedido).sort(), [...CAMPOS_PEDIDO].sort());
    assert.deepEqual(Object.keys(pedido.financeiro).sort(), [...CAMPOS_FINANCEIRO].sort());
    assert.deepEqual(Object.keys(pedido.proposta).sort(), [...CAMPOS_PROPOSTA].sort());
    assert.equal(pedido.orcamentoId, 'ORC-70');
    assert.equal(pedido.confirmadoEm, CONFIRMACAO.confirmadoEm);
    assert.equal(pedido.confirmadoPor, 'usuario-teste');
    assert.deepEqual(pedido.cliente, { nome: 'Cliente Financeiro', endereco: 'Rua A, 1' });
    assert.deepEqual(pedido.costureira, { nome: 'Costureira', enderecoEntrega: 'Rua B, 2' });
    assert.deepEqual(pedido.comissionado, { nome: 'Arquiteta Parceira', celular: '5521998765432' });
    assert.deepEqual(pedido.itens, obterItensAtuaisDoOrcamento(orcamento));
    assert.deepEqual(validarSnapshotPedidoV2(pedido), { valido: true, erros: [] });

    // Base 1.000, desconto 10%, comissão 10%, custo 500, instalação 150.
    assert.deepEqual(pedido.financeiro, {
        dataVenda: '2026-09-17',
        descontoPercentual: 10,
        percentualComissao: 10,
        subtotalSemComissaoCentavos: 100000,
        descontoBaseCentavos: 10000,
        baseLiquidaCentavos: 90000,
        valorComissaoCentavos: 9000,
        valorProdutosCobradoClienteCentavos: 99000,
        valorLiquidoFilippiniCentavos: 90000,
        custoProdutosCentavos: 50000,
        margemCentavos: 40000
    });
    assert.deepEqual(pedido.proposta, { totalInstalacaoCentavos: 15000, totalPropostaClienteCentavos: 114000 });

    // Todos os valores monetários oficiais são inteiros seguros.
    [...CAMPOS_FINANCEIRO.filter(campo => campo.endsWith('Centavos')).map(campo => pedido.financeiro[campo]),
        ...CAMPOS_PROPOSTA.map(campo => pedido.proposta[campo])]
        .forEach(valor => assert.ok(Number.isSafeInteger(valor) && !Object.is(valor, -0), String(valor)));
    // O orçamento original não é alterado.
    assert.equal(orcamento.statusDocumento, 'orcamento');
    assert.equal('pedido' in orcamento, false);
});

test('valores congelados são os mesmos da tela e as relações fecham exatamente em amostra aleatória', () => {
    const aleatorio = criarGeradorAleatorio(20260917);
    const inteiro = (minimo, maximo) => minimo + Math.floor(aleatorio() * (maximo - minimo + 1));
    const escolher = lista => lista[Math.floor(aleatorio() * lista.length)];
    let naoFechavamAntes = 0;

    for (let indice = 0; indice < 5000; indice++) {
        const percentual = escolher([0, 0, 5, 7.5, 10, 12.34]);
        const itens = Array.from({ length: inteiro(1, 8) }, (_, posicao) => {
            const unidadeMedida = escolher(['Unidade', 'MetroLinear', 'MetroQuadrado']);
            const produto = { unidadeMedida, precoCompra: inteiro(1, 60000) / 100, markup: escolher([1.5, 2, 2.35, inteiro(110, 350) / 100]), alturaPadrao: 2.8 };
            const quantidade = unidadeMedida === 'MetroLinear' ? inteiro(500, 30000) / 1000 : inteiro(1, 6);
            return criarItem(`i${posicao}`, produto, quantidade, inteiro(30, 400) / 100, inteiro(30, 320) / 100, percentual);
        });
        const orcamento = criarOrcamento({
            id: `ORC-${indice}`,
            itens,
            percentualComissao: percentual,
            descontoGlobal: escolher([0, 2.5, 3.33, 5, 7.5, 10, inteiro(0, 2000) / 100]),
            valoresInstalacao: { A: inteiro(0, 200000) / 100, B: inteiro(0, 50000) / 100 }
        });

        const totais = calcularTotaisOrcamento(orcamento);
        const confirmado = confirmar(orcamento);
        const { financeiro, proposta } = confirmado.pedido;

        assert.equal(pedidoParticipaFinanceiro(confirmado), true, orcamento.id);
        assert.equal(financeiro.valorProdutosCobradoClienteCentavos, totais.centavos.totalProdutos);
        assert.equal(financeiro.valorComissaoCentavos, totais.centavos.valorComissao);
        assert.equal(financeiro.baseLiquidaCentavos, totais.centavos.baseLiquida);
        assert.equal(financeiro.subtotalSemComissaoCentavos, totais.centavos.subtotalSemComissao);
        assert.equal(proposta.totalInstalacaoCentavos, totais.centavos.totalInstalacao);
        assert.equal(proposta.totalPropostaClienteCentavos, totais.centavos.totalGeral);

        assert.equal(financeiro.descontoBaseCentavos, financeiro.subtotalSemComissaoCentavos - financeiro.baseLiquidaCentavos);
        assert.equal(financeiro.valorLiquidoFilippiniCentavos, financeiro.valorProdutosCobradoClienteCentavos - financeiro.valorComissaoCentavos);
        assert.equal(financeiro.margemCentavos, financeiro.valorLiquidoFilippiniCentavos - financeiro.custoProdutosCentavos);
        assert.equal(proposta.totalPropostaClienteCentavos, financeiro.valorProdutosCobradoClienteCentavos + proposta.totalInstalacaoCentavos);
        if (converterValorParaCentavos(totais.descontoBase) !== financeiro.descontoBaseCentavos) naoFechavamAntes++;
    }
    // A amostra inclui casos em que o desconto arredondado isoladamente não fechava com a base.
    assert.ok(naoFechavamAntes > 0);
});

test('custo é arredondado linha a linha antes da soma', () => {
    // Cada custo tem meio centavo: 10,005 → 10,01 e 20,005 → 20,01. Somar os floats daria 30,01.
    const orcamento = criarOrcamento({ itens: [criarItemComPreco('a', 50, 10.005), criarItemComPreco('b', 50, 20.005)] });
    const { financeiro } = confirmar(orcamento).pedido;

    assert.equal(converterValorParaCentavos(10.005 + 20.005), 3001);
    assert.equal(financeiro.custoProdutosCentavos, 3002);
    assert.equal(financeiro.margemCentavos, financeiro.valorLiquidoFilippiniCentavos - 3002);
});

test('venda sem comissão e com 5%, 10% e 7,5% sobre a mesma base', () => {
    const casos = [
        [0, { cobrado: 100000, comissao: 0, liquido: 100000 }],
        [5, { cobrado: 105000, comissao: 5000, liquido: 100000 }],
        [10, { cobrado: 110000, comissao: 10000, liquido: 100000 }],
        [7.5, { cobrado: 107500, comissao: 7500, liquido: 100000 }]
    ];
    casos.forEach(([percentual, esperado]) => {
        const { financeiro } = confirmar(criarOrcamento({ percentualComissao: percentual })).pedido;
        assert.equal(financeiro.percentualComissao, percentual);
        assert.equal(financeiro.subtotalSemComissaoCentavos, 100000);
        assert.equal(financeiro.baseLiquidaCentavos, 100000);
        assert.equal(financeiro.valorProdutosCobradoClienteCentavos, esperado.cobrado, String(percentual));
        assert.equal(financeiro.valorComissaoCentavos, esperado.comissao, String(percentual));
        assert.equal(financeiro.valorLiquidoFilippiniCentavos, esperado.liquido, String(percentual));
        assert.equal(financeiro.margemCentavos, 50000);
    });
});

test('desconto com comissão congela os casos homologados na Etapa 2A', () => {
    const caso4 = confirmar(criarOrcamento({
        itens: [criarItem('m2', PRODUTO_M2, 2, 3.5, 2.85, 10)], descontoGlobal: 7.5, percentualComissao: 10
    })).pedido.financeiro;
    assert.equal(caso4.valorProdutosCobradoClienteCentavos, 184763);
    assert.equal(caso4.baseLiquidaCentavos, 167966);
    assert.equal(caso4.valorComissaoCentavos, 16797);
    assert.equal(caso4.valorLiquidoFilippiniCentavos, 167966);

    const caso5 = confirmar(criarOrcamento({
        itens: [
            criarItem('a', { unidadeMedida: 'Unidade', precoCompra: 16.665, markup: 2 }, 3, 0, 0, 7.5),
            criarItem('b', PRODUTO_LINEAR, 7.345, 0, 0, 7.5),
            criarItem('m2', PRODUTO_M2, 2, 3.5, 2.85, 7.5)
        ],
        descontoGlobal: 5,
        percentualComissao: 7.5,
        valoresInstalacao: { Sala: 350.55 }
    })).pedido;
    assert.equal(caso5.financeiro.valorProdutosCobradoClienteCentavos, 238771);
    assert.equal(caso5.financeiro.baseLiquidaCentavos, 222113);
    assert.equal(caso5.financeiro.valorComissaoCentavos, 16658);
    assert.equal(caso5.financeiro.valorLiquidoFilippiniCentavos, 222113);
    assert.equal(caso5.proposta.totalInstalacaoCentavos, 35055);
    assert.equal(caso5.proposta.totalPropostaClienteCentavos, 238771 + 35055);
});

test('instalação fica fora do financeiro e só entra no total da proposta', () => {
    const semInstalacao = confirmar(criarOrcamento({ descontoGlobal: 10, percentualComissao: 10 })).pedido;
    const comInstalacao = confirmar(criarOrcamento({
        descontoGlobal: 10, percentualComissao: 10, valoresInstalacao: { Sala: 300, Quarto: '150,50' }
    })).pedido;

    assert.deepEqual(comInstalacao.financeiro, semInstalacao.financeiro);
    assert.equal(semInstalacao.proposta.totalInstalacaoCentavos, 0);
    // Texto legado com vírgula é lido por parseFloat até a vírgula (150), como desde a Etapa 0.
    assert.equal(comInstalacao.proposta.totalInstalacaoCentavos, 45000);
    assert.equal(comInstalacao.proposta.totalPropostaClienteCentavos, 99000 + 45000);
    // O valor a receber da Filippini não inclui instalação nem abate a comissão.
    assert.equal(obterValorReceberCentavos(comInstalacao), 99000);
    assert.equal(obterValorReceberCentavos(semInstalacao), 99000);
});

test('total da proposta fecha em centavos nos cenários que antes diferiam 1 centavo', () => {
    // Produto de R$ 10,10 com 5% de desconto: produtos R$ 9,59. A soma de floats exibia R$ 109,60.
    const cenarioA = criarOrcamento({ itens: [criarItemComPreco('a', 10.1)], descontoGlobal: 5, valoresInstalacao: { Sala: 100 } });
    const totaisA = calcularTotaisOrcamento(cenarioA);
    assert.equal(converterValorParaCentavos(totaisA.totalProdutos + totaisA.totalInstalacao), 10960);
    assert.equal(totaisA.centavos.totalProdutos, 959);
    assert.equal(totaisA.centavos.totalGeral, 10959);
    assert.equal(totaisA.totalGeral, 109.59);
    assert.equal(confirmar(cenarioA).pedido.proposta.totalPropostaClienteCentavos, 10959);

    // Produto de R$ 10,70 com 5% de desconto: produtos R$ 10,17. A soma de floats exibia R$ 110,16.
    const cenarioB = criarOrcamento({ itens: [criarItemComPreco('b', 10.7)], descontoGlobal: 5, valoresInstalacao: { Sala: 100 } });
    const totaisB = calcularTotaisOrcamento(cenarioB);
    assert.equal(converterValorParaCentavos(totaisB.totalProdutos + totaisB.totalInstalacao), 11016);
    assert.equal(totaisB.centavos.totalProdutos, 1017);
    assert.equal(totaisB.centavos.totalGeral, 11017);
    assert.equal(confirmar(cenarioB).pedido.proposta.totalPropostaClienteCentavos, 11017);
});

test('data da venda é a data civil de Brasília de confirmadoEm, inclusive nas viradas de mês e de ano', () => {
    const casos = [
        ['2026-04-01T02:59:59.999Z', '2026-03-31'],
        ['2026-04-01T03:00:00.000Z', '2026-04-01'],
        ['2027-01-01T02:59:59.999Z', '2026-12-31'],
        ['2027-01-01T03:00:00.000Z', '2027-01-01'],
        ['2026-09-17T15:00:00.000Z', '2026-09-17']
    ];
    casos.forEach(([confirmadoEm, dataVenda]) => {
        const confirmado = confirmar(criarOrcamento(), { confirmadoEm, confirmadoPor: 'usuario-teste' });
        assert.equal(confirmado.pedido.confirmadoEm, confirmadoEm);
        assert.equal(confirmado.pedido.financeiro.dataVenda, dataVenda, confirmadoEm);
        assert.equal(pedidoParticipaFinanceiro(confirmado), true);
    });

    // confirmadoEm fora do formato UTC de toISOString() não gera pedido.
    assert.throws(() => confirmar(criarOrcamento(), { confirmadoEm: '2026-03-31T23:59:59.999-03:00' }), /congelar os valores/);
    const incoerente = comAlteracao(confirmar(criarOrcamento()), pedido => { pedido.financeiro.dataVenda = '2026-09-18'; });
    assert.ok(validarSnapshotPedidoV2(incoerente.pedido).erros.includes('financeiro.dataVenda-incoerente-com-confirmadoEm'));
    assert.equal(pedidoParticipaFinanceiro(incoerente), false);
});

test('alterações no orçamento vivo ou no catálogo não mudam o snapshot v2', () => {
    const orcamento = criarOrcamento({ descontoGlobal: 10, percentualComissao: 10, valoresInstalacao: { Sala: 150 } });
    const confirmado = confirmar(orcamento);
    const snapshotOriginal = structuredClone(confirmado.pedido);

    // O documento vivo muda (por exemplo, por uma gravação indevida), mas o snapshot não depende dele.
    confirmado.infoComercial.descontoGlobal = 50;
    confirmado.infoComercial.percentualComissao = 5;
    confirmado.valoresInstalacao.Sala = 999;
    confirmado.itens[0].precoTotal = 1;
    confirmado.itens[0].custoReal = 1;
    assert.deepEqual(confirmado.pedido, snapshotOriginal);
    assert.equal(obterValorReceberCentavos(confirmado.pedido), 99000);
    assert.deepEqual(obterTotaisDoPedido(confirmado).financeiro, snapshotOriginal.financeiro);

    // Novo preço de catálogo: só um item recriado a partir do catálogo teria outro valor.
    const catalogoNovo = { ...PRODUTO_UNIDADE, precoCompra: 800 };
    assert.notEqual(criarItem('a', catalogoNovo, 1, 0, 0, 10).precoTotal, snapshotOriginal.itens[0].precoVendaTotal);
    assert.deepEqual(confirmado.pedido, snapshotOriginal);
    // A confirmação usa apenas o orçamento: confirmar de novo o mesmo documento dá o mesmo snapshot.
    assert.deepEqual(confirmar(orcamento).pedido, snapshotOriginal);
});

test('pedido v1 continua operacional e nunca participa do financeiro', () => {
    const orcamento = criarOrcamento({
        itens: [criarItem('a', PRODUTO_UNIDADE, 2, 0, 0, 0), criarItem('b', PRODUTO_LINEAR, 3, 0, 0, 0, { fornecedor: 'Fornecedor B' })],
        descontoGlobal: 5,
        valoresInstalacao: { Sala: 100 }
    });
    const v1 = criarPedidoV1(orcamento);
    const v2 = confirmar(orcamento);

    assert.equal(pedidoEstaConfirmado(v1), true);
    assert.equal(pedidoEstaAtivo(v1), true);
    assert.equal(pedidoParticipaFinanceiro(v1), false);
    assert.equal(obterValorReceberCentavos(v1.pedido), null);
    assert.equal(obterTotaisDoPedido(v1).origem, 'derivado');
    assert.deepEqual(validarSnapshotPedidoV2(v1.pedido).valido, false);

    // Fornecedor e instalador recebem exatamente o mesmo formato de itens em v1 e v2.
    assert.deepEqual(obterItensDoPedido(v1), obterItensDoPedido(v2));
    assert.deepEqual(agruparItensPorFornecedor(obterItensDoPedido(v1)), agruparItensPorFornecedor(obterItensDoPedido(v2)));

    // Mesmo com um bloco financeiro válido enxertado, v1 continua fora (nenhum fallback).
    const v1ComFinanceiro = structuredClone(v1);
    v1ComFinanceiro.pedido.financeiro = structuredClone(v2.pedido.financeiro);
    v1ComFinanceiro.pedido.proposta = structuredClone(v2.pedido.proposta);
    assert.equal(pedidoParticipaFinanceiro(v1ComFinanceiro), false);
    assert.equal(obterValorReceberCentavos(v1ComFinanceiro.pedido), null);
});

test('snapshot v2 inválido nunca participa: tipos, campos, versão e relações', () => {
    const valido = confirmar(criarOrcamento({ descontoGlobal: 10, percentualComissao: 10, valoresInstalacao: { Sala: 150 } }));
    assert.equal(pedidoParticipaFinanceiro(valido), true);

    const mutacoes = [
        ['versão como texto', p => { p.versaoSnapshot = '2'; }, 'versaoSnapshot-diferente-de-2'],
        ['versão 3', p => { p.versaoSnapshot = 3; }, 'versaoSnapshot-diferente-de-2'],
        ['centavos fracionários', p => { p.financeiro.valorComissaoCentavos = 9000.5; }, 'financeiro.valorComissaoCentavos-invalido'],
        ['centavos em texto', p => { p.financeiro.baseLiquidaCentavos = '90000'; }, 'financeiro.baseLiquidaCentavos-invalido'],
        ['centavos negativos', p => { p.financeiro.custoProdutosCentavos = -1; }, 'financeiro.custoProdutosCentavos-invalido'],
        ['menos zero', p => { p.proposta.totalInstalacaoCentavos = -0; }, 'proposta.totalInstalacaoCentavos-invalido'],
        ['NaN', p => { p.financeiro.subtotalSemComissaoCentavos = Number.NaN; }, 'financeiro.subtotalSemComissaoCentavos-invalido'],
        ['campo ausente', p => { delete p.financeiro.margemCentavos; }, 'financeiro.margemCentavos-ausente'],
        ['campo desconhecido', p => { p.financeiro.total = 1; }, 'financeiro.total-desconhecido'],
        ['campo genérico no pedido', p => { p.totais = {}; }, 'pedido.totais-desconhecido'],
        ['proposta ausente', p => { delete p.proposta; }, 'proposta-ausente'],
        ['percentual acima de 100', p => { p.financeiro.percentualComissao = 101; }, 'financeiro.percentualComissao-invalido'],
        ['percentual com 3 casas', p => { p.financeiro.percentualComissao = 10.001; }, 'financeiro.percentualComissao-invalido'],
        ['desconto negativo', p => { p.financeiro.descontoPercentual = -1; }, 'financeiro.descontoPercentual-invalido'],
        ['data da venda inválida', p => { p.financeiro.dataVenda = '2026-02-30'; }, 'financeiro.dataVenda-invalida'],
        ['confirmadoEm com fuso local', p => { p.confirmadoEm = '2026-09-17T12:00:00.000-03:00'; }, 'pedido.confirmadoEm-invalido'],
        ['sem itens', p => { p.itens = []; }, 'pedido.itens-invalido'],
        ['cliente sem nome', p => { delete p.cliente.nome; }, 'cliente.nome-ausente'],
        ['comissionado ausente', p => { delete p.comissionado; }, 'pedido.comissionado-ausente'],
        // Relações: cada valor alterado em 1 centavo quebra exatamente a relação correspondente.
        ['desconto da base +1', p => { p.financeiro.descontoBaseCentavos += 1; }, 'relacao-desconto-base'],
        ['base líquida +1', p => { p.financeiro.baseLiquidaCentavos += 1; }, 'relacao-desconto-base'],
        ['comissão +1', p => { p.financeiro.valorComissaoCentavos += 1; }, 'relacao-comissao'],
        ['produtos cobrados +1', p => { p.financeiro.valorProdutosCobradoClienteCentavos += 1; }, 'relacao-liquido-filippini'],
        ['líquido Filippini +1', p => { p.financeiro.valorLiquidoFilippiniCentavos += 1; }, 'relacao-liquido-filippini'],
        ['custo +1', p => { p.financeiro.custoProdutosCentavos += 1; }, 'relacao-margem'],
        ['margem +1', p => { p.financeiro.margemCentavos += 1; }, 'relacao-margem'],
        ['instalação +1', p => { p.proposta.totalInstalacaoCentavos += 1; }, 'relacao-total-proposta'],
        ['total da proposta +1', p => { p.proposta.totalPropostaClienteCentavos += 1; }, 'relacao-total-proposta'],
        ['instalação somada aos produtos cobrados', p => {
            p.financeiro.valorProdutosCobradoClienteCentavos += p.proposta.totalInstalacaoCentavos;
            p.financeiro.valorLiquidoFilippiniCentavos += p.proposta.totalInstalacaoCentavos;
            p.financeiro.margemCentavos += p.proposta.totalInstalacaoCentavos;
        }, 'relacao-total-proposta']
    ];

    mutacoes.forEach(([nome, alterar, erroEsperado]) => {
        const alterado = comAlteracao(valido, alterar);
        const { valido: ehValido, erros } = validarSnapshotPedidoV2(alterado.pedido);
        assert.equal(ehValido, false, nome);
        assert.ok(erros.includes(erroEsperado), `${nome}: ${erros.join(', ')}`);
        assert.equal(pedidoParticipaFinanceiro(alterado), false, nome);
        assert.equal(obterValorReceberCentavos(alterado.pedido), null, nome);
    });

    // Snapshot copiado para outro documento não participa (evita dupla contagem).
    const copiado = { ...structuredClone(valido), id: 'ORC-99' };
    assert.equal(pedidoParticipaFinanceiro(copiado), false);
    // Documento que não é pedido confirmado nunca participa.
    assert.equal(pedidoParticipaFinanceiro({ ...structuredClone(valido), statusDocumento: 'orcamento' }), false);
    assert.equal(pedidoParticipaFinanceiro(null), false);
    assert.equal(validarSnapshotPedidoV2(null).valido, false);
});

test('confirmação é recusada sem itens, em pedido, em perdido e com resíduo anormal', () => {
    assert.throws(() => confirmar(criarOrcamento({ itens: [] })), error => error.codigo === 'sem-itens');
    const pedido = confirmar(criarOrcamento());
    assert.throws(() => confirmar(pedido), error => error.codigo === 'ja-confirmado' && /já foi confirmado/.test(error.message));
    const perdido = marcarOrcamentoComoPerdido(criarOrcamento(), { alteradoEm: '2026-09-17T10:00:00.000Z' });
    assert.throws(() => confirmar(perdido), error => error.codigo === 'perdido');

    // Documento antigo de arquiteto com um item sem a comissão embutida: preços não fecham com a comissão.
    const antigoItem = (id, tipo) => {
        const percentual = tipo === 'arquiteto' ? 0.10 : 0;
        const precoUnitario = Math.round(1000 * (1 + percentual) * 100) / 100;
        return { id, unidadeMedida: 'Unidade', quantidade: 1, quantidadeCompra: 1, precoCompraUnitario: 500, custoReal: 500,
            precoUnitario, precoTotal: precoUnitario, valorComissao: 1000 * percentual };
    };
    const inconsistente = criarOrcamento({ tipoCliente: 'arquiteto', itens: [antigoItem('a', 'arquiteto'), antigoItem('b', 'cliente')] });
    assert.throws(() => confirmar(inconsistente), error => error.codigo === 'residuo-comissao-anormal');
});

test('pedido confirmado continua congelado', () => {
    const pedido = confirmar(criarOrcamento({ percentualComissao: 10 }));
    const copia = structuredClone(pedido);

    assert.throws(() => alterarPercentualComissao(pedido, 5), /Pedidos confirmados não permitem alterar a comissão/);
    assert.throws(() => marcarOrcamentoComoPerdido(pedido, {}), /Pedidos confirmados não podem ser marcados como perdidos/);
    assert.throws(() => confirmar(pedido), /já foi confirmado/);
    assert.match(validarExclusaoOrcamento(pedido), /Pedidos confirmados não podem ser excluídos/);
    assert.deepEqual(pedido, copia);
});

test('cancelamento de pedido v2 é auditável, definitivo e tira o pedido do financeiro', () => {
    const pedido = confirmar(criarOrcamento({ descontoGlobal: 10, percentualComissao: 10 }));
    congelarProfundamente(pedido);
    const cancelado = cancelarPedido(pedido, { ...CANCELAMENTO, motivo: '  Cliente desistiu da compra  ' });

    assert.deepEqual(cancelado.pedido.cancelamento, {
        canceladoEm: '2026-09-18T12:00:00.000Z',
        canceladoPor: 'usuario-teste',
        motivo: 'Cliente desistiu da compra'
    });
    // Nada além do registro de cancelamento muda: itens, financeiro, proposta e status continuam.
    const { cancelamento: _cancelamento, ...pedidoSemCancelamento } = cancelado.pedido;
    assert.deepEqual(pedidoSemCancelamento, pedido.pedido);
    assert.equal(cancelado.statusDocumento, 'pedido');
    assert.equal(validarSnapshotPedidoV2(cancelado.pedido).valido, true);

    assert.equal(pedidoEstaConfirmado(cancelado), true);
    assert.equal(pedidoEstaCancelado(cancelado), true);
    assert.equal(pedidoEstaAtivo(cancelado), false);
    assert.equal(pedidoParticipaFinanceiro(cancelado), false);
    assert.equal(obterValorReceberCentavos(cancelado.pedido), null);
    assert.equal(obterTotaisDoPedido(cancelado).cancelado, true);
    assert.equal(pedidoParticipaFinanceiro(pedido), true);

    // Não pode ser desfeito, repetido nem alterado; o pedido continua congelado.
    assert.throws(() => cancelarPedido(cancelado, CANCELAMENTO), error => error.codigo === 'ja-cancelado');
    assert.throws(() => cancelarPedido(cancelado, { ...CANCELAMENTO, motivo: 'Outro motivo' }), error => error.codigo === 'ja-cancelado');
    assert.throws(() => alterarPercentualComissao(cancelado, 5), /Pedidos confirmados/);
    assert.throws(() => confirmar(cancelado), error => error.codigo === 'ja-confirmado');
    assert.match(validarExclusaoOrcamento(cancelado), /Pedidos confirmados não podem ser excluídos/);
});

test('cancelamento exige pedido confirmado e motivo válido; também vale para v1', () => {
    const orcamento = criarOrcamento();
    assert.throws(() => cancelarPedido(orcamento, CANCELAMENTO), error => error.codigo === 'nao-e-pedido');
    const pedido = confirmar(orcamento);
    ['', '   ', null, undefined, 42].forEach(motivo => {
        assert.throws(() => cancelarPedido(pedido, { ...CANCELAMENTO, motivo }), error => error.codigo === 'motivo-obrigatorio', String(motivo));
    });
    assert.throws(
        () => cancelarPedido(pedido, { ...CANCELAMENTO, motivo: 'x'.repeat(TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO + 1) }),
        error => error.codigo === 'motivo-muito-longo'
    );
    assert.equal(cancelarPedido(pedido, { ...CANCELAMENTO, motivo: 'x'.repeat(TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO) }).pedido.cancelamento.motivo.length, 500);
    assert.throws(() => cancelarPedido(pedido, { ...CANCELAMENTO, canceladoEm: '17/09/2026' }), error => error.codigo === 'data-cancelamento-invalida');
    assert.throws(() => cancelarPedido(null, CANCELAMENTO), TypeError);

    // Pedido v1: cancelamento apenas operacional (v1 já não participa do financeiro).
    const v1 = criarPedidoV1(orcamento);
    const v1Cancelado = cancelarPedido(v1, CANCELAMENTO);
    assert.equal(pedidoEstaCancelado(v1Cancelado), true);
    assert.equal(pedidoEstaAtivo(v1Cancelado), false);
    assert.equal(pedidoParticipaFinanceiro(v1Cancelado), false);
    assert.deepEqual(obterItensDoPedido(v1Cancelado), obterItensDoPedido(v1));
    assert.throws(() => cancelarPedido(v1Cancelado, CANCELAMENTO), error => error.codigo === 'ja-cancelado');

    // Formato do registro de cancelamento.
    assert.deepEqual(validarCancelamentoPedido(v1Cancelado.pedido.cancelamento), []);
    assert.ok(validarCancelamentoPedido({ canceladoEm: 'x', canceladoPor: 1, motivo: ' a ' }).length >= 3);
    assert.deepEqual(validarCancelamentoPedido(null), ['cancelamento-invalido']);
    // Cancelamento malformado invalida o snapshot v2.
    const malformado = comAlteracao(pedido, p => { p.cancelamento = { motivo: '' }; });
    assert.equal(validarSnapshotPedidoV2(malformado.pedido).valido, false);
    assert.equal(pedidoParticipaFinanceiro(malformado), false);
});

test('duplicar pedido cancelado cria orçamento editável sem pedido nem cancelamento', () => {
    const cancelado = cancelarPedido(confirmar(criarOrcamento({ descontoGlobal: 5, percentualComissao: 7.5 })), CANCELAMENTO);
    const copia = criarOrcamentoDuplicado(cancelado, { novoId: 'ORC-71', dataOrcamento: '2026-09-18' });

    assert.equal(copia.id, 'ORC-71');
    assert.equal(copia.statusDocumento, 'orcamento');
    assert.equal('pedido' in copia, false);
    assert.equal(pedidoEstaConfirmado(copia), false);
    assert.equal(pedidoEstaCancelado(copia), false);
    assert.equal(copia.infoComercial.percentualComissao, 7.5);
    assert.deepEqual(copia.itens, cancelado.itens);
    // A cópia pode virar um novo pedido v2, independente do cancelado.
    const novoPedido = confirmar(copia, { confirmadoEm: '2026-09-18T15:00:00.000Z', confirmadoPor: 'usuario-teste' });
    assert.equal(pedidoParticipaFinanceiro(novoPedido), true);
    assert.equal(novoPedido.pedido.orcamentoId, 'ORC-71');
    assert.equal(pedidoParticipaFinanceiro(cancelado), false);
});

test('legado de arquiteto sem percentual gravado confirma como v2 com os 10% efetivos', () => {
    const antigo = criarOrcamento({ tipoCliente: 'arquiteto', itens: [{
        id: 'a', unidadeMedida: 'Unidade', quantidade: 1, quantidadeCompra: 1, precoCompraUnitario: 500, custoReal: 500,
        precoUnitario: 1100, precoTotal: 1100, valorComissao: 100, margemLiquida: 500, margemPercentual: 45.45
    }] });
    const confirmado = confirmar(antigo);

    assert.equal(confirmado.infoComercial.percentualComissao, 10);
    assert.equal(confirmado.pedido.financeiro.percentualComissao, 10);
    assert.equal(confirmado.pedido.financeiro.baseLiquidaCentavos, 100000);
    assert.equal(confirmado.pedido.financeiro.valorComissaoCentavos, 10000);
    assert.equal(confirmado.pedido.financeiro.valorProdutosCobradoClienteCentavos, 110000);
    assert.equal(pedidoParticipaFinanceiro(confirmado), true);
    // Os pedidos v1 existentes nunca são convertidos: só uma nova confirmação gera v2.
    assert.equal(pedidoParticipaFinanceiro(criarPedidoV1(antigo)), false);
});

test('valor a receber é o valor de produtos cobrado do cliente, sem instalação e sem abater comissão', () => {
    const pedido = confirmar(criarOrcamento({ descontoGlobal: 10, percentualComissao: 10, valoresInstalacao: { Sala: 300 } })).pedido;
    assert.equal(obterValorReceberCentavos(pedido), pedido.financeiro.valorProdutosCobradoClienteCentavos);
    assert.equal(obterValorReceberCentavos(pedido), 99000);
    assert.notEqual(obterValorReceberCentavos(pedido), pedido.financeiro.valorLiquidoFilippiniCentavos);
    assert.notEqual(obterValorReceberCentavos(pedido), pedido.proposta.totalPropostaClienteCentavos);
    assert.equal(obterValorReceberCentavos(null), null);
    assert.equal(obterValorReceberCentavos({ versaoSnapshot: 1 }), null);
});

test('blocos financeiros derivados não dependem de estado externo', () => {
    const orcamento = criarOrcamento({ descontoGlobal: 10, percentualComissao: 10, valoresInstalacao: { Sala: 150 } });
    congelarProfundamente(orcamento);
    const primeiro = calcularFinanceiroDoOrcamento(orcamento, { confirmadoEm: CONFIRMACAO.confirmadoEm });
    const segundo = calcularFinanceiroDoOrcamento(orcamento, { confirmadoEm: CONFIRMACAO.confirmadoEm });
    assert.deepEqual(primeiro, segundo);
    assert.equal(calcularFinanceiroDoOrcamento(orcamento, { confirmadoEm: 'inválido' }).financeiro.dataVenda, null);
});

test('restauração de backup preserva pedidos confirmados e só cria pedidos v1 íntegros ou v2 válidos', () => {
    const orcamento = criarOrcamento({ id: 'ORC-80', percentualComissao: 10 });
    const pedidoV2 = confirmar(orcamento);
    const pedidoV1 = criarPedidoV1({ ...orcamento, id: 'ORC-81' });
    const cancelado = cancelarPedido(pedidoV2, CANCELAMENTO);

    // Documento inexistente: orçamento, v1 íntegro e v2 válido são criados.
    assert.deepEqual(avaliarRestauracaoOrcamento(null, orcamento), { gravar: true });
    assert.deepEqual(avaliarRestauracaoOrcamento(null, pedidoV1), { gravar: true });
    assert.deepEqual(avaliarRestauracaoOrcamento(null, pedidoV2), { gravar: true });
    assert.deepEqual(avaliarRestauracaoOrcamento(null, cancelado), { gravar: true });
    assert.equal(avaliarRestauracaoOrcamento(null, comAlteracao(pedidoV2, p => { p.financeiro.margemCentavos += 1; })).motivo, 'pedido-v2-invalido');
    assert.equal(avaliarRestauracaoOrcamento(null, { ...structuredClone(pedidoV2), id: 'ORC-99' }).motivo, 'pedido-v2-invalido');
    assert.equal(avaliarRestauracaoOrcamento(null, comAlteracao(pedidoV1, p => { delete p.itens; })).motivo, 'pedido-v1-incompleto');
    assert.equal(avaliarRestauracaoOrcamento(null, comAlteracao(pedidoV1, p => { p.versaoSnapshot = 7; })).motivo, 'pedido-versao-desconhecida');
    assert.equal(avaliarRestauracaoOrcamento(null, { ...structuredClone(pedidoV1), pedido: undefined }).motivo, 'pedido-ausente');
    assert.equal(avaliarRestauracaoOrcamento(null, 'x').motivo, 'registro-invalido');

    // Pedido existente: backup idêntico nos campos congelados pode atualizar contatos; diferente é ignorado.
    const contatosNovos = { ...structuredClone(pedidoV2), infoGerais: { ...pedidoV2.infoGerais, celularCliente: '5511999999999' } };
    assert.deepEqual(avaliarRestauracaoOrcamento(pedidoV2, contatosNovos), { gravar: true });
    assert.deepEqual(avaliarRestauracaoOrcamento(cancelado, pedidoV2), { gravar: true });
    assert.equal(avaliarRestauracaoOrcamento(pedidoV2, cancelado).motivo, 'pedido-confirmado-preservado');
    assert.equal(avaliarRestauracaoOrcamento(pedidoV2, orcamento).motivo, 'pedido-confirmado-preservado');
    assert.equal(avaliarRestauracaoOrcamento(pedidoV2, { ...structuredClone(pedidoV2), infoComercial: { descontoGlobal: 50 } }).motivo, 'pedido-confirmado-preservado');
    assert.deepEqual(avaliarRestauracaoOrcamento(pedidoV2, { id: 'ORC-80', infoGerais: { nomeCliente: 'Outro' } }), { gravar: true });

    // Orçamento existente não vira pedido por restauração (a regra só aceita confirmação transacional v2).
    assert.equal(avaliarRestauracaoOrcamento(orcamento, pedidoV2).motivo, 'orcamento-existente-nao-vira-pedido');
    assert.equal(avaliarRestauracaoOrcamento(orcamento, pedidoV1).motivo, 'orcamento-existente-nao-vira-pedido');
    assert.deepEqual(avaliarRestauracaoOrcamento(orcamento, { ...orcamento, infoGerais: { nomeCliente: 'Outro' } }), { gravar: true });
});
