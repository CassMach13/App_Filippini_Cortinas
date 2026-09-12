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

test('publicação ignora documentação, testes e arquivos de configuração local', () => {
    const ignorados = firebaseConfig.hosting?.ignore || [];
    assert.equal(firebaseConfig.hosting?.public, 'public');
    assert.ok(ignorados.includes('docs/**'));
    assert.ok(ignorados.includes('tests/**'));
    assert.ok(ignorados.includes('firebase-config.example.js'));
    assert.ok(ignorados.includes('*.mp4'));
    assert.ok(ignorados.includes('*.log'));
});
