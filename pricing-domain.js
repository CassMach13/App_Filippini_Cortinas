function numeroFinito(valor, padrao = 0) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : padrao;
}

export function arredondamentoFinanceiro(valor, casasDecimais = 2) {
    const fator = 10 ** casasDecimais;
    return Math.round((numeroFinito(valor) + Number.EPSILON) * fator) / fator;
}

export function calcularPrecoFinal(precoCompra, markup) {
    return numeroFinito(precoCompra) * numeroFinito(markup);
}

export function calcularTotaisProposta({
    subtotalProdutos,
    margemProdutos,
    totalInstalacao,
    descontoPercentual
}) {
    const subtotal = numeroFinito(subtotalProdutos);
    const margemOriginal = numeroFinito(margemProdutos);
    const instalacao = numeroFinito(totalInstalacao);
    const percentual = Math.min(100, Math.max(0, numeroFinito(descontoPercentual)));
    const descontoValor = subtotal * (percentual / 100);
    const totalProdutos = subtotal - descontoValor;
    const margemComDesconto = margemOriginal - descontoValor;
    const margemPercentual = totalProdutos > 0
        ? (margemComDesconto / totalProdutos) * 100
        : -100;

    return {
        descontoPercentual: percentual,
        descontoValor,
        totalProdutos,
        totalInstalacao: instalacao,
        totalGeral: totalProdutos + instalacao,
        margemComDesconto,
        margemPercentual
    };
}

export function validarParametrosItem(produtoBase, quantidade, largura, altura) {
    if (!produtoBase) return 'Produto não encontrado.';
    if (numeroFinito(quantidade) <= 0) return 'A quantidade deve ser um número maior que zero.';

    if (produtoBase.unidadeMedida === 'MetroQuadrado') {
        if (numeroFinito(largura) <= 0 || numeroFinito(altura) <= 0) {
            return "Largura e altura são obrigatórias e devem ser maiores que zero para produtos em metro quadrado.";
        }
    }

    return null;
}

export function calcularDetalhesItem(produtoBase, quantidade, largura, altura, tipoCliente = 'cliente') {
    const quantidadeNumerica = numeroFinito(quantidade);
    const larguraNumerica = numeroFinito(largura);
    const alturaNumerica = numeroFinito(altura);
    const precoCompra = numeroFinito(produtoBase?.precoCompra);
    let quantidadeCompra = 0;
    let larguraSalva = null;
    let alturaSalva = null;
    let calculoTexto = '';

    switch (produtoBase?.unidadeMedida) {
        case 'MetroLinear':
            quantidadeCompra = quantidadeNumerica;
            alturaSalva = produtoBase.alturaPadrao ?? null;
            calculoTexto = `${quantidadeNumerica.toFixed(3)} metro(s)`;
            break;
        case 'MetroQuadrado':
            quantidadeCompra = larguraNumerica * alturaNumerica * quantidadeNumerica;
            larguraSalva = larguraNumerica;
            alturaSalva = alturaNumerica;
            calculoTexto = `(${larguraNumerica}m x ${alturaNumerica}m) x ${quantidadeNumerica} pç(s) = ${quantidadeCompra.toFixed(2)}m²`;
            break;
        default:
            quantidadeCompra = quantidadeNumerica;
            calculoTexto = `${quantidadeNumerica} unidade(s)`;
            break;
    }

    const precoUnitarioBase = calcularPrecoFinal(precoCompra, produtoBase?.markup);
    const percentualComissao = tipoCliente === 'arquiteto' ? 0.10 : 0;
    const precoUnitario = arredondamentoFinanceiro(precoUnitarioBase * (1 + percentualComissao), 2);
    const precoTotal = arredondamentoFinanceiro(precoUnitario * quantidadeCompra, 2);
    const custoReal = precoCompra * quantidadeCompra;
    const valorComissao = precoUnitarioBase * percentualComissao * quantidadeCompra;
    const margemLiquida = precoTotal - custoReal - valorComissao;
    const margemPercentual = precoTotal > 0 ? (margemLiquida / precoTotal) * 100 : 0;

    return {
        quantidadeCompra,
        larguraSalva,
        alturaSalva,
        precoUnitario,
        precoTotal,
        custoReal,
        valorComissao,
        margemLiquida,
        margemPercentual,
        calculoTexto
    };
}
