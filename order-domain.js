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
