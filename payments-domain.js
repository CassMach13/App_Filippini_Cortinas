import { ehDataCivilValida, obterDataCivilAtual } from './date-domain.js';
import { pedidoEstaCancelado, pedidoParticipaFinanceiro } from './order-domain.js';

// Movimentos financeiros de um pedido (recebimentos e reembolsos), em centavos inteiros.
//
// Cada movimento é um documento próprio em orcamentos/{id}/pagamentos/{pagamentoId}: nunca um array
// no documento do orçamento, porque o salvamento geral regrava o documento inteiro e apagaria
// lançamentos feitos em outro dispositivo. O estado atual fica no próprio documento (com `versao`
// para concorrência otimista) e cada mudança deixa um evento imutável em .../auditoria.
//
// Correção e reembolso NÃO são a mesma coisa: corrigir significa que o dado estava errado e não move
// dinheiro; reembolsar significa que o dinheiro voltou ao cliente, e é um movimento novo, com data e
// valor próprios, que reduz o caixa.
//
// LIMITAÇÃO DE AUDITORIA, deliberada: criadoEm, atualizadoEm, canceladoEm e registradoEm são
// fornecidos pelo CLIENTE AUTENTICADO e NÃO constituem prova temporal independente do dispositivo.
// Não devem ser apresentados como tal em nenhuma tela ou relatório futuro. Foram mantidos em ISO-8601
// UTC (e não em serverTimestamp) porque o backup em JSON converteria um Timestamp do Firestore em mapa
// e a restauração seria recusada pelas regras.
// A ordenação lógica confiável da trilha é `versao`, nunca o relógio.
//
// DECISÃO ARQUITETURAL sobre reembolso, nesta fundação: um reembolso é um movimento real de saída
// associado ao PEDIDO, e a fundação NÃO afirma que ele referencia um recebimento individual. Não há
// vínculo obrigatório com um recebimento específico nem teto agregado de reembolso — exigir essa
// reconciliação mudaria o modelo de concorrência (passaria a depender do total já recebido no
// momento da escrita) e precisa ser decidido à parte, não presumido aqui.
// A data financeira oficial, essa sim, é `dataMovimento`: data civil de Brasília, informada e validada.

export const TIPOS_MOVIMENTO = Object.freeze({ RECEBIMENTO: 'recebimento', REEMBOLSO: 'reembolso' });
export const STATUS_MOVIMENTO = Object.freeze({ ATIVO: 'ativo', CANCELADO: 'cancelado' });
export const EVENTOS_AUDITORIA = Object.freeze({ CRIACAO: 'criacao', CORRECAO: 'correcao', CANCELAMENTO: 'cancelamento' });

// Lista fixa nesta geração: não há gerenciamento configurável de formas de pagamento.
export const FORMAS_PAGAMENTO = Object.freeze([
    'PIX', 'Dinheiro', 'Cartão de débito', 'Cartão de crédito', 'Transferência', 'Boleto', 'Outro'
]);

export const TAMANHO_MAXIMO_OBSERVACAO_MOVIMENTO = 500;
export const TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO_MOVIMENTO = 500;

export const SITUACOES_FINANCEIRAS = Object.freeze({
    EM_ABERTO: 'Em aberto',
    PARCIALMENTE_PAGO: 'Parcialmente pago',
    QUITADO: 'Quitado',
    EXCEDENTE: 'Excedente'
});

// ESTADO DE NEGÓCIO do movimento — NÃO é um snapshot completo do documento. São exatamente estes seis
// campos, o mínimo para reconstruir a alteração de negócio. Ficam de fora, de propósito, os campos
// técnicos (versao, ultimoEventoId, criadoEm/criadoPor, atualizadoEm/atualizadoPor) e os do
// cancelamento, que o evento preserva em campos próprios (motivo, registradoPor, registradoEm).
const CAMPOS_ESTADO = ['tipo', 'dataMovimento', 'valorCentavos', 'formaPagamento', 'observacao', 'status'];

export function idDoEventoDaVersao(versao) {
    // Um evento por versão do movimento: o id é novo a cada operação e prova, sozinho, a qual versão
    // ele pertence. A trilha nunca é percorrida para validar nada; só este evento é consultado.
    return `v${versao}`;
}

export class ErroMovimento extends Error {
    constructor(codigo, mensagem) {
        super(mensagem);
        this.name = 'ErroMovimento';
        this.codigo = codigo;
    }
}

function ehInstanteIsoUtc(valor) {
    // Mesmo formato de Date.prototype.toISOString(), igual ao contrato já usado em pedido.confirmadoEm.
    return typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(valor);
}

function ehTextoOuNulo(valor) {
    return valor === null || typeof valor === 'string';
}

function normalizarTextoObrigatorio(valor, tamanhoMaximo, codigo, rotulo) {
    const texto = typeof valor === 'string' ? valor.trim() : '';
    if (!texto) throw new ErroMovimento(codigo, `Informe ${rotulo}.`);
    if (texto.length > tamanhoMaximo) {
        throw new ErroMovimento(`${codigo}-muito-longo`, `${rotulo} deve ter no máximo ${tamanhoMaximo} caracteres.`);
    }
    return texto;
}

export function ehValorMonetarioValido(valor) {
    return Number.isSafeInteger(valor) && valor > 0;
}

export function ehFormaPagamentoValida(valor) {
    return FORMAS_PAGAMENTO.includes(valor);
}

export function ehDataMovimentoValida(dataMovimento, hoje = obterDataCivilAtual()) {
    // Data passada é permitida, inclusive anterior à confirmação do pedido: um sinal recebido durante
    // a negociação pode ser lançado depois. Data futura não: dinheiro previsto não é dinheiro movimentado.
    return ehDataCivilValida(dataMovimento) && dataMovimento <= hoje;
}

export function validarMovimento(movimento, { hoje = obterDataCivilAtual() } = {}) {
    const erros = [];
    if (!movimento || typeof movimento !== 'object') return { valido: false, erros: ['movimento-ausente'] };

    if (!Object.values(TIPOS_MOVIMENTO).includes(movimento.tipo)) erros.push('tipo-invalido');
    if (!ehDataCivilValida(movimento.dataMovimento)) erros.push('dataMovimento-invalida');
    else if (movimento.dataMovimento > hoje) erros.push('dataMovimento-futura');
    if (!ehValorMonetarioValido(movimento.valorCentavos)) erros.push('valorCentavos-invalido');
    if (!ehFormaPagamentoValida(movimento.formaPagamento)) erros.push('formaPagamento-invalida');
    if (typeof movimento.observacao !== 'string') erros.push('observacao-invalida');
    else if (movimento.observacao.length > TAMANHO_MAXIMO_OBSERVACAO_MOVIMENTO) erros.push('observacao-muito-longa');
    if (!Object.values(STATUS_MOVIMENTO).includes(movimento.status)) erros.push('status-invalido');
    if (!Number.isSafeInteger(movimento.versao) || movimento.versao < 1) erros.push('versao-invalida');
    // Aponta o evento de auditoria desta versão: sem ele as regras recusam a escrita.
    if (typeof movimento.ultimoEventoId !== 'string' || movimento.ultimoEventoId.length === 0) erros.push('ultimoEventoId-invalido');
    if (!ehInstanteIsoUtc(movimento.criadoEm)) erros.push('criadoEm-invalido');
    if (!ehTextoOuNulo(movimento.criadoPor)) erros.push('criadoPor-invalido');
    if (!ehInstanteIsoUtc(movimento.atualizadoEm)) erros.push('atualizadoEm-invalido');
    if (!ehTextoOuNulo(movimento.atualizadoPor)) erros.push('atualizadoPor-invalido');

    const cancelado = movimento.status === STATUS_MOVIMENTO.CANCELADO;
    const temCamposDeCancelamento = 'canceladoEm' in movimento || 'canceladoPor' in movimento || 'motivoCancelamento' in movimento;
    if (cancelado) {
        if (!ehInstanteIsoUtc(movimento.canceladoEm)) erros.push('canceladoEm-invalido');
        if (!ehTextoOuNulo(movimento.canceladoPor)) erros.push('canceladoPor-invalido');
        const motivo = movimento.motivoCancelamento;
        if (typeof motivo !== 'string' || motivo !== motivo.trim() || motivo.length === 0
            || motivo.length > TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO_MOVIMENTO) {
            erros.push('motivoCancelamento-invalido');
        }
    } else if (temCamposDeCancelamento) {
        erros.push('cancelamento-em-movimento-ativo');
    }

    return { valido: erros.length === 0, erros };
}

function ignorandoCancelamento(orcamento) {
    // Mesmo documento, sem o registro de cancelamento: permite reusar o portão oficial para responder
    // "este pedido teria snapshot v2 válido se não estivesse cancelado?", sem duplicar a validação.
    const { cancelamento, ...pedidoSemCancelamento } = orcamento?.pedido || {};
    return { ...orcamento, pedido: pedidoSemCancelamento };
}

export function pedidoTemSnapshotV2Valido(orcamento) {
    return pedidoParticipaFinanceiro(orcamento)
        || (pedidoEstaCancelado(orcamento) && pedidoParticipaFinanceiro(ignorandoCancelamento(orcamento)));
}

export function pedidoAceitaMovimento(orcamento, tipo) {
    // Só pedido v2 com snapshot válido movimenta dinheiro. Pedido v1 nunca: não tem snapshot
    // financeiro e portanto não tem valor devido contra o qual comparar.
    if (!Object.values(TIPOS_MOVIMENTO).includes(tipo)) return false;
    // Recebimento passa pelo portão oficial, que já recusa pedido cancelado.
    if (tipo === TIPOS_MOVIMENTO.RECEBIMENTO) return pedidoParticipaFinanceiro(orcamento);
    // Reembolso continua possível depois do cancelamento: o dinheiro entrou de verdade e pode voltar.
    return pedidoTemSnapshotV2Valido(orcamento);
}

export function obterValorReceberCentavos(orcamento) {
    // Fonte única do recebível: o snapshot congelado. A instalação é paga direto ao instalador e nunca
    // entra; a comissão continua embutida no que o cliente paga e não é abatida.
    return orcamento?.pedido?.financeiro?.valorProdutosCobradoClienteCentavos ?? 0;
}

export function criarMovimento({
    tipo, dataMovimento, valorCentavos, formaPagamento, observacao = '', criadoEm, criadoPor = null
} = {}, { hoje = obterDataCivilAtual() } = {}) {
    const instante = criadoEm || new Date().toISOString();
    const movimento = {
        tipo,
        dataMovimento,
        valorCentavos,
        formaPagamento,
        observacao: typeof observacao === 'string' ? observacao.trim() : observacao,
        status: STATUS_MOVIMENTO.ATIVO,
        versao: 1,
        ultimoEventoId: idDoEventoDaVersao(1),
        criadoEm: instante,
        criadoPor,
        atualizadoEm: instante,
        atualizadoPor: criadoPor
    };
    const validacao = validarMovimento(movimento, { hoje });
    if (!validacao.valido) {
        throw new ErroMovimento('movimento-invalido', `Movimento financeiro inválido (${validacao.erros.join(', ')}).`);
    }
    return movimento;
}

export function corrigirMovimento(atual, {
    dataMovimento, valorCentavos, formaPagamento, observacao, atualizadoEm, atualizadoPor = null
} = {}, { hoje = obterDataCivilAtual() } = {}) {
    // Correção significa que o dado registrado estava errado: muda o estado efetivo e NÃO move dinheiro.
    if (!atual || typeof atual !== 'object') throw new ErroMovimento('nao-encontrado', 'O movimento é obrigatório para a correção.');
    if (atual.status === STATUS_MOVIMENTO.CANCELADO) {
        throw new ErroMovimento('movimento-cancelado', 'Um movimento cancelado não pode ser corrigido.');
    }

    const corrigido = {
        ...atual,
        // `tipo` nunca muda: transformar recebimento em reembolso apagaria uma saída de caixa real.
        dataMovimento: dataMovimento ?? atual.dataMovimento,
        valorCentavos: valorCentavos ?? atual.valorCentavos,
        formaPagamento: formaPagamento ?? atual.formaPagamento,
        observacao: observacao === undefined ? atual.observacao : String(observacao).trim(),
        versao: atual.versao + 1,
        ultimoEventoId: idDoEventoDaVersao(atual.versao + 1),
        atualizadoEm: atualizadoEm || new Date().toISOString(),
        atualizadoPor
    };
    const validacao = validarMovimento(corrigido, { hoje });
    if (!validacao.valido) {
        throw new ErroMovimento('movimento-invalido', `Movimento financeiro inválido (${validacao.erros.join(', ')}).`);
    }
    return corrigido;
}

export function cancelarMovimento(atual, { motivo, canceladoEm, canceladoPor = null } = {}) {
    // Cancelar o lançamento também é correção: o registro não deveria existir. Não gera saída de caixa.
    if (!atual || typeof atual !== 'object') throw new ErroMovimento('nao-encontrado', 'O movimento é obrigatório para o cancelamento.');
    if (atual.status === STATUS_MOVIMENTO.CANCELADO) {
        throw new ErroMovimento('movimento-cancelado', 'Este movimento já está cancelado.');
    }
    const motivoLimpo = normalizarTextoObrigatorio(
        motivo, TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO_MOVIMENTO, 'motivo-obrigatorio', 'o motivo do cancelamento'
    );
    const instante = canceladoEm || new Date().toISOString();
    return {
        ...atual,
        status: STATUS_MOVIMENTO.CANCELADO,
        versao: atual.versao + 1,
        ultimoEventoId: idDoEventoDaVersao(atual.versao + 1),
        atualizadoEm: instante,
        atualizadoPor: canceladoPor,
        canceladoEm: instante,
        canceladoPor,
        motivoCancelamento: motivoLimpo
    };
}

function extrairEstado(movimento) {
    if (!movimento) return null;
    return CAMPOS_ESTADO.reduce((estado, campo) => {
        estado[campo] = movimento[campo];
        return estado;
    }, {});
}

export function criarEventoAuditoria(evento, anterior, novo, { registradoEm, registradoPor = null, motivo = null } = {}) {
    if (!Object.values(EVENTOS_AUDITORIA).includes(evento)) {
        throw new ErroMovimento('evento-invalido', 'Evento de auditoria desconhecido.');
    }
    return {
        evento,
        versaoAnterior: anterior ? anterior.versao : null,
        versaoNova: novo.versao,
        // A auditoria preserva a versão anterior: o relatório reflete o estado atual, mas a história fica.
        estadoAnterior: extrairEstado(anterior),
        estadoNovo: extrairEstado(novo),
        motivo,
        registradoEm: registradoEm || new Date().toISOString(),
        registradoPor
    };
}

function somarPorTipo(movimentos, tipo) {
    return (movimentos || []).reduce((soma, movimento) => (
        movimento?.status === STATUS_MOVIMENTO.ATIVO && movimento.tipo === tipo
            ? soma + movimento.valorCentavos
            : soma
    ), 0);
}

export function calcularSituacaoFinanceira(orcamento, movimentos = []) {
    // Tudo em centavos inteiros. O saldo não é truncado em zero: excedente precisa aparecer.
    const valorReceberCentavos = obterValorReceberCentavos(orcamento);
    const recebidoCentavos = somarPorTipo(movimentos, TIPOS_MOVIMENTO.RECEBIMENTO);
    const reembolsadoCentavos = somarPorTipo(movimentos, TIPOS_MOVIMENTO.REEMBOLSO);
    const recebimentosLiquidosCentavos = recebidoCentavos - reembolsadoCentavos;
    const saldoCentavos = valorReceberCentavos - recebimentosLiquidosCentavos;

    let situacao;
    if (saldoCentavos < 0) situacao = SITUACOES_FINANCEIRAS.EXCEDENTE;
    else if (saldoCentavos === 0) situacao = SITUACOES_FINANCEIRAS.QUITADO;
    // Reembolso maior que o recebido devolve o pedido ao estado de nada pago, nunca a "parcialmente".
    else if (recebimentosLiquidosCentavos <= 0) situacao = SITUACOES_FINANCEIRAS.EM_ABERTO;
    else situacao = SITUACOES_FINANCEIRAS.PARCIALMENTE_PAGO;

    return {
        valorReceberCentavos,
        recebidoCentavos,
        reembolsadoCentavos,
        recebimentosLiquidosCentavos,
        saldoCentavos,
        excedenteCentavos: Math.max(-saldoCentavos, 0),
        situacao
    };
}

// BLOQUEADOR DE DEPLOY DA ETAPA 4: nenhum pagamento pode ser liberado em produção enquanto
// exportarDados/importarDados (apps.js) não incluírem pagamentos + auditoria. O backup atual só
// enxerga `orcamentosSalvos`, e subcoleção não aparece ali: hoje um pagamento gravado em produção
// ficaria FORA do backup. Antes do primeiro write financeiro real, o backup precisa preservar
// pagamentoId, estado atual, versao, status, movimentos cancelados, reembolsos, todos os eventos de
// auditoria e os IDs desses eventos; e a restauração nunca pode sobrescrever pagamento existente.
// A função abaixo é só a regra de decisão por documento: sozinha, ela NÃO é o backup completo.
export function avaliarRestauracaoMovimento(existente, candidato, orcamentoPai) {
    // Backup nunca sobrescreve movimento existente nem cria movimento órfão: restaurar uma versão
    // antiga por cima da atual desfaria silenciosamente uma correção já feita.
    if (existente) return { gravar: false, motivo: 'movimento-ja-existe' };
    if (!orcamentoPai) return { gravar: false, motivo: 'pedido-inexistente' };
    if (orcamentoPai.pedido?.versaoSnapshot === 1) return { gravar: false, motivo: 'pedido-v1' };
    if (!pedidoAceitaMovimento(orcamentoPai, candidato?.tipo)) return { gravar: false, motivo: 'pedido-nao-elegivel' };
    // A restauração aceita movimentos cancelados e versões maiores que 1: é história, não lançamento novo.
    const validacao = validarMovimento(candidato, { hoje: candidato?.dataMovimento });
    if (!validacao.valido) return { gravar: false, motivo: `movimento-invalido:${validacao.erros.join(',')}` };
    return { gravar: true, motivo: null };
}
