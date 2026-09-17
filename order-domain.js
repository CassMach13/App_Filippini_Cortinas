import {
    aplicarComissaoAoItem,
    calcularPercentualEmCentavos,
    calcularPrecoFinal,
    calcularPrecoTotalSemComissao,
    calcularTotaisProposta,
    converterValorParaCentavos,
    percentualComissaoEhValido
} from './pricing-domain.js';
import { converterInstanteParaDataCivil, ehDataCivilValida } from './date-domain.js';

// Formato aceito por <input type="number">; outros textos viram campo vazio.
const NUMERO_VALIDO_CAMPO_HTML = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;

// Única versão de snapshot que participa do controle financeiro. Pedidos v1 continuam válidos para a
// operação (fornecedor, instalador), mas nunca entram no financeiro nem são convertidos.
export const VERSAO_SNAPSHOT_FINANCEIRO = 2;
export const TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO = 500;

// Instante em UTC exatamente como Date.prototype.toISOString() produz.
const PADRAO_INSTANTE_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CAMPOS_PEDIDO_V2 = [
    'versaoSnapshot',
    'orcamentoId',
    'confirmadoEm',
    'confirmadoPor',
    'cliente',
    'costureira',
    'comissionado',
    'itens',
    'financeiro',
    'proposta'
];
const CAMPOS_FINANCEIRO_V2 = [
    'dataVenda',
    'descontoPercentual',
    'percentualComissao',
    'subtotalSemComissaoCentavos',
    'descontoBaseCentavos',
    'baseLiquidaCentavos',
    'valorComissaoCentavos',
    'valorProdutosCobradoClienteCentavos',
    'valorLiquidoFilippiniCentavos',
    'custoProdutosCentavos',
    'margemCentavos'
];
const CENTAVOS_NAO_NEGATIVOS_FINANCEIRO_V2 = CAMPOS_FINANCEIRO_V2
    .filter(campo => campo.endsWith('Centavos') && campo !== 'margemCentavos');
const CAMPOS_PROPOSTA_V2 = ['totalInstalacaoCentavos', 'totalPropostaClienteCentavos'];
const CAMPOS_CANCELAMENTO = ['canceladoEm', 'canceladoPor', 'motivo'];
// Campos que as regras do Firestore congelam depois da confirmação (ver firestore.rules).
const CAMPOS_CONGELADOS_PEDIDO = ['statusDocumento', 'pedido', 'itens', 'produtosAcabados', 'infoComercial', 'valoresInstalacao'];

export class ErroPedido extends Error {
    constructor(codigo, mensagem, detalhes = {}) {
        super(mensagem);
        this.name = 'ErroPedido';
        this.codigo = codigo;
        this.detalhes = detalhes;
    }
}

// `statusDocumento` é a única fonte do status comercial. Documentos sem o campo estão em negociação.
export const STATUS_DOCUMENTO = Object.freeze({
    ORCAMENTO: 'orcamento',
    PEDIDO: 'pedido',
    PERDIDO: 'perdido'
});

// Percentual sugerido ao ativar a venda com comissão na tela.
export const PERCENTUAL_COMISSAO_PADRAO = 10;
// Regra antiga: documentos com tipoCliente "arquiteto" embutiam 10% em cada item.
const PERCENTUAL_COMISSAO_LEGADO_ARQUITETO = 10;

export const FORMATO_PRECO_ITEM = Object.freeze({
    ATUAL: 'atual',
    LEGADO_SEM_COMISSAO: 'legado-sem-comissao',
    LEGADO_COM_COMISSAO: 'legado-com-comissao'
});

function numeroFinito(valor, padrao = 0) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : padrao;
}

function numeroOuNulo(valor) {
    // Diferente de Number(), campo ausente, nulo ou vazio não vira zero.
    if (valor === null || valor === undefined || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
}

export function percentualComissaoEstaGravado(orcamento) {
    return percentualComissaoEhValido(orcamento?.infoComercial?.percentualComissao);
}

export function obterPercentualComissao(orcamento) {
    // Fonte única: infoComercial.percentualComissao. Documentos antigos sem o campo (ou com valor
    // inválido) usam a regra anterior pelo tipo de cliente. Um 0 gravado prevalece sobre "arquiteto".
    const percentualGravado = orcamento?.infoComercial?.percentualComissao;
    if (percentualComissaoEhValido(percentualGravado)) return percentualGravado;
    return orcamento?.infoGerais?.tipoCliente === 'arquiteto' ? PERCENTUAL_COMISSAO_LEGADO_ARQUITETO : 0;
}

function ehObjetoSimples(valor) {
    return Boolean(valor) && typeof valor === 'object' && !Array.isArray(valor);
}

function ehInteiroSeguro(valor) {
    return Number.isSafeInteger(valor) && !Object.is(valor, -0);
}

export function instanteIsoUtcValido(valor) {
    if (typeof valor !== 'string' || !PADRAO_INSTANTE_ISO_UTC.test(valor)) return false;
    const data = new Date(valor);
    // A volta pela data descarta dias inexistentes, como 2026-02-30.
    return !Number.isNaN(data.getTime()) && data.toISOString() === valor;
}

export function valoresIguais(valorA, valorB) {
    // Comparação estrutural independente da ordem das chaves (o Firestore não preserva a ordem).
    if (Object.is(valorA, valorB)) return true;
    if (Array.isArray(valorA) || Array.isArray(valorB)) {
        return Array.isArray(valorA) && Array.isArray(valorB) && valorA.length === valorB.length
            && valorA.every((item, indice) => valoresIguais(item, valorB[indice]));
    }
    if (!ehObjetoSimples(valorA) || !ehObjetoSimples(valorB)) return false;
    const chavesA = Object.keys(valorA).filter(chave => valorA[chave] !== undefined);
    const chavesB = Object.keys(valorB).filter(chave => valorB[chave] !== undefined);
    return chavesA.length === chavesB.length
        && chavesA.every(chave => Object.hasOwn(valorB, chave) && valoresIguais(valorA[chave], valorB[chave]));
}

export function pedidoEstaConfirmado(orcamento) {
    return orcamento?.statusDocumento === 'pedido' && Boolean(orcamento?.pedido?.confirmadoEm);
}

export function pedidoEstaCancelado(orcamento) {
    // O cancelamento é um registro auditável dentro do pedido; `statusDocumento` continua "pedido".
    return pedidoEstaConfirmado(orcamento) && orcamento.pedido.cancelamento != null;
}

export function pedidoEstaAtivo(orcamento) {
    return pedidoEstaConfirmado(orcamento) && !pedidoEstaCancelado(orcamento);
}

export function orcamentoEstaPerdido(orcamento) {
    return orcamento?.statusDocumento === STATUS_DOCUMENTO.PERDIDO;
}

export function obterStatusComercial(orcamento) {
    if (pedidoEstaConfirmado(orcamento)) return STATUS_DOCUMENTO.PEDIDO;
    if (orcamentoEstaPerdido(orcamento)) return STATUS_DOCUMENTO.PERDIDO;
    return STATUS_DOCUMENTO.ORCAMENTO;
}

function alterarStatusComercial(orcamento, novoStatus, { alteradoEm, alteradoPor } = {}) {
    // Itens, valores e contatos são preservados.
    const atualizado = structuredClone(orcamento);
    atualizado.statusDocumento = novoStatus;
    atualizado.statusAlteradoEm = alteradoEm || new Date().toISOString();
    atualizado.statusAlteradoPor = alteradoPor ?? null;
    return atualizado;
}

export function marcarOrcamentoComoPerdido(orcamento, auditoria = {}) {
    if (!orcamento || typeof orcamento !== 'object') {
        throw new TypeError('O orçamento é obrigatório para alterar o status.');
    }
    const status = obterStatusComercial(orcamento);
    if (status === STATUS_DOCUMENTO.PEDIDO) {
        throw new Error('Pedidos confirmados não podem ser marcados como perdidos.');
    }
    if (status === STATUS_DOCUMENTO.PERDIDO) {
        throw new Error('Este orçamento já está marcado como perdido.');
    }
    return alterarStatusComercial(orcamento, STATUS_DOCUMENTO.PERDIDO, auditoria);
}

export function reabrirNegociacao(orcamento, auditoria = {}) {
    if (!orcamentoEstaPerdido(orcamento)) {
        throw new Error('Somente orçamentos marcados como perdidos podem ser reabertos.');
    }
    const reaberto = alterarStatusComercial(orcamento, STATUS_DOCUMENTO.ORCAMENTO, auditoria);
    // A data antiga não volta como follow-up vencido; a observação fica como contexto
    // e a nova data é informada pelo usuário.
    reaberto.infoGerais = { ...(reaberto.infoGerais || {}), proximoFollowUp: '' };
    return reaberto;
}

export function validarExclusaoOrcamento(orcamento) {
    // Retorna o motivo do bloqueio ou null. Pedidos e perdidos preservam o histórico.
    if (pedidoEstaConfirmado(orcamento)) {
        return 'Pedidos confirmados não podem ser excluídos por esta tela. Isso preserva o histórico operacional.';
    }
    if (orcamentoEstaPerdido(orcamento)) {
        return 'Orçamentos perdidos / não fechados não podem ser excluídos. Isso preserva o histórico comercial.';
    }
    return null;
}

export function criarOrcamentoDuplicado(orcamentoOriginal, { novoId, dataOrcamento } = {}) {
    if (!orcamentoOriginal || typeof orcamentoOriginal !== 'object') {
        throw new TypeError('O orçamento original é obrigatório para criar uma cópia.');
    }
    if (!novoId || !dataOrcamento) {
        throw new TypeError('O novo ID e a data do orçamento são obrigatórios.');
    }

    const novoOrcamento = structuredClone(orcamentoOriginal);
    novoOrcamento.id = novoId;
    novoOrcamento.infoGerais = {
        ...(novoOrcamento.infoGerais || {}),
        nome: `Orçamento ${novoId}`,
        dataOrcamento,
        dataInstalacao: '',
        // A criação normal deixa a validade em branco; a cópia segue a mesma regra
        // em vez de herdar uma data absoluta que pode já estar vencida.
        prazoValidade: '',
        // Contatos são copiados; o follow-up pertence à negociação original.
        proximoFollowUp: '',
        observacaoFollowUp: ''
    };
    // A cópia nasce com o percentual efetivo gravado e não depende mais do tipo de cliente antigo.
    // Os itens mantêm bases e preços atuais, sem reprecificar.
    novoOrcamento.infoComercial = {
        ...(novoOrcamento.infoComercial || {}),
        percentualComissao: obterPercentualComissao(orcamentoOriginal)
    };
    delete novoOrcamento.infoGerais.tipoCliente;
    novoOrcamento.statusDocumento = STATUS_DOCUMENTO.ORCAMENTO;
    delete novoOrcamento.pedido;
    delete novoOrcamento.pagamentos;
    delete novoOrcamento.statusAlteradoEm;
    delete novoOrcamento.statusAlteradoPor;

    return novoOrcamento;
}

function recuperarBaseDaComissaoAntiga(item, valorComissao, quantidadeCompra) {
    const base = valorComissao / quantidadeCompra / (PERCENTUAL_COMISSAO_LEGADO_ARQUITETO / 100);
    // A divisão deixa ruído de ponto flutuante que muda o arredondamento de bases terminadas em meio
    // centavo. Com o preço de compra gravado no próprio item, refaz o produto compra × markup original
    // (markup de até 6 casas); se não fechar, mantém a divisão.
    const precoCompra = numeroOuNulo(item?.precoCompraUnitario);
    if (!(precoCompra > 0)) return base;
    const baseRefeita = calcularPrecoFinal(precoCompra, Number((base / precoCompra).toFixed(6)));
    return Math.abs(baseRefeita - base) <= 1e-9 * Math.max(1, Math.abs(base)) ? baseRefeita : base;
}

export function obterPrecosBaseDoItem(item, percentualComissaoDocumento = 0) {
    // Valores sem comissão de um item, sem consultar o catálogo e sem alterar o item.
    const quantidadeCompra = calcularQuantidadeCompraDoItem(item);
    const precoUnitarioBaseGravado = numeroOuNulo(item?.precoUnitarioBase);

    if (precoUnitarioBaseGravado !== null) {
        return {
            formato: FORMATO_PRECO_ITEM.ATUAL,
            quantidadeCompra,
            precoUnitarioBase: precoUnitarioBaseGravado,
            precoTotalSemComissao: numeroOuNulo(item?.precoTotalSemComissao)
                ?? calcularPrecoTotalSemComissao(precoUnitarioBaseGravado, quantidadeCompra)
        };
    }

    // Item antigo: o preço gravado pode ou não conter os 10% da regra de arquiteto.
    const precoTotalGravado = numeroFinito(item?.precoTotal);
    const precoUnitarioGravado = numeroOuNulo(item?.precoUnitario)
        ?? (quantidadeCompra > 0 ? precoTotalGravado / quantidadeCompra : 0);
    const valorComissao = numeroOuNulo(item?.valorComissao);
    const possuiComissaoEmbutida = valorComissao !== null
        ? valorComissao > 0
        : numeroFinito(percentualComissaoDocumento) > 0;

    if (!possuiComissaoEmbutida) {
        // Cliente final antigo: o preço gravado já é o preço sem comissão.
        return {
            formato: FORMATO_PRECO_ITEM.LEGADO_SEM_COMISSAO,
            quantidadeCompra,
            precoUnitarioBase: precoUnitarioGravado,
            precoTotalSemComissao: precoTotalGravado
        };
    }

    // Arquiteto antigo: valorComissao = base × 10% × quantidade é a forma mais precisa de recuperar a base.
    const precoUnitarioBase = valorComissao !== null && quantidadeCompra > 0
        ? recuperarBaseDaComissaoAntiga(item, valorComissao, quantidadeCompra)
        : precoUnitarioGravado / (1 + (valorComissao !== null
            ? PERCENTUAL_COMISSAO_LEGADO_ARQUITETO
            : numeroFinito(percentualComissaoDocumento)) / 100);

    return {
        formato: FORMATO_PRECO_ITEM.LEGADO_COM_COMISSAO,
        quantidadeCompra,
        precoUnitarioBase,
        precoTotalSemComissao: calcularPrecoTotalSemComissao(precoUnitarioBase, quantidadeCompra)
    };
}

function calcularToleranciaResiduoDoItem(formato, quantidadeCompra) {
    // Linhas no formato atual arredondam uma única vez (até meio centavo). Itens antigos de arquiteto
    // arredondavam o unitário com comissão antes de multiplicar, o que pode somar ~1 centavo por unidade.
    if (formato !== FORMATO_PRECO_ITEM.LEGADO_COM_COMISSAO) return 1;
    return 2 + Math.ceil(2.2 * Math.abs(quantidadeCompra));
}

export function calcularIndicadoresDoItem(item, percentualComissaoDocumento = 0) {
    // Indicadores internos derivados; nada aqui é gravado no item.
    const precosBase = obterPrecosBaseDoItem(item, percentualComissaoDocumento);
    const custoTotal = numeroFinito(
        item?.custoReal,
        calcularPrecoCompraUnitarioDoItem(item) * precosBase.quantidadeCompra
    );
    const margem = precosBase.precoTotalSemComissao - custoTotal;

    return {
        ...precosBase,
        precoTotal: numeroFinito(item?.precoTotal),
        custoTotal,
        margem,
        margemPercentual: precosBase.precoTotalSemComissao > 0 ? (margem / precosBase.precoTotalSemComissao) * 100 : 0,
        toleranciaResiduoCentavos: calcularToleranciaResiduoDoItem(precosBase.formato, precosBase.quantidadeCompra)
    };
}

export function somarIndicadoresDosItens(itens, percentualComissaoDocumento = 0) {
    // Subtotais internos de um grupo (produto acabado, avulsos ou ambiente) antes do desconto.
    const soma = (Array.isArray(itens) ? itens : []).reduce((total, item) => {
        const indicadores = calcularIndicadoresDoItem(item, percentualComissaoDocumento);
        total.precoTotal += indicadores.precoTotal;
        total.precoTotalSemComissao += indicadores.precoTotalSemComissao;
        total.custoTotal += indicadores.custoTotal;
        return total;
    }, { precoTotal: 0, precoTotalSemComissao: 0, custoTotal: 0 });
    const margem = soma.precoTotalSemComissao - soma.custoTotal;

    return {
        ...soma,
        margem,
        margemPercentual: soma.precoTotalSemComissao > 0 ? (margem / soma.precoTotalSemComissao) * 100 : 0
    };
}

export function alterarPercentualComissao(orcamento, novoPercentual) {
    // Retorna uma cópia com o novo percentual e os itens recalculados a partir dos valores sem
    // comissão já gravados no orçamento. Custos, quantidades e demais dados são preservados.
    if (!orcamento || typeof orcamento !== 'object') {
        throw new TypeError('O orçamento é obrigatório para alterar a comissão.');
    }
    if (!percentualComissaoEhValido(novoPercentual)) {
        throw new RangeError('O percentual da comissão deve estar entre 0 e 100, com até duas casas decimais.');
    }
    const status = obterStatusComercial(orcamento);
    if (status === STATUS_DOCUMENTO.PEDIDO) {
        throw new Error('Pedidos confirmados não permitem alterar a comissão.');
    }
    if (status === STATUS_DOCUMENTO.PERDIDO) {
        throw new Error('Reabra a negociação antes de alterar a comissão.');
    }

    // A base dos itens antigos é recuperada com o percentual em vigor antes da alteração.
    const percentualAnterior = obterPercentualComissao(orcamento);
    const atualizado = structuredClone(orcamento);
    atualizado.infoComercial = { ...(atualizado.infoComercial || {}), percentualComissao: novoPercentual };

    const reprecificarItem = item => {
        if (!item || typeof item !== 'object') return;
        const { precoUnitarioBase, precoTotalSemComissao } = obterPrecosBaseDoItem(item, percentualAnterior);
        const { precoUnitario, precoTotal } = aplicarComissaoAoItem({ precoUnitarioBase, precoTotalSemComissao }, novoPercentual);
        item.precoUnitarioBase = precoUnitarioBase;
        item.precoTotalSemComissao = precoTotalSemComissao;
        item.precoUnitario = precoUnitario;
        item.precoTotal = precoTotal;
        // Valores derivados da regra antiga deixam de valer quando o item passa ao formato atual.
        delete item.valorComissao;
        delete item.margemLiquida;
        delete item.margemPercentual;
    };

    if (Array.isArray(atualizado.itens)) atualizado.itens.forEach(reprecificarItem);
    if (Array.isArray(atualizado.produtosAcabados)) {
        atualizado.produtosAcabados.forEach(produto => {
            if (Array.isArray(produto?.itens)) produto.itens.forEach(reprecificarItem);
        });
    }

    return atualizado;
}

export function confirmarOrcamentoComoPedido(orcamento, { confirmadoEm, confirmadoPor } = {}) {
    if (!orcamento || typeof orcamento !== 'object') {
        throw new TypeError('O orçamento é obrigatório para confirmar o pedido.');
    }
    const status = obterStatusComercial(orcamento);
    if (status === STATUS_DOCUMENTO.PEDIDO) {
        throw new ErroPedido('ja-confirmado', 'Este orçamento já foi confirmado como pedido.');
    }
    if (status === STATUS_DOCUMENTO.PERDIDO) {
        throw new ErroPedido('perdido', 'Reabra a negociação antes de transformar este orçamento em pedido.');
    }
    if (listarItensNaOrdemDaInterface(orcamento).length === 0) {
        throw new ErroPedido('sem-itens', 'Adicione pelo menos um item antes de transformar o orçamento em pedido.');
    }

    const confirmado = structuredClone(orcamento);
    if (!percentualComissaoEstaGravado(confirmado)) {
        // Documento antigo: o percentual efetivo passa a ficar registrado junto do pedido.
        confirmado.infoComercial = {
            ...(confirmado.infoComercial || {}),
            percentualComissao: obterPercentualComissao(orcamento)
        };
    }
    if (calcularTotaisOrcamento(confirmado).avisos.some(aviso => aviso.codigo === 'residuo-comissao-anormal')) {
        // Congelar preços que não fecham com a comissão distorceria o líquido da Filippini.
        throw new ErroPedido(
            'residuo-comissao-anormal',
            'Os preços dos itens não fecham com a comissão calculada. Altere o percentual da comissão para recalcular os itens ou revise-os antes de confirmar.'
        );
    }

    confirmado.statusDocumento = STATUS_DOCUMENTO.PEDIDO;
    confirmado.pedido = criarSnapshotPedido(confirmado, {
        confirmadoEm: confirmadoEm || new Date().toISOString(),
        confirmadoPor
    });
    const validacao = validarSnapshotPedidoV2(confirmado.pedido);
    if (!validacao.valido) {
        throw new ErroPedido(
            'snapshot-invalido',
            `Não foi possível congelar os valores do pedido (${validacao.erros.join(', ')}).`,
            { erros: validacao.erros }
        );
    }
    return confirmado;
}

export function normalizarMotivoCancelamento(motivo) {
    const motivoLimpo = typeof motivo === 'string' ? motivo.trim() : '';
    if (!motivoLimpo) {
        throw new ErroPedido('motivo-obrigatorio', 'Informe o motivo do cancelamento.');
    }
    if (motivoLimpo.length > TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO) {
        throw new ErroPedido(
            'motivo-muito-longo',
            `O motivo do cancelamento deve ter no máximo ${TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO} caracteres.`
        );
    }
    return motivoLimpo;
}

export function cancelarPedido(orcamento, { motivo, canceladoEm, canceladoPor } = {}) {
    // O cancelamento é definitivo e só acrescenta `pedido.cancelamento`: itens, snapshot e valores
    // congelados são preservados. Um pedido cancelado sai do controle financeiro.
    if (!orcamento || typeof orcamento !== 'object') {
        throw new TypeError('O pedido é obrigatório para o cancelamento.');
    }
    if (!pedidoEstaConfirmado(orcamento)) {
        throw new ErroPedido('nao-e-pedido', 'Somente pedidos confirmados podem ser cancelados.');
    }
    if (pedidoEstaCancelado(orcamento)) {
        throw new ErroPedido('ja-cancelado', 'Este pedido já foi cancelado. O cancelamento não pode ser desfeito nem alterado.');
    }
    const motivoLimpo = normalizarMotivoCancelamento(motivo);
    const instante = canceladoEm || new Date().toISOString();
    if (!instanteIsoUtcValido(instante)) {
        throw new ErroPedido('data-cancelamento-invalida', 'A data do cancelamento é inválida.');
    }

    const cancelado = structuredClone(orcamento);
    cancelado.pedido.cancelamento = {
        canceladoEm: instante,
        canceladoPor: canceladoPor ?? null,
        motivo: motivoLimpo
    };
    return cancelado;
}

export function calcularFinanceiroDoOrcamento(orcamento, { confirmadoEm } = {}) {
    // Blocos congelados no snapshot v2, sempre em centavos inteiros e sem consultar o catálogo.
    // As grandezas oficiais (base líquida, comissão, produtos cobrados, custo e instalação) vêm de
    // calcularTotaisOrcamento; as demais são derivadas por subtração ou soma de inteiros e fecham exatamente.
    const totais = calcularTotaisOrcamento(orcamento);
    const subtotalSemComissaoCentavos = totais.centavos.subtotalSemComissao;
    const baseLiquidaCentavos = totais.centavos.baseLiquida;
    const valorComissaoCentavos = totais.centavos.valorComissao;
    const valorProdutosCobradoClienteCentavos = totais.centavos.totalProdutos;
    const valorLiquidoFilippiniCentavos = valorProdutosCobradoClienteCentavos - valorComissaoCentavos;
    // Cada linha é convertida para centavos antes da soma: arredondar só a soma de floats mudaria o centavo.
    const custoProdutosCentavos = listarItensNaOrdemDaInterface(orcamento).reduce((soma, item) => (
        soma + converterValorParaCentavos(calcularIndicadoresDoItem(item, totais.percentualComissao).custoTotal)
    ), 0);
    const totalInstalacaoCentavos = totais.centavos.totalInstalacao;

    return {
        financeiro: {
            dataVenda: converterInstanteParaDataCivil(confirmadoEm),
            descontoPercentual: totais.descontoPercentual,
            percentualComissao: totais.percentualComissao,
            subtotalSemComissaoCentavos,
            descontoBaseCentavos: subtotalSemComissaoCentavos - baseLiquidaCentavos,
            baseLiquidaCentavos,
            valorComissaoCentavos,
            valorProdutosCobradoClienteCentavos,
            valorLiquidoFilippiniCentavos,
            custoProdutosCentavos,
            margemCentavos: valorLiquidoFilippiniCentavos - custoProdutosCentavos
        },
        // A instalação é paga direto ao instalador: fica só no total da proposta ao cliente.
        proposta: {
            totalInstalacaoCentavos,
            totalPropostaClienteCentavos: valorProdutosCobradoClienteCentavos + totalInstalacaoCentavos
        }
    };
}

function verificarCampos(objeto, obrigatorios, opcionais, contexto, erros) {
    const permitidos = new Set([...obrigatorios, ...opcionais]);
    obrigatorios.filter(campo => !Object.hasOwn(objeto, campo))
        .forEach(campo => erros.push(`${contexto}.${campo}-ausente`));
    Object.keys(objeto).filter(campo => !permitidos.has(campo))
        .forEach(campo => erros.push(`${contexto}.${campo}-desconhecido`));
}

function verificarTextos(objeto, campos, contexto, erros) {
    if (!ehObjetoSimples(objeto)) {
        erros.push(`${contexto}-invalido`);
        return;
    }
    verificarCampos(objeto, campos, [], contexto, erros);
    campos.filter(campo => typeof objeto[campo] !== 'string')
        .forEach(campo => erros.push(`${contexto}.${campo}-invalido`));
}

export function validarCancelamentoPedido(cancelamento) {
    if (!ehObjetoSimples(cancelamento)) return ['cancelamento-invalido'];
    const erros = [];
    verificarCampos(cancelamento, CAMPOS_CANCELAMENTO, [], 'cancelamento', erros);
    if (!instanteIsoUtcValido(cancelamento.canceladoEm)) erros.push('cancelamento.canceladoEm-invalido');
    if (!(cancelamento.canceladoPor === null || typeof cancelamento.canceladoPor === 'string')) {
        erros.push('cancelamento.canceladoPor-invalido');
    }
    const motivo = cancelamento.motivo;
    if (typeof motivo !== 'string' || !motivo.trim() || motivo !== motivo.trim()
        || motivo.length > TAMANHO_MAXIMO_MOTIVO_CANCELAMENTO) {
        erros.push('cancelamento.motivo-invalido');
    }
    return erros;
}

export function validarSnapshotPedidoV2(pedido) {
    // Contrato do snapshot financeiro. Nada aqui é recalculado a partir do orçamento vivo:
    // um snapshot inválido simplesmente não participa do financeiro.
    if (!ehObjetoSimples(pedido)) return { valido: false, erros: ['pedido-ausente'] };

    const erros = [];
    if (pedido.versaoSnapshot !== VERSAO_SNAPSHOT_FINANCEIRO) erros.push('versaoSnapshot-diferente-de-2');
    verificarCampos(pedido, CAMPOS_PEDIDO_V2, ['cancelamento'], 'pedido', erros);
    if (typeof pedido.orcamentoId !== 'string' || !pedido.orcamentoId) erros.push('pedido.orcamentoId-invalido');
    if (!instanteIsoUtcValido(pedido.confirmadoEm)) erros.push('pedido.confirmadoEm-invalido');
    if (!(pedido.confirmadoPor === null || typeof pedido.confirmadoPor === 'string')) erros.push('pedido.confirmadoPor-invalido');
    verificarTextos(pedido.cliente, ['nome', 'endereco'], 'cliente', erros);
    verificarTextos(pedido.costureira, ['nome', 'enderecoEntrega'], 'costureira', erros);
    verificarTextos(pedido.comissionado, ['nome', 'celular'], 'comissionado', erros);
    if (!Array.isArray(pedido.itens) || pedido.itens.length === 0) erros.push('pedido.itens-invalido');
    if (pedido.cancelamento !== undefined) erros.push(...validarCancelamentoPedido(pedido.cancelamento));

    const financeiro = pedido.financeiro;
    const proposta = pedido.proposta;
    if (!ehObjetoSimples(financeiro)) erros.push('financeiro-ausente');
    if (!ehObjetoSimples(proposta)) erros.push('proposta-ausente');
    if (!ehObjetoSimples(financeiro) || !ehObjetoSimples(proposta)) return { valido: false, erros };

    verificarCampos(financeiro, CAMPOS_FINANCEIRO_V2, [], 'financeiro', erros);
    verificarCampos(proposta, CAMPOS_PROPOSTA_V2, [], 'proposta', erros);

    if (!ehDataCivilValida(financeiro.dataVenda)) {
        erros.push('financeiro.dataVenda-invalida');
    } else if (instanteIsoUtcValido(pedido.confirmadoEm)
        && converterInstanteParaDataCivil(pedido.confirmadoEm) !== financeiro.dataVenda) {
        erros.push('financeiro.dataVenda-incoerente-com-confirmadoEm');
    }
    const desconto = financeiro.descontoPercentual;
    if (typeof desconto !== 'number' || !Number.isFinite(desconto) || desconto < 0 || desconto > 100) {
        erros.push('financeiro.descontoPercentual-invalido');
    }
    if (!percentualComissaoEhValido(financeiro.percentualComissao)) erros.push('financeiro.percentualComissao-invalido');

    let centavosValidos = true;
    const exigirInteiro = (objeto, campo, contexto, naoNegativo) => {
        const valor = objeto[campo];
        if (!ehInteiroSeguro(valor) || (naoNegativo && valor < 0)) {
            erros.push(`${contexto}.${campo}-invalido`);
            centavosValidos = false;
        }
    };
    CENTAVOS_NAO_NEGATIVOS_FINANCEIRO_V2.forEach(campo => exigirInteiro(financeiro, campo, 'financeiro', true));
    exigirInteiro(financeiro, 'margemCentavos', 'financeiro', false);
    CAMPOS_PROPOSTA_V2.forEach(campo => exigirInteiro(proposta, campo, 'proposta', true));

    if (centavosValidos) {
        if (financeiro.descontoBaseCentavos !== financeiro.subtotalSemComissaoCentavos - financeiro.baseLiquidaCentavos) {
            erros.push('relacao-desconto-base');
        }
        if (percentualComissaoEhValido(financeiro.percentualComissao)
            && financeiro.valorComissaoCentavos !== calcularPercentualEmCentavos(financeiro.baseLiquidaCentavos, financeiro.percentualComissao)) {
            erros.push('relacao-comissao');
        }
        if (financeiro.valorLiquidoFilippiniCentavos !== financeiro.valorProdutosCobradoClienteCentavos - financeiro.valorComissaoCentavos) {
            erros.push('relacao-liquido-filippini');
        }
        if (financeiro.margemCentavos !== financeiro.valorLiquidoFilippiniCentavos - financeiro.custoProdutosCentavos) {
            erros.push('relacao-margem');
        }
        if (proposta.totalPropostaClienteCentavos !== financeiro.valorProdutosCobradoClienteCentavos + proposta.totalInstalacaoCentavos) {
            erros.push('relacao-total-proposta');
        }
    }

    return { valido: erros.length === 0, erros };
}

export function pedidoParticipaFinanceiro(orcamento) {
    // Começa do zero: só pedidos confirmados já com o snapshot v2, íntegros e não cancelados.
    // Não há cálculo alternativo para v1, versões desconhecidas ou snapshots inválidos.
    if (!pedidoEstaConfirmado(orcamento)) return false;
    const pedido = orcamento.pedido;
    if (pedido.versaoSnapshot !== VERSAO_SNAPSHOT_FINANCEIRO) return false;
    if (pedidoEstaCancelado(orcamento)) return false;
    if (pedido.orcamentoId !== orcamento.id) return false;
    return validarSnapshotPedidoV2(pedido).valido;
}

export function obterValorReceberCentavos(pedido) {
    // Base da Etapa 4: o cliente paga à Filippini os produtos cobrados, que já incluem a comissão
    // embutida (repassada depois, por isso não é abatida). A instalação é paga direto ao instalador.
    if (!ehObjetoSimples(pedido) || pedido.versaoSnapshot !== VERSAO_SNAPSHOT_FINANCEIRO) return null;
    if (pedido.cancelamento != null) return null;
    if (!validarSnapshotPedidoV2(pedido).valido) return null;
    return pedido.financeiro.valorProdutosCobradoClienteCentavos;
}

function semCancelamento(pedido) {
    if (!ehObjetoSimples(pedido)) return pedido;
    const { cancelamento: _cancelamento, ...restante } = pedido;
    return restante;
}

function snapshotV1Restauravel(pedido) {
    // Pedidos v1 sempre gravaram toISOString(); só o formato mínimo operacional é exigido.
    return instanteIsoUtcValido(pedido.confirmadoEm)
        && Array.isArray(pedido.itens)
        && !Object.hasOwn(pedido, 'financeiro')
        && !Object.hasOwn(pedido, 'proposta')
        && (pedido.cancelamento === undefined || validarCancelamentoPedido(pedido.cancelamento).length === 0);
}

export function avaliarRestauracaoOrcamento(atual, doBackup) {
    // Espelha as regras do Firestore para que um backup não seja recusado inteiro: pedidos confirmados
    // não são sobrescritos, um orçamento existente não vira pedido por restauração, e só são criados
    // pedidos com snapshot v1 íntegro (histórico) ou v2 válido.
    if (!ehObjetoSimples(doBackup)) return { gravar: false, motivo: 'registro-invalido' };
    const backupEhPedido = doBackup.statusDocumento === STATUS_DOCUMENTO.PEDIDO;

    if (!atual) {
        if (!backupEhPedido) return { gravar: true };
        const pedido = doBackup.pedido;
        if (!ehObjetoSimples(pedido)) return { gravar: false, motivo: 'pedido-ausente' };
        if (pedido.versaoSnapshot === 1) {
            return snapshotV1Restauravel(pedido) ? { gravar: true } : { gravar: false, motivo: 'pedido-v1-incompleto' };
        }
        if (pedido.versaoSnapshot === VERSAO_SNAPSHOT_FINANCEIRO) {
            return validarSnapshotPedidoV2(pedido).valido && pedido.orcamentoId === doBackup.id
                ? { gravar: true }
                : { gravar: false, motivo: 'pedido-v2-invalido' };
        }
        return { gravar: false, motivo: 'pedido-versao-desconhecida' };
    }

    if (atual.statusDocumento === STATUS_DOCUMENTO.PEDIDO) {
        const congeladosPreservados = CAMPOS_CONGELADOS_PEDIDO.every(campo => {
            if (doBackup[campo] === undefined) return true;
            if (campo !== 'pedido') return valoresIguais(atual[campo], doBackup[campo]);
            return valoresIguais(semCancelamento(atual.pedido), semCancelamento(doBackup.pedido))
                && (doBackup.pedido?.cancelamento === undefined
                    || valoresIguais(atual.pedido?.cancelamento, doBackup.pedido.cancelamento));
        });
        return congeladosPreservados ? { gravar: true } : { gravar: false, motivo: 'pedido-confirmado-preservado' };
    }

    if (backupEhPedido) return { gravar: false, motivo: 'orcamento-existente-nao-vira-pedido' };
    return { gravar: true };
}

export function calcularQuantidadeCompraDoItem(item) {
    if (Number.isFinite(Number(item?.quantidadeCompra))) {
        return numeroFinito(item.quantidadeCompra);
    }

    const quantidade = numeroFinito(item?.quantidade);
    if (item?.unidadeMedida === 'MetroQuadrado') {
        return numeroFinito(item?.largura) * numeroFinito(item?.altura) * quantidade;
    }

    return quantidade;
}

export function calcularPrecoCompraUnitarioDoItem(item) {
    if (Number.isFinite(Number(item?.precoCompraUnitario))) {
        return numeroFinito(item.precoCompraUnitario);
    }

    const quantidadeCompra = calcularQuantidadeCompraDoItem(item);
    if (quantidadeCompra <= 0) return 0;
    return numeroFinito(item?.custoReal) / quantidadeCompra;
}

function copiarItemParaPedido(item, produtoAcabado = null) {
    const quantidadeCompra = calcularQuantidadeCompraDoItem(item);
    const precoCompraUnitario = calcularPrecoCompraUnitarioDoItem(item);

    return {
        id: item?.id || '',
        produtoAcabadoId: produtoAcabado?.id || null,
        produtoAcabadoNome: produtoAcabado?.nome || null,
        ambiente: item?.ambiente || produtoAcabado?.ambiente || 'Não informado',
        fornecedor: item?.fornecedor || 'Fornecedor Não Informado',
        codigo: item?.codigo || '',
        descricao: item?.descricao || '',
        cor: item?.cor || '-',
        unidadeMedida: item?.unidadeMedida || 'Unidade',
        quantidade: numeroFinito(item?.quantidade),
        largura: item?.largura ?? null,
        altura: item?.altura ?? null,
        quantidadeCompra,
        precoCompraUnitario,
        custoTotal: numeroFinito(item?.custoReal, precoCompraUnitario * quantidadeCompra),
        precoVendaUnitario: numeroFinito(item?.precoUnitario),
        precoVendaTotal: numeroFinito(item?.precoTotal),
        observacoes: item?.observacoes || ''
    };
}

export function obterItensAtuaisDoOrcamento(orcamento) {
    if (!orcamento) return [];

    const itens = [];
    for (const produto of orcamento.produtosAcabados || []) {
        for (const item of produto.itens || []) {
            itens.push(copiarItemParaPedido(item, produto));
        }
    }

    for (const item of orcamento.itens || []) {
        itens.push(copiarItemParaPedido(item));
    }

    return itens;
}

export function obterItensDoPedido(orcamento) {
    if (pedidoEstaConfirmado(orcamento) && Array.isArray(orcamento.pedido.itens)) {
        return structuredClone(orcamento.pedido.itens);
    }
    return obterItensAtuaisDoOrcamento(orcamento);
}

export function criarSnapshotPedido(orcamento, { confirmadoEm, confirmadoPor } = {}) {
    // Snapshot v2: `itens` mantém o formato operacional do v1 (fornecedor e instalador) e os blocos
    // `financeiro` e `proposta` congelam os valores oficiais em centavos no instante da confirmação.
    const dataConfirmacao = confirmadoEm || new Date().toISOString();
    const infoGerais = orcamento?.infoGerais || {};
    const { financeiro, proposta } = calcularFinanceiroDoOrcamento(orcamento, { confirmadoEm: dataConfirmacao });

    return {
        versaoSnapshot: VERSAO_SNAPSHOT_FINANCEIRO,
        orcamentoId: orcamento?.id || '',
        confirmadoEm: dataConfirmacao,
        confirmadoPor: confirmadoPor || null,
        cliente: {
            nome: String(infoGerais.nomeCliente || ''),
            endereco: String(infoGerais.enderecoCliente || '')
        },
        costureira: {
            nome: String(infoGerais.nomeCostureira || ''),
            enderecoEntrega: String(infoGerais.enderecoCostureira || '')
        },
        // Quem recebe a comissão, como estava no momento da venda.
        comissionado: {
            nome: String(infoGerais.nomeComissionado || ''),
            celular: String(infoGerais.celularComissionado || '')
        },
        itens: obterItensAtuaisDoOrcamento(orcamento),
        financeiro,
        proposta
    };
}

export function agruparItensPorFornecedor(itens) {
    const grupos = {};

    for (const item of itens || []) {
        const fornecedor = item.fornecedor || 'Fornecedor Não Informado';
        const chave = [
            item.codigo || '',
            item.descricao || '',
            item.unidadeMedida || '',
            numeroFinito(item.precoCompraUnitario).toFixed(4)
        ].join('|');

        if (!grupos[fornecedor]) {
            grupos[fornecedor] = { itens: {}, totalCusto: 0 };
        }

        if (!grupos[fornecedor].itens[chave]) {
            grupos[fornecedor].itens[chave] = {
                fornecedor,
                codigo: item.codigo || '',
                descricao: item.descricao || '',
                unidadeMedida: item.unidadeMedida || 'Unidade',
                quantidadeCompra: 0,
                precoCompraUnitario: numeroFinito(item.precoCompraUnitario),
                custoTotal: 0
            };
        }

        const itemAgrupado = grupos[fornecedor].itens[chave];
        itemAgrupado.quantidadeCompra += numeroFinito(item.quantidadeCompra);
        itemAgrupado.custoTotal = itemAgrupado.quantidadeCompra * itemAgrupado.precoCompraUnitario;
    }

    for (const grupo of Object.values(grupos)) {
        grupo.totalCusto = Object.values(grupo.itens)
            .reduce((total, item) => total + numeroFinito(item.custoTotal), 0);
    }

    return grupos;
}

function listarItensNaOrdemDaInterface(orcamento) {
    // A interface soma primeiro os itens avulsos e depois os dos produtos acabados.
    // Somas em ponto flutuante dependem da ordem, por isso a mesma sequência é mantida.
    const itensAvulsos = Array.isArray(orcamento?.itens) ? orcamento.itens : [];
    const produtosAcabados = Array.isArray(orcamento?.produtosAcabados) ? orcamento.produtosAcabados : [];

    return [
        ...itensAvulsos,
        ...produtosAcabados.flatMap(produto => (Array.isArray(produto?.itens) ? produto.itens : []))
    ];
}

function somarCampo(itens, campo) {
    return itens.reduce((soma, item) => soma + (Number(item?.[campo]) || 0), 0);
}

function somarValoresInstalacao(valoresInstalacao) {
    if (!valoresInstalacao || typeof valoresInstalacao !== 'object') return 0;
    return Object.values(valoresInstalacao)
        .reduce((soma, valor) => soma + (parseFloat(valor) || 0), 0);
}

function lerDescontoPercentual(infoComercial) {
    // Reproduz o caminho da tela: o valor salvo vai para o campo numérico da proposta
    // e é lido com parseFloat, limitado entre 0% e 100%.
    const valorDoCampo = String(infoComercial?.descontoGlobal || 0);
    const desconto = NUMERO_VALIDO_CAMPO_HTML.test(valorDoCampo) ? parseFloat(valorDoCampo) : 0;
    return Math.min(100, Math.max(0, desconto || 0));
}

function converterTotaisParaCentavos(totais) {
    return {
        subtotalProdutos: converterValorParaCentavos(totais.subtotalProdutos),
        descontoValor: converterValorParaCentavos(totais.descontoValor),
        totalProdutos: converterValorParaCentavos(totais.totalProdutos),
        totalInstalacao: converterValorParaCentavos(totais.totalInstalacao),
        totalGeral: converterValorParaCentavos(totais.totalGeral)
    };
}

export function calcularTotaisOrcamento(orcamento) {
    // Fonte oficial dos totais: calcula a partir do documento persistido, sem ler campos da tela
    // nem o cache `orcamento.totais`. Ordem: base sem comissão → desconto → base líquida → comissão
    // → produtos cobrados → líquido Filippini; a instalação fica fora e só entra no total da proposta.
    const itens = listarItensNaOrdemDaInterface(orcamento);
    const percentualComissao = obterPercentualComissao(orcamento);
    const indicadores = itens.map(item => calcularIndicadoresDoItem(item, percentualComissao));
    const descontoPercentual = lerDescontoPercentual(orcamento?.infoComercial);

    // Valores visíveis ao cliente, com a comissão embutida nas linhas. O desconto exibido incide
    // sobre este subtotal, o que equivale a descontar a base e somar a comissão depois.
    const subtotalProdutos = somarCampo(itens, 'precoTotal');
    const totaisProposta = calcularTotaisProposta({
        subtotalProdutos,
        margemProdutos: 0,
        totalInstalacao: somarValoresInstalacao(orcamento?.valoresInstalacao),
        descontoPercentual
    });

    // Base da Filippini, sem comissão, com o mesmo desconto.
    const subtotalSemComissao = indicadores.reduce((soma, item) => soma + item.precoTotalSemComissao, 0);
    const { descontoValor: descontoBase, totalProdutos: baseLiquida } = calcularTotaisProposta({
        subtotalProdutos: subtotalSemComissao,
        margemProdutos: 0,
        totalInstalacao: 0,
        descontoPercentual
    });

    // Comissão oficial em centavos sobre a base líquida (nunca a soma de comissões por item).
    // O resíduo de arredondamento entre linhas e comissão fica com a Filippini.
    const baseLiquidaCentavos = converterValorParaCentavos(baseLiquida);
    const comissaoCentavos = calcularPercentualEmCentavos(baseLiquidaCentavos, percentualComissao);
    const totalProdutosCentavos = converterValorParaCentavos(totaisProposta.totalProdutos);
    const liquidoFilippiniCentavos = totalProdutosCentavos - comissaoCentavos;
    // Total da proposta ao cliente fechado em centavos: produtos cobrados + instalação exibidos.
    // Somar os floats e arredondar depois diferia 1 centavo em cerca de 0,5% das propostas.
    const totalPropostaClienteCentavos = totalProdutosCentavos + converterValorParaCentavos(totaisProposta.totalInstalacao);
    const residuoCentavos = liquidoFilippiniCentavos - baseLiquidaCentavos;
    const liquidoFilippini = liquidoFilippiniCentavos / 100;

    // Margem interna: a comissão é valor de passagem e não entra como receita da Filippini.
    const custoTotal = indicadores.reduce((soma, item) => soma + item.custoTotal, 0);
    const margemProdutos = subtotalSemComissao - custoTotal;
    const margemComDesconto = liquidoFilippini - custoTotal;

    const toleranciaResiduoCentavos = indicadores
        .reduce((soma, item) => soma + item.toleranciaResiduoCentavos, 2);
    const avisos = [];
    const percentualGravado = orcamento?.infoComercial?.percentualComissao;
    if (percentualGravado !== undefined && !percentualComissaoEhValido(percentualGravado)) {
        avisos.push({ codigo: 'percentual-comissao-invalido', percentualUsado: percentualComissao });
    }
    if (itens.length > 0 && Math.abs(residuoCentavos) > toleranciaResiduoCentavos) {
        avisos.push({ codigo: 'residuo-comissao-anormal', residuo: residuoCentavos / 100 });
    }

    return {
        quantidadeItens: itens.length,
        percentualComissao,
        percentualComissaoGravado: percentualComissaoEhValido(percentualGravado),
        subtotalSemComissao,
        descontoBase,
        baseLiquida,
        valorComissao: comissaoCentavos / 100,
        liquidoFilippini,
        residuo: residuoCentavos / 100,
        custoTotal,
        subtotalProdutos,
        margemProdutos,
        margemProdutosPercentual: subtotalSemComissao > 0 ? (margemProdutos / subtotalSemComissao) * 100 : 0,
        ...totaisProposta,
        totalGeral: totalPropostaClienteCentavos / 100,
        margemComDesconto,
        margemPercentual: liquidoFilippini > 0 ? (margemComDesconto / liquidoFilippini) * 100 : -100,
        avisos,
        centavos: {
            ...converterTotaisParaCentavos({ subtotalProdutos, ...totaisProposta }),
            totalGeral: totalPropostaClienteCentavos,
            subtotalSemComissao: converterValorParaCentavos(subtotalSemComissao),
            descontoBase: converterValorParaCentavos(descontoBase),
            baseLiquida: baseLiquidaCentavos,
            valorComissao: comissaoCentavos,
            liquidoFilippini: liquidoFilippiniCentavos,
            residuo: residuoCentavos
        }
    };
}

export function obterTotaisDoPedido(orcamento) {
    if (!pedidoEstaConfirmado(orcamento)) return null;

    const pedido = orcamento.pedido;
    const itens = obterItensDoPedido(orcamento);
    const identificacao = {
        versaoSnapshot: pedido.versaoSnapshot ?? null,
        quantidadeItens: itens.length,
        cancelado: pedidoEstaCancelado(orcamento)
    };

    if (pedido.versaoSnapshot === VERSAO_SNAPSHOT_FINANCEIRO) {
        // Snapshot v2: somente os valores congelados. Nunca recalcula pelo orçamento vivo nem pelo catálogo.
        const validacao = validarSnapshotPedidoV2(pedido);
        if (!validacao.valido) {
            return { origem: 'snapshot-invalido', ...identificacao, erros: validacao.erros };
        }
        const { financeiro, proposta } = pedido;
        return {
            origem: 'snapshot',
            ...identificacao,
            descontoPercentual: financeiro.descontoPercentual,
            percentualComissao: financeiro.percentualComissao,
            totalProdutos: financeiro.valorProdutosCobradoClienteCentavos / 100,
            totalInstalacao: proposta.totalInstalacaoCentavos / 100,
            totalGeral: proposta.totalPropostaClienteCentavos / 100,
            financeiro: structuredClone(financeiro),
            proposta: structuredClone(proposta),
            centavos: {
                totalProdutos: financeiro.valorProdutosCobradoClienteCentavos,
                totalInstalacao: proposta.totalInstalacaoCentavos,
                totalGeral: proposta.totalPropostaClienteCentavos
            }
        };
    }

    if (pedido.versaoSnapshot !== 1 && pedido.versaoSnapshot !== undefined) {
        return { origem: 'versao-desconhecida', ...identificacao };
    }

    // Snapshot v1 (uso operacional, fora do financeiro): os itens estão congelados, mas desconto e
    // instalação continuam no orçamento, protegidos pelos bloqueios de pedido confirmado. Os itens
    // avulsos voltam para o início para somar na mesma ordem usada pela tela.
    const itensNaOrdemDaInterface = [
        ...itens.filter(item => !item?.produtoAcabadoId),
        ...itens.filter(item => item?.produtoAcabadoId)
    ];
    const subtotalProdutos = somarCampo(itensNaOrdemDaInterface, 'precoVendaTotal');
    const { descontoPercentual, descontoValor, totalProdutos, totalInstalacao } = calcularTotaisProposta({
        subtotalProdutos,
        margemProdutos: 0,
        totalInstalacao: somarValoresInstalacao(orcamento.valoresInstalacao),
        descontoPercentual: lerDescontoPercentual(orcamento.infoComercial)
    });
    const centavos = converterTotaisParaCentavos({ subtotalProdutos, descontoValor, totalProdutos, totalInstalacao, totalGeral: 0 });
    // Mesmo fechamento em centavos exibido na proposta.
    centavos.totalGeral = centavos.totalProdutos + centavos.totalInstalacao;

    return {
        origem: 'derivado',
        ...identificacao,
        subtotalProdutos,
        descontoPercentual,
        descontoValor,
        totalProdutos,
        totalInstalacao,
        totalGeral: centavos.totalGeral / 100,
        centavos
    };
}
