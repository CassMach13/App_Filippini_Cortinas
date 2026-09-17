import assert from 'node:assert/strict';
import test from 'node:test';

import {
    FORMATO_PRECO_ITEM,
    PERCENTUAL_COMISSAO_PADRAO,
    alterarPercentualComissao,
    calcularIndicadoresDoItem,
    calcularTotaisOrcamento,
    confirmarOrcamentoComoPedido,
    criarOrcamentoDuplicado,
    marcarOrcamentoComoPerdido,
    obterPercentualComissao,
    obterPrecosBaseDoItem,
    percentualComissaoEstaGravado,
    somarIndicadoresDosItens
} from '../order-domain.js';
import {
    arredondamentoFinanceiro,
    calcularDetalhesItem,
    calcularPercentualEmCentavos,
    calcularPrecoFinal,
    interpretarPercentualComissao,
    percentualComissaoEhValido
} from '../pricing-domain.js';

const PRODUTO_UNIDADE = { unidadeMedida: 'Unidade', precoCompra: 500, markup: 2 };
const PRODUTO_M2 = { unidadeMedida: 'MetroQuadrado', precoCompra: 38.73, markup: 2.35 };
const PRODUTO_ARREDONDAMENTO = { unidadeMedida: 'Unidade', precoCompra: 16.665, markup: 2 };
const PRODUTO_LINEAR = { unidadeMedida: 'MetroLinear', precoCompra: 24.99, markup: 2.3, alturaPadrao: 2.8 };

function congelarProfundamente(valor) {
    if (valor && typeof valor === 'object') {
        Object.values(valor).forEach(congelarProfundamente);
        Object.freeze(valor);
    }
    return valor;
}

function criarGeradorAleatorio(semente) {
    let estado = semente >>> 0;
    return () => {
        estado = (estado + 0x6D2B79F5) >>> 0;
        let t = estado;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Item novo, como gravado pela tela depois da Etapa 2B.
function criarItem(id, produto, quantidade, largura, altura, percentual) {
    const detalhes = calcularDetalhesItem(produto, quantidade, largura, altura, percentual);
    return {
        id,
        codigo: `COD-${id}`,
        descricao: `Item ${id}`,
        fornecedor: 'Fornecedor Teste',
        unidadeMedida: produto.unidadeMedida,
        quantidade,
        largura: detalhes.larguraSalva,
        altura: detalhes.alturaSalva,
        quantidadeCompra: detalhes.quantidadeCompra,
        precoCompraUnitario: produto.precoCompra,
        custoReal: detalhes.custoReal,
        precoUnitarioBase: detalhes.precoUnitarioBase,
        precoTotalSemComissao: detalhes.precoTotalSemComissao,
        precoUnitario: detalhes.precoUnitario,
        precoTotal: detalhes.precoTotal
    };
}

// Item antigo, com a regra anterior de tipo de cliente (10% embutidos por unitário para arquiteto).
function criarItemAntigo(id, produto, quantidade, largura, altura, tipoCliente) {
    const quantidadeCompra = produto.unidadeMedida === 'MetroQuadrado' ? largura * altura * quantidade : quantidade;
    const precoUnitarioBase = calcularPrecoFinal(produto.precoCompra, produto.markup);
    const percentual = tipoCliente === 'arquiteto' ? 0.10 : 0;
    const precoUnitario = arredondamentoFinanceiro(precoUnitarioBase * (1 + percentual), 2);
    const precoTotal = arredondamentoFinanceiro(precoUnitario * quantidadeCompra, 2);
    const custoReal = produto.precoCompra * quantidadeCompra;
    const valorComissao = precoUnitarioBase * percentual * quantidadeCompra;
    return {
        id,
        codigo: `COD-${id}`,
        unidadeMedida: produto.unidadeMedida,
        quantidade,
        largura: produto.unidadeMedida === 'MetroQuadrado' ? largura : null,
        altura: produto.unidadeMedida === 'MetroQuadrado' ? altura : null,
        quantidadeCompra,
        precoCompraUnitario: produto.precoCompra,
        custoReal,
        precoUnitario,
        precoTotal,
        valorComissao,
        margemLiquida: precoTotal - custoReal - valorComissao,
        margemPercentual: precoTotal > 0 ? ((precoTotal - custoReal - valorComissao) / precoTotal) * 100 : 0
    };
}

function criarOrcamento({ itens = [], produtosAcabados, descontoGlobal = 0, percentualComissao, tipoCliente, valoresInstalacao } = {}) {
    const orcamento = {
        id: 'ORC-50',
        statusDocumento: 'orcamento',
        infoGerais: { nomeCliente: 'Cliente Comissão', nomeComissionado: 'Arquiteta Teste' },
        infoComercial: { condicaoPagamento: 'À vista', descontoGlobal },
        itens
    };
    if (percentualComissao !== undefined) orcamento.infoComercial.percentualComissao = percentualComissao;
    if (tipoCliente !== undefined) orcamento.infoGerais.tipoCliente = tipoCliente;
    if (produtosAcabados !== undefined) orcamento.produtosAcabados = produtosAcabados;
    if (valoresInstalacao !== undefined) orcamento.valoresInstalacao = valoresInstalacao;
    return orcamento;
}

function resumir(totais) {
    // Valores em reais a partir dos centavos oficiais, para comparar com os casos homologados.
    const c = totais.centavos;
    return {
        subtotalExibido: c.subtotalProdutos / 100,
        descontoExibido: c.descontoValor / 100,
        produtosCobrados: c.totalProdutos / 100,
        baseLiquida: c.baseLiquida / 100,
        comissao: c.valorComissao / 100,
        liquidoFilippini: c.liquidoFilippini / 100,
        residuo: c.residuo / 100
    };
}

test('percentual aceita de 0 a 100 com até duas casas e rejeita o resto', () => {
    [0, 5, 7.5, 10, 12.34, 99.99, 100].forEach(valor => assert.equal(percentualComissaoEhValido(valor), true, String(valor)));
    [-1, 100.01, 7.555, Number.NaN, Number.POSITIVE_INFINITY, '10', null, undefined, 0.1 + 0.2]
        .forEach(valor => assert.equal(percentualComissaoEhValido(valor), false, String(valor)));

    assert.equal(interpretarPercentualComissao('10'), 10);
    assert.equal(interpretarPercentualComissao('7,5'), 7.5);
    assert.equal(interpretarPercentualComissao('7.25'), 7.25);
    assert.equal(interpretarPercentualComissao(' 10,00 % '), 10);
    assert.equal(interpretarPercentualComissao('0'), 0);
    ['', 'abc', '-5', '100,01', '101', '7,555', '1.000', '5e1', ',5'].forEach(texto => {
        assert.equal(interpretarPercentualComissao(texto), null, texto);
    });
});

test('percentual em centavos arredonda o meio centavo exatamente, sem ponto flutuante', () => {
    // 10% de R$ 1.679,66 = 167,966 -> 167,97; 7,5% de R$ 2.221,13 = 166,58475 -> 166,58.
    assert.equal(calcularPercentualEmCentavos(167966, 10), 16797);
    assert.equal(calcularPercentualEmCentavos(222113, 7.5), 16658);
    // Meio centavo exato vai para cima: 5% de R$ 0,10 = 0,005.
    assert.equal(calcularPercentualEmCentavos(10, 5), 1);
    // 5% de R$ 10,10 = 0,505: com float (10.1 * 0.05) o resultado cairia para 0,50.
    assert.equal(calcularPercentualEmCentavos(1010, 5), 51);

    const aleatorio = criarGeradorAleatorio(2026);
    for (let indice = 0; indice < 50000; indice++) {
        const centavos = Math.floor(aleatorio() * 1e9);
        const percentualCentesimal = Math.floor(aleatorio() * 10001);
        // Referência com inteiros grandes: arredonda (centavos × p) / 10000 com meio para cima.
        const numerador = BigInt(centavos) * BigInt(percentualCentesimal);
        const esperado = Number((numerador * 2n + 10000n) / 20000n);
        assert.equal(calcularPercentualEmCentavos(centavos, percentualCentesimal / 100), esperado, `${centavos} × ${percentualCentesimal}`);
    }

    // Todos os percentuais com duas casas, em valores que caem exatamente no meio centavo:
    // é onde uma conta em ponto flutuante (Math.round(centavos × p / 100)) erra.
    const mdc = (a, b) => (b === 0 ? a : mdc(b, a % b));
    const inverso = (a, m) => {
        for (let x = 1; x < m; x++) if ((a * x) % m === 1) return x;
        return 1;
    };
    let meiosCentavos = 0;
    for (let percentualCentesimal = 1; percentualCentesimal < 10000; percentualCentesimal++) {
        const divisor = mdc(percentualCentesimal, 10000);
        if (5000 % divisor !== 0) continue;
        const modulo = 10000 / divisor;
        const primeiro = ((5000 / divisor) * inverso((percentualCentesimal / divisor) % modulo, modulo)) % modulo;
        [1000, 123457, 98765432].forEach(inicio => {
            const centavos = primeiro + Math.ceil(inicio / modulo) * modulo;
            const numerador = centavos * percentualCentesimal;
            assert.equal(numerador % 10000, 5000);
            assert.equal(calcularPercentualEmCentavos(centavos, percentualCentesimal / 100), (numerador + 5000) / 10000, `${centavos} × ${percentualCentesimal}`);
            meiosCentavos++;
        });
    }
    assert.ok(meiosCentavos > 10000);
});

test('item com 0% reproduz o preço anterior de cliente final em 100 mil linhas', () => {
    const aleatorio = criarGeradorAleatorio(1604);
    const inteiro = (minimo, maximo) => minimo + Math.floor(aleatorio() * (maximo - minimo + 1));
    for (let indice = 0; indice < 100000; indice++) {
        const unidadeMedida = ['Unidade', 'MetroLinear', 'MetroQuadrado'][indice % 3];
        const produto = { unidadeMedida, precoCompra: inteiro(1, 60000) / 100, markup: inteiro(110, 350) / 100, alturaPadrao: 2.8 };
        const quantidade = unidadeMedida === 'MetroLinear' ? inteiro(500, 30000) / 1000 : inteiro(1, 6);
        const largura = inteiro(30, 400) / 100;
        const altura = inteiro(30, 320) / 100;
        const antigo = criarItemAntigo('x', produto, quantidade, largura, altura, 'cliente');
        const novo = calcularDetalhesItem(produto, quantidade, largura, altura, 0);

        assert.equal(novo.precoUnitario, antigo.precoUnitario);
        assert.equal(novo.precoTotal, antigo.precoTotal);
        assert.equal(novo.precoTotalSemComissao, antigo.precoTotal);
    }
});

test('percentuais 0%, 5%, 10%, 7,5% e com duas casas embutem a comissão por fora na linha', () => {
    const casos = [
        [0, 1000, 1000],
        [5, 1050, 1050],
        [10, 1100, 1100],
        [7.5, 1075, 1075],
        [12.34, 1123.4, 1123.4]
    ];
    casos.forEach(([percentual, precoUnitario, precoTotal]) => {
        const item = calcularDetalhesItem(PRODUTO_UNIDADE, 1, 0, 0, percentual);
        assert.equal(item.precoUnitarioBase, 1000);
        assert.equal(item.precoTotalSemComissao, 1000);
        assert.equal(item.precoUnitario, precoUnitario, String(percentual));
        assert.equal(item.precoTotal, precoTotal, String(percentual));

        // Nunca "por dentro": 10% por dentro daria 1.111,11.
        const totais = calcularTotaisOrcamento(criarOrcamento({ itens: [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, percentual)], percentualComissao: percentual }));
        assert.equal(totais.percentualComissao, percentual);
        assert.equal(totais.valorComissao, arredondamentoFinanceiro(1000 * percentual / 100));
        assert.equal(totais.liquidoFilippini, 1000);
        assert.equal(totais.residuo, 0);
    });

    assert.throws(() => calcularDetalhesItem(PRODUTO_UNIDADE, 1, 0, 0, 'arquiteto'), RangeError);
    assert.throws(() => calcularDetalhesItem(PRODUTO_UNIDADE, 1, 0, 0, 7.555), RangeError);
});

test('os cinco casos homologados na Etapa 2A fecham exatamente', () => {
    const caso = (itens, descontoGlobal, percentualComissao, valoresInstalacao) =>
        calcularTotaisOrcamento(criarOrcamento({ itens, descontoGlobal, percentualComissao, valoresInstalacao }));

    // 1. Base 1.000, sem desconto, 10%.
    const caso1 = caso([criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 10)], 0, 10);
    assert.deepEqual(resumir(caso1), {
        subtotalExibido: 1100, descontoExibido: 0, produtosCobrados: 1100,
        baseLiquida: 1000, comissao: 100, liquidoFilippini: 1000, residuo: 0
    });

    // 2. Desconto de 10% e comissão de 10%: cliente paga 990, comissão 90.
    const caso2 = caso([criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 10)], 10, 10);
    assert.deepEqual(resumir(caso2), {
        subtotalExibido: 1100, descontoExibido: 110, produtosCobrados: 990,
        baseLiquida: 900, comissao: 90, liquidoFilippini: 900, residuo: 0
    });

    // 3. Desconto de 10% e comissão de 5%.
    const caso3 = caso([criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 5)], 10, 5);
    assert.deepEqual(resumir(caso3), {
        subtotalExibido: 1050, descontoExibido: 105, produtosCobrados: 945,
        baseLiquida: 900, comissao: 45, liquidoFilippini: 900, residuo: 0
    });

    // 4. Metro quadrado com base 91,0155 e quantidade 19,95, desconto 7,5%, comissão 10%.
    const caso4 = caso([criarItem('m2', PRODUTO_M2, 2, 3.5, 2.85, 10)], 7.5, 10);
    assert.deepEqual(resumir(caso4), {
        subtotalExibido: 1997.44, descontoExibido: 149.81, produtosCobrados: 1847.63,
        baseLiquida: 1679.66, comissao: 167.97, liquidoFilippini: 1679.66, residuo: 0
    });

    // 5. Três itens com arredondamentos diferentes, desconto 5%, comissão 7,5% e instalação.
    const caso5 = caso([
        criarItem('a', PRODUTO_ARREDONDAMENTO, 3, 0, 0, 7.5),
        criarItem('b', PRODUTO_LINEAR, 7.345, 0, 0, 7.5),
        criarItem('m2', PRODUTO_M2, 2, 3.5, 2.85, 7.5)
    ], 5, 7.5, { Sala: 350.55 });
    assert.deepEqual(resumir(caso5), {
        subtotalExibido: 2513.38, descontoExibido: 125.67, produtosCobrados: 2387.71,
        baseLiquida: 2221.13, comissao: 166.58, liquidoFilippini: 2221.13, residuo: 0
    });
    assert.equal(caso5.centavos.totalInstalacao, 35055);
    assert.equal(caso5.centavos.totalGeral, 273826);
});

test('desconto exibido incide sobre o subtotal com comissão e equivale a descontar a base', () => {
    const itens = [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 10)];
    const semDesconto = calcularTotaisOrcamento(criarOrcamento({ itens, descontoGlobal: 0, percentualComissao: 10 }));
    const comDesconto = calcularTotaisOrcamento(criarOrcamento({ itens, descontoGlobal: 10, percentualComissao: 10 }));

    assert.equal(semDesconto.descontoValor, 0);
    assert.equal(semDesconto.descontoBase, 0);
    assert.equal(semDesconto.totalProdutos, 1100);

    // 1.100 − 10% = 990 = (1.000 − 10%) + 10% de comissão sobre 900.
    assert.equal(comDesconto.descontoValor, 110);
    assert.equal(comDesconto.descontoBase, 100);
    assert.equal(comDesconto.totalProdutos, 990);
    assert.equal(comDesconto.baseLiquida + comDesconto.valorComissao, comDesconto.totalProdutos);
    // A comissão acompanha o desconto: 90 em vez de 100.
    assert.equal(comDesconto.valorComissao, 90);
});

test('instalação fica fora da base, da comissão e da margem, mas entra no total da proposta', () => {
    const itens = [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 10)];
    const semInstalacao = calcularTotaisOrcamento(criarOrcamento({ itens, descontoGlobal: 10, percentualComissao: 10 }));
    const comInstalacao = calcularTotaisOrcamento(criarOrcamento({
        itens, descontoGlobal: 10, percentualComissao: 10, valoresInstalacao: { Sala: 300, Quarto: '150,50' }
    }));

    assert.equal(comInstalacao.totalInstalacao, 450);
    ['subtotalSemComissao', 'descontoBase', 'baseLiquida', 'valorComissao', 'liquidoFilippini', 'residuo',
        'totalProdutos', 'margemProdutos', 'margemComDesconto', 'margemPercentual']
        .forEach(campo => assert.equal(comInstalacao[campo], semInstalacao[campo], campo));
    assert.equal(comInstalacao.totalGeral, 990 + 450);
    assert.equal(comInstalacao.centavos.totalGeral, 144000);
});

test('margem interna antes e depois do desconto ignora a comissão como receita', () => {
    // Custo 500, base 1.000, comissão 10%.
    const semDesconto = calcularTotaisOrcamento(criarOrcamento({ itens: [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 10)], percentualComissao: 10 }));
    assert.equal(semDesconto.custoTotal, 500);
    assert.equal(semDesconto.margemProdutos, 500);
    assert.equal(semDesconto.margemProdutosPercentual, 50);
    assert.equal(semDesconto.margemComDesconto, 500);
    assert.equal(semDesconto.margemPercentual, 50);

    const comDesconto = calcularTotaisOrcamento(criarOrcamento({ itens: [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 10)], descontoGlobal: 10, percentualComissao: 10 }));
    assert.equal(comDesconto.margemProdutos, 500);
    // Depois do desconto: líquido Filippini 900 − custo 500 = 400, sobre o líquido.
    assert.equal(comDesconto.margemComDesconto, 400);
    assert.ok(Math.abs(comDesconto.margemPercentual - (400 / 900) * 100) < 1e-9);

    const comCincoPorcento = calcularTotaisOrcamento(criarOrcamento({ itens: [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 5)], descontoGlobal: 10, percentualComissao: 5 }));
    assert.equal(comCincoPorcento.margemComDesconto, 400);

    const descontoTotal = calcularTotaisOrcamento(criarOrcamento({ itens: [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 10)], descontoGlobal: 100, percentualComissao: 10 }));
    assert.equal(descontoTotal.valorComissao, 0);
    assert.equal(descontoTotal.liquidoFilippini, 0);
    assert.equal(descontoTotal.margemPercentual, -100);

    // Indicadores por item e por grupo usam a mesma regra.
    const item = criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 10);
    assert.equal(calcularIndicadoresDoItem(item, 10).margem, 500);
    assert.equal(calcularIndicadoresDoItem(item, 10).margemPercentual, 50);
    const grupo = somarIndicadoresDosItens([item, criarItem('b', PRODUTO_UNIDADE, 2, 0, 0, 10)], 10);
    assert.deepEqual(grupo, { precoTotal: 3300, precoTotalSemComissao: 3000, custoTotal: 1500, margem: 1500, margemPercentual: 50 });
});

test('resíduo de arredondamento fica com a Filippini e só gera aviso quando é anormal', () => {
    // Soma de linhas arredondadas separadamente: 3 × 3,33 com 5% = 3 × 3,50 = 10,50,
    // enquanto a comissão oficial é 5% de 9,99 = 0,50; líquido 10,00 contra base 9,99.
    const produto = { unidadeMedida: 'Unidade', precoCompra: 3.33, markup: 1 };
    const itens = ['a', 'b', 'c'].map(id => criarItem(id, produto, 1, 0, 0, 5));
    const totais = calcularTotaisOrcamento(criarOrcamento({ itens, percentualComissao: 5 }));
    assert.equal(totais.subtotalProdutos, 10.5);
    assert.equal(totais.baseLiquida, 9.99);
    assert.equal(totais.valorComissao, 0.5);
    assert.equal(totais.liquidoFilippini, 10);
    assert.equal(totais.centavos.residuo, 1);
    // Nenhum centavo é redistribuído entre as linhas.
    assert.deepEqual(itens.map(item => item.precoTotal), [3.5, 3.5, 3.5]);
    assert.deepEqual(totais.avisos, []);

    // Documento de arquiteto com um item sem comissão embutida: inconsistência, apenas avisada.
    const inconsistente = criarOrcamento({
        tipoCliente: 'arquiteto',
        itens: [criarItemAntigo('a', PRODUTO_UNIDADE, 1, 0, 0, 'arquiteto'), criarItemAntigo('b', PRODUTO_UNIDADE, 1, 0, 0, 'cliente')]
    });
    const copia = structuredClone(inconsistente);
    const totaisInconsistentes = calcularTotaisOrcamento(inconsistente);
    assert.deepEqual(totaisInconsistentes.avisos, [{ codigo: 'residuo-comissao-anormal', residuo: -100 }]);
    assert.equal(totaisInconsistentes.totalProdutos, 2100);
    assert.deepEqual(inconsistente, copia);
});

test('recálculo parte da base sem catálogo e nunca acumula', () => {
    const original = criarOrcamento({
        descontoGlobal: 7.5,
        percentualComissao: 10,
        itens: [criarItem('a', PRODUTO_ARREDONDAMENTO, 3, 0, 0, 10), criarItem('b', PRODUTO_LINEAR, 7.345, 0, 0, 10)],
        produtosAcabados: [{ id: 'prod-1', nome: 'Cortina', ambiente: 'Sala', itens: [criarItem('m2', PRODUTO_M2, 2, 3.5, 2.85, 10)] }]
    });
    congelarProfundamente(original);

    // 10 -> 5: somente dados do orçamento. Não existe catálogo nesta chamada.
    const cinco = alterarPercentualComissao(original, 5);
    const itemM2 = cinco.produtosAcabados[0].itens[0];
    const originalM2 = original.produtosAcabados[0].itens[0];
    assert.equal(cinco.infoComercial.percentualComissao, 5);
    assert.equal(itemM2.precoTotal, 1906.64);
    ['id', 'codigo', 'descricao', 'fornecedor', 'unidadeMedida', 'quantidade', 'largura', 'altura',
        'quantidadeCompra', 'precoCompraUnitario', 'custoReal', 'precoUnitarioBase', 'precoTotalSemComissao']
        .forEach(campo => assert.equal(itemM2[campo], originalM2[campo], campo));
    assert.equal(cinco.infoComercial.descontoGlobal, 7.5);
    assert.equal(cinco.produtosAcabados[0].nome, 'Cortina');

    // Sequência 10 -> 5 -> 10 -> 5 -> 0 -> 10 termina igual a 10% direto.
    let sequencia = original;
    for (const percentual of [10, 5, 10, 5, 0, 10]) sequencia = alterarPercentualComissao(sequencia, percentual);
    assert.deepEqual(sequencia, original);
    assert.deepEqual(calcularTotaisOrcamento(sequencia), calcularTotaisOrcamento(original));

    // Com 0% os preços voltam exatamente à base.
    const zero = alterarPercentualComissao(original, 0);
    [...zero.itens, ...zero.produtosAcabados[0].itens].forEach(item => assert.equal(item.precoTotal, item.precoTotalSemComissao));
    assert.equal(calcularTotaisOrcamento(zero).valorComissao, 0);

    // Documento sem itens e sem produtosAcabados também aceita a alteração.
    assert.equal(alterarPercentualComissao({ id: 'ORC-60', itens: [] }, 10).infoComercial.percentualComissao, 10);
    assert.throws(() => alterarPercentualComissao(original, 100.5), RangeError);
    assert.throws(() => alterarPercentualComissao(original, '5'), RangeError);
});

test('recupera a base de itens antigos de cliente final e de arquiteto', () => {
    // Cliente final antigo: o preço gravado é a própria base.
    const cliente = criarItemAntigo('c', PRODUTO_M2, 2, 3.5, 2.85, 'cliente');
    const baseCliente = obterPrecosBaseDoItem(cliente, 0);
    assert.equal(baseCliente.formato, FORMATO_PRECO_ITEM.LEGADO_SEM_COMISSAO);
    assert.equal(baseCliente.precoUnitarioBase, cliente.precoUnitario);
    assert.equal(baseCliente.precoTotalSemComissao, cliente.precoTotal);

    // Arquiteto antigo: a base vem de valorComissao, não do unitário já arredondado com 10%.
    const arquiteto = criarItemAntigo('a', PRODUTO_M2, 2, 3.5, 2.85, 'arquiteto');
    assert.equal(arquiteto.precoUnitario, 100.12);
    assert.equal(arquiteto.precoTotal, 1997.39);
    const baseArquiteto = obterPrecosBaseDoItem(arquiteto, 10);
    assert.equal(baseArquiteto.formato, FORMATO_PRECO_ITEM.LEGADO_COM_COMISSAO);
    assert.ok(Math.abs(baseArquiteto.precoUnitarioBase - 91.0155) < 1e-9);
    assert.equal(baseArquiteto.precoTotalSemComissao, 1815.85);

    // Arquiteto antigo sem valorComissao: usa o unitário dividido pelo percentual do documento.
    const semValorComissao = { ...arquiteto };
    delete semValorComissao.valorComissao;
    const baseSemValor = obterPrecosBaseDoItem(semValorComissao, 10);
    assert.ok(Math.abs(baseSemValor.precoUnitarioBase - 100.12 / 1.1) < 1e-9);
    assert.equal(obterPrecosBaseDoItem(semValorComissao, 0).formato, FORMATO_PRECO_ITEM.LEGADO_SEM_COMISSAO);

    // Primeiro recálculo manual de um documento antigo de arquiteto: 10% -> 5% converte para o formato atual.
    const documento = criarOrcamento({ tipoCliente: 'arquiteto', descontoGlobal: 7.5, itens: [arquiteto] });
    const antes = calcularTotaisOrcamento(documento);
    assert.equal(antes.totalProdutos, 1997.39 * 0.925);
    assert.equal(antes.valorComissao, 167.97);
    const recalculado = alterarPercentualComissao(documento, 5);
    const item = recalculado.itens[0];
    assert.equal(item.precoTotalSemComissao, 1815.85);
    assert.equal(item.precoTotal, 1906.64);
    ['valorComissao', 'margemLiquida', 'margemPercentual'].forEach(campo => assert.equal(campo in item, false, campo));
    assert.equal(item.custoReal, arquiteto.custoReal);
    assert.equal(recalculado.infoGerais.tipoCliente, 'arquiteto');
    assert.equal(obterPrecosBaseDoItem(item, 5).formato, FORMATO_PRECO_ITEM.ATUAL);
    // Voltar a 10% usa a nova regra por linha, e não o arredondamento antigo por unitário.
    assert.equal(alterarPercentualComissao(recalculado, 10).itens[0].precoTotal, 1997.44);

    // Cliente final antigo passando a ter comissão.
    const documentoCliente = criarOrcamento({ tipoCliente: 'cliente', itens: [cliente] });
    const comComissao = alterarPercentualComissao(documentoCliente, 10);
    assert.equal(comComissao.itens[0].precoTotalSemComissao, cliente.precoTotal);
    assert.equal(comComissao.itens[0].precoTotal, 1997.44);
});

test('base recuperada de itens antigos de arquiteto reproduz o preço sem comissão do catálogo', () => {
    const aleatorio = criarGeradorAleatorio(310);
    const inteiro = (minimo, maximo) => minimo + Math.floor(aleatorio() * (maximo - minimo + 1));
    for (let indice = 0; indice < 100000; indice++) {
        const unidadeMedida = ['Unidade', 'MetroLinear', 'MetroQuadrado'][indice % 3];
        const markup = indice % 7 === 0 ? inteiro(1100000, 3500000) / 1000000 : inteiro(110, 350) / 100;
        const produto = { unidadeMedida, precoCompra: inteiro(1, 60000) / 100, markup, alturaPadrao: 2.8 };
        const quantidade = unidadeMedida === 'MetroLinear' ? inteiro(500, 30000) / 1000 : inteiro(1, 6);
        const largura = inteiro(30, 400) / 100;
        const altura = inteiro(30, 320) / 100;
        const antigo = criarItemAntigo('x', produto, quantidade, largura, altura, 'arquiteto');
        const catalogo = calcularDetalhesItem(produto, quantidade, largura, altura, 10);

        const recuperado = obterPrecosBaseDoItem(antigo, 10);
        assert.equal(recuperado.precoTotalSemComissao, catalogo.precoTotalSemComissao, `${produto.precoCompra} × ${markup} × ${quantidade}`);
        assert.equal(arredondamentoFinanceiro(recuperado.precoUnitarioBase), arredondamentoFinanceiro(catalogo.precoUnitarioBase));
    }

    // Sem preço de compra gravado, a base vem só da divisão de valorComissao.
    const semPrecoCompra = criarItemAntigo('y', PRODUTO_UNIDADE, 3, 0, 0, 'arquiteto');
    delete semPrecoCompra.precoCompraUnitario;
    assert.ok(Math.abs(obterPrecosBaseDoItem(semPrecoCompra, 10).precoUnitarioBase - 1000) < 1e-9);
});

test('percentual gravado prevalece sobre o tipo de cliente antigo, inclusive 0%', () => {
    assert.equal(obterPercentualComissao(null), 0);
    assert.equal(obterPercentualComissao({}), 0);
    assert.equal(obterPercentualComissao(criarOrcamento({ tipoCliente: 'cliente' })), 0);
    assert.equal(obterPercentualComissao(criarOrcamento({ tipoCliente: 'arquiteto' })), 10);
    assert.equal(obterPercentualComissao(criarOrcamento({ tipoCliente: 'arquiteto', percentualComissao: 0 })), 0);
    assert.equal(obterPercentualComissao(criarOrcamento({ tipoCliente: 'arquiteto', percentualComissao: 7.5 })), 7.5);
    assert.equal(obterPercentualComissao(criarOrcamento({ tipoCliente: 'cliente', percentualComissao: 12.34 })), 12.34);
    assert.equal(obterPercentualComissao(criarOrcamento({ percentualComissao: 5 })), 5);
    assert.equal(PERCENTUAL_COMISSAO_PADRAO, 10);

    assert.equal(percentualComissaoEstaGravado(criarOrcamento({ tipoCliente: 'arquiteto' })), false);
    assert.equal(percentualComissaoEstaGravado(criarOrcamento({ percentualComissao: 0 })), true);

    // 0% gravado em documento de arquiteto: itens novos sem comissão e nenhuma comissão calculada.
    const totais = calcularTotaisOrcamento(criarOrcamento({
        tipoCliente: 'arquiteto', percentualComissao: 0, itens: [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 0)]
    }));
    assert.equal(totais.percentualComissao, 0);
    assert.equal(totais.valorComissao, 0);
    assert.equal(totais.percentualComissaoGravado, true);
});

test('percentual gravado inválido usa a regra antiga, gera aviso e não é aceito em alterações', () => {
    [150, -5, 7.555, '10', null, Number.NaN].forEach(invalido => {
        const cliente = criarOrcamento({ tipoCliente: 'cliente', percentualComissao: invalido, itens: [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 0)] });
        const arquiteto = criarOrcamento({ tipoCliente: 'arquiteto', percentualComissao: invalido });

        assert.equal(obterPercentualComissao(cliente), 0, String(invalido));
        assert.equal(obterPercentualComissao(arquiteto), 10, String(invalido));
        const totais = calcularTotaisOrcamento(cliente);
        assert.equal(totais.percentualComissaoGravado, false);
        assert.deepEqual(totais.avisos, [{ codigo: 'percentual-comissao-invalido', percentualUsado: 0 }]);
        assert.throws(() => alterarPercentualComissao(cliente, invalido), RangeError);
    });
    // Sem o campo não há aviso de percentual inválido.
    assert.deepEqual(calcularTotaisOrcamento(criarOrcamento({ tipoCliente: 'arquiteto' })).avisos, []);
});

test('leitura de documento antigo não grava percentual nem altera itens', () => {
    const antigo = criarOrcamento({
        tipoCliente: 'arquiteto',
        descontoGlobal: 5,
        itens: [criarItemAntigo('a', PRODUTO_LINEAR, 7.345, 0, 0, 'arquiteto')],
        produtosAcabados: [{ id: 'prod-1', nome: 'Cortina', ambiente: 'Sala', itens: [criarItemAntigo('b', PRODUTO_M2, 2, 3.5, 2.85, 'arquiteto')] }],
        valoresInstalacao: { Sala: 200 }
    });
    const copia = structuredClone(antigo);
    congelarProfundamente(antigo);

    obterPercentualComissao(antigo);
    percentualComissaoEstaGravado(antigo);
    calcularTotaisOrcamento(antigo);
    obterPrecosBaseDoItem(antigo.itens[0], 10);
    calcularIndicadoresDoItem(antigo.produtosAcabados[0].itens[0], 10);
    somarIndicadoresDosItens(antigo.itens, 10);

    assert.deepEqual(antigo, copia);
    assert.equal('percentualComissao' in antigo.infoComercial, false);
    assert.equal(antigo.infoGerais.tipoCliente, 'arquiteto');
});

test('duplicação grava o percentual efetivo, copia bases e valores e não reprecifica', () => {
    const originais = [
        criarOrcamento({ tipoCliente: 'arquiteto', descontoGlobal: 5, itens: [criarItemAntigo('a', PRODUTO_M2, 2, 3.5, 2.85, 'arquiteto')] }),
        criarOrcamento({ tipoCliente: 'cliente', itens: [criarItemAntigo('a', PRODUTO_UNIDADE, 1, 0, 0, 'cliente')] }),
        criarOrcamento({ percentualComissao: 7.5, descontoGlobal: 10, itens: [criarItem('a', PRODUTO_ARREDONDAMENTO, 3, 0, 0, 7.5)] }),
        criarOrcamento({ tipoCliente: 'arquiteto', percentualComissao: 0, itens: [criarItem('a', PRODUTO_UNIDADE, 1, 0, 0, 0)] })
    ];

    originais.forEach((original, indice) => {
        const antes = structuredClone(original);
        const copia = criarOrcamentoDuplicado(original, { novoId: 'ORC-61', dataOrcamento: '2026-09-17' });

        assert.equal(copia.infoComercial.percentualComissao, obterPercentualComissao(original), String(indice));
        assert.equal(percentualComissaoEstaGravado(copia), true);
        assert.equal('tipoCliente' in copia.infoGerais, false);
        assert.equal(copia.infoGerais.nomeComissionado, 'Arquiteta Teste');
        assert.equal(copia.infoComercial.descontoGlobal, original.infoComercial.descontoGlobal);
        assert.deepEqual(copia.itens, original.itens);
        assert.equal(copia.statusDocumento, 'orcamento');

        // Mesmos valores ao cliente e mesma comissão, sem depender do tipo de cliente.
        const totaisOriginal = calcularTotaisOrcamento(original);
        const totaisCopia = calcularTotaisOrcamento(copia);
        assert.deepEqual(totaisCopia.centavos, totaisOriginal.centavos, String(indice));
        assert.deepEqual(original, antes);
    });
});

test('pedido confirmado grava o percentual e bloqueia a alteração da comissão', () => {
    const auditoria = { confirmadoEm: '2026-09-17T12:00:00.000Z', confirmadoPor: 'usuario-teste' };

    // Documento antigo de arquiteto: a confirmação registra os 10% efetivos.
    const antigo = criarOrcamento({ tipoCliente: 'arquiteto', itens: [criarItemAntigo('a', PRODUTO_UNIDADE, 1, 0, 0, 'arquiteto')] });
    const pedidoAntigo = confirmarOrcamentoComoPedido(antigo, auditoria);
    assert.equal(pedidoAntigo.infoComercial.percentualComissao, 10);
    assert.equal(pedidoAntigo.statusDocumento, 'pedido');
    assert.equal(pedidoAntigo.pedido.versaoSnapshot, 1);
    assert.equal(pedidoAntigo.pedido.confirmadoEm, auditoria.confirmadoEm);
    assert.equal(pedidoAntigo.pedido.itens[0].precoVendaTotal, 1100);
    assert.equal('percentualComissao' in antigo.infoComercial, false);
    assert.equal(pedidoAntigo.infoGerais.tipoCliente, 'arquiteto');

    // Documento antigo de cliente final grava 0%; percentual já gravado não é sobrescrito.
    assert.equal(confirmarOrcamentoComoPedido(criarOrcamento({ tipoCliente: 'cliente' }), auditoria).infoComercial.percentualComissao, 0);
    assert.equal(confirmarOrcamentoComoPedido(criarOrcamento({ tipoCliente: 'arquiteto', percentualComissao: 7.5 }), auditoria).infoComercial.percentualComissao, 7.5);
    // Percentual gravado inválido é substituído pelo efetivo.
    assert.equal(confirmarOrcamentoComoPedido(criarOrcamento({ tipoCliente: 'arquiteto', percentualComissao: 150 }), auditoria).infoComercial.percentualComissao, 10);

    const copiaPedido = structuredClone(pedidoAntigo);
    assert.throws(() => alterarPercentualComissao(pedidoAntigo, 5), /Pedidos confirmados não permitem alterar a comissão/);
    assert.throws(() => confirmarOrcamentoComoPedido(pedidoAntigo, auditoria), /já foi confirmado/);
    assert.deepEqual(pedidoAntigo, copiaPedido);

    const perdido = marcarOrcamentoComoPerdido(criarOrcamento({ percentualComissao: 10 }), { alteradoEm: auditoria.confirmadoEm });
    assert.throws(() => alterarPercentualComissao(perdido, 5), /Reabra a negociação/);
    assert.throws(() => confirmarOrcamentoComoPedido(perdido, auditoria), /Reabra a negociação/);
});

test('equivalência: documentos sem comissão e antigos mantêm os valores ao cliente antes de alteração manual', () => {
    const referencia = orcamento => {
        // Fórmula anterior da proposta: soma de precoTotal, desconto sobre o subtotal e instalação à parte.
        const itens = [...(orcamento.itens || []), ...(orcamento.produtosAcabados || []).flatMap(produto => produto.itens || [])];
        const subtotal = itens.reduce((soma, item) => soma + (item.precoTotal || 0), 0);
        const desconto = subtotal * (Math.min(100, Math.max(0, Number(orcamento.infoComercial?.descontoGlobal) || 0)) / 100);
        return { subtotal, desconto, total: subtotal - desconto };
    };
    const documentos = [
        // Sem campo de tipo de cliente nem percentual.
        { id: 'ORC-70', infoComercial: { descontoGlobal: 5 }, itens: [criarItemAntigo('a', PRODUTO_LINEAR, 7.345, 0, 0, 'cliente')] },
        criarOrcamento({ tipoCliente: 'cliente', descontoGlobal: 12.5, itens: [criarItemAntigo('a', PRODUTO_M2, 2, 3.5, 2.85, 'cliente')] }),
        criarOrcamento({ tipoCliente: 'arquiteto', descontoGlobal: 7.5, itens: [criarItemAntigo('a', PRODUTO_M2, 2, 3.5, 2.85, 'arquiteto'), criarItemAntigo('b', PRODUTO_ARREDONDAMENTO, 3, 0, 0, 'arquiteto')] })
    ];

    documentos.forEach(documento => {
        const esperado = referencia(documento);
        const totais = calcularTotaisOrcamento(documento);
        assert.equal(totais.subtotalProdutos, esperado.subtotal, documento.id);
        assert.equal(totais.descontoValor, esperado.desconto, documento.id);
        assert.equal(totais.totalProdutos, esperado.total, documento.id);
        assert.deepEqual(totais.avisos, []);
    });
});
