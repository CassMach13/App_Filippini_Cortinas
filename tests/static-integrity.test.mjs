import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [html, appSource, firebaseConfig] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../apps.js', import.meta.url), 'utf8'),
    readFile(new URL('../firebase.json', import.meta.url), 'utf8').then(JSON.parse)
]);

test('todos os IDs acessados diretamente no JavaScript existem no HTML', () => {
    const idsHtml = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
    const idsCriadosDinamicamente = new Set([
        ...appSource.matchAll(/\.id\s*=\s*["']([^"']+)["']/g)
    ].map(match => match[1]));
    const idsJavaScript = new Set([
        ...appSource.matchAll(/getElementById\(["']([^"']+)["']\)/g)
    ].map(match => match[1]));
    const ausentes = [...idsJavaScript]
        .filter(id => !idsHtml.has(id) && !idsCriadosDinamicamente.has(id))
        .sort();

    assert.deepEqual(ausentes, []);
});

test('IDs do HTML são únicos', () => {
    const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
    const duplicados = ids.filter((id, indice) => ids.indexOf(id) !== indice);

    assert.deepEqual([...new Set(duplicados)], []);
});

test('HTML não mantém manipuladores inline', () => {
    assert.doesNotMatch(html, /\son(?:click|change|input|blur|submit)\s*=/i);
});

test('login usa formulário semântico e metadados de autenticação', () => {
    assert.match(html, /<form[^>]+id=["']login-form["']/i);
    assert.match(html, /id=["']login-email["'][^>]+name=["']email["'][^>]+autocomplete=["']username["']/i);
    assert.match(html, /id=["']login-password["'][^>]+name=["']password["'][^>]+autocomplete=["']current-password["']/i);
    assert.match(html, /id=["']feedbackMessageLogin["'][^>]+aria-live=/i);
});

test('abas, modais e ordenação usam controles semânticos', () => {
    // Cinco abas: a aba de Follow-ups foi incluída na Etapa 1.
    assert.equal((html.match(/role=["']tab["']/g) || []).length, 5);
    assert.equal((html.match(/role=["']tabpanel["']/g) || []).length, 5);
    assert.equal((html.match(/class=["']modal["'][^>]+role=["']dialog["']/g) || []).length, 11);
    assert.equal((html.match(/class=["']close-button["']/g) || []).length, 11);
    assert.doesNotMatch(html, /<span[^>]+class=["']close-button["']/i);
    assert.equal((html.match(/class=["']sort-button["']/g) || []).length, 10);
});

test('tabelas não contêm botões diretamente dentro de tbody', () => {
    const corposTabela = [...html.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)].map(match => match[1]);
    corposTabela.forEach(conteudo => assert.doesNotMatch(conteudo, /^\s*<button\b/i));
});

test('interface evita alertas bloqueantes e animações indiscriminadas', () => {
    assert.doesNotMatch(appSource, /\balert\s*\(/);
    assert.doesNotMatch(html, /transition\s*:\s*all\b/i);
    assert.match(html, /prefers-reduced-motion/);
});

test('proposta detalhada móvel usa cartões responsivos apenas na tela', () => {
    assert.match(html, /@media\s+screen\s+and\s+\(max-width:\s*560px\)/i);
    assert.match(html, /\.proposta-detalhada\s+\.proposta-detalhes-table\s+thead\s*\{\s*display:\s*none/i);
    assert.match(appSource, /proposta-ambiente-table proposta-detalhes-table/);
});

test('configuração de impressão A4 mantém margens de 8 mm', () => {
    assert.match(html, /@media\s+print[\s\S]*?@page\s*\{[\s\S]*?size:\s*A4\s+portrait;[\s\S]*?margin:\s*8mm;/i);
});

test('impressão esconde todas as abas, exceto a proposta', () => {
    const regraOculta = html.match(/@media\s+print\s*\{[\s\S]*?([^{}]*#tab1[^{}]*)\{\s*display:\s*none\s*!important;/i);
    assert.ok(regraOculta, 'regra de impressão que esconde as abas não encontrada');

    const seletores = regraOculta[1].split(',').map(seletor => seletor.trim());
    const paineis = [...html.matchAll(/<div id=["']([^"']+)["'] class=["'][^"']*\btab-content\b[^"']*["'] role=["']tabpanel["']/g)]
        .map(match => match[1]);

    assert.deepEqual(paineis, ['tab1', 'tab2', 'tab3', 'tab-followups', 'tab4']);
    paineis.filter(id => id !== 'tab3').forEach(id => assert.ok(seletores.includes(`#${id}`), `#${id} deve ficar fora da impressão`));
    assert.equal(seletores.includes('#tab3'), false);
});

test('módulos importados pela aplicação fazem parte do pacote do Hosting', async () => {
    const scriptPublicacao = await readFile(new URL('../scripts/build-hosting.mjs', import.meta.url), 'utf8');
    const listaPublicacao = scriptPublicacao.match(/const filesToPublish = \[([\s\S]*?)\];/);
    assert.ok(listaPublicacao, 'lista de arquivos publicados não encontrada');
    const publicados = new Set([...listaPublicacao[1].matchAll(/'([^']+)'/g)].map(match => match[1]));

    const importados = new Set();
    const pendentes = ['apps.js'];
    while (pendentes.length > 0) {
        const arquivo = pendentes.pop();
        const fonte = await readFile(new URL(`../${arquivo}`, import.meta.url), 'utf8');
        for (const [, modulo] of fonte.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
            if (importados.has(modulo)) continue;
            importados.add(modulo);
            if (modulo !== 'firebase-config.js') pendentes.push(modulo);
        }
    }

    assert.ok(importados.has('date-domain.js'));
    assert.deepEqual([...importados].filter(modulo => !publicados.has(modulo)).sort(), []);
});

test('contatos usam campo de telefone e links de WhatsApp seguros', () => {
    ['celularCliente', 'celularComissionado'].forEach(id => {
        assert.match(html, new RegExp(`<input type=["']tel["'] id=["']${id}["']`));
        assert.match(html, new RegExp(`<label for=["']${id}["']`));
    });

    const linksWhatsApp = [...html.matchAll(/<a\b[^>]*class=["'][^"']*btn-whatsapp[^"']*["'][^>]*>/g)].map(match => match[0]);
    assert.equal(linksWhatsApp.length, 2);
    linksWhatsApp.forEach(link => {
        assert.match(link, /target=["']_blank["']/);
        assert.match(link, /rel=["']noopener noreferrer["']/);
        // Sem celular válido o link nasce indisponível e sem URL.
        assert.doesNotMatch(link, /\bhref=/);
    });
    assert.match(appSource, /target="_blank" rel="noopener noreferrer"/);
});

function converterFontePadraoEmRegExp(fonte) {
    // Suporte mínimo à sintaxe de "source" do Firebase Hosting usada neste projeto:
    // "**" (qualquer sequência, inclusive vazia e com barras), "*" (qualquer sequência sem barra)
    // e grupos de alternância no estilo extglob "@(a|b)".
    let regexTexto = '';
    for (let indice = 0; indice < fonte.length; indice++) {
        const caractere = fonte[indice];
        if (fonte.startsWith('**', indice)) {
            regexTexto += '.*';
            indice++;
        } else if (caractere === '*') {
            regexTexto += '[^/]*';
        } else if (fonte.startsWith('@(', indice)) {
            const fim = fonte.indexOf(')', indice);
            const alternativas = fonte.slice(indice + 2, fim).split('|')
                .map(alternativa => alternativa.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
            regexTexto += `(?:${alternativas.join('|')})`;
            indice = fim;
        } else {
            regexTexto += caractere.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
        }
    }
    return new RegExp(`^${regexTexto}$`);
}

function obterCacheControlEfetivo(regrasHeaders, caminho) {
    // Reproduz a regra do Firebase Hosting: quando várias definições correspondem ao mesmo
    // caminho e definem o mesmo cabeçalho, vale o valor da definição que aparece por último.
    let valor = null;
    for (const regra of regrasHeaders) {
        if (!converterFontePadraoEmRegExp(regra.source).test(caminho)) continue;
        const cacheControl = regra.headers.find(cabecalho => cabecalho.key.toLowerCase() === 'cache-control');
        if (cacheControl) valor = cacheControl.value;
    }
    return valor;
}

test('cabeçalhos de Hosting forçam revalidação do HTML de entrada, inclusive na raiz "/"', () => {
    const regrasHeaders = firebaseConfig.hosting?.headers || [];
    const forcaRevalidacao = valor => /\b(no-cache|no-store|must-revalidate)\b/i.test(valor || '');

    // A raiz "/" é o caminho que o navegador realmente pede; sem uma regra própria, ela cai na
    // política padrão de cache do Hosting (max-age=3600) em vez da regra pensada para HTML/JS.
    const raiz = obterCacheControlEfetivo(regrasHeaders, '/');
    assert.ok(raiz, 'nenhuma regra de headers alcança a raiz "/"');
    assert.ok(forcaRevalidacao(raiz), `Cache-Control de "/" deve forçar revalidação, obtido: ${raiz}`);
    assert.doesNotMatch(raiz, /max-age=\s*(?!0\b)\d+/, 'raiz "/" não pode aceitar um max-age longo sem revalidação');

    // O documento também pode ser pedido explicitamente como /index.html; deve ter a mesma garantia.
    const indice = obterCacheControlEfetivo(regrasHeaders, '/index.html');
    assert.ok(forcaRevalidacao(indice), `Cache-Control de "/index.html" deve forçar revalidação, obtido: ${indice}`);

    // Os módulos JavaScript continuam com a mesma política de revalidação, sem afrouxar.
    const script = obterCacheControlEfetivo(regrasHeaders, '/apps.js');
    assert.ok(forcaRevalidacao(script), `Cache-Control de "/apps.js" deve forçar revalidação, obtido: ${script}`);

    // Um ativo estático comum não precisa de revalidação forçada; a proteção é específica do HTML/JS.
    const imagem = obterCacheControlEfetivo(regrasHeaders, '/logo.png');
    assert.equal(imagem, null, 'esta verificação não deve exigir revalidação para ativos estáticos comuns');
});

test('publicação ignora documentação, testes e arquivos de configuração local', () => {
    const ignorados = firebaseConfig.hosting?.ignore || [];
    assert.equal(firebaseConfig.hosting?.public, 'public');
    assert.ok(ignorados.includes('docs/**'));
    assert.ok(ignorados.includes('tests/**'));
    assert.ok(ignorados.includes('firebase-config.example.js'));
    assert.ok(ignorados.includes('*.mp4'));
    assert.ok(ignorados.includes('*.log'));
});
