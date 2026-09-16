import assert from 'node:assert/strict';
import test from 'node:test';

import {
    FUSO_HORARIO_SISTEMA,
    compararDatasCivis,
    converterInstanteParaDataCivil,
    dataCivilEstaNoPeriodo,
    ehDataCivilValida,
    obterDataCivilAtual
} from '../date-domain.js';

test('usa o fuso de Brasília como padrão do sistema', () => {
    assert.equal(FUSO_HORARIO_SISTEMA, 'America/Sao_Paulo');
});

test('converte instantes para o dia civil de Brasília na virada do dia', () => {
    assert.equal(converterInstanteParaDataCivil('2026-10-01T02:59:59.999Z'), '2026-09-30');
    assert.equal(converterInstanteParaDataCivil('2026-10-01T03:00:00.000Z'), '2026-10-01');

    // Confirmação às 22h de 30/09 em Brasília: o padrão antigo em UTC já apontaria 01/10.
    const confirmadoEm = new Date('2026-09-30T22:00:00-03:00').toISOString();
    assert.equal(confirmadoEm, '2026-10-01T01:00:00.000Z');
    assert.equal(confirmadoEm.split('T')[0], '2026-10-01');
    assert.equal(converterInstanteParaDataCivil(confirmadoEm), '2026-09-30');
});

test('considera o horário de verão histórico de Brasília', () => {
    // Entre 04/11/2018 e 17/02/2019 Brasília usou UTC-2; um deslocamento fixo de -3h erraria o dia.
    assert.equal(converterInstanteParaDataCivil('2018-11-04T02:30:00Z'), '2018-11-03');
    assert.equal(converterInstanteParaDataCivil('2018-11-04T03:00:00Z'), '2018-11-04');
    assert.equal(converterInstanteParaDataCivil('2019-01-15T01:59:59Z'), '2019-01-14');
    assert.equal(converterInstanteParaDataCivil('2019-01-15T02:30:00Z'), '2019-01-15');
    assert.equal(converterInstanteParaDataCivil('2019-02-17T02:30:00Z'), '2019-02-16');
});

test('aceita Date e timestamp e rejeita instantes ambíguos ou inválidos', () => {
    assert.equal(converterInstanteParaDataCivil(new Date('2026-09-16T12:00:00Z')), '2026-09-16');
    assert.equal(converterInstanteParaDataCivil(Date.UTC(2026, 8, 17, 2, 0)), '2026-09-16');
    assert.equal(converterInstanteParaDataCivil('2026-09-16T23:30:00+00:00'), '2026-09-16');
    assert.equal(converterInstanteParaDataCivil('2026-09-16T23:30:00Z', 'UTC'), '2026-09-16');

    // Data sem horário não é instante: new Date('2026-09-30') cairia no dia 29 em Brasília.
    assert.equal(converterInstanteParaDataCivil('2026-09-30'), null);
    // Sem fuso explícito, o resultado dependeria do relógio da máquina.
    assert.equal(converterInstanteParaDataCivil('2026-09-30T10:00:00'), null);
    assert.equal(converterInstanteParaDataCivil('texto'), null);
    assert.equal(converterInstanteParaDataCivil(new Date('inválida')), null);
    assert.equal(converterInstanteParaDataCivil(Number.NaN), null);
    assert.equal(converterInstanteParaDataCivil(null), null);
    assert.equal(converterInstanteParaDataCivil(undefined), null);
    assert.equal(converterInstanteParaDataCivil(''), null);
});

test('obtém a data atual de Brasília a partir do relógio informado', () => {
    assert.equal(obterDataCivilAtual(new Date('2026-09-17T02:30:00Z')), '2026-09-16');
    assert.equal(obterDataCivilAtual(new Date('2026-09-17T03:00:00Z')), '2026-09-17');
    assert.equal(ehDataCivilValida(obterDataCivilAtual()), true);
});

test('valida datas civis reais no formato AAAA-MM-DD', () => {
    ['2026-09-16', '2028-02-29', '2026-12-31', '2026-01-01'].forEach(data => {
        assert.equal(ehDataCivilValida(data), true, data);
    });

    ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-9-1', '16/09/2026', '2026-09-16T00:00:00Z', '', null, undefined, 20260916]
        .forEach(data => {
            assert.equal(ehDataCivilValida(data), false, String(data));
        });
});

test('compara datas civis e rejeita datas inválidas', () => {
    assert.equal(compararDatasCivis('2026-09-15', '2026-09-16'), -1);
    assert.equal(compararDatasCivis('2026-09-16', '2026-09-16'), 0);
    assert.equal(compararDatasCivis('2026-10-01', '2026-09-30'), 1);
    assert.equal(compararDatasCivis('2025-12-31', '2026-01-01'), -1);

    assert.throws(() => compararDatasCivis('2026-02-30', '2026-09-16'), TypeError);
    assert.throws(() => compararDatasCivis('2026-09-16', ''), TypeError);
});

test('verifica períodos incluindo as duas pontas', () => {
    assert.equal(dataCivilEstaNoPeriodo('2026-09-01', '2026-09-01', '2026-09-30'), true);
    assert.equal(dataCivilEstaNoPeriodo('2026-09-15', '2026-09-01', '2026-09-30'), true);
    assert.equal(dataCivilEstaNoPeriodo('2026-09-30', '2026-09-01', '2026-09-30'), true);
    assert.equal(dataCivilEstaNoPeriodo('2026-08-31', '2026-09-01', '2026-09-30'), false);
    assert.equal(dataCivilEstaNoPeriodo('2026-10-01', '2026-09-01', '2026-09-30'), false);

    // Documento sem data fica fora do período; período inválido é erro de quem chama.
    assert.equal(dataCivilEstaNoPeriodo('', '2026-09-01', '2026-09-30'), false);
    assert.equal(dataCivilEstaNoPeriodo(undefined, '2026-09-01', '2026-09-30'), false);
    assert.throws(() => dataCivilEstaNoPeriodo('2026-09-15', '2026-09-01', '30/09/2026'), TypeError);

    const confirmacao = converterInstanteParaDataCivil('2026-10-01T01:00:00.000Z');
    assert.equal(dataCivilEstaNoPeriodo(confirmacao, '2026-09-01', '2026-09-30'), true);
    assert.equal(dataCivilEstaNoPeriodo(confirmacao, '2026-10-01', '2026-10-31'), false);
});
