import { compararDatasCivis, ehDataCivilValida } from './date-domain.js';
import { STATUS_DOCUMENTO, calcularTotaisOrcamento, obterStatusComercial } from './order-domain.js';

export const SITUACAO_FOLLOW_UP = Object.freeze({
    VENCIDO: 'vencido',
    HOJE: 'hoje',
    PROXIMO: 'proximo'
});

export function classificarFollowUp(dataFollowUp, hoje) {
    // Sem data válida não há follow-up agendado.
    if (!ehDataCivilValida(dataFollowUp)) return null;

    const comparacao = compararDatasCivis(dataFollowUp, hoje);
    if (comparacao < 0) return SITUACAO_FOLLOW_UP.VENCIDO;
    return comparacao === 0 ? SITUACAO_FOLLOW_UP.HOJE : SITUACAO_FOLLOW_UP.PROXIMO;
}

function compararRegistros(registroA, registroB) {
    return compararDatasCivis(registroA.dataFollowUp, registroB.dataFollowUp)
        || String(registroA.id).localeCompare(String(registroB.id), 'pt-BR', { numeric: true });
}

export function listarFollowUps(orcamentos, hoje) {
    // `hoje` é a data civil de Brasília (obterDataCivilAtual), recebida de fora para manter a função pura.
    if (!ehDataCivilValida(hoje)) {
        throw new TypeError('A data de referência deve estar no formato AAAA-MM-DD.');
    }

    const lista = Array.isArray(orcamentos) ? orcamentos : Object.values(orcamentos || {});
    const grupos = { vencidos: [], hoje: [], proximos: [] };
    const grupoPorSituacao = {
        [SITUACAO_FOLLOW_UP.VENCIDO]: grupos.vencidos,
        [SITUACAO_FOLLOW_UP.HOJE]: grupos.hoje,
        [SITUACAO_FOLLOW_UP.PROXIMO]: grupos.proximos
    };

    lista.forEach(orcamento => {
        // Pedidos confirmados e orçamentos perdidos saem da lista ativa.
        if (!orcamento || obterStatusComercial(orcamento) !== STATUS_DOCUMENTO.ORCAMENTO) return;

        const infoGerais = orcamento.infoGerais || {};
        const situacao = classificarFollowUp(infoGerais.proximoFollowUp, hoje);
        if (!situacao) return;

        grupoPorSituacao[situacao].push({
            id: orcamento.id,
            situacao,
            dataFollowUp: infoGerais.proximoFollowUp,
            observacao: infoGerais.observacaoFollowUp || '',
            nomeCliente: infoGerais.nomeCliente || '',
            celularCliente: infoGerais.celularCliente || '',
            nomeComissionado: infoGerais.nomeComissionado || '',
            celularComissionado: infoGerais.celularComissionado || '',
            // Total da proposta ao cliente, o mesmo "Valor total geral da proposta": produtos com
            // desconto e comissão vigente, mais instalação. Não é o valor financeiro nem o faturamento
            // da Filippini, que terão base própria (sem instalação).
            totalPropostaCliente: calcularTotaisOrcamento(orcamento).totalGeral
        });
    });

    // Vencidos: mais antigos primeiro. Próximos: mais próximos primeiro.
    Object.values(grupos).forEach(grupo => grupo.sort(compararRegistros));
    return grupos;
}
