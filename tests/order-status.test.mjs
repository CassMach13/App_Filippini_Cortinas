import assert from 'node:assert/strict';
import test from 'node:test';

import { listarFollowUps } from '../followup-domain.js';
import {
    STATUS_DOCUMENTO,
    criarOrcamentoDuplicado,
    criarSnapshotPedido,
    marcarOrcamentoComoPerdido,
    obterItensDoPedido,
    obterStatusComercial,
    obterTotaisDoPedido,
    orcamentoEstaPerdido,
    pedidoEstaConfirmado,
    reabrirNegociacao,
    validarExclusaoOrcamento
} from '../order-domain.js';

const HOJE = '2026-09-16';
const AUDITORIA = { alteradoEm: '2026-09-16T15:00:00.000Z', alteradoPor: 'usuario-teste' };

function criarOrcamentoEmNegociacao() {
    return {
        id: 'ORC-20',
        statusDocumento: 'orcamento',
        infoGerais: {
            nome: 'Orçamento ORC-20',
            nomeCliente: 'Cliente Teste',
            enderecoCliente: 'Rua do Cliente, 10',
            celularCliente: '5511987654321',
            nomeComissionado: 'Arquiteta Teste',
            celularComissionado: '5521998765432',
            dataOrcamento: '2026-09-01',
            prazoValidade: '2026-09-30',
            proximoFollowUp: HOJE,
            observacaoFollowUp: 'Retornar após visita técnica'
        },
        infoComercial: { descontoGlobal: 5 },
        valoresInstalacao: { Sala: 150 },
        itens: [
            { id: 'item-1', codigo: 'SUP-01', fornecedor: 'Fornecedor A', quantidade: 2, precoTotal: 80, custoReal: 40 }
        ],
        produtosAcabados: [
            {
                id: 'prod-1',
                nome: 'Cortina Sala',
                ambiente: 'Sala',
                itens: [
                    { id: 'item-2', codigo: 'TEC-01', fornecedor: 'Fornecedor B', quantidade: 5, precoTotal: 500, custoReal: 250 }
                ]
            }
        ]
    };
}

function confirmarPedido(orcamento) {
    return {
        ...structuredClone(orcamento),
        statusDocumento: 'pedido',
        pedido: criarSnapshotPedido(orcamento, { confirmadoEm: '2026-09-16T15:00:00.000Z', confirmadoPor: 'usuario-teste' })
    };
}

function semCamposDeStatus(orcamento) {
    const { statusDocumento, statusAlteradoEm, statusAlteradoPor, ...restante } = orcamento;
    return restante;
}

test('orçamento sem status ou com status padrão está em negociação', () => {
    assert.equal(obterStatusComercial({ id: 'ORC-01' }), STATUS_DOCUMENTO.ORCAMENTO);
    assert.equal(obterStatusComercial(criarOrcamentoEmNegociacao()), STATUS_DOCUMENTO.ORCAMENTO);
    assert.equal(obterStatusComercial(null), STATUS_DOCUMENTO.ORCAMENTO);
    // Mantém a leitura atual: "pedido" sem data de confirmação não é pedido confirmado.
    assert.equal(obterStatusComercial({ statusDocumento: 'pedido', pedido: {} }), STATUS_DOCUMENTO.ORCAMENTO);
    assert.equal(obterStatusComercial(confirmarPedido(criarOrcamentoEmNegociacao())), STATUS_DOCUMENTO.PEDIDO);
});

test('marca como perdido preservando itens, valores, cliente e histórico', () => {
    const original = criarOrcamentoEmNegociacao();
    const copiaOriginal = structuredClone(original);
    const perdido = marcarOrcamentoComoPerdido(original, AUDITORIA);

    assert.equal(perdido.statusDocumento, STATUS_DOCUMENTO.PERDIDO);
    assert.equal(perdido.statusAlteradoEm, AUDITORIA.alteradoEm);
    assert.equal(perdido.statusAlteradoPor, AUDITORIA.alteradoPor);
    assert.equal(orcamentoEstaPerdido(perdido), true);
    assert.deepEqual(semCamposDeStatus(perdido), semCamposDeStatus(original));
    assert.deepEqual(original, copiaOriginal);

    assert.throws(() => marcarOrcamentoComoPerdido(perdido, AUDITORIA), /já está marcado como perdido/);
    assert.throws(() => marcarOrcamentoComoPerdido(null), TypeError);
});

test('orçamento perdido não é pedido e sai dos follow-ups ativos', () => {
    const original = criarOrcamentoEmNegociacao();
    const perdido = marcarOrcamentoComoPerdido(original, AUDITORIA);

    assert.equal(pedidoEstaConfirmado(perdido), false);
    assert.equal(obterTotaisDoPedido(perdido), null);
    assert.deepEqual(listarFollowUps([original], HOJE).hoje.map(registro => registro.id), ['ORC-20']);
    assert.deepEqual(listarFollowUps([perdido], HOJE), { vencidos: [], hoje: [], proximos: [] });
    // O follow-up continua guardado como histórico.
    assert.equal(perdido.infoGerais.proximoFollowUp, HOJE);
    assert.equal(perdido.infoGerais.observacaoFollowUp, 'Retornar após visita técnica');
});

test('reabre orçamento perdido sem alterar itens, valores ou contatos e sem reativar a data antiga', () => {
    const perdido = marcarOrcamentoComoPerdido(criarOrcamentoEmNegociacao(), AUDITORIA);
    assert.equal(perdido.infoGerais.proximoFollowUp, HOJE);
    assert.equal(perdido.infoGerais.observacaoFollowUp, 'Retornar após visita técnica');

    const reaberto = reabrirNegociacao(perdido, { alteradoEm: '2026-09-17T12:00:00.000Z', alteradoPor: 'usuario-2' });

    assert.equal(reaberto.statusDocumento, STATUS_DOCUMENTO.ORCAMENTO);
    assert.equal(obterStatusComercial(reaberto), STATUS_DOCUMENTO.ORCAMENTO);
    assert.equal(reaberto.statusAlteradoPor, 'usuario-2');
    assert.equal(reaberto.pedido, undefined);
    assert.equal(reaberto.infoGerais.proximoFollowUp, '');
    assert.equal(reaberto.infoGerais.observacaoFollowUp, 'Retornar após visita técnica');

    // Fora a data do follow-up, nada muda: itens, valores e contatos continuam iguais.
    const comDataOriginal = { ...reaberto, infoGerais: { ...reaberto.infoGerais, proximoFollowUp: HOJE } };
    assert.deepEqual(semCamposDeStatus(comDataOriginal), semCamposDeStatus(perdido));
    assert.equal(perdido.infoGerais.proximoFollowUp, HOJE);

    // Só volta à lista quando o usuário informa uma nova data.
    assert.deepEqual(listarFollowUps([reaberto], HOJE), { vencidos: [], hoje: [], proximos: [] });
    const comNovaData = { ...reaberto, infoGerais: { ...reaberto.infoGerais, proximoFollowUp: '2026-09-20' } };
    assert.deepEqual(listarFollowUps([comNovaData], HOJE).proximos.map(registro => registro.id), ['ORC-20']);

    assert.throws(() => reabrirNegociacao(criarOrcamentoEmNegociacao()), /Somente orçamentos marcados como perdidos/);
});

test('orçamento perdido não pode ser excluído, mas continua podendo ser reaberto', () => {
    const emNegociacao = criarOrcamentoEmNegociacao();
    const perdido = marcarOrcamentoComoPerdido(emNegociacao, AUDITORIA);
    const pedido = confirmarPedido(emNegociacao);

    assert.equal(validarExclusaoOrcamento(emNegociacao), null);
    assert.equal(validarExclusaoOrcamento({ id: 'ORC-01' }), null);
    assert.match(validarExclusaoOrcamento(perdido), /perdidos \/ não fechados não podem ser excluídos/);
    assert.match(validarExclusaoOrcamento(pedido), /Pedidos confirmados não podem ser excluídos/);

    const reaberto = reabrirNegociacao(perdido, AUDITORIA);
    assert.equal(validarExclusaoOrcamento(reaberto), null);
});

test('pedido confirmado não pode ser marcado como perdido nem reaberto e continua congelado', () => {
    const orcamento = criarOrcamentoEmNegociacao();
    const pedido = confirmarPedido(orcamento);
    const copiaPedido = structuredClone(pedido);

    assert.throws(() => marcarOrcamentoComoPerdido(pedido, AUDITORIA), /Pedidos confirmados não podem ser marcados como perdidos/);
    assert.throws(() => reabrirNegociacao(pedido, AUDITORIA), /Somente orçamentos marcados como perdidos/);
    assert.deepEqual(pedido, copiaPedido);

    pedido.produtosAcabados[0].itens[0].custoReal = 999;
    assert.equal(pedidoEstaConfirmado(pedido), true);
    assert.equal(obterItensDoPedido(pedido).find(item => item.id === 'item-2').custoTotal, 250);
    assert.deepEqual(listarFollowUps([pedido], HOJE), { vencidos: [], hoje: [], proximos: [] });
});

test('duplicação copia contatos e nasce em negociação sem follow-up', () => {
    [
        criarOrcamentoEmNegociacao(),
        marcarOrcamentoComoPerdido(criarOrcamentoEmNegociacao(), AUDITORIA),
        { ...confirmarPedido(criarOrcamentoEmNegociacao()), pagamentos: [{ id: 'pag-1', valor: 100 }] }
    ].forEach(original => {
        const copia = criarOrcamentoDuplicado(original, { novoId: 'ORC-21', dataOrcamento: '2026-09-17' });

        assert.equal(copia.id, 'ORC-21');
        assert.equal(copia.statusDocumento, STATUS_DOCUMENTO.ORCAMENTO);
        assert.equal(obterStatusComercial(copia), STATUS_DOCUMENTO.ORCAMENTO);
        assert.equal(copia.pedido, undefined);
        assert.equal(copia.pagamentos, undefined);
        assert.equal(copia.statusAlteradoEm, undefined);
        assert.equal(copia.statusAlteradoPor, undefined);

        assert.equal(copia.infoGerais.nomeCliente, 'Cliente Teste');
        assert.equal(copia.infoGerais.enderecoCliente, 'Rua do Cliente, 10');
        assert.equal(copia.infoGerais.celularCliente, '5511987654321');
        assert.equal(copia.infoGerais.nomeComissionado, 'Arquiteta Teste');
        assert.equal(copia.infoGerais.celularComissionado, '5521998765432');
        assert.equal(copia.infoGerais.proximoFollowUp, '');
        assert.equal(copia.infoGerais.observacaoFollowUp, '');
        assert.equal(copia.infoGerais.prazoValidade, '');
        assert.deepEqual(copia.itens, original.itens);
        assert.deepEqual(copia.produtosAcabados, original.produtosAcabados);

        // A cópia é independente e o original não é alterado.
        assert.equal(original.infoGerais.proximoFollowUp, HOJE);
        assert.deepEqual(listarFollowUps([copia], HOJE), { vencidos: [], hoje: [], proximos: [] });
    });
});
