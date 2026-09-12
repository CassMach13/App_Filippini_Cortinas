import assert from 'node:assert/strict';
import test from 'node:test';
import {
    arredondamentoFinanceiro,
    calcularDetalhesItem,
    calcularPrecoFinal,
    calcularTotaisProposta,
    validarParametrosItem
} from '../pricing-domain.js';

test('calcula e arredonda o preço final do catálogo', () => {
    assert.equal(calcularPrecoFinal('38.73', '1.5'), 58.095);
    assert.equal(arredondamentoFinanceiro(58.095), 58.10);
});

test('calcula item por unidade para cliente final', () => {
    const resultado = calcularDetalhesItem(
        { unidadeMedida: 'Unidade', precoCompra: 10, markup: 2 },
        3,
        0,
        0,
        'cliente'
    );

    assert.equal(resultado.quantidadeCompra, 3);
    assert.equal(resultado.precoUnitario, 20);
    assert.equal(resultado.precoTotal, 60);
    assert.equal(resultado.custoReal, 30);
    assert.equal(resultado.valorComissao, 0);
    assert.equal(resultado.margemLiquida, 30);
    assert.equal(resultado.margemPercentual, 50);
});

test('calcula comissão de arquiteto preservando a margem líquida atual', () => {
    const resultado = calcularDetalhesItem(
        { unidadeMedida: 'Unidade', precoCompra: 10, markup: 2 },
        3,
        0,
        0,
        'arquiteto'
    );

    assert.equal(resultado.precoUnitario, 22);
    assert.equal(resultado.precoTotal, 66);
    assert.equal(resultado.valorComissao, 6);
    assert.equal(resultado.margemLiquida, 30);
});

test('calcula metro linear e preserva a largura padrão do material', () => {
    const resultado = calcularDetalhesItem(
        { unidadeMedida: 'MetroLinear', precoCompra: 12.5, markup: 1.5, alturaPadrao: 2.8 },
        7.5,
        0,
        0,
        'cliente'
    );

    assert.equal(resultado.quantidadeCompra, 7.5);
    assert.equal(resultado.alturaSalva, 2.8);
    assert.equal(resultado.precoUnitario, 18.75);
    assert.equal(resultado.precoTotal, 140.63);
    assert.equal(resultado.calculoTexto, '7.500 metro(s)');
});

test('calcula metro quadrado multiplicando medidas e peças', () => {
    const resultado = calcularDetalhesItem(
        { unidadeMedida: 'MetroQuadrado', precoCompra: 10, markup: 2 },
        2,
        3.5,
        2.85,
        'cliente'
    );

    assert.equal(resultado.quantidadeCompra, 19.95);
    assert.equal(resultado.precoTotal, 399);
    assert.equal(resultado.custoReal, 199.5);
    assert.equal(resultado.margemLiquida, 199.5);
});

test('rejeita quantidade inválida também para metro quadrado', () => {
    const produto = { unidadeMedida: 'MetroQuadrado' };
    assert.match(validarParametrosItem(produto, 0, 3, 2), /quantidade/i);
    assert.match(validarParametrosItem(produto, 1, 0, 2), /largura e altura/i);
    assert.equal(validarParametrosItem(produto, 1, 3, 2), null);
});

test('calcula desconto somente nos produtos e soma a instalação depois', () => {
    const resultado = calcularTotaisProposta({
        subtotalProdutos: 1000,
        margemProdutos: 400,
        totalInstalacao: 220,
        descontoPercentual: 5
    });

    assert.equal(resultado.descontoValor, 50);
    assert.equal(resultado.totalProdutos, 950);
    assert.equal(resultado.margemComDesconto, 350);
    assert.equal(resultado.totalGeral, 1170);
    assert.ok(Math.abs(resultado.margemPercentual - 36.8421052632) < 0.000001);
});

test('limita desconto a 100% e mantém a instalação fora dele', () => {
    const resultado = calcularTotaisProposta({
        subtotalProdutos: 1000,
        margemProdutos: 400,
        totalInstalacao: 220,
        descontoPercentual: 150
    });

    assert.equal(resultado.descontoPercentual, 100);
    assert.equal(resultado.totalProdutos, 0);
    assert.equal(resultado.totalGeral, 220);
    assert.equal(resultado.margemPercentual, -100);
});
