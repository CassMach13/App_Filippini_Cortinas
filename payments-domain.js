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

function estadosIguais(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return CAMPOS_ESTADO.every(campo => a[campo] === b[campo]);
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
//
// Atenção ao par de perguntas distintas: pedidoAceitaMovimento() responde "posso criar um movimento
// NOVO agora?" (e recusa recebimento em pedido cancelado); esta função responde "posso RESTAURAR este
// movimento histórico?". Liberar a restauração aqui não abre nada nas Firestore Rules: o create
// server-side continua exclusivamente versão 1, movimento novo e evento v1, até a 4B2.
export function avaliarRestauracaoMovimento(existente, candidato, orcamentoPai, { hoje = obterDataCivilAtual() } = {}) {
    // Backup nunca sobrescreve movimento existente nem cria movimento órfão: restaurar uma versão
    // antiga por cima da atual desfaria silenciosamente uma correção já feita.
    if (existente) return { gravar: false, motivo: 'movimento-ja-existe' };
    if (!orcamentoPai) return { gravar: false, motivo: 'pedido-inexistente' };
    if (orcamentoPai.pedido?.versaoSnapshot === 1) return { gravar: false, motivo: 'pedido-v1' };
    // Restaurar história NÃO é a mesma pergunta que "posso lançar agora?": por isso aqui vale o
    // snapshot financeiro do pai, e não pedidoAceitaMovimento. Um pedido que recebeu dinheiro e só
    // depois foi cancelado precisa poder ter esse recebimento restaurado — o cancelamento posterior
    // não transforma em inexistente o dinheiro que entrou antes dele.
    if (!pedidoTemSnapshotV2Valido(orcamentoPai)) return { gravar: false, motivo: 'pedido-sem-snapshot-v2-valido' };
    // A restauração aceita movimentos cancelados e versões maiores que 1: é história, não lançamento
    // novo. O que ela NÃO relaxa é a validade temporal: o relógio de referência é o `hoje` da
    // restauração, nunca a própria dataMovimento — usar a data do candidato como relógio tornaria
    // qualquer movimento futuro automaticamente "não futuro". Ser backup não transforma um movimento
    // com data futura em fato ocorrido.
    const validacao = validarMovimento(candidato, { hoje });
    if (!validacao.valido) return { gravar: false, motivo: `movimento-invalido:${validacao.erros.join(',')}` };
    return { gravar: true, motivo: null };
}

// Contrato exato do evento de auditoria gravado pela 4B1 (mesma lista de eventoDeAuditoriaValido() nas
// Rules). Campo desconhecido no formato atual do backup é recusado, não ignorado.
const CAMPOS_EVENTO_AUDITORIA = ['evento', 'versaoAnterior', 'versaoNova', 'estadoAnterior', 'estadoNovo',
    'motivo', 'registradoEm', 'registradoPor'];

function temExatamenteAsChaves(objeto, campos) {
    if (!objeto || typeof objeto !== 'object' || Array.isArray(objeto)) return false;
    const chaves = Object.keys(objeto);
    return chaves.length === campos.length && campos.every(campo => Object.prototype.hasOwnProperty.call(objeto, campo));
}

function ehTextoNaoVazio(valor) {
    return typeof valor === 'string' && valor.length > 0;
}

// Estado de negócio bem formado: exatamente os seis campos (como estadoConfere() nas Rules) e valores
// que um movimento válido poderia ter tido. Nas Rules cada estado é comparado com o próprio documento,
// que por sua vez passa por movimentoValido(); aqui o documento daquela época já não existe, então o
// próprio estado é validado. A data segue o mesmo relógio `hoje` do movimento atual.
function estadoDeNegocioValido(estado, hoje) {
    if (!temExatamenteAsChaves(estado, CAMPOS_ESTADO)) return false;
    return Object.values(TIPOS_MOVIMENTO).includes(estado.tipo)
        && ehDataMovimentoValida(estado.dataMovimento, hoje)
        && ehValorMonetarioValido(estado.valorCentavos)
        && ehFormaPagamentoValida(estado.formaPagamento)
        && typeof estado.observacao === 'string'
        && estado.observacao.length <= TAMANHO_MAXIMO_OBSERVACAO_MOVIMENTO
        && Object.values(STATUS_MOVIMENTO).includes(estado.status);
}

function camposIguaisExcetoStatus(a, b) {
    return CAMPOS_ESTADO.filter(campo => campo !== 'status').every(campo => a[campo] === b[campo]);
}

// Valida a trilha COMPLETA de um movimento (v1..vN, sem lacunas nem duplicatas), não só o documento
// isolado como validarMovimento(). Usada pelo backup (round-trip estrutural) e, no futuro, pela
// restauração financeira privilegiada (Etapa 4B2R) — nunca pela escrita operacional normal, que
// sempre grava um evento por vez e é validada pelas Firestore Rules na própria transação.
//
// Certifica o conjunto contra as invariantes que as Rules da 4B1 impõem a cada escrita, para que o
// backup nunca certifique um estado que as Rules não teriam produzido (ou que elas não conseguem
// barrar, como dataMovimento futura). O relógio `hoje` é injetável para teste determinístico.
// Relações de autoria/instante só são exigidas onde o documento atual permite prová-las: eventos
// intermediários não têm mais o atualizadoPor/Em da época, então neles basta autor e instante válidos.
export function validarCadeiaDeAuditoria(movimento, eventos, { hoje = obterDataCivilAtual() } = {}) {
    const erros = [];
    if (!movimento || typeof movimento !== 'object') return { valido: false, erros: ['movimento-ausente'] };

    // 1. O movimento atual precisa ser válido por si só: valor, forma, data não futura, status,
    // campos de cancelamento coerentes e versão. As Rules não barram data futura; o backup barra.
    const validacaoMovimento = validarMovimento(movimento, { hoje });
    if (!validacaoMovimento.valido) {
        return { valido: false, erros: validacaoMovimento.erros.map(erro => `movimento-${erro}`) };
    }
    // Movimento produzido pela 4B1 sempre nasce com o usuário autenticado como autor.
    if (!ehTextoNaoVazio(movimento.criadoPor)) return { valido: false, erros: ['movimento-criadoPor-ausente'] };

    if (!Array.isArray(eventos) || eventos.length === 0) return { valido: false, erros: ['cadeia-vazia'] };

    // 2. Cada item é { eventoId, dados }: formato exato, eventoId == "v" + versaoNova, sem duplicatas.
    const porVersao = new Map();
    for (const item of eventos) {
        const eventoId = item?.eventoId;
        const dados = item?.dados;
        if (typeof eventoId !== 'string' || !dados || typeof dados !== 'object') {
            erros.push('evento-malformado');
            continue;
        }
        if (!temExatamenteAsChaves(dados, CAMPOS_EVENTO_AUDITORIA)) {
            erros.push(`evento-${eventoId}-formato-invalido`);
            continue;
        }
        if (!Number.isSafeInteger(dados.versaoNova) || dados.versaoNova < 1) {
            erros.push(`evento-${eventoId}-versaoNova-invalida`);
            continue;
        }
        if (eventoId !== idDoEventoDaVersao(dados.versaoNova)) {
            erros.push(`evento-${eventoId}-id-nao-corresponde-a-versaoNova`);
            continue;
        }
        if (porVersao.has(dados.versaoNova)) {
            erros.push(`evento-duplicado-versao-${dados.versaoNova}`);
            continue;
        }
        if (!Object.values(EVENTOS_AUDITORIA).includes(dados.evento)) erros.push(`evento-${eventoId}-tipo-invalido`);
        if (!ehInstanteIsoUtc(dados.registradoEm)) erros.push(`evento-${eventoId}-registradoEm-invalido`);
        // Todo evento da 4B1 é gravado pelo usuário autenticado (registradoPor == auth.uid nas Rules).
        if (!ehTextoNaoVazio(dados.registradoPor)) erros.push(`evento-${eventoId}-registradoPor-invalido`);
        if (!ehTextoOuNulo(dados.motivo)) erros.push(`evento-${eventoId}-motivo-invalido`);
        if (dados.estadoAnterior !== null && !estadoDeNegocioValido(dados.estadoAnterior, hoje)) {
            erros.push(`evento-${eventoId}-estadoAnterior-malformado`);
        }
        if (!estadoDeNegocioValido(dados.estadoNovo, hoje)) erros.push(`evento-${eventoId}-estadoNovo-malformado`);
        porVersao.set(dados.versaoNova, dados);
    }
    if (erros.length > 0) return { valido: false, erros };

    const versaoFinal = movimento.versao;

    // 3. Exatamente 1..versaoFinal, contíguo, sem buraco nem sobra.
    if (porVersao.size !== versaoFinal) {
        return { valido: false, erros: [`cadeia-incompleta:esperado-${versaoFinal}-eventos-recebido-${porVersao.size}`] };
    }
    for (let v = 1; v <= versaoFinal; v++) {
        if (!porVersao.has(v)) return { valido: false, erros: [`cadeia-com-lacuna-na-versao-${v}`] };
    }

    // 4. Criação: nasce ativo, sem estado anterior nem motivo, com o autor e o instante do documento.
    const v1 = porVersao.get(1);
    if (v1.evento !== EVENTOS_AUDITORIA.CRIACAO) erros.push('v1-nao-e-criacao');
    if (v1.versaoAnterior !== null) erros.push('v1-versaoAnterior-nao-nula');
    if (v1.estadoAnterior !== null) erros.push('v1-estadoAnterior-nao-nulo');
    if (v1.estadoNovo.status !== STATUS_MOVIMENTO.ATIVO) erros.push('v1-estadoNovo-nao-nasce-ativo');
    if (v1.motivo !== null) erros.push('v1-motivo-nao-nulo');
    if (v1.registradoPor !== movimento.criadoPor) erros.push('v1-registradoPor-diverge-de-criadoPor');
    if (v1.registradoEm !== movimento.criadoEm) erros.push('v1-registradoEm-diverge-de-criadoEm');

    // 5. Encadeamento e semântica de cada transição. Cancelamento é terminal: só pode ser o último.
    for (let v = 2; v <= versaoFinal; v++) {
        const atual = porVersao.get(v);
        const anterior = porVersao.get(v - 1);
        if (atual.versaoAnterior !== v - 1) erros.push(`evento-v${v}-versaoAnterior-nao-encadeia`);
        if (atual.estadoAnterior === null || !estadosIguais(atual.estadoAnterior, anterior.estadoNovo)) {
            erros.push(`evento-v${v}-estadoAnterior-nao-bate-com-v${v - 1}`);
            continue;
        }

        const permitidos = v < versaoFinal
            ? [EVENTOS_AUDITORIA.CORRECAO]
            : [EVENTOS_AUDITORIA.CORRECAO, EVENTOS_AUDITORIA.CANCELAMENTO];
        if (!permitidos.includes(atual.evento)) {
            erros.push(v < versaoFinal
                ? `evento-v${v}-intermediario-so-pode-ser-correcao`
                : `evento-v${v}-tipo-invalido-para-nao-ser-criacao`);
            continue;
        }

        if (atual.evento === EVENTOS_AUDITORIA.CORRECAO) {
            // Correção: sem motivo, entre dois estados ativos, sem trocar o tipo (Rules da 4B1).
            if (atual.motivo !== null) erros.push(`evento-v${v}-correcao-com-motivo`);
            if (atual.estadoAnterior.status !== STATUS_MOVIMENTO.ATIVO || atual.estadoNovo.status !== STATUS_MOVIMENTO.ATIVO) {
                erros.push(`evento-v${v}-correcao-fora-de-estado-ativo`);
            }
            if (atual.estadoNovo.tipo !== atual.estadoAnterior.tipo) erros.push(`evento-v${v}-correcao-muda-tipo`);
            // Autor e instante de eventos intermediários já foram checados como válidos acima; o
            // documento atual não guarda mais o atualizadoPor/Em daquela época para comparar.
        } else {
            // Cancelamento: motivo obrigatório, ativo -> cancelado, sem mexer em valores nem datas.
            if (!ehTextoNaoVazio(atual.motivo)) erros.push(`evento-v${v}-cancelamento-sem-motivo`);
            if (atual.estadoAnterior.status !== STATUS_MOVIMENTO.ATIVO || atual.estadoNovo.status !== STATUS_MOVIMENTO.CANCELADO) {
                erros.push(`evento-v${v}-cancelamento-transicao-invalida`);
            }
            if (!camposIguaisExcetoStatus(atual.estadoAnterior, atual.estadoNovo)) erros.push(`evento-v${v}-cancelamento-altera-valores`);
        }
    }

    // 6. O último evento descreve exatamente o documento atual, com o autor e o instante dele.
    const ultimo = porVersao.get(versaoFinal);
    if (!estadosIguais(ultimo.estadoNovo, extrairEstado(movimento))) erros.push('ultimo-estadoNovo-diverge-do-movimento-atual');
    if (ultimo.registradoPor !== movimento.atualizadoPor) erros.push('ultimo-registradoPor-diverge-de-atualizadoPor');
    if (ultimo.registradoEm !== movimento.atualizadoEm) erros.push('ultimo-registradoEm-diverge-de-atualizadoEm');

    if (movimento.status === STATUS_MOVIMENTO.CANCELADO) {
        if (ultimo.evento !== EVENTOS_AUDITORIA.CANCELAMENTO) erros.push('movimento-cancelado-mas-ultimo-evento-nao-e-cancelamento');
        // Cancelar é a última atualização do documento: mesmos autor e instante nos três lugares.
        if (movimento.canceladoPor !== movimento.atualizadoPor) erros.push('movimento-canceladoPor-diverge-de-atualizadoPor');
        if (movimento.canceladoEm !== movimento.atualizadoEm) erros.push('movimento-canceladoEm-diverge-de-atualizadoEm');
        if (ultimo.registradoPor !== movimento.canceladoPor) erros.push('ultimo-registradoPor-diverge-de-canceladoPor');
        if (ultimo.registradoEm !== movimento.canceladoEm) erros.push('ultimo-registradoEm-diverge-de-canceladoEm');
        if (ultimo.motivo !== movimento.motivoCancelamento) erros.push('ultimo-motivo-diverge-de-motivoCancelamento');
    } else if (versaoFinal === 1) {
        if (ultimo.evento !== EVENTOS_AUDITORIA.CRIACAO) erros.push('movimento-ativo-v1-mas-ultimo-evento-nao-e-criacao');
    } else {
        if (ultimo.evento !== EVENTOS_AUDITORIA.CORRECAO) erros.push('movimento-ativo-versao-maior-que-1-mas-ultimo-evento-nao-e-correcao');
    }

    if (movimento.ultimoEventoId !== idDoEventoDaVersao(versaoFinal)) erros.push('movimento-ultimoEventoId-nao-bate-com-versao-final');

    return { valido: erros.length === 0, erros };
}

// Portão real do backup: certifica CADA pagamento coletado antes de devolver a lista pronta para
// serialização, em ordem determinística. Fail-closed — o primeiro registro reprovado lança e nada é
// devolvido; o chamador (exportarDados) nunca monta um arquivo parcial. São três certificações, todas
// necessárias para que o conjunto exportado seja conceitualmente associável a pais válidos por uma
// futura restauração (4B2R):
//
// 1. IDENTIDADE: orcamentoId + pagamentoId não se repete. Uma consulta normal do Firestore não produz
//    duplicata, mas este helper é puro e serve como certificador estrutural do payload, inclusive de
//    payloads montados por outro caminho.
// 2. PAI: o orcamentoId existe entre os orçamentos exportados e é pedido v2 com snapshot financeiro
//    válido. Aqui a semântica correta é pedidoTemSnapshotV2Valido() e NÃO pedidoParticipaFinanceiro():
//    um pedido cancelado depois continua tendo histórico financeiro legítimo a preservar. Pagamento
//    sob v1, sob orçamento em negociação, sob snapshot v2 inválido ou sob pai ausente é estado
//    impossível (corrupção/admin) e bloqueia a exportação.
// 3. CADEIA: a trilha de auditoria do movimento é íntegra de v1 até a versão atual.
export function prepararPagamentosParaBackup(pagamentosColetados, orcamentosPorId, { hoje = obterDataCivilAtual() } = {}) {
    if (!Array.isArray(pagamentosColetados)) {
        throw new ErroMovimento('pagamentos-coletados-invalidos', 'A lista de pagamentos coletados para o backup precisa ser um array.');
    }
    if (!orcamentosPorId || typeof orcamentosPorId !== 'object' || Array.isArray(orcamentosPorId)) {
        throw new ErroMovimento('orcamentos-do-backup-invalidos', 'Os orçamentos do backup precisam ser informados como mapa por id para certificar o pai de cada pagamento.');
    }

    const abortar = (codigo, registro, motivo) => {
        throw new ErroMovimento(
            codigo,
            `Não foi possível gerar o backup financeiro. O lançamento ${registro?.pagamentoId} do pedido `
            + `${registro?.orcamentoId} ${motivo}. Nenhum arquivo foi gerado.`
        );
    };

    const chavesVistas = new Set();
    for (const registro of pagamentosColetados) {
        // 1. Identidade única do par pedido+pagamento. O mesmo pagamentoId sob orcamentoIds diferentes
        // é legítimo (ids são gerados por subcoleção) e continua permitido.
        const chave = `${registro?.orcamentoId}/${registro?.pagamentoId}`;
        if (chavesVistas.has(chave)) {
            abortar('pagamento-duplicado-no-backup', registro, 'aparece mais de uma vez na lista coletada');
        }
        chavesVistas.add(chave);

        // 2. Pai financeiro válido dentro do próprio backup.
        const pai = orcamentosPorId[registro?.orcamentoId];
        if (!pai) {
            abortar('pai-do-pagamento-ausente', registro, 'aponta para um pedido que não existe no backup');
        }
        if (!pedidoTemSnapshotV2Valido(pai)) {
            abortar('pai-do-pagamento-invalido', registro, 'está sob um pedido que não é v2 com snapshot financeiro válido');
        }

        // 3. Movimento atual válido e cadeia de auditoria íntegra, contra as invariantes das Rules.
        const validacao = validarCadeiaDeAuditoria(registro?.movimento, registro?.auditoria, { hoje });
        if (!validacao.valido) {
            abortar('cadeia-invalida', registro, `possui histórico de auditoria inconsistente (${validacao.erros.join(', ')})`);
        }
    }

    // Ordem determinística: por orcamentoId e depois pagamentoId (numérica quando aplicável), e a
    // auditoria de cada pagamento por versaoNova numérica — nunca lexical, para que v10 não venha
    // antes de v2. Isso não substitui a validação acima; só torna o arquivo reproduzível e legível.
    const comparar = (a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
    return [...pagamentosColetados]
        .sort((a, b) => comparar(a.orcamentoId, b.orcamentoId) || comparar(a.pagamentoId, b.pagamentoId))
        .map(registro => ({
            ...registro,
            auditoria: [...registro.auditoria].sort((a, b) => a.dados.versaoNova - b.dados.versaoNova)
        }));
}
