import assert from 'node:assert/strict';
import test from 'node:test';

import { obterDataCivilAtual } from '../date-domain.js';
import { SITUACAO_FOLLOW_UP, classificarFollowUp, listarFollowUps } from '../followup-domain.js';
import { calcularTotaisOrcamento } from '../order-domain.js';

const HOJE = '2026-09-16';

function criarOrcamento(id, infoGerais = {}, extras = {}) {
    return {
        id,
        statusDocumento: 'orcamento',
        infoGerais: { nomeCliente: `Cliente ${id}`, ...infoGerais },
        itens: [],
        produtosAcabados: [],
        ...extras
    };
}

function congelarProfundamente(valor) {
    if (valor && typeof valor === 'object') {
        Object.values(valor).forEach(congelarProfundamente);
        Object.freeze(valor);
    }
    return valor;
}

test('classifica follow-up vencido, de hoje, futuro ou sem data', () => {
    assert.equal(classificarFollowUp('2026-09-15', HOJE), SITUACAO_FOLLOW_UP.VENCIDO);
    assert.equal(classificarFollowUp('2026-09-16', HOJE), SITUACAO_FOLLOW_UP.HOJE);
    assert.equal(classificarFollowUp('2026-09-17', HOJE), SITUACAO_FOLLOW_UP.PROXIMO);

    [undefined, null, '', '2026-02-30', '16/09/2026'].forEach(data => {
        assert.equal(classificarFollowUp(data, HOJE), null, String(data));
    });
    assert.throws(() => classificarFollowUp('2026-09-16', '16/09/2026'), TypeError);
});

test('lista follow-ups ordenados por grupo, com observação, contatos e valor atual', () => {
    const orcamentoComValor = criarOrcamento('ORC-04', {
        proximoFollowUp: HOJE,
        observacaoFollowUp: 'Ligar para saber a decisão',
        celularCliente: '5511987654321',
        nomeComissionado: 'Arquiteta Teste',
        celularComissionado: '5521998765432'
    }, {
        itens: [{ precoTotal: 1000, margemLiquida: 400 }],
        valoresInstalacao: { Sala: 250 },
        infoComercial: { descontoGlobal: 10 },
        // Cache antigo ignorado: o valor vem de calcularTotaisOrcamento.
        totais: { totalProdutos: 999999, totalInstalacao: 1 }
    });

    const orcamentos = {
        'ORC-01': { id: 'ORC-01', infoGerais: { nomeCliente: 'Documento antigo' } },
        'ORC-02': criarOrcamento('ORC-02', { proximoFollowUp: '2026-09-10' }),
        'ORC-03': criarOrcamento('ORC-03', { proximoFollowUp: '2026-09-01' }),
        'ORC-04': orcamentoComValor,
        'ORC-10': criarOrcamento('ORC-10', { proximoFollowUp: HOJE }),
        'ORC-9': criarOrcamento('ORC-9', { proximoFollowUp: HOJE }),
        'ORC-05': criarOrcamento('ORC-05', { proximoFollowUp: '2026-10-01' }),
        'ORC-06': criarOrcamento('ORC-06', { proximoFollowUp: '2026-09-20' }),
        'ORC-07': criarOrcamento('ORC-07', { proximoFollowUp: '2026-09-02' }, { statusDocumento: 'perdido' }),
        'ORC-08': criarOrcamento('ORC-08', { proximoFollowUp: HOJE }, {
            statusDocumento: 'pedido',
            pedido: { confirmadoEm: '2026-09-15T12:00:00.000Z', itens: [] }
        }),
        'ORC-11': criarOrcamento('ORC-11', { proximoFollowUp: '2026-13-01' })
    };
    congelarProfundamente(orcamentos);

    const grupos = listarFollowUps(orcamentos, HOJE);

    assert.deepEqual(grupos.vencidos.map(registro => registro.id), ['ORC-03', 'ORC-02']);
    assert.deepEqual(grupos.hoje.map(registro => registro.id), ['ORC-04', 'ORC-9', 'ORC-10']);
    assert.deepEqual(grupos.proximos.map(registro => registro.id), ['ORC-06', 'ORC-05']);

    const registro = grupos.hoje[0];
    assert.equal(registro.situacao, SITUACAO_FOLLOW_UP.HOJE);
    assert.equal(registro.dataFollowUp, HOJE);
    assert.equal(registro.observacao, 'Ligar para saber a decisão');
    assert.equal(registro.nomeCliente, 'Cliente ORC-04');
    assert.equal(registro.celularCliente, '5511987654321');
    assert.equal(registro.nomeComissionado, 'Arquiteta Teste');
    assert.equal(registro.celularComissionado, '5521998765432');
    // Total da proposta ao cliente: 1.000 com 10% de desconto, mais 250 de instalação.
    assert.equal(registro.totalPropostaCliente, calcularTotaisOrcamento(orcamentoComValor).totalGeral);
    assert.equal(registro.totalPropostaCliente, 1150);

    assert.equal(grupos.vencidos[0].observacao, '');
    assert.equal(grupos.vencidos[0].celularCliente, '');
    assert.deepEqual(listarFollowUps(Object.values(orcamentos), HOJE), grupos);
});

test('documentos sem follow-up, perdidos ou pedidos ficam fora da lista ativa', () => {
    const grupos = listarFollowUps([
        { id: 'ORC-01' },
        criarOrcamento('ORC-02'),
        criarOrcamento('ORC-03', { proximoFollowUp: '', observacaoFollowUp: 'Sem data' }),
        criarOrcamento('ORC-04', { proximoFollowUp: HOJE }, { statusDocumento: 'perdido' }),
        criarOrcamento('ORC-05', { proximoFollowUp: HOJE }, {
            statusDocumento: 'pedido',
            pedido: { confirmadoEm: '2026-09-16T12:00:00.000Z', itens: [] }
        }),
        null
    ], HOJE);

    assert.deepEqual(grupos, { vencidos: [], hoje: [], proximos: [] });
    assert.deepEqual(listarFollowUps(undefined, HOJE), { vencidos: [], hoje: [], proximos: [] });
});

test('usa o dia civil de Brasília para decidir o que é hoje', () => {
    // 23h30 de 16/09 em Brasília já é 17/09 em UTC.
    const agora = new Date('2026-09-17T02:30:00.000Z');
    const hojeEmBrasilia = obterDataCivilAtual(agora);
    const orcamentos = [criarOrcamento('ORC-01', { proximoFollowUp: '2026-09-16' })];

    assert.equal(agora.toISOString().split('T')[0], '2026-09-17');
    assert.equal(hojeEmBrasilia, '2026-09-16');
    assert.deepEqual(listarFollowUps(orcamentos, hojeEmBrasilia).hoje.map(registro => registro.id), ['ORC-01']);
    assert.deepEqual(listarFollowUps(orcamentos, '2026-09-17').vencidos.map(registro => registro.id), ['ORC-01']);
    assert.throws(() => listarFollowUps(orcamentos, '17/09/2026'), TypeError);
});
