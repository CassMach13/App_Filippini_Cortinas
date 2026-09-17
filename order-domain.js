import {
    aplicarComissaoAoItem,
    calcularPercentualEmCentavos,
    calcularPrecoFinal,
    calcularPrecoTotalSemComissao,
    calcularTotaisProposta,
    converterValorParaCentavos,
    percentualComissaoEhValido
} from './pricing-domain.js';

// Formato aceito por <input type="number">; outros textos viram campo vazio.
const NUMERO_VALIDO_CAMPO_HTML = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const CAMPOS_TOTAIS_PEDIDO = [
    'subtotalProdutos',
    'descontoPercentual',
    'descontoValor',
    'totalProdutos',
    'totalInstalacao',
    'totalGeral'
];

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

export function pedidoEstaConfirmado(orcamento) {
    return orcamento?.statusDocumento === 'pedido' && Boolean(orcamento?.pedido?.confirmadoEm);
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
        throw new Error('Este orçamento já foi confirmado como pedido.');
    }
    if (status === STATUS_DOCUMENTO.PERDIDO) {
        throw new Error('Reabra a negociação antes de transformar este orçamento em pedido.');
    }

    const confirmado = structuredClone(orcamento);
    if (!percentualComissaoEstaGravado(confirmado)) {
        // Documento antigo: o percentual efetivo passa a ficar registrado junto do pedido.
        confirmado.infoComercial = {
            ...(confirmado.infoComercial || {}),
            percentualComissao: obterPercentualComissao(orcamento)
        };
    }
    confirmado.statusDocumento = STATUS_DOCUMENTO.PEDIDO;
    confirmado.pedido = criarSnapshotPedido(confirmado, { confirmadoEm, confirmadoPor });
    return confirmado;
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
    const dataConfirmacao = confirmadoEm || new Date().toISOString();
    const infoGerais = orcamento?.infoGerais || {};

    return {
        versaoSnapshot: 1,
        orcamentoId: orcamento?.id || '',
        confirmadoEm: dataConfirmacao,
        confirmadoPor: confirmadoPor || null,
        cliente: {
            nome: infoGerais.nomeCliente || '',
            endereco: infoGerais.enderecoCliente || ''
        },
        costureira: {
            nome: infoGerais.nomeCostureira || '',
            enderecoEntrega: infoGerais.enderecoCostureira || ''
        },
        itens: obterItensAtuaisDoOrcamento(orcamento)
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
        margemComDesconto,
        margemPercentual: liquidoFilippini > 0 ? (margemComDesconto / liquidoFilippini) * 100 : -100,
        avisos,
        centavos: {
            ...converterTotaisParaCentavos({ subtotalProdutos, ...totaisProposta }),
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
    const totaisSalvos = pedido.totais;
    const possuiTotaisSalvos = Boolean(totaisSalvos) && typeof totaisSalvos === 'object'
        && CAMPOS_TOTAIS_PEDIDO.every(campo => typeof totaisSalvos[campo] === 'number' && Number.isFinite(totaisSalvos[campo]));

    let totais;
    if (possuiTotaisSalvos) {
        totais = Object.fromEntries(CAMPOS_TOTAIS_PEDIDO.map(campo => [campo, totaisSalvos[campo]]));
    } else {
        // Snapshot versão 1: os itens estão congelados, mas desconto e instalação continuam no
        // orçamento, protegidos pelos bloqueios de pedido confirmado. Os itens avulsos voltam
        // para o início para somar na mesma ordem usada pela tela.
        const itensNaOrdemDaInterface = [
            ...itens.filter(item => !item?.produtoAcabadoId),
            ...itens.filter(item => item?.produtoAcabadoId)
        ];
        const subtotalProdutos = somarCampo(itensNaOrdemDaInterface, 'precoVendaTotal');
        const { descontoPercentual, descontoValor, totalProdutos, totalInstalacao, totalGeral } = calcularTotaisProposta({
            subtotalProdutos,
            margemProdutos: 0,
            totalInstalacao: somarValoresInstalacao(orcamento.valoresInstalacao),
            descontoPercentual: lerDescontoPercentual(orcamento.infoComercial)
        });
        totais = {
            subtotalProdutos,
            descontoPercentual,
            descontoValor,
            totalProdutos,
            totalInstalacao,
            totalGeral
        };
    }

    return {
        origem: possuiTotaisSalvos ? 'snapshot' : 'derivado',
        versaoSnapshot: pedido.versaoSnapshot ?? null,
        quantidadeItens: itens.length,
        ...totais,
        centavos: converterTotaisParaCentavos(totais)
    };
}
