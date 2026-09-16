function numeroFinito(valor, padrao = 0) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : padrao;
}

export function arredondamentoFinanceiro(valor, casasDecimais = 2) {
    const fator = 10 ** casasDecimais;
    return Math.round((numeroFinito(valor) + Number.EPSILON) * fator) / fator;
}

export function converterValorParaCentavos(valor) {
    // Arredonda exatamente como a exibição em moeda (Intl.NumberFormat): parte da menor
    // representação decimal do número e leva o meio centavo para longe do zero.
    // Ex.: 5.005 vira 501 centavos, enquanto Math.round(5.005 * 100) e toFixed(2) resultam em 500.
    const numero = numeroFinito(valor);
    const [, parteInteira, parteDecimal = '', expoente = '0'] = String(Math.abs(numero))
        .match(/^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/);
    let digitos = parteInteira + parteDecimal;
    let digitosDosCentavos = parteInteira.length + Number(expoente) + 2;

    if (digitosDosCentavos < 1) {
        digitos = '0'.repeat(1 - digitosDosCentavos) + digitos;
        digitosDosCentavos = 1;
    }
    digitos = digitos.padEnd(digitosDosCentavos + 1, '0');

    const centavos = Number(digitos.slice(0, digitosDosCentavos))
        + (Number(digitos[digitosDosCentavos]) >= 5 ? 1 : 0);
    return (numero < 0 ? -centavos : centavos) || 0;
}

export function calcularPrecoFinal(precoCompra, markup) {
    return numeroFinito(precoCompra) * numeroFinito(markup);
}

export function normalizarUnidadeMedida(unidadeMedida) {
    const valorOriginal = String(unidadeMedida || '').trim();
    const valorNormalizado = valorOriginal
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/²/g, '2')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toLowerCase();

    if (['metrolinear', 'ml'].includes(valorNormalizado)) return 'MetroLinear';
    if (['metroquadrado', 'm2'].includes(valorNormalizado)) return 'MetroQuadrado';
    if (['unidade', 'un'].includes(valorNormalizado)) return 'Unidade';

    return valorOriginal || 'Unidade';
}

export function validarParametrosProduto({ precoCompra, markup, unidadeMedida, alturaPadrao }) {
    if (numeroFinito(precoCompra) <= 0) return 'O preço de compra deve ser maior que zero.';
    if (numeroFinito(markup) <= 0) return 'O markup deve ser maior que zero.';

    if (normalizarUnidadeMedida(unidadeMedida) === 'MetroLinear' && numeroFinito(alturaPadrao) <= 0) {
        return 'A altura padrão deve ser maior que zero para produtos em metro linear.';
    }

    return null;
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

    if (normalizarUnidadeMedida(produtoBase.unidadeMedida) === 'MetroQuadrado') {
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

    switch (normalizarUnidadeMedida(produtoBase?.unidadeMedida)) {
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
