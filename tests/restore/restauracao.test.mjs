import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { cancelarPedido, confirmarOrcamentoComoPedido } from '../../order-domain.js';
import { cancelarMovimento, corrigirMovimento, criarEventoAuditoria, criarMovimento, TIPOS_MOVIMENTO } from '../../payments-domain.js';
import { calcularDetalhesItem } from '../../pricing-domain.js';

// Restauração administrativa contra o Firestore Emulator (projeto demo-, nunca produção).
// Execute com: npm run test:restore
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJETO = process.env.GCLOUD_PROJECT || 'demo-filippini-restauracao';
const SCRIPT = fileURLToPath(new URL('../../scripts/restaurar-backup.mjs', import.meta.url));
const PASTA = mkdtempSync(join(tmpdir(), 'restauracao-'));
const HOJE = '2026-09-20';

test('ambiente do emulador', () => {
    assert.ok(HOST, 'FIRESTORE_EMULATOR_HOST ausente: execute com "npm run test:restore".');
    assert.match(PROJETO, /^demo-/, 'a restauração só é testada em projeto demo do emulador');
});

const app = initializeApp({ projectId: PROJETO }, 'testes-restauracao');
const db = getFirestore(app);
after(() => deleteApp(app));

beforeEach(async () => {
    const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
    assert.equal(resposta.ok, true, 'o emulador precisa ser limpo entre os testes');
});

// --- Backup de referência, produzido pelas funções reais do domínio ------------------------------

function criarOrcamento(id, nomeCliente) {
    const detalhes = calcularDetalhesItem({ unidadeMedida: 'Unidade', precoCompra: 500, markup: 2 }, 1, 0, 0, 10);
    return {
        id,
        statusDocumento: 'orcamento',
        infoGerais: { nome: `Orçamento ${id}`, nomeCliente, enderecoCliente: 'Rua A, 1' },
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

function evento(tipo, anterior, novo, extras) {
    return { eventoId: `v${novo.versao}`, dados: criarEventoAuditoria(tipo, anterior, novo, extras) };
}

function montarBackup() {
    const pedidoAtivo = confirmarOrcamentoComoPedido(criarOrcamento('ORC-11', 'Cliente Ativo'), {
        confirmadoEm: '2026-09-15T15:00:00.000Z', confirmadoPor: 'uid-original-a'
    });
    const pedidoCancelado = cancelarPedido(
        confirmarOrcamentoComoPedido(criarOrcamento('ORC-12', 'Cliente Cancelado'), {
            confirmadoEm: '2026-09-15T16:00:00.000Z', confirmadoPor: 'uid-original-a'
        }),
        { motivo: 'Cliente desistiu', canceladoEm: '2026-09-19T12:00:00.000Z', canceladoPor: 'uid-original-b' }
    );

    // Recebimento criado por A, corrigido por B e cancelado por A: cadeia v1..v3.
    const recebimentoV1 = criarMovimento({
        tipo: TIPOS_MOVIMENTO.RECEBIMENTO, dataMovimento: '2026-09-16', valorCentavos: 50000, formaPagamento: 'PIX',
        observacao: 'Sinal', criadoEm: '2026-09-16T14:00:00.000Z', criadoPor: 'uid-original-a'
    }, { hoje: HOJE });
    const recebimentoV2 = corrigirMovimento(recebimentoV1, {
        valorCentavos: 45000, atualizadoEm: '2026-09-17T09:00:00.000Z', atualizadoPor: 'uid-original-b'
    }, { hoje: HOJE });
    const recebimentoV3 = cancelarMovimento(recebimentoV2, {
        motivo: 'Lançado em duplicidade', canceladoEm: '2026-09-18T10:00:00.000Z', canceladoPor: 'uid-original-a'
    });
    const reembolso = criarMovimento({
        tipo: TIPOS_MOVIMENTO.REEMBOLSO, dataMovimento: '2026-09-18', valorCentavos: 10000, formaPagamento: 'Transferência',
        observacao: '', criadoEm: '2026-09-18T11:00:00.000Z', criadoPor: 'uid-original-b'
    }, { hoje: HOJE });
    // Recebimento anterior ao cancelamento do pedido ORC-12: história válida sob pai cancelado.
    const recebimentoPedidoCancelado = criarMovimento({
        tipo: TIPOS_MOVIMENTO.RECEBIMENTO, dataMovimento: '2026-09-16', valorCentavos: 22000, formaPagamento: 'Dinheiro',
        observacao: 'Entrada', criadoEm: '2026-09-16T18:00:00.000Z', criadoPor: 'uid-original-a'
    }, { hoje: HOJE });

    return {
        version: '2.0',
        versaoBackup: 2,
        exportadoEm: '2026-09-20T12:00:00.000Z',
        precos: [{ id: 'produto-1', codigo: 'P1', descricao: 'Trilho', precoCompra: 100, markup: 2, status: 'Ativo' }],
        fornecedores: [{ id: 'fornecedor-1', nome: 'Fornecedor A', status: 'Ativo' }],
        categorias: [{ id: 'categoria-1', nome: 'Acessórios', status: 'Ativo' }],
        unidadesDeMedida: [{ id: 'unidade-1', nome: 'Unidade', status: 'Ativo' }],
        orcamentosSalvos: {
            'ORC-10': { ...criarOrcamento('ORC-10', 'Cliente Em Negociação'), firestoreId: 'ORC-10' },
            'ORC-11': { ...pedidoAtivo, firestoreId: 'ORC-11' },
            'ORC-12': pedidoCancelado
        },
        pagamentos: [
            {
                orcamentoId: 'ORC-11', pagamentoId: 'pag-recebimento', movimento: recebimentoV3,
                auditoria: [
                    evento('criacao', null, recebimentoV1, { registradoEm: recebimentoV1.criadoEm, registradoPor: 'uid-original-a' }),
                    evento('correcao', recebimentoV1, recebimentoV2, { registradoEm: recebimentoV2.atualizadoEm, registradoPor: 'uid-original-b' }),
                    evento('cancelamento', recebimentoV2, recebimentoV3, {
                        registradoEm: recebimentoV3.canceladoEm, registradoPor: 'uid-original-a', motivo: recebimentoV3.motivoCancelamento
                    })
                ]
            },
            {
                orcamentoId: 'ORC-11', pagamentoId: 'pag-reembolso', movimento: reembolso,
                auditoria: [evento('criacao', null, reembolso, { registradoEm: reembolso.criadoEm, registradoPor: 'uid-original-b' })]
            },
            {
                orcamentoId: 'ORC-12', pagamentoId: 'pag-antes-do-cancelamento', movimento: recebimentoPedidoCancelado,
                auditoria: [evento('criacao', null, recebimentoPedidoCancelado, {
                    registradoEm: recebimentoPedidoCancelado.criadoEm, registradoPor: 'uid-original-a'
                })]
            }
        ]
    };
}

// 4 catálogos + 3 orçamentos + 3 pagamentos + 5 eventos.
const TOTAL_DOCUMENTOS = 15;

function salvarBackup(backup, nome = 'filippini_backup_teste.json') {
    const caminho = join(PASTA, nome);
    writeFileSync(caminho, JSON.stringify(backup, null, 2));
    return caminho;
}

function rodar(...argumentos) {
    const resultado = spawnSync(process.execPath, [SCRIPT, ...argumentos], { encoding: 'utf8', env: process.env });
    return { codigo: resultado.status, saida: resultado.stdout, erro: resultado.stderr };
}

async function contarDocumentos() {
    const colecoes = ['precos', 'fornecedores', 'categorias', 'unidadesDeMedida', 'orcamentos', 'contadores'];
    let total = 0;
    for (const colecao of colecoes) total += (await db.collection(colecao).get()).size;
    total += (await db.collectionGroup('pagamentos').get()).size;
    total += (await db.collectionGroup('auditoria').get()).size;
    return total;
}

// --- Testes ---------------------------------------------------------------------------------------

test('dry-run (sem --apply) não grava nada e mostra o plano', async () => {
    const arquivo = salvarBackup(montarBackup());
    const { codigo, saida } = rodar(arquivo, '--project', PROJETO);

    assert.equal(codigo, 0, saida);
    assert.match(saida, /MODO: DRY-RUN/);
    assert.match(saida, new RegExp(`Projeto: ${PROJETO}`));
    assert.match(saida, /Orçamentos: 3/);
    assert.match(saida, /Pagamentos: 3/);
    assert.match(saida, /Eventos: 5/);
    assert.match(saida, new RegExp(`CREATE: ${TOTAL_DOCUMENTOS}`));
    assert.match(saida, /SKIP: 0/);
    assert.match(saida, /CONFLICT: 0/);
    assert.equal(await contarDocumentos(), 0, 'sem --apply nada pode ser gravado');
});

test('--apply restaura o backup completo preservando IDs, autores, datas, versões, cancelamentos e reembolsos', async () => {
    const backup = montarBackup();
    const { codigo, saida } = rodar(salvarBackup(backup), '--project', PROJETO, '--apply');

    assert.equal(codigo, 0, saida);
    assert.match(saida, new RegExp(`Gravados: ${TOTAL_DOCUMENTOS}`));
    assert.match(saida, /Verificação: todos os documentos do backup estão iguais no destino/);
    assert.equal(await contarDocumentos(), TOTAL_DOCUMENTOS);

    // Catálogo: o id vira o ID do documento e não é gravado como campo.
    const { id: _idPreco, ...preco } = backup.precos[0];
    assert.deepEqual((await db.doc('precos/produto-1').get()).data(), preco);

    // Orçamentos: gravados sem o artefato firestoreId.
    for (const id of ['ORC-10', 'ORC-11', 'ORC-12']) {
        const { firestoreId: _artefato, ...esperado } = backup.orcamentosSalvos[id];
        const gravado = (await db.doc(`orcamentos/${id}`).get()).data();
        assert.deepEqual(gravado, esperado, id);
        assert.equal('firestoreId' in gravado, false);
    }

    // Pagamentos e auditoria: byte a byte iguais ao backup, com IDs originais.
    for (const registro of backup.pagamentos) {
        const base = `orcamentos/${registro.orcamentoId}/pagamentos/${registro.pagamentoId}`;
        assert.deepEqual((await db.doc(base).get()).data(), registro.movimento, base);
        const eventos = await db.collection(`${base}/auditoria`).get();
        assert.deepEqual(eventos.docs.map(documento => documento.id).sort(), registro.auditoria.map(e => e.eventoId).sort());
        for (const { eventoId, dados } of registro.auditoria) {
            assert.deepEqual((await db.doc(`${base}/auditoria/${eventoId}`).get()).data(), dados, `${base}/auditoria/${eventoId}`);
        }
    }
    const cancelado = (await db.doc('orcamentos/ORC-11/pagamentos/pag-recebimento').get()).data();
    assert.equal(cancelado.versao, 3);
    assert.equal(cancelado.criadoPor, 'uid-original-a');
    assert.equal(cancelado.canceladoPor, 'uid-original-a');
    assert.equal(cancelado.motivoCancelamento, 'Lançado em duplicidade');
    const correcao = (await db.doc('orcamentos/ORC-11/pagamentos/pag-recebimento/auditoria/v2').get()).data();
    assert.equal(correcao.registradoPor, 'uid-original-b', 'o autor histórico da correção é preservado');

    // Centavos continuam inteiros (integerValue), como as Rules exigem para correções futuras pelo app.
    const rest = await fetch(`http://${HOST}/v1/projects/${PROJETO}/databases/(default)/documents/orcamentos/ORC-11/pagamentos/pag-reembolso`,
        { headers: { Authorization: 'Bearer owner' } }).then(resposta => resposta.json());
    assert.equal(rest.fields.valorCentavos.integerValue, '10000');
});

test('segunda execução é idempotente: tudo SKIP e zero gravações', async () => {
    const arquivo = salvarBackup(montarBackup());
    assert.equal(rodar(arquivo, '--project', PROJETO, '--apply').codigo, 0);
    const antes = (await db.doc('orcamentos/ORC-11/pagamentos/pag-recebimento').get()).updateTime;

    const { codigo, saida } = rodar(arquivo, '--project', PROJETO, '--apply');
    assert.equal(codigo, 0, saida);
    assert.match(saida, /CREATE: 0/);
    assert.match(saida, new RegExp(`SKIP: ${TOTAL_DOCUMENTOS}`));
    assert.match(saida, /Gravados: 0/);
    assert.equal(await contarDocumentos(), TOTAL_DOCUMENTOS);
    const depois = (await db.doc('orcamentos/ORC-11/pagamentos/pag-recebimento').get()).updateTime;
    assert.equal(depois.isEqual(antes), true, 'documento existente igual não é regravado');
});

test('execução interrompida pode ser retomada: o que falta vira CREATE, o resto SKIP', async () => {
    // Simula uma parada no meio: só o catálogo e o pedido ORC-11 chegaram, sem nenhum pagamento.
    const backup = montarBackup();
    const { id: _id, ...preco } = backup.precos[0];
    await db.doc('precos/produto-1').create(preco);
    const { firestoreId: _artefato, ...orc11 } = backup.orcamentosSalvos['ORC-11'];
    await db.doc('orcamentos/ORC-11').create(orc11);

    const { codigo, saida } = rodar(salvarBackup(backup), '--project', PROJETO, '--apply');
    assert.equal(codigo, 0, saida);
    assert.match(saida, /SKIP: 2/);
    assert.match(saida, new RegExp(`CREATE: ${TOTAL_DOCUMENTOS - 2}`));
    assert.equal(await contarDocumentos(), TOTAL_DOCUMENTOS);
});

test('documento existente divergente é CONFLICT e bloqueia o --apply inteiro', async () => {
    await db.doc('precos/produto-1').create({ codigo: 'P1', descricao: 'Trilho', precoCompra: 999, markup: 2, status: 'Ativo' });
    const arquivo = salvarBackup(montarBackup());

    const seco = rodar(arquivo, '--project', PROJETO);
    assert.equal(seco.codigo, 2, seco.saida);
    assert.match(seco.saida, /CONFLICT: 1/);
    assert.match(seco.saida, /precos\/produto-1/);

    const aplicado = rodar(arquivo, '--project', PROJETO, '--apply');
    assert.equal(aplicado.codigo, 2, aplicado.saida);
    assert.match(aplicado.saida, /APPLY BLOQUEADO: nada foi gravado/);
    assert.equal(await contarDocumentos(), 1, 'nenhum outro documento do backup foi gravado');
    assert.equal((await db.doc('precos/produto-1').get()).data().precoCompra, 999, 'o documento divergente não foi sobrescrito');
});

test('cadeia financeira inválida bloqueia antes de qualquer gravação, mesmo com --apply', async () => {
    const backup = montarBackup();
    // Remove o evento v2 da cadeia v1..v3: a história ficaria com lacuna.
    backup.pagamentos[0].auditoria.splice(1, 1);

    const { codigo, erro } = rodar(salvarBackup(backup), '--project', PROJETO, '--apply');
    assert.equal(codigo, 1);
    assert.match(erro, /Pagamentos inválidos/);
    assert.match(erro, /pag-recebimento/);
    assert.match(erro, /Nenhuma alteração foi feita/);
    assert.equal(await contarDocumentos(), 0);
});

test('orçamento estruturalmente inválido, mesmo sem pagamentos, bloqueia antes de qualquer gravação', async () => {
    const backup = montarBackup();
    // ORC-10 não tem pagamentos; um orçamento em negociação não pode carregar snapshot de pedido.
    backup.orcamentosSalvos['ORC-10'].pedido = { versaoSnapshot: 2 };

    const { codigo, erro } = rodar(salvarBackup(backup), '--project', PROJETO, '--apply');
    assert.equal(codigo, 1);
    assert.match(erro, /orçamento ORC-10 não pode ser restaurado \(orcamento-com-snapshot\)/);
    assert.match(erro, /Nenhuma alteração foi feita/);
    assert.equal(await contarDocumentos(), 0);
});

test('--project é obrigatório: sem ele nada é lido nem gravado', async () => {
    const { codigo, erro } = rodar(salvarBackup(montarBackup()), '--apply');
    assert.equal(codigo, 1);
    assert.match(erro, /--project é obrigatório/);
    assert.equal(await contarDocumentos(), 0);
});
