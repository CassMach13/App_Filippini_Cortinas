import test from 'node:test';
import assert from 'node:assert/strict';

import {
    agruparItensPorFornecedor,
    calcularQuantidadeCompraDoItem,
    criarSnapshotPedido,
    obterItensDoPedido,
    pedidoEstaConfirmado
} from '../order-domain.js';

function criarOrcamentoExemplo() {
    return {
        id: 'ORC-10',
        infoGerais: {
            nomeCliente: 'Cliente Teste',
            enderecoCliente: 'Endereço do cliente',
            nomeCostureira: 'Costureira Teste',
            enderecoCostureira: 'Endereço de entrega'
        },
        produtosAcabados: [
            {
                id: 'produto-1',
                nome: 'Cortina Sala',
                ambiente: 'Sala',
                itens: [
                    {
                        id: 'item-1',
                        codigo: 'TEC-01',
                        descricao: 'Tecido',
                        fornecedor: 'Fornecedor A',
                        unidadeMedida: 'MetroLinear',
                        quantidade: 5,
                        precoCompraUnitario: 10,
                        custoReal: 50,
                        precoUnitario: 25,
                        precoTotal: 125
                    }
                ]
            }
        ],
        itens: [
            {
                id: 'item-2',
                codigo: 'SUP-01',
                descricao: 'Suporte',
                fornecedor: 'Fornecedor B',
                unidadeMedida: 'Unidade',
                quantidade: 2,
                custoReal: 16,
                precoUnitario: 20,
                precoTotal: 40
            }
        ]
    };
}

test('calcula quantidade de compra de metro quadrado para dados legados', () => {
    assert.equal(calcularQuantidadeCompraDoItem({
        unidadeMedida: 'MetroQuadrado',
        largura: 2,
        altura: 1.5,
        quantidade: 3
    }), 9);
});

test('cria snapshot completo e independente do orçamento', () => {
    const orcamento = criarOrcamentoExemplo();
    const snapshot = criarSnapshotPedido(orcamento, {
        confirmadoEm: '2026-09-12T12:00:00.000Z',
        confirmadoPor: 'usuario-1'
    });

    assert.equal(snapshot.itens.length, 2);
    assert.equal(snapshot.itens[0].produtoAcabadoNome, 'Cortina Sala');
    assert.equal(snapshot.itens[1].precoCompraUnitario, 8);
    assert.equal(snapshot.costureira.enderecoEntrega, 'Endereço de entrega');

    orcamento.produtosAcabados[0].itens[0].custoReal = 999;
    assert.equal(snapshot.itens[0].custoTotal, 50);
});

test('pedido confirmado usa itens congelados', () => {
    const orcamento = criarOrcamentoExemplo();
    const snapshot = criarSnapshotPedido(orcamento, {
        confirmadoEm: '2026-09-12T12:00:00.000Z'
    });
    orcamento.statusDocumento = 'pedido';
    orcamento.pedido = snapshot;

    orcamento.produtosAcabados[0].itens[0].precoCompraUnitario = 99;

    assert.equal(pedidoEstaConfirmado(orcamento), true);
    assert.equal(obterItensDoPedido(orcamento)[0].precoCompraUnitario, 10);
});

test('agrupa itens por fornecedor e código sem perder o custo congelado', () => {
    const itens = [
        { fornecedor: 'Fornecedor A', codigo: 'TEC-01', descricao: 'Tecido', unidadeMedida: 'MetroLinear', quantidadeCompra: 2, precoCompraUnitario: 10 },
        { fornecedor: 'Fornecedor A', codigo: 'TEC-01', descricao: 'Tecido', unidadeMedida: 'MetroLinear', quantidadeCompra: 3, precoCompraUnitario: 10 },
        { fornecedor: 'Fornecedor B', codigo: 'SUP-01', descricao: 'Suporte', unidadeMedida: 'Unidade', quantidadeCompra: 1, precoCompraUnitario: 8 }
    ];

    const grupos = agruparItensPorFornecedor(itens);
    const tecido = Object.values(grupos['Fornecedor A'].itens)[0];

    assert.equal(tecido.quantidadeCompra, 5);
    assert.equal(tecido.custoTotal, 50);
    assert.equal(grupos['Fornecedor A'].totalCusto, 50);
    assert.equal(grupos['Fornecedor B'].totalCusto, 8);
});
