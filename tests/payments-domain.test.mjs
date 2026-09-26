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
    idDoEventoDaVersao,
    obterValorReceberCentavos,
    pedidoAceitaMovimento,
    prepararPagamentosParaBackup,
    validarCadeiaDeAuditoria,
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

test('BLOQUEADOR DE DEPLOY (4B2A): exportação cobre pagamentos, mas a restauração financeira continua indisponível', () => {
    // Guarda formal da Etapa 4: a exportação (Etapa 4B2A) já cobre pagamentos + auditoria, mas a
    // restauração privilegiada (Etapa 4B2R) ainda não existe. Nenhum write financeiro real pode ir a
    // produção até a 4B2R decidir o mecanismo de restauração sem reescrever autoria histórica.
    const fonteApps = readFileSync(new URL('../apps.js', import.meta.url), 'utf8');

    // 1) Exportação: coletarPagamentosParaBackup existe; montarDadosBackup monta o payload chamando
    // prepararPagamentosParaBackup (que valida a cadeia e ordena, e lança se algo estiver inconsistente
    // — fail-closed); exportarDados só chama baixarBackup(data) DEPOIS de montarDadosBackup ter
    // retornado com sucesso, nunca antes.
    assert.match(fonteApps, /async function coletarPagamentosParaBackup\(\)/, 'função de coleta de pagamentos existe');
    assert.match(fonteApps, /function montarDadosBackup\(pagamentosColetados\)/, 'função de montagem do payload existe');
    assert.match(fonteApps, /function baixarBackup\(data\)/, 'função de download existe e recebe só o payload já pronto');

    const inicioMontar = fonteApps.indexOf('function montarDadosBackup(pagamentosColetados)');
    const inicioBaixar = fonteApps.indexOf('function baixarBackup(data)');
    assert.ok(inicioMontar >= 0 && inicioBaixar > inicioMontar, 'montarDadosBackup vem antes de baixarBackup');
    const trechoMontar = fonteApps.slice(inicioMontar, inicioBaixar);
    // O mapa de pais precisa ser passado junto: sem ele a certificação de pai não acontece.
    assert.match(
        trechoMontar,
        /prepararPagamentosParaBackup\(pagamentosColetados, orcamentosSalvos\)/,
        'montarDadosBackup certifica identidade, pai e cadeia via prepararPagamentosParaBackup'
    );

    const fimBaixar = fonteApps.indexOf('async function exportarDados()');
    const trechoBaixar = fonteApps.slice(inicioBaixar, fimBaixar);
    assert.ok(!trechoBaixar.includes('prepararPagamentosParaBackup'), 'baixarBackup não revalida a cadeia — só recebe payload já pronto');

    const inicioExport = fimBaixar;
    const fimExport = fonteApps.indexOf('async function gravarDocumentosEmLotes');
    assert.ok(inicioExport >= 0 && fimExport > inicioExport, 'exportarDados existe e vem antes de gravarDocumentosEmLotes');
    const trechoExportacao = fonteApps.slice(inicioExport, fimExport);
    assert.match(trechoExportacao, /coletarPagamentosParaBackup\(\)/, 'exportarDados chama a coleta de pagamentos');
    assert.match(trechoExportacao, /montarDadosBackup\(pagamentosColetados\)/, 'exportarDados chama a montagem validada do payload');
    const indiceMontarNoExport = trechoExportacao.indexOf('montarDadosBackup(pagamentosColetados)');
    const indiceBaixarNoExport = trechoExportacao.indexOf('baixarBackup(data)');
    assert.ok(indiceBaixarNoExport > indiceMontarNoExport, 'o download só acontece depois da montagem validada do payload');

    // 2) Importação: um backup com pagamentos precisa abortar ANTES de qualquer write, ou seja, antes
    // da primeira chamada a gravarDocumentosEmLotes dentro de importarDados.
    const inicioImport = fonteApps.indexOf('async function importarDados(event)');
    const fimImport = fonteApps.indexOf('async function salvarOrcamentoAtual');
    assert.ok(inicioImport >= 0 && fimImport > inicioImport, 'importarDados existe e tem um fim localizável');
    const trechoImportacao = fonteApps.slice(inicioImport, fimImport);
    const indiceBloqueio = trechoImportacao.indexOf('restauração de pagamentos ainda exige');
    const indicePrimeiraGravacao = trechoImportacao.indexOf('gravarDocumentosEmLotes(');
    assert.ok(indiceBloqueio >= 0, 'a mensagem de bloqueio de restauração financeira está presente');
    assert.ok(indicePrimeiraGravacao >= 0, 'importarDados ainda grava dados (fluxo normal preservado)');
    assert.ok(indiceBloqueio < indicePrimeiraGravacao, 'o bloqueio ocorre antes de qualquer gravação: zero writes com pagamentos no backup');

    // 3) A restauração financeira privilegiada (4B2R) ainda não está wired: nada em apps.js chama o
    // motor de restauração de movimentos.
    assert.ok(!fonteApps.includes('avaliarRestauracaoMovimento'), 'a restauração de pagamentos ainda não está implementada em produção');
});

test('a restauração preserva a validade temporal: data futura é recusada', () => {
    // Relógio explícito: o teste não depende da data real da execução.
    const restauracao = { hoje: '2026-09-18' };
    const pedidoAtivo = criarPedidoV2();

    const ontem = criar({ dataMovimento: '2026-09-17' });
    const hojeMesmo = criar({ dataMovimento: '2026-09-18' });
    const amanha = { ...criar(), dataMovimento: '2026-09-19' };

    assert.equal(avaliarRestauracaoMovimento(null, ontem, pedidoAtivo, restauracao).gravar, true, 'data passada');
    assert.equal(avaliarRestauracaoMovimento(null, hojeMesmo, pedidoAtivo, restauracao).gravar, true, 'data de hoje');

    const futuro = avaliarRestauracaoMovimento(null, amanha, pedidoAtivo, restauracao);
    assert.equal(futuro.gravar, false, 'data futura');
    assert.equal(futuro.motivo, 'movimento-invalido:dataMovimento-futura');
});

test('ignorar o cancelamento do pai não significa ignorar a validade temporal do movimento', () => {
    // O pai cancelado deixa de bloquear a restauração do histórico, mas um movimento com data futura
    // continua impossível: ser backup não transforma o que não aconteceu em fato ocorrido.
    const restauracao = { hoje: '2026-09-18' };
    const pedidoCancelado = cancelarPedido(criarPedidoV2(), CANCELAMENTO_PEDIDO);

    assert.equal(
        avaliarRestauracaoMovimento(null, criar({ dataMovimento: '2026-09-17' }), pedidoCancelado, restauracao).gravar,
        true,
        'recebimento histórico sob pai cancelado continua restaurável'
    );

    const futuro = avaliarRestauracaoMovimento(null, { ...criar(), dataMovimento: '2099-01-01' }, pedidoCancelado, restauracao);
    assert.equal(futuro.gravar, false, 'movimento futuro sob pai cancelado');
    assert.equal(futuro.motivo, 'movimento-invalido:dataMovimento-futura');
});

test('backup recusa movimento estruturalmente inválido', () => {
    const corrompido = { ...criar(), valorCentavos: -1 };
    const avaliacao = avaliarRestauracaoMovimento(null, corrompido, criarPedidoV2());
    assert.equal(avaliacao.gravar, false);
    assert.match(avaliacao.motivo, /^movimento-invalido:/);
});

// --- validarCadeiaDeAuditoria(): trilha completa v1..vN, usada pelo backup e pela futura restauração ---

function construirCadeiaCompleta() {
    const v1 = criar();
    const eventoV1 = criarEventoAuditoria('criacao', null, v1, { registradoEm: v1.criadoEm, registradoPor: 'usuario-teste' });

    const v2 = corrigirMovimento(
        v1, { valorCentavos: 45000, atualizadoEm: '2026-09-19T09:00:00.000Z', atualizadoPor: 'usuario-teste' }, { hoje: HOJE }
    );
    const eventoV2 = criarEventoAuditoria('correcao', v1, v2, { registradoEm: v2.atualizadoEm, registradoPor: 'usuario-teste' });

    const v3 = cancelarMovimento(v2, {
        motivo: 'Lançado em duplicidade', canceladoEm: '2026-09-20T10:00:00.000Z', canceladoPor: 'usuario-teste'
    });
    const eventoV3 = criarEventoAuditoria('cancelamento', v2, v3, {
        registradoEm: v3.canceladoEm, registradoPor: 'usuario-teste', motivo: v3.motivoCancelamento
    });

    const eventos = [
        { eventoId: 'v1', dados: eventoV1 },
        { eventoId: 'v2', dados: eventoV2 },
        { eventoId: 'v3', dados: eventoV3 }
    ];
    return { v1, v2, v3, eventos };
}

test('cadeia íntegra v1..v3 (criação, correção, cancelamento) é válida', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const resultado = validarCadeiaDeAuditoria(v3, eventos);
    assert.equal(resultado.valido, true, JSON.stringify(resultado));
    assert.deepEqual(resultado.erros, []);
});

test('movimento ativo na versão 1 (só criação) é uma cadeia válida', () => {
    const v1 = criar();
    const evento = criarEventoAuditoria('criacao', null, v1, { registradoEm: v1.criadoEm, registradoPor: 'usuario-teste' });
    const resultado = validarCadeiaDeAuditoria(v1, [{ eventoId: 'v1', dados: evento }]);
    assert.equal(resultado.valido, true, JSON.stringify(resultado));
});

test('movimento ativo em versão > 1 precisa terminar em correção, não em criação', () => {
    const { v2, eventos } = construirCadeiaCompleta();
    // v2 é ativo (a cadeia completa cancela depois, em v3); aqui testamos só até v2.
    const resultado = validarCadeiaDeAuditoria(v2, eventos.slice(0, 2));
    assert.equal(resultado.valido, true, JSON.stringify(resultado));
});

test('cadeia truncada (falta um evento do meio) é recusada', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const truncada = [eventos[0], eventos[2]]; // falta v2
    const resultado = validarCadeiaDeAuditoria(v3, truncada);
    assert.equal(resultado.valido, false);
    assert.ok(resultado.erros.some(erro => erro.includes('lacuna') || erro.includes('incompleta')), JSON.stringify(resultado));
});

test('evento faltante no final (cadeia incompleta para a versão do movimento) é recusado', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const semUltimo = eventos.slice(0, 2); // só v1 e v2, mas o movimento está na versão 3
    const resultado = validarCadeiaDeAuditoria(v3, semUltimo);
    assert.equal(resultado.valido, false);
    assert.ok(resultado.erros.some(erro => erro.includes('incompleta')), JSON.stringify(resultado));
});

test('evento duplicado (duas entradas para a mesma versão) é recusado', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    // Mesmo eventoId "v2" (formato correto), só que repetido: é a duplicata que importa aqui.
    const duplicada = [...eventos, { eventoId: 'v2', dados: eventos[1].dados }];
    const resultado = validarCadeiaDeAuditoria(v3, duplicada);
    assert.equal(resultado.valido, false);
    assert.ok(resultado.erros.some(erro => erro.includes('duplicado')), JSON.stringify(resultado));
});

test('estado final divergente do último evento é recusado', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const movimentoAdulterado = { ...v3, valorCentavos: 999999 };
    const resultado = validarCadeiaDeAuditoria(movimentoAdulterado, eventos);
    assert.equal(resultado.valido, false);
    assert.ok(resultado.erros.includes('ultimo-estadoNovo-diverge-do-movimento-atual'), JSON.stringify(resultado));
});

test('eventoId que não corresponde a "v" + versaoNova é recusado', () => {
    const { v1 } = construirCadeiaCompleta();
    const evento = criarEventoAuditoria('criacao', null, v1, { registradoEm: v1.criadoEm, registradoPor: 'usuario-teste' });
    const resultado = validarCadeiaDeAuditoria(v1, [{ eventoId: 'evento-1', dados: evento }]);
    assert.equal(resultado.valido, false);
    assert.ok(resultado.erros.some(erro => erro.includes('nao-corresponde-a-versaoNova')), JSON.stringify(resultado));
});

test('v1 com versaoAnterior ou estadoAnterior preenchidos é recusado', () => {
    const { v1 } = construirCadeiaCompleta();
    const eventoAdulterado = { ...criarEventoAuditoria('criacao', null, v1, { registradoEm: v1.criadoEm, registradoPor: 'u' }), versaoAnterior: 0 };
    const resultado = validarCadeiaDeAuditoria(v1, [{ eventoId: 'v1', dados: eventoAdulterado }]);
    assert.equal(resultado.valido, false);
    assert.ok(resultado.erros.includes('v1-versaoAnterior-nao-nula'), JSON.stringify(resultado));
});

test('elo quebrado: estadoAnterior de v2 não bate com estadoNovo de v1 é recusado', () => {
    const { v1, v2, eventos } = construirCadeiaCompleta();
    const eventoV2Adulterado = { ...eventos[1].dados, estadoAnterior: { ...eventos[1].dados.estadoAnterior, valorCentavos: 1 } };
    const resultado = validarCadeiaDeAuditoria(v2, [eventos[0], { eventoId: 'v2', dados: eventoV2Adulterado }]);
    assert.equal(resultado.valido, false);
    assert.ok(resultado.erros.some(erro => erro.includes('nao-bate-com-v1')), JSON.stringify(resultado));
});

test('cadeia vazia ou movimento ausente são recusados', () => {
    assert.equal(validarCadeiaDeAuditoria(null, []).valido, false);
    assert.equal(validarCadeiaDeAuditoria(criar(), []).valido, false);
    assert.equal(validarCadeiaDeAuditoria(criar(), null).valido, false);
});

// --- Round-trip estrutural puro do backup (sem Firestore): serializa, reparseia e revalida ------

test('round-trip JSON puro preserva IDs, versões, autores, datas, estados e a cadeia de auditoria', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const backup = {
        versaoBackup: 2,
        pagamentos: [{ orcamentoId: 'ORC-90', pagamentoId: 'pag-teste', movimento: v3, auditoria: eventos }]
    };

    const reidratado = JSON.parse(JSON.stringify(backup));
    const registro = reidratado.pagamentos[0];

    assert.deepEqual(registro.movimento, v3, 'o movimento sobrevive ao round-trip JSON sem perder nem ganhar campos');
    assert.deepEqual(registro.auditoria, eventos, 'a auditoria completa sobrevive ao round-trip JSON');
    assert.equal(registro.orcamentoId, 'ORC-90');
    assert.equal(registro.pagamentoId, 'pag-teste');

    const validacao = validarCadeiaDeAuditoria(registro.movimento, registro.auditoria);
    assert.equal(validacao.valido, true, JSON.stringify(validacao));

    // Nenhum Timestamp do Firestore, nenhum objeto complexo: tudo string/number/null/boolean.
    const semTimestamp = valor => {
        if (valor === null || typeof valor !== 'object') return true;
        if (Array.isArray(valor)) return valor.every(semTimestamp);
        if (typeof valor.toDate === 'function' || 'seconds' in valor) return false;
        return Object.values(valor).every(semTimestamp);
    };
    assert.ok(semTimestamp(backup), 'o backup não depende de Timestamp do Firestore');
});

// --- Contrato da camada agregadora/UI (Contas a Receber e listener do pedido) --------------------
// Esta camada não é domínio puro: vive em apps.js e só pode ser inspecionada pela fonte. O E2E prova o
// comportamento; estes testes travam as decisões que um refactor silencioso poderia desfazer.

// Comentários explicam por que uma escolha NÃO foi feita e citam o helper rejeitado: as asserções de
// ausência precisam olhar só o código executável.
function semComentarios(trecho) {
    return trecho.split(/\r?\n/).filter(linha => !linha.trim().startsWith('//')).join('\n');
}

function trechoDaFuncao(fonte, assinatura, assinaturaSeguinte) {
    const inicio = fonte.indexOf(assinatura);
    assert.ok(inicio >= 0, `função ${assinatura} existe em apps.js`);
    const fim = fonte.indexOf(assinaturaSeguinte, inicio + assinatura.length);
    assert.ok(fim > inicio, `função ${assinaturaSeguinte} vem depois de ${assinatura}`);
    return fonte.slice(inicio, fim);
}

test('Contas a Receber: participação só por pedidoParticipaFinanceiro, e falha de leitura derruba o conjunto', () => {
    const fonteApps = readFileSync(new URL('../apps.js', import.meta.url), 'utf8');
    const trechoCarregar = trechoDaFuncao(fonteApps, 'async function carregarContasAReceber()', 'function inicializarSelectInteligente');

    // Fonte de participação: o portão oficial, que já recusa pedido cancelado, v1 e snapshot inválido.
    assert.match(
        trechoCarregar,
        /Object\.values\(orcamentosSalvos\)\.filter\(pedidoParticipaFinanceiro\)/,
        'a lista global usa pedidoParticipaFinanceiro como único critério de participação'
    );
    assert.ok(
        !semComentarios(trechoCarregar).includes('pedidoTemSnapshotV2Valido'),
        'pedidoTemSnapshotV2Valido NÃO decide participação no Contas a Receber ativo: ele aceita de propósito '
        + 'pedido cancelado depois, para histórico e reembolso'
    );

    // Fail-closed na leitura: Promise.all rejeita o conjunto; allSettled com soma parcial é proibido.
    assert.match(trechoCarregar, /await Promise\.all\(/, 'a carga usa Promise.all, que rejeita se qualquer leitura falhar');
    assert.ok(!semComentarios(trechoCarregar).includes('allSettled'), 'Promise.allSettled seguido de soma parcial é proibido aqui');
    assert.match(trechoCarregar, /contasAReceberComFalha = true/, 'a falha marca a seção como sem visão válida');
    assert.match(trechoCarregar, /contasAReceberCarregadas = \[\]/, 'a falha descarta o que foi lido, em vez de deixar visão parcial acessível');
    assert.match(
        trechoCarregar,
        /Não foi possível carregar todas as informações de Contas a Receber\. Tente novamente\./,
        'a interface informa que a carga não foi completa'
    );

    // O render também precisa respeitar o estado de falha: trocar o filtro não pode repintar a lista.
    const trechoRender = trechoDaFuncao(fonteApps, 'function renderizarContasAReceber()', 'async function carregarContasAReceber()');
    const indiceGuarda = trechoRender.indexOf('if (contasAReceberComFalha)');
    const indiceFiltro = trechoRender.indexOf('contasReceberFiltroSituacao');
    assert.ok(indiceGuarda >= 0, 'renderizarContasAReceber tem guarda de falha');
    assert.ok(indiceGuarda < indiceFiltro, 'a guarda de falha vem antes de qualquer filtragem/pintura');

    // Nada de recalcular dinheiro nesta camada: todos os valores saem de calcularSituacaoFinanceira.
    assert.match(trechoCarregar, /calcularSituacaoFinanceira\(orcamento, movimentos\)/, 'a situação vem do domínio');
    const trechoLinha = trechoDaFuncao(fonteApps, 'function criarLinhaContasAReceber(', 'function renderizarContasAReceber()');
    for (const proibido of ['valorTotal', 'percentualComissao', 'valoresInstalacao', 'converterValorParaCentavos', 'obterValorReceberCentavos']) {
        assert.ok(
            !semComentarios(trechoLinha).includes(proibido),
            `a linha de Contas a Receber não recalcula ${proibido}: recebível, comissão, instalação e saldo vêm da situação`
        );
    }
    for (const campo of ['situacao.valorReceberCentavos', 'situacao.recebidoCentavos', 'situacao.reembolsadoCentavos', 'situacao.saldoCentavos']) {
        assert.ok(trechoLinha.includes(campo), `a linha exibe ${campo} calculado pelo domínio`);
    }
});

test('listener financeiro: uma assinatura por pedido observado, com guarda contra callback atrasado', () => {
    const fonteApps = readFileSync(new URL('../apps.js', import.meta.url), 'utf8');
    const trechoListener = trechoDaFuncao(fonteApps, 'function atualizarListenerFinanceiroDoPedido()', 'function criarLinhaMovimento(');

    // Sem churn: mesmo pedido/elegibilidade => só repinta, sem passar por unsubscribe/onSnapshot.
    const indiceGuardaIdentidade = trechoListener.indexOf('if (orcamentoIdDoListenerFinanceiro === idAlvo)');
    const indiceUnsubscribe = trechoListener.indexOf('unsubscribeMovimentosFinanceiros();');
    const indiceOnSnapshot = trechoListener.indexOf('onSnapshot(');
    assert.ok(indiceGuardaIdentidade >= 0, 'a identidade do pedido observado é conferida');
    assert.ok(indiceGuardaIdentidade < indiceUnsubscribe, 'a guarda de identidade vem antes de desligar o listener');
    assert.ok(indiceGuardaIdentidade < indiceOnSnapshot, 'a guarda de identidade vem antes de assinar de novo');
    assert.ok(
        !semComentarios(trechoListener).includes('atualizarInterfacePedido()'),
        'o listener não chama atualizarInterfacePedido(), que o chamaria de volta e criaria churn'
    );

    // Callback atrasado: geração + pedido esperado conferidos ANTES de escrever estado ou pintar.
    assert.match(trechoListener, /\+\+geracaoListenerFinanceiro/, 'cada assinatura recebe uma geração própria');
    assert.match(
        trechoListener,
        /geracaoDestaAssinatura === geracaoListenerFinanceiro\s*\r?\n?\s*&& orcamentoIdDoListenerFinanceiro === idAlvo/,
        'a guarda confere geração e pedido esperado'
    );
    const trechoCallbacks = trechoListener.slice(indiceOnSnapshot);
    const indicePrimeiraGuarda = trechoCallbacks.indexOf('if (!ehCallbackAtual()) return;');
    const indicePrimeiraEscrita = trechoCallbacks.indexOf('movimentosDoOrcamentoAtual =');
    assert.ok(indicePrimeiraGuarda >= 0, 'o callback de dados começa descartando callback fora de geração');
    assert.ok(indicePrimeiraGuarda < indicePrimeiraEscrita, 'a guarda vem antes de escrever movimentosDoOrcamentoAtual');
    assert.equal(
        trechoCallbacks.split('if (!ehCallbackAtual()) return;').length - 1,
        2,
        'os dois callbacks (dados e erro) são protegidos, não só o de dados'
    );

    // Logout precisa invalidar a geração, além de desligar o listener.
    const trechoDetach = trechoDaFuncao(fonteApps, 'function detachAllListeners()', '// --- 6. PONTO DE ENTRADA');
    assert.match(trechoDetach, /geracaoListenerFinanceiro\+\+/, 'logout invalida a geração dos callbacks pendentes');
    assert.match(trechoDetach, /movimentosDoOrcamentoAtual = \[\]/, 'logout limpa os movimentos em memória');
    assert.match(trechoDetach, /contasAReceberCarregadas = \[\]/, 'logout limpa o cache de Contas a Receber');
});

// --- prepararPagamentosParaBackup(): portão real do caminho de exportação --------------------------

function registro(orcamentoId, pagamentoId, movimento, auditoria) {
    return { orcamentoId, pagamentoId, movimento, auditoria };
}

// Mapa de pais válidos, como orcamentosSalvos entrega em apps.js: um pedido v2 íntegro por id citado.
function paisDe(...ids) {
    return Object.fromEntries(ids.map(id => [id, criarPedidoV2({ id })]));
}

test('cadeia íntegra: o pagamento entra no backup, com a auditoria ordenada por versão', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    // Embaralha a ordem de chegada da auditoria para provar que a ordenação é feita aqui, não
    // presumida da ordem natural de retorno do Firestore.
    const embaralhada = [eventos[2], eventos[0], eventos[1]];
    const resultado = prepararPagamentosParaBackup([registro('ORC-90', 'pag-1', v3, embaralhada)], paisDe('ORC-90'));

    assert.equal(resultado.length, 1);
    assert.deepEqual(resultado[0].auditoria.map(e => e.eventoId), ['v1', 'v2', 'v3']);
});

test('exportação aborta (lança) quando um pagamento tem evento de auditoria faltante', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const semV2 = [eventos[0], eventos[2]];
    assert.throws(
        () => prepararPagamentosParaBackup([registro('ORC-90', 'pag-1', v3, semV2)], paisDe('ORC-90')),
        erro => erro instanceof ErroMovimento
            && erro.codigo === 'cadeia-invalida'
            && erro.message.includes('pag-1')
            && erro.message.includes('ORC-90')
            && erro.message.includes('Nenhum arquivo foi gerado')
    );
});

test('exportação aborta quando o estado final do movimento diverge do último evento', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const adulterado = { ...v3, valorCentavos: 999999 };
    assert.throws(
        () => prepararPagamentosParaBackup([registro('ORC-90', 'pag-1', adulterado, eventos)], paisDe('ORC-90')),
        ErroMovimento
    );
});

test('dois pagamentos válidos entram os dois; um cancelado e um reembolso também', () => {
    const { v3: recebimentoCorrigidoECancelado, eventos: eventosA } = construirCadeiaCompleta();
    const reembolso = criar({ tipo: TIPOS_MOVIMENTO.REEMBOLSO });
    const eventoReembolso = criarEventoAuditoria('criacao', null, reembolso, {
        registradoEm: reembolso.criadoEm, registradoPor: 'usuario-teste'
    });

    const resultado = prepararPagamentosParaBackup([
        registro('ORC-90', 'pag-cancelado', recebimentoCorrigidoECancelado, eventosA),
        registro('ORC-91', 'pag-reembolso', reembolso, [{ eventoId: 'v1', dados: eventoReembolso }])
    ], paisDe('ORC-90', 'ORC-91'));

    assert.equal(resultado.length, 2);
    assert.equal(resultado.find(r => r.pagamentoId === 'pag-cancelado').movimento.status, STATUS_MOVIMENTO.CANCELADO);
    assert.equal(resultado.find(r => r.pagamentoId === 'pag-reembolso').movimento.tipo, TIPOS_MOVIMENTO.REEMBOLSO);
});

test('ordem determinística: por orcamentoId e pagamentoId, e a auditoria por versão numérica (v10 depois de v2)', () => {
    const { v1: base } = construirCadeiaCompleta();

    // Dois registros em ordem "errada" de chegada: ORC-90/pag-2 antes de ORC-2/pag-1.
    const eventoBase = criarEventoAuditoria('criacao', null, base, { registradoEm: base.criadoEm, registradoPor: 'u' });
    const resultado = prepararPagamentosParaBackup([
        registro('ORC-90', 'pag-2', base, [{ eventoId: 'v1', dados: eventoBase }]),
        registro('ORC-2', 'pag-1', base, [{ eventoId: 'v1', dados: eventoBase }])
    ], paisDe('ORC-90', 'ORC-2'));
    assert.deepEqual(resultado.map(r => r.orcamentoId + '/' + r.pagamentoId), ['ORC-2/pag-1', 'ORC-90/pag-2']);

    // Cadeia longa (v1..v11): auditoria fora de ordem lexical não pode enganar a ordenação numérica.
    let atual = criar();
    const cadeiaLonga = [criarEventoAuditoria('criacao', null, atual, { registradoEm: atual.criadoEm, registradoPor: 'u' })];
    for (let i = 0; i < 10; i++) {
        const anterior = atual;
        atual = corrigirMovimento(anterior, { valorCentavos: anterior.valorCentavos + 100 }, { hoje: HOJE });
        cadeiaLonga.push(criarEventoAuditoria('correcao', anterior, atual, { registradoEm: atual.atualizadoEm, registradoPor: 'u' }));
    }
    const eventosEmbaralhados = [...cadeiaLonga].sort(() => Math.random() - 0.5)
        .map(dados => ({ eventoId: idDoEventoDaVersao(dados.versaoNova), dados }));
    const resultadoLongo = prepararPagamentosParaBackup([registro('ORC-1', 'pag-longo', atual, eventosEmbaralhados)], paisDe('ORC-1'));
    assert.deepEqual(
        resultadoLongo[0].auditoria.map(e => e.eventoId),
        Array.from({ length: 11 }, (_, i) => 'v' + (i + 1)),
        'v10 e v11 vêm depois de v2..v9, não antes (a ordenação é numérica, não lexical)'
    );
});

test('prepararPagamentosParaBackup recusa entrada que não é um array', () => {
    assert.throws(() => prepararPagamentosParaBackup({}, paisDe('ORC-90')), ErroMovimento);
    assert.throws(() => prepararPagamentosParaBackup('x', paisDe('ORC-90')), ErroMovimento);
    assert.throws(() => prepararPagamentosParaBackup(null, paisDe('ORC-90')), ErroMovimento);
});

test('prepararPagamentosParaBackup recusa mapa de pais ausente ou que não é mapa', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const lista = [registro('ORC-90', 'pag-1', v3, eventos)];
    for (const paisInvalidos of [undefined, null, [], 'x', 7]) {
        assert.throws(
            () => prepararPagamentosParaBackup(lista, paisInvalidos),
            erro => erro instanceof ErroMovimento && erro.codigo === 'orcamentos-do-backup-invalidos',
            'sem mapa de pais não há como certificar o pai de cada pagamento'
        );
    }
});

test('prepararPagamentosParaBackup não muta os registros de entrada', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const entrada = congelarProfundamente([registro('ORC-90', 'pag-1', v3, [eventos[2], eventos[0], eventos[1]])]);
    assert.doesNotThrow(() => prepararPagamentosParaBackup(entrada, paisDe('ORC-90')));
});

// --- Certificação do PAI financeiro no backup ----------------------------------------------------
// Semântica deliberada aqui: pedidoTemSnapshotV2Valido(), não pedidoParticipaFinanceiro(). Um pedido
// cancelado depois continua tendo histórico financeiro legítimo a exportar.

test('backup exporta pagamento de pedido v2 cancelado depois (histórico continua válido)', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const pais = { 'ORC-90': cancelarPedido(criarPedidoV2({ id: 'ORC-90' }), CANCELAMENTO_PEDIDO) };

    const resultado = prepararPagamentosParaBackup([registro('ORC-90', 'pag-1', v3, eventos)], pais);
    assert.equal(resultado.length, 1, 'cancelar o pedido não apaga o histórico financeiro do backup');
});

test('backup aborta quando o orcamentoId do pagamento não existe entre os orçamentos exportados', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    assert.throws(
        () => prepararPagamentosParaBackup([registro('ORC-404', 'pag-1', v3, eventos)], paisDe('ORC-90')),
        erro => erro instanceof ErroMovimento
            && erro.codigo === 'pai-do-pagamento-ausente'
            && erro.message.includes('ORC-404')
            && erro.message.includes('pag-1')
            && erro.message.includes('Nenhum arquivo foi gerado')
    );
});

test('backup aborta com pagamento sob pedido v1, sob orçamento em negociação ou sob snapshot v2 inválido', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const lista = [registro('ORC-90', 'pag-1', v3, eventos)];

    const snapshotInvalido = criarPedidoV2({ id: 'ORC-90' });
    snapshotInvalido.pedido.financeiro.valorComissaoCentavos += 1;

    const paisImpossiveis = {
        'pedido v1': { 'ORC-90': criarPedidoV1() },
        'orcamento em negociacao': { 'ORC-90': criarOrcamento({ id: 'ORC-90' }) },
        'snapshot v2 invalido': { 'ORC-90': snapshotInvalido },
        'pai nulo': { 'ORC-90': null }
    };

    for (const [rotulo, pais] of Object.entries(paisImpossiveis)) {
        assert.throws(
            () => prepararPagamentosParaBackup(lista, pais),
            erro => erro instanceof ErroMovimento
                && ['pai-do-pagamento-invalido', 'pai-do-pagamento-ausente'].includes(erro.codigo)
                && erro.message.includes('Nenhum arquivo foi gerado'),
            'pagamento sob ' + rotulo + ' não pode ser exportado'
        );
    }
});

// --- Identidade única do par pedido+pagamento ----------------------------------------------------

test('backup aborta quando o mesmo pedido+pagamento aparece duas vezes', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const duplicado = registro('ORC-90', 'pag-1', v3, eventos);
    assert.throws(
        () => prepararPagamentosParaBackup([duplicado, { ...duplicado }], paisDe('ORC-90')),
        erro => erro instanceof ErroMovimento
            && erro.codigo === 'pagamento-duplicado-no-backup'
            && erro.message.includes('pag-1')
            && erro.message.includes('ORC-90')
            && erro.message.includes('Nenhum arquivo foi gerado')
    );
});

test('o mesmo pagamentoId sob pedidos diferentes é permitido (ids são por subcoleção)', () => {
    const { v3, eventos } = construirCadeiaCompleta();
    const resultado = prepararPagamentosParaBackup([
        registro('ORC-90', 'pag-1', v3, eventos),
        registro('ORC-91', 'pag-1', v3, eventos)
    ], paisDe('ORC-90', 'ORC-91'));

    assert.deepEqual(resultado.map(r => r.orcamentoId + '/' + r.pagamentoId), ['ORC-90/pag-1', 'ORC-91/pag-1']);
});
