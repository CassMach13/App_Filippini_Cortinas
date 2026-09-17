import { dataCivilEstaNoPeriodo, ehDataCivilValida } from './date-domain.js';
import {
    pedidoEstaCancelado,
    pedidoEstaConfirmado,
    pedidoParticipaFinanceiro,
    validarSnapshotPedidoV2
} from './order-domain.js';

// Relatório de vendas: a única fonte financeira é o snapshot v2 congelado na confirmação
// (pedido.financeiro), nunca o orçamento vivo nem o catálogo. Pedidos v1 e snapshots v2 inválidos
// ou cancelados nunca entram nas somas; um pedido cancelado é contado à parte, apenas como
// informação, quando a venda original caiu dentro do período.

function compararRegistrosDeVenda(vendaA, vendaB) {
    // Mais recentes primeiro: dataVenda, depois confirmadoEm, depois o ID como desempate estável.
    return vendaB.dataVenda.localeCompare(vendaA.dataVenda)
        || vendaB.confirmadoEm.localeCompare(vendaA.confirmadoEm)
        || String(vendaA.orcamentoId).localeCompare(String(vendaB.orcamentoId), 'pt-BR', { numeric: true });
}

export function gerarRelatorioVendas(orcamentos, { dataInicial, dataFinal } = {}) {
    if (!ehDataCivilValida(dataInicial) || !ehDataCivilValida(dataFinal)) {
        throw new TypeError('O período do relatório precisa de datas civis válidas (AAAA-MM-DD).');
    }
    if (dataInicial > dataFinal) {
        throw new RangeError('A data inicial não pode ser depois da data final.');
    }

    const lista = Array.isArray(orcamentos) ? orcamentos : Object.values(orcamentos || {});
    const vendas = [];
    const inconsistencias = [];
    let quantidadePedidosV1 = 0;
    let quantidadeCanceladosNoPeriodo = 0;

    lista.forEach(orcamento => {
        if (!orcamento || !pedidoEstaConfirmado(orcamento)) return; // orçamento em negociação ou perdido: fora
        const pedido = orcamento.pedido;

        if (pedido.versaoSnapshot === 1) {
            // Histórico anterior ao módulo financeiro: contado à parte, nunca somado.
            quantidadePedidosV1 += 1;
            return;
        }

        // Estrutura do snapshot v2, independente de estar cancelado ou não: reaproveita o validador
        // do domínio, sem duplicar suas regras.
        const estruturalmenteValido = pedido.orcamentoId === orcamento.id && validarSnapshotPedidoV2(pedido).valido;
        if (!estruturalmenteValido) {
            inconsistencias.push({ orcamentoId: orcamento.id, tipo: 'snapshot-v2-invalido' });
            return;
        }

        if (pedidoEstaCancelado(orcamento)) {
            // Cancelado nunca entra nas somas; só é contado se a venda original caiu no período.
            if (dataCivilEstaNoPeriodo(pedido.financeiro.dataVenda, dataInicial, dataFinal)) {
                quantidadeCanceladosNoPeriodo += 1;
            }
            return;
        }

        // Portão único e oficial de participação no financeiro (requisito da Etapa 3B2).
        if (!pedidoParticipaFinanceiro(orcamento)) return;
        if (!dataCivilEstaNoPeriodo(pedido.financeiro.dataVenda, dataInicial, dataFinal)) return;

        const financeiro = pedido.financeiro;
        vendas.push({
            orcamentoId: orcamento.id,
            dataVenda: financeiro.dataVenda,
            confirmadoEm: pedido.confirmadoEm,
            clienteNome: pedido.cliente.nome,
            produtosCobradoClienteCentavos: financeiro.valorProdutosCobradoClienteCentavos,
            comissaoCentavos: financeiro.valorComissaoCentavos,
            liquidoFilippiniCentavos: financeiro.valorLiquidoFilippiniCentavos
        });
    });

    vendas.sort(compararRegistrosDeVenda);

    const totais = vendas.reduce((soma, venda) => ({
        quantidadePedidos: soma.quantidadePedidos + 1,
        valorProdutosCobradoClienteCentavos: soma.valorProdutosCobradoClienteCentavos + venda.produtosCobradoClienteCentavos,
        valorComissaoCentavos: soma.valorComissaoCentavos + venda.comissaoCentavos,
        valorLiquidoFilippiniCentavos: soma.valorLiquidoFilippiniCentavos + venda.liquidoFilippiniCentavos
    }), {
        quantidadePedidos: 0,
        valorProdutosCobradoClienteCentavos: 0,
        valorComissaoCentavos: 0,
        valorLiquidoFilippiniCentavos: 0
    });

    return {
        periodo: { dataInicial, dataFinal },
        vendas,
        totais,
        quantidadePedidosV1,
        quantidadeCanceladosNoPeriodo,
        inconsistencias
    };
}
