// Celulares brasileiros: armazenados só com dígitos, no formato 55 + DDD + 9 dígitos.
// O DDD nunca é presumido; sem ele o número é inválido e não gera link de WhatsApp.

const CODIGO_PAIS_BRASIL = '55';
const CARACTERES_PERMITIDOS = /^[\d\s()+.\-]+$/;
const DDDS_BRASILEIROS = new Set([
    '11', '12', '13', '14', '15', '16', '17', '18', '19',
    '21', '22', '24', '27', '28',
    '31', '32', '33', '34', '35', '37', '38',
    '41', '42', '43', '44', '45', '46', '47', '48', '49',
    '51', '53', '54', '55',
    '61', '62', '63', '64', '65', '66', '67', '68', '69',
    '71', '73', '74', '75', '77', '79',
    '81', '82', '83', '84', '85', '86', '87', '88', '89',
    '91', '92', '93', '94', '95', '96', '97', '98', '99'
]);

export function normalizarCelular(valor) {
    // Retorna '' para campo vazio, os dígitos normalizados para celular válido e null para inválido.
    const texto = String(valor ?? '').trim();
    if (!texto) return '';
    if (!CARACTERES_PERMITIDOS.test(texto)) return null;

    let digitos = texto.replace(/\D/g, '');
    if (texto.startsWith('+')) {
        // Nesta versão, apenas números brasileiros.
        if (!digitos.startsWith(CODIGO_PAIS_BRASIL)) return null;
        digitos = digitos.slice(CODIGO_PAIS_BRASIL.length);
    } else if (digitos.length === 13 && digitos.startsWith(CODIGO_PAIS_BRASIL)) {
        digitos = digitos.slice(CODIGO_PAIS_BRASIL.length);
    } else if (digitos.length === 12 && digitos.startsWith('0')) {
        // Prefixo de ligação interurbana, como em (011) 98765-4321.
        digitos = digitos.slice(1);
    }

    if (digitos.length !== 11 || !DDDS_BRASILEIROS.has(digitos.slice(0, 2)) || digitos[2] !== '9') {
        return null;
    }
    return CODIGO_PAIS_BRASIL + digitos;
}

export function ehCelularValido(valor) {
    return Boolean(normalizarCelular(valor));
}

export function formatarCelular(valor) {
    const normalizado = normalizarCelular(valor);
    // Valores vazios ou inválidos são exibidos como estão, sem esconder o que foi gravado.
    if (!normalizado) return String(valor ?? '').trim();

    const numero = normalizado.slice(CODIGO_PAIS_BRASIL.length);
    return `(${numero.slice(0, 2)}) ${numero.slice(2, 7)}-${numero.slice(7)}`;
}

export function gerarLinkWhatsApp(valor) {
    const normalizado = normalizarCelular(valor);
    return normalizado ? `https://wa.me/${normalizado}` : null;
}
