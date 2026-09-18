import assert from 'node:assert/strict';
import test from 'node:test';

import { cancelarPedido, confirmarOrcamentoComoPedido, obterItensAtuaisDoOrcamento } from '../order-domain.js';
import { calcularDetalhesItem } from '../pricing-domain.js';
import { STATUS_MOVIMENTO, TIPOS_MOVIMENTO, calcularSituacaoFinanceira } from '../payments-domain.js';
import {
    ErroOperacaoMovimento,
    cancelarMovimentoComTransacao,
    corrigirMovimentoComTransacao,
    registrarMovimentoComTransacao
} from '../payment-transactions.js';

const HOJE = '2026-09-20';
const AGORA = '2026-09-20T13:00:00.000Z';

function erroFirestore(code) {
    return Object.assign(new Error(`Falha simulada: ${code}`), { code });
}

// Firestore em memória com a semântica de transação do SDK web, agora com caminhos de vários
// segmentos (subcoleções) e set(). Leituras registram a versão do documento; se ela mudar antes do
// commit, a função roda de novo. Offline, a transação falha em vez de enfileirar.
function criarFirestoreFalso(documentos = {}) {
    const armazenamento = new Map(Object.entries(structuredClone(documentos)));
    const versoes = new Map([...armazenamento.keys()].map(caminho => [caminho, 1]));
    const estado = { offline: false, falhaProxima: null, transacoes: 0, tentativas: 0, antesDoCommit: null, escritas: [] };

    const firestore = {
        db: { nome: 'firestore-falso' },
        doc: (_db, ...segmentos) => ({ caminho: segmentos.join('/') }),
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
                        lidas.set(referencia.caminho, versoes.get(referencia.caminho) || 0);
                        const dados = structuredClone(armazenamento.get(referencia.caminho));
                        // Cede a vez para que outra transação possa ler o mesmo documento antes do commit.
                        await new Promise(resolve => setImmediate(resolve));
                        return { exists: () => dados !== undefined, data: () => structuredClone(dados) };
                    },
                    set: (referencia, dados) => operacoes.push({ referencia, dados })
                };
                const resultado = await funcao(transacao);
                if (estado.antesDoCommit) {
                    const gancho = estado.antesDoCommit;
                    estado.antesDoCommit = null;
                    await gancho();
                }
                const conflito = [...lidas].some(([caminho, versao]) => (versoes.get(caminho) || 0) !== versao);
                if (conflito) continue;
                operacoes.forEach(({ referencia, dados }) => {
                    armazenamento.set(referencia.caminho, structuredClone(dados));
                    versoes.set(referencia.caminho, (versoes.get(referencia.caminho) || 0) + 1);
                    estado.escritas.push(referencia.caminho);
                });
                return resultado;
            }
            throw erroFirestore('aborted');
        }
    };

    return {
        firestore,
        estado,
        ler: caminho => structuredClone(armazenamento.get(caminho)),
        escrever: (caminho, dados) => {
            armazenamento.set(caminho, structuredClone(dados));
            versoes.set(caminho, (versoes.get(caminho) || 0) + 1);
        },
        caminhos: () => [...armazenamento.keys()].sort()
    };
}

function criarOrcamento(id = 'ORC-90') {
    const detalhes = calcularDetalhesItem({ unidadeMedida: 'Unidade', precoCompra: 500, markup: 2 }, 1, 0, 0, 10);
    return {
        id,
        statusDocumento: 'orcamento',
        infoGerais: { nome: `Orçamento ${id}`, nomeCliente: 'Cliente Transação', enderecoCliente: 'Rua A, 1' },
        infoComercial: { condicaoPagamento: 'À vista', descontoGlobal: 0, percentualComissao: 10 },
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

function pedidoV2(id = 'ORC-90') {
    return confirmarOrcamentoComoPedido(criarOrcamento(id), { confirmadoEm: '2026-09-15T15:00:00.000Z', confirmadoPor: 'usuario-teste' });
}

function pedidoV1(id = 'ORC-91') {
    const base = criarOrcamento(id);
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

function ambiente(documento = pedidoV2()) {
    return criarFirestoreFalso({ [`orcamentos/${documento.id}`]: documento });
}

function argumentosRecebimento(extras = {}) {
    return {
        orcamentoId: 'ORC-90',
        pagamentoId: 'pag-1',
        tipo: TIPOS_MOVIMENTO.RECEBIMENTO,
        dataMovimento: '2026-09-18',
        valorCentavos: 50000,
        formaPagamento: 'PIX',
        observacao: 'Sinal',
        registradoEm: AGORA,
        registradoPor: 'usuario-teste',
        hoje: HOJE,
        ...extras
    };
}

async function capturarErro(promessa) {
    try {
        await promessa;
        return null;
    } catch (erro) {
        return erro;
    }
}

const caminhoPagamento = (id = 'pag-1') => `orcamentos/ORC-90/pagamentos/${id}`;
const caminhoAuditoria = (versao, id = 'pag-1') => `${caminhoPagamento(id)}/auditoria/v${versao}`;

// --- Registro -----------------------------------------------------------------------------------

test('registrar recebimento grava o movimento e a auditoria na mesma transação', async () => {
    const { firestore, estado, ler, caminhos } = ambiente();
    const movimento = await registrarMovimentoComTransacao(firestore, argumentosRecebimento());

    assert.equal(movimento.versao, 1);
    assert.equal(ler(caminhoPagamento()).valorCentavos, 50000);
    const evento = ler(caminhoAuditoria(1));
    assert.equal(evento.evento, 'criacao');
    assert.equal(evento.estadoAnterior, null);
    assert.equal(evento.estadoNovo.valorCentavos, 50000);
    assert.equal(estado.transacoes, 1);
    assert.deepEqual(caminhos(), ['orcamentos/ORC-90', caminhoPagamento(), caminhoAuditoria(1)]);
});

test('o documento do orçamento nunca é reescrito por um movimento financeiro', async () => {
    const { firestore, estado, ler } = ambiente();
    const antes = ler('orcamentos/ORC-90');
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());

    assert.deepEqual(ler('orcamentos/ORC-90'), antes);
    assert.ok(!estado.escritas.includes('orcamentos/ORC-90'), 'nenhuma escrita tocou o documento do pedido');
});

test('pedido v1 e orçamento em negociação recusam recebimento', async () => {
    const v1 = criarFirestoreFalso({ 'orcamentos/ORC-91': pedidoV1() });
    const erroV1 = await capturarErro(registrarMovimentoComTransacao(v1.firestore, argumentosRecebimento({ orcamentoId: 'ORC-91' })));
    assert.equal(erroV1.codigo, 'pedido-nao-elegivel');
    assert.equal(v1.ler(`orcamentos/ORC-91/pagamentos/pag-1`), undefined);

    const negociacao = criarFirestoreFalso({ 'orcamentos/ORC-90': criarOrcamento() });
    const erro = await capturarErro(registrarMovimentoComTransacao(negociacao.firestore, argumentosRecebimento()));
    assert.equal(erro.codigo, 'pedido-nao-elegivel');
});

test('snapshot v2 inválido recusa recebimento', async () => {
    const corrompido = pedidoV2();
    corrompido.pedido.financeiro.valorLiquidoFilippiniCentavos += 1;
    const { firestore } = criarFirestoreFalso({ 'orcamentos/ORC-90': corrompido });

    const erro = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento()));
    assert.equal(erro.codigo, 'pedido-nao-elegivel');
});

test('pedido inexistente recusa recebimento', async () => {
    const { firestore } = criarFirestoreFalso({});
    const erro = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento()));
    assert.equal(erro.codigo, 'nao-encontrado');
});

test('pedido cancelado bloqueia recebimento novo e aceita reembolso', async () => {
    const cancelado = cancelarPedido(pedidoV2(), { motivo: 'Cliente desistiu', canceladoEm: '2026-09-19T12:00:00.000Z', canceladoPor: 'u' });
    const { firestore, ler } = criarFirestoreFalso({ 'orcamentos/ORC-90': cancelado });

    const erro = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento()));
    assert.equal(erro.codigo, 'pedido-nao-elegivel');

    const reembolso = await registrarMovimentoComTransacao(firestore, argumentosRecebimento({
        pagamentoId: 'pag-reembolso', tipo: TIPOS_MOVIMENTO.REEMBOLSO, observacao: 'Devolução do sinal'
    }));
    assert.equal(reembolso.tipo, TIPOS_MOVIMENTO.REEMBOLSO);
    assert.equal(ler(caminhoPagamento('pag-reembolso')).valorCentavos, 50000);
});

test('data futura é recusada antes de qualquer acesso ao servidor', async () => {
    const { firestore, estado } = ambiente();
    const erro = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento({ dataMovimento: '2026-09-25' })));

    assert.equal(erro.codigo, 'movimento-invalido');
    assert.equal(estado.transacoes, 0, 'nada foi enviado ao servidor');
});

test('excedente não é bloqueado: o lançamento passa e a situação acusa', async () => {
    const pedido = pedidoV2();
    const { firestore } = ambiente(pedido);
    const total = pedido.pedido.financeiro.valorProdutosCobradoClienteCentavos;

    const movimento = await registrarMovimentoComTransacao(firestore, argumentosRecebimento({ valorCentavos: total + 10000 }));
    const resultado = calcularSituacaoFinanceira(pedido, [movimento]);
    assert.equal(resultado.situacao, 'Excedente');
    assert.equal(resultado.excedenteCentavos, 10000);
});

// --- Offline ------------------------------------------------------------------------------------

test('offline não enfileira dinheiro: nenhuma das três operações grava', async () => {
    const { firestore, estado, ler } = ambiente();
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());

    for (const [rotulo, chamada] of [
        ['registro', () => registrarMovimentoComTransacao(firestore, argumentosRecebimento({ pagamentoId: 'pag-2', online: false }))],
        ['correção', () => corrigirMovimentoComTransacao(firestore, {
            orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 1, corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE, online: false
        })],
        ['cancelamento', () => cancelarMovimentoComTransacao(firestore, {
            orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, motivo: 'Teste', canceladoEm: AGORA, canceladoPor: 'usuario-teste', online: false
        })]
    ]) {
        const erro = await capturarErro(chamada());
        assert.equal(erro.codigo, 'sem-conexao', rotulo);
    }

    assert.equal(ler(caminhoPagamento('pag-2')), undefined, 'o lançamento offline não foi criado');
    assert.equal(ler(caminhoPagamento()).versao, 1, 'o lançamento existente ficou intacto');
    assert.equal(estado.transacoes, 1, 'só o registro inicial chegou ao servidor');
});

test('queda de conexão durante a transação vira erro de conexão, sem gravar', async () => {
    const { firestore, estado, ler } = ambiente();
    estado.offline = true;

    const erro = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento()));
    assert.equal(erro.codigo, 'sem-conexao');
    assert.equal(ler(caminhoPagamento()), undefined);
});

// --- Ator obrigatório ---------------------------------------------------------------------------

test('operação sem ator falha antes de abrir transação', async () => {
    const { firestore, estado, ler } = ambiente();
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());
    const transacoesApos = estado.transacoes;

    const semAtor = [
        ['registro sem registradoPor', () => registrarMovimentoComTransacao(firestore, argumentosRecebimento({ pagamentoId: 'pag-2', registradoPor: null }))],
        ['registro com ator vazio', () => registrarMovimentoComTransacao(firestore, argumentosRecebimento({ pagamentoId: 'pag-3', registradoPor: '   ' }))],
        ['correção sem corrigidoPor', () => corrigirMovimentoComTransacao(firestore, {
            orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 1, corrigidoEm: AGORA, hoje: HOJE
        })],
        ['cancelamento sem canceladoPor', () => cancelarMovimentoComTransacao(firestore, {
            orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, motivo: 'Teste', canceladoEm: AGORA
        })]
    ];

    for (const [rotulo, chamada] of semAtor) {
        const erro = await capturarErro(chamada());
        assert.equal(erro.codigo, 'sem-ator', rotulo);
    }

    assert.equal(estado.transacoes, transacoesApos, 'nenhuma transação foi aberta sem ator');
    assert.equal(ler(caminhoPagamento('pag-2')), undefined);
    assert.equal(ler(caminhoPagamento()).versao, 1, 'o lançamento existente ficou intacto');
});

// --- Concorrência -------------------------------------------------------------------------------

test('dois recebimentos simultâneos não se perdem', async () => {
    const pedido = pedidoV2();
    const { firestore, ler } = ambiente(pedido);

    const [a, b] = await Promise.all([
        registrarMovimentoComTransacao(firestore, argumentosRecebimento({ pagamentoId: 'pag-a', valorCentavos: 30000 })),
        registrarMovimentoComTransacao(firestore, argumentosRecebimento({ pagamentoId: 'pag-b', valorCentavos: 20000 }))
    ]);

    assert.equal(ler(caminhoPagamento('pag-a')).valorCentavos, 30000);
    assert.equal(ler(caminhoPagamento('pag-b')).valorCentavos, 20000);
    assert.equal(calcularSituacaoFinanceira(pedido, [a, b]).recebidoCentavos, 50000);
});

test('registrar duas vezes o mesmo pagamentoId não duplica nem sobrescreve', async () => {
    const { firestore, ler } = ambiente();
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento({ valorCentavos: 30000 }));
    const erro = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento({ valorCentavos: 99999 })));

    assert.equal(erro.codigo, 'ja-existe');
    assert.equal(ler(caminhoPagamento()).valorCentavos, 30000);
});

test('cliente desatualizado não apaga a correção feita em outro dispositivo', async () => {
    const { firestore, ler } = ambiente();
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());
    // Outro dispositivo já corrigiu: o movimento está na versão 2.
    await corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 45000, corrigidoEm: AGORA, corrigidoPor: 'outro', hoje: HOJE
    });

    const erro = await capturarErro(corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 10, corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    }));

    assert.equal(erro.codigo, 'conflito');
    assert.equal(ler(caminhoPagamento()).valorCentavos, 45000, 'a correção do outro dispositivo permanece');
    assert.equal(ler(caminhoPagamento()).versao, 2);
});

test('correção concorrente na mesma versão: só uma conclui', async () => {
    const { firestore, estado, ler } = ambiente();
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());

    // A segunda correção entra depois da leitura da primeira e antes do commit dela.
    estado.antesDoCommit = async () => {
        await corrigirMovimentoComTransacao(firestore, {
            orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 11111, corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
        });
    };

    const erro = await capturarErro(corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 22222, corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    }));

    // A transação repete, relê a versão 2 e a versão esperada deixa de bater.
    assert.equal(erro.codigo, 'conflito');
    assert.equal(ler(caminhoPagamento()).valorCentavos, 11111);
    assert.equal(ler(caminhoPagamento()).versao, 2);
});

test('cancelar enquanto outro corrige: só uma operação vence aquela versão', async () => {
    const { firestore, estado, ler } = ambiente();
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());

    estado.antesDoCommit = async () => {
        await cancelarMovimentoComTransacao(firestore, {
            orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, motivo: 'Lançado em duplicidade', canceladoEm: AGORA, canceladoPor: 'usuario-teste'
        });
    };

    const erro = await capturarErro(corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 33333, corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    }));

    assert.equal(erro.codigo, 'conflito');
    const final = ler(caminhoPagamento());
    assert.equal(final.status, STATUS_MOVIMENTO.CANCELADO);
    assert.equal(final.valorCentavos, 50000, 'o cancelamento não alterou o valor');
});

// --- Correção versus reembolso ------------------------------------------------------------------

test('correção não cria movimento novo nem saída de caixa', async () => {
    const pedido = pedidoV2();
    const { firestore, ler, caminhos } = ambiente(pedido);
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento({ valorCentavos: 50000 }));

    const corrigido = await corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 40000,
        corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    });

    const movimentos = caminhos().filter(caminho => /\/pagamentos\/[^/]+$/.test(caminho));
    assert.equal(movimentos.length, 1, 'correção não gera um segundo movimento');
    assert.equal(corrigido.tipo, TIPOS_MOVIMENTO.RECEBIMENTO);

    const resultado = calcularSituacaoFinanceira(pedido, [ler(caminhoPagamento())]);
    assert.equal(resultado.reembolsadoCentavos, 0, 'corrigir não vira reembolso');
    assert.equal(resultado.recebidoCentavos, 40000);

    const evento = ler(caminhoAuditoria(2));
    assert.equal(evento.evento, 'correcao');
    assert.equal(evento.estadoAnterior.valorCentavos, 50000);
    assert.equal(evento.estadoNovo.valorCentavos, 40000);
});

test('reembolso é movimento financeiro real, com data própria e efeito negativo', async () => {
    const pedido = pedidoV2();
    const { firestore, ler } = ambiente(pedido);
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento({ valorCentavos: 50000, dataMovimento: '2026-09-16' }));
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento({
        pagamentoId: 'pag-reembolso', tipo: TIPOS_MOVIMENTO.REEMBOLSO, valorCentavos: 20000, dataMovimento: '2026-09-19'
    }));

    const movimentos = [ler(caminhoPagamento()), ler(caminhoPagamento('pag-reembolso'))];
    const resultado = calcularSituacaoFinanceira(pedido, movimentos);

    assert.equal(resultado.recebidoCentavos, 50000);
    assert.equal(resultado.reembolsadoCentavos, 20000);
    assert.equal(resultado.recebimentosLiquidosCentavos, 30000);
    // Datas próprias: o reembolso cai no período dele, não no do recebimento.
    assert.equal(movimentos[0].dataMovimento, '2026-09-16');
    assert.equal(movimentos[1].dataMovimento, '2026-09-19');
});

// --- Cancelamento do lançamento -----------------------------------------------------------------

test('cancelar lançamento é terminal, deixa auditoria e sai das somas', async () => {
    const pedido = pedidoV2();
    const { firestore, ler } = ambiente(pedido);
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());

    const cancelado = await cancelarMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1,
        motivo: 'Lançado em duplicidade', canceladoEm: AGORA, canceladoPor: 'usuario-teste'
    });
    assert.equal(cancelado.status, STATUS_MOVIMENTO.CANCELADO);
    assert.equal(calcularSituacaoFinanceira(pedido, [ler(caminhoPagamento())]).recebidoCentavos, 0);

    const evento = ler(caminhoAuditoria(2));
    assert.equal(evento.evento, 'cancelamento');
    assert.equal(evento.motivo, 'Lançado em duplicidade');
    assert.equal(evento.estadoAnterior.status, STATUS_MOVIMENTO.ATIVO);

    const erro = await capturarErro(corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 2, valorCentavos: 100, corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    }));
    assert.equal(erro.codigo, 'movimento-cancelado');
});

test('cancelar lançamento inexistente é recusado', async () => {
    const { firestore } = ambiente();
    const erro = await capturarErro(cancelarMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-fantasma', versaoEsperada: 1, motivo: 'Teste', canceladoEm: AGORA, canceladoPor: 'usuario-teste'
    }));
    assert.equal(erro.codigo, 'nao-encontrado');
});

// --- Pedido cancelado: histórico continua corrigível --------------------------------------------

async function ambienteComPedidoCanceladoEMovimentos() {
    // O pedido nasce válido, recebe movimentos e só depois é cancelado: é o caso real de um pedido
    // que já tinha dinheiro quando foi cancelado.
    const ambienteAtivo = ambiente();
    await registrarMovimentoComTransacao(ambienteAtivo.firestore, argumentosRecebimento({ pagamentoId: 'pag-receb', valorCentavos: 50000 }));
    await registrarMovimentoComTransacao(ambienteAtivo.firestore, argumentosRecebimento({
        pagamentoId: 'pag-reemb', tipo: TIPOS_MOVIMENTO.REEMBOLSO, valorCentavos: 10000
    }));

    const cancelado = cancelarPedido(pedidoV2(), { motivo: 'Cliente desistiu', canceladoEm: '2026-09-19T12:00:00.000Z', canceladoPor: 'u' });
    ambienteAtivo.escrever('orcamentos/ORC-90', cancelado);
    return ambienteAtivo;
}

test('pedido cancelado: recebimento novo é proibido, mas o histórico continua corrigível', async () => {
    const { firestore, ler } = await ambienteComPedidoCanceladoEMovimentos();

    const novo = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento({ pagamentoId: 'pag-novo' })));
    assert.equal(novo.codigo, 'pedido-nao-elegivel', 'recebimento novo continua proibido');

    // Erro de digitação num recebimento histórico pode ser corrigido mesmo com o pedido cancelado.
    const corrigido = await corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-receb', versaoEsperada: 1, valorCentavos: 45000,
        corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    });
    assert.equal(corrigido.valorCentavos, 45000);
    assert.equal(ler(caminhoPagamento('pag-receb')).versao, 2);

    // E o lançamento histórico também pode ser cancelado logicamente.
    const canceladoLogicamente = await cancelarMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-receb', versaoEsperada: 2,
        motivo: 'Nunca foi recebido', canceladoEm: AGORA, canceladoPor: 'usuario-teste'
    });
    assert.equal(canceladoLogicamente.status, STATUS_MOVIMENTO.CANCELADO);
});

test('pedido cancelado: reembolso existente também pode ser corrigido e cancelado', async () => {
    const { firestore, ler } = await ambienteComPedidoCanceladoEMovimentos();

    await corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-reemb', versaoEsperada: 1, valorCentavos: 12000,
        corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    });
    assert.equal(ler(caminhoPagamento('pag-reemb')).valorCentavos, 12000);

    await cancelarMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-reemb', versaoEsperada: 2,
        motivo: 'Reembolso lançado por engano', canceladoEm: AGORA, canceladoPor: 'usuario-teste'
    });
    assert.equal(ler(caminhoPagamento('pag-reemb')).status, STATUS_MOVIMENTO.CANCELADO);

    // Reembolso novo continua permitido em pedido cancelado.
    const reembolsoNovo = await registrarMovimentoComTransacao(firestore, argumentosRecebimento({
        pagamentoId: 'pag-reemb-2', tipo: TIPOS_MOVIMENTO.REEMBOLSO, valorCentavos: 5000
    }));
    assert.equal(reembolsoNovo.tipo, TIPOS_MOVIMENTO.REEMBOLSO);
});

test('correção é recusada quando o snapshot do pai deixou de ser válido', async () => {
    const corrompido = pedidoV2();
    const { firestore } = ambiente(corrompido);
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());

    corrompido.pedido.financeiro.valorComissaoCentavos += 1;
    const ambienteCorrompido = criarFirestoreFalso({ 'orcamentos/ORC-90': corrompido });
    ambienteCorrompido.escrever(caminhoPagamento(), { ...argumentosRecebimento(), versao: 1, status: 'ativo', tipo: 'recebimento' });

    const erro = await capturarErro(corrigirMovimentoComTransacao(ambienteCorrompido.firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 1, corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    }));
    assert.equal(erro.codigo, 'pedido-nao-elegivel');
});

// --- Vínculo com a auditoria --------------------------------------------------------------------

test('cada operação aponta ultimoEventoId para o evento daquela versão', async () => {
    const { firestore, ler } = ambiente();
    await registrarMovimentoComTransacao(firestore, argumentosRecebimento());
    assert.equal(ler(caminhoPagamento()).ultimoEventoId, 'v1');
    assert.equal(ler(caminhoAuditoria(1)).versaoNova, 1);

    await corrigirMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 1, valorCentavos: 40000, corrigidoEm: AGORA, corrigidoPor: 'usuario-teste', hoje: HOJE
    });
    assert.equal(ler(caminhoPagamento()).ultimoEventoId, 'v2');
    assert.equal(ler(caminhoAuditoria(2)).versaoAnterior, 1);

    await cancelarMovimentoComTransacao(firestore, {
        orcamentoId: 'ORC-90', pagamentoId: 'pag-1', versaoEsperada: 2, motivo: 'Duplicado', canceladoEm: AGORA, canceladoPor: 'usuario-teste'
    });
    const final = ler(caminhoPagamento());
    assert.equal(final.ultimoEventoId, 'v3');
    // O evento novo nunca reaproveita o id do anterior: as regras exigem que mude.
    assert.notEqual(final.ultimoEventoId, 'v2');
    assert.equal(ler(caminhoAuditoria(3)).evento, 'cancelamento');
});

// --- Tradução de erros do servidor --------------------------------------------------------------

test('recusa das regras e conflito do servidor viram mensagens próprias', async () => {
    const { firestore, estado } = ambiente();

    estado.falhaProxima = 'permission-denied';
    const recusado = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento()));
    assert.equal(recusado.codigo, 'recusado');
    assert.ok(recusado instanceof ErroOperacaoMovimento);

    estado.falhaProxima = 'aborted';
    const conflito = await capturarErro(registrarMovimentoComTransacao(firestore, argumentosRecebimento()));
    assert.equal(conflito.codigo, 'conflito');
});
