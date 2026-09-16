import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ehCelularValido,
    formatarCelular,
    gerarLinkWhatsApp,
    normalizarCelular
} from '../contact-domain.js';

test('documento antigo sem celular continua válido e sem link de WhatsApp', () => {
    [undefined, null, '', '   '].forEach(valor => {
        assert.equal(normalizarCelular(valor), '', String(valor));
        assert.equal(formatarCelular(valor), '', String(valor));
        assert.equal(gerarLinkWhatsApp(valor), null, String(valor));
        assert.equal(ehCelularValido(valor), false, String(valor));
    });
});

test('aceita celular brasileiro digitado com formatação e armazena somente dígitos', () => {
    [
        '(11) 98765-4321',
        '11 98765-4321',
        '11987654321',
        '11.98765.4321',
        '+55 11 98765-4321',
        '+55 (11) 98765-4321',
        '55 11 98765 4321',
        '5511987654321',
        '(011) 98765-4321',
        '011987654321'
    ].forEach(entrada => {
        assert.equal(normalizarCelular(entrada), '5511987654321', entrada);
        assert.equal(ehCelularValido(entrada), true, entrada);
    });
});

test('formata o celular normalizado para exibição e mantém a normalização estável', () => {
    assert.equal(formatarCelular('5511987654321'), '(11) 98765-4321');
    assert.equal(formatarCelular('(21) 99876-5432'), '(21) 99876-5432');
    assert.equal(normalizarCelular(formatarCelular('5511987654321')), '5511987654321');
    assert.equal(normalizarCelular(normalizarCelular('11 98765-4321')), '5511987654321');

    // DDD 55 (RS) com 11 dígitos não é confundido com o código do país.
    assert.equal(normalizarCelular('(55) 99876-5432'), '5555998765432');
    assert.equal(formatarCelular('5555998765432'), '(55) 99876-5432');
});

test('rejeita celular inválido sem presumir DDD nem gerar link', () => {
    [
        '98765-4321',
        '987654321',
        '(11) 8765-4321',
        '(11) 88765-4321',
        '(20) 98765-4321',
        '(00) 98765-4321',
        '+1 415 555 2671',
        '0 21 11 98765-4321',
        '11 98765-4321 ramal 2',
        'celular',
        '11987654321999'
    ].forEach(entrada => {
        assert.equal(normalizarCelular(entrada), null, entrada);
        assert.equal(ehCelularValido(entrada), false, entrada);
        assert.equal(gerarLinkWhatsApp(entrada), null, entrada);
    });

    // Um valor inválido já gravado continua visível para correção.
    assert.equal(formatarCelular(' 98765-4321 '), '98765-4321');
});

test('cliente e comissionado mantêm números e links independentes', () => {
    const infoGerais = {
        celularCliente: normalizarCelular('(11) 98765-4321'),
        celularComissionado: normalizarCelular('(21) 99876-5432')
    };

    assert.equal(infoGerais.celularCliente, '5511987654321');
    assert.equal(infoGerais.celularComissionado, '5521998765432');
    assert.notEqual(gerarLinkWhatsApp(infoGerais.celularCliente), gerarLinkWhatsApp(infoGerais.celularComissionado));
    assert.equal(gerarLinkWhatsApp(infoGerais.celularComissionado), 'https://wa.me/5521998765432');
});

test('gera link do WhatsApp no formato wa.me com o número internacional', () => {
    assert.equal(gerarLinkWhatsApp('5511987654321'), 'https://wa.me/5511987654321');
    assert.equal(gerarLinkWhatsApp('(11) 98765-4321'), 'https://wa.me/5511987654321');
    assert.match(gerarLinkWhatsApp('+55 (48) 99123-4567'), /^https:\/\/wa\.me\/55\d{11}$/);
});
