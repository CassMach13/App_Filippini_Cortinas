// Datas civis (AAAA-MM-DD) no fuso do sistema.
// Evita `toISOString().split('T')[0]`, que usa o dia em UTC: em Brasília, a partir das 21h
// esse padrão já devolve o dia seguinte.

export const FUSO_HORARIO_SISTEMA = 'America/Sao_Paulo';

const PADRAO_DATA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;
// Instantes precisam de horário e fuso explícitos; sem fuso, o navegador usaria o horário local da máquina.
const PADRAO_INSTANTE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const formatadoresPorFuso = new Map();

function obterFormatador(fusoHorario) {
    if (!formatadoresPorFuso.has(fusoHorario)) {
        formatadoresPorFuso.set(fusoHorario, new Intl.DateTimeFormat('en-US', {
            timeZone: fusoHorario,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }));
    }
    return formatadoresPorFuso.get(fusoHorario);
}

export function ehDataCivilValida(valor) {
    const partes = typeof valor === 'string' ? valor.match(PADRAO_DATA_CIVIL) : null;
    if (!partes) return false;

    const [ano, mes, dia] = partes.slice(1).map(Number);
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

export function converterInstanteParaDataCivil(instante, fusoHorario = FUSO_HORARIO_SISTEMA) {
    let data = null;
    if (instante instanceof Date) {
        data = instante;
    } else if (typeof instante === 'number') {
        data = new Date(instante);
    } else if (typeof instante === 'string' && PADRAO_INSTANTE_ISO.test(instante)) {
        data = new Date(instante);
    }

    if (!data || Number.isNaN(data.getTime())) return null;

    const partes = Object.fromEntries(
        obterFormatador(fusoHorario).formatToParts(data).map(({ type, value }) => [type, value])
    );
    return `${partes.year.padStart(4, '0')}-${partes.month}-${partes.day}`;
}

export function obterDataCivilAtual(agora = new Date(), fusoHorario = FUSO_HORARIO_SISTEMA) {
    return converterInstanteParaDataCivil(agora, fusoHorario);
}

export function compararDatasCivis(dataA, dataB) {
    if (!ehDataCivilValida(dataA) || !ehDataCivilValida(dataB)) {
        throw new TypeError('As datas comparadas devem ser válidas e estar no formato AAAA-MM-DD.');
    }
    if (dataA === dataB) return 0;
    return dataA < dataB ? -1 : 1;
}

export function dataCivilEstaNoPeriodo(data, inicio, fim) {
    // O período inclui as duas pontas. Datas ausentes ou inválidas no documento ficam fora;
    // um período inválido é erro de quem chama.
    if (!ehDataCivilValida(data)) return false;
    return compararDatasCivis(data, inicio) >= 0 && compararDatasCivis(data, fim) <= 0;
}
