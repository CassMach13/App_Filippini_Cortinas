import {
    ErroPedido,
    cancelarPedido,
    confirmarOrcamentoComoPedido,
    criarSnapshotPedido,
    normalizarMotivoCancelamento,
    valoresIguais
} from './order-domain.js';

// Operações de pedido que exigem transação no Firestore. As funções do Firestore são recebidas por
// parâmetro ({ db, doc, runTransaction }) para que concorrência e falta de conexão sejam testáveis.

const COLECAO_ORCAMENTOS = 'orcamentos';
// Transações do Firestore não funcionam offline: falham com estes códigos em vez de enfileirar.
const CODIGOS_SEM_CONEXAO = new Set(['unavailable', 'deadline-exceeded']);

export class ErroOperacaoPedido extends Error {
    constructor(codigo, mensagem, causa = null) {
        super(mensagem);
        this.name = 'ErroOperacaoPedido';
        this.codigo = codigo;
        this.causa = causa;
    }
}

function traduzirErro(erro, operacao) {
    if (erro instanceof ErroOperacaoPedido) return erro;
    if (erro instanceof ErroPedido) return new ErroOperacaoPedido(erro.codigo, erro.message, erro);

    const codigo = String(erro?.code || '');
    if (CODIGOS_SEM_CONEXAO.has(codigo) || /offline/i.test(String(erro?.message || ''))) {
        return new ErroOperacaoPedido(
            'sem-conexao',
            `Sem conexão com a internet: ${operacao} requer internet. Nada foi alterado.`,
            erro
        );
    }
    if (codigo === 'permission-denied') {
        return new ErroOperacaoPedido(
            'recusado',
            'O servidor recusou a operação. Recarregue a página para usar a versão atual do sistema e tente novamente.',
            erro
        );
    }
    if (codigo === 'aborted' || codigo === 'failed-precondition') {
        return new ErroOperacaoPedido(
            'conflito',
            'O orçamento foi alterado ao mesmo tempo em outro dispositivo. Revise os dados e tente novamente.',
            erro
        );
    }
    return new ErroOperacaoPedido('desconhecido', `Não foi possível concluir: ${operacao}.`, erro);
}

function exigirConexao(online, operacao) {
    if (online === false) {
        throw new ErroOperacaoPedido(
            'sem-conexao',
            `Sem conexão com a internet: ${operacao} requer internet. Conecte-se e tente novamente; nada foi alterado.`
        );
    }
}

async function lerOrcamentoNaTransacao(transacao, referencia) {
    const leitura = await transacao.get(referencia);
    if (!leitura.exists()) {
        throw new ErroOperacaoPedido('nao-encontrado', 'Este orçamento não existe mais.');
    }
    return leitura.data();
}

export async function confirmarPedidoComTransacao(firestore, {
    id,
    confirmadoEm,
    confirmadoPor = null,
    online = true,
    orcamentoExibido = null
} = {}) {
    if (!id) throw new TypeError('O ID do orçamento é obrigatório para confirmar o pedido.');
    const operacao = 'confirmar pedido';
    exigirConexao(online, operacao);

    const instante = confirmadoEm || new Date().toISOString();
    const referencia = firestore.doc(firestore.db, COLECAO_ORCAMENTOS, id);
    try {
        return await firestore.runTransaction(firestore.db, async transacao => {
            // Sempre a versão mais recente do servidor: um pedido já confirmado em outra aba falha aqui.
            const atual = await lerOrcamentoNaTransacao(transacao, referencia);
            const confirmado = confirmarOrcamentoComoPedido(atual, { confirmadoEm: instante, confirmadoPor });

            if (orcamentoExibido) {
                // O que é congelado precisa ser exatamente o que o usuário está vendo na tela.
                const esperado = criarSnapshotPedido(orcamentoExibido, { confirmadoEm: instante, confirmadoPor });
                if (!valoresIguais(esperado, confirmado.pedido)) {
                    throw new ErroOperacaoPedido(
                        'orcamento-desatualizado',
                        'Há alterações ainda não sincronizadas ou o orçamento mudou em outro dispositivo. Aguarde a sincronização, revise e confirme novamente.'
                    );
                }
            }

            // Somente a transição para pedido: os demais campos do documento não são regravados.
            transacao.update(referencia, {
                statusDocumento: confirmado.statusDocumento,
                pedido: confirmado.pedido,
                'infoComercial.percentualComissao': confirmado.infoComercial.percentualComissao
            });
            return confirmado;
        });
    } catch (erro) {
        throw traduzirErro(erro, operacao);
    }
}

export async function cancelarPedidoComTransacao(firestore, {
    id,
    motivo,
    canceladoEm,
    canceladoPor = null,
    online = true
} = {}) {
    if (!id) throw new TypeError('O ID do pedido é obrigatório para o cancelamento.');
    const operacao = 'cancelar pedido';
    // O motivo é validado antes de qualquer acesso ao servidor.
    let motivoLimpo;
    try {
        motivoLimpo = normalizarMotivoCancelamento(motivo);
    } catch (erro) {
        throw traduzirErro(erro, operacao);
    }
    exigirConexao(online, operacao);

    const instante = canceladoEm || new Date().toISOString();
    const referencia = firestore.doc(firestore.db, COLECAO_ORCAMENTOS, id);
    try {
        return await firestore.runTransaction(firestore.db, async transacao => {
            const atual = await lerOrcamentoNaTransacao(transacao, referencia);
            const cancelado = cancelarPedido(atual, { motivo: motivoLimpo, canceladoEm: instante, canceladoPor });
            // Só acrescenta o registro de cancelamento; itens e valores congelados não são reescritos.
            transacao.update(referencia, { 'pedido.cancelamento': cancelado.pedido.cancelamento });
            return cancelado;
        });
    } catch (erro) {
        throw traduzirErro(erro, operacao);
    }
}
