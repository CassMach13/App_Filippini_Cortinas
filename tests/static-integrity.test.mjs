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
    assert.equal((html.match(/role=["']tab["']/g) || []).length, 4);
    assert.equal((html.match(/role=["']tabpanel["']/g) || []).length, 4);
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

test('publicação ignora documentação, testes e arquivos de configuração local', () => {
    const ignorados = firebaseConfig.hosting?.ignore || [];
    assert.equal(firebaseConfig.hosting?.public, 'public');
    assert.ok(ignorados.includes('docs/**'));
    assert.ok(ignorados.includes('tests/**'));
    assert.ok(ignorados.includes('firebase-config.example.js'));
    assert.ok(ignorados.includes('*.mp4'));
    assert.ok(ignorados.includes('*.log'));
});
