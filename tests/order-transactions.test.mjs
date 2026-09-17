import assert from 'node:assert/strict';
import test from 'node:test';

import {
    pedidoEstaCancelado,
    pedidoParticipaFinanceiro,
    validarSnapshotPedidoV2
} from '../order-domain.js';
import { calcularDetalhesItem } from '../pricing-domain.js';
import {
    ErroOperacaoPedido,
    cancelarPedidoComTransacao,
    confirmarPedidoComTransacao
} from '../order-transactions.js';

const AGORA = '2026-09-17T15:00:00.000Z';

function erroFirestore(code) {
    return Object.assign(new Error(`Falha simulada: ${code}`), { code });
}

// Firestore em memória com a mesma semântica de transação do SDK web: leituras registram a versão do
// documento; se ele mudar antes do commit, a função roda de novo (até 5 vezes). Offline, falha.
function criarFirestoreFalso(documentos = {}) {
    const armazenamento = new Map(Object.entries(structuredClone(documentos)));
    const versoes = new Map([...armazenamento.keys()].map(id => [id, 1]));
    const estado = { offline: false, falhaProxima: null, tentativas: 0, transacoes: 0, antesDoCommit: null, escritas: [] };

    const aplicarCaminhos = (anterior, dados) => {
        const resultado = structuredClone(anterior);
        for (const [caminho, valor] of Object.entries(dados)) {
            const partes = caminho.split('.');
            let alvo = resultado;
            partes.slice(0, -1).forEach(parte => {
                if (!alvo[parte] || typeof alvo[parte] !== 'object') alvo[parte] = {};
                alvo = alvo[parte];
            });
            alvo[partes.at(-1)] = structuredClone(valor);
        }
        return resultado;
    };

    const firestore = {
        db: { nome: 'firestore-falso' },
        doc: (_db, colecao, id) => ({ colecao, id }),
        async runTransaction(_db, funcao) {
            estado.transacoes++;
            for (let tentativa = 1; tentativa <= 5; tentativa++) {
                estado.tentativas++;
                if (estado.offline) throw erroFirestore('unavailable');
                if (estado.falhaProxima) {
                    const code = estado.falhaProxima;
                    estado.falhaProxima = null;
                    throw erroFirestore(code);
                }
                const lidas = new Map();
                const operacoes = [];
                const transacao = {
                    get: async referencia => {
                        // A leitura captura o estado deste instante, como o SDK; depois cede a vez para que
                        // outra transação leia o mesmo documento antes do commit desta.
                        lidas.set(referencia.id, versoes.get(referencia.id) || 0);
                        const dados = structuredClone(armazenamento.get(referencia.id));
                        await new Promise(resolve => setImmediate(resolve));
                        return { exists: () => dados !== undefined, data: () => structuredClone(dados) };
                    },
                    update: (referencia, dados) => operacoes.push({ referencia, dados })
                };
                const resultado = await funcao(transacao);
                if (estado.antesDoCommit) {
                    const gancho = estado.antesDoCommit;
                    estado.antesDoCommit = null;
                    gancho();
                }
                const conflito = [...lidas].some(([id, versao]) => (versoes.get(id) || 0) !== versao);
                if (conflito) continue;
                operacoes.forEach(({ referencia, dados }) => {
                    armazenamento.set(referencia.id, aplicarCaminhos(armazenamento.get(referencia.id), dados));
                    versoes.set(referencia.id, (versoes.get(referencia.id) || 0) + 1);
                    estado.escritas.push({ id: referencia.id, campos: Object.keys(dados) });
                });
                return resultado;
            }
            throw erroFirestore('aborted');
        }
    };

    return {
        firestore,
        estado,
        ler: id => structuredClone(armazenamento.get(id)),
        escrever: (id, dados) => {
            armazenamento.set(id, structuredClone(dados));
            versoes.set(id, (versoes.get(id) || 0) + 1);
        }
    };
}

function criarOrcamento(id = 'ORC-40', { descontoGlobal = 10, percentualComissao = 10 } = {}) {
    const detalhes = calcularDetalhesItem({ unidadeMedida: 'Unidade', precoCompra: 500, markup: 2 }, 1, 0, 0, percentualComissao);
    return {
        id,
        statusDocumento: 'orcamento',
        apresentacao: { modo: 'reduzida' },
        infoGerais: { nome: `Orçamento ${id}`, nomeCliente: 'Cliente Transação', nomeComissionado: 'Arquiteta' },
        infoComercial: { descontoGlobal, percentualComissao },
        valoresInstalacao: { Sala: 150 },
        itens: [{
            id: 'item-1', codigo: 'COD-1', fornecedor: 'Fornecedor A', unidadeMedida: 'Unidade', quantidade: 1,
            quantidadeCompra: 1, precoCompraUnitario: 500, custoReal: detalhes.custoReal,
            precoUnitarioBase: detalhes.precoUnitarioBase, precoTotalSemComissao: detalhes.precoTotalSemComissao,
            precoUnitario: detalhes.precoUnitario, precoTotal: detalhes.precoTotal
        }],
        produtosAcabados: []
    };
}

async function capturarErro(promessa) {
    try {
        await promessa;
    } catch (erro) {
        return erro;
    }
    assert.fail('a operação deveria ter falhado');
}

test('confirmação transacional grava o snapshot v2 e somente os campos da transição', async () => {
    const orcamento = criarOrcamento();
    const { firestore, estado, ler } = criarFirestoreFalso({ 'ORC-40': orcamento });

    const confirmado = await confirmarPedidoComTransacao(firestore, {
        id: 'ORC-40', confirmadoEm: AGORA, confirmadoPor: 'usuario-1', orcamentoExibido: orcamento
    });
    const gravado = ler('ORC-40');

    assert.equal(gravado.statusDocumento, 'pedido');
    assert.equal(gravado.pedido.versaoSnapshot, 2);
    assert.equal(validarSnapshotPedidoV2(gravado.pedido).valido, true);
    assert.equal(pedidoParticipaFinanceiro(gravado), true);
    assert.equal(gravado.pedido.confirmadoPor, 'usuario-1');
    assert.equal(gravado.pedido.financeiro.valorProdutosCobradoClienteCentavos, 99000);
    assert.deepEqual(gravado, confirmado);
    // Só a transição é escrita; itens, instalação, apresentação e dados gerais não são regravados.
    assert.deepEqual(estado.escritas, [{ id: 'ORC-40', campos: ['statusDocumento', 'pedido', 'infoComercial.percentualComissao'] }]);
    const { statusDocumento: _s, pedido: _p, infoComercial: infoDepois, ...restoDepois } = gravado;
    const { statusDocumento: _s0, infoComercial: infoAntes, ...restoAntes } = orcamento;
    assert.deepEqual(restoDepois, restoAntes);
    assert.deepEqual(infoDepois, infoAntes);
});

test('duas confirmações concorrentes: uma grava e a outra falha sem sobrescrever', async () => {
    const orcamento = criarOrcamento();
    const { firestore, estado, ler } = criarFirestoreFalso({ 'ORC-40': orcamento });

    const resultados = await Promise.allSettled([
        confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: '2026-09-17T15:00:00.000Z', confirmadoPor: 'aba-1' }),
        confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: '2026-09-17T15:00:01.000Z', confirmadoPor: 'aba-2' })
    ]);
    const vencedoras = resultados.filter(resultado => resultado.status === 'fulfilled');
    const perdedoras = resultados.filter(resultado => resultado.status === 'rejected');

    assert.equal(vencedoras.length, 1);
    assert.equal(perdedoras.length, 1);
    assert.ok(perdedoras[0].reason instanceof ErroOperacaoPedido);
    assert.equal(perdedoras[0].reason.codigo, 'ja-confirmado');
    // A segunda transação detectou o conflito, repetiu a leitura e encontrou o pedido já confirmado.
    assert.ok(estado.tentativas >= 3);
    assert.equal(estado.escritas.length, 1);
    assert.deepEqual(ler('ORC-40').pedido, vencedoras[0].value.pedido);
});

test('aba desatualizada: orçamento já confirmado em outro dispositivo não é sobrescrito', async () => {
    const orcamentoNaTela = criarOrcamento();
    const { firestore, ler } = criarFirestoreFalso({ 'ORC-40': orcamentoNaTela });
    await confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA, confirmadoPor: 'outro-dispositivo' });
    const pedidoOriginal = ler('ORC-40');

    const erro = await capturarErro(confirmarPedidoComTransacao(firestore, {
        id: 'ORC-40', confirmadoEm: '2026-09-17T16:00:00.000Z', confirmadoPor: 'aba-antiga', orcamentoExibido: orcamentoNaTela
    }));
    assert.equal(erro.codigo, 'ja-confirmado');
    assert.match(erro.message, /já foi confirmado/);
    assert.deepEqual(ler('ORC-40'), pedidoOriginal);
});

test('confirmação sem conexão falha sem criar pedido, antes ou durante a transação', async () => {
    const orcamento = criarOrcamento();
    const { firestore, estado, ler } = criarFirestoreFalso({ 'ORC-40': orcamento });

    const semRede = await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA, online: false }));
    assert.equal(semRede.codigo, 'sem-conexao');
    assert.match(semRede.message, /requer internet/);
    assert.equal(estado.transacoes, 0);

    estado.offline = true;
    const offline = await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA }));
    assert.equal(offline.codigo, 'sem-conexao');
    assert.deepEqual(ler('ORC-40'), orcamento);

    estado.offline = false;
    estado.falhaProxima = 'deadline-exceeded';
    assert.equal((await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA }))).codigo, 'sem-conexao');
    assert.deepEqual(ler('ORC-40'), orcamento);
    assert.equal(estado.escritas.length, 0);
});

test('erros do servidor são traduzidos sem gravar nada', async () => {
    const orcamento = criarOrcamento();
    const { firestore, estado, ler } = criarFirestoreFalso({ 'ORC-40': orcamento });

    estado.falhaProxima = 'permission-denied';
    assert.equal((await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA }))).codigo, 'recusado');
    estado.falhaProxima = 'aborted';
    assert.equal((await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA }))).codigo, 'conflito');
    estado.falhaProxima = 'internal';
    assert.equal((await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA }))).codigo, 'desconhecido');
    assert.deepEqual(ler('ORC-40'), orcamento);
    await assert.rejects(confirmarPedidoComTransacao(firestore, { confirmadoEm: AGORA }), TypeError);
});

test('confirmação respeita as regras de domínio lidas do servidor', async () => {
    const semItens = { ...criarOrcamento('ORC-41'), itens: [] };
    const perdido = { ...criarOrcamento('ORC-42'), statusDocumento: 'perdido' };
    const { firestore, estado } = criarFirestoreFalso({ 'ORC-41': semItens, 'ORC-42': perdido });

    assert.equal((await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-41', confirmadoEm: AGORA }))).codigo, 'sem-itens');
    assert.equal((await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-42', confirmadoEm: AGORA }))).codigo, 'perdido');
    assert.equal((await capturarErro(confirmarPedidoComTransacao(firestore, { id: 'ORC-99', confirmadoEm: AGORA }))).codigo, 'nao-encontrado');
    assert.equal(estado.escritas.length, 0);
});

test('congela exatamente o que está na tela: alteração não sincronizada ou concorrente aborta', async () => {
    const orcamentoNaTela = criarOrcamento();
    const noServidor = criarOrcamento('ORC-40', { descontoGlobal: 5 });
    const { firestore, estado, ler, escrever } = criarFirestoreFalso({ 'ORC-40': noServidor });

    const divergente = await capturarErro(confirmarPedidoComTransacao(firestore, {
        id: 'ORC-40', confirmadoEm: AGORA, orcamentoExibido: orcamentoNaTela
    }));
    assert.equal(divergente.codigo, 'orcamento-desatualizado');
    assert.deepEqual(ler('ORC-40'), noServidor);

    // Outro dispositivo altera o desconto entre a leitura e o commit: a transação repete e aborta.
    escrever('ORC-40', orcamentoNaTela);
    estado.antesDoCommit = () => escrever('ORC-40', noServidor);
    const concorrente = await capturarErro(confirmarPedidoComTransacao(firestore, {
        id: 'ORC-40', confirmadoEm: AGORA, orcamentoExibido: orcamentoNaTela
    }));
    assert.equal(concorrente.codigo, 'orcamento-desatualizado');
    assert.equal(ler('ORC-40').statusDocumento, 'orcamento');
    assert.equal(estado.escritas.length, 0);
});

test('cancelamento transacional grava só o registro e não pode ser repetido', async () => {
    const orcamento = criarOrcamento();
    const { firestore, estado, ler } = criarFirestoreFalso({ 'ORC-40': orcamento });
    await confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA, confirmadoPor: 'usuario-1' });
    const pedidoConfirmado = ler('ORC-40');

    const resultados = await Promise.allSettled([
        cancelarPedidoComTransacao(firestore, { id: 'ORC-40', motivo: 'Cliente desistiu', canceladoEm: '2026-09-18T10:00:00.000Z', canceladoPor: 'aba-1' }),
        cancelarPedidoComTransacao(firestore, { id: 'ORC-40', motivo: 'Outro motivo', canceladoEm: '2026-09-18T10:00:01.000Z', canceladoPor: 'aba-2' })
    ]);
    assert.equal(resultados.filter(resultado => resultado.status === 'fulfilled').length, 1);
    const rejeitado = resultados.find(resultado => resultado.status === 'rejected');
    assert.equal(rejeitado.reason.codigo, 'ja-cancelado');

    const cancelado = ler('ORC-40');
    assert.equal(pedidoEstaCancelado(cancelado), true);
    assert.equal(pedidoParticipaFinanceiro(cancelado), false);
    const { cancelamento, ...pedidoSemCancelamento } = cancelado.pedido;
    assert.deepEqual(pedidoSemCancelamento, pedidoConfirmado.pedido);
    assert.deepEqual(Object.keys(cancelamento).sort(), ['canceladoEm', 'canceladoPor', 'motivo']);
    assert.deepEqual(estado.escritas.at(-1), { id: 'ORC-40', campos: ['pedido.cancelamento'] });
    assert.equal(estado.escritas.length, 2);

    // Uma tentativa posterior também falha e não altera o registro.
    const repetido = await capturarErro(cancelarPedidoComTransacao(firestore, { id: 'ORC-40', motivo: 'Mudar motivo', canceladoEm: '2026-09-19T10:00:00.000Z' }));
    assert.equal(repetido.codigo, 'ja-cancelado');
    assert.deepEqual(ler('ORC-40'), cancelado);
});

test('cancelamento valida motivo e conexão antes do servidor e exige pedido confirmado', async () => {
    const orcamento = criarOrcamento();
    const { firestore, estado, ler } = criarFirestoreFalso({ 'ORC-40': orcamento });

    const semMotivo = await capturarErro(cancelarPedidoComTransacao(firestore, { id: 'ORC-40', motivo: '   ' }));
    assert.ok(semMotivo instanceof ErroOperacaoPedido);
    assert.equal(semMotivo.codigo, 'motivo-obrigatorio');
    assert.equal((await capturarErro(cancelarPedidoComTransacao(firestore, { id: 'ORC-40', motivo: 'x', online: false }))).codigo, 'sem-conexao');
    assert.equal(estado.transacoes, 0);

    assert.equal((await capturarErro(cancelarPedidoComTransacao(firestore, { id: 'ORC-40', motivo: 'Sem pedido' }))).codigo, 'nao-e-pedido');
    estado.offline = true;
    await confirmarPedidoComTransacao(firestore, { id: 'ORC-40', confirmadoEm: AGORA }).catch(() => {});
    assert.equal((await capturarErro(cancelarPedidoComTransacao(firestore, { id: 'ORC-40', motivo: 'Offline' }))).codigo, 'sem-conexao');
    assert.deepEqual(ler('ORC-40'), orcamento);
    await assert.rejects(cancelarPedidoComTransacao(firestore, { motivo: 'Sem id' }), TypeError);
});
