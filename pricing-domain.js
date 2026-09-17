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

export function calcularPercentualEmCentavos(valorCentavos, percentual) {
    // Aplica um percentual com até duas casas a um valor inteiro em centavos, sem erro de ponto
    // flutuante: o produto é inteiro e a divisão por 10^6 tem representação decimal exata, então
    // converterValorParaCentavos arredonda o meio centavo para longe do zero como na exibição.
    const percentualCentesimal = Math.round(numeroFinito(percentual) * 100);
    return converterValorParaCentavos((Math.trunc(numeroFinito(valorCentavos)) * percentualCentesimal) / 1e6);
}

export function percentualComissaoEhValido(percentual) {
    // Somente números de 0 a 100 com no máximo duas casas decimais. Textos não são aceitos
    // como valor gravado; a tela converte o que foi digitado com interpretarPercentualComissao.
    return typeof percentual === 'number'
        && Number.isFinite(percentual)
        && percentual >= 0
        && percentual <= 100
        && Math.round(percentual * 100) / 100 === percentual;
}

export function interpretarPercentualComissao(texto) {
    // Aceita "10", "7,5", "7.25" ou "10,00 %". Retorna null quando o texto não é um percentual válido.
    const normalizado = String(texto ?? '').replace('%', '').trim().replace(',', '.');
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalizado)) return null;
    const percentual = Number(normalizado);
    return percentualComissaoEhValido(percentual) ? percentual : null;
}

export function calcularPrecoFinal(precoCompra, markup) {
    return numeroFinito(precoCompra) * numeroFinito(markup);
}

export function calcularPrecoTotalSemComissao(precoUnitarioBase, quantidadeCompra) {
    // Mesmo arredondamento usado até hoje no preço de cliente final: unitário e depois a linha.
    const precoUnitarioSemComissao = arredondamentoFinanceiro(precoUnitarioBase, 2);
    return arredondamentoFinanceiro(precoUnitarioSemComissao * numeroFinito(quantidadeCompra), 2);
}

export function aplicarComissaoAoItem({ precoUnitarioBase, precoTotalSemComissao }, percentualComissao) {
    // A comissão é embutida por fora em cada linha: linha sem comissão × (1 + p/100), arredondada
    // uma única vez. O cálculo parte sempre dos valores sem comissão, por isso nunca acumula.
    if (!percentualComissaoEhValido(percentualComissao)) {
        throw new RangeError('O percentual da comissão deve estar entre 0 e 100, com até duas casas decimais.');
    }
    const unitarioSemComissaoCentavos = converterValorParaCentavos(arredondamentoFinanceiro(precoUnitarioBase, 2));
    const totalSemComissaoCentavos = converterValorParaCentavos(precoTotalSemComissao);

    return {
        precoUnitario: (unitarioSemComissaoCentavos
            + calcularPercentualEmCentavos(unitarioSemComissaoCentavos, percentualComissao)) / 100,
        precoTotal: (totalSemComissaoCentavos
            + calcularPercentualEmCentavos(totalSemComissaoCentavos, percentualComissao)) / 100
    };
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

export function calcularDetalhesItem(produtoBase, quantidade, largura, altura, percentualComissao = 0) {
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

    // Preço-base sem comissão e sem arredondamento; os valores com comissão derivam dele.
    const precoUnitarioBase = calcularPrecoFinal(precoCompra, produtoBase?.markup);
    const precoTotalSemComissao = calcularPrecoTotalSemComissao(precoUnitarioBase, quantidadeCompra);
    const { precoUnitario, precoTotal } = aplicarComissaoAoItem(
        { precoUnitarioBase, precoTotalSemComissao },
        percentualComissao
    );

    // Comissão e margem não fazem parte do item: são calculadas no nível do orçamento.
    return {
        quantidadeCompra,
        larguraSalva,
        alturaSalva,
        precoUnitarioBase,
        precoTotalSemComissao,
        precoUnitario,
        precoTotal,
        custoReal: precoCompra * quantidadeCompra,
        calculoTexto
    };
}
