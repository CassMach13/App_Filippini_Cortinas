import { calcularTotaisProposta, converterValorParaCentavos } from './pricing-domain.js';

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

function numeroFinito(valor, padrao = 0) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : padrao;
}

export function pedidoEstaConfirmado(orcamento) {
    return orcamento?.statusDocumento === 'pedido' && Boolean(orcamento?.pedido?.confirmadoEm);
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
        prazoValidade: ''
    };
    novoOrcamento.statusDocumento = 'orcamento';
    delete novoOrcamento.pedido;

    return novoOrcamento;
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
    // Calcula a partir do documento persistido, sem ler campos da tela nem o cache `orcamento.totais`.
    const itens = listarItensNaOrdemDaInterface(orcamento);
    const subtotalProdutos = somarCampo(itens, 'precoTotal');
    const margemProdutos = somarCampo(itens, 'margemLiquida');
    const totaisProposta = calcularTotaisProposta({
        subtotalProdutos,
        margemProdutos,
        totalInstalacao: somarValoresInstalacao(orcamento?.valoresInstalacao),
        descontoPercentual: lerDescontoPercentual(orcamento?.infoComercial)
    });

    return {
        quantidadeItens: itens.length,
        subtotalProdutos,
        margemProdutos,
        margemProdutosPercentual: subtotalProdutos > 0 ? (margemProdutos / subtotalProdutos) * 100 : 0,
        ...totaisProposta,
        centavos: converterTotaisParaCentavos({ subtotalProdutos, ...totaisProposta })
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
