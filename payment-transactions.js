import {
    ErroMovimento,
    EVENTOS_AUDITORIA,
    TIPOS_MOVIMENTO,
    cancelarMovimento,
    corrigirMovimento,
    criarEventoAuditoria,
    criarMovimento,
    pedidoAceitaMovimento,
    pedidoTemSnapshotV2Valido
} from './payments-domain.js';

// Escritas financeiras do pedido. Todas exigem internet: transações do Firestore falham offline em vez
// de enfileirar, e dinheiro enfileirado sincronizaria depois com data e estado errados.
//
// Cada operação grava, na mesma transação, o estado atual do movimento e o evento de auditoria. O pai
// é lido dentro da transação: se o pedido for cancelado no meio de um recebimento, a transação repete,
// enxerga o cancelamento e recusa.

const COLECAO_ORCAMENTOS = 'orcamentos';
const SUBCOLECAO_PAGAMENTOS = 'pagamentos';
const SUBCOLECAO_AUDITORIA = 'auditoria';
const CODIGOS_SEM_CONEXAO = new Set(['unavailable', 'deadline-exceeded']);

export class ErroOperacaoMovimento extends Error {
    constructor(codigo, mensagem, causa = null) {
        super(mensagem);
        this.name = 'ErroOperacaoMovimento';
        this.codigo = codigo;
        this.causa = causa;
    }
}

function traduzirErro(erro, operacao) {
    if (erro instanceof ErroOperacaoMovimento) return erro;
    if (erro instanceof ErroMovimento) return new ErroOperacaoMovimento(erro.codigo, erro.message, erro);

    const codigo = String(erro?.code || '');
    if (CODIGOS_SEM_CONEXAO.has(codigo) || /offline/i.test(String(erro?.message || ''))) {
        return new ErroOperacaoMovimento(
            'sem-conexao',
            `Sem conexão com a internet: ${operacao} requer internet. Nada foi alterado.`,
            erro
        );
    }
    if (codigo === 'permission-denied') {
        return new ErroOperacaoMovimento(
            'recusado',
            'O servidor recusou a operação. Recarregue a página para usar a versão atual do sistema e tente novamente.',
            erro
        );
    }
    if (codigo === 'aborted' || codigo === 'failed-precondition') {
        return new ErroOperacaoMovimento(
            'conflito',
            'Este lançamento foi alterado ao mesmo tempo em outro dispositivo. Revise os dados e tente novamente.',
            erro
        );
    }
    return new ErroOperacaoMovimento('desconhecido', `Não foi possível concluir: ${operacao}.`, erro);
}

function exigirAtor(uid, operacao) {
    // Toda escrita financeira normal tem autor, e as regras exigem que ele seja o usuário autenticado.
    // Falhar aqui evita que a interface descubra isso só como um permission-denied opaco do servidor.
    if (typeof uid !== 'string' || uid.trim() === '') {
        throw new ErroOperacaoMovimento(
            'sem-ator',
            `Sessão sem usuário identificado: ${operacao} exige um usuário autenticado. Nada foi alterado.`
        );
    }
}

function exigirConexao(online, operacao) {
    if (online === false) {
        throw new ErroOperacaoMovimento(
            'sem-conexao',
            `Sem conexão com a internet: ${operacao} requer internet. Conecte-se e tente novamente; nada foi alterado.`
        );
    }
}

function referenciaPagamento(firestore, orcamentoId, pagamentoId) {
    return firestore.doc(firestore.db, COLECAO_ORCAMENTOS, orcamentoId, SUBCOLECAO_PAGAMENTOS, pagamentoId);
}

function referenciaAuditoria(firestore, orcamentoId, pagamentoId, eventoId) {
    return firestore.doc(
        firestore.db, COLECAO_ORCAMENTOS, orcamentoId, SUBCOLECAO_PAGAMENTOS, pagamentoId, SUBCOLECAO_AUDITORIA, eventoId
    );
}

async function lerPedidoElegivel(transacao, firestore, orcamentoId, tipo) {
    const referencia = firestore.doc(firestore.db, COLECAO_ORCAMENTOS, orcamentoId);
    const leitura = await transacao.get(referencia);
    if (!leitura.exists()) {
        throw new ErroOperacaoMovimento('nao-encontrado', 'Este pedido não existe mais.');
    }
    const orcamento = { id: orcamentoId, ...leitura.data() };
    if (!pedidoAceitaMovimento(orcamento, tipo)) {
        throw new ErroOperacaoMovimento(
            'pedido-nao-elegivel',
            tipo === TIPOS_MOVIMENTO.RECEBIMENTO
                ? 'Só pedidos confirmados com controle financeiro ativo recebem pagamentos.'
                : 'Só pedidos com snapshot financeiro válido aceitam reembolso.'
        );
    }
    return orcamento;
}

async function lerPedidoDoMovimentoExistente(transacao, firestore, orcamentoId) {
    // Corrigir ou cancelar um lançamento que JÁ existe não é o mesmo que aceitar um lançamento novo:
    // um pedido cancelado não recebe mais, mas continua podendo ter um erro de digitação corrigido no
    // histórico. Aqui basta que o pai continue sendo um pedido v2 com snapshot íntegro.
    const referencia = firestore.doc(firestore.db, COLECAO_ORCAMENTOS, orcamentoId);
    const leitura = await transacao.get(referencia);
    if (!leitura.exists()) {
        throw new ErroOperacaoMovimento('nao-encontrado', 'Este pedido não existe mais.');
    }
    const orcamento = { id: orcamentoId, ...leitura.data() };
    if (!pedidoTemSnapshotV2Valido(orcamento)) {
        throw new ErroOperacaoMovimento('pedido-nao-elegivel', 'O pedido deste lançamento não tem snapshot financeiro válido.');
    }
    return orcamento;
}

async function lerMovimentoAtual(transacao, referencia, versaoEsperada) {
    const leitura = await transacao.get(referencia);
    if (!leitura.exists()) {
        throw new ErroOperacaoMovimento('nao-encontrado', 'Este lançamento não existe mais.');
    }
    const atual = leitura.data();
    if (versaoEsperada !== undefined && versaoEsperada !== null && atual.versao !== versaoEsperada) {
        // Cliente desatualizado: outro dispositivo já corrigiu ou cancelou este lançamento.
        throw new ErroOperacaoMovimento(
            'conflito',
            'Este lançamento foi alterado em outro dispositivo. Recarregue os dados e revise antes de tentar de novo.'
        );
    }
    return atual;
}

export async function registrarMovimentoComTransacao(firestore, {
    orcamentoId,
    pagamentoId,
    tipo,
    dataMovimento,
    valorCentavos,
    formaPagamento,
    observacao = '',
    registradoEm,
    registradoPor = null,
    hoje,
    online = true
} = {}) {
    if (!orcamentoId) throw new TypeError('O ID do pedido é obrigatório para registrar o movimento.');
    if (!pagamentoId) throw new TypeError('O ID do movimento é obrigatório para registrar o movimento.');
    const operacao = tipo === TIPOS_MOVIMENTO.REEMBOLSO ? 'registrar reembolso' : 'registrar recebimento';
    exigirAtor(registradoPor, operacao);

    // O movimento é montado e validado antes de qualquer acesso ao servidor.
    let movimento;
    try {
        movimento = criarMovimento(
            { tipo, dataMovimento, valorCentavos, formaPagamento, observacao, criadoEm: registradoEm, criadoPor: registradoPor },
            hoje ? { hoje } : {}
        );
    } catch (erro) {
        throw traduzirErro(erro, operacao);
    }
    exigirConexao(online, operacao);

    const referencia = referenciaPagamento(firestore, orcamentoId, pagamentoId);
    try {
        return await firestore.runTransaction(firestore.db, async transacao => {
            await lerPedidoElegivel(transacao, firestore, orcamentoId, tipo);
            const existente = await transacao.get(referencia);
            if (existente.exists()) {
                throw new ErroOperacaoMovimento('ja-existe', 'Este lançamento já foi registrado.');
            }

            const evento = criarEventoAuditoria(EVENTOS_AUDITORIA.CRIACAO, null, movimento, {
                registradoEm: movimento.criadoEm,
                registradoPor
            });
            transacao.set(referencia, movimento);
            transacao.set(referenciaAuditoria(firestore, orcamentoId, pagamentoId, movimento.ultimoEventoId), evento);
            return movimento;
        });
    } catch (erro) {
        throw traduzirErro(erro, operacao);
    }
}

export async function corrigirMovimentoComTransacao(firestore, {
    orcamentoId,
    pagamentoId,
    versaoEsperada,
    dataMovimento,
    valorCentavos,
    formaPagamento,
    observacao,
    corrigidoEm,
    corrigidoPor = null,
    hoje,
    online = true
} = {}) {
    if (!orcamentoId || !pagamentoId) throw new TypeError('Pedido e movimento são obrigatórios para a correção.');
    const operacao = 'corrigir lançamento';
    exigirAtor(corrigidoPor, operacao);
    exigirConexao(online, operacao);

    const referencia = referenciaPagamento(firestore, orcamentoId, pagamentoId);
    try {
        return await firestore.runTransaction(firestore.db, async transacao => {
            const atual = await lerMovimentoAtual(transacao, referencia, versaoEsperada);
            await lerPedidoDoMovimentoExistente(transacao, firestore, orcamentoId);

            const corrigido = corrigirMovimento(
                atual,
                { dataMovimento, valorCentavos, formaPagamento, observacao, atualizadoEm: corrigidoEm, atualizadoPor: corrigidoPor },
                hoje ? { hoje } : {}
            );
            const evento = criarEventoAuditoria(EVENTOS_AUDITORIA.CORRECAO, atual, corrigido, {
                registradoEm: corrigido.atualizadoEm,
                registradoPor: corrigidoPor
            });
            transacao.set(referencia, corrigido);
            transacao.set(referenciaAuditoria(firestore, orcamentoId, pagamentoId, corrigido.ultimoEventoId), evento);
            return corrigido;
        });
    } catch (erro) {
        throw traduzirErro(erro, operacao);
    }
}

export async function cancelarMovimentoComTransacao(firestore, {
    orcamentoId,
    pagamentoId,
    versaoEsperada,
    motivo,
    canceladoEm,
    canceladoPor = null,
    online = true
} = {}) {
    if (!orcamentoId || !pagamentoId) throw new TypeError('Pedido e movimento são obrigatórios para o cancelamento.');
    const operacao = 'cancelar lançamento';
    exigirAtor(canceladoPor, operacao);
    exigirConexao(online, operacao);

    const referencia = referenciaPagamento(firestore, orcamentoId, pagamentoId);
    try {
        return await firestore.runTransaction(firestore.db, async transacao => {
            const atual = await lerMovimentoAtual(transacao, referencia, versaoEsperada);
            const cancelado = cancelarMovimento(atual, { motivo, canceladoEm, canceladoPor });
            const evento = criarEventoAuditoria(EVENTOS_AUDITORIA.CANCELAMENTO, atual, cancelado, {
                registradoEm: cancelado.canceladoEm,
                registradoPor: canceladoPor,
                motivo: cancelado.motivoCancelamento
            });
            transacao.set(referencia, cancelado);
            transacao.set(referenciaAuditoria(firestore, orcamentoId, pagamentoId, cancelado.ultimoEventoId), evento);
            return cancelado;
        });
    } catch (erro) {
        throw traduzirErro(erro, operacao);
    }
}
