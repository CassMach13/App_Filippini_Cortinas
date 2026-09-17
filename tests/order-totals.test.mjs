import assert from 'node:assert/strict';
import test from 'node:test';

import {
    calcularTotaisOrcamento,
    criarSnapshotPedido,
    obterTotaisDoPedido
} from '../order-domain.js';
import {
    arredondamentoFinanceiro,
    calcularPrecoFinal,
    calcularTotaisProposta,
    converterValorParaCentavos,
    normalizarUnidadeMedida
} from '../pricing-domain.js';

const formatadorMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
// Valores que o cliente vê na proposta; não podem mudar para documentos antigos.
const CAMPOS_TOTAIS_PEDIDO = [
    'subtotalProdutos',
    'descontoPercentual',
    'descontoValor',
    'totalProdutos',
    'totalInstalacao',
    'totalGeral'
];

// Reprodução literal da regra de item anterior à comissão configurável (calcularDetalhesItem com
// tipoCliente), usada para gerar documentos antigos como os que existem no Firestore.
function calcularItemComoRegraAntiga(produtoBase, quantidade, largura, altura, tipoCliente = 'cliente') {
    let quantidadeCompra = quantidade;
    let larguraSalva = null;
    let alturaSalva = null;
    if (normalizarUnidadeMedida(produtoBase.unidadeMedida) === 'MetroLinear') {
        alturaSalva = produtoBase.alturaPadrao ?? null;
    } else if (normalizarUnidadeMedida(produtoBase.unidadeMedida) === 'MetroQuadrado') {
        quantidadeCompra = largura * altura * quantidade;
        larguraSalva = largura;
        alturaSalva = altura;
    }

    const precoUnitarioBase = calcularPrecoFinal(produtoBase.precoCompra, produtoBase.markup);
    const percentualComissao = tipoCliente === 'arquiteto' ? 0.10 : 0;
    const precoUnitario = arredondamentoFinanceiro(precoUnitarioBase * (1 + percentualComissao), 2);
    const precoTotal = arredondamentoFinanceiro(precoUnitario * quantidadeCompra, 2);
    const custoReal = produtoBase.precoCompra * quantidadeCompra;
    const valorComissao = precoUnitarioBase * percentualComissao * quantidadeCompra;
    const margemLiquida = precoTotal - custoReal - valorComissao;
    const margemPercentual = precoTotal > 0 ? (margemLiquida / precoTotal) * 100 : 0;

    return { quantidadeCompra, larguraSalva, alturaSalva, precoUnitario, precoTotal, custoReal, valorComissao, margemLiquida, margemPercentual };
}

// Reprodução literal do cálculo da interface antes da comissão configurável, usada como referência de
// equivalência: renderizarItensOrcamento, calcularTotalInstalacao, preencherInfoOrcamento e atualizarPropostaCliente.
function calcularComoInterfaceAnterior(orcamento) {
    const todosOsItens = [...(orcamento.itens || []), ...(orcamento.produtosAcabados || []).flatMap(p => p.itens || [])];
    const totalOrcamento = todosOsItens.reduce((sum, item) => sum + (item.precoTotal || 0), 0);
    const totalMargemProposta = todosOsItens.reduce((sum, item) => sum + (item.margemLiquida || 0), 0);
    const margemPercentualProposta = totalOrcamento > 0 ? (totalMargemProposta / totalOrcamento) * 100 : 0;

    let totalInstalacao = 0;
    if (orcamento.valoresInstalacao) {
        for (const ambiente in orcamento.valoresInstalacao) {
            totalInstalacao += parseFloat(orcamento.valoresInstalacao[ambiente]) || 0;
        }
    }

    const valorDoCampoDesconto = String((orcamento.infoComercial || {}).descontoGlobal || 0);
    const descontoGlobal = Math.min(100, Math.max(0, parseFloat(valorDoCampoDesconto) || 0));
    const totaisProposta = calcularTotaisProposta({
        subtotalProdutos: totalOrcamento || 0,
        margemProdutos: totalMargemProposta || 0,
        totalInstalacao: totalInstalacao || 0,
        descontoPercentual: descontoGlobal
    });

    return {
        subtotalProdutos: totalOrcamento,
        margemProdutos: totalMargemProposta,
        margemProdutosPercentual: margemPercentualProposta,
        ...totaisProposta
    };
}

function selecionarCampos(objeto, campos) {
    return Object.fromEntries(campos.map(campo => [campo, objeto[campo]]));
}

function exibirMoeda(valor) {
    // O Intl separa "R$" do número com espaço não separável.
    return formatadorMoeda.format(valor).replace(/\s/g, ' ');
}

function centavosExibidos(valor) {
    const texto = formatadorMoeda.format(valor);
    const centavos = Number(texto.replace(/[^\d]/g, ''));
    // "-R$ 0,00" representa zero centavos.
    return (texto.includes('-') ? -centavos : centavos) || 0;
}

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

function gerarOrcamentoAleatorio(aleatorio, indice) {
    const escolher = lista => lista[Math.floor(aleatorio() * lista.length)];
    const inteiro = (minimo, maximo) => minimo + Math.floor(aleatorio() * (maximo - minimo + 1));
    const tipoCliente = escolher(['cliente', 'arquiteto']);
    const ambientes = [];
    let contadorItens = 0;

    const criarItem = ambiente => {
        const numero = contadorItens++;
        const unidadeMedida = escolher(['Unidade', 'MetroLinear', 'MetroQuadrado']);
        const produto = {
            unidadeMedida,
            precoCompra: inteiro(1, 60000) / 100,
            markup: escolher([1.5, 1.8, 2, 2.2, 2.35, 2.5, 3, inteiro(110, 350) / 100]),
            alturaPadrao: 2.8
        };
        const quantidade = unidadeMedida === 'MetroLinear' ? inteiro(500, 30000) / 1000 : inteiro(1, 6);
        const detalhes = calcularItemComoRegraAntiga(produto, quantidade, inteiro(30, 400) / 100, inteiro(30, 320) / 100, tipoCliente);

        return {
            id: `item-${indice}-${numero}`,
            ambiente,
            codigo: `COD-${numero}`,
            descricao: `Item ${numero}`,
            fornecedor: escolher(['Fornecedor A', 'Fornecedor B']),
            unidadeMedida,
            quantidade,
            largura: detalhes.larguraSalva,
            altura: detalhes.alturaSalva,
            precoUnitario: detalhes.precoUnitario,
            precoTotal: detalhes.precoTotal,
            custoReal: detalhes.custoReal,
            quantidadeCompra: detalhes.quantidadeCompra,
            precoCompraUnitario: produto.precoCompra,
            margemLiquida: detalhes.margemLiquida,
            margemPercentual: detalhes.margemPercentual,
            valorComissao: detalhes.valorComissao
        };
    };

    const orcamento = {
        id: `ORC-${indice}`,
        statusDocumento: 'orcamento',
        infoGerais: { nomeCliente: `Cliente ${indice}`, tipoCliente }
    };

    if (aleatorio() < 0.85) {
        orcamento.produtosAcabados = Array.from({ length: inteiro(0, 6) }, (_, posicao) => {
            const ambiente = `Ambiente ${posicao + 1}`;
            ambientes.push(ambiente);
            const produto = { id: `prod-${indice}-${posicao}`, nome: `Produto ${posicao + 1}`, ambiente };
            if (aleatorio() < 0.9) produto.itens = Array.from({ length: inteiro(0, 4) }, () => criarItem(ambiente));
            return produto;
        });
    }
    if (aleatorio() < 0.85) {
        orcamento.itens = Array.from({ length: inteiro(0, 4) }, () => criarItem('Itens Avulsos'));
    }
    if (aleatorio() < 0.75) {
        orcamento.valoresInstalacao = {};
        [...ambientes, 'Itens Avulsos', 'Ambiente removido'].forEach(ambiente => {
            if (aleatorio() < 0.7) {
                orcamento.valoresInstalacao[ambiente] = escolher([
                    0,
                    inteiro(0, 250000) / 100,
                    inteiro(0, 250000) / 100,
                    `${inteiro(0, 900)},${inteiro(10, 99)}`
                ]);
            }
        });
    }
    if (aleatorio() < 0.8) {
        orcamento.infoComercial = { condicaoPagamento: 'À vista' };
        if (aleatorio() < 0.9) {
            orcamento.infoComercial.descontoGlobal = escolher([0, 2.5, 3.33, 5, 7, 7.5, 10, 12.5, 15, inteiro(0, 2000) / 100, 100, 150, -5]);
        }
    }
    if (aleatorio() < 0.3) {
        orcamento.totais = { totalProdutos: 999999, totalInstalacao: 123, totalMargemProposta: 1 };
    }

    return orcamento;
}

function gerarOrcamentos(quantidade, semente) {
    const aleatorio = criarGeradorAleatorio(semente);
    return Array.from({ length: quantidade }, (_, indice) => gerarOrcamentoAleatorio(aleatorio, indice));
}

function confirmarComoPedido(orcamento) {
    return {
        ...structuredClone(orcamento),
        statusDocumento: 'pedido',
        pedido: criarSnapshotPedido(orcamento, {
            confirmadoEm: '2026-09-16T15:00:00.000Z',
            confirmadoPor: 'usuario-teste'
        })
    };
}

function criarOrcamentoExemplo() {
    return {
        id: 'ORC-20',
        statusDocumento: 'orcamento',
        infoGerais: { nomeCliente: 'Cliente Teste', enderecoCliente: 'Endereço do cliente' },
        infoComercial: { descontoGlobal: 10 },
        valoresInstalacao: { Sala: 150, 'Itens Avulsos': 0 },
        produtosAcabados: [
            {
                id: 'prod-1',
                nome: 'Cortina Sala',
                ambiente: 'Sala',
                itens: [
                    { id: 'item-1', codigo: 'TEC-01', fornecedor: 'Fornecedor A', precoTotal: 125, margemLiquida: 75, custoReal: 50 },
                    { id: 'item-3', codigo: 'TRI-01', fornecedor: 'Fornecedor A', precoTotal: 60.5, margemLiquida: 30.25, custoReal: 30.25 }
                ]
            }
        ],
        itens: [
            { id: 'item-2', codigo: 'SUP-01', fornecedor: 'Fornecedor B', precoTotal: 40, margemLiquida: 24, custoReal: 16 }
        ]
    };
}

test('documentos antigos mantêm exatamente os valores exibidos ao cliente', () => {
    const orcamentos = gerarOrcamentos(2000, 20260916);
    let comDesconto = 0;
    let comInstalacao = 0;
    let deArquiteto = 0;

    orcamentos.forEach(orcamento => {
        const anterior = calcularComoInterfaceAnterior(orcamento);
        const totais = calcularTotaisOrcamento(orcamento);

        // Subtotal, desconto, total de produtos, instalação e total da proposta idênticos.
        assert.deepEqual(selecionarCampos(totais, CAMPOS_TOTAIS_PEDIDO), selecionarCampos(anterior, CAMPOS_TOTAIS_PEDIDO), orcamento.id);
        assert.deepEqual(totais.avisos, [], orcamento.id);

        if (orcamento.infoGerais.tipoCliente === 'arquiteto') {
            deArquiteto++;
            // Comissão oficial: 10% da base líquida, calculada no orçamento.
            assert.equal(totais.percentualComissao, 10);
            assert.equal(totais.centavos.valorComissao, converterValorParaCentavos(totais.centavos.baseLiquida / 1000), orcamento.id);
        } else {
            // Sem comissão a margem é a mesma de antes, a menos do arredondamento do total em centavos.
            assert.equal(totais.percentualComissao, 0);
            assert.equal(totais.valorComissao, 0);
            assert.ok(Math.abs(totais.margemProdutos - anterior.margemProdutos) < 1e-6, orcamento.id);
            assert.ok(Math.abs(totais.margemComDesconto - anterior.margemComDesconto) <= 0.0051, orcamento.id);
        }
        if (totais.descontoValor > 0) comDesconto++;
        if (totais.totalInstalacao > 0) comInstalacao++;
    });

    assert.ok(comDesconto > 500, 'a amostra precisa exercitar descontos');
    assert.ok(comInstalacao > 500, 'a amostra precisa exercitar instalação');
    assert.ok(deArquiteto > 500, 'a amostra precisa exercitar documentos antigos de arquiteto');
});

test('calcula o exemplo completo com produtos acabados, itens avulsos, instalação e desconto', () => {
    const totais = calcularTotaisOrcamento(criarOrcamentoExemplo());

    assert.equal(totais.quantidadeItens, 3);
    assert.equal(totais.subtotalProdutos, 225.5);
    assert.equal(totais.margemProdutos, 129.25);
    assert.equal(totais.descontoPercentual, 10);
    assert.equal(totais.descontoValor, 22.55);
    assert.equal(totais.totalProdutos, 202.95);
    assert.equal(totais.totalInstalacao, 150);
    assert.equal(totais.totalGeral, 352.95);
    assert.equal(totais.custoTotal, 96.25);
    assert.ok(Math.abs(totais.margemComDesconto - 106.7) < 1e-9);
    assert.deepEqual(totais.centavos, {
        subtotalProdutos: 22550,
        descontoValor: 2255,
        totalProdutos: 20295,
        totalInstalacao: 15000,
        totalGeral: 35295,
        subtotalSemComissao: 22550,
        descontoBase: 2255,
        baseLiquida: 20295,
        valorComissao: 0,
        liquidoFilippini: 20295,
        residuo: 0
    });
});

test('orçamento sem instalação soma apenas os produtos', () => {
    const semCampo = criarOrcamentoExemplo();
    delete semCampo.valoresInstalacao;
    const mapaVazio = { ...criarOrcamentoExemplo(), valoresInstalacao: {} };

    [semCampo, mapaVazio].forEach(orcamento => {
        const totais = calcularTotaisOrcamento(orcamento);
        assert.equal(totais.totalInstalacao, 0);
        assert.equal(totais.totalGeral, totais.totalProdutos);
        assert.equal(totais.totalGeral, 202.95);
    });
});

test('orçamento sem desconto mantém o total dos produtos', () => {
    const semInfoComercial = criarOrcamentoExemplo();
    delete semInfoComercial.infoComercial;
    const descontoZero = { ...criarOrcamentoExemplo(), infoComercial: { descontoGlobal: 0 } };
    const semCampoDesconto = { ...criarOrcamentoExemplo(), infoComercial: { formaPagamento: 'PIX' } };

    [semInfoComercial, descontoZero, semCampoDesconto].forEach(orcamento => {
        const totais = calcularTotaisOrcamento(orcamento);
        assert.equal(totais.descontoPercentual, 0);
        assert.equal(totais.descontoValor, 0);
        assert.equal(totais.totalProdutos, 225.5);
        assert.equal(totais.totalGeral, 375.5);
        assert.equal(totais.margemComDesconto, 129.25);
    });
});

test('aplica desconto somente aos produtos com os mesmos limites do campo da proposta', () => {
    const comDesconto = (descontoGlobal) => calcularTotaisOrcamento({
        ...criarOrcamentoExemplo(),
        infoComercial: { descontoGlobal }
    });

    assert.equal(comDesconto(10).totalInstalacao, 150);
    assert.equal(comDesconto(150).descontoPercentual, 100);
    assert.equal(comDesconto(150).totalProdutos, 0);
    assert.equal(comDesconto(150).totalGeral, 150);
    assert.equal(comDesconto(-5).descontoPercentual, 0);
    // Textos passam pela validação do <input type="number">, como acontece hoje na tela.
    assert.equal(comDesconto('12.5').descontoPercentual, 12.5);
    assert.equal(comDesconto('12,5').descontoPercentual, 0);
});

test('lê documentos antigos sem campos opcionais e não grava valores padrão', () => {
    const vazio = calcularTotaisOrcamento({ id: 'ORC-01' });
    assert.equal(vazio.quantidadeItens, 0);
    assert.equal(vazio.subtotalProdutos, 0);
    assert.equal(vazio.totalInstalacao, 0);
    assert.equal(vazio.totalGeral, 0);
    assert.deepEqual(calcularTotaisOrcamento(null), vazio);

    const somenteAvulsos = calcularTotaisOrcamento({ itens: [{ precoTotal: 80, custoReal: 40 }] });
    assert.equal(somenteAvulsos.subtotalProdutos, 80);
    assert.equal(somenteAvulsos.margemProdutosPercentual, 50);

    const produtoSemItens = calcularTotaisOrcamento({ produtosAcabados: [{ id: 'prod-1', nome: 'Sem itens' }] });
    assert.equal(produtoSemItens.quantidadeItens, 0);

    const comCacheDesatualizado = { ...criarOrcamentoExemplo(), totais: { totalProdutos: 999999, totalInstalacao: 1 } };
    assert.equal(calcularTotaisOrcamento(comCacheDesatualizado).totalGeral, 352.95);

    const documento = criarOrcamentoExemplo();
    delete documento.valoresInstalacao;
    delete documento.infoComercial;
    const original = structuredClone(documento);
    congelarProfundamente(documento);

    calcularTotaisOrcamento(documento);
    assert.deepEqual(documento, original);
    assert.equal('totais' in documento, false);
});

test('preserva a leitura atual de valores de instalação legados', () => {
    const totais = calcularTotaisOrcamento({
        itens: [{ precoTotal: 100 }],
        valoresInstalacao: {
            Sala: 120.5,
            // Ambiente sem itens continua somando, como em calcularTotalInstalacao.
            'Ambiente removido': 30,
            // Texto com vírgula é lido por parseFloat até a vírgula, como hoje.
            Quarto: '180,50',
            Varanda: 'sem valor'
        }
    });

    assert.equal(totais.totalInstalacao, 330.5);
    assert.equal(totais.totalGeral, 430.5);
});

test('pedido não confirmado não possui totais de pedido', () => {
    const orcamento = criarOrcamentoExemplo();

    assert.equal(obterTotaisDoPedido(orcamento), null);
    assert.equal(obterTotaisDoPedido({ ...orcamento, statusDocumento: 'pedido' }), null);
    assert.equal(obterTotaisDoPedido({ ...orcamento, statusDocumento: 'pedido', pedido: { itens: [] } }), null);
    assert.equal(obterTotaisDoPedido(null), null);
});

test('pedido versão 1 calcula os mesmos totais exibidos no momento da confirmação', () => {
    const orcamentos = gerarOrcamentos(2000, 1209)
        .filter(orcamento => calcularTotaisOrcamento(orcamento).quantidadeItens > 0);
    assert.ok(orcamentos.length > 1000);

    orcamentos.forEach(orcamento => {
        const pedido = confirmarComoPedido(orcamento);
        const totais = obterTotaisDoPedido(pedido);

        assert.equal(pedido.pedido.versaoSnapshot, 1);
        assert.equal(totais.origem, 'derivado');
        assert.equal(totais.versaoSnapshot, 1);
        assert.equal(totais.quantidadeItens, calcularTotaisOrcamento(orcamento).quantidadeItens);
        assert.deepEqual(
            selecionarCampos(totais, CAMPOS_TOTAIS_PEDIDO),
            selecionarCampos(calcularComoInterfaceAnterior(orcamento), CAMPOS_TOTAIS_PEDIDO),
            orcamento.id
        );
    });
});

test('pedido versão 1 soma primeiro os itens avulsos para não mudar o centavo exibido', () => {
    const orcamento = {
        id: 'ORC-30',
        infoComercial: { descontoGlobal: 5 },
        itens: [{ id: 'avulso-1', precoTotal: 862.03 }],
        produtosAcabados: [{
            id: 'prod-1',
            nome: 'Cortinas',
            ambiente: 'Sala',
            itens: [
                { id: 'item-1', precoTotal: 216.61 },
                { id: 'item-2', precoTotal: 240.12 },
                { id: 'item-3', precoTotal: 44.94 }
            ]
        }]
    };
    const pedido = confirmarComoPedido(orcamento);
    const somaNaOrdemDoSnapshot = pedido.pedido.itens.reduce((soma, item) => soma + item.precoVendaTotal, 0);
    const totalNaOrdemDoSnapshot = somaNaOrdemDoSnapshot - somaNaOrdemDoSnapshot * 0.05;

    assert.equal(exibirMoeda(calcularComoInterfaceAnterior(orcamento).totalProdutos), 'R$ 1.295,51');
    assert.equal(exibirMoeda(totalNaOrdemDoSnapshot), 'R$ 1.295,52');
    assert.equal(obterTotaisDoPedido(pedido).centavos.totalProdutos, 129551);
});

test('alterações posteriores no catálogo não mudam os totais do pedido confirmado', () => {
    const pedido = confirmarComoPedido(criarOrcamentoExemplo());
    const totaisNaConfirmacao = obterTotaisDoPedido(pedido);

    // Simula um recálculo dos itens a partir de novos preços do catálogo.
    pedido.produtosAcabados[0].itens.forEach(item => {
        item.precoTotal *= 2;
        item.custoReal *= 2;
    });
    pedido.itens[0].precoTotal = 999;

    assert.notEqual(calcularTotaisOrcamento(pedido).subtotalProdutos, totaisNaConfirmacao.subtotalProdutos);
    assert.deepEqual(obterTotaisDoPedido(pedido), totaisNaConfirmacao);
    assert.equal(totaisNaConfirmacao.totalGeral, 352.95);
});

test('snapshots futuros com totais armazenados prevalecem sobre o cálculo derivado', () => {
    const pedido = confirmarComoPedido(criarOrcamentoExemplo());
    pedido.pedido.versaoSnapshot = 2;
    pedido.pedido.totais = {
        subtotalProdutos: 1000,
        descontoPercentual: 5,
        descontoValor: 50,
        totalProdutos: 950,
        totalInstalacao: 200,
        totalGeral: 1150
    };

    const totais = obterTotaisDoPedido(pedido);
    assert.equal(totais.origem, 'snapshot');
    assert.equal(totais.versaoSnapshot, 2);
    assert.equal(totais.totalGeral, 1150);
    assert.deepEqual(totais.centavos, {
        subtotalProdutos: 100000,
        descontoValor: 5000,
        totalProdutos: 95000,
        totalInstalacao: 20000,
        totalGeral: 115000
    });

    pedido.pedido.totais = { totalGeral: 1150 };
    const incompletos = obterTotaisDoPedido(pedido);
    assert.equal(incompletos.origem, 'derivado');
    assert.equal(incompletos.totalGeral, 352.95);
});

test('converte valores para centavos com o mesmo arredondamento da exibição em moeda', () => {
    const casos = [
        [0, 0],
        [12.34, 1234],
        ['12.34', 1234],
        [5.005, 501],
        [1.005, 101],
        [1.115, 112],
        [9744.425, 974443],
        [35528.255, 3552826],
        [-2.675, -268],
        [0.005, 1],
        [0.004, 0],
        [-0.004, 0],
        [1e-7, 0],
        [1.5e21, 150000000000000000000000],
        [Number.NaN, 0],
        [Number.POSITIVE_INFINITY, 0],
        [undefined, 0]
    ];

    casos.forEach(([valor, centavos]) => {
        assert.equal(converterValorParaCentavos(valor), centavos, String(valor));
        assert.equal(Object.is(converterValorParaCentavos(valor), -0), false, String(valor));
    });

    // arredondamentoFinanceiro, usado nos itens, não serve para converter totais exibidos.
    assert.equal(arredondamentoFinanceiro(35528.255), 35528.25);

    const aleatorio = criarGeradorAleatorio(42);
    for (let indice = 0; indice < 50000; indice++) {
        const divisor = [1, 7, 100, 1000, 10000][indice % 5];
        const sinal = indice % 4 === 0 ? -1 : 1;
        const valor = sinal * Math.floor(aleatorio() * 1e9) / divisor;
        assert.equal(converterValorParaCentavos(valor), centavosExibidos(valor), String(valor));
    }

    gerarOrcamentos(500, 7).forEach(orcamento => {
        const totais = calcularTotaisOrcamento(orcamento);
        Object.entries(totais.centavos).forEach(([campo, centavos]) => {
            assert.equal(centavos, centavosExibidos(totais[campo]), `${orcamento.id} ${campo}`);
        });
    });
});

test('centavos de cada total seguem o valor exibido, mesmo quando a subtração não fecha', () => {
    const totais = calcularTotaisOrcamento({
        itens: [{ precoTotal: 100.1 }],
        infoComercial: { descontoGlobal: 5 }
    });

    assert.equal(exibirMoeda(totais.subtotalProdutos), 'R$ 100,10');
    assert.equal(exibirMoeda(totais.descontoValor), 'R$ 5,01');
    assert.equal(exibirMoeda(totais.totalProdutos), 'R$ 95,10');
    assert.deepEqual(
        [totais.centavos.subtotalProdutos, totais.centavos.descontoValor, totais.centavos.totalProdutos],
        [10010, 501, 9510]
    );
    assert.equal(totais.centavos.subtotalProdutos - totais.centavos.descontoValor, 9509);
});
